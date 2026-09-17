import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd());
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const centerTab = read('components/ui/CenterTabButton.tsx');
const createPost = read('app/(tabs)/create-post.tsx');
const profile = read('app/profile.tsx');
const discover = read('app/(tabs)/discover/mobile-community.tsx');
const publicEvent = read('app/public-event.tsx');
const gameDetails = read('app/game-details/GameDetailsScreen.tsx');
const signIn = read('app/sign-in.tsx');
const create = read('app/create.tsx');
const feedScreen = read('app/feed.tsx');
const submitAd = read('components/SubmitAdScreenBase.tsx');

describe('guest create-entry contracts', () => {
  it('routes generic create entry points through /create instead of the raw composer', () => {
    // The center "+" tab deliberately goes straight to the composer (device-test
    // feedback, commit d66c6029: team creation stays in coach Quick Actions). The
    // composer self-guards auth (see next test), so this is safe. Other generic
    // entry points (profile, discover) still funnel through the /create hub.
    expect(centerTab).toContain("void router.push('/create-post');");
    expect(profile).toContain("onPress={() => void router.push('/create')}");
    expect(discover).toContain("onPress={() => void router.push('/create')}");
  });

  it('keeps the composer self-guarded so direct navigation cannot bypass auth', () => {
    // Guest guard (2026-07-14): a render guard prevents the composer from EVER
    // drawing for a signed-out user (so a guest reaching create-post directly
    // can't flash the composer / hit a raw Unauthorized), backed by the
    // redirect to the /create login sheet.
    expect(createPost).toContain('const { user, loading: authLoading } = useAuth();');
    expect(createPost).toMatch(
      /if \(authLoading \|\| !user \|\| !\(user as any\)\?\.email_verified\)/
    );
    expect(createPost).toContain('Opening sign in...');
    expect(createPost).toContain("router.replace('/create');");
  });

  it('keeps event-scoped create paths on /create-post with sign-in prompts and game context', () => {
    expect(publicEvent).toContain("pathname: '/create-post'");
    expect(publicEvent).toContain("message: 'Sign in to post to this event.'");
    expect(gameDetails).toContain("message: 'Sign in to post a story to this event.'");
    expect(gameDetails).not.toContain('style={styles.addPostButton}');
  });

  it('keeps sign-in limited to auth actions instead of adding an extra guest CTA', () => {
    expect(signIn).not.toContain('Continue as guest');
    expect(signIn).toContain("onPress={() => void router.replace('/sign-up')}");
  });

  it('keeps ad reservation reachable for guests and prompts sign-in only when submission needs auth', () => {
    // Ad reservation entry moved from the create hub to the guest-visible
    // feed promo card.
    expect(feedScreen).toContain("router.push('/submit-ad')");
    expect(feedScreen).toContain('Reserve Your Ad Space Now');
    expect(submitAd).toContain("promptForSignIn(() => router.push('/sign-in'), {");
    expect(submitAd).toContain("message: 'Sign in to reserve ad space.'");
  });
});
