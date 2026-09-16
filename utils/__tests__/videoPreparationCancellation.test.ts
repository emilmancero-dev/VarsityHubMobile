import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { Video, getVideoMetaData } from 'react-native-compressor';
import { prepareVideoForUpload } from '../compressVideo';
import { persistPreparedMedia } from '../mediaDraftFiles';
import { captureException } from '../sentry';
import { Platform } from 'react-native';

jest.mock('expo-file-system/legacy', () => ({ getInfoAsync: jest.fn(), deleteAsync: jest.fn() }));
jest.mock('react-native-compressor', () => ({
  Video: { compress: jest.fn(), cancelCompression: jest.fn() },
  getVideoMetaData: jest.fn(),
}));
jest.mock('../mediaDraftFiles', () => ({
  persistPreparedMedia: jest.fn(),
  deleteConfirmedMediaDraft: jest.fn(),
  isOwnedMediaDraft: (uri: string) => uri.startsWith('file:///documents/MediaDrafts/'),
}));
jest.mock('../sentry', () => ({ captureException: jest.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  jest.resetAllMocks();
  const stored = new Map<string, string>();
  (AsyncStorage.getItem as jest.Mock).mockImplementation(
    async (key: string) => stored.get(key) ?? null
  );
  (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => {
    stored.set(key, value);
  });
  (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => ({
    exists: true,
    isDirectory: false,
    modificationTime: 1,
    size: (uri.includes('prepared') ? 5 : 40) * 1024 * 1024,
  }));
  (getVideoMetaData as jest.Mock).mockResolvedValue({
    width: 1920,
    height: 1080,
    duration: 10,
    size: 40 * 1024 * 1024,
  });
  (persistPreparedMedia as jest.Mock).mockImplementation(async (uri: string) => uri);
  (Video.compress as jest.Mock).mockResolvedValue('file:///prepared.mp4');
});

it('defers legacy Android cancellation without invoking its promise-stranding native API', async () => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  const controller = new AbortController();
  const started = deferred<void>();
  const native = deferred<string>();
  const progress: number[] = [];
  let emitProgress!: (value: number) => void;
  (Video.compress as jest.Mock).mockImplementationOnce((_uri, options, onProgress) => {
    options.getCancellationId?.('legacy-android');
    emitProgress = onProgress;
    started.resolve();
    return native.promise;
  });
  // The affected Android API can leave its promise pending; do not simulate a
  // rejection that the real library is not guaranteed to deliver.
  (Video.cancelCompression as jest.Mock).mockImplementation(() => {});
  const cancelled = prepareVideoForUpload('file:///first.mp4', {
    signal: controller.signal,
    onCompressProgress: value => progress.push(value),
  }).catch(error => error);
  await started.promise;
  emitProgress(0.2);
  controller.abort();
  emitProgress(0.4);
  const next = prepareVideoForUpload('file:///next.mp4');
  await Promise.resolve();
  const encodesBeforeCompletion = (Video.compress as jest.Mock).mock.calls.length;
  native.resolve('file:///prepared.mp4');
  expect(await cancelled).toMatchObject({ name: 'AbortError' });
  await expect(next).resolves.toMatchObject({ wasCompressed: true });
  expect(Video.cancelCompression).not.toHaveBeenCalled();
  expect(encodesBeforeCompletion).toBe(1);
  expect(progress).toEqual([0.2]);
  expect(persistPreparedMedia).toHaveBeenCalledTimes(1);
});

it('rejects pre-cancelled preparation before reading or encoding the source', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    prepareVideoForUpload('file:///source.mp4', { signal: controller.signal })
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
  expect(Video.compress).not.toHaveBeenCalled();
});

it.each(['copy', 'output stat'])(
  'retains a completed draft for retry when cancelled during %s',
  async stage => {
    const controller = new AbortController();
    (persistPreparedMedia as jest.Mock).mockImplementation(async () => {
      if (stage === 'copy') controller.abort();
      return 'file:///durable-prepared.mp4';
    });
    const readInfo = (FileSystem.getInfoAsync as jest.Mock).getMockImplementation()!;
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (stage === 'output stat' && uri === 'file:///durable-prepared.mp4') controller.abort();
      return readInfo(uri);
    });
    await expect(
      prepareVideoForUpload('file:///source.mp4', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(prepareVideoForUpload('file:///source.mp4')).resolves.toMatchObject({
      uri: 'file:///durable-prepared.mp4',
    });
    expect(Video.compress).toHaveBeenCalledTimes(1);
    expect(persistPreparedMedia).toHaveBeenCalledTimes(1);
  }
);

it.each(['no identity', 'cache write failure', 'output stat failure'])(
  'removes only a newly created owned copy when cancelled with %s',
  async reason => {
    const controller = new AbortController();
    const copy = 'file:///documents/MediaDrafts/prepared/cancelled.mp4';
    const readInfo = (FileSystem.getInfoAsync as jest.Mock).getMockImplementation()!;
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === copy && reason === 'output stat failure') throw new Error('stat failed');
      const info = await readInfo(uri);
      return reason === 'no identity' ? { ...info, modificationTime: undefined } : info;
    });
    if (reason === 'cache write failure')
      (AsyncStorage.setItem as jest.Mock).mockRejectedValue(new Error('storage failed'));
    (persistPreparedMedia as jest.Mock).mockImplementation(async () => {
      controller.abort();
      return copy;
    });
    await expect(
      prepareVideoForUpload('file:///source.mp4', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(copy, { idempotent: true });
  }
);

it('never deletes a reused owned file when an unindexable preparation is cancelled', async () => {
  const controller = new AbortController();
  const reused = 'file:///documents/MediaDrafts/prepared/reused.mp4';
  const readInfo = (FileSystem.getInfoAsync as jest.Mock).getMockImplementation()!;
  (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => ({
    ...(await readInfo(uri)),
    modificationTime: undefined,
  }));
  (Video.compress as jest.Mock).mockResolvedValue(reused);
  (persistPreparedMedia as jest.Mock).mockImplementation(async (uri: string) => {
    controller.abort();
    return uri;
  });
  await expect(
    prepareVideoForUpload('file:///source.mp4', { signal: controller.signal })
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
});

it('cancels the owned native job, waits for it to stop, and lets the next job succeed', async () => {
  const controller = new AbortController();
  const started = deferred<void>();
  const native = deferred<string>();
  let progress!: (fraction: number) => void;
  (Video.compress as jest.Mock).mockImplementationOnce((_uri, options, onProgress) => {
    options.getCancellationId?.('first-job');
    progress = onProgress;
    started.resolve();
    return native.promise;
  });
  const seen: number[] = [];
  const first = prepareVideoForUpload('file:///first.mp4', {
    signal: controller.signal,
    onCompressProgress: value => seen.push(value),
  });
  const firstResult = first.catch(error => error);
  await started.promise;
  progress(0.2);
  controller.abort();
  const cancelledIds = (Video.cancelCompression as jest.Mock).mock.calls.map(([id]) => id);
  progress(0.4);
  const next = prepareVideoForUpload('file:///next.mp4');
  await Promise.resolve();
  const encodesBeforeStop = (Video.compress as jest.Mock).mock.calls.length;
  native.reject(new Error('native compression cancelled'));
  const error = await firstResult;
  await expect(next).resolves.toMatchObject({ uri: 'file:///prepared.mp4' });
  expect(cancelledIds).toEqual(['first-job']);
  expect(error).toMatchObject({ name: 'AbortError' });
  expect(seen).toEqual([0.2]);
  expect(encodesBeforeStop).toBe(1);
  expect(persistPreparedMedia).toHaveBeenCalledTimes(1);
  expect(captureException).not.toHaveBeenCalled();
});

it('never starts a queued job cancelled while another encode is running', async () => {
  const started = deferred<void>();
  const native = deferred<string>();
  (Video.compress as jest.Mock).mockImplementationOnce(() => {
    started.resolve();
    return native.promise;
  });
  const active = prepareVideoForUpload('file:///active.mp4');
  await started.promise;
  const controller = new AbortController();
  const queued = prepareVideoForUpload('file:///queued.mp4', { signal: controller.signal }).catch(
    error => error
  );
  controller.abort();
  native.resolve('file:///prepared.mp4');
  await active;
  expect(await queued).toMatchObject({ name: 'AbortError' });
  expect(Video.compress).toHaveBeenCalledTimes(1);
  expect(FileSystem.getInfoAsync).not.toHaveBeenCalledWith('file:///queued.mp4');
});

it('does not encode when cancellation arrives during metadata lookup', async () => {
  const controller = new AbortController();
  (getVideoMetaData as jest.Mock).mockImplementation(async () => {
    controller.abort();
    return { width: 1920, height: 1080, duration: 10, size: 40 * 1024 * 1024 };
  });
  await expect(
    prepareVideoForUpload('file:///source.mp4', { signal: controller.signal })
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(Video.compress).not.toHaveBeenCalled();
});

it('discards a native success racing cancellation instead of caching or uploading it', async () => {
  const controller = new AbortController();
  (Video.compress as jest.Mock).mockImplementation(async (_uri, options) => {
    options.getCancellationId?.('race-job');
    controller.abort();
    return 'file:///prepared.mp4';
  });
  await expect(
    prepareVideoForUpload('file:///source.mp4', { signal: controller.signal })
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(persistPreparedMedia).not.toHaveBeenCalled();
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  expect(captureException).not.toHaveBeenCalled();
});

it('retries cancellation on late progress when native job registration lagged the first cancel', async () => {
  const controller = new AbortController();
  const started = deferred<void>();
  const native = deferred<string>();
  let progress!: (fraction: number) => void;
  let registered = false;
  (Video.cancelCompression as jest.Mock).mockImplementation(() => {
    if (registered) native.reject(new Error('cancelled'));
  });
  (Video.compress as jest.Mock).mockImplementation((_uri, options, onProgress) => {
    options.getCancellationId('delayed-registration');
    progress = onProgress;
    started.resolve();
    return native.promise;
  });
  const result = prepareVideoForUpload('file:///source.mp4', { signal: controller.signal }).catch(
    error => error
  );
  await started.promise;
  controller.abort();
  registered = true;
  progress(0.01);
  expect(await result).toMatchObject({ name: 'AbortError' });
  expect(Video.cancelCompression).toHaveBeenNthCalledWith(1, 'delayed-registration');
  expect(Video.cancelCompression).toHaveBeenNthCalledWith(2, 'delayed-registration');
  expect(persistPreparedMedia).not.toHaveBeenCalled();
});

it('stops before native invocation when cancellation precedes the ID callback', async () => {
  const controller = new AbortController();
  let nativeStarted = false;
  (Video.compress as jest.Mock).mockImplementation(async (_uri, options) => {
    controller.abort();
    // Mirrors the installed package: callback precedes native compress().
    options.getCancellationId('not-started');
    nativeStarted = true;
    return 'file:///prepared.mp4';
  });
  await expect(
    prepareVideoForUpload('file:///source.mp4', { signal: controller.signal })
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(nativeStarted).toBe(false);
  expect(captureException).not.toHaveBeenCalled();
});

it('removes the abort listener after success so later aborts do not cancel a finished job', async () => {
  const controller = new AbortController();
  (Video.compress as jest.Mock).mockImplementation(async (_uri, options) => {
    options.getCancellationId('finished');
    return 'file:///prepared.mp4';
  });
  await expect(
    prepareVideoForUpload('file:///source.mp4', { signal: controller.signal })
  ).resolves.toMatchObject({ wasCompressed: true });
  controller.abort();
  expect(Video.cancelCompression).not.toHaveBeenCalled();
});

it('keeps cancellation authoritative when the native cancel call throws', async () => {
  const controller = new AbortController();
  (Video.cancelCompression as jest.Mock).mockImplementation(() => {
    throw new Error('bridge failure');
  });
  (Video.compress as jest.Mock).mockImplementation(async (_uri, options, progress) => {
    options.getCancellationId('broken-cancel');
    controller.abort();
    progress(0.1);
    return 'file:///prepared.mp4';
  });
  await expect(
    prepareVideoForUpload('file:///source.mp4', { signal: controller.signal })
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(captureException).toHaveBeenCalledTimes(1);
  expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
    tags: { context: 'video_compress', stage: 'cancel_failed' },
  });
  expect(persistPreparedMedia).not.toHaveBeenCalled();
});
