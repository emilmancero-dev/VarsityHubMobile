import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, Image, Platform } from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';
import { prepareVideoForUpload } from '@/utils/compressVideo';
import { uploadVideo } from '@/api/videoUpload';

jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useFocusEffect: () => {},
}));

jest.mock('expo-linear-gradient', () =>
  require('@/test-utils/screenMocks').expoLinearGradientMock()
);
jest.mock('react-native-safe-area-context', () =>
  require('@/test-utils/screenMocks').safeAreaMock()
);
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  ...require('@/test-utils/screenMocks').expoRouterOverrides(),
}));
jest.mock('@/components/KeyboardAwareScreen', () =>
  require('@/test-utils/screenMocks').childSentinelMock('KeyboardAwareScreen')()
);
jest.mock('@/components/SwipeBackContainer', () =>
  require('@/test-utils/screenMocks').childSentinelMock('SwipeBackContainer')()
);
jest.mock('@/components/VideoPlayer', () =>
  require('@/test-utils/screenMocks').childSentinelMock('VideoPlayer')()
);
jest.mock('@/components/VideoTrimmer', () =>
  require('@/test-utils/screenMocks').childSentinelMock('VideoTrimmer')()
);
jest.mock('@/components/ui/MentionInput', () => ({
  MentionInput: require('@/test-utils/screenMocks').hostPassthrough('MentionInput'),
}));
jest.mock('@/context/AuthProvider', () => {
  const user = { id: 'photo-owner', email_verified: true, preferences: {} };
  return { useAuth: () => ({ user, loading: false }) };
});
jest.mock('@/context/PostCacheContext', () => ({ usePostCache: () => ({ clear: jest.fn() }) }));
jest.mock('@/hooks/useColorScheme', () => ({ useColorScheme: () => 'light' }));
jest.mock('@/hooks/useDeviceLocation', () => ({
  useDeviceLocation: () => ({
    location: null,
    permissionGranted: false,
    requestPermission: async () => false,
  }),
}));
jest.mock('@/utils/analytics', () => ({ analytics: { track: jest.fn() }, ANALYTICS_EVENTS: {} }));
jest.mock('@/utils/sentry', () => ({ captureException: jest.fn() }));
jest.mock('@/utils/mediaDraftFiles', () => ({ persistPreparedMedia: async (uri: string) => uri }));
jest.mock('@/utils/compressVideo', () => ({
  cleanupConfirmedVideoDraft: jest.fn(),
  prepareVideoForUpload: jest.fn(),
  uploadTimeoutMsForSize: () => 300000,
}));
jest.mock('@/api/videoUpload', () => ({ uploadVideo: jest.fn() }));
jest.mock('@/api/auth', () => ({ __esModule: true, default: { getToken: async () => 'token' } }));
jest.mock('@/api/http', () => ({
  getApiBaseUrl: () => 'https://api.test',
  getAccessTokenForRequest: async () => 'token',
}));
jest.mock('@/hooks/useVerificationGate', () => ({
  openVerificationGate: jest.fn(),
  isEmailVerificationRequiredError: () => false,
}));
let mockDraft: any = null;
jest.mock('@/api/settings', () => ({
  __esModule: true,
  default: {
    SETTINGS_KEYS: { POST_DRAFT: 'draft' },
    getJson: async () => mockDraft,
    setJson: async (_key: string, value: any) => {
      mockDraft = value;
    },
  },
}));
const mockCreate = jest.fn();
jest.mock('@/api/entities', () => ({
  Game: { list: async () => [] },
  Event: { filter: async () => [] },
  Post: { create: (...args: any[]) => mockCreate(...args) },
}));
const mockPick = jest.fn();
jest.mock('@/utils/pickMedia', () => ({
  launchMediaLibraryAsync: (...args: any[]) => mockPick(...args),
  launchMediaCameraAsync: (...args: any[]) => mockPick(...args),
}));
jest.mock('expo-image-picker', () => ({
  ...require('@/test-utils/screenMocks').expoImagePickerMock(),
  VideoExportPreset: { Passthrough: 0 },
  requestMediaLibraryPermissionsAsync: async () => ({ granted: true, status: 'granted' }),
  requestCameraPermissionsAsync: async () => ({ granted: true }),
}));
jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  manipulateAsync: jest.fn(),
}));
const mockPut = jest.fn();
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: async () => ({ exists: true, size: 3 * 1024 * 1024 }),
  FileSystemUploadType: { BINARY_CONTENT: 'binary' },
  createUploadTask: (...args: any[]) => {
    mockPut(...args);
    return { uploadAsync: async () => ({ status: 200 }), cancelAsync: async () => {} };
  },
}));

import CreatePostScreen from '../(tabs)/create-post';

const originalFetch = global.fetch;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockDraft = null;
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  jest.spyOn(Image, 'getSize').mockImplementation((_uri, success) => success(1200, 4000));
  (ImageManipulator.manipulateAsync as jest.Mock).mockResolvedValue({
    uri: 'file:///prepared.jpg',
  });
  mockCreate.mockResolvedValue({ id: 'created-post' });
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      uploadUrl: 'https://storage.test/put',
      publicUrl: 'https://media.test/photo',
      contentLength: 3 * 1024 * 1024,
    }),
  })) as any;
});
afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});

it('submits exactly 800 characters without truncating them', async () => {
  render(<CreatePostScreen />);
  await act(async () => {});
  const input = screen.UNSAFE_getByType('MentionInput' as any);
  expect(input.props.maxLength).toBe(800);
  fireEvent(input, 'changeText', 'a'.repeat(800));
  fireEvent.press(screen.getByTestId('create-post-submit-button'));
  fireEvent.press(screen.getByLabelText('Confirm and post'));
  await waitFor(() => expect(mockCreate).toHaveBeenCalled());
  expect(mockCreate.mock.calls[0][0].content).toBe('a'.repeat(800));
});

it('blocks oversize restored drafts before preview or upload without losing text', async () => {
  const content = 'd'.repeat(801);
  mockDraft = { content, ownerId: 'photo-owner' };
  const alert = jest.spyOn(Alert, 'alert');
  render(<CreatePostScreen />);
  await act(async () => {});
  const restore = alert.mock.calls
    .find(call => call[0] === 'Restore draft?')?.[2]
    ?.find(button => button.text === 'Restore');
  expect(restore).toBeDefined();
  await act(async () => {
    restore?.onPress?.();
  });
  fireEvent.press(screen.getByTestId('create-post-submit-button'));
  expect(
    screen.getByText('Posts are limited to 800 characters. Shorten your text to continue.')
  ).toBeTruthy();
  expect(screen.queryByLabelText('Confirm and post')).toBeNull();
  expect(screen.UNSAFE_getByType('MentionInput' as any).props.value).toBe(content);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockPut).not.toHaveBeenCalled();
  alert.mockRestore();
});

it.each([false, true])(
  'corrects a rejected legacy draft preserving identity (replace media: %s)',
  async replaceMedia => {
    const pendingPayload = { client_request_id: 'legacy-pending-001', content: 'p'.repeat(1200) };
    mockDraft = {
      ownerId: 'photo-owner',
      content: pendingPayload.content,
      picked: { uri: 'file:///previous.jpg', type: 'image', mime: 'image/jpeg' },
      recovery: {
        ownerId: 'photo-owner',
        pendingPayload,
        sourceUri: 'file:///previous.jpg',
        upload: { url: 'https://media.test/photo' },
      },
    };
    mockCreate.mockRejectedValueOnce({
      status: 400,
      data: {
        error: 'Invalid payload',
        code: 'POST_CONTENT_TOO_LONG',
        issues: [{ path: ['content'], message: 'Posts are limited to 800 characters.' }],
      },
    });
    const alert = jest.spyOn(Alert, 'alert');
    render(<CreatePostScreen />);
    await act(async () => {});
    const restore = alert.mock.calls
      .find(call => call[0] === 'Restore draft?')?.[2]
      ?.find(button => button.text === 'Restore');
    await act(async () => {
      restore?.onPress?.();
    });
    fireEvent.press(screen.getByTestId('create-post-submit-button'));
    fireEvent.press(screen.getByLabelText('I confirm I personally filmed or own this content'));
    fireEvent.press(screen.getByLabelText('Confirm and upload'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.getByText('Posts are limited to 800 characters. Shorten your text to continue.')
      ).toBeTruthy()
    );
    expect(mockDraft.recovery.upload.url).toBe('https://media.test/photo');
    expect(screen.UNSAFE_getByType('MentionInput' as any).props.value).toBe(pendingPayload.content);
    fireEvent(screen.UNSAFE_getByType('MentionInput' as any), 'changeText', 'Corrected caption');
    if (replaceMedia) {
      mockPick.mockResolvedValue({
        canceled: false,
        assets: [{ uri: 'file:///replacement.jpg', mimeType: 'image/jpeg', type: 'image' }],
      });
      fireEvent.press(screen.getByTestId('create-post-photo-picker'));
      await waitFor(() =>
        expect(
          screen
            .UNSAFE_getAllByType(Image)
            .some(item => item.props.source?.uri === 'file:///replacement.jpg')
        ).toBe(true)
      );
    }
    fireEvent.press(screen.getByTestId('create-post-submit-button'));
    if (replaceMedia) {
      fireEvent.press(screen.getByLabelText('I confirm I personally filmed or own this content'));
    }
    fireEvent.press(screen.getByLabelText('Confirm and upload'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(2));
    expect(mockCreate.mock.calls[1][0]).toMatchObject({
      client_request_id: 'legacy-pending-001',
      content: 'Corrected caption',
      media_url: 'https://media.test/photo',
    });
    expect(mockPut).toHaveBeenCalledTimes(replaceMedia ? 1 : 0);
    alert.mockRestore();
  }
);

it.each([
  ['jpeg', 'image/jpeg', 1, 'file:///prepared.jpg', 'image/jpeg'],
  ['heic', 'image/heic', 1, 'file:///prepared.jpg', 'image/jpeg'],
  ['png', 'image/png', 0, 'file:///selected.png', 'image/png'],
  ['gif', 'image/gif', 0, 'file:///selected.gif', 'image/gif'],
  ['camera', 'image/jpeg', 1, 'file:///prepared.jpg', 'image/jpeg'],
])(
  'selects and uploads %s with one preparation authority',
  async (extension, mime, encodes, output, outputMime) => {
    mockPick.mockResolvedValue({
      canceled: false,
      assets: [{ uri: `file:///selected.${extension}`, mimeType: mime, type: 'image' }],
    });
    render(<CreatePostScreen />);
    await act(async () => {});
    fireEvent.press(
      screen.getByTestId(
        extension === 'camera' ? 'create-post-camera-picker' : 'create-post-photo-picker'
      )
    );
    await waitFor(() => expect(screen.getByTestId('create-post-remove-media-button')).toBeTruthy());
    fireEvent.press(screen.getByTestId('create-post-submit-button'));
    fireEvent.press(screen.getByLabelText('I confirm I personally filmed or own this content'));
    fireEvent.press(screen.getByLabelText('Confirm and upload'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(ImageManipulator.manipulateAsync).toHaveBeenCalledTimes(encodes);
    expect(mockPut).toHaveBeenCalledWith(
      'https://storage.test/put',
      output,
      expect.objectContaining({
        headers: expect.objectContaining({ 'Content-Type': outputMime }),
      }),
      expect.any(Function)
    );
  }
);

it('uploads at most five selected photos, encoding each JPEG once', async () => {
  mockPick.mockResolvedValue({
    canceled: false,
    assets: Array.from({ length: 6 }, (_, i) => ({
      uri: `file:///photo-${i}.jpg`,
      mimeType: 'image/jpeg',
      type: 'image',
    })),
  });
  render(<CreatePostScreen />);
  await act(async () => {});
  fireEvent.press(screen.getByTestId('create-post-photo-picker'));
  await waitFor(() => expect(screen.getByTestId('create-post-extra-photo-strip')).toBeTruthy());
  fireEvent.press(screen.getByTestId('create-post-submit-button'));
  fireEvent.press(screen.getByLabelText('I confirm I personally filmed or own this content'));
  fireEvent.press(screen.getByLabelText('Confirm and upload'));
  await waitFor(() => expect(mockCreate).toHaveBeenCalled());
  expect(ImageManipulator.manipulateAsync).toHaveBeenCalledTimes(5);
  expect(mockPut).toHaveBeenCalledTimes(5);
});

it('does not upload or create a post when image preparation fails', async () => {
  (ImageManipulator.manipulateAsync as jest.Mock).mockRejectedValue(new Error('Unreadable image'));
  mockPick.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///photo.jpg', mimeType: 'image/jpeg', type: 'image' }],
  });
  render(<CreatePostScreen />);
  await act(async () => {});
  fireEvent.press(screen.getByTestId('create-post-photo-picker'));
  await waitFor(() => expect(screen.getByTestId('create-post-remove-media-button')).toBeTruthy());
  fireEvent.press(screen.getByTestId('create-post-submit-button'));
  fireEvent.press(screen.getByLabelText('I confirm I personally filmed or own this content'));
  fireEvent.press(screen.getByLabelText('Confirm and upload'));
  await waitFor(() =>
    expect(screen.getByText('Failed to create post. Please try again.')).toBeTruthy()
  );
  expect(mockPut).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockDraft.picked.uri).toBe('file:///photo.jpg');
});

it('Cancel upload reaches video preparation and preserves the draft without publishing', async () => {
  let preparationSignal: AbortSignal | undefined;
  let finishPreparation!: (value: any) => void;
  (prepareVideoForUpload as jest.Mock).mockImplementation((_uri, options) => {
    preparationSignal = options?.signal;
    return new Promise(resolve => {
      finishPreparation = resolve;
    });
  });
  mockPick.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///video.mp4', mimeType: 'video/mp4', type: 'video', duration: 10000 }],
  });
  render(<CreatePostScreen />);
  await act(async () => {});
  fireEvent.press(screen.getByTestId('create-post-video-picker'));
  await waitFor(() => expect(screen.getByTestId('create-post-remove-media-button')).toBeTruthy());
  fireEvent.press(screen.getByTestId('create-post-submit-button'));
  fireEvent.press(screen.getByLabelText('I confirm I personally filmed or own this content'));
  fireEvent.press(screen.getByLabelText('Confirm and upload'));
  await waitFor(() => expect(prepareVideoForUpload).toHaveBeenCalled());
  fireEvent.press(screen.getByLabelText('Cancel upload'));
  expect(screen.getByLabelText('Cancelling upload')).toBeDisabled();
  await act(async () => {
    finishPreparation({ uri: 'file:///video.mp4', finalSizeBytes: 3000000 });
  });
  await waitFor(() =>
    expect(screen.getByText('Upload paused. Your draft is saved; retry when ready.')).toBeTruthy()
  );
  expect(preparationSignal?.aborted).toBe(true);
  expect(uploadVideo).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockDraft.picked.uri).toBe('file:///video.mp4');
});
