import { runChunkUpload, waitForUploadRetry } from '../resumableUpload';

describe('acknowledged chunk upload', () => {
  it('cancels processing poll waits immediately and removes its listener', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    const wait = waitForUploadRetry(5000, controller.signal);
    const assertion = expect(wait).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
  it('checkpoints only successful chunks and resumes without resending them', async () => {
    let offset = 0;
    const send = jest
      .fn()
      .mockResolvedValueOnce({ done: false })
      .mockRejectedValueOnce(Object.assign(new Error('offline'), { status: 0 }));
    await expect(
      runChunkUpload({
        size: 15,
        chunkSize: 6,
        offset,
        send,
        save: async next => {
          offset = next;
        },
        retries: 0,
      })
    ).rejects.toThrow('offline');
    expect(offset).toBe(6);
    const resumed = jest
      .fn()
      .mockResolvedValueOnce({ done: false })
      .mockResolvedValueOnce({ done: true });
    await runChunkUpload({
      size: 15,
      chunkSize: 6,
      offset,
      send: resumed,
      save: async next => {
        offset = next;
      },
      retries: 0,
    });
    expect(resumed.mock.calls.map(call => call.slice(0, 2))).toEqual([
      [6, 12],
      [12, 15],
    ]);
    expect(offset).toBe(15);
  });
  it('does not retry permanent rejection or acknowledge an unfinished final response', async () => {
    const send = jest.fn().mockRejectedValue(Object.assign(new Error('invalid'), { status: 400 }));
    const save = jest.fn();
    await expect(runChunkUpload({ size: 5, chunkSize: 6, offset: 0, send, save })).rejects.toThrow(
      'invalid'
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    await expect(
      runChunkUpload({
        size: 5,
        chunkSize: 6,
        offset: 0,
        send: async () => ({ done: false }),
        save,
      })
    ).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
  it('aborts before sending bytes', async () => {
    const controller = new AbortController();
    controller.abort();
    const send = jest.fn();
    await expect(
      runChunkUpload({
        size: 5,
        chunkSize: 6,
        offset: 0,
        send,
        save: async () => {},
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(send).not.toHaveBeenCalled();
  });
});
it.each([NaN, 1.5, Infinity])(
  'rejects corrupt checkpoint offset %s before network IO',
  async offset => {
    const send = jest.fn();
    await expect(
      runChunkUpload({ size: 12, chunkSize: 6, offset, send, save: jest.fn() })
    ).rejects.toThrow('Invalid upload checkpoint');
    expect(send).not.toHaveBeenCalled();
  }
);
it.each([NaN, 0.5, Infinity])(
  'rejects invalid chunk size %s before network IO',
  async chunkSize => {
    const send = jest.fn();
    await expect(
      runChunkUpload({ size: 12, chunkSize, offset: 0, send, save: jest.fn() })
    ).rejects.toThrow('Invalid upload checkpoint');
    expect(send).not.toHaveBeenCalled();
  }
);
