import { Platform, StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  name: {
    fontSize: 18,
    fontWeight: '600',
  },
  muted: {
    fontSize: 14,
    opacity: 0.7,
  },
  centerContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  loadingText: {
    fontSize: 16,
    marginTop: 12,
    opacity: 0.7,
  },
  errorText: {
    fontSize: 16,
    marginTop: 12,
    textAlign: 'center',
  },
  tabContainer: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginBottom: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 12,
    padding: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  activeTab: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  tabText: {
    fontSize: 14,
    fontWeight: '600',
  },
  messagesList: {
    flex: 1,
    paddingHorizontal: 8,
  },
  messageContainer: {
    flexDirection: 'row',
    marginBottom: 4,
    alignItems: 'flex-end',
    paddingHorizontal: 4,
  },
  currentUserMessage: {
    flexDirection: 'row-reverse',
  },
  announcementMessage: {
    backgroundColor: 'rgba(255, 193, 7, 0.1)',
    borderRadius: 16,
    padding: 12,
    margin: 8,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 1px 2px rgba(0, 0, 0, 0.1)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.1,
          shadowRadius: 2,
        }),
    elevation: 2,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
    marginBottom: 4,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 1px 2px rgba(0, 0, 0, 0.15)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.15,
          shadowRadius: 2,
        }),
    elevation: 2,
  },
  avatarText: {
    fontSize: 12,
    fontWeight: '600',
    color: 'white',
  },
  messageContent: {
    flex: 1,
    maxWidth: '75%',
  },
  currentUserContent: {
    alignItems: 'flex-end',
  },
  announcementContent: {
    backgroundColor: 'rgba(255, 193, 7, 0.15)',
    borderRadius: 12,
    padding: 8,
  },
  messageContentWithoutAvatar: {
    marginLeft: 40,
  },
  messageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
    paddingHorizontal: 4,
  },
  authorName: {
    fontSize: 14,
    fontWeight: '600',
  },
  authorRole: {
    fontSize: 12,
    textTransform: 'uppercase',
  },
  timestamp: {
    fontSize: 11,
    marginLeft: 'auto',
  },
  replyContainer: {
    borderLeftWidth: 3,
    paddingLeft: 12,
    marginBottom: 6,
    opacity: 0.8,
    borderRadius: 8,
    paddingVertical: 4,
  },
  replyText: {
    fontSize: 12,
    fontStyle: 'italic',
  },
  messageBubble: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    maxWidth: '100%',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 1px 3px rgba(0, 0, 0, 0.1)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.1,
          shadowRadius: 3,
        }),
    elevation: 2,
  },
  announcementIcon: {
    marginRight: 6,
  },
  messageText: {
    fontSize: 15,
    lineHeight: 20,
  },
  reactionsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
    marginHorizontal: 4,
  },
  reaction: {
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 1px 2px rgba(0, 0, 0, 0.1)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.1,
          shadowRadius: 2,
        }),
    elevation: 1,
  },
  inputContainer: {
    padding: 16,
    gap: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
  },
  messageInput: {
    flex: 1,
    backgroundColor: 'transparent',
    paddingHorizontal: 8,
    paddingVertical: 8,
    fontSize: 16,
    maxHeight: 120,
    marginVertical: 4,
  },
  sendButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 2px 3px rgba(0, 0, 0, 0.2)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.2,
          shadowRadius: 3,
        }),
    elevation: 3,
  },
  membersList: {
    flex: 1,
  },
  memberItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    marginBottom: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 12,
  },
  memberAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    marginRight: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  memberInfo: {
    flex: 1,
  },
  memberName: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 2,
  },
  memberRole: {
    fontSize: 12,
    textTransform: 'uppercase',
    opacity: 0.7,
  },
  memberStatus: {
    alignItems: 'flex-end',
  },
  statusIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginBottom: 4,
  },
  lastSeen: {
    fontSize: 11,
    opacity: 0.6,
  },
  filesList: {
    flex: 1,
  },
  fileItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    marginBottom: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 12,
  },
  fileIcon: {
    width: 40,
    height: 40,
    borderRadius: 8,
    marginRight: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fileInfo: {
    flex: 1,
  },
  fileName: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 2,
  },
  fileDetails: {
    fontSize: 12,
    opacity: 0.7,
  },
  uploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 12,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: 'rgba(255, 255, 255, 0.3)',
    marginBottom: 16,
  },
  uploadText: {
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 8,
  },
  reactionEmoji: {
    fontSize: 12,
  },
  reactionCount: {
    fontSize: 10,
    fontWeight: '600',
  },
  memberCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    marginBottom: 12,
    borderRadius: 16,
    borderWidth: 1,
  },
  memberInitials: {
    fontSize: 16,
    fontWeight: '700',
    color: 'white',
  },
  memberDetails: {
    flex: 1,
    marginLeft: 12,
  },
  messageButton: {
    padding: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  messagesContent: {
    paddingBottom: 20,
    paddingTop: 8,
  },
  attachButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 1px 2px rgba(0, 0, 0, 0.1)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.1,
          shadowRadius: 2,
        }),
    elevation: 2,
  },
  membersContent: {
    paddingBottom: 16,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    textAlign: 'center',
    opacity: 0.7,
  },
  replyAuthor: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 2,
  },
  emojiPicker: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 12,
    marginTop: 12,
    borderRadius: 20,
    borderWidth: 1,
    gap: 8,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 2px 4px rgba(0, 0, 0, 0.15)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.15,
          shadowRadius: 4,
        }),
    elevation: 3,
  },
  emojiOption: {
    padding: 10,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 40,
    minHeight: 40,
  },
  emojiText: {
    fontSize: 22,
  },
  replyingToContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 1px 2px rgba(0, 0, 0, 0.1)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.1,
          shadowRadius: 2,
        }),
    elevation: 2,
  },
  replyingToContent: {
    flex: 1,
  },
  replyingToLabel: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  replyingToText: {
    fontSize: 14,
    lineHeight: 18,
  },
  cancelReplyButton: {
    padding: 6,
    borderRadius: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  fileDownloadButton: {
    padding: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  typingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 20,
    gap: 12,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 1px 2px rgba(0, 0, 0, 0.1)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.1,
          shadowRadius: 2,
        }),
    elevation: 2,
  },
  typingDots: {
    flexDirection: 'row',
    gap: 3,
  },
  typingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    opacity: 0.7,
  },
  typingText: {
    fontSize: 13,
    fontStyle: 'italic',
    opacity: 0.8,
  },
  quickActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
    opacity: 0.7,
  },
  quickActionsRight: {
    alignSelf: 'flex-end',
  },
  quickActionButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 1px 1px rgba(0, 0, 0, 0.1)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.1,
          shadowRadius: 1,
        }),
    elevation: 1,
  },
  imageContainer: {
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 4,
  },
  messageImage: {
    borderRadius: 12,
    width: 200,
    height: 150,
    minWidth: 150,
    minHeight: 100,
  },
  messageTextWithImage: {
    marginTop: 8,
  },
  imageButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  textInputContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: '#fff',
    borderRadius: 25,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginRight: 8,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 1px 2px rgba(0, 0, 0, 0.1)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.1,
          shadowRadius: 2,
        }),
    elevation: 2,
  },
  inputIconButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginHorizontal: 4,
  },
  micButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 2px 4px rgba(0, 0, 0, 0.2)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.2,
          shadowRadius: 4,
        }),
    elevation: 4,
  },
  imageViewerContainer: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageViewerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  imageViewerContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  fullScreenImage: {
    width: '100%',
    height: '80%',
    maxWidth: 400,
    maxHeight: 600,
  },
  imageViewerActions: {
    position: 'absolute',
    top: 60,
    right: 20,
    flexDirection: 'row',
    gap: 12,
  },
  imageActionButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 2px 4px rgba(0, 0, 0, 0.3)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.3,
          shadowRadius: 4,
        }),
    elevation: 4,
  },
  messageStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 4,
    gap: 4,
  },
  statusTime: {
    fontSize: 11,
    opacity: 0.8,
  },
  statusIcons: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  doubleCheck: {
    flexDirection: 'row',
    alignItems: 'center',
    position: 'relative',
  },
  checkmark1: {
    position: 'absolute',
    left: 0,
  },
  checkmark2: {
    marginLeft: 6,
  },
  recordingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
    margin: 16,
    borderRadius: 20,
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#fff',
    marginRight: 8,
  },
  recordingText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
  },
  recordingTime: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  voiceMessageContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    minWidth: 200,
  },
  voicePlayButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  voiceWaveform: {
    flex: 1,
    height: 32,
    position: 'relative',
    justifyContent: 'center',
    marginRight: 8,
  },
  voiceProgress: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: '100%',
    borderRadius: 16,
  },
  voiceWaves: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 32,
    paddingHorizontal: 4,
  },
  voiceWave: {
    width: 2,
    borderRadius: 1,
    marginHorizontal: 1,
  },
  voiceDuration: {
    fontSize: 12,
    fontWeight: '500',
  },
  fileMessageContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    minWidth: 200,
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  // Custom Menu Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  customMenu: {
    width: '90%',
    maxWidth: 400,
    borderRadius: 20,
    marginBottom: 40,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 4px 8px rgba(0, 0, 0, 0.3)' }
      : {
          shadowColor: '#000',
          shadowOffset: {
            width: 0,
            height: 4,
          },
          shadowOpacity: 0.3,
          shadowRadius: 8,
        }),
    elevation: 10,
  },
  menuHeader: {
    padding: 24,
    paddingBottom: 16,
    alignItems: 'center',
  },
  menuTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 4,
  },
  menuSubtitle: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  menuOptions: {
    paddingHorizontal: 16,
  },
  menuOption: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    marginBottom: 8,
    borderRadius: 16,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 1px 2px rgba(0, 0, 0, 0.1)' }
      : {
          shadowColor: '#000',
          shadowOffset: {
            width: 0,
            height: 1,
          },
          shadowOpacity: 0.1,
          shadowRadius: 2,
        }),
    elevation: 2,
  },
  menuIconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  menuOptionText: {
    flex: 1,
  },
  menuOptionTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 2,
  },
  menuOptionSubtitle: {
    fontSize: 13,
    lineHeight: 18,
  },
  menuCancelButton: {
    margin: 16,
    marginTop: 8,
    padding: 16,
    borderRadius: 16,
    alignItems: 'center',
  },
  menuCancelText: {
    fontSize: 16,
    fontWeight: '600',
  },
  // Toast Styles
  toast: {
    position: 'absolute',
    bottom: 100,
    left: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 25,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 2px 4px rgba(0, 0, 0, 0.25)' }
      : {
          shadowColor: '#000',
          shadowOffset: {
            width: 0,
            height: 2,
          },
          shadowOpacity: 0.25,
          shadowRadius: 4,
        }),
    elevation: 5,
  },
  toastText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
    marginLeft: 8,
    flex: 1,
  },
});
