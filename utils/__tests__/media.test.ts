import { describe, expect, it } from '@jest/globals';
import {
  clampFullscreenMediaOffset,
  getCloudinaryVideoPreviewUrl,
  getVerticalPostContentFit,
  resolveMediaType,
  resolvePostMedia,
} from '../media';

describe('full-post media presentation', () => {
  it('shows the complete image or video in the vertical viewer', () => {
    expect(getVerticalPostContentFit()).toBe('contain');
  });

  it('locks panning at normal scale and bounds it while zoomed', () => {
    expect(clampFullscreenMediaOffset(80, 1, 390)).toBe(0);
    expect(clampFullscreenMediaOffset(500, 2, 390)).toBe(195);
    expect(clampFullscreenMediaOffset(-500, 2, 390)).toBe(-195);
  });
});

describe('resolveMediaType', () => {
  it('returns null when there is no media url', () => {
    expect(resolveMediaType(null, 'video')).toBeNull();
    expect(resolveMediaType(undefined, 'image')).toBeNull();
  });

  it('trusts explicit media_type from the API', () => {
    expect(resolveMediaType('https://example.com/asset', 'video')).toBe('video');
    expect(resolveMediaType('https://example.com/asset', 'image')).toBe('image');
  });

  it('detects video urls with query params and hash fragments', () => {
    expect(resolveMediaType('https://cdn.example.com/clip.mp4?token=123#t=2', null)).toBe('video');
  });

  it('detects mkv videos that older client regexes missed', () => {
    expect(resolveMediaType('https://cdn.example.com/clip.mkv', null)).toBe('video');
  });
});

describe('resolvePostMedia', () => {
  it('uses preview_url for video thumbnails', () => {
    expect(
      resolvePostMedia({
        media_url: 'https://cdn.example.com/clip.mp4',
        media_type: 'video',
        preview_url: 'https://cdn.example.com/clip.jpg',
      })
    ).toMatchObject({
      isVideo: true,
      displayImageUrl: 'https://cdn.example.com/clip.jpg',
    });
  });

  it('never tries to render the raw video url as an image when preview is missing', () => {
    expect(
      resolvePostMedia({
        media_url: 'https://cdn.example.com/clip.mp4?token=123',
        media_type: 'video',
      })
    ).toMatchObject({
      isVideo: true,
      displayImageUrl: null,
    });
  });

  it('derives a Cloudinary preview when the API omits preview_url', () => {
    expect(
      resolvePostMedia({
        media_url: 'https://res.cloudinary.com/demo/video/upload/v123/clip.mp4',
        media_type: 'video',
      })
    ).toMatchObject({
      isVideo: true,
      displayImageUrl:
        'https://res.cloudinary.com/demo/video/upload/f_webp,fl_awebp,du_3,so_0,w_480,q_60/v123/clip.mp4',
    });
  });
});

describe('getCloudinaryVideoPreviewUrl', () => {
  it('returns null for non-Cloudinary videos', () => {
    expect(getCloudinaryVideoPreviewUrl('https://cdn.example.com/clip.mp4')).toBeNull();
  });
});
