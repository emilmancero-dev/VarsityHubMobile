import { getVideoPlaybackSource, optimizeVideoUrl, optimizeImageUrl } from '../imageUrl';
const mp4 =
  'https://res.cloudinary.com/demo/video/upload/c_limit,w_1280,h_1280,vc_h264,ac_aac,f_mp4,q_auto/v123/varsityhub/media/clip.mp4';
it('uses prepared adaptive video natively and canonical MP4 on web', () => {
  expect(getVideoPlaybackSource(mp4, 'ios')).toEqual({
    uri: 'https://res.cloudinary.com/demo/video/upload/sp_hd/v123/varsityhub/media/clip.m3u8',
    fallbackUri: mp4,
  });
  expect(getVideoPlaybackSource(mp4, 'web')).toEqual({ uri: mp4 });
  expect(optimizeVideoUrl(mp4)).toBe(mp4);
});
it('does not invent streaming manifests for legacy or unverified URLs', () => {
  for (const url of [
    'https://media.example.com/clip.mp4',
    'https://res.cloudinary.com/demo/video/upload/v123/old.mp4',
    mp4.replace('/media/', '/old/'),
  ]) {
    expect(getVideoPlaybackSource(url, 'ios')).toEqual({ uri: url });
  }
});
it('preserves the exact prepared poster instead of requesting an unprepared transform', () => {
  const poster =
    'https://res.cloudinary.com/demo/video/upload/so_0,w_480,f_jpg/v123/varsityhub/media/clip.jpg';
  expect(optimizeImageUrl(poster, 900)).toBe(poster);
});

it('uses the prepared 1080p ladder for new videos while preserving the canonical MP4', () => {
  const fullHd = mp4.replace('w_1280,h_1280', 'w_1920,h_1920');
  expect(getVideoPlaybackSource(fullHd, 'ios')).toEqual({
    uri: 'https://res.cloudinary.com/demo/video/upload/sp_full_hd/v123/varsityhub/media/clip.m3u8',
    fallbackUri: fullHd,
  });
  expect(optimizeVideoUrl(fullHd)).toBe(fullHd);
  expect(getVideoPlaybackSource(fullHd, 'web')).toEqual({ uri: fullHd });
});
