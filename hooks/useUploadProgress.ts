import { toUserMessage } from '@/utils/toUserMessage';
/**
 * Hook to track upload progress with visual feedback
 */
import { useCallback, useState } from 'react';
import { uploadFileWithProgress, UploadProgressCallback } from '@/api/upload';
import { getApiBaseUrl } from '@/api/http';

export interface UploadState {
  /** Whether upload is in progress */
  uploading: boolean;
  /** Progress percentage (0-100) */
  progress: number;
  /** Bytes uploaded */
  loaded: number;
  /** Total bytes to upload */
  total: number;
  /** Error message if upload failed */
  error: string | null;
  /** Result from successful upload */
  result: any | null;
}

export interface UseUploadProgressReturn extends UploadState {
  /** Start an upload */
  upload: (uri: string, filename?: string, mimeType?: string) => Promise<any>;
  /** Reset state */
  reset: () => void;
  /** Formatted progress text (e.g., "45% (2.3 MB / 5.1 MB)") */
  progressText: string;
}

const initialState: UploadState = {
  uploading: false,
  progress: 0,
  loaded: 0,
  total: 0,
  error: null,
  result: null,
};

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Hook for tracking file upload progress
 *
 * @example
 * ```tsx
 * const { upload, uploading, progress, progressText, error } = useUploadProgress();
 *
 * const handleUpload = async () => {
 *   const result = await upload(fileUri, 'photo.jpg', 'image/jpeg');
 *   if (result) {
 *     if (__DEV__) console.log('Uploaded to:', result.url);
 *   }
 * };
 *
 * // In render:
 * {uploading && (
 *   <View>
 *     <ProgressBar progress={progress / 100} />
 *     <Text>{progressText}</Text>
 *   </View>
 * )}
 * ```
 */
export function useUploadProgress(): UseUploadProgressReturn {
  const [state, setState] = useState<UploadState>(initialState);

  const reset = useCallback(() => {
    setState(initialState);
  }, []);

  const upload = useCallback(
    async (uri: string, filename?: string, mimeType?: string): Promise<any> => {
      setState({
        ...initialState,
        uploading: true,
      });

      const onProgress: UploadProgressCallback = (progress, loaded, total) => {
        setState(prev => ({
          ...prev,
          progress,
          loaded,
          total,
        }));
      };

      try {
        const result = await uploadFileWithProgress(
          getApiBaseUrl(),
          uri,
          filename,
          mimeType,
          { onProgress, timeoutMs: 300000 } // 5 minute timeout for large files
        );

        setState(prev => ({
          ...prev,
          uploading: false,
          progress: 100,
          result,
          error: null,
        }));

        return result;
      } catch (err: any) {
        const errorMessage = toUserMessage(err, 'Upload failed');
        setState(prev => ({
          ...prev,
          uploading: false,
          error: errorMessage,
          result: null,
        }));
        throw err;
      }
    },
    []
  );

  // Generate progress text
  const progressText =
    state.uploading || state.progress > 0
      ? state.total > 0
        ? `${state.progress}% (${formatBytes(state.loaded)} / ${formatBytes(state.total)})`
        : `${state.progress}%`
      : '';

  return {
    ...state,
    upload,
    reset,
    progressText,
  };
}

export default useUploadProgress;
