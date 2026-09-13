export function throwIfUploadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Upload cancelled');
    error.name = 'AbortError';
    throw error;
  }
}

export function waitForUploadRetry(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfUploadAborted(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(Object.assign(new Error('Upload cancelled'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function runChunkUpload(options: {
  size: number;
  chunkSize: number;
  offset: number;
  send: (start: number, end: number) => Promise<{ done?: boolean }>;
  save: (offset: number) => Promise<void>;
  signal?: AbortSignal;
  retries?: number;
}): Promise<void> {
  const { size, chunkSize, signal } = options;
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !Number.isSafeInteger(chunkSize) ||
    chunkSize <= 0 ||
    !Number.isSafeInteger(options.offset) ||
    options.offset < 0 ||
    options.offset > size
  ) {
    throw new Error('Invalid upload checkpoint');
  }
  for (let start = options.offset; start < size; start += chunkSize) {
    const end = Math.min(size, start + chunkSize);
    for (let attempt = 0; ; attempt++) {
      throwIfUploadAborted(signal);
      try {
        const result = await options.send(start, end);
        if (end === size && result.done !== true) throw new Error('Upload has not finished');
        await options.save(end);
        break;
      } catch (error: any) {
        throwIfUploadAborted(signal);
        const transient =
          error?.status === 0 ||
          error?.status === 408 ||
          error?.status === 429 ||
          error?.status >= 500;
        if (!transient || attempt >= (options.retries ?? 2)) throw error;
        await waitForUploadRetry(Math.min(8000, 1000 * 2 ** attempt), signal);
      }
    }
  }
}
