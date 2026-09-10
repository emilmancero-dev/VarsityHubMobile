import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockVideoUpload = jest.fn(async () => ({
  url: 'https://media.test/clip.mp4',
  provider: 'cloudinary',
  type: 'video',
}));
jest.mock('../videoUpload', () => ({ uploadVideo: mockVideoUpload }));

const mockAuth = {
  getToken: jest.fn(async () => 'test-token'),
  refreshToken: jest.fn(async () => ({
    accessToken: 'refreshed-token',
    reason: 'success' as const,
  })),
  clearTokensOnly: jest.fn(async () => undefined),
};

const openVerificationGateMock = jest.fn(async () => false);
const getAccessTokenForRequestMock = jest.fn(async () => 'test-token');
const refreshAccessTokenWithCacheMock = jest.fn(async () => ({
  accessToken: 'refreshed-token',
  reason: 'success' as const,
}));
const mockGetInfoAsync = jest.fn(async () => ({
  exists: true,
  size: 12345,
}));
const mockCreateUploadTask = jest.fn(() => ({
  uploadAsync: jest.fn(async () => ({ status: 200, body: '' })),
  cancelAsync: jest.fn(async () => undefined),
}));

jest.mock('@/utils/ensureUploadableUri', () => ({
  compressImageForUpload: jest.fn(async (uri: string, mimeType: string) => ({ uri, mimeType })),
}));

jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: mockGetInfoAsync,
  createUploadTask: mockCreateUploadTask,
  FileSystemUploadType: {
    BINARY_CONTENT: 'binary',
  },
}));

jest.mock('../auth', () => ({
  __esModule: true,
  default: mockAuth,
}));

jest.mock('../http', () => ({
  getApiBaseUrl: jest.fn(() => 'https://api.test'),
  getAccessTokenForRequest: getAccessTokenForRequestMock,
  refreshAccessTokenWithCache: refreshAccessTokenWithCacheMock,
}));

jest.mock('@/hooks/useVerificationGate', () => ({
  openVerificationGate: openVerificationGateMock,
  isEmailVerificationRequiredError: (status: number, payload: any) =>
    status === 403 &&
    String(payload?.error || payload?.message || '')
      .trim()
      .toLowerCase() === 'email verification required',
}));

class MockXHR {
  static instances: MockXHR[] = [];
  static nextStatus = 200;
  static nextResponseText = JSON.stringify({ secure_url: 'https://cloudinary.test/image.jpg' });

  upload = {
    onprogress: null as
      | ((event: { lengthComputable: boolean; loaded: number; total: number }) => void)
      | null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  timeout = 0;
  status = MockXHR.nextStatus;
  responseText = MockXHR.nextResponseText;
  method = '';
  url = '';
  requestBody: any = null;

  constructor() {
    MockXHR.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  send(body?: any) {
    this.requestBody = body;
    this.onload?.();
  }
}

describe('uploadFile routing', () => {
  const fetchMock = jest.fn() as any;
  const originalFormData = (global as any).FormData;
  // Every media upload first probes GET /uploads/r2-presign; a 503 means R2 is
  // unprovisioned and latches _r2UnavailableAt for 5 minutes within a module
  // instance (jest.resetModules() in beforeEach clears the latch between tests).
  const mockR2ProbeUnavailable = () =>
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ error: 'R2 not configured' }),
    });
  const mockSignatureThenFallbackUpload = () =>
    mockR2ProbeUnavailable()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          cloudName: 'varsityhub',
          apiKey: 'key',
          signature: 'sig',
          timestamp: 123,
          folder: 'uploads',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            url: 'https://api.test/uploads/fallback.jpg',
            type: 'image',
            mime: 'image/jpeg',
            storage: 'cloudinary',
          }),
      });

  beforeEach(() => {
    jest.resetModules();
    mockVideoUpload.mockReset();
    mockVideoUpload.mockResolvedValue({
      url: 'https://media.test/clip.mp4',
      provider: 'cloudinary',
      type: 'video',
    });
    fetchMock.mockReset();
    mockAuth.getToken.mockReset();
    mockAuth.refreshToken.mockReset();
    mockAuth.clearTokensOnly.mockReset();
    mockAuth.getToken.mockResolvedValue('test-token');
    mockAuth.refreshToken.mockResolvedValue({ accessToken: 'refreshed-token', reason: 'success' });
    getAccessTokenForRequestMock.mockReset();
    refreshAccessTokenWithCacheMock.mockReset();
    getAccessTokenForRequestMock.mockResolvedValue('test-token');
    refreshAccessTokenWithCacheMock.mockResolvedValue({
      accessToken: 'refreshed-token',
      reason: 'success',
    });
    mockGetInfoAsync.mockReset();
    mockGetInfoAsync.mockResolvedValue({ exists: true, size: 12345 });
    mockCreateUploadTask.mockClear();
    openVerificationGateMock.mockReset();
    openVerificationGateMock.mockResolvedValue(false);
    MockXHR.instances.length = 0;
    MockXHR.nextStatus = 200;
    MockXHR.nextResponseText = JSON.stringify({ secure_url: 'https://cloudinary.test/image.jpg' });
    (global as any).fetch = fetchMock;
    (global as any).XMLHttpRequest = MockXHR;
  });

  afterEach(() => {
    delete (global as any).fetch;
    delete (global as any).XMLHttpRequest;
    (global as any).FormData = originalFormData;
  });

  it.each([0, 10 * 1024 * 1024 + 1])(
    'blocks unreadable or oversized prepared images (%s) before any provider request',
    async size => {
      mockGetInfoAsync.mockResolvedValue({ exists: true, size });
      const { uploadFile } = await import('../upload');
      await expect(
        uploadFile('https://api.test', 'file:///photo.jpg', 'photo.jpg', 'image/jpeg')
      ).rejects.toThrow('Image is unreadable or too large');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(MockXHR.instances).toHaveLength(0);
    }
  );

  it('routes PDFs to /uploads/files instead of the media-only upload path', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ url: 'https://cdn.test/doc.pdf', type: 'raw', mime: 'application/pdf' }),
    });

    const { uploadFile } = await import('../upload');
    const result = await uploadFile(
      'https://api.test',
      'file:///tmp/doc.pdf',
      'doc.pdf',
      'application/pdf'
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.test/uploads/files');
    expect(result).toEqual({
      url: 'https://cdn.test/doc.pdf',
      type: 'raw',
      mime: 'application/pdf',
    });
  });

  it('mirrors onboarding upload context into the query string for server uploads', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ url: 'https://cdn.test/doc.pdf', type: 'raw', mime: 'application/pdf' }),
    });

    const { uploadFile } = await import('../upload');
    await uploadFile('https://api.test', 'file:///tmp/doc.pdf', 'doc.pdf', 'application/pdf', {
      formFields: {
        onboarding: true,
        upload_context: 'organization_supporting_document',
      },
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.test/uploads/files?onboarding=true&upload_context=organization_supporting_document'
    );
  });

  it('refreshes the session and retries PDF uploads after a 401', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: 'Unauthorized' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ url: 'https://cdn.test/doc.pdf', type: 'raw', mime: 'application/pdf' }),
      });

    const { uploadFile } = await import('../upload');
    const result = await uploadFile(
      'https://api.test',
      'file:///tmp/doc.pdf',
      'doc.pdf',
      'application/pdf'
    );

    expect(refreshAccessTokenWithCacheMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.headers?.Authorization).toBe('Bearer refreshed-token');
    expect(result).toEqual({
      url: 'https://cdn.test/doc.pdf',
      type: 'raw',
      mime: 'application/pdf',
    });
  });

  it('uses the token resolved by the HTTP auth helper for PDF uploads', async () => {
    getAccessTokenForRequestMock.mockResolvedValueOnce('recovered-token');
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ url: 'https://cdn.test/doc.pdf', type: 'raw', mime: 'application/pdf' }),
    });

    const { uploadFile } = await import('../upload');
    const result = await uploadFile(
      'https://api.test',
      'file:///tmp/doc.pdf',
      'doc.pdf',
      'application/pdf'
    );

    expect(refreshAccessTokenWithCacheMock).toHaveBeenCalledTimes(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.headers?.Authorization).toBe('Bearer recovered-token');
    expect(result).toEqual({
      url: 'https://cdn.test/doc.pdf',
      type: 'raw',
      mime: 'application/pdf',
    });
  });

  it('opens the verification gate and retries PDF uploads after email-verification-required', async () => {
    getAccessTokenForRequestMock
      .mockResolvedValueOnce('test-token')
      .mockResolvedValueOnce('verified-token');
    openVerificationGateMock.mockResolvedValue(true);
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: 'Email verification required' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ url: 'https://cdn.test/doc.pdf', type: 'raw', mime: 'application/pdf' }),
      });

    const { uploadFile } = await import('../upload');
    const result = await uploadFile(
      'https://api.test',
      'file:///tmp/doc.pdf',
      'doc.pdf',
      'application/pdf'
    );

    expect(openVerificationGateMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.headers?.Authorization).toBe('Bearer verified-token');
    expect(result).toEqual({
      url: 'https://cdn.test/doc.pdf',
      type: 'raw',
      mime: 'application/pdf',
    });
  });

  it('routes images through the Cloudinary signature flow before upload', async () => {
    mockR2ProbeUnavailable();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        cloudName: 'varsityhub',
        apiKey: 'key',
        signature: 'sig',
        timestamp: 123,
        folder: 'uploads',
      }),
    });

    const { uploadFile } = await import('../upload');
    const result = await uploadFile(
      'https://api.test',
      'file:///tmp/pic.jpg',
      'pic.jpg',
      'image/jpeg'
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.test/uploads/r2-presign?content_type=image%2Fjpeg&content_length=12345'
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://api.test/uploads/cloudinary-signature'
    );
    expect(MockXHR.instances).toHaveLength(1);
    expect(MockXHR.instances[0]?.url).toBe(
      'https://api.cloudinary.com/v1_1/varsityhub/image/upload'
    );
    expect(result).toEqual({
      url: 'https://cloudinary.test/image.jpg',
      type: 'image',
      mime: 'image/jpeg',
      provider: 'cloudinary',
    });
  });

  it('uploads directly to R2 with the server-approved content length when R2 is available', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        uploadUrl: 'https://r2.test/upload',
        key: 'varsityhub/test/image.jpg',
        publicUrl: 'https://media.test/varsityhub/test/image.jpg',
        expiresIn: 600,
        contentLength: 12345,
        maxBytes: 10485760,
      }),
    });

    const { uploadFile } = await import('../upload');
    const result = await uploadFile(
      'https://api.test',
      'file:///tmp/pic.jpg',
      'pic.jpg',
      'image/jpeg'
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.test/uploads/r2-presign?content_type=image%2Fjpeg&content_length=12345'
    );
    expect(mockCreateUploadTask).toHaveBeenCalledWith(
      'https://r2.test/upload',
      'file:///tmp/pic.jpg',
      expect.objectContaining({
        httpMethod: 'PUT',
        headers: {
          'Content-Type': 'image/jpeg',
          'Content-Length': '12345',
        },
      }),
      undefined
    );
    expect(result).toEqual({
      url: 'https://media.test/varsityhub/test/image.jpg',
      type: 'image',
      mime: 'image/jpeg',
      provider: 'r2',
    });
  });

  it('normalizes trimmed local video paths and refreshes mime from the final asset extension', async () => {
    class MockFormData {
      private readonly parts = new Map<string, any>();

      append(key: string, value: any) {
        this.parts.set(key, value);
      }

      get(key: string) {
        return this.parts.get(key);
      }
    }

    (global as any).FormData = MockFormData as any;
    mockR2ProbeUnavailable();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        cloudName: 'varsityhub',
        apiKey: 'key',
        signature: 'sig',
        timestamp: 123,
        folder: 'uploads',
      }),
    });

    const { uploadFile } = await import('../upload');
    await uploadFile('https://api.test', '/tmp/trimmed-output.mp4', 'clip.mov', 'video/quicktime');

    expect(mockVideoUpload).toHaveBeenCalledWith(
      'file:///tmp/trimmed-output.mp4',
      'clip.mov',
      'video/mp4',
      undefined
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockXHR.instances).toHaveLength(0);
  });

  it('mirrors signed Cloudinary constraints into the direct-upload form body', async () => {
    mockR2ProbeUnavailable();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        cloudName: 'varsityhub',
        apiKey: 'key',
        signature: 'sig',
        timestamp: 123,
        folder: 'uploads',
        allowed_formats: 'jpg,mp4',
        max_bytes: '157286400',
      }),
    });

    const { uploadFile } = await import('../upload');
    await uploadFile('https://api.test', 'file:///tmp/pic.jpg', 'pic.jpg', 'image/jpeg');

    const form = MockXHR.instances[0]?.requestBody as FormData;
    expect(form?.get('allowed_formats')).toBe('jpg,mp4');
    expect(form?.get('max_bytes')).toBe('157286400');
  });

  it('falls back to the server proxy on provider service failure', async () => {
    MockXHR.nextStatus = 503;
    MockXHR.nextResponseText = JSON.stringify({ error: { message: 'Invalid Signature' } });
    mockSignatureThenFallbackUpload();

    const { uploadFile } = await import('../upload');
    const result = await uploadFile(
      'https://api.test',
      'file:///tmp/pic.jpg',
      'pic.jpg',
      'image/jpeg'
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('https://api.test/uploads/r2-presign');
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://api.test/uploads/cloudinary-signature'
    );
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe('https://api.test/uploads');
    expect(result).toEqual({
      url: 'https://api.test/uploads/fallback.jpg',
      type: 'image',
      mime: 'image/jpeg',
      storage: 'cloudinary',
    });
  });

  it('propagates resumable video failures without silently starting another upload', async () => {
    mockVideoUpload.mockRejectedValueOnce(new Error('Transfer interrupted; retry to continue'));
    const { uploadFile } = await import('../upload');
    await expect(
      uploadFile('https://api.test', 'file:///tmp/clip.mp4', 'clip.mp4', 'video/mp4')
    ).rejects.toThrow('Transfer interrupted');
    expect(mockVideoUpload).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not bypass a permanent direct upload rejection using a proxy', async () => {
    MockXHR.nextStatus = 400;
    mockSignatureThenFallbackUpload();
    const { uploadFile } = await import('../upload');
    await expect(
      uploadFile('https://api.test', 'file:///tmp/pic.jpg', 'pic.jpg', 'image/jpeg')
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('carries onboarding upload context into the media fallback query string', async () => {
    MockXHR.nextStatus = 503;
    MockXHR.nextResponseText = JSON.stringify({ error: { message: 'Invalid Signature' } });
    mockSignatureThenFallbackUpload();

    const { uploadFile } = await import('../upload');
    await uploadFile('https://api.test', 'file:///tmp/pic.jpg', 'pic.jpg', 'image/jpeg', {
      formFields: {
        onboarding: true,
        upload_context: 'onboarding_header_image',
      },
    });

    expect(String(fetchMock.mock.calls[2]?.[0])).toBe(
      'https://api.test/uploads?onboarding=true&upload_context=onboarding_header_image'
    );
  });

  it('latches R2 unavailability after a 503 probe and skips the probe on later uploads', async () => {
    mockR2ProbeUnavailable();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        cloudName: 'varsityhub',
        apiKey: 'key',
        signature: 'sig',
        timestamp: 123,
        folder: 'uploads',
      }),
    });

    const { uploadFile } = await import('../upload');
    await uploadFile('https://api.test', 'file:///tmp/pic.jpg', 'pic.jpg', 'image/jpeg');
    await uploadFile('https://api.test', 'file:///tmp/pic2.jpg', 'pic2.jpg', 'image/jpeg');

    const presignCalls = fetchMock.mock.calls.filter((call: any[]) =>
      String(call[0]).includes('/uploads/r2-presign')
    );
    expect(presignCalls).toHaveLength(1);
    expect(MockXHR.instances).toHaveLength(2);
  });
});
