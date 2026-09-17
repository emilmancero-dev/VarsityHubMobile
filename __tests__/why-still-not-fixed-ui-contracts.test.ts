import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');

describe('September 2026 event-page UI regressions', () => {
  it('keeps loaded event content visible during a background refresh', () => {
    const source = read('app', 'game-details', 'GameDetailsScreen.tsx');
    expect(source).toContain('{vm ? (');
    expect(source).not.toContain('{vm && !loading ? (');
  });

  it('does not render the corner add-post control on an event page', () => {
    const source = read('app', 'game-details', 'GameDetailsScreen.tsx');
    expect(source).not.toContain('style={styles.addPostButton}');
  });

  it('uses Games Attended everywhere instead of Watching History', () => {
    const files = [
      read('app', 'rsvp-history.tsx'),
      read('app', 'settings', 'index.tsx'),
      read('app', 'settings', '_layout.tsx'),
    ];
    expect(files.join('\n')).not.toContain('Watching History');
    expect(files.join('\n')).toContain('Games Attended');
    expect(files[0]).toContain('User.eventPagesForProfile');
    expect(files[0]).not.toContain('myRsvps');
  });
});
