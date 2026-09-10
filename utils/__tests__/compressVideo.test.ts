import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('expo-file-system/legacy', () => ({
  __esModule: true,
  default: {},
  getInfoAsync: jest.fn(),
}));

jest.mock('react-native-compressor', () => ({
  Video: {
    compress: jest.fn(),
  },
}));

jest.mock('@/utils/sentry', () => ({
  captureException: jest.fn(),
}));

import * as FileSystem from 'expo-file-system/legacy';
import { Video } from 'react-native-compressor';

import { VIDEO_TARGET_BITRATE_BPS } from '@/constants/video';
import { captureException } from '@/utils/sentry';

import {
  compressVideoSafe,
  prepareVideoForUpload,
  uploadTimeoutMsForSize,
  VIDEO_COMPRESSION_THRESHOLD_MB,
} from '../compressVideo';

const getInfoAsyncMock = FileSystem.getInfoAsync as jest.MockedFunction<
  typeof FileSystem.getInfoAsync
>;
const compressMock = Video.compress as jest.MockedFunction<typeof Video.compress>;
const captureExceptionSpy = captureException as jest.MockedFunction<typeof captureException>;

describe('prepareVideoForUpload', () => {
  beforeEach(() => {
    getInfoAsyncMock.mockReset();
    compressMock.mockReset();
  });

  it('skips compression for already-small clips', async () => {
    getInfoAsyncMock.mockResolvedValue({ exists: true, size: 2 * 1024 * 1024 } as any);

    const result = await prepareVideoForUpload('file:///clip.mp4');

    expect(result.uri).toBe('file:///clip.mp4');
    expect(result.wasCompressed).toBe(false);
    expect(compressMock).not.toHaveBeenCalled();
  });

  it('skips a mid-size clip that already fits the upload cap (no wasteful re-encode)', async () => {
    // Owner decision 2026-09-09: a 24MB clip is well under the 150MB cap, so it
    // uploads as-is at capture quality instead of paying for a full 1080p
    // transcode. This is the fix for slow uploads — the on-device re-encode was
    // the slowest step and it was running on clips that never needed shrinking.
    getInfoAsyncMock.mockResolvedValue({ exists: true, size: 24 * 1024 * 1024 } as any);

    const result = await prepareVideoForUpload('file:///clip.mp4');

    expect(result.wasCompressed).toBe(false);
    expect(result.uri).toBe('file:///clip.mp4');
    expect(compressMock).not.toHaveBeenCalled();
  });

  it('compresses only when the clip exceeds the upload cap', async () => {
    getInfoAsyncMock.mockImplementation(async (uri: string) => {
      if (uri === 'file:///compressed.mp4') {
        return { exists: true, size: 50 * 1024 * 1024 } as any;
      }
      return { exists: true, size: 170 * 1024 * 1024 } as any; // over the 150MB cap
    });
    compressMock.mockResolvedValue('file:///compressed.mp4' as any);

    const result = await prepareVideoForUpload('file:///clip.mp4');

    // These options are the whole quality story — see the comments in
    // compressVideoSafe. 'auto' clamps the bitrate to 1,669,000 bps in the
    // package's native code no matter the resolution, which is why 1080p clips
    // still looked bad; 'manual' + an explicit bitrate is the fix, and maxSize
    // keeps the long edge at 1920 (the package defaults it to 640).
    expect(compressMock).toHaveBeenCalledWith(
      'file:///clip.mp4',
      {
        compressionMethod: 'manual',
        bitrate: VIDEO_TARGET_BITRATE_BPS,
        minimumFileSizeForCompress: 1,
        maxSize: 1920,
      },
      undefined
    );
    expect(VIDEO_TARGET_BITRATE_BPS).toBeGreaterThan(1_669_000);
    expect(result).toMatchObject({
      uri: 'file:///compressed.mp4',
      wasCompressed: true,
      originalSizeBytes: 170 * 1024 * 1024,
      finalSizeBytes: 50 * 1024 * 1024,
    });
  });

  it('exports the documented threshold constant', () => {
    expect(VIDEO_COMPRESSION_THRESHOLD_MB).toBe(8);
  });
});

describe('compression progress', () => {
  beforeEach(() => {
    getInfoAsyncMock.mockReset();
    compressMock.mockReset();
  });

  it('forwards native compression progress to the caller (this is the dead-air fix)', async () => {
    getInfoAsyncMock.mockImplementation(async (uri: string) =>
      uri === 'file:///compressed.mp4'
        ? ({ exists: true, size: 5 * 1024 * 1024 } as any)
        : ({ exists: true, size: 170 * 1024 * 1024 } as any)
    );
    compressMock.mockImplementation(async (_uri: any, _opts: any, onProgress: any) => {
      onProgress?.(0.25);
      onProgress?.(0.5);
      onProgress?.(1);
      return 'file:///compressed.mp4' as any;
    });

    const seen: number[] = [];
    await prepareVideoForUpload('file:///clip.mp4', {
      onCompressProgress: fraction => seen.push(fraction),
    });

    expect(seen).toEqual([0.25, 0.5, 1]);
  });

  it('collapses sub-percent noise so the encoder cannot spam a setState per frame', async () => {
    getInfoAsyncMock.mockImplementation(async (uri: string) =>
      uri === 'file:///compressed.mp4'
        ? ({ exists: true, size: 5 * 1024 * 1024 } as any)
        : ({ exists: true, size: 170 * 1024 * 1024 } as any)
    );
    compressMock.mockImplementation(async (_uri: any, _opts: any, onProgress: any) => {
      // Four readings that all round to 30%, then a real move to 31%.
      onProgress?.(0.3);
      onProgress?.(0.3001);
      onProgress?.(0.2998);
      onProgress?.(0.3004);
      onProgress?.(0.31);
      return 'file:///compressed.mp4' as any;
    });

    const seen: number[] = [];
    await prepareVideoForUpload('file:///clip.mp4', {
      onCompressProgress: fraction => seen.push(fraction),
    });

    expect(seen).toEqual([0.3, 0.31]);
  });

  it('never calls back for a clip small enough to skip compression', async () => {
    getInfoAsyncMock.mockResolvedValue({ exists: true, size: 2 * 1024 * 1024 } as any);
    const onCompressProgress = jest.fn();

    await prepareVideoForUpload('file:///small.mp4', { onCompressProgress });

    expect(onCompressProgress).not.toHaveBeenCalled();
    expect(compressMock).not.toHaveBeenCalled();
  });
});

describe('compression hardening', () => {
  beforeEach(() => {
    getInfoAsyncMock.mockReset();
    compressMock.mockReset();
    captureExceptionSpy.mockReset();
  });

  it('keeps the ORIGINAL uri when compression produces a larger file', async () => {
    // Original 20MB, "compressed" output is 25MB — re-encoding made it worse.
    getInfoAsyncMock.mockImplementation(async (uri: string) => {
      if (uri === 'file:///video-compressed.mp4') {
        return { exists: true, size: 25 * 1024 * 1024 } as any;
      }
      return { exists: true, size: 20 * 1024 * 1024 } as any;
    });
    compressMock.mockResolvedValue('file:///video-compressed.mp4' as any);

    const result = await prepareVideoForUpload('file:///video.mp4');

    expect(result.uri).toBe('file:///video.mp4');
    expect(result.wasCompressed).toBe(false);
    expect(result.finalSizeBytes).toBe(20 * 1024 * 1024);
  });

  it('throws VIDEO_TOO_LARGE when the final asset exceeds MAX_VIDEO_SIZE_BYTES', async () => {
    // Original 200MB, compressed 180MB — both over the 150MB cap.
    getInfoAsyncMock.mockImplementation(async (uri: string) => {
      if (uri === 'file:///huge-compressed.mp4') {
        return { exists: true, size: 180 * 1024 * 1024 } as any;
      }
      return { exists: true, size: 200 * 1024 * 1024 } as any;
    });
    compressMock.mockResolvedValue('file:///huge-compressed.mp4' as any);

    await expect(prepareVideoForUpload('file:///huge.mp4')).rejects.toMatchObject({
      code: 'VIDEO_TOO_LARGE',
    });
  });

  it('reports the module-missing fallback to Sentry exactly once per session', async () => {
    // Simulate a binary built before react-native-compressor was added: the
    // module-level require throws. Reset the module registry and re-mock so
    // the module-level `reportedModuleMissing` flag starts fresh, then
    // require a brand-new instance of compressVideo.
    jest.resetModules();
    jest.doMock('react-native-compressor', () => {
      throw new Error("Cannot find native module 'RNCompressor'");
    });
    const freshCaptureException = jest.fn();
    jest.doMock('@/utils/sentry', () => ({ captureException: freshCaptureException }));
    jest.doMock('expo-file-system/legacy', () => ({
      __esModule: true,
      default: {},
      getInfoAsync: jest.fn(),
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const freshModule = require('../compressVideo') as typeof import('../compressVideo');

    const a = await freshModule.compressVideoSafe('file:///a.mp4');
    const b = await freshModule.compressVideoSafe('file:///b.mp4');

    expect(a).toBe('file:///a.mp4');
    expect(b).toBe('file:///b.mp4');
    expect(freshCaptureException).toHaveBeenCalledTimes(1);
    const [, context] = freshCaptureException.mock.calls[0] as [
      unknown,
      { tags: { stage: string } },
    ];
    expect(context.tags.stage).toBe('module_missing');

    // Restore the shared registry/mocks so later test files aren't affected.
    jest.resetModules();
    jest.dontMock('react-native-compressor');
    jest.dontMock('@/utils/sentry');
    jest.dontMock('expo-file-system/legacy');
  });
});

describe('uploadTimeoutMsForSize', () => {
  it('keeps the 5-minute floor for small files', () => {
    expect(uploadTimeoutMsForSize(8 * 1024 * 1024)).toBe(300_000);
  });
  it('scales ~6s per MB for large files', () => {
    expect(uploadTimeoutMsForSize(100 * 1024 * 1024)).toBe(600_000);
  });
  it('caps at 15 minutes', () => {
    expect(uploadTimeoutMsForSize(500 * 1024 * 1024)).toBe(900_000);
  });
  it('falls back to the floor when size is unknown (0)', () => {
    expect(uploadTimeoutMsForSize(0)).toBe(300_000);
  });
});
