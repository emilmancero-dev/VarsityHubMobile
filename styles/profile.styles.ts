import { StyleSheet } from 'react-native';
import { Colors } from '@/constants/Colors';

export const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  verticalFeedModal: {
    flex: 1,
    backgroundColor: '#020617',
  },
  center: { flex: 1, padding: 24, alignItems: 'center', justifyContent: 'center' },
  error: { color: '#b91c1c', textAlign: 'center' },

  // Header Styles - Exact Match to Reference
  headerContainer: {
    position: 'relative',
    width: '100%',
    overflow: 'visible', // Allow avatar to extend beyond banner
    backgroundColor: 'transparent', // Will use theme.background from component
  },
  headerBackgroundPressable: {
    position: 'relative',
    height: 200, // Match reference image
    width: '100%',
  },
  headerBackgroundImage: {
    ...StyleSheet.absoluteFillObject,
    height: 200,
    width: '100%',
  },
  headerGradient: {
    ...StyleSheet.absoluteFillObject,
    height: 200,
  },
  headerControls: {
    position: 'absolute',
    right: 16,
    zIndex: 200,
    elevation: 200,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerActionButton: {
    flexDirection: 'row',
    minHeight: 36,
    minWidth: 96,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 2,
  },
  headerActionButtonGhost: {
    borderColor: '#FFFFFF',
    borderWidth: 1.5,
    backgroundColor: 'transparent',
  },
  headerActionButtonActive: {
    borderColor: '#FFB800',
    borderWidth: 1.5,
    backgroundColor: 'rgba(0, 0, 0, 0.18)',
  },
  headerActionButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  controlButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 2,
  },
  persistentBackButton: {
    position: 'absolute',
    left: 16,
    top: 12,
    zIndex: 1000,
    elevation: 1000,
  },
  backgroundEditButton: {
    position: 'absolute',
    left: 16,
    top: 12,
    zIndex: 200,
    elevation: 200,
  },
  profileContent: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 12,
    zIndex: 100, // Ensure profile content is above banner but below avatar
    elevation: 100, // For Android
  },
  avatarSection: {
    marginBottom: -40, // Overlap into content area to close gap
    zIndex: 99999, // Highest z-index to ensure avatar is always on top
    elevation: 99999, // Highest elevation for Android
    position: 'relative',
    marginRight: 0, // Ensure no right margin pushes text
    flexShrink: 0, // Prevent avatar from shrinking
  },
  avatarContainer: {
    position: 'relative',
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 4,
    borderColor: '#ffffff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 99999, // Highest elevation for Android
    backgroundColor: '#ffffff',
    zIndex: 99999, // Highest z-index to ensure avatar is always on top
    overflow: 'visible', // Ensure full circle is visible
  },
  avatarImage: {
    width: '100%',
    height: '100%',
    borderRadius: 46,
  },
  avatarPlaceholder: {
    width: '100%',
    height: '100%',
    borderRadius: 46,
    backgroundColor: 'transparent', // Will be overridden with theme color if needed
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 46,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 0, // Removed margin to close gap
    flexShrink: 1, // Allow wrapping if needed
  },
  userInfo: {
    flex: 1,
    paddingBottom: 0, // Removed padding to close gap
    minWidth: 0, // Allow flex to work properly
    marginLeft: 8, // Ensure spacing from avatar
    paddingRight: 8, // Prevent text from touching screen edge
  },
  userName: {
    fontSize: 22,
    fontWeight: '700',
    flexShrink: 1, // Allow text to shrink if needed
    maxWidth: '100%', // Prevent overflow
  },
  editButtonBelowBanner: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: 'transparent', // Will be overridden with theme color
    borderWidth: 1,
    borderColor: 'transparent', // Will be overridden with theme color
    alignItems: 'center',
    justifyContent: 'center',
  },
  editButtonBelowBannerText: {
    fontSize: 14,
    fontWeight: '600',
  },
  followButtonBelowBanner: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 100,
  },
  followButtonBelowBannerText: {
    fontSize: 14,
    fontWeight: '600',
  },
  followingIndicator: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#10B981',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Profile Details Below Banner - Tight spacing to match reference
  profileDetailsContainer: {
    paddingTop: 48, // Account for avatar overhang (40px negative margin + 8px breathing room)
    marginBottom: 0, // No gap before tabs
    paddingBottom: 0, // No padding at bottom
    // backgroundColor set dynamically via theme.background in component
  },
  userInfoBelowBanner: {
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  editButton: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#3B82F6',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 100,
  },
  editButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  userDetails: {
    paddingHorizontal: 16,
    paddingTop: 4, // Reduced top padding to close gap
    paddingBottom: 4,
  },
  usernameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingTop: 0,
    paddingBottom: 0,
    gap: 12,
  },
  userHandle: {
    fontSize: 15,
    fontWeight: '500', // Slightly bolder for better readability
    flex: 1,
  },
  userBio: {
    fontSize: 15,
    fontWeight: '400',
    marginBottom: 2, // Reduced margin to close gap
    lineHeight: 20,
    // Color will be set inline with theme.text
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 0, // Removed margin to close gap
    marginTop: 2, // Small top margin instead
  },
  metaText: {
    fontSize: 14,
    fontWeight: '500', // Slightly bolder for better readability
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginTop: 2,
    gap: 0, // No gap between number and label
  },
  statTappable: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  statNumber: {
    fontSize: 15,
    fontWeight: '700',
  },
  statLabel: {
    fontSize: 15,
    fontWeight: '500', // Slightly bolder for better readability
  },
  teamsSection: {
    marginTop: 16,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  teamsSectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 10,
  },
  teamsList: {
    gap: 8,
  },
  teamChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    gap: 10,
  },
  teamChipAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  teamChipPlaceholder: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  teamChipName: { flex: 1, fontSize: 15, fontWeight: '600', minWidth: 0 },
  teamChipRole: { fontSize: 12, textTransform: 'capitalize' },
  positionBadgeText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#3B82F6',
    marginBottom: 2,
  },
  credentialsTextCompact: {
    fontSize: 13,
    fontWeight: '400',
    color: Colors.light.mutedText,
  },
  bioSectionCompact: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  userBioCompact: {
    fontSize: 14,
    fontWeight: '400',
    color: Colors.light.text,
    lineHeight: 20,
  },
  badgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
    flexWrap: 'wrap',
  },
  roleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: '#7c3aed',
    gap: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 2,
    elevation: 2,
  },
  coachBadge: { backgroundColor: '#1d4ed8' },
  playerBadge: { backgroundColor: '#dc2626' },
  fanBadge: { backgroundColor: '#7c3aed' },
  roleText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  // Athletic Stats Card
  statsCard: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    marginHorizontal: 16,
    marginTop: 0,
    borderRadius: 16,
    paddingVertical: 24,
    paddingHorizontal: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 6,
    borderWidth: 1,
    borderColor: '#f1f5f9',
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statDivider: {
    width: 1,
    backgroundColor: '#e2e8f0',
    marginHorizontal: 16,
  },

  // Legacy styles kept for existing components
  statValue: { fontSize: 20, fontWeight: '800', color: Colors.light.text },
  name: { fontSize: 18, fontWeight: '800', marginBottom: 4, color: Colors.light.text },
  bio: { fontSize: 15, color: '#4B5563', lineHeight: 20, marginTop: 8 },
  editProfileButton: {
    flex: 1,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  masonryContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 8,
    paddingBottom: 32,
  },
  masonryItem: {
    width: '32%',
    margin: '0.66%',
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#F3F4F6',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  tabsContainer: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    backgroundColor: 'transparent',
    marginTop: 0,
    marginBottom: 0,
    paddingTop: 0,
    paddingBottom: 0,
  },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center' }, // Reduced padding
  activeTab: { borderBottomWidth: 2, borderBottomColor: Colors.light.text },
  tabText: { color: Colors.light.mutedText, fontWeight: '600', fontSize: 15 },
  activeTabText: { color: Colors.light.text },
  filtersBar: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    gap: 12,
    backgroundColor: 'transparent',
  },
  segmentedRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  segment: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20 },
  segmentActive: {},
  segmentText: { fontWeight: '600', fontSize: 13 },
  segmentTextActive: { color: 'white' },
  sortRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  sortPill: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 16 },
  sortPillActive: {},
  sortText: { fontWeight: '600', fontSize: 12 },
  sortTextActive: { color: 'white' },
  emptyContainer: { alignItems: 'center', justifyContent: 'center', padding: 40, gap: 16 },
  emptyTitle: { fontSize: 20, fontWeight: '800', color: 'transparent' }, // Will be overridden with theme.text
  emptySubtitle: {
    color: 'transparent', // Will be overridden with better contrast color
    textAlign: 'center',
    marginBottom: 20,
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '500', // Slightly bolder for better readability
  },
  createPostButton: {
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: 'transparent', // Will be overridden with theme.tint
    borderWidth: 1,
    borderColor: 'transparent', // Will be overridden with theme.tint
    minWidth: 200,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createPostButtonText: {
    fontSize: 16,
    fontWeight: '700', // Bolder for better readability
    color: '#FFFFFF', // White text for good contrast on tint background - always white
  },
  activityItem: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  gridRow: {
    gap: 12, // Spacing between cards like event page
    paddingHorizontal: 8,
    marginBottom: 12, // Vertical spacing between rows
  },
  gridItem: {
    flex: 1,
    aspectRatio: 1,
    margin: 0,
    borderRadius: 14, // Rounded corners like event page
    overflow: 'hidden',
    backgroundColor: '#F3F4F6',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  gridImageContainer: { width: '100%', height: '100%', position: 'relative' },
  gridImage: { width: '100%', height: '100%' },
  gridImageOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  gridImageFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    position: 'relative',
  },
  textPostOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 12,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 8,
    margin: 8,
  },
  gridTextOnly: {
    textAlign: 'center',
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 12,
    lineHeight: 16,
    textShadowColor: 'rgba(0,0,0,0.3)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  gridIconBadge: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 14,
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
  },
  gridCounts: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 14,
    paddingHorizontal: 8,
    paddingVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
  },
  gridCountItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  gridCountText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  // Text-only post card styles (clean card instead of gradient)
  gridItemTextCard: {
    aspectRatio: undefined,
    minHeight: 140,
    backgroundColor: undefined, // will be set by theme
  },
  textCardInner: {
    flex: 1,
    padding: 12,
    justifyContent: 'space-between',
  },
  textCardAuthor: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  textCardCaption: {
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 18,
    flex: 1,
  },
  textCardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 8,
  },
  textCardStat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  textCardStatText: {
    fontSize: 12,
    fontWeight: '600',
  },

  // Organizations Section
  organizationsSection: {
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 12,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  orgHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  orgTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  orgList: {
    gap: 12,
    paddingRight: 16,
  },
  orgCard: {
    width: 100,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    gap: 8,
  },
  orgLogo: {
    width: 48,
    height: 48,
    borderRadius: 24,
  },
  orgLogoPlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  orgName: {
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
});
