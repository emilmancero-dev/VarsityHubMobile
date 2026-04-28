import { retryWithBackoff } from '../retryWithBackoff';

describe('retryWithBackoff', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves immediately when the function succeeds on first attempt', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    const promise = retryWithBackoff(fn, { maxRetries: 3 });
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries and resolves when function succeeds on second attempt', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValueOnce('success');
    const promise = retryWithBackoff(fn, { maxRetries: 3, initialDelayMs: 10, maxDelayMs: 100 });
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws immediately when shouldRetry returns false', async () => {
    const error = { status: 400 };
    const fn = jest.fn().mockRejectedValue(error);
    const shouldRetry = jest.fn().mockReturnValue(false);
    const promise = retryWithBackoff(fn, { maxRetries: 3, shouldRetry });
    // Register rejection handler before advancing timers to avoid unhandled rejection
    const assertion = expect(promise).rejects.toMatchObject(error);
    await jest.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledWith(error);
  });

  it('exhausts all retries and throws last error', async () => {
    const error = { status: 503 };
    const fn = jest.fn().mockRejectedValue(error);
    const promise = retryWithBackoff(fn, { maxRetries: 3, initialDelayMs: 10, maxDelayMs: 100 });
    const assertion = expect(promise).rejects.toMatchObject(error);
    await jest.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it('does not retry 4xx errors by default (except 408 and 429)', async () => {
    const error404 = { status: 404 };
    const fn = jest.fn().mockRejectedValue(error404);
    const promise = retryWithBackoff(fn, { maxRetries: 3 });
    const assertion = expect(promise).rejects.toMatchObject(error404);
    await jest.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 408 (timeout) by default', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce({ status: 408 })
      .mockResolvedValueOnce('ok');
    const promise = retryWithBackoff(fn, { maxRetries: 3, initialDelayMs: 10, maxDelayMs: 100 });
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 (rate limit) by default', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValueOnce('ok');
    const promise = retryWithBackoff(fn, { maxRetries: 3, initialDelayMs: 10, maxDelayMs: 100 });
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on errors with no status (network errors)', async () => {
    const networkError = new Error('Network Error');
    const fn = jest
      .fn()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce('ok');
    const promise = retryWithBackoff(fn, { maxRetries: 3, initialDelayMs: 10, maxDelayMs: 100 });
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('caps delay at maxDelayMs', async () => {
    const fn = jest.fn().mockRejectedValue({ status: 503 });
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const promise = retryWithBackoff(fn, {
      maxRetries: 5,
      initialDelayMs: 1000,
      maxDelayMs: 2000,
      backoffMultiplier: 4,
    });
    const assertion = expect(promise).rejects.toMatchObject({ status: 503 });
    await jest.runAllTimersAsync();
    await assertion;
    // Check that no setTimeout was called with a value > maxDelayMs
    const delays = setTimeoutSpy.mock.calls.map(call => call[1] as number).filter(d => d !== undefined);
    delays.forEach(delay => expect(delay).toBeLessThanOrEqual(2000));
    setTimeoutSpy.mockRestore();
  });

  it('respects maxRetries: 0 (no retries)', async () => {
    const error = { status: 503 };
    const fn = jest.fn().mockRejectedValue(error);
    const promise = retryWithBackoff(fn, { maxRetries: 0 });
    const assertion = expect(promise).rejects.toMatchObject(error);
    await jest.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
