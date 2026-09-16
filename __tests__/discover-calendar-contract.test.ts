import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const screenSource = fs.readFileSync(
  path.join(repoRoot, 'app/(tabs)/discover/mobile-community.tsx'),
  'utf8'
);
const calendarSource = fs.readFileSync(path.join(repoRoot, 'utils/discoverCalendar.ts'), 'utf8');

describe('Discover followed calendar contract', () => {
  it('uses the full calendar component instead of the old horizontal date strip', () => {
    expect(screenSource).toContain("import { Calendar, DateData } from 'react-native-calendars'");
    expect(screenSource).toContain('<Calendar');
    expect(screenSource).toContain('enableSwipeMonths');
    expect(screenSource).toContain('markedDates={markedCalendarDates}');
    expect(screenSource).not.toContain('styles.calendarStrip');
    expect(screenSource).not.toContain('styles.calendarDay');
  });

  it('marks every followed or managed event date from the event-discovery feed', () => {
    expect(screenSource).toContain("httpGet('/event-discovery?scope=following')");
    expect(screenSource).toContain('enabled: interactionsDone && isSignedIn');
    expect(screenSource).toContain('buildDiscoverMarkedDates(');
    expect(calendarSource).toContain('export function buildDiscoverMarkedDates');
    expect(calendarSource).toContain('for (const row of [...games, ...events])');
  });

  it('keeps authenticated-only discover queries behind the signed-in gate', () => {
    expect(screenSource).toContain('const suggestedQueryKey = useMemo(');
    expect(screenSource).toContain('enabled: interactionsDone && isSignedIn');
    expect(screenSource).toContain(
      '...(isSignedIn ? [refetchSuggested(), refetchFollowingCalendar()] : [])'
    );
    expect(screenSource).toContain(
      'user ? await getAuthSnapshot(checkAuth, user).catch(() => null) : null'
    );
  });
});
