import { Dimensions, Platform, StyleSheet } from 'react-native';

const { height: windowHeight } = Dimensions.get('window');

export const styles = StyleSheet.create({
  container: { flex: 1 },
  backdrop: { ...StyleSheet.absoluteFillObject },
  card: { backgroundColor: 'transparent' },
  mediaContainer: {
    flex: 1,
    backgroundColor: '#000', // Black background for images to show properly with contain mode
    justifyContent: 'center',
    alignItems: 'center',
  },
  media: {
    width: '100%',
    height: '100%',
    backgroundColor: 'transparent',
  },
  mediaFallback: { alignItems: 'center', justifyContent: 'center' },
  mediaFallbackText: { fontWeight: '700' },
  textOnlyCard: {
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  textOnlyContent: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 24,
    padding: 24,
    maxWidth: 600,
    alignSelf: 'center',
    width: '100%',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  textOnlyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  textOnlyAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    marginRight: 12,
  },
  textOnlyAuthorInfo: {
    flex: 1,
  },
  textOnlyAuthorName: {
    fontSize: 17,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 2,
  },
  textOnlyTimestamp: {
    fontSize: 14,
    color: '#94a3b8',
    fontWeight: '500',
  },
  textOnlyCaption: {
    fontSize: 19,
    fontWeight: '400',
    color: '#f1f5f9',
    lineHeight: 28,
    letterSpacing: -0.2,
  },
  textOnlyCaptionToggle: {
    color: '#cbd5e1',
  },
  headerOverlay: {
    position: 'absolute',
    left: 16,
    right: 16,
    top: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    pointerEvents: 'box-none',
  },
  headerAvatar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  avatar: { width: 32, height: 32, borderRadius: 16 },
  avatarFallback: { backgroundColor: '#374151', alignItems: 'center', justifyContent: 'center' },
  avatarFallbackText: { fontWeight: '700' },
  authorName: { color: '#fff', marginLeft: 8, fontWeight: '700' },
  captionOverlay: {
    position: 'absolute',
    left: 16,
    // Gutter reserved for the action rail; narrowed from 88 on 2026-07-17 when
    // the rail lost its 48px avatar and its icons shrank.
    right: 76,
    bottom: 12,
    zIndex: 20,
    elevation: 20,
    pointerEvents: 'box-none',
  },
  authorNameBottom: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
    ...(Platform.OS === 'web'
      ? { textShadow: '0px 1px 3px rgba(0, 0, 0, 0.75)' }
      : {
          textShadowColor: 'rgba(0, 0, 0, 0.75)',
          textShadowOffset: { width: 0, height: 1 },
          textShadowRadius: 3,
        }),
  },
  authorNameButton: {
    alignSelf: 'flex-start',
  },
  eventChipRow: {
    marginTop: 6,
    marginBottom: 2,
  },
  captionText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '500',
    lineHeight: 20,
    ...(Platform.OS === 'web'
      ? { textShadow: '0px 1px 3px rgba(0, 0, 0, 0.75)' }
      : {
          textShadowColor: 'rgba(0, 0, 0, 0.75)',
          textShadowOffset: { width: 0, height: 1 },
          textShadowRadius: 3,
        }),
  },
  captionToggle: {
    color: '#e2e8f0',
    ...(Platform.OS === 'web'
      ? { textShadow: '0px 1px 3px rgba(0, 0, 0, 0.75)' }
      : {
          textShadowColor: 'rgba(0, 0, 0, 0.75)',
          textShadowOffset: { width: 0, height: 1 },
          textShadowRadius: 3,
        }),
  },
  videoWrap: {
    width: '100%',
    height: '100%',
  },
  // Absolute so it fills videoWrap *behind* the VideoView rather than stacking
  // above it in flow (styles.media is 100%-height, not absolute).
  videoPoster: {
    ...StyleSheet.absoluteFillObject,
  },
  videoOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(2, 6, 23, 0.38)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 24,
  },
  videoOverlayTitle: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  videoOverlayCaption: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '600',
  },
  rail: {
    position: 'absolute',
    right: 16,
    bottom: 12,
    alignItems: 'center',
    zIndex: 20,
    elevation: 20,
    pointerEvents: 'box-none',
  },
  // v1.0.3: the follow-plus badge styles were removed along with the overlay
  // badge on the avatar. 2026-07-17: the rail avatar styles went the same way
  // when the avatar itself was removed from the rail. All are kept out of the
  // stylesheet so future greps don't trip over a dead style.
  // Icon is 26–28px but the padding keeps the touch target at ~44x44.
  railBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
    minWidth: 44,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  railLabel: {
    color: '#fff',
    fontWeight: '800',
    marginTop: 2,
    fontSize: 12,
    ...(Platform.OS === 'web'
      ? { textShadow: '0px 1px 3px rgba(0, 0, 0, 0.75)' }
      : {
          textShadowColor: 'rgba(0, 0, 0, 0.75)',
          textShadowOffset: { width: 0, height: 1 },
          textShadowRadius: 3,
        }),
  },
  titleOverlay: {
    position: 'absolute',
    top: 0,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 30,
    elevation: 30,
    pointerEvents: 'box-none',
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleTextWrap: {
    flex: 1,
    marginLeft: 12,
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  titleText: {
    fontWeight: '800',
    fontSize: 16,
    color: '#fff',
    ...(Platform.OS === 'web'
      ? { textShadow: '0px 1px 3px rgba(0, 0, 0, 0.75)' }
      : {
          textShadowColor: 'rgba(0, 0, 0, 0.75)',
          textShadowOffset: { width: 0, height: 1 },
          textShadowRadius: 3,
        }),
  },
  titleSubtitle: {
    color: '#e5e7eb',
    marginTop: 2,
    fontSize: 12,
    ...(Platform.OS === 'web'
      ? { textShadow: '0px 1px 3px rgba(0, 0, 0, 0.75)' }
      : {
          textShadowColor: 'rgba(0, 0, 0, 0.75)',
          textShadowOffset: { width: 0, height: 1 },
          textShadowRadius: 3,
        }),
  },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  emptyStateTitle: { fontWeight: '800', fontSize: 18 },
  emptyStateCaption: { marginTop: 8, textAlign: 'center' },
  emptyStateBtn: {
    marginTop: 16,
    backgroundColor: '#2563EB',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 999,
  },
  emptyStateBtnText: { fontWeight: '700' },
  loadingState: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  commentModalRoot: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  commentSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 24,
    paddingTop: 16,
    paddingHorizontal: 16,
    minHeight: windowHeight * 0.4,
  },
  commentHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  commentTitle: { fontSize: 18, fontWeight: '700' },
  commentCloseBtn: { position: 'absolute', right: 0, padding: 6 },
  commentError: { marginVertical: 8, textAlign: 'center' },
  commentRow: { marginBottom: 14, borderBottomWidth: 1 },
  commentAuthor: { fontWeight: '700' },
  commentBody: { marginTop: 4 },
  commentTimestamp: { marginTop: 4, fontSize: 12 },
  commentComposer: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  commentInput: {
    flex: 1,
    backgroundColor: '#1f2937',
    borderRadius: 12,
    color: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginRight: 12,
  },
  commentSendBtn: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
  },
  commentSendDisabled: { backgroundColor: '#475569' },
  commentSendText: { fontWeight: '700' },

  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: '#1E1E1E',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 400,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 12,
    textAlign: 'center',
  },
  modalText: {
    fontSize: 16,
    color: '#cbd5e1',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 22,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  modalCancelBtn: {
    flex: 1,
    backgroundColor: '#475569',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  modalCancelText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  modalDeleteBtn: {
    flex: 1,
    backgroundColor: '#dc2626',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  modalDeleteText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  modalSaveBtn: {
    flex: 1,
    backgroundColor: '#2563EB',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  modalSaveText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  editInput: {
    backgroundColor: '#3A3A3C',
    color: '#fff',
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    minHeight: 120,
    marginBottom: 24,
    textAlignVertical: 'top',
  },
  optionsMenu: {
    backgroundColor: '#1E1E1E',
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 40,
  },
  optionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
  },
  optionText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '500',
  },
});
