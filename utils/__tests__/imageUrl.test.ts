import { optimizeImageUrl } from '../imageUrl';

describe('optimizeImageUrl', () => {
  it('returns undefined for undefined input', () => {
    expect(optimizeImageUrl(undefined)).toBeUndefined();
  });

  it('returns undefined for null input', () => {
    expect(optimizeImageUrl(null)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(optimizeImageUrl('')).toBeUndefined();
  });

  it('returns non-Cloudinary URLs unchanged', () => {
    const url = 'https://example.com/image.jpg';
    expect(optimizeImageUrl(url)).toBe(url);
  });

  it('inserts default transform (w_600,q_auto,f_auto) into Cloudinary URL', () => {
    const url = 'https://res.cloudinary.com/demo/image/upload/sample.jpg';
    const result = optimizeImageUrl(url);
    expect(result).toBe(
      'https://res.cloudinary.com/demo/image/upload/w_600,q_auto,f_auto/sample.jpg'
    );
  });

  it('inserts custom width transform into Cloudinary URL', () => {
    const url = 'https://res.cloudinary.com/demo/image/upload/sample.jpg';
    const result = optimizeImageUrl(url, 300);
    expect(result).toBe(
      'https://res.cloudinary.com/demo/image/upload/w_300,q_auto,f_auto/sample.jpg'
    );
  });

  it('handles Cloudinary URL with existing path segments', () => {
    const url = 'https://res.cloudinary.com/demo/image/upload/v1234567890/folder/photo.png';
    const result = optimizeImageUrl(url, 800);
    expect(result).toContain('w_800,q_auto,f_auto');
    expect(result).toContain('/upload/w_800,q_auto,f_auto/');
  });

  it('only modifies the /upload/ segment, not other occurrences of upload in path', () => {
    const url = 'https://res.cloudinary.com/demo/image/upload/upload-folder/photo.jpg';
    const result = optimizeImageUrl(url);
    // Should only replace the first /upload/
    expect(result).toBe(
      'https://res.cloudinary.com/demo/image/upload/w_600,q_auto,f_auto/upload-folder/photo.jpg'
    );
  });
});
