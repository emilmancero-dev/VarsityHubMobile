type PrimaryPhoto = { uri: string; type: 'image' | 'video'; mime?: string };
type ExtraPhoto = { uri: string; mime: string };

export function removePrimaryPhoto(primary: PrimaryPhoto, extras: ExtraPhoto[]) {
  const [next, ...remaining] = extras;
  return {
    primary: next ? { ...next, type: 'image' as const } : null,
    extras: remaining,
  };
}

export function selectPhotoForPreview(primary: PrimaryPhoto, extras: ExtraPhoto[], index: number) {
  const selected = extras[index];
  if (!selected) return { primary, extras };
  return {
    primary: { ...selected, type: 'image' as const },
    extras: extras.map((item, itemIndex) =>
      itemIndex === index ? { uri: primary.uri, mime: primary.mime ?? 'image/jpeg' } : item
    ),
  };
}
