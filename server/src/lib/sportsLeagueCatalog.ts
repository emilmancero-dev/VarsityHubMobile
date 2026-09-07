export type SportsLeagueLevel = 'major' | 'minor' | 'college' | 'international' | 'other';
export type SportsLeagueGender = 'men' | 'women' | 'coed' | 'mixed' | 'unknown';

export type SportsLeagueCatalogEntry = {
  id: string;
  slug: string;
  name: string;
  sport_slug: string;
  level: SportsLeagueLevel;
  gender: SportsLeagueGender;
  country_code: string | null;
  provider: string | null;
  provider_league_id: string | null;
  active: boolean;
};

function league(
  slug: string,
  name: string,
  sport_slug: string,
  level: SportsLeagueLevel,
  gender: SportsLeagueGender,
  provider: string | null = null,
  provider_league_id: string | null = null,
  country_code: string | null = 'US'
): SportsLeagueCatalogEntry {
  return {
    id: `sports_league_${slug}`,
    slug,
    name,
    sport_slug,
    level,
    gender,
    country_code,
    provider,
    provider_league_id,
    active: Boolean(provider && provider_league_id),
  };
}

export const SPORTS_LEAGUE_CATALOG: SportsLeagueCatalogEntry[] = [
  league('nfl', 'NFL', 'football', 'major', 'men', 'espn', 'football/nfl'),
  league('nba', 'NBA', 'basketball', 'major', 'men', 'espn', 'basketball/nba'),
  league('wnba', 'WNBA', 'basketball', 'major', 'women', 'espn', 'basketball/wnba'),
  league('mlb', 'MLB', 'baseball', 'major', 'men', 'espn', 'baseball/mlb'),
  league('nhl', 'NHL', 'ice_hockey', 'major', 'men'),
  league('mls', 'MLS', 'soccer', 'major', 'men'),
  league('nwsl', 'NWSL', 'soccer', 'major', 'women'),
  league('wwe', 'WWE', 'wrestling', 'major', 'mixed'),
  league('ufc', 'UFC', 'mma', 'major', 'mixed'),
  league('pga_tour', 'PGA Tour', 'golf', 'major', 'men'),
  league('lpga', 'LPGA', 'golf', 'major', 'women'),
  league('atp', 'ATP Tour', 'tennis', 'major', 'men', 'espn', 'tennis/atp'),
  league('wta', 'WTA Tour', 'tennis', 'major', 'women', 'espn', 'tennis/wta'),
  league(
    'fiba_womens_world_cup',
    "FIBA Women's Basketball World Cup",
    'basketball',
    'international',
    'women',
    'fiba',
    'fiba-womens-basketball-world-cup',
    null
  ),
  league('nascar_cup', 'NASCAR Cup Series', 'auto_racing', 'major', 'mixed'),
  league('indycar', 'IndyCar', 'auto_racing', 'major', 'mixed'),
  league('formula_one', 'Formula 1', 'auto_racing', 'major', 'mixed', null, null, null),

  league('milb_triple_a', 'Minor League Baseball Triple-A', 'baseball', 'minor', 'men'),
  league('milb_double_a', 'Minor League Baseball Double-A', 'baseball', 'minor', 'men'),
  league('milb_high_a', 'Minor League Baseball High-A', 'baseball', 'minor', 'men'),
  league('milb_single_a', 'Minor League Baseball Single-A', 'baseball', 'minor', 'men'),
  league('milb_rookie', 'Minor League Baseball Rookie', 'baseball', 'minor', 'men'),
  league('arizona_fall_league', 'Arizona Fall League', 'baseball', 'minor', 'men'),
  league('ahl', 'AHL', 'ice_hockey', 'minor', 'men'),
  league('echl', 'ECHL', 'ice_hockey', 'minor', 'men'),
  league('sphl', 'SPHL', 'ice_hockey', 'minor', 'men'),
  league('fphl', 'FPHL', 'ice_hockey', 'minor', 'men'),
  league('nba_g_league', 'NBA G League', 'basketball', 'minor', 'men'),
  league('usl_championship', 'USL Championship', 'soccer', 'minor', 'men'),
  league('usl_league_one', 'USL League One', 'soccer', 'minor', 'men'),
  league('mls_next_pro', 'MLS NEXT Pro', 'soccer', 'minor', 'men'),
  league('nisa', 'NISA', 'soccer', 'minor', 'men'),
  league('usl_super_league', 'USL Super League', 'soccer', 'major', 'women'),

  league(
    'ncaaf',
    'NCAA Football',
    'football',
    'college',
    'men',
    'espn',
    'football/college-football'
  ),
  league('ncaaf_fbs', 'NCAA FBS Football', 'football', 'college', 'men'),
  league('ncaaf_fcs', 'NCAA FCS Football', 'football', 'college', 'men'),
  league(
    'ncaamb',
    "NCAA Men's Basketball",
    'basketball',
    'college',
    'men',
    'espn',
    'basketball/mens-college-basketball'
  ),
  league(
    'ncaawb',
    "NCAA Women's Basketball",
    'basketball',
    'college',
    'women',
    'espn',
    'basketball/womens-college-basketball'
  ),
  league(
    'ncaabaseball',
    'NCAA Baseball',
    'baseball',
    'college',
    'men',
    'espn',
    'baseball/college-baseball'
  ),
  league('ncaasoftball', 'NCAA Softball', 'softball', 'college', 'women'),
  league(
    'ncaamhockey',
    "NCAA Men's Ice Hockey",
    'ice_hockey',
    'college',
    'men',
    'espn',
    'hockey/mens-college-hockey'
  ),
  league('ncaawhockey', "NCAA Women's Ice Hockey", 'ice_hockey', 'college', 'women'),
  league('ncaamsoccer', "NCAA Men's Soccer", 'soccer', 'college', 'men'),
  league('ncaawsoccer', "NCAA Women's Soccer", 'soccer', 'college', 'women'),
  league('ncaamvolleyball', "NCAA Men's Volleyball", 'volleyball', 'college', 'men'),
  league('ncaawvolleyball', "NCAA Women's Volleyball", 'volleyball', 'college', 'women'),
  league(
    'ncaawbeach_volleyball',
    "NCAA Women's Beach Volleyball",
    'beach_volleyball',
    'college',
    'women'
  ),
  league('ncaamlacrosse', "NCAA Men's Lacrosse", 'lacrosse', 'college', 'men'),
  league('ncaawlacrosse', "NCAA Women's Lacrosse", 'lacrosse', 'college', 'women'),
  league('ncaamtennis', "NCAA Men's Tennis", 'tennis', 'college', 'men'),
  league('ncaawtennis', "NCAA Women's Tennis", 'tennis', 'college', 'women'),
  league('ncaamgolf', "NCAA Men's Golf", 'golf', 'college', 'men'),
  league('ncaawgolf', "NCAA Women's Golf", 'golf', 'college', 'women'),
  league('ncaamcross_country', "NCAA Men's Cross Country", 'cross_country', 'college', 'men'),
  league('ncaawcross_country', "NCAA Women's Cross Country", 'cross_country', 'college', 'women'),
  league('ncaamtrack_field', "NCAA Men's Track & Field", 'track_field', 'college', 'men'),
  league('ncaawtrack_field', "NCAA Women's Track & Field", 'track_field', 'college', 'women'),
  league('ncaamswimming', "NCAA Men's Swimming & Diving", 'swimming', 'college', 'men'),
  league('ncaawswimming', "NCAA Women's Swimming & Diving", 'swimming', 'college', 'women'),
  league('ncaamgymnastics', "NCAA Men's Gymnastics", 'gymnastics', 'college', 'men'),
  league('ncaawgymnastics', "NCAA Women's Gymnastics", 'gymnastics', 'college', 'women'),
  league('ncaamwrestling', "NCAA Men's Wrestling", 'wrestling', 'college', 'men'),
  league('ncaawwrestling', "NCAA Women's Wrestling", 'wrestling', 'college', 'women'),
  league('ncaafield_hockey', "NCAA Women's Field Hockey", 'field_hockey', 'college', 'women'),
  league('ncaawbowling', "NCAA Women's Bowling", 'bowling', 'college', 'women'),
  league('ncaafencing', 'NCAA Fencing', 'fencing', 'college', 'coed'),
  league('ncaarifle', 'NCAA Rifle', 'other', 'college', 'coed'),
  league('ncaaskiing', 'NCAA Skiing', 'skiing', 'college', 'coed'),
  league('ncaamwater_polo', "NCAA Men's Water Polo", 'water_polo', 'college', 'men'),
  league('ncaawwater_polo', "NCAA Women's Water Polo", 'water_polo', 'college', 'women'),
  league('ncaawrowing', "NCAA Women's Rowing", 'crew', 'college', 'women'),
  league(
    'ncaawacrobatics_tumbling',
    "NCAA Women's Acrobatics & Tumbling",
    'acrobatics_tumbling',
    'college',
    'women'
  ),
  league('ncaawstunt', "NCAA Women's STUNT", 'stunt', 'college', 'women'),
];

export const SPORTS_LEAGUE_CATALOG_BY_SLUG = new Map(
  SPORTS_LEAGUE_CATALOG.map(league => [league.slug, league])
);
