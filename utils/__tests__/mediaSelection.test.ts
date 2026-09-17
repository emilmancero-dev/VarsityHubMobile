import { removePrimaryPhoto, selectPhotoForPreview } from '../mediaSelection';

const primary = { uri: 'one.jpg', type: 'image' as const, mime: 'image/jpeg' };
const extras = [
  { uri: 'two.jpg', mime: 'image/jpeg' },
  { uri: 'three.jpg', mime: 'image/jpeg' },
];

describe('multi-photo selection', () => {
  it('removing the primary photo promotes the next photo instead of clearing all', () => {
    expect(removePrimaryPhoto(primary, extras)).toEqual({
      primary: { uri: 'two.jpg', type: 'image', mime: 'image/jpeg' },
      extras: [{ uri: 'three.jpg', mime: 'image/jpeg' }],
    });
  });

  it('lets each thumbnail become the full-size preview without losing another photo', () => {
    expect(selectPhotoForPreview(primary, extras, 1)).toEqual({
      primary: { uri: 'three.jpg', type: 'image', mime: 'image/jpeg' },
      extras: [
        { uri: 'two.jpg', mime: 'image/jpeg' },
        { uri: 'one.jpg', mime: 'image/jpeg' },
      ],
    });
  });
});
