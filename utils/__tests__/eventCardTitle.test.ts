import { formatEventCardTitle, proLeagueToSportSlug } from '../eventTitle';

describe('proLeagueToSportSlug', () => {
  it('maps common pro/college leagues to sport slugs', () => {
    expect(proLeagueToSportSlug('nfl')).toBe('football');
    expect(proLeagueToSportSlug('ncaaf')).toBe('football');
    expect(proLeagueToSportSlug('nba')).toBe('basketball');
    expect(proLeagueToSportSlug('wnba')).toBe('basketball');
    expect(proLeagueToSportSlug('mlb')).toBe('baseball');
    expect(proLeagueToSportSlug('nhl')).toBe('ice_hockey');
    expect(proLeagueToSportSlug('mls')).toBe('soccer');
  });
  it('is case-insensitive and returns null for unknown', () => {
    expect(proLeagueToSportSlug('NFL')).toBe('football');
    expect(proLeagueToSportSlug('quidditch')).toBeNull();
    expect(proLeagueToSportSlug(null)).toBeNull();
  });
});

describe('formatEventCardTitle', () => {
  it('keeps emoji out of titles and strips the redundant gender+sport suffix', () => {
    expect(
      formatEventCardTitle({
        title: 'Adelphi Panthers at Vermont Catamounts Womens Soccer',
        sport: 'soccer',
      })
    ).toBe('Adelphi Panthers at Vermont Catamounts');
  });

  it('derives the emoji from the stripped sport word when sport is absent', () => {
    expect(
      formatEventCardTitle({
        title: 'Cal State Bakersfield Roadrunners at Saint Mary’s Gaels Womens Volleyball',
      })
    ).toBe('Cal State Bakersfield Roadrunners at Saint Mary’s Gaels');
  });

  it('handles Mens prefix and multi-word sports', () => {
    expect(
      formatEventCardTitle({
        title: 'Bowling Green State Falcons at Milwaukee Panthers Mens Soccer',
      })
    ).toBe('Bowling Green State Falcons at Milwaukee Panthers');
  });

  it('strips a doubled gender+sport suffix', () => {
    expect(
      formatEventCardTitle({
        title: "Syracuse Orange at Mercyhurst Lakers Women's Hockey Womens Hockey",
        sport: 'ice_hockey',
      })
    ).toBe('Syracuse Orange at Mercyhurst Lakers');
  });

  it('leaves school-only NCAA titles intact (never drops a real name as a mascot)', () => {
    expect(formatEventCardTitle({ title: 'Ohio State at Union', sport: 'football' })).toBe(
      'Ohio State at Union'
    );
    expect(formatEventCardTitle({ title: 'Maine at Cornell', sport: 'ice_hockey' })).toBe(
      'Maine at Cornell'
    );
  });

  it('uses pro_league for the emoji and keeps single-word pro nicknames', () => {
    expect(
      formatEventCardTitle({ title: 'Cowboys at Giants', event_type: 'game', pro_league: 'nfl' })
    ).toBe('Cowboys at Giants');
  });

  it('strips a tournament prefix and #ranking tokens', () => {
    expect(
      formatEventCardTitle({
        title: 'Duke’s Mayo Classic: West Virginia vs #25 Virginia',
        sport: 'football',
      })
    ).toBe('West Virginia vs Virginia');
  });

  it('falls back to a non-competitive event label when there is no title', () => {
    expect(formatEventCardTitle({ title: '', event_type: 'fundraiser' })).toBe('Fundraiser');
    expect(formatEventCardTitle({ title: null, event_type: 'watch_party' })).toBe('Watch Party');
  });

  it('returns an empty string when there is nothing to show', () => {
    expect(formatEventCardTitle({ title: '', event_type: 'game' })).toBe('');
  });

  it('does not add an emoji when the sport is unknown', () => {
    expect(formatEventCardTitle({ title: 'Spring Gala' })).toBe('Spring Gala');
  });

  it('collapses whitespace introduced by stripping', () => {
    expect(
      formatEventCardTitle({ title: 'Team A at Team B   Womens   Soccer', sport: 'soccer' })
    ).toBe('Team A at Team B');
  });
});
