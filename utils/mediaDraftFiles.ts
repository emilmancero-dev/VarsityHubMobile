import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import * as FileSystem from 'expo-file-system/legacy';

export function mediaDraftDirectory(): string {
  if (!FileSystem.documentDirectory) throw new Error('Persistent media storage is unavailable.');
  return `${FileSystem.documentDirectory}MediaDrafts/`;
}

export function isOwnedMediaDraft(uri: string): boolean {
  if (!FileSystem.documentDirectory) return false;
  const directory = mediaDraftDirectory();
  if (!uri.startsWith(directory) || uri.endsWith('/')) return false;
  try {
    return !uri
      .slice(directory.length)
      .split('/')
      .some(part => part === '..' || decodeURIComponent(part).includes('..'));
  } catch {
    return false;
  }
}

/** Copy before checkpoint persistence; Documents survives OS cache eviction. */
export async function persistPreparedMedia(uri: string): Promise<string> {
  if (Platform.OS === 'web') return uri;
  if (isOwnedMediaDraft(uri)) return uri;
  if (Platform.OS === 'ios') {
    const native = requireOptionalNativeModule<{ prepareDraftDirectory(): Promise<string> }>(
      'VarsityMediaPicker'
    );
    if (native?.prepareDraftDirectory) await native.prepareDraftDirectory();
  }
  const directory = `${mediaDraftDirectory()}prepared/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const extension =
    uri
      .split(/[?#]/)[0]
      .split('.')
      .pop()
      ?.replace(/[^a-zA-Z0-9]/g, '') || 'mp4';
  const destination = `${directory}${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
  await FileSystem.copyAsync({ from: uri, to: destination });
  const info = await FileSystem.getInfoAsync(destination);
  if (!info.exists || info.isDirectory || !Number.isFinite(info.size) || info.size <= 0) {
    await FileSystem.deleteAsync(destination, { idempotent: true });
    throw new Error('Could not preserve the prepared media. Please retry.');
  }
  return destination;
}

/** Call only after the server confirms the post has been saved. */
export async function deleteConfirmedMediaDraft(uri: string): Promise<void> {
  if (isOwnedMediaDraft(uri)) await FileSystem.deleteAsync(uri, { idempotent: true });
}
