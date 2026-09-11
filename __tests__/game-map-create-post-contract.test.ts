import { readFileSync } from 'fs';
import { join } from 'path';

const gameMapSource = readFileSync(join(process.cwd(), 'app', 'game-map.tsx'), 'utf8');
const eventMapTypesSource = readFileSync(
  join(process.cwd(), 'components', 'EventMap.types.ts'),
  'utf8'
);
const eventMapSource = readFileSync(join(process.cwd(), 'components', 'EventMap.tsx'), 'utf8');

describe('game map create-post contract', () => {
  it('keeps event/game upload target ids on map markers', () => {
    expect(eventMapTypesSource).toContain('event_id?: string | null');
    expect(eventMapTypesSource).toContain('game_id?: string | null');
    expect(eventMapTypesSource).toContain('onCreatePostPress?: (event: EventMapData) => void');
  });

  it('routes the selected map marker to create-post with game/event ids', () => {
    expect(gameMapSource).toContain('const handleCreatePostPress = useCallback');
    expect(gameMapSource).toContain("pathname: '/create-post'");
    expect(gameMapSource).toContain('...(gameId ? { gameId } : {})');
    expect(gameMapSource).toContain('...(eventId ? { eventId } : {})');
    expect(gameMapSource).toContain('onCreatePostPress={handleCreatePostPress}');
  });

  it('loads picked calendar dates as the user local day and keeps past event pages visible', () => {
    expect(gameMapSource).toContain('function toLocalDateKey(date: Date): string');
    expect(gameMapSource).toContain('start.setHours(0, 0, 0, 0)');
    expect(gameMapSource).toContain('end.setHours(23, 59, 59, 999)');
    expect(gameMapSource).toContain('setSelectedDate(toLocalDateKey(start))');
    expect(gameMapSource).toContain(
      'toMapEvents(discovery.data ?? [], new Date(), { includePast: Boolean(selectedDate) })'
    );
    expect(gameMapSource).toContain('maximumDate={new Date()}');
    expect(gameMapSource).not.toContain('Date.UTC(picked.getFullYear()');
  });

  it('keeps the map search as a loaded-marker filter, not a global event-page search', () => {
    expect(eventMapSource).toContain('Search box — filters the loaded map event/game pins only');
    expect(eventMapSource).toContain("const [searchQuery, setSearchQuery] = useState('')");
    expect(eventMapSource).toContain('event.title,');
    expect(eventMapSource).toContain('event.location,');
    expect(eventMapSource).toContain('event.sport,');
    expect(eventMapSource).toContain('event.league_slug,');
    expect(eventMapSource).toContain('event.league_name,');
    expect(eventMapSource).not.toContain('/event-discovery?surface=map&q=');
  });
});
