import { Platform, StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  // Base Layout
  screen: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  loadingText: {
    fontSize: 16,
    fontWeight: '500',
  },
  loadingPlaceholder: {
    flex: 1,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  errorText: {
    fontSize: 16,
    textAlign: 'center',
    fontWeight: '500',
  },
  retryButton: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#fff',
    fontWeight: '600',
  },

  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  backButton: {
    padding: 8,
    borderRadius: 8,
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 8,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  headerSubtitle: {
    fontSize: 12,
    marginTop: 2,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8,
  },
  headerActionButton: {
    padding: 8,
    borderRadius: 8,
  },
  shareButton: {
    padding: 8,
    borderRadius: 8,
  },

  // Swipe Hint
  swipeHint: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    gap: 8,
  },
  swipeHintText: {
    fontSize: 12,
    fontWeight: '500',
  },

  // Content
  content: {
    flex: 1,
  },

  // Hero Section
  heroSection: {
    position: 'relative',
  },
  mediaContainer: {
    width: '100%',
    height: 280,
    position: 'relative',
    // Defense-in-depth on web: a mis-sized <video> must never spill its
    // native controls over the post body below.
    overflow: 'hidden',
  },
  heroImage: {
    width: '100%',
    height: '100%',
  },
  videoContainer: {
    width: '100%',
    height: '100%',
    // Letterbox bars read as intentional on black, not as a broken layout.
    backgroundColor: '#000',
  },
  heroVideo: {
    width: '100%',
    height: '100%',
  },
  noMediaHero: {
    width: '100%',
    height: 200,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  noMediaIcon: {
    fontSize: 48,
  },
  noMediaText: {
    fontSize: 16,
    fontWeight: '600',
  },
  mediaOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 120,
  },
  mediaTopOverlay: {
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  categoryBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  categoryIcon: {
    fontSize: 16,
  },
  categoryText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  countryFlag: {
    fontSize: 20,
  },
  liveBadge: {
    position: 'absolute',
    top: 16,
    right: 16,
    backgroundColor: '#DC2626',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  liveText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
  },
  expandIcon: {
    position: 'absolute',
    bottom: 16,
    right: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    padding: 8,
    borderRadius: 20,
  },

  // Post Content
  postContent: {
    padding: 20,
    // Was marginTop: -20 — the caption/author card overlapped the bottom of the
    // media, blocking the image ("the product is the image", owner 2026-07-14).
    // A positive gap keeps the media fully visible with the card cleanly below.
    marginTop: 12,
    marginHorizontal: 16,
    borderRadius: 16,
    ...Platform.select({
      ios: {
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.1,
        shadowRadius: 12,
      },
      android: {
        elevation: 8,
      },
    }),
  },
  postTitle: {
    fontSize: 24,
    fontWeight: '800',
    lineHeight: 32,
    marginBottom: 12,
  },
  postText: {
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 20,
  },
  postTextToggle: {
    marginTop: -10,
    marginBottom: 20,
    fontWeight: '700',
  },

  // Game/Event Info
  gameInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 20,
    gap: 12,
  },
  gameDetails: {
    flex: 1,
  },
  gameTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  gameTeams: {
    fontSize: 13,
  },

  // Team Info
  teamInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 20,
    gap: 12,
  },
  teamDetails: {
    flex: 1,
  },
  teamTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  teamSport: {
    fontSize: 13,
  },

  // Author Section
  authorSection: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 16,
    marginBottom: 16,
    borderBottomWidth: 1,
  },
  authorInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  authorAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
  },
  defaultAvatar: {
    backgroundColor: '#9CA3AF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  authorDetails: {
    flex: 1,
  },
  authorName: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 2,
  },
  postTime: {
    fontSize: 13,
    fontWeight: '500',
  },
  followButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 20,
  },
  followingButton: {},
  followText: {
    fontSize: 14,
    fontWeight: '600',
  },
  followingText: {},

  // Stats & Actions
  statsSection: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  stats: {
    flexDirection: 'row',
    gap: 16,
  },
  stat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statText: {
    fontSize: 14,
    fontWeight: '600',
  },
  actions: {
    flexDirection: 'row',
    gap: 6,
  },
  actionButton: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  upvoteButton: {
    backgroundColor: '#2563EB',
    borderColor: '#2563EB',
  },
  upvoteButtonActive: {
    backgroundColor: '#10B981',
    borderColor: '#10B981',
  },
  actionText: {
    fontSize: 13,
    fontWeight: '600',
  },
  actionTextActive: {
    fontWeight: '700',
  },

  // Quick Links
  quickLinks: {
    paddingTop: 20,
    marginTop: 20,
    borderTopWidth: 1,
  },
  quickLinksTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  quickLinksRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  quickLinkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
    ...Platform.select({
      ios: {
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  quickLinkText: {
    fontSize: 14,
    fontWeight: '600',
  },

  // Comments Section
  commentsSection: {
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 8,
  },
  commentsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingVertical: 12,
  },
  commentsTitle: {
    fontSize: 20,
    fontWeight: '700',
  },
  commentsCount: {
    fontSize: 14,
    fontWeight: '600',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },

  // Add Comment
  addCommentWrapper: {},
  addCommentContainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    padding: 16,
    borderRadius: 12,
  },
  replyingToBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  replyingToText: {
    fontSize: 13,
  },
  commentAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  commentInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 14,
    maxHeight: 80,
    textAlignVertical: 'top',
  },
  sendButton: {
    padding: 8,
    borderRadius: 8,
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },

  // Comments List
  commentsList: {
    paddingBottom: 16,
  },
  emptyComments: {
    paddingVertical: 40,
    alignItems: 'center',
    gap: 12,
  },
  emptyCommentsText: {
    fontSize: 18,
    fontWeight: '600',
  },
  emptyCommentsSubtext: {
    fontSize: 14,
    textAlign: 'center',
  },
  commentCard: {
    padding: 16,
  },
  commentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  commentAuthor: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  commentAuthorInfo: {
    flex: 1,
  },
  commentAuthorName: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 2,
  },
  commentDate: {
    fontSize: 12,
    fontWeight: '500',
  },
  commentActions: {
    flexDirection: 'row',
    gap: 8,
  },
  commentActionBtn: {
    padding: 6,
    borderRadius: 6,
  },
  commentText: {
    fontSize: 15,
    lineHeight: 22,
    letterSpacing: 0.1,
  },

  // Edit Modal
  editModal: {
    flex: 1,
  },
  editHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
  },
  editTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  cancelButton: {
    fontSize: 16,
    fontWeight: '500',
  },
  saveButton: {
    fontSize: 16,
    fontWeight: '600',
  },
  saveButtonDisabled: {
    // Color handled dynamically in component
  },
  editContent: {
    flex: 1,
    padding: 16,
  },
  editCommentInput: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    minHeight: 120,
    textAlignVertical: 'top',
    ...Platform.select({
      ios: {
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
      },
      android: {
        elevation: 2,
      },
    }),
  },

  // Skeleton Loading Styles
  skeletonButton: {
    width: 40,
    height: 40,
    borderRadius: 8,
  },
  skeletonTitle: {
    width: 120,
    height: 20,
    borderRadius: 4,
  },
  skeletonHero: {
    width: '100%',
    height: 280,
  },
  skeletonLine: {
    height: 16,
    borderRadius: 4,
    marginBottom: 8,
  },
  skeletonLineTitle: {
    width: '80%',
    height: 24,
    marginBottom: 12,
  },
  skeletonLineText: {
    width: '100%',
  },
  skeletonAuthorName: {
    width: '60%',
    height: 16,
    borderRadius: 4,
    marginBottom: 4,
  },
  skeletonAuthorTime: {
    width: '40%',
    height: 12,
    borderRadius: 4,
  },
  skeletonFollowButton: {
    width: 80,
    height: 32,
    borderRadius: 16,
  },
  skeletonCommentsTitle: {
    width: 100,
    height: 20,
    borderRadius: 4,
  },
  skeletonCommentsCount: {
    width: 24,
    height: 24,
    borderRadius: 12,
  },
  skeletonCommentAuthor: {
    width: '50%',
    height: 14,
    borderRadius: 4,
    marginBottom: 2,
  },
  skeletonCommentDate: {
    width: '30%',
    height: 12,
    borderRadius: 4,
  },
  skeletonCommentText: {
    width: '90%',
    height: 14,
    borderRadius: 4,
    marginTop: 8,
  },

  // Fullscreen Media Styles
  fullscreenContainer: {
    flex: 1,
    backgroundColor: '#121212',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullscreenCloseButton: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 60 : 40,
    right: 20,
    zIndex: 10,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    padding: 8,
    borderRadius: 24,
  },
  fullscreenRotateButton: {
    position: 'absolute',
    bottom: Platform.OS === 'ios' ? 60 : 40,
    right: 20,
    zIndex: 10,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    padding: 8,
    borderRadius: 24,
  },
  fullscreenPageIndicator: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 66 : 46,
    alignSelf: 'center',
    zIndex: 10,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  fullscreenPageIndicatorText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  fullscreenImageWrapper: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullscreenImage: {
    width: '100%',
    height: '100%',
  },
  fullscreenVideo: {
    width: '100%',
    height: '100%',
  },
});
