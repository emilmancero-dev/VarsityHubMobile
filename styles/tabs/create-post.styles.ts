import { Platform, StyleSheet } from 'react-native';
import { Colors } from '@/constants/Colors';

export const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  authGateState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 12,
  },
  authGateText: {
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 20,
  },
  iconBtn: {
    padding: 8,
    borderRadius: 999,
    backgroundColor: 'transparent',
  },
  headerSpacer: {
    flex: 1,
  },
  postButtonContainer: {
    minWidth: 80,
    alignItems: 'flex-end',
  },

  // Prompts Section
  promptsSection: {
    marginBottom: 20,
  },

  // Composer Section
  composerSection: {
    marginBottom: 24,
  },
  textarea: {
    height: 120,
    borderRadius: 12,
    borderWidth: 1,
    // borderColor: Uses dynamic color in JSX
    padding: 16,
    textAlignVertical: 'top',
    marginBottom: 8,
    fontSize: 16,
    lineHeight: 22,
    // backgroundColor & color: Uses dynamic colors in JSX
  },
  helper: {
    fontSize: 14,
    fontStyle: 'italic',
    // color: Uses dynamic color in JSX
  },

  // Swipe Section
  swipeSection: {
    marginBottom: 24,
    borderRadius: 20,
    borderWidth: 1.5,
    paddingVertical: 18,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  swipeSectionCamera: {
    backgroundColor: '#DBEAFE',
    borderColor: '#93C5FD',
  },
  swipeSectionReview: {
    backgroundColor: '#FEE2E2',
    borderColor: '#FCA5A5',
  },
  swipeIndicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    gap: 12,
  },
  swipeOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    minWidth: 120,
    borderWidth: 1.5,
  },
  swipeOptionInactive: {
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderColor: 'rgba(17,24,39,0.08)',
  },
  swipeOptionActiveCamera: {
    backgroundColor: '#1D4ED8',
    borderColor: '#1D4ED8',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 4px 8px rgba(29, 78, 216, 0.18)' }
      : {
          shadowColor: '#1D4ED8',
          shadowOpacity: 0.18,
          shadowOffset: { width: 0, height: 4 },
          shadowRadius: 8,
        }),
    elevation: 4,
  },
  swipeOptionActiveReview: {
    backgroundColor: '#DC2626',
    borderColor: '#DC2626',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 4px 8px rgba(220, 38, 38, 0.18)' }
      : {
          shadowColor: '#DC2626',
          shadowOpacity: 0.18,
          shadowOffset: { width: 0, height: 4 },
          shadowRadius: 8,
        }),
    elevation: 4,
  },
  swipeOptionLabel: {
    marginLeft: 8,
    fontSize: 15,
    fontWeight: '600',
    // color: Uses dynamic color in JSX
  },
  swipeOptionLabelActiveCamera: {
    color: '#FFFFFF',
  },
  swipeOptionLabelActiveReview: {
    color: '#FFFFFF',
  },
  swipeDivider: {
    width: 1,
    height: 32,
    backgroundColor: 'rgba(17,24,39,0.08)',
  },
  swipeHint: {
    marginTop: 14,
    fontSize: 13,
    fontWeight: '600',
  },
  swipeHintCamera: {
    color: '#1D4ED8',
  },
  swipeHintReview: {
    color: '#DC2626',
  },

  // Media Section
  mediaSection: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    // color: Uses dynamic color in JSX
    marginBottom: 16,
    textAlign: 'center',
  },
  tilesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
  },
  // Owner note (Sep 2026): the three Add Media tiles are color-coded by medium —
  // Photo = bronze, Camera = silver, Video = gold — and rendered as a metallic
  // gradient (constants/metallic.ts), not a flat swatch, per the commandments
  // rule that every bronze/silver/gold surface in the app reads as polished
  // metal. tileShadowWrap carries the drop shadow (must NOT clip, so no
  // overflow/borderRadius here); tileGradient carries the metal sheen + corner
  // radius + a light rim highlight for contrast against the shadow wrap.
  tileShadowWrap: {
    width: 100,
    height: 100,
    borderRadius: 20,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 2px 8px rgba(0, 0, 0, 0.08)' }
      : {
          shadowColor: '#000',
          shadowOpacity: 0.08,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 },
        }),
    elevation: 3,
  },
  tileGradient: {
    flex: 1,
    borderRadius: 20,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.35)',
  },
  tileLabel: {
    fontSize: 12,
    fontWeight: '600',
    // color: Uses dynamic color in JSX
    marginTop: 6,
  },
  successOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  successCheckCircle: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: '#16A34A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  successTitle: {
    fontSize: 22,
    fontWeight: '800',
  },
  successPreview: {
    width: 140,
    height: 140,
    borderRadius: 14,
    backgroundColor: '#000',
  },
  successVideoPreview: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  successEventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
  },
  successEventText: {
    fontSize: 14,
    fontWeight: '600',
    flexShrink: 1,
  },
  successDoneButton: {
    marginTop: 8,
    paddingHorizontal: 40,
    paddingVertical: 13,
    borderRadius: 12,
  },
  successDoneText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  lightTileLabel: {
    color: '#FFFFFF',
  },
  darkTileLabel: {
    color: '#1B2430',
  },
  storyButtonContainer: {
    marginTop: 20,
    alignItems: 'center',
    gap: 8,
  },
  storyHint: {
    fontSize: 12,
    // color: Uses dynamic color in JSX
    fontStyle: 'italic',
    textAlign: 'center',
  },

  // Preview Section
  previewSection: {
    marginBottom: 24,
  },
  previewContainer: {
    position: 'relative',
    borderRadius: 16,
    overflow: 'hidden',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 2px 8px rgba(0, 0, 0, 0.1)' }
      : {
          shadowColor: '#000',
          shadowOpacity: 0.1,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 },
        }),
    elevation: 4,
  },
  previewMedia: {
    width: '100%',
    height: 240,
    // backgroundColor: Uses dynamic color in JSX
  },
  removeButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  cropHint: {
    fontSize: 12,
    fontStyle: 'italic',
    textAlign: 'center',
    marginTop: 6,
    marginBottom: 2,
  },
  extraPhotoStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  extraPhotoThumbWrap: {
    width: 56,
    height: 56,
    borderRadius: 8,
    overflow: 'hidden',
    position: 'relative',
  },
  extraPhotoThumb: {
    width: '100%',
    height: '100%',
  },
  extraPhotoRemove: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Game/Event Section
  gameSection: {
    marginBottom: 24,
  },
  gameSuggestionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#ECFDF5',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#A7F3D0',
    gap: 12,
  },
  gameIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#D1FAE5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  gameLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#059669',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  gameTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#065F46',
    marginBottom: 2,
  },
  gameDate: {
    fontSize: 13,
    color: '#047857',
  },
  eventConfirmation: {
    fontSize: 12,
    fontWeight: '600',
  },
  gameHint: {
    fontSize: 12,
    color: Colors.light.mutedText,
    marginTop: 8,
    textAlign: 'center',
    fontStyle: 'italic',
  },

  // Settings Section
  settingsSection: {
    marginBottom: 24,
  },
  locRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 16,
    // backgroundColor: Uses dynamic color in JSX
    borderRadius: 12,
  },
  settingInfo: {
    flex: 1,
  },
  locLabel: {
    fontWeight: '600',
    fontSize: 16,
    // color: Uses dynamic color in JSX
  },
  settingDescription: {
    fontSize: 14,
    // color: Uses dynamic color in JSX
    marginTop: 2,
  },
  muted: {
    // color: Uses dynamic color in JSX
    fontSize: 14,
    marginTop: 12,
    textAlign: 'center',
    fontStyle: 'italic',
  },

  // Footer Section
  footerSection: {
    alignItems: 'center',
    paddingTop: 12,
  },
  footerLink: {
    color: '#1B3A6B',
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '500',
  },
  warningBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  warningText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 18,
  },
  warningActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 16,
  },
  warningActionLink: {
    fontSize: 13,
  },
  error: {
    color: '#DC2626',
    marginTop: 12,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '500',
  },

  // Review Modal
  reviewModalContainer: {
    flex: 1,
    // backgroundColor: Uses dynamic color in JSX
  },
  reviewModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    // borderBottomColor: Uses dynamic color in JSX
  },
  reviewModalTitle: {
    fontSize: 18,
    fontWeight: '700',
    // color: Uses dynamic color in JSX
  },
  reviewModalBody: {
    padding: 20,
    gap: 20,
  },
  reviewMediaCard: {
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    // borderColor & backgroundColor: Uses dynamic colors in JSX
  },
  reviewMedia: {
    width: '100%',
    height: 240,
  },
  reviewMediaLabel: {
    padding: 12,
    fontSize: 14,
    fontWeight: '600',
    // color: Uses dynamic color in JSX
  },
  reviewTextCard: {
    borderRadius: 16,
    borderWidth: 1,
    // borderColor & backgroundColor: Uses dynamic colors in JSX
    padding: 16,
  },
  reviewTextLabel: {
    fontSize: 13,
    fontWeight: '700',
    // color: Uses dynamic color in JSX
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  reviewText: {
    fontSize: 15,
    // color: Uses dynamic color in JSX
    lineHeight: 22,
  },
  reviewEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    paddingHorizontal: 16,
    borderRadius: 16,
    borderWidth: 1,
    // borderColor & backgroundColor: Uses dynamic colors in JSX
    gap: 12,
  },
  reviewEmptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    // color: Uses dynamic color in JSX
  },
  reviewEmptySubtitle: {
    fontSize: 14,
    // color: Uses dynamic color in JSX
    textAlign: 'center',
    lineHeight: 20,
  },

  // Event selection styles
  sectionTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  changeEventButton: {
    color: '#1B3A6B',
    fontSize: 14,
    fontWeight: '600',
  },
  noEventCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1.5,
    // borderColor & backgroundColor: Uses dynamic colors in JSX
    borderStyle: 'dashed',
  },
  noEventText: {
    // color: Uses dynamic color in JSX
    fontSize: 14,
    fontWeight: '500',
  },
  eventActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 8,
  },
  removeEventButton: {
    color: '#DC2626',
    fontSize: 13,
    fontWeight: '600',
  },

  // Event selector modal
  modalContainer: {
    flex: 1,
    // backgroundColor: Uses dynamic color in JSX
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    // borderBottomColor: Uses dynamic color in JSX
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    // color: Uses dynamic color in JSX
  },
  modalBody: {
    padding: 16,
    gap: 12,
  },
  eventOptionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    // borderColor & backgroundColor: Uses dynamic colors in JSX
  },
  eventOptionCardSelected: {
    borderColor: '#059669',
    backgroundColor: '#ECFDF5',
  },
  eventOptionIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    // backgroundColor: Uses dynamic color in JSX
    alignItems: 'center',
    justifyContent: 'center',
  },
  eventOptionBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: '#F59E0B',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  eventOptionTitle: {
    fontSize: 15,
    fontWeight: '600',
    // color: Uses dynamic color in JSX
    marginBottom: 4,
  },
  eventOptionDate: {
    fontSize: 13,
    // color: Uses dynamic color in JSX
    marginBottom: 2,
  },
  eventOptionLocation: {
    fontSize: 12,
    // color: Uses dynamic color in JSX
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    gap: 12,
  },
  emptyStateTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.light.text,
  },
  emptyStateText: {
    fontSize: 14,
    color: Colors.light.mutedText,
    textAlign: 'center',
    lineHeight: 20,
  },

  // Nearby games
  nearbyGamesHint: {
    fontSize: 13,
    marginBottom: 12,
    fontStyle: 'italic',
  },
  nearbyGameCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 8,
  },
  gameMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  gameDistance: {
    fontSize: 12,
    fontWeight: '600',
  },
  viewMoreButton: {
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  viewMoreText: {
    fontSize: 14,
    fontWeight: '600',
  },

  // Preview modal
  previewCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    marginBottom: 24,
  },
  previewLabel: {
    fontSize: 13,
    marginBottom: 12,
    fontStyle: 'italic',
  },
  previewContent: {
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 12,
  },
  previewMediaContainer: {
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 12,
    position: 'relative',
  },
  previewMediaFull: {
    width: '100%',
    minHeight: 300,
    backgroundColor: '#F3F4F6',
  },
  retakeButton: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 20,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 2px 8px rgba(0, 0, 0, 0.2)' }
      : {
          shadowColor: '#000',
          shadowOpacity: 0.2,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 },
        }),
    elevation: 4,
  },
  retakeButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  previewEventBadge: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: 16,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  previewEventText: {
    fontSize: 15,
    fontWeight: '600',
  },
  previewEventId: {
    fontSize: 13,
    marginTop: 4,
  },
  previewDestination: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderRadius: 8,
  },
  previewDestinationText: {
    fontSize: 13,
    flex: 1,
  },
  previewPostActions: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#D1D5DB',
  },
  previewActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  previewActionText: {
    fontSize: 13,
    fontWeight: '600',
  },
  previewActions: {
    flexDirection: 'row',
    gap: 12,
  },
  previewButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 16,
    borderRadius: 12,
  },
  editButton: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  confirmButton: {
    backgroundColor: '#1B3A6B',
  },
  previewButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  confirmButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  previewTips: {
    flexDirection: 'row',
    gap: 12,
    padding: 16,
    borderRadius: 12,
    marginTop: 16,
  },
  previewTipsTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 6,
  },
  previewTipsText: {
    fontSize: 13,
    lineHeight: 20,
  },
  celebrationOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 999,
  },
  celebrationContent: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  celebrationTitle: {
    color: '#FFD700',
    fontSize: 34,
    fontWeight: '900',
    marginTop: 20,
    letterSpacing: 1,
  },
  celebrationSubtitle: {
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 18,
    fontWeight: '600',
    marginTop: 10,
  },
  confettiDot: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  headerPostBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#1B3A6B',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 2px 6px rgba(27, 58, 107, 0.3)' }
      : {
          shadowColor: '#1B3A6B',
          shadowOpacity: 0.3,
          shadowOffset: { width: 0, height: 2 },
          shadowRadius: 6,
        }),
    elevation: 4,
  },
  headerPostBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
});
