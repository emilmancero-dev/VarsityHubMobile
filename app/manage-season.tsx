import CustomActionModal, { ActionModalOption } from '@/components/CustomActionModal';
import CoachAccessRedirecting from '@/components/CoachAccessRedirecting';
import { Colors } from '@/constants/Colors';
import { useAuth } from '@/context/AuthProvider';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useRequireTeamManagement } from '@/hooks/useRequireTeamManagement';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { handleCoachAccessError } from '@/utils/coachAccess';
import { toUserMessage } from '@/utils/toUserMessage';
import { safeGoBack } from '@/utils/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
// @ts-ignore JS exports
import { Game as GameAPI, Team as TeamAPI } from '@/api/entities';
import AddGameModal, { GameFormData } from '@/components/AddGameModal';
import BulkScheduleModal from '@/components/BulkScheduleModal';
import QuickAddGameModal, { QuickGameData } from '@/components/QuickAddGameModal';
import { EmptyState, GameCard, SectionHeader } from '@/components/ui';
import type { Game as GameCardGame } from '@/components/ui/GameCard';
import { captureBreadcrumb, captureException } from '@/utils/sentry';
import { partitionSeasonApprovalGames } from '@/utils/gameApprovalQueue';

type GameStatus = 'upcoming' | 'completed' | 'cancelled' | 'pending' | 'live' | 'in-progress';

interface Game extends GameCardGame {
  id: string;
  opponent?: string; // Keep for backward compatibility
  homeTeam?: string;
  awayTeam?: string;
  date: string;
  time: string;
  location: string;
  type: 'home' | 'away' | 'neutral';
  status: GameStatus;
  approval_status?: 'pending' | 'approved' | 'rejected';
  // Distinct from approval_status: 'pending' here means the OPPONENT still has
  // to confirm, which is not this team's action to take.
  opponent_approval_status?: string | null;
  banner_url?: string; // Add banner URL support
  cover_image_url?: string; // Add cover image URL support
  // event_type/title let non-competitive rows (fundraiser, watch party, etc.)
  // render their own title instead of "vs TBD" — see utils/eventTitle.ts.
  event_type?: string | null;
  title?: string | null;
  score?: {
    team: number;
    opponent: number;
  };
}

interface SeasonStats {
  wins: number;
  losses: number;
  ties: number;
  gamesPlayed: number;
  totalGames: number;
  pointsFor: number;
  pointsAgainst: number;
}

function ManageSeasonScreen() {
  const { user } = useAuth();
  const { canManage, loading: coachLoading } = useRequireTeamManagement();
  const router = useRouter();
  const colorScheme = useColorScheme() ?? 'light';
  const params = useLocalSearchParams<{ teamId?: string; from?: string; fallback?: string }>();
  const backFallback =
    typeof params.fallback === 'string' && params.fallback.trim().startsWith('/')
      ? params.fallback.trim()
      : params.from === 'discover-quick-actions'
        ? '/(tabs)/discover'
        : undefined;
  const handleBack = useCallback(() => {
    safeGoBack(router, backFallback);
  }, [backFallback, router]);

  // Modal state for universal action modal
  const [actionModal, setActionModal] = useState<{
    visible: boolean;
    title?: string;
    message?: string;
    options: ActionModalOption[];
  }>({ visible: false, options: [] });

  // Prompt modal state (for Alert.prompt replacement)
  const [promptModal, setPromptModal] = useState<{
    visible: boolean;
    title?: string;
    message?: string;
    defaultValue?: string;
    onSubmit?: (value: string) => void;
  }>({ visible: false });

  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedTab, _setSelectedTab] = useState<'schedule' | 'standings' | 'playoffs'>(
    'schedule'
  );
  const [showAddGameModal, setShowAddGameModal] = useState(false);
  const [showQuickAddModal, setShowQuickAddModal] = useState(false);
  const [showBulkScheduleModal, setShowBulkScheduleModal] = useState(false);
  const [editingGame, setEditingGame] = useState<Game | null>(null);
  const [games, setGames] = useState<Game[]>([]);
  const [currentTeam, setCurrentTeam] = useState<{ id: string; name: string } | null>(null);
  const [managedTeams, setManagedTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [teamSelectorOpen, setTeamSelectorOpen] = useState<boolean>(false);

  const reportSeasonFailure = useCallback((task: string, error: unknown) => {
    if (__DEV__) console.warn(`[manage-season] ${task} failed:`, error);
    captureBreadcrumb(
      'Manage season deferred task failed',
      'manage_season.screen',
      { task },
      'warning'
    );
    captureException(error instanceof Error ? error : new Error(String(error)), {
      tags: { context: 'manage-season', task },
    });
  }, []);

  const loadTeam = useCallback(async () => {
    setLoading(true);
    try {
      if (params.teamId) {
        const teamData = await TeamAPI.get(params.teamId);
        setCurrentTeam({ id: String(teamData.id), name: String(teamData.name) });
        return;
      }
      // No teamId provided: fetch managed teams and prompt selection
      const teams = await TeamAPI.managed();
      const arr = Array.isArray(teams)
        ? teams
        : Array.isArray((teams as any)?.items)
          ? (teams as any).items
          : [];
      const normalized = arr.map((t: any) => ({
        id: String(t.id),
        name: String(t.name || t.display_name || 'Team'),
      }));
      setManagedTeams(normalized);
      if (normalized.length > 0) {
        setTeamSelectorOpen(true);
      } else {
        setActionModal({
          visible: true,
          title: 'No Managed Teams',
          message: "You don't manage any teams yet. Create one to continue.",
          options: [
            {
              label: 'Create Team',
              onPress: () =>
                router.push({
                  pathname: '/create-team',
                  params: {
                    fallback: backFallback ?? '/organization?tab=teams',
                  },
                } as any),
            },
            { label: 'Close', onPress: () => {} },
          ],
        });
      }
    } catch (error) {
      if (handleCoachAccessError(router, error, 'managing your season', user)) {
        return;
      }
      if (__DEV__) console.error('Error loading team:', error);
    } finally {
      setLoading(false);
    }
  }, [backFallback, params.teamId, router, user]);

  const loadGames = useCallback(async () => {
    try {
      setLoading(true);
      if (!currentTeam?.id) {
        setGames([]);
        return;
      }
      const response = await GameAPI.list('-date', {
        showPending: true,
        teamId: currentTeam.id,
        limit: 100,
      });
      const backendGames = response?.games ?? (Array.isArray(response) ? response : []);
      const relevantGames: any[] = Array.isArray(backendGames) ? backendGames : [];

      // Convert backend games to local Game format
      const convertedGames = relevantGames.map((game: any) => {
        const converted: Game = {
          id: game.id,
          homeTeam: game.home_team || null,
          awayTeam: game.away_team || null,
          opponent: game.away_team || game.home_team || game.title?.replace('vs ', '') || 'TBD',
          date: game.date
            ? new Date(game.date).toISOString().split('T')[0]
            : new Date().toISOString().split('T')[0],
          time: game.date
            ? new Date(game.date).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
              })
            : '7:00 PM',
          location: game.location || 'TBD',
          type: game.home_team && game.home_team !== 'Away Team' ? 'home' : 'away',
          status: game.winner
            ? 'completed'
            : game.approval_status === 'rejected' || game.opponent_approval_status === 'declined'
              ? 'cancelled'
              : game.approval_status === 'pending' || game.opponent_approval_status === 'pending'
                ? 'pending'
                : 'upcoming',
          banner_url: game.banner_url || undefined, // Include banner URL from backend
          cover_image_url: game.cover_image_url || undefined, // Include cover image URL from backend
          event_type: game.event_type ?? null,
          title: game.title ?? null,
          // Carry BOTH raw approval fields through. The local `status` above
          // flattens them into one 'pending', which is why the queue used to
          // offer Approve/Reject on games that were really waiting on the
          // opponent — see partitionSeasonApprovalGames.
          approval_status: game.approval_status ?? undefined,
          opponent_approval_status: game.opponent_approval_status ?? undefined,
        };
        return converted;
      });

      setGames(convertedGames);
    } catch (error) {
      if (handleCoachAccessError(router, error, 'managing your season', user)) {
        return;
      }
      if (__DEV__) console.error('Error loading games:', error);
      const errorMessage =
        error instanceof Error && error.message.includes('Too many requests')
          ? 'Server is busy, please try again in a moment'
          : 'Failed to load games from server';

      setActionModal({
        visible: true,
        title: 'Error',
        message: errorMessage,
        options: [{ label: 'OK', onPress: () => {}, color: undefined }],
      });
    } finally {
      setLoading(false);
    }
  }, [currentTeam?.id, router, user]);

  // Load team and then games
  useEffect(() => {
    void loadTeam().catch(error => {
      reportSeasonFailure('load_team', error);
    });
  }, [loadTeam, reportSeasonFailure]);

  useEffect(() => {
    if (currentTeam?.id) {
      void loadGames().catch(error => {
        reportSeasonFailure('load_games_for_team', error);
      });
    }
  }, [currentTeam?.id, loadGames, reportSeasonFailure]);

  // Compute season stats from real game data
  const _seasonStats: SeasonStats = (() => {
    const teamId = currentTeam?.id;
    if (!teamId)
      return {
        wins: 0,
        losses: 0,
        ties: 0,
        gamesPlayed: 0,
        totalGames: 0,
        pointsFor: 0,
        pointsAgainst: 0,
      };
    const completed = games.filter(g => g.status === 'completed' || (g as any).winner);
    let wins = 0,
      losses = 0,
      ties = 0,
      pointsFor = 0,
      pointsAgainst = 0;
    for (const g of completed) {
      const raw = g as any;
      const isHome = String(raw.home_team_id) === teamId;
      const hs = typeof raw.home_score === 'number' ? raw.home_score : 0;
      const as_ = typeof raw.away_score === 'number' ? raw.away_score : 0;
      pointsFor += isHome ? hs : as_;
      pointsAgainst += isHome ? as_ : hs;
      if (raw.winner === 'tie') {
        ties++;
      } else if ((raw.winner === 'home' && isHome) || (raw.winner === 'away' && !isHome)) {
        wins++;
      } else if (raw.winner) {
        losses++;
      }
    }
    return {
      wins,
      losses,
      ties,
      gamesPlayed: completed.length,
      totalGames: games.length,
      pointsFor,
      pointsAgainst,
    };
  })();

  // Only games awaiting THIS team's review are actionable. Games already
  // approved on our side and waiting on the opponent render read-only — the
  // opponent decides those from the Approvals screen's "Game Requests", and
  // the server 403s self-review, so Approve/Reject here was a dead end.
  const { awaitingMyReview: pendingGames, awaitingOpponent: awaitingOpponentGames } =
    partitionSeasonApprovalGames(games ?? []);

  // g.date is a 'YYYY-MM-DD' wall-clock calendar date (games store the intended
  // wall time as UTC). Compare it to the user's LOCAL calendar date as strings —
  // round-tripping through Date parsed the game date as UTC midnight but "today"
  // as local midnight, which pushed games happening today out of Upcoming.
  const localToday = new Date();
  const localTodayStr = [
    localToday.getFullYear(),
    String(localToday.getMonth() + 1).padStart(2, '0'),
    String(localToday.getDate()).padStart(2, '0'),
  ].join('-');

  const upcomingGames: Game[] = (games ?? []).filter(g => {
    if (g.approval_status === 'pending' || g.approval_status === 'rejected') return false;
    if (g.status === 'completed' || g.status === 'cancelled') return false;
    return g.date >= localTodayStr;
  });

  const recentGames: Game[] = (games ?? []).filter(g => {
    if (g.approval_status === 'pending') return false;
    return g.date < localTodayStr || g.status === 'completed' || g.status === 'cancelled';
  });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadGames();
    } finally {
      setRefreshing(false);
    }
  }, [loadGames]);

  const handleAddGame = () => {
    // Directly open Quick Add modal (simplified for boomer-friendly UX)
    setShowQuickAddModal(true);
  };

  const handleEditGame = (game: GameCardGame) => {
    const localGame = games.find(g => g.id === game.id);
    if (localGame) {
      setEditingGame(localGame);
      setShowQuickAddModal(true);
    }
  };

  const handleDeleteGame = (game: GameCardGame) => {
    setActionModal({
      visible: true,
      title: 'Delete Game',
      message: `Are you sure you want to delete the game vs ${game.opponent || game.opponent_name || 'opponent'}?`,
      options: [
        { label: 'Cancel', onPress: () => {}, color: undefined },
        {
          label: 'Delete',
          isDestructive: true,
          onPress: async () => {
            try {
              await GameAPI.delete(game.id);
              setGames(prev => prev.filter(g => g.id !== game.id));
              setActionModal({
                visible: true,
                title: 'Success',
                message: 'Game deleted successfully!',
                options: [{ label: 'OK', onPress: () => {}, color: undefined }],
              });
            } catch (error) {
              if (handleCoachAccessError(router, error, 'deleting games', user)) {
                return;
              }
              setActionModal({
                visible: true,
                title: 'Error',
                message: 'Failed to delete game. Please try again.',
                options: [{ label: 'OK', onPress: () => {}, color: undefined }],
              });
              if (__DEV__) console.error('Error deleting game:', error);
            }
          },
        },
      ],
    });
  };

  const handleChangeGameStatus = (game: GameCardGame) => {
    const localGame = games.find(g => g.id === game.id);
    if (!localGame) return;
    const statusOptions = [
      { label: 'Upcoming', value: 'upcoming' as const },
      { label: 'Completed', value: 'completed' as const },
      { label: 'Cancelled', value: 'cancelled' as const },
    ].filter(option => option.value !== localGame.status);
    setActionModal({
      visible: true,
      title: 'Change Status',
      message: `Current status: ${localGame.status}`,
      options: [
        { label: 'Cancel', onPress: () => {}, color: undefined },
        ...statusOptions.map(option => ({
          label: option.label,
          onPress: async () => {
            try {
              await GameAPI.update(game.id, { status: option.value });
              setGames(prev =>
                prev.map(g => (g.id === game.id ? { ...g, status: option.value } : g))
              );
              setActionModal({
                visible: true,
                title: 'Success',
                message: `Game status changed to ${option.label.toLowerCase()}!`,
                options: [{ label: 'OK', onPress: () => {}, color: undefined }],
              });
            } catch (err: any) {
              if (handleCoachAccessError(router, err, 'updating game status', user)) {
                return;
              }
              setActionModal({
                visible: true,
                title: 'Error',
                message: toUserMessage(err, 'Failed to update game status'),
                options: [{ label: 'OK', onPress: () => {}, color: undefined }],
              });
            }
          },
        })),
      ],
    });
  };

  const handleGamePress = (game: GameCardGame) => {
    router.push({
      pathname: '/game/[id]',
      params: { id: game.id },
    });
  };

  const handleEnterScore = (game: GameCardGame) => {
    const localGame = games.find(g => g.id === game.id);
    setPromptModal({
      visible: true,
      title: 'Home Team Score',
      message: `Enter score for ${localGame?.homeTeam || 'Home Team'}`,
      defaultValue: String(localGame?.score?.team ?? ''),
      onSubmit: homeScoreStr => {
        const homeScore = parseInt(homeScoreStr.trim(), 10);
        if (isNaN(homeScore)) {
          setActionModal({
            visible: true,
            title: 'Invalid Score',
            message: 'Please enter a valid number for the home team score.',
            options: [{ label: 'OK', onPress: () => {}, color: undefined }],
          });
          return;
        }
        setTimeout(() => {
          setPromptModal({
            visible: true,
            title: 'Away Team Score',
            message: `Enter score for ${localGame?.awayTeam || 'Away Team'}`,
            defaultValue: String(localGame?.score?.opponent ?? ''),
            onSubmit: async awayScoreStr => {
              const awayScore = parseInt(awayScoreStr.trim(), 10);
              if (isNaN(awayScore)) {
                setActionModal({
                  visible: true,
                  title: 'Invalid Score',
                  message: 'Please enter a valid number for the away team score.',
                  options: [{ label: 'OK', onPress: () => {}, color: undefined }],
                });
                return;
              }
              try {
                const winner =
                  homeScore > awayScore ? 'home' : awayScore > homeScore ? 'away' : 'tie';
                await GameAPI.setResult(game.id, {
                  home_score: homeScore,
                  away_score: awayScore,
                  winner,
                });
                setGames(prevGames =>
                  prevGames.map(g =>
                    g.id === game.id
                      ? {
                          ...g,
                          score: { team: homeScore, opponent: awayScore },
                          status: 'completed' as GameStatus,
                        }
                      : g
                  )
                );
                setActionModal({
                  visible: true,
                  title: 'Score Saved',
                  message: `Final score: ${homeScore} - ${awayScore}`,
                  options: [{ label: 'OK', onPress: () => {}, color: undefined }],
                });
              } catch (error: any) {
                if (handleCoachAccessError(router, error, 'saving game scores', user)) {
                  return;
                }
                setActionModal({
                  visible: true,
                  title: 'Error',
                  message: toUserMessage(error, 'Failed to save score. Please try again.'),
                  options: [{ label: 'OK', onPress: () => {}, color: undefined }],
                });
              }
            },
          });
        }, 200);
      },
    });
  };

  const handleGameLongPress = (game: GameCardGame) => {
    const _localGame = games.find(g => g.id === game.id);
    setActionModal({
      visible: true,
      title: 'Game Options',
      message: `${game.opponent || game.opponent_name || 'Game'} - ${game.date || game.scheduled_date || ''}`,
      options: [
        { label: 'Cancel', onPress: () => {}, color: undefined },
        { label: 'Edit', onPress: () => handleEditGame(game) },
        { label: 'Change Status', onPress: () => handleChangeGameStatus(game) },
        { label: 'Enter Score', onPress: () => handleEnterScore(game) },
        { label: 'Delete', isDestructive: true, onPress: () => handleDeleteGame(game) },
      ],
    });
  };

  const handleApproveGame = async (game: Game) => {
    try {
      await GameAPI.setApprovalStatus(game.id, 'approved');
      setGames(prevGames =>
        prevGames.map(g =>
          g.id === game.id ? { ...g, approval_status: 'approved', status: 'upcoming' } : g
        )
      );

      setActionModal({
        visible: true,
        title: '✅ Game Approved',
        message: `${game.opponent || 'Game'} has been approved and will appear in upcoming games.`,
        options: [{ label: 'OK', onPress: () => {} }],
      });
    } catch (error: any) {
      if (handleCoachAccessError(router, error, 'approving games', user)) {
        return;
      }
      if (__DEV__) console.error('Error approving game:', error);
      setActionModal({
        visible: true,
        title: 'Approval Failed',
        message: toUserMessage(error, 'We could not approve this game. Please try again.'),
        options: [{ label: 'OK', onPress: () => {} }],
      });
    }
  };

  const handleRejectGame = async (game: Game) => {
    setActionModal({
      visible: true,
      title: 'Reject Game',
      message: `Are you sure you want to reject "${game.opponent || 'this game'}"? This action cannot be undone.`,
      options: [
        { label: 'Cancel', onPress: () => {} },
        {
          label: 'Reject',
          isDestructive: true,
          onPress: async () => {
            try {
              await GameAPI.setApprovalStatus(game.id, 'rejected');
              setGames(prevGames => prevGames.filter(g => g.id !== game.id));

              setActionModal({
                visible: true,
                title: 'Game Rejected',
                message: 'The game has been rejected and removed.',
                options: [{ label: 'OK', onPress: () => {} }],
              });
            } catch (error: any) {
              if (handleCoachAccessError(router, error, 'rejecting games', user)) {
                return;
              }
              if (__DEV__) console.error('Error rejecting game:', error);
              setActionModal({
                visible: true,
                title: 'Rejection Failed',
                message: toUserMessage(error, 'We could not reject this game. Please try again.'),
                options: [{ label: 'OK', onPress: () => {} }],
              });
            }
          },
        },
      ],
    });
  };

  const handlePendingGameAction = (game: Game) => {
    setActionModal({
      visible: true,
      title: 'Pending Game',
      message: `${game.opponent} - ${game.date}`,
      options: [
        { label: 'Cancel', onPress: () => {} },
        { label: '✅ Approve', onPress: () => handleApproveGame(game) },
        { label: 'Edit', onPress: () => handleEditGame(game) },
        { label: '❌ Reject', isDestructive: true, onPress: () => handleRejectGame(game) },
      ],
    });
  };

  const sanitizeTeamId = (value?: string) => {
    const trimmed = (value || '').trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const parseDateParts = (date: string) => {
    const [yearStr, monthStr, dayStr] = (date || '').split('-');
    const year = parseInt(yearStr || '', 10);
    const month = parseInt(monthStr || '', 10);
    const day = parseInt(dayStr || '', 10);
    return { year, month, day };
  };

  const parseMeridiemTime = (time: string) => {
    const normalized = (time || '').replace(/\u202f/g, ' ').trim();
    const match = normalized.match(/^(\d{1,2})(?::(\d{1,2}))?(?:\s*(AM|PM))?$/i);
    if (!match) {
      throw new Error('Invalid time format');
    }
    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2] ?? '0', 10);
    const meridiem = (match[3] || '').toUpperCase();
    if (meridiem === 'PM' && hours < 12) hours += 12;
    if (meridiem === 'AM' && hours === 12) hours = 0;
    return { hours, minutes };
  };

  const handleSaveQuickGame = async (gameData: QuickGameData) => {
    const isEditing = !!gameData.id;
    try {
      const { year, month, day } = parseDateParts(gameData.date);
      const { hours, minutes } = parseMeridiemTime(gameData.time);

      if ([year, month, day, hours, minutes].some(val => Number.isNaN(val))) {
        throw new Error('Invalid date/time combination');
      }

      // True-instant encoding: build the Date from local parts (NOT Date.UTC) so
      // "7:00 PM" is stored as the correct UTC instant of the coach's local time
      // and renders back as 7:00 PM for same-region viewers. This matches the
      // bulk-add and fan-event paths; the old Date.UTC form stored wall-clock as
      // UTC and showed a shifted time to everyone not in UTC.
      const gameDateTime = new Date(year, month - 1, day, hours, minutes);

      // Validate the date
      if (isNaN(gameDateTime.getTime())) {
        throw new Error('Invalid date/time combination');
      }

      const homeTeamId = sanitizeTeamId(
        gameData.type === 'home' ? gameData.currentTeamId : gameData.opponentTeamId
      );
      const awayTeamId = sanitizeTeamId(
        gameData.type === 'home' ? gameData.opponentTeamId : gameData.currentTeamId
      );

      // Create game data for API. For non-competitive events
      // `gameData.currentTeam` carries the user-entered event title
      // (buildQuickGameData) — use it verbatim; every event is one-of-one,
      // never "<title> Event".
      const gamePayload: Record<string, any> = {
        title: gameData.isCompetitive
          ? `${gameData.currentTeam} vs ${gameData.opponent}`
          : gameData.currentTeam,
        date: gameDateTime.toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        description:
          gameData.description ||
          (gameData.isCompetitive
            ? `${gameData.type === 'home' ? 'Home' : 'Away'} game: ${gameData.currentTeam} vs ${gameData.opponent}`
            : gameData.currentTeam),
      };

      // Only add team fields if this is a competitive game
      if (gameData.isCompetitive) {
        gamePayload.home_team = gameData.type === 'home' ? gameData.currentTeam : gameData.opponent;
        gamePayload.away_team = gameData.type === 'home' ? gameData.opponent : gameData.currentTeam;

        if (homeTeamId) gamePayload.home_team_id = homeTeamId;
        if (awayTeamId) {
          gamePayload.away_team_id = awayTeamId;
        } else if (gameData.opponent) {
          gamePayload.away_team_name = gameData.opponent;
        }
      } else {
        // For non-competitive events, still send home_team_id for approval workflow
        if (gameData.currentTeamId) {
          gamePayload.home_team_id = gameData.currentTeamId;
        }
      }

      // Add expected attendance if provided
      if (gameData.expectedAttendance) {
        gamePayload.expected_attendance = gameData.expectedAttendance;
      }

      // Add event type
      if (gameData.eventType) {
        gamePayload.event_type = gameData.eventType;
      }

      // Add event type-specific fields
      if (gameData.donationGoal) {
        gamePayload.donation_goal = gameData.donationGoal;
      }
      if (gameData.watchLocation) {
        gamePayload.watch_location = gameData.watchLocation;
        if (gameData.watchLocationLat) gamePayload.watch_location_lat = gameData.watchLocationLat;
        if (gameData.watchLocationLng) gamePayload.watch_location_lng = gameData.watchLocationLng;
        if (gameData.watchLocationPlaceId)
          gamePayload.watch_location_place_id = gameData.watchLocationPlaceId;
      }
      if (gameData.destination) {
        gamePayload.destination = gameData.destination;
      }

      // Add game venue location — always ensure location is set (server requires it)
      const venue = gameData.type === 'home' ? gameData.homeVenue : gameData.awayVenue;
      const venueLat = gameData.type === 'home' ? gameData.homeVenueLat : gameData.awayVenueLat;
      const venueLng = gameData.type === 'home' ? gameData.homeVenueLng : gameData.awayVenueLng;
      if (venue) {
        gamePayload.location = venue;
        if (venueLat) gamePayload.latitude = venueLat;
        if (venueLng) gamePayload.longitude = venueLng;
      } else {
        // Fallback for non-competitive events: use watch location, destination, or a default
        gamePayload.location = gameData.watchLocation || gameData.destination || 'TBD';
      }

      // Include banner URL if provided by the QuickAdd modal
      if (gameData.banner_url) {
        gamePayload.banner_url = gameData.banner_url;
        gamePayload.cover_image_url = gameData.banner_url; // Also set cover_image_url to the same value
      } else if (gameData.cover_image_url) {
        gamePayload.cover_image_url = gameData.cover_image_url;
      }
      // Include appearance preset if provided
      if (gameData.appearance) {
        // Map to backend field - use `appearance` or `banner_style` depending on API
        gamePayload.appearance = gameData.appearance;
      }

      // Save to backend API (create or update)
      const savedGame = isEditing
        ? await GameAPI.update(gameData.id!, gamePayload)
        : await GameAPI.create(gamePayload);

      // Create local game object for immediate UI update
      const updatedGame: Game = {
        id: savedGame.id || gameData.id || Date.now().toString(),
        homeTeam: gameData.type === 'home' ? gameData.currentTeam : gameData.opponent,
        awayTeam: gameData.type === 'home' ? gameData.opponent : gameData.currentTeam,
        opponent: gameData.opponent, // Keep for backward compatibility
        date: gameData.date,
        time: gameData.time,
        location:
          gameData.homeVenue ||
          gameData.awayVenue ||
          (gameData.type === 'home' ? 'Home Stadium' : 'Away Venue'),
        type: gameData.type,
        status: 'upcoming',
        // TEMP FIX: Prioritize the banner_url we sent over the null response from backend
        banner_url: gameData.banner_url || savedGame.banner_url || undefined,
        cover_image_url:
          gameData.banner_url || gameData.cover_image_url || savedGame.cover_image_url || undefined,
      };

      // Update games state
      if (isEditing) {
        setGames(prev => prev.map(g => (g.id === gameData.id ? updatedGame : g)));
      } else {
        setGames(prev => [...prev, updatedGame]);
      }

      // Show success message
      setActionModal({
        visible: true,
        title: 'Success',
        message: isEditing
          ? `Game "${gameData.currentTeam} vs ${gameData.opponent}" updated successfully!`
          : `Game "${gameData.currentTeam} vs ${gameData.opponent}" added successfully!`,
        options: [{ label: 'OK', onPress: () => {}, color: undefined }],
      });

      // Close modal and clear editing state
      setShowQuickAddModal(false);
      setEditingGame(null);
    } catch (error: any) {
      if (
        handleCoachAccessError(router, error, isEditing ? 'updating games' : 'creating games', user)
      ) {
        return;
      }
      if (__DEV__) console.error('Error adding quick game:', error);
      if (__DEV__) console.error('Error status:', error?.status);
      if (__DEV__) console.error('Error data:', error?.data);
      if (__DEV__) console.error('Error message:', error?.message);
      setActionModal({
        visible: true,
        title: 'Error',
        message: toUserMessage(
          error,
          'Failed to save event. Please check your entries and try again.'
        ),
        options: [{ label: 'OK', onPress: () => {}, color: undefined }],
      });
    }
  };

  const handleSaveGame = async (gameData: GameFormData) => {
    try {
      // Merge the separate date + time pickers into one true-instant timestamp
      // from LOCAL parts (not Date.UTC), matching handleSaveQuickGame and the
      // bulk/fan paths so a "7:00 PM" game is stored as the correct instant and
      // renders back as 7:00 PM for same-region viewers.
      const gameDateTime = new Date(
        gameData.date.getFullYear(),
        gameData.date.getMonth(),
        gameData.date.getDate(),
        gameData.time.getHours(),
        gameData.time.getMinutes()
      );

      const isHome = gameData.type === 'home';
      const currentTeamId = sanitizeTeamId(currentTeam?.id || params.teamId);
      const opponentTeamId = sanitizeTeamId(gameData.opponent_team_id ?? undefined);
      const homeTeamId = isHome ? currentTeamId : opponentTeamId;
      const awayTeamId = isHome ? opponentTeamId : currentTeamId;

      // Create game data for API
      const gamePayload: Record<string, any> = {
        title: `${gameData.currentTeam} vs ${gameData.opponent}`,
        home_team: isHome ? gameData.currentTeam : gameData.opponent,
        away_team: isHome ? gameData.opponent : gameData.currentTeam,
        date: gameDateTime.toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        location: gameData.location,
        description: `${gameData.type === 'home' ? 'Home' : gameData.type === 'away' ? 'Away' : 'Neutral'} game: ${gameData.currentTeam} vs ${gameData.opponent}`,
      };

      // Link teams by ID when they exist on VarsityHub; otherwise keep the
      // opponent as a display-only placeholder name (no fake team accounts).
      if (homeTeamId) gamePayload.home_team_id = homeTeamId;
      if (awayTeamId) {
        gamePayload.away_team_id = awayTeamId;
      } else if (gameData.opponent) {
        gamePayload.away_team_name = gameData.opponent;
      }

      if (gameData.banner_url) {
        gamePayload.banner_url = gameData.banner_url;
        gamePayload.cover_image_url = gameData.banner_url;
      }
      if (gameData.attendance) gamePayload.expected_attendance = gameData.attendance;
      if (gameData.latitude != null) gamePayload.latitude = gameData.latitude;
      if (gameData.longitude != null) gamePayload.longitude = gameData.longitude;

      // Save to backend API
      const savedGame = await GameAPI.create(gamePayload);

      // Create local game object for immediate UI update
      const newGame: Game = {
        id: savedGame.id || Date.now().toString(),
        opponent: gameData.opponent,
        date: gameData.date.toISOString().split('T')[0],
        time: gameData.time.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }),
        location: gameData.location,
        type: gameData.type,
        status: 'upcoming',
        banner_url: gameData.banner_url || undefined, // Include banner URL
      };

      // Add to games state
      setGames(prev => [...prev, newGame]);

      // Show success message
      setActionModal({
        visible: true,
        title: 'Success',
        message: `Game "${gameData.currentTeam} vs ${gameData.opponent}" added successfully!`,
        options: [{ label: 'OK', onPress: () => {}, color: undefined }],
      });
    } catch (error) {
      if (handleCoachAccessError(router, error, 'creating games', user)) {
        return;
      }
      setActionModal({
        visible: true,
        title: 'Error',
        message: 'Failed to add event. Please try again.',
        options: [{ label: 'OK', onPress: () => {}, color: undefined }],
      });
      if (__DEV__) console.error('Error adding game:', error);
    }
  };

  const handleSaveBulkGames = async (bulkGames: any[]) => {
    try {
      // v1.0.2: use atomic /games/bulk endpoint instead of Promise.all over individual creates.
      // Server rolls back the whole batch if any single game fails to save.
      const convertTo24Hour = (time12h: string) => {
        const [time, modifier] = time12h.split(' ');
        let [hours, minutes] = time.split(':');
        hours = hours.padStart(2, '0');
        if (hours === '12') {
          hours = modifier === 'AM' ? '00' : '12';
        } else if (modifier === 'PM') {
          hours = String(parseInt(hours, 10) + 12).padStart(2, '0');
        }
        return `${hours}:${minutes || '00'}`;
      };
      const teamName = currentTeam?.name || 'Team';
      const currentTeamId = currentTeam?.id;
      const payloads = bulkGames.map(gameData => {
        const time24h = convertTo24Hour(gameData.time);
        const [year, month, day] = gameData.date.split('-');
        const [hours, minutes] = time24h.split(':');
        const gameDateTime = new Date(
          parseInt(year),
          parseInt(month) - 1,
          parseInt(day),
          parseInt(hours),
          parseInt(minutes)
        );
        if (isNaN(gameDateTime.getTime())) {
          throw new Error(`Invalid date/time for game vs ${gameData.opponent}`);
        }
        // Attach the managed team's id to its side of the matchup. Without this
        // the server's /games/bulk endpoint rejects every row (it requires a
        // home_team_id or away_team_id), so bulk scheduling always 400'd. The
        // opponent stays a free-text name (no id) → no opponent-consent needed.
        const isAway = gameData.type === 'away';
        return {
          title: `${teamName} vs ${gameData.opponent}`,
          home_team: gameData.type === 'home' ? teamName : gameData.opponent,
          away_team: gameData.type === 'home' ? gameData.opponent : teamName,
          ...(currentTeamId
            ? isAway
              ? { away_team_id: currentTeamId }
              : { home_team_id: currentTeamId }
            : {}),
          date: gameDateTime.toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          location: gameData.location,
          description: `${gameData.type === 'home' ? 'Home' : gameData.type === 'away' ? 'Away' : 'Neutral'} game: ${teamName} vs ${gameData.opponent}`,
        };
      });
      const result: any = await GameAPI.bulkCreate(payloads);
      const savedGames = Array.isArray(result?.games) ? result.games : [];

      // Convert to local game format and add to state (teamName already in scope from above)
      const newGames: Game[] = savedGames.map((savedGame: any, index: number) => {
        const originalData = bulkGames[index];
        return {
          id: savedGame.id || Date.now().toString() + index,
          homeTeam: originalData.type === 'home' ? teamName : originalData.opponent,
          awayTeam: originalData.type === 'home' ? originalData.opponent : teamName,
          opponent: originalData.opponent,
          date: originalData.date,
          time: originalData.time,
          location: originalData.location,
          type: originalData.type,
          status: 'upcoming',
          banner_url: savedGame.banner_url || undefined, // Include banner URL from saved game
        };
      });

      setGames(prev => [...prev, ...newGames]);
      setActionModal({
        visible: true,
        title: 'Success!',
        message: `Successfully created ${savedGames.length} games!`,
        options: [{ label: 'OK', onPress: () => {}, color: undefined }],
      });
    } catch (error) {
      if (handleCoachAccessError(router, error, 'creating games', user)) {
        return;
      }
      setActionModal({
        visible: true,
        title: 'Error',
        message: toUserMessage(error, 'Failed to create bulk games. Please try again.'),
        options: [{ label: 'OK', onPress: () => {}, color: undefined }],
      });
      if (__DEV__) console.error('Error creating bulk games:', error);
    }
  };

  // Prompt input state
  const [promptValue, setPromptValue] = useState('');

  // When promptModal opens, set default value
  useEffect(() => {
    if (promptModal.visible) {
      setPromptValue(promptModal.defaultValue || '');
    }
  }, [promptModal.visible, promptModal.defaultValue]);

  if (coachLoading) {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}
        edges={['top', 'bottom']}
      >
        <ActivityIndicator style={{ marginTop: 40 }} color={Colors[colorScheme].tint} />
      </SafeAreaView>
    );
  }

  if (!canManage) {
    return (
      <CoachAccessRedirecting
        backgroundColor={Colors[colorScheme].background}
        spinnerColor={Colors[colorScheme].tint}
        textColor={Colors[colorScheme].mutedText}
      />
    );
  }

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}
      edges={['top', 'bottom']}
    >
      {/* Universal Action Modal */}
      <CustomActionModal
        visible={actionModal.visible}
        title={actionModal.title}
        message={actionModal.message}
        options={actionModal.options.map(opt => {
          // Validate onPress is a function to prevent code injection
          const handler = typeof opt.onPress === 'function' ? opt.onPress : () => {};
          return {
            ...opt,
            onPress: () => {
              setActionModal(a => ({ ...a, visible: false }));
              // Safe execution with 150ms delay
              setTimeout(() => handler(), 150);
            },
          };
        })}
        onClose={() => setActionModal(a => ({ ...a, visible: false }))}
      />

      {/* Prompt Modal (for Alert.prompt replacement) */}
      <CustomActionModal
        visible={promptModal.visible}
        title={promptModal.title}
        message={promptModal.message}
        options={[
          {
            label: 'Cancel',
            onPress: () => setPromptModal(p => ({ ...p, visible: false })),
            color: undefined,
          },
          {
            label: 'OK',
            onPress: () => {
              setPromptModal(p => ({ ...p, visible: false }));
              promptModal.onSubmit?.(promptValue);
            },
          },
        ]}
        onClose={() => setPromptModal(p => ({ ...p, visible: false }))}
      >
        {/* Input field for prompt */}
        <View style={{ marginVertical: 12 }}>
          <Text style={{ fontSize: 16, marginBottom: 6 }}>Input:</Text>
          <View style={{ borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 8 }}>
            <TextInput
              style={{ fontSize: 16 }}
              value={promptValue}
              onChangeText={setPromptValue}
              placeholder="Enter value..."
              autoFocus
            />
          </View>
        </View>
      </CustomActionModal>

      {/* Team selector modal */}
      <CustomActionModal
        visible={teamSelectorOpen}
        title="Select a Team"
        message={
          managedTeams.length
            ? 'Choose which roster you would like to manage.'
            : 'You do not manage any teams yet.'
        }
        options={
          managedTeams.length
            ? [{ label: 'Close', onPress: () => setTeamSelectorOpen(false), color: undefined }]
            : [
                { label: 'Cancel', onPress: () => setTeamSelectorOpen(false), color: undefined },
                {
                  label: 'Create Team',
                  onPress: () => {
                    void router.push({
                      pathname: '/create-team',
                      params: {
                        fallback: backFallback ?? '/organization?tab=teams',
                      },
                    } as any);
                  },
                  color: Colors[colorScheme].tint,
                },
              ]
        }
        onClose={() => setTeamSelectorOpen(false)}
      >
        {managedTeams.length > 0 ? (
          <View style={{ width: '100%', gap: 12 }}>
            {managedTeams.map(team => (
              <Pressable
                key={team.id}
                style={[
                  styles.teamOptionButton,
                  {
                    borderColor: Colors[colorScheme].border,
                    backgroundColor: Colors[colorScheme].surface,
                  },
                ]}
                onPress={() => {
                  setCurrentTeam(team);
                  setTeamSelectorOpen(false);
                }}
              >
                <Ionicons name="shield-outline" size={18} color={Colors[colorScheme].tint} />
                <View style={{ flex: 1 }}>
                  <Text
                    style={{ fontSize: 16, fontWeight: '700', color: Colors[colorScheme].text }}
                  >
                    {team.name}
                  </Text>
                  <Text style={{ color: Colors[colorScheme].mutedText, fontSize: 13 }}>
                    Tap to switch to this team
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        ) : (
          <Text style={{ textAlign: 'center', color: Colors[colorScheme].mutedText }}>
            Create a team to unlock the season dashboard.
          </Text>
        )}
      </CustomActionModal>
      <Stack.Screen
        options={{
          headerShown: false,
        }}
      />

      {/* SIMPLIFIED HEADER - Team Name with Back Button */}
      <View
        style={[
          styles.headerCard,
          {
            backgroundColor: Colors[colorScheme].surface,
            borderColor: Colors[colorScheme].border,
            padding: 20,
          },
        ]}
      >
        <View
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <Pressable onPress={handleBack} style={{ padding: 8 }}>
            <Ionicons name="arrow-back" size={24} color={Colors[colorScheme].text} />
          </Pressable>
          <Pressable onPress={() => setTeamSelectorOpen(true)} style={{ flex: 1 }}>
            <Text
              style={{
                fontSize: 24,
                fontWeight: '700',
                textAlign: 'center',
                color: Colors[colorScheme].text,
              }}
            >
              {currentTeam?.name || 'Select Team'}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              if (currentTeam?.id) router.push(`/season-stats?teamId=${currentTeam.id}`);
            }}
            style={{ padding: 8 }}
          >
            <Ionicons
              name="stats-chart"
              size={22}
              color={currentTeam?.id ? Colors[colorScheme].tint : Colors[colorScheme].border}
            />
          </Pressable>
        </View>
      </View>

      {loading && (
        <View
          style={[
            styles.loadingState,
            {
              backgroundColor: Colors[colorScheme].surface,
              borderColor: Colors[colorScheme].border,
            },
          ]}
        >
          <ActivityIndicator color={Colors[colorScheme].tint} />
          <Text style={[styles.loadingText, { color: Colors[colorScheme].mutedText }]}>
            Refreshing season data...
          </Text>
        </View>
      )}

      {/* Quick Actions - SIMPLIFIED: Add Event Only */}
      <View
        style={[
          styles.quickActionsCard,
          { backgroundColor: Colors[colorScheme].surface, borderColor: Colors[colorScheme].border },
        ]}
      >
        <Pressable
          style={[styles.quickActionButton, { backgroundColor: Colors[colorScheme].tint }]}
          onPress={handleAddGame}
        >
          <Ionicons name="add-outline" size={20} color="#fff" />
          <Text style={styles.quickActionText}>Add Event</Text>
        </Pressable>
      </View>

      {/* Tab controls removed — only Schedule content is shown */}

      {/* Main Content - No Tabs, Just Schedule */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 20 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[Colors[colorScheme].tint]}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        {selectedTab === 'schedule' && (
          <View style={styles.tabContent}>
            {!currentTeam?.id ? (
              <View
                style={[
                  styles.sectionCard,
                  {
                    backgroundColor: Colors[colorScheme].surface,
                    borderColor: Colors[colorScheme].border,
                  },
                ]}
              >
                <SectionHeader title="Select a Team to Manage" style={{ paddingHorizontal: 0 }} />
                {managedTeams.length > 0 ? (
                  managedTeams.map(t => (
                    <Pressable
                      key={t.id}
                      style={[styles.gameCard, { borderColor: Colors[colorScheme].border }]}
                      onPress={() => {
                        setCurrentTeam(t);
                        setTeamSelectorOpen(false);
                      }}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Ionicons name="shield" size={18} color={Colors[colorScheme].tint} />
                        <Text
                          style={{
                            fontSize: 16,
                            fontWeight: '700',
                            color: Colors[colorScheme].text,
                          }}
                        >
                          {t.name}
                        </Text>
                      </View>
                    </Pressable>
                  ))
                ) : (
                  <EmptyState
                    icon="people-outline"
                    title="No Teams"
                    subtitle="Create a team to manage your season."
                  />
                )}
              </View>
            ) : null}
            {/* Pending Approval Queue */}
            {pendingGames.length > 0 && (
              <View
                style={[
                  styles.sectionCard,
                  {
                    backgroundColor: Colors[colorScheme].surface,
                    borderColor: '#F59E0B',
                    borderWidth: 2,
                  },
                ]}
              >
                <View
                  style={[
                    styles.approvalHeader,
                    {
                      backgroundColor: colorScheme === 'dark' ? '#78350F' : '#FEF3C7',
                      borderColor: '#F59E0B',
                    },
                  ]}
                >
                  <Ionicons name="time" size={24} color="#F59E0B" />
                  <Text
                    style={[
                      styles.approvalTitle,
                      { color: colorScheme === 'dark' ? '#FDE68A' : '#92400E' },
                    ]}
                  >
                    📋 Approval Queue ({pendingGames.length})
                  </Text>
                </View>
                <Text style={[styles.approvalSubtitle, { color: Colors[colorScheme].mutedText }]}>
                  Games waiting for approval before appearing publicly
                </Text>
                {pendingGames.map(game => (
                  <View
                    key={game.id}
                    style={[
                      styles.pendingGameCard,
                      {
                        backgroundColor: colorScheme === 'dark' ? '#1F2937' : '#F9FAFB',
                        borderColor: Colors[colorScheme].border,
                      },
                    ]}
                  >
                    <GameCard
                      game={{
                        ...game,
                        opponent_name: game.opponent_name || game.opponent,
                        scheduled_date: game.date,
                        scheduled_time: game.time,
                        game_type: game.type,
                      }}
                      onPress={() => handlePendingGameAction(game)}
                      showActions={false}
                      style={{ marginBottom: 0 }}
                    />
                    <View style={styles.pendingActions}>
                      <Pressable
                        style={[styles.approveButton, { backgroundColor: '#10B981' }]}
                        onPress={() => handleApproveGame(game)}
                      >
                        <Ionicons name="checkmark-circle" size={18} color="#FFFFFF" />
                        <Text style={styles.approveButtonText}>Approve</Text>
                      </Pressable>
                      <Pressable
                        style={[
                          styles.rejectButton,
                          { backgroundColor: colorScheme === 'dark' ? '#374151' : '#D1D5DB' },
                        ]}
                        onPress={() => handleRejectGame(game)}
                      >
                        <Ionicons name="close-circle" size={18} color="#EF4444" />
                        <Text
                          style={[
                            styles.rejectButtonText,
                            { color: colorScheme === 'dark' ? '#FCA5A5' : '#DC2626' },
                          ]}
                        >
                          Reject
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                ))}
              </View>
            )}

            {/* Awaiting opponent — read-only. These are approved on our side;
                the opponent confirms them from their Approvals screen. No
                Approve/Reject here: the server refuses self-review (403). */}
            {awaitingOpponentGames.length > 0 && (
              <View
                style={[
                  styles.sectionCard,
                  {
                    backgroundColor: Colors[colorScheme].surface,
                    borderColor: Colors[colorScheme].border,
                  },
                ]}
              >
                <SectionHeader
                  title={`Awaiting Opponent Approval (${awaitingOpponentGames.length})`}
                />
                <Text style={[styles.approvalSubtitle, { color: Colors[colorScheme].mutedText }]}>
                  Sent to the opposing team. They go live once the opponent confirms.
                </Text>
                {awaitingOpponentGames.map(game => (
                  <GameCard
                    key={game.id}
                    game={{
                      ...game,
                      opponent_name: game.opponent_name || game.opponent,
                      scheduled_date: game.date,
                      scheduled_time: game.time,
                      game_type: game.type,
                    }}
                    onPress={() => handlePendingGameAction(game)}
                    showActions={false}
                    style={{ marginBottom: 8 }}
                  />
                ))}
              </View>
            )}

            {/* Upcoming Games */}
            <View
              style={[
                styles.sectionCard,
                {
                  backgroundColor: Colors[colorScheme].surface,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              <SectionHeader
                title="📅 Upcoming Games"
                action={
                  <Pressable onPress={handleAddGame}>
                    <Ionicons
                      name="add-circle-outline"
                      size={24}
                      color={Colors[colorScheme].tint}
                    />
                  </Pressable>
                }
                style={{ paddingHorizontal: 0 }}
              />

              {upcomingGames.length === 0 ? (
                <EmptyState
                  icon="calendar-outline"
                  title="No Upcoming Games"
                  subtitle="Add your first game to get started"
                  style={{ paddingVertical: 40 }}
                />
              ) : (
                upcomingGames.map(game => (
                  <GameCard
                    key={game.id}
                    game={{
                      ...game,
                      // GameCard prepends "vs " via gameRowTitle() and reads
                      // event_type/title from the spread above, so pass ONLY the
                      // opponent name — composing "A vs B" here would double the
                      // "vs". Non-competitive events surface their own title.
                      opponent_name: game.opponent_name || game.opponent,
                      scheduled_date: game.date,
                      scheduled_time: game.time,
                      game_type: game.type,
                    }}
                    onPress={handleGamePress}
                    onEdit={handleGameLongPress}
                    onDelete={handleDeleteGame}
                    showActions={true}
                    style={{ marginBottom: 12 }}
                  />
                ))
              )}
            </View>

            {/* Recent Games */}
            <View
              style={[
                styles.sectionCard,
                {
                  backgroundColor: Colors[colorScheme].surface,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              <SectionHeader title="🏆 Recent Games" style={{ paddingHorizontal: 0 }} />

              {recentGames.length === 0 ? (
                <EmptyState
                  icon="time-outline"
                  title="No Recent Games"
                  subtitle="Past games will appear here"
                  style={{ paddingVertical: 40 }}
                />
              ) : (
                recentGames.map(game => (
                  <GameCard
                    key={game.id}
                    game={{
                      ...game,
                      // See the Upcoming Games card above — pass only the
                      // opponent; gameRowTitle() prepends "vs ".
                      opponent_name: game.opponent_name || game.opponent,
                      scheduled_date: game.date,
                      scheduled_time: game.time,
                      game_type: game.type,
                      home_score: game.score?.team,
                      away_score: game.score?.opponent,
                    }}
                    onPress={handleGamePress}
                    onEdit={handleGameLongPress}
                    onDelete={handleDeleteGame}
                    showActions={true}
                    style={{ marginBottom: 12 }}
                  />
                ))
              )}
            </View>
          </View>
        )}

        {selectedTab === 'standings' && (
          <View style={styles.tabContent}>
            <View
              style={[
                styles.sectionCard,
                {
                  backgroundColor: Colors[colorScheme].surface,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, { color: Colors[colorScheme].text }]}>
                  League Standings
                </Text>
                <Pressable onPress={onRefresh}>
                  <Ionicons name="refresh-outline" size={20} color={Colors[colorScheme].tint} />
                </Pressable>
              </View>
              <EmptyState
                icon="stats-chart-outline"
                title="Standings Coming Soon"
                subtitle="League standings will appear here after standings support is connected."
                style={{ paddingVertical: 40 }}
              />
            </View>
          </View>
        )}

        {selectedTab === 'playoffs' && (
          <View style={styles.tabContent}>
            <View
              style={[
                styles.sectionCard,
                {
                  backgroundColor: Colors[colorScheme].surface,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, { color: Colors[colorScheme].text }]}>
                  Playoff Bracket
                </Text>
                <Pressable onPress={onRefresh}>
                  <Ionicons name="trophy-outline" size={20} color={Colors[colorScheme].tint} />
                </Pressable>
              </View>
              <EmptyState
                icon="trophy-outline"
                title="Playoffs Coming Soon"
                subtitle="Playoff brackets will appear here after bracket support is connected."
                style={{ paddingVertical: 40 }}
              />
            </View>
          </View>
        )}
      </ScrollView>

      {/* Add Event Modal */}
      <AddGameModal
        visible={showAddGameModal}
        onClose={() => setShowAddGameModal(false)}
        onSave={handleSaveGame}
        currentTeamName={currentTeam?.name || 'My Team'}
      />

      {/* Quick Add Event Modal */}
      <QuickAddGameModal
        visible={showQuickAddModal}
        onClose={() => {
          setShowQuickAddModal(false);
          setEditingGame(null);
        }}
        onSave={handleSaveQuickGame}
        currentTeamName={currentTeam?.name || 'My Team'}
        currentTeamId={currentTeam?.id || params.teamId || ''}
        userRole="coach"
        initialData={
          editingGame
            ? {
                id: editingGame.id,
                opponent: editingGame.opponent || '',
                date: editingGame.date,
                time: editingGame.time,
                type: editingGame.type === 'neutral' ? 'home' : editingGame.type, // Convert neutral to home for editing
                banner_url: editingGame.banner_url,
                status: editingGame.status,
                location: editingGame.location,
              }
            : undefined
        }
      />

      {/* Bulk Schedule Modal */}
      <BulkScheduleModal
        visible={showBulkScheduleModal}
        onClose={() => setShowBulkScheduleModal(false)}
        onSave={handleSaveBulkGames}
        currentTeamName={currentTeam?.name || 'My Team'}
        currentTeamId={params.teamId || ''}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  headerCard: {
    margin: 16,
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  statsGradient: {
    padding: 20,
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 20,
    borderWidth: 1,
  },
  seasonHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  seasonInfo: {
    flex: 1,
  },
  seasonTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#fff',
    marginBottom: 4,
  },
  seasonSubtitle: {
    fontSize: 16,
    fontWeight: '500',
    color: '#fff',
    opacity: 0.8,
  },
  settingsButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    rowGap: 12,
  },
  statItem: {
    width: '48%',
    alignItems: 'flex-start',
  },
  statNumber: {
    fontSize: 20,
    fontWeight: '800',
    color: '#fff',
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#fff',
    opacity: 0.8,
    textTransform: 'uppercase',
  },
  quickActionsCard: {
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
  },
  quickActions: {
    gap: 12,
  },
  quickActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    gap: 8,
  },
  quickActionText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  loadingState: {
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
    fontWeight: '600',
  },
  teamOptionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
  },
  tabContainer: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginBottom: 16,
    backgroundColor: '#D1D5DB',
    borderRadius: 12,
    padding: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
  },
  tabText: {
    fontSize: 14,
    fontWeight: '600',
  },
  tabContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  sectionCard: {
    padding: 20,
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '800',
  },
  gameCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
  },
  gameInfo: {
    flex: 1,
  },
  gameHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  opponent: {
    fontSize: 16,
    fontWeight: '700',
  },
  gameType: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  gameTypeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  scoreContainer: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  scoreText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  gameDetails: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 4,
  },
  gameLocation: {
    fontSize: 13,
    fontWeight: '500',
  },
  comingSoon: {
    fontSize: 15,
    textAlign: 'center',
    padding: 24,
    fontStyle: 'italic',
  },
  approvalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 12,
    marginBottom: 8,
    borderWidth: 1,
  },
  approvalTitle: {
    fontSize: 18,
    fontWeight: '800',
    flex: 1,
  },
  approvalSubtitle: {
    fontSize: 14,
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  pendingGameCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    marginBottom: 12,
  },
  pendingActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  approveButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 8,
  },
  approveButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  rejectButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 8,
  },
  rejectButtonText: {
    fontSize: 15,
    fontWeight: '700',
  },
});

export default ManageSeasonScreen;
