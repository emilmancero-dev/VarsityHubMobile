import { normalizeSportSlug } from '@/constants/sports';

// A Game row is only a competitive matchup when its event_type is unset or
// literally 'game' — this mirrors the server's canonical rule exactly
// (isCompetitivePollEventType in server/src/routes/games.ts).
// Non-competitive events (fundraiser, watch party, team trip, meeting, team
// meal, other) are Game rows too — they must show their own title, never
// "vs TBD".
export function gameRowTitle(g: {
  title?: string | null;
  event_type?: string | null;
  away_team?: string | null;
  away_team_name?: string | null;
  opponent?: string | null;
}): string {
  const opponent = (g.opponent || g.away_team || g.away_team_name || '').trim();
  const et = (g.event_type || '').trim().toLowerCase();
  const isCompetitive = et === '' || et === 'game';
  if (isCompetitive) return `vs ${opponent || 'TBD'}`;
  return (g.title || '').trim() || eventTypeLabel(g.event_type);
}

// Pro/college league code → canonical sport slug, so a card whose sport isn't
// stored directly (pro/NCAA fixtures carry a league, not a Team.sport) can
// still resolve a sport emoji. Mirrors server proLeagueToSport in
// eventCardSerializer.ts.
const PRO_LEAGUE_TO_SPORT: Record<string, string> = {
  nfl: 'football',
  ncaaf: 'football',
  cfb: 'football',
  nba: 'basketball',
  wnba: 'basketball',
  ncaam: 'basketball',
  ncaaw: 'basketball',
  cbb: 'basketball',
  mlb: 'baseball',
  nhl: 'ice_hockey',
  mls: 'soccer',
};

export function proLeagueToSportSlug(league?: string | null): string | null {
  if (!league) return null;
  return PRO_LEAGUE_TO_SPORT[league.trim().toLowerCase()] ?? null;
}

// Trailing "gender + sport" phrases that ingested fixture titles append, e.g.
// "Adelphi Panthers at Vermont Catamounts Womens Soccer". The emoji conveys the
// sport, so the words are redundant noise on a card. Ordered longest-first so a
// multi-word sport ("Beach Volleyball") wins over its last word ("Volleyball").
const SPORT_TAIL_PHRASES: Array<{ phrase: string; slug: string }> = [
  { phrase: 'beach volleyball', slug: 'beach_volleyball' },
  { phrase: 'cross country', slug: 'cross_country' },
  { phrase: 'field hockey', slug: 'field_hockey' },
  { phrase: 'ice hockey', slug: 'ice_hockey' },
  { phrase: 'water polo', slug: 'water_polo' },
  { phrase: 'track and field', slug: 'track_field' },
  { phrase: 'track & field', slug: 'track_field' },
  { phrase: 'swimming and diving', slug: 'swimming' },
  { phrase: 'swimming & diving', slug: 'swimming' },
  { phrase: 'volleyball', slug: 'volleyball' },
  { phrase: 'basketball', slug: 'basketball' },
  { phrase: 'football', slug: 'football' },
  { phrase: 'baseball', slug: 'baseball' },
  { phrase: 'softball', slug: 'softball' },
  { phrase: 'lacrosse', slug: 'lacrosse' },
  { phrase: 'wrestling', slug: 'wrestling' },
  { phrase: 'gymnastics', slug: 'gymnastics' },
  { phrase: 'swimming', slug: 'swimming' },
  { phrase: 'soccer', slug: 'soccer' },
  { phrase: 'softball', slug: 'softball' },
  { phrase: 'tennis', slug: 'tennis' },
  { phrase: 'hockey', slug: 'ice_hockey' },
  { phrase: 'golf', slug: 'golf' },
];

const GENDER_TAIL = new Set([
  'mens',
  "men's",
  'men',
  'womens',
  "women's",
  'women',
  'boys',
  "boys'",
  'girls',
  "girls'",
  'coed',
]);

/**
 * A compact, card-ready title: the matchup without emoji, with the redundant
 * "Womens Soccer" sport suffix, tournament prefixes, and #rankings removed.
 *
 * We intentionally do NOT try to reduce team names to bare schools — the stored
 * title has already concatenated school + mascot, and many fixtures are
 * school-only ("Ohio State at Union") or pro nicknames ("Cowboys at Giants"),
 * so dropping the last word would corrupt real names. School-only titles need
 * ingestion to store school/mascot separately.
 */
export function formatEventCardTitle(item: {
  title?: string | null;
  sport?: string | null;
  event_type?: string | null;
  pro_league?: string | null;
}): string {
  let base = String(item.title ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!base) {
    const et = (item.event_type || '').trim().toLowerCase();
    return et === '' || et === 'game' ? '' : eventTypeLabel(item.event_type);
  }

  // Drop a leading tournament label ("Duke's Mayo Classic: A vs B") only when
  // what follows the colon is itself a matchup, so we never strip a real title
  // that merely contains a colon.
  const colonIdx = base.indexOf(':');
  if (colonIdx > 0) {
    const after = base.slice(colonIdx + 1).trim();
    if (/\s(?:at|vs\.?|v)\s/i.test(after)) base = after;
  }

  // Drop ranking tokens like "#25".
  base = base
    .replace(/#\d+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Repeatedly peel a trailing "[gender] <sport>" segment. Only peel a bare
  // sport word when a gender word precedes it or it matches the known sport,
  // so a mascot that happens to be a sport-like word is never dropped.
  const knownSlug = normalizeSportSlug(item.sport);
  for (let guard = 0; guard < 4; guard += 1) {
    const lower = base.toLowerCase();
    const match = SPORT_TAIL_PHRASES.find(
      p => lower === p.phrase || lower.endsWith(' ' + p.phrase)
    );
    if (!match) break;
    const before = base.slice(0, base.length - match.phrase.length).trim();
    const prevToken = before.split(' ').pop()?.toLowerCase() ?? '';
    const genderPrecedes = GENDER_TAIL.has(prevToken);
    const matchesKnown = knownSlug != null && knownSlug === match.slug;
    const isMultiWord = match.phrase.includes(' ');
    if (!genderPrecedes && !matchesKnown && !isMultiWord) break;
    base = genderPrecedes ? before.split(' ').slice(0, -1).join(' ').trim() : before;
  }

  const title = base.replace(/\s+/g, ' ').trim();
  return title;
}

function eventTypeLabel(t?: string | null): string {
  switch ((t || '').trim().toLowerCase()) {
    case 'fundraiser':
      return 'Fundraiser';
    case 'watch_party':
      return 'Watch Party';
    case 'team_trip':
      return 'Team Trip';
    case 'meeting':
      return 'Meeting';
    case 'team_meal':
      return 'Team Meal';
    default:
      return 'Event';
  }
}
