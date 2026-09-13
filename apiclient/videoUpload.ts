import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import auth from './auth';
import { httpPostWithOptions } from './http';
import { runChunkUpload, throwIfUploadAborted, waitForUploadRetry } from '@/utils/resumableUpload';
import type { UploadOptions } from './upload';
import { captureException } from '@/utils/sentry';
import { prepareVideoForUpload } from '@/utils/compressVideo';

const CHUNK_BYTES = 6 * 1024 * 1024;
type Checkpoint = { id: string; offset: number; size: number; modified: number; created: number };
let queue: Promise<unknown> = Promise.resolve();

function newId() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const n = Math.floor(Math.random() * 16);
      return (c === 'x' ? n : (n & 3) | 8).toString(16);
    })
  );
}

// One memory-bounded transfer at a time. A failed task never poisons the queue.
export function uploadVideo(uri: string, name: string, mime: string, options?: UploadOptions) {
  const task = queue
    .then(() => performUpload(uri, name, mime, options))
    .catch(error => {
      if (error?.name !== 'AbortError')
        captureException(error instanceof Error ? error : new Error(String(error)), {
          tags: {
            context: 'video_upload',
            stage: 'session_transfer_or_processing',
            status: String(error?.status ?? 'unknown'),
          },
        });
      throw error;
    });
  queue = task.catch(() => undefined);
  return task;
}

async function performUpload(uri: string, name: string, mime: string, options?: UploadOptions) {
  const signal = options?.signal;
  throwIfUploadAborted(signal);
  const owner = String((await auth.me()).id);
  throwIfUploadAborted(signal);
  if (Platform.OS !== 'web') {
    // Every native video entry point enforces preparation. Cached prepared
    // outputs are reused, so screens that expose encoder progress do not encode twice.
    const prepared = await prepareVideoForUpload(uri);
    if (prepared.wasCompressed) {
      name = `${name.replace(/\.[^.]+$/, '')}.mp4`;
      mime = 'video/mp4';
    }
    uri = prepared.uri;
    throwIfUploadAborted(signal);
  }
  const fs = Platform.OS === 'web' ? null : await import('expo-file-system');
  const file = fs ? new fs.File(uri) : null;
  const blob = Platform.OS === 'web' ? await (await fetch(uri, { signal })).blob() : null;
  const size = file?.size ?? blob?.size ?? 0;
  const modified = file?.modificationTime ?? 0;
  if (!Number.isSafeInteger(size) || size <= 0 || size > 150 * 1024 * 1024)
    throw new Error('Video file is missing or exceeds 150 MB');
  const key = `vh_video_upload:${encodeURIComponent(owner)}:${encodeURIComponent(uri)}`;
  const saved = await AsyncStorage.getItem(key);
  let checkpoint: Checkpoint | null = null;
  try {
    checkpoint = saved ? JSON.parse(saved) : null;
  } catch {
    checkpoint = null;
  }
  if (
    !checkpoint ||
    typeof checkpoint.id !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(checkpoint.id) ||
    !Number.isSafeInteger(checkpoint.offset) ||
    checkpoint.offset < 0 ||
    checkpoint.offset > size ||
    (checkpoint.offset !== size && checkpoint.offset % CHUNK_BYTES !== 0) ||
    !Number.isFinite(checkpoint.created) ||
    checkpoint.created > Date.now() ||
    checkpoint.size !== size ||
    checkpoint.modified !== modified ||
    Date.now() - checkpoint.created > 24 * 60 * 60 * 1000
  ) {
    checkpoint = { id: newId(), offset: 0, size, modified, created: Date.now() };
  }
  const state = checkpoint;
  await AsyncStorage.setItem(key, JSON.stringify(state));
  const request = (path: string, body: object) =>
    httpPostWithOptions(path, body, 30000, 0, undefined, signal);
  const session = await request('/uploads/video-sessions', {
    id: state.id,
    bytes: size,
    content_type: mime,
  });
  throwIfUploadAborted(signal);
  if (session.owner_id !== owner) throw new Error('Account changed. Please retry the upload.');
  if (!['ready', 'uploading', 'processing'].includes(session.state))
    throw new Error('Invalid upload session response');
  if (session.state === 'ready') return session.result;
  // The final chunk may have succeeded while its response/checkpoint was lost.
  // Ask the server before resending any bytes on a resumed invocation.
  if (saved && session.state === 'uploading') {
    try {
      const completed = await request(`/uploads/video-sessions/${session.id}/complete`, {});
      throwIfUploadAborted(signal);
      if (completed.state === 'ready') return completed.result;
      if (completed.state === 'processing') session.state = 'processing';
    } catch (error: any) {
      if (error?.status !== 409) throw error; // 409 = provider has no complete asset yet.
    }
  }
  if (session.state === 'uploading') {
    const handle = file?.open();
    try {
      await runChunkUpload({
        size,
        chunkSize: CHUNK_BYTES,
        offset: state.offset,
        signal,
        retries: options?.retries,
        save: async offset => {
          state.offset = offset;
          await AsyncStorage.setItem(key, JSON.stringify(state));
        },
        send: async (start, end) => {
          throwIfUploadAborted(signal);
          const form = new FormData();
          let part: InstanceType<NonNullable<typeof fs>['File']> | undefined;
          try {
            if (blob) form.append('file', blob.slice(start, end, mime), name);
            else if (handle && fs) {
              handle.offset = start;
              const bytes = handle.readBytes(end - start);
              if (bytes.byteLength !== end - start)
                throw new Error('Video file changed during upload');
              part = new fs.File(fs.Paths.cache, `${state.id}-part`);
              part.write(bytes);
              form.append('file', { uri: part.uri, name, type: mime } as any);
            }
            for (const [field, value] of Object.entries(session.fields))
              form.append(field, String(value));
            return await new Promise<{ done?: boolean }>((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              const abort = () => xhr.abort();
              const finish = (error?: Error, value?: any) => {
                signal?.removeEventListener('abort', abort);
                error ? reject(error) : resolve(value);
              };
              xhr.open('POST', session.upload_url);
              xhr.setRequestHeader('X-Unique-Upload-Id', session.id);
              xhr.setRequestHeader('Content-Range', `bytes ${start}-${end - 1}/${size}`);
              xhr.timeout = Math.min(options?.timeoutMs ?? 180000, 180000);
              xhr.upload.onprogress = event => {
                if (event.lengthComputable) {
                  const sent = start + Math.round(((end - start) * event.loaded) / event.total);
                  options?.onProgress?.(Math.min(99, Math.round((sent / size) * 100)), sent, size);
                }
              };
              xhr.onload = () => {
                if (xhr.status < 200 || xhr.status >= 300) {
                  finish(
                    Object.assign(new Error('Video transfer interrupted. Retry to continue.'), {
                      status: xhr.status,
                    })
                  );
                  return;
                }
                try {
                  finish(undefined, JSON.parse(xhr.responseText));
                } catch {
                  finish(new Error('Invalid upload response'));
                }
              };
              xhr.onerror = xhr.ontimeout = () =>
                finish(
                  Object.assign(new Error('Video transfer interrupted. Retry to continue.'), {
                    status: 0,
                  })
                );
              xhr.onabort = () =>
                finish(Object.assign(new Error('Upload cancelled'), { name: 'AbortError' }));
              signal?.addEventListener('abort', abort, { once: true });
              if (signal?.aborted) {
                finish(Object.assign(new Error('Upload cancelled'), { name: 'AbortError' }));
                return;
              }
              xhr.send(form);
            });
          } finally {
            if (part?.exists) part.delete();
          }
        },
      });
    } finally {
      handle?.close();
    }
  }
  // Completion is idempotent. A timeout keeps the acknowledged offset and the
  // same session, so a later retry only checks processing; it never resends bytes.
  options?.onPhase?.('processing');
  for (let poll = 0; poll < 24; poll++) {
    throwIfUploadAborted(signal);
    const completed = await request(`/uploads/video-sessions/${session.id}/complete`, {});
    throwIfUploadAborted(signal);
    if (completed.state === 'ready') {
      options?.onProgress?.(100, size, size);
      return completed.result;
    }
    await waitForUploadRetry(5000, signal);
  }
  throw new Error(
    'Your video is uploaded and still processing. Retry to finish posting without uploading again.'
  );
}
