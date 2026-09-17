import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd());
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const discoverScreen = read('app/(tabs)/discover/mobile-community.tsx');
// ProfileScreen.tsx was deleted; app/profile.tsx is the live profile screen.
const profileScreen = read('app/profile.tsx');
const feedScreen = read('app/feed.tsx');
const gameDetailsScreen = read('app/game-details/GameDetailsScreen.tsx');
const teamScreen = read('app/team-page.tsx');
const eventDetailScreen = read('app/(tabs)/event-detail.tsx');
// RSVP/posting auth prompts moved to the public-event page when event-detail
// became a legacy redirector (2026-07-05).
const publicEventScreen = read('app/public-event.tsx');

describe('discover result screen contracts', () => {
  it('discover result taps route to the canonical user, team, organization, game, and event screens', () => {
    expect(discoverScreen).toContain(
      "import { buildEventDetailRoute } from '@/utils/eventRoutes';"
    );
    expect(discoverScreen).toContain('void router.push(`/user-profile?id=${u.id}`);');
    expect(discoverScreen).toContain('void router.push(`/team-page?id=${t.id}`);');
    expect(discoverScreen).toMatch(
      /void router\.push\(\{\s*pathname: '\/organization',\s*params: \{ id: String\(o\.id\) \},\s*\} as any\);/
    );
    expect(discoverScreen).toContain(
      "void router.push({ pathname: '/game/[id]', params: { id: String(game.id) } });"
    );
    expect(discoverScreen).toContain(
      'void router.push(buildEventDetailRoute(event.id, event.game_id));'
    );
  });

  it('profile screen fails closed with retryable error states instead of a permanent loading spinner', () => {
    expect(profileScreen).toContain(
      "setError(viewingUserId ? 'User not found.' : 'You need to sign in to view your profile.')"
    );
    expect(profileScreen).toContain(
      "setError('This user was not found or may have been deleted.')"
    );
    expect(profileScreen).toContain('profileRequestInFlight.current = false;');
    expect(profileScreen).toContain('setLoading(false);');
    expect(profileScreen).toContain(
      "<Text style={[styles.error, { color: theme.text, textAlign: 'center', marginBottom: 8 }]}>"
    );
    expect(profileScreen).toContain('<Button onPress={() => void loadProfile()}>');
    // app/profile.tsx fails closed with an inline error state ("You need to sign
    // in to view your profile.") rather than redirecting to /sign-in — so the
    // ProfileScreen-only sign-in-redirect assertions don't apply here.
  });

  it('team screen rejects invalid or missing params and exits loading in all cases', () => {
    // team-page reads through react-query: the error is derived from the param
    // guards (not imperative setError) and loading is gated on isPending, so the
    // screen always exits the spinner for invalid/missing IDs.
    expect(teamScreen).toContain("? 'Invalid team ID format'");
    expect(teamScreen).toContain("? 'No team ID or name provided'");
    expect(teamScreen).toContain('teamQuery.isPending');
    expect(teamScreen).toContain(
      '<Text style={[styles.error, { color: theme.text }]}>Team not found</Text>'
    );
    expect(teamScreen).toContain(
      '<Pressable onPress={() => void teamQuery.refetch()} style={styles.retryButton}>'
    );
  });

  it('team screen surfaces venue and organization context from the public summary payload', () => {
    expect(teamScreen).toContain('venue_address?: string | null;');
    expect(teamScreen).toContain(
      "const teamVenue = typeof team?.venue_address === 'string' ? team.venue_address.trim() : '';"
    );
    expect(teamScreen).toContain('const teamOrganizationName =');
    expect(teamScreen).toContain("pathname: '/organization'");
    expect(teamScreen).toContain('Ionicons name="location-outline"');
    expect(teamScreen).toContain('Ionicons name="business-outline"');
  });

  it('public-event gates RSVP posting behind the shared sign-in prompt', () => {
    // event-detail is now a legacy redirector (no RSVP UI); the standalone-event
    // posting flow lives on public-event and gates guests through the shared
    // promptForSignIn helper (the app-wide guest-UX convention).
    expect(eventDetailScreen).toContain('LEGACY REDIRECTOR');
    expect(publicEventScreen).toContain("import { promptForSignIn } from '@/utils/requireSignIn';");
    expect(publicEventScreen).toContain("void router.push('/sign-in');");
    expect(publicEventScreen).toContain("message: 'Sign in to post to this event.',");
  });

  it('feed and game details keep explicit sign-in entry points for gated actions', () => {
    expect(feedScreen).toContain("router.replace('/sign-in')");
    expect(feedScreen).toContain("void router.push('/sign-in')");
    expect(gameDetailsScreen).toContain("promptForSignIn(() => router.push('/sign-in')");
    expect(gameDetailsScreen).toContain("message: 'Sign in to post a story to this event.'");
  });
});
