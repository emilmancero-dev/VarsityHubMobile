import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function read(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

describe('event-card post-count removal', () => {
  it('does not add post-count badges to feed or profile event cards', () => {
    expect(read('app/feed.tsx')).not.toContain('EventPostCountBadge');
    expect(read('app/profile.tsx')).not.toContain('EventPostCountBadge');
  });
});
