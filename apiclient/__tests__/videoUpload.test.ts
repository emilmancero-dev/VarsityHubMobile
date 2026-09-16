import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
const mockRequest = jest.fn();
const mockMe = jest.fn();
const mockPrepare = jest.fn();
jest.mock('@/utils/compressVideo', () => ({
  prepareVideoForUpload: (...args: any[]) => mockPrepare(...args),
}));
const mockRead = jest.fn();
const mockWrite = jest.fn();
const mockDelete = jest.fn();
const mockClose = jest.fn();
let mockSize = 13 * 1024 * 1024;
const mockHandles: {
  offset: number;
  readBytes: (count: number) => Uint8Array;
  close: typeof mockClose;
}[] = [];
jest.mock('../auth', () => ({ __esModule: true, default: { me: () => mockMe() } }));
jest.mock('../http', () => ({ httpPostWithOptions: (...args: any[]) => mockRequest(...args) }));
jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache/' },
  File: class {
    uri: string;
    size = mockSize;
    modificationTime = 100;
    exists = true;
    constructor(...parts: string[]) {
      this.uri = parts.join('');
    }
    open() {
      const handle = {
        offset: 0,
        readBytes(count: number) {
          mockRead(this.offset, count);
          this.offset += count;
          return new Uint8Array(count);
        },
        close: mockClose,
      };
      mockHandles.push(handle);
      return handle;
    }
    write(bytes: Uint8Array) {
      mockWrite(bytes.byteLength);
    }
    delete() {
      mockDelete(this.uri);
    }
  },
}));
import { uploadVideo } from '../videoUpload';
const uri = 'file:///video.mov';
const key = `vh_video_upload:owner:${encodeURIComponent(uri)}`;
const chunk = 6 * 1024 * 1024;
let responses: { status: number; body?: object }[];
let ranges: string[];
const originalXHR = global.XMLHttpRequest;
const originalFetch = global.fetch;
class TestXHR {
  upload: any = {};
  headers: Record<string, string> = {};
  status = 200;
  responseText = '';
  onload?: () => void;
  onabort?: () => void;
  open() {}
  setRequestHeader(key: string, value: string) {
    this.headers[key] = value;
  }
  send() {
    ranges.push(this.headers['Content-Range']);
    const response = responses.shift() || { status: 200, body: { done: true } };
    this.status = response.status;
    this.responseText = JSON.stringify(response.body || {});
    this.onload?.();
  }
  abort() {
    this.onabort?.();
  }
}
function session(body: any) {
  return {
    id: body.id,
    owner_id: 'owner',
    state: 'uploading',
    fields: { signature: 'signed' },
    upload_url: 'https://api.cloudinary.com/demo/video/upload',
  };
}
beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockHandles.length = 0;
  mockSize = 13 * 1024 * 1024;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  global.XMLHttpRequest = TestXHR as any;
  ranges = [];
  responses = [];
  mockMe.mockResolvedValue({ id: 'owner' });
  mockPrepare.mockImplementation(async (uri: string) => ({ uri, wasCompressed: false }));
  mockRequest.mockImplementation(async (path, body) =>
    path.endsWith('/complete') ? { state: 'ready', result: { url: 'ready.mp4' } } : session(body)
  );
});
afterAll(() => {
  global.XMLHttpRequest = originalXHR;
  global.fetch = originalFetch;
});
it('enforces preparation before sending any native video bytes', async () => {
  mockPrepare.mockRejectedValue(new Error('Could not prepare video'));
  await expect(uploadVideo(uri, 'video.mov', 'video/quicktime')).rejects.toThrow(
    'Could not prepare'
  );
  expect(mockRequest).not.toHaveBeenCalled();
  expect(ranges).toHaveLength(0);
});
it('passes cancellation into preparation and never starts a cancelled transfer', async () => {
  const controller = new AbortController();
  let preparationSignal: AbortSignal | undefined;
  mockPrepare.mockImplementation(async (_uri, options) => {
    preparationSignal = options?.signal;
    controller.abort();
    return { uri, wasCompressed: false };
  });
  await expect(
    uploadVideo(uri, 'video.mov', 'video/quicktime', { signal: controller.signal })
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(preparationSignal).toBe(controller.signal);
  expect(mockRequest).not.toHaveBeenCalled();
  expect(ranges).toHaveLength(0);
});
it.each([0, NaN, 150 * 1024 * 1024 + 1])(
  'rejects invalid or oversized video bytes (%s) before requesting an upload session',
  async size => {
    mockSize = size;
    await expect(uploadVideo(uri, 'video.mov', 'video/quicktime')).rejects.toThrow(
      'Video file is missing or exceeds 150 MB'
    );
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockRead).not.toHaveBeenCalled();
    expect(ranges).toHaveLength(0);
  }
);
it('restarts from persisted acknowledgement with bounded native chunk IO and cleanup', async () => {
  responses = [{ status: 200, body: { done: false } }, { status: 400 }];
  await expect(uploadVideo(uri, 'video.mov', 'video/quicktime')).rejects.toMatchObject({
    status: 400,
  });
  expect(JSON.parse((await AsyncStorage.getItem(key))!).offset).toBe(chunk);
  expect(ranges).toHaveLength(2); // Permanent rejection is never automatically retried.
  ranges = [];
  mockRead.mockClear();
  mockRequest
    .mockImplementationOnce(async (_path, body) => session(body))
    .mockRejectedValueOnce(Object.assign(new Error('not uploaded yet'), { status: 409 }));
  await expect(uploadVideo(uri, 'video.mov', 'video/quicktime')).resolves.toEqual({
    url: 'ready.mp4',
  });
  expect(ranges).toEqual([
    `bytes ${chunk}-${2 * chunk - 1}/${mockSize}`,
    `bytes ${2 * chunk}-${mockSize - 1}/${mockSize}`,
  ]);
  expect(mockRead.mock.calls).toEqual([
    [chunk, chunk],
    [2 * chunk, mockSize - 2 * chunk],
  ]);
  expect(Math.max(...mockWrite.mock.calls.map(([size]) => size))).toBe(chunk);
  expect(mockClose).toHaveBeenCalledTimes(2);
  expect(mockDelete).toHaveBeenCalledTimes(4);
});
it('retries finalization without retransmitting completed bytes', async () => {
  mockRequest
    .mockImplementationOnce(async (_path, body) => session(body))
    .mockRejectedValueOnce(new Error('completion timeout'));
  await expect(uploadVideo(uri, 'video.mov', 'video/quicktime')).rejects.toThrow(
    'completion timeout'
  );
  expect(JSON.parse((await AsyncStorage.getItem(key))!).offset).toBe(mockSize);
  const before = ranges.length;
  await uploadVideo(uri, 'video.mov', 'video/quicktime');
  expect(ranges).toHaveLength(before);
});
it('rejects a session owned by another account before opening the file or transmitting', async () => {
  mockRequest.mockImplementation(async (_path, body) => ({ ...session(body), owner_id: 'other' }));
  await expect(uploadVideo(uri, 'video.mov', 'video/quicktime')).rejects.toThrow('Account changed');
  expect(mockHandles).toHaveLength(0);
  expect(ranges).toHaveLength(0);
});
it('slices web blobs without using native file IO', async () => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  const slice = jest.fn(() => new Blob(['part'], { type: 'video/mp4' }));
  global.fetch = jest.fn().mockResolvedValue({ blob: async () => ({ size: chunk + 5, slice }) });
  await uploadVideo('blob:clip', 'video.mp4', 'video/mp4');
  expect(slice.mock.calls).toEqual([
    [0, chunk, 'video/mp4'],
    [chunk, chunk + 5, 'video/mp4'],
  ]);
  expect(mockRead).not.toHaveBeenCalled();
  expect(mockHandles).toHaveLength(0);
});
it('serializes concurrent transfers so only one file handle is open', async () => {
  let release!: (value: any) => void;
  mockRequest.mockImplementationOnce(
    (_path, body) =>
      new Promise(resolve => {
        release = () => resolve(session(body));
      })
  );
  const first = uploadVideo(uri, 'video.mov', 'video/quicktime');
  const second = uploadVideo('file:///other.mov', 'other.mov', 'video/quicktime');
  for (let tick = 0; tick < 20 && !release; tick++) await Promise.resolve();
  expect(mockMe).toHaveBeenCalledTimes(1);
  release(undefined);
  await first;
  await second;
  expect(mockHandles).toHaveLength(2);
  const firstCloseOrder = mockClose.mock.invocationCallOrder[0];
  const secondFileReadOrder = mockRead.mock.invocationCallOrder[3];
  expect(firstCloseOrder).toBeLessThan(secondFileReadOrder);
});

it('recovers a lost final acknowledgement through completion without resending bytes', async () => {
  responses = [
    { status: 200, body: { done: false } },
    { status: 200, body: { done: false } },
    { status: 0 },
  ];
  await expect(
    uploadVideo(uri, 'video.mov', 'video/quicktime', { retries: 0 })
  ).rejects.toMatchObject({ status: 0 });
  expect(JSON.parse((await AsyncStorage.getItem(key))!).offset).toBe(2 * chunk);
  const before = ranges.length;
  mockRead.mockClear();
  await expect(uploadVideo(uri, 'video.mov', 'video/quicktime')).resolves.toEqual({
    url: 'ready.mp4',
  });
  expect(ranges).toHaveLength(before);
  expect(mockRead).not.toHaveBeenCalled();
});
