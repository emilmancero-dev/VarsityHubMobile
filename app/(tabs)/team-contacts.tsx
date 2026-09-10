import { launchMediaLibraryAsync, launchMediaCameraAsync } from '@/utils/pickMedia';
import CustomActionModal from '@/components/CustomActionModal';
import CoachAccessRedirecting from '@/components/CoachAccessRedirecting';
import { Colors } from '@/constants/Colors';
import {
  CHAT_VIDEO_MAX_DURATION_S,
  isNativeVideoTrimSupported,
  MAX_PICKED_VIDEO_SIZE_BYTES,
  VIDEO_CAPTURE_PRESET,
} from '@/constants/video';
import { prepareVideoForUpload, uploadTimeoutMsForSize } from '@/utils/compressVideo';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useRequireTeamManagement } from '@/hooks/useRequireTeamManagement';
import { useTeamMembersQuery } from '@/hooks/useTeamMembersQuery';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { materializeICloudAssetIfNeeded } from '@/utils/materializeICloudAsset';
import * as ImagePicker from 'expo-image-picker';
import {
  AudioModule,
  createAudioPlayer,
  requestRecordingPermissionsAsync,
  RecordingPresets,
  setAudioModeAsync,
  type AudioPlayer,
  type AudioStatus,
} from 'expo-audio';
import VideoPlayer from '@/components/VideoPlayer';
import VideoTrimmer from '@/components/VideoTrimmer';
import * as MediaLibrary from 'expo-media-library';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Clipboard,
  FlatList,
  Image,
  InteractionManager,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatFileSize, uploadDocument, uploadImage, UploadResponse } from '@/utils/uploadUtils';
import type { UploadOptions } from '@/api/upload';
import { safeGoBack } from '@/utils/navigation';
import { pickerAllMediaTypesProp, pickerMediaTypesProp } from '@/utils/picker';

// Pre-generated waveform bar heights — avoids Array allocation + Math.random() on every render
const VOICE_WAVE_HEIGHTS = Array.from({ length: 20 }, (_, i) => {
  // Deterministic pseudo-random using a simple hash so heights are stable across renders
  const h = (((i * 7 + 3) * 13) % 20) + 8;
  return h;
});

type TeamVoiceRecorder = InstanceType<typeof AudioModule.AudioRecorder> & {
  timer?: ReturnType<typeof setInterval>;
  startedAt?: number;
};

type TeamVoicePlayer = AudioPlayer & {
  subscription?: { remove?: () => void };
};

interface ChatMessage {
  id: string;
  content: string;
  author: {
    id: string;
    display_name: string;
    username?: string;
    avatar_url?: string;
    role?: string;
  };
  timestamp: string;
  type: 'text' | 'image' | 'file' | 'voice' | 'announcement' | 'game_reminder';
  reactions?: {
    emoji: string;
    count: number;
    users: string[];
  }[];
  replyTo?: string;
  image?: {
    uri: string;
    width: number;
    height: number;
  };
  voice?: {
    uri: string;
    duration: number;
  };
  file?: {
    uri: string;
    name: string;
    size: string;
    type: string;
  };
  status?: 'sending' | 'sent' | 'delivered' | 'read';
}

interface TeamMember {
  id: string;
  user?: {
    id: string;
    display_name?: string;
    email?: string;
    avatar_url?: string;
  };
  role: string;
  status: 'online' | 'offline' | 'away';
  lastSeen?: string;
}

// Maps the raw shared ['team-members'] cache entry to this screen's chat
// shape. Module-level so its identity is stable across renders.
const selectChatMembers = (membersData: any[]): TeamMember[] =>
  membersData.map((m: any) => ({
    id: String(m.id),
    user: m.user
      ? {
          id: String(m.user.id),
          display_name: m.user.username || 'Member',
          email: m.user.email,
          avatar_url: m.user.avatar_url,
        }
      : undefined,
    role: m.role || 'member',
    status: 'offline' as 'online' | 'offline' | 'away',
    lastSeen: undefined,
  }));

const mapMimeTypeToFileType = (mimeType: string): string => {
  const mime = mimeType.toLowerCase();
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('excel') || mime.includes('spreadsheet') || mime.includes('ms-excel'))
    return 'excel';
  if (mime.includes('image')) return 'image';
  if (mime.includes('video')) return 'video';
  return 'document';
};

export default function TeamChatScreen() {
  // Group-chat management mirrors the server's canManageTeam boundary (team
  // staff OR org admin), not the narrower approved-coach-only gate. Aliased to
  // keep the rest of this screen's loading/redirect logic unchanged.
  const { canManage: canAccessCoachTools, loading: coachLoading } = useRequireTeamManagement();
  const { id, fallback } = useLocalSearchParams<{ id?: string; fallback?: string }>();
  const router = useRouter();
  const _insets = useSafeAreaInsets();
  const colorScheme = useColorScheme() ?? 'light';
  const explicitFallback =
    typeof fallback === 'string' && fallback.trim().startsWith('/')
      ? fallback.trim()
      : id
        ? `/my-team?teamId=${encodeURIComponent(String(id))}`
        : '/organization?tab=teams';

  // Modal state for replacing Alert.alert
  const [modal, setModal] = useState<null | { title: string; message?: string; options: any[] }>(
    null
  );

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [selectedTab, setSelectedTab] = useState<'chat' | 'members' | 'files'>('chat');
  const [sending, setSending] = useState(false);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState<string | null>(null);
  const [files, setFiles] = useState<any[]>([]);
  const [typingUsers, _setTypingUsers] = useState<string[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [selectedImage, setSelectedImage] = useState<{
    uri: string;
    width: number;
    height: number;
  } | null>(null);
  const [imageViewerVisible, setImageViewerVisible] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recording, setRecording] = useState<TeamVoiceRecorder | null>(null);
  const [recordingDuration, setRecordingDuration] = useState<number>(0);
  const [playingAudio, setPlayingAudio] = useState<string | null>(null);
  const [audioPosition, setAudioPosition] = useState<{ [key: string]: number }>({});
  const recordingRef = useRef<TeamVoiceRecorder | null>(null);
  const soundObjectsRef = useRef<Record<string, TeamVoicePlayer>>({});

  // Modal states for custom menus
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const [showImageOptionsMenu, setShowImageOptionsMenu] = useState(false);
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  const [videoToTrim, setVideoToTrim] = useState<{
    uri: string;
    name: string;
    size: number;
    /** Picked-asset duration in seconds (ImagePicker reports ms) — drives the chat clip cap. */
    durationS?: number;
  } | null>(null);
  const [videoTrimmedUri, setVideoTrimmedUri] = useState<string | null>(null);
  const canTrimVideo = isNativeVideoTrimSupported(Platform.OS);

  // Toast notification state
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastType, setToastType] = useState<'success' | 'error'>('success');
  const toastAnim = useRef(new Animated.Value(0)).current;

  const flatListRef = useRef<FlatList>(null);
  const typingTimeoutRef = useRef<any>(null);
  const textInputRef = useRef<TextInput>(null);

  // Animated values for typing dots
  const dot1Anim = useRef(new Animated.Value(0.4)).current;
  const dot2Anim = useRef(new Animated.Value(0.4)).current;
  const dot3Anim = useRef(new Animated.Value(0.4)).current;
  const animTimeoutRefs = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Clear animation timeouts on unmount
  useEffect(() => {
    return () => {
      animTimeoutRefs.current.forEach(clearTimeout);
    };
  }, []);

  // Animation refs for messages
  const messageAnimations = useRef<Map<string, Animated.Value>>(new Map()).current;

  // Message persistence functions
  const STORAGE_KEY = `team_messages_${id}`;

  const saveMessages = useCallback(
    async (messages: ChatMessage[]) => {
      try {
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
      } catch (error) {
        if (__DEV__) console.error('Failed to save messages:', error);
      }
    },
    [STORAGE_KEY]
  );

  const loadMessages = useCallback(async (): Promise<ChatMessage[]> => {
    try {
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch (error) {
      if (__DEV__) console.error('Failed to load messages:', error);
      return [];
    }
  }, [STORAGE_KEY]);

  // Helper to show modal dialogs
  const showModal = useCallback((title: string, message?: string, options?: any[]) => {
    setModal({
      title,
      message,
      options: options || [{ label: 'OK', onPress: () => {}, color: '#2563eb' }],
    });
  }, []);

  const saveFiles = useCallback(
    async (filesList: any[]) => {
      try {
        const filesKey = `team-${id}-files`;
        await AsyncStorage.setItem(filesKey, JSON.stringify(filesList));
      } catch (error) {
        if (__DEV__) console.error('Failed to save files:', error);
      }
    },
    [id]
  );

  const addUploadedFile = useCallback(
    ({
      name,
      size,
      mimeType,
      url,
    }: {
      name: string;
      size?: number;
      mimeType?: string;
      url: string;
    }) => {
      const newFile = {
        id: Date.now().toString(),
        name,
        size: formatFileSize(size || 0),
        type: mapMimeTypeToFileType(mimeType || 'application/octet-stream'),
        uploadedBy: 'You',
        uploadedAt: new Date().toISOString(),
        url,
      };

      setFiles(prev => {
        const updated = [newFile, ...prev];
        void saveFiles(updated);
        return updated;
      });
    },
    [saveFiles]
  );

  const loadFiles = useCallback(async (): Promise<any[]> => {
    try {
      const filesKey = `team-${id}-files`;
      const stored = await AsyncStorage.getItem(filesKey);
      return stored ? JSON.parse(stored) : [];
    } catch (error) {
      if (__DEV__) console.error('Failed to load files:', error);
      return [];
    }
  }, [id]);

  // Available emojis for reactions
  const availableEmojis = ['👍', '❤️', '😂', '😮', '😢', '😡', '🔥', '🎉', '👏', '🙏'];

  // Animated typing dots
  const startTypingAnimation = useCallback(() => {
    const animateDot = (animValue: Animated.Value) => {
      Animated.loop(
        Animated.sequence([
          Animated.timing(animValue, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(animValue, {
            toValue: 0.4,
            duration: 600,
            useNativeDriver: true,
          }),
        ]),
        { iterations: -1 }
      ).start();
    };

    // Start animations with staggered delays
    animTimeoutRefs.current.forEach(clearTimeout);
    animTimeoutRefs.current = [
      setTimeout(() => animateDot(dot1Anim), 0),
      setTimeout(() => animateDot(dot2Anim), 200),
      setTimeout(() => animateDot(dot3Anim), 400),
    ];
  }, [dot1Anim, dot2Anim, dot3Anim]);

  const stopTypingAnimation = useCallback(() => {
    dot1Anim.stopAnimation();
    dot2Anim.stopAnimation();
    dot3Anim.stopAnimation();
    dot1Anim.setValue(0.4);
    dot2Anim.setValue(0.4);
    dot3Anim.setValue(0.4);
  }, [dot1Anim, dot2Anim, dot3Anim]);

  // Message animation functions
  const animateNewMessage = useCallback(
    (messageId: string) => {
      const fadeAnim = new Animated.Value(0);
      const scaleAnim = new Animated.Value(0.8);
      messageAnimations.set(messageId, fadeAnim);

      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.spring(scaleAnim, {
          toValue: 1,
          tension: 100,
          friction: 8,
          useNativeDriver: true,
        }),
      ]).start();
    },
    [messageAnimations]
  );

  // Welcome messages shown when a team chat has no history yet
  const welcomeMessages: ChatMessage[] = useMemo(
    () => [
      {
        id: '1',
        content:
          "Great practice today everyone! Don't forget we have the game against Warriors this Saturday at 7 PM.",
        author: {
          id: 'coach1',
          display_name: 'Coach Johnson',
          role: 'Head Coach',
        },
        timestamp: '2025-09-23T10:30:00Z',
        type: 'announcement',
        reactions: [
          { emoji: '👍', count: 8, users: ['1', '2', '3'] },
          { emoji: '🔥', count: 3, users: ['4', '5'] },
        ],
      },
      {
        id: '2',
        content: 'I will be there early to help set up the equipment.',
        author: {
          id: 'player1',
          display_name: 'Alex Wilson',
          role: 'Team Captain',
        },
        timestamp: '2025-09-23T10:35:00Z',
        type: 'text',
        replyTo: '1',
      },
      {
        id: '3',
        content: 'Can someone pick me up? My car is in the shop.',
        author: {
          id: 'player2',
          display_name: 'Sarah Johnson',
          role: 'Player',
        },
        timestamp: '2025-09-23T11:15:00Z',
        type: 'text',
      },
      {
        id: '4',
        content: 'I can give you a ride Sarah! I pass by your area.',
        author: {
          id: 'player3',
          display_name: 'Mike Davis',
          role: 'Player',
        },
        timestamp: '2025-09-23T11:20:00Z',
        type: 'text',
        replyTo: '3',
        reactions: [{ emoji: '🙏', count: 2, users: ['2', '5'] }],
      },
    ],
    []
  );

  // Defer kicking off the first fetch until the push animation finishes so
  // the transition isn't competing with network parsing. Cached revisits are
  // unaffected: a disabled query still renders its cached data instantly.
  const [interactionsDone, setInteractionsDone] = useState(false);
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => setInteractionsDone(true));
    return () => task.cancel();
  }, []);

  const {
    data: membersData,
    isPending: membersPending,
    isError: membersIsError,
    refetch: refetchMembers,
  } = useTeamMembersQuery({
    teamId: id ? String(id) : null,
    enabled: !!id && interactionsDone,
    select: selectChatMembers,
  });
  const members = membersData ?? [];

  // Persisted chat messages/files live in AsyncStorage (local-only state);
  // load them once per team alongside the members query.
  const [localReady, setLocalReady] = useState(false);
  useEffect(() => {
    if (!id || !interactionsDone) return;
    let mounted = true;
    void (async () => {
      // Load persisted messages first, then fallback to welcome messages
      const savedMessages = await loadMessages();
      if (!mounted) return;
      if (savedMessages.length > 0) {
        setMessages(savedMessages);
      } else {
        setMessages(welcomeMessages);
        await saveMessages(welcomeMessages);
      }

      // Load persisted files — added to as uploads complete
      const savedFiles = await loadFiles();
      if (!mounted) return;
      setFiles(savedFiles);
      setLocalReady(true);
    })();
    return () => {
      mounted = false;
    };
  }, [id, interactionsDone, loadFiles, loadMessages, welcomeMessages, saveMessages]);

  // Full-screen spinner until both the roster query and the local chat state
  // are ready (isPending only — background revalidation of cached data never
  // re-shows it). On retry the error card stays up until refetch succeeds.
  const loading = !!id && (membersPending || !localReady);
  const error = !id
    ? 'Missing team id'
    : membersIsError && membersData === undefined
      ? 'Failed to load team chat'
      : null;

  // Start/stop typing animations based on typing users
  useEffect(() => {
    if (typingUsers.length > 0) {
      startTypingAnimation();
    } else {
      stopTypingAnimation();
    }
  }, [typingUsers.length, startTypingAnimation, stopTypingAnimation]);

  const sendMessage = useCallback(async () => {
    if (!newMessage.trim() || sending) return;

    setSending(true);
    try {
      const message: ChatMessage = {
        id: Date.now().toString(),
        content: newMessage.trim(),
        author: {
          id: 'current_user',
          display_name: 'You',
          role: 'Player',
        },
        timestamp: new Date().toISOString(),
        type: 'text',
        replyTo: replyingTo?.id,
        status: 'sending',
      };

      setMessages(prev => {
        const updated = [...prev, message];
        void saveMessages(updated);
        return updated;
      });
      setNewMessage('');
      setReplyingTo(null);

      // Animate new message
      animateNewMessage(message.id);

      // Scroll to bottom
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);

      // Mark as sent (local-only chat, persisted to AsyncStorage)
      setMessages(prev =>
        prev.map(msg => (msg.id === message.id ? { ...msg, status: 'sent' } : msg))
      );
    } catch {
      showModal('Error', 'Failed to send message');
    } finally {
      setSending(false);
    }
  }, [animateNewMessage, newMessage, replyingTo, saveMessages, sending, showModal]);

  const addReaction = useCallback((messageId: string, emoji: string) => {
    setMessages(prev =>
      prev.map(message => {
        if (message.id === messageId) {
          const existingReactions = message.reactions || [];
          const reactionIndex = existingReactions.findIndex(r => r.emoji === emoji);

          if (reactionIndex >= 0) {
            // Toggle reaction if user already reacted
            const reaction = existingReactions[reactionIndex];
            const hasUserReacted = reaction.users.includes('current_user');

            if (hasUserReacted) {
              // Remove user's reaction
              const updatedUsers = reaction.users.filter(id => id !== 'current_user');
              if (updatedUsers.length === 0) {
                // Remove reaction entirely if no users left
                return {
                  ...message,
                  reactions: existingReactions.filter((_, idx) => idx !== reactionIndex),
                };
              } else {
                // Update reaction count
                const updatedReactions = [...existingReactions];
                updatedReactions[reactionIndex] = {
                  ...reaction,
                  count: updatedUsers.length,
                  users: updatedUsers,
                };
                return { ...message, reactions: updatedReactions };
              }
            } else {
              // Add user's reaction
              const updatedReactions = [...existingReactions];
              updatedReactions[reactionIndex] = {
                ...reaction,
                count: reaction.count + 1,
                users: [...reaction.users, 'current_user'],
              };
              return { ...message, reactions: updatedReactions };
            }
          } else {
            // Add new reaction
            return {
              ...message,
              reactions: [...existingReactions, { emoji, count: 1, users: ['current_user'] }],
            };
          }
        }
        return message;
      })
    );
    setShowEmojiPicker(null);
  }, []);

  const replyToMessage = useCallback((message: ChatMessage) => {
    setReplyingTo(message);
    setShowEmojiPicker(null);
    // Focus the text input after a short delay
    setTimeout(() => {
      textInputRef.current?.focus();
    }, 100);
  }, []);

  const cancelReply = useCallback(() => {
    setReplyingTo(null);
  }, []);

  const showToast = useCallback(
    (message: string, type: 'success' | 'error' = 'success') => {
      setToastMessage(message);
      setToastType(type);

      Animated.sequence([
        Animated.timing(toastAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.delay(2000),
        Animated.timing(toastAnim, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start(() => {
        setToastMessage(null);
      });
    },
    [toastAnim]
  );

  const uploadFile = useCallback(async () => {
    setShowAttachmentMenu(true);
  }, []);

  const markMessageSent = useCallback(
    (messageId: string, updatedMessage: ChatMessage) => {
      setMessages(prev => {
        const updated = prev.map(msg => (msg.id === messageId ? updatedMessage : msg));
        void saveMessages(updated);
        return updated;
      });
    },
    [saveMessages]
  );

  const scrollMessagesToEnd = useCallback(() => {
    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, []);

  const getFileIcon = (type: string) => {
    const mimeType = type.toLowerCase();
    if (mimeType.includes('pdf')) return 'document-text';
    if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) return 'grid';
    if (mimeType.includes('word') || mimeType.includes('document')) return 'document';
    if (mimeType.includes('image')) return 'image';
    if (mimeType.includes('video')) return 'videocam';
    if (mimeType.includes('audio')) return 'musical-notes';
    if (mimeType.includes('zip') || mimeType.includes('rar')) return 'archive';
    if (mimeType.includes('text')) return 'document-text';
    return 'document-attach';
  };

  const getFileIconColor = (type: string) => {
    const mimeType = type.toLowerCase();
    if (mimeType.includes('pdf')) return '#F44336';
    if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) return '#4CAF50';
    if (mimeType.includes('word') || mimeType.includes('document')) return '#2196F3';
    if (mimeType.includes('image')) return '#FF9800';
    if (mimeType.includes('video')) return '#9C27B0';
    if (mimeType.includes('audio')) return '#E91E63';
    if (mimeType.includes('zip') || mimeType.includes('rar')) return '#795548';
    if (mimeType.includes('text')) return '#607D8B';
    return '#757575';
  };

  const sendImageMessage = useCallback(
    async (imageAsset: ImagePicker.ImagePickerAsset) => {
      try {
        const message: ChatMessage = {
          id: Date.now().toString(),
          content: 'Uploading image...',
          author: {
            id: 'current_user',
            display_name: 'You',
            role: 'Player',
          },
          timestamp: new Date().toISOString(),
          type: 'image',
          image: {
            uri: imageAsset.uri,
            width: imageAsset.width,
            height: imageAsset.height,
          },
          replyTo: replyingTo?.id,
          status: 'sending',
        };

        setMessages(prev => {
          const updated = [...prev, message];
          void saveMessages(updated);
          return updated;
        });
        setReplyingTo(null);

        // Animate new message
        animateNewMessage(message.id);

        // Upload image to server
        const fileToUpload = {
          uri: imageAsset.uri,
          name: `image_${Date.now()}.jpg`,
          type: 'image/jpeg',
          size: imageAsset.fileSize,
        };

        const uploadResponse = await uploadImage(fileToUpload);

        // Update message with server URL and success status
        const updatedMessage: ChatMessage = {
          ...message,
          content: '',
          image: {
            ...message.image!,
            uri: uploadResponse.url, // Use server URL
          },
          status: 'sent',
        };

        markMessageSent(message.id, updatedMessage);
        scrollMessagesToEnd();

        addUploadedFile({
          name: fileToUpload.name,
          size: fileToUpload.size,
          mimeType: fileToUpload.type,
          url: uploadResponse.url,
        });

        showToast('Image uploaded successfully!');
      } catch (error) {
        if (__DEV__) console.error('Image upload failed:', error);

        // Update message to show error
        setMessages(prev => {
          const updated = prev.map(msg => {
            if (msg.status === 'sending' && msg.type === 'image') {
              return {
                ...msg,
                content: '❌ Failed to upload image',
                status: 'sent' as const,
              };
            }
            return msg;
          });
          void saveMessages(updated);
          return updated;
        });

        showModal('Error', 'Failed to upload image to server');
      }
    },
    [
      addUploadedFile,
      animateNewMessage,
      markMessageSent,
      replyingTo,
      saveMessages,
      scrollMessagesToEnd,
      showModal,
      showToast,
    ]
  );

  const pickImage = useCallback(async () => {
    try {
      const result = await launchMediaLibraryAsync({
        ...pickerMediaTypesProp(),
        allowsEditing: false,
        quality: 1,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        const localUri = await materializeICloudAssetIfNeeded(asset.uri);
        await sendImageMessage({ ...asset, uri: localUri });
      }
    } catch {
      showModal('Error', 'Failed to pick image');
    }
  }, [sendImageMessage, showModal]);

  const takePhoto = useCallback(async () => {
    try {
      const result = await launchMediaCameraAsync({
        allowsEditing: false,
        quality: 1,
      });

      if (!result.canceled && result.assets[0]) {
        await sendImageMessage(result.assets[0]);
      }
    } catch {
      showModal('Error', 'Failed to take photo');
    }
  }, [sendImageMessage, showModal]);

  const showImageOptions = useCallback(() => {
    setShowImageOptionsMenu(true);
  }, []);

  const saveImageToGallery = useCallback(
    async (imageUri: string) => {
      try {
        const { status } = await MediaLibrary.requestPermissionsAsync();
        if (status !== 'granted') {
          showModal(
            'Permission needed',
            'Please grant permission to save images to your gallery.',
            [
              { label: 'Cancel', onPress: () => {} },
              { label: 'Open Settings', onPress: () => Linking.openSettings(), color: '#2563eb' },
            ]
          );
          return;
        }

        await MediaLibrary.saveToLibraryAsync(imageUri);
        showToast('Image saved to gallery!');
      } catch {
        showModal('Error', 'Failed to save image to gallery');
      }
    },
    [showModal, showToast]
  );

  const closeImageViewer = useCallback(() => {
    setImageViewerVisible(false);
    setSelectedImage(null);
  }, []);

  const startRecording = useCallback(async () => {
    if (isRecording) return;
    if (Platform.OS === 'web') {
      showModal('Audio Recording', 'Voice recording is available in the mobile app.');
      return;
    }

    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        showModal(
          'Microphone Permission Needed',
          'Enable microphone access to record voice messages.',
          [
            { label: 'Cancel', onPress: () => {} },
            { label: 'Open Settings', onPress: () => Linking.openSettings(), color: '#2563eb' },
          ]
        );
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
      });

      const voiceRecorder = new AudioModule.AudioRecorder(
        RecordingPresets.HIGH_QUALITY
      ) as TeamVoiceRecorder;
      await voiceRecorder.prepareToRecordAsync();
      voiceRecorder.record();
      voiceRecorder.startedAt = Date.now();
      voiceRecorder.timer = setInterval(() => {
        const status = voiceRecorder.getStatus();
        const elapsedMs =
          typeof status.durationMillis === 'number'
            ? status.durationMillis
            : Date.now() - (voiceRecorder.startedAt || Date.now());
        setRecordingDuration(Math.max(0, Math.floor(elapsedMs / 1000)));
      }, 250);

      recordingRef.current = voiceRecorder;
      setRecording(voiceRecorder);
      setRecordingDuration(0);
      setIsRecording(true);
    } catch (error) {
      if (__DEV__) console.error('Failed to start voice recording:', error);
      showModal('Error', 'Failed to start voice recording');
      setIsRecording(false);
      setRecording(null);
      setRecordingDuration(0);
    }
  }, [isRecording, showModal]);

  const sendVoiceMessage = useCallback(
    async (uri: string, duration: number) => {
      try {
        const message: ChatMessage = {
          id: Date.now().toString(),
          content: '',
          author: {
            id: 'current_user',
            display_name: 'You',
            role: 'Player',
          },
          timestamp: new Date().toISOString(),
          type: 'voice',
          voice: {
            uri,
            duration: Math.max(0, Math.round(duration)),
          },
          replyTo: replyingTo?.id,
          status: 'sending',
        };

        setMessages(prev => {
          const updated = [...prev, message];
          void saveMessages(updated); // Save to storage
          return updated;
        });
        setReplyingTo(null);

        // Animate new message
        animateNewMessage(message.id);

        // Scroll to bottom
        setTimeout(() => {
          flatListRef.current?.scrollToEnd({ animated: true });
        }, 100);

        // Simulate message status progression
        setTimeout(() => {
          setMessages(prev => {
            const updated = prev.map(msg =>
              msg.id === message.id ? { ...msg, status: 'sent' as const } : msg
            );
            void saveMessages(updated);
            return updated;
          });
        }, 800);
      } catch {
        showModal('Error', 'Failed to send voice message');
      }
    },
    [animateNewMessage, replyingTo, saveMessages, showModal]
  );

  const stopRecording = useCallback(async () => {
    if (!recording) return;

    try {
      if (recording.timer) {
        clearInterval(recording.timer);
      }

      setIsRecording(false);
      await recording.stop();
      recordingRef.current = null;
      const uri = recording.uri;

      if (uri) {
        const status = recording.getStatus();
        const elapsedMs =
          typeof status.durationMillis === 'number'
            ? status.durationMillis
            : Date.now() - (recording.startedAt || Date.now());
        await sendVoiceMessage(uri, elapsedMs);
      } else {
        showModal('Error', 'No audio file was created. Please try recording again.');
      }

      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
      }).catch(() => {});
      setRecording(null);
      setRecordingDuration(0);
    } catch (error) {
      if (__DEV__) console.error('Failed to stop voice recording:', error);
      showModal('Error', 'Failed to stop recording');
      setRecording(null);
      recordingRef.current = null;
      setIsRecording(false);
      setRecordingDuration(0);
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
      }).catch(() => {});
    }
  }, [recording, sendVoiceMessage, showModal]);

  // Voice playback functions
  const playVoiceMessage = useCallback(
    async (messageId: string, uri: string) => {
      try {
        // Stop any currently playing audio
        if (playingAudio && playingAudio !== messageId) {
          const currentSound = soundObjectsRef.current[playingAudio];
          if (currentSound) {
            await currentSound.seekTo(0).catch(() => {});
            currentSound.pause();
          }
        }

        // If this message is already playing, pause it
        if (playingAudio === messageId) {
          const sound = soundObjectsRef.current[messageId];
          if (sound) {
            sound.pause();
            setPlayingAudio(null);
          }
          return;
        }

        // Create new sound object if it doesn't exist
        let sound = soundObjectsRef.current[messageId];
        if (!sound) {
          const player = createAudioPlayer({ uri }, { updateInterval: 250 }) as TeamVoicePlayer;
          sound = player;
          soundObjectsRef.current[messageId] = sound;

          sound.subscription = sound.addListener('playbackStatusUpdate', (status: AudioStatus) => {
            if (status.isLoaded && status.duration > 0) {
              setAudioPosition(prev => ({
                ...prev,
                [messageId]: Math.min(1, Math.max(0, status.currentTime / status.duration)),
              }));
            }

            if (status.didJustFinish) {
              setPlayingAudio(null);
              setAudioPosition(prev => ({ ...prev, [messageId]: 0 }));
              sound.seekTo(0).catch(() => {});
            }
          });
        }

        await setAudioModeAsync({
          allowsRecording: false,
          playsInSilentMode: true,
          shouldPlayInBackground: false,
        }).catch(() => {});
        sound.play();
        setPlayingAudio(messageId);
      } catch (error) {
        if (__DEV__) console.error('Failed to play voice message:', error);
        showModal('Error', 'Failed to play voice message');
      }
    },
    [playingAudio, showModal]
  );

  const formatDuration = useCallback((milliseconds: number) => {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }, []);

  const sendFileMessage = useCallback(
    async (fileAsset: any, uploadOptions?: UploadOptions) => {
      try {
        // Create initial message with uploading status
        const message: ChatMessage = {
          id: Date.now().toString(),
          content: `Uploading file: ${fileAsset.name}...`,
          author: {
            id: 'current_user',
            display_name: 'You',
            role: 'Player',
          },
          timestamp: new Date().toISOString(),
          type: 'file',
          file: {
            uri: fileAsset.uri,
            name: fileAsset.name,
            size: formatFileSize(fileAsset.size || 0),
            type: fileAsset.mimeType || 'application/octet-stream',
          },
          replyTo: replyingTo?.id,
          status: 'sending',
        };

        setMessages(prev => {
          const updated = [...prev, message];
          void saveMessages(updated);
          return updated;
        });
        setReplyingTo(null);

        // Animate new message
        animateNewMessage(message.id);

        // Upload file to server
        const fileToUpload = {
          uri: fileAsset.uri,
          name: fileAsset.name,
          type: fileAsset.mimeType,
          size: fileAsset.size,
        };

        let uploadResponse: UploadResponse;

        if (fileAsset.mimeType?.startsWith('image/')) {
          uploadResponse = await uploadImage(fileToUpload, uploadOptions);
        } else {
          uploadResponse = await uploadDocument(fileToUpload, uploadOptions);
        }

        // Update message with server URL and success status
        const updatedMessage: ChatMessage = {
          ...message,
          content: `Shared a file: ${fileAsset.name}`,
          file: {
            ...message.file!,
            uri: uploadResponse.url, // Use server URL
          },
          status: 'sent',
        };

        markMessageSent(message.id, updatedMessage);
        scrollMessagesToEnd();

        addUploadedFile({
          name: fileAsset.name,
          size: fileAsset.size,
          mimeType: fileAsset.mimeType,
          url: uploadResponse.url,
        });

        showToast('File uploaded successfully!');
        return true;
      } catch (error) {
        if (__DEV__) console.error('File upload failed:', error);

        // Update message to show error - use a new variable since message is not in scope
        setMessages(prev => {
          const updated = prev.map(msg => {
            if (
              msg.status === 'sending' &&
              msg.type === 'file' &&
              msg.file?.name === fileAsset.name
            ) {
              return {
                ...msg,
                content: `❌ Failed to upload: ${fileAsset.name}`,
                status: 'sent' as const, // Use valid status
              };
            }
            return msg;
          });
          void saveMessages(updated);
          return updated;
        });

        if ((error as any)?.status === 429) {
          showModal(
            'Too Many Uploads',
            'You have hit the hourly upload limit. Wait a few minutes and try again.'
          );
        } else {
          showModal('Error', 'Failed to upload file to server');
        }
        return false;
      }
    },
    [
      addUploadedFile,
      animateNewMessage,
      markMessageSent,
      replyingTo,
      saveMessages,
      scrollMessagesToEnd,
      showModal,
      showToast,
    ]
  );

  // Document picking functions
  const pickDocument = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets[0]) {
        await sendFileMessage(result.assets[0]);
      }
    } catch {
      showModal('Error', 'Failed to pick document');
    }
  }, [sendFileMessage, showModal]);

  const handleFileUpload = useCallback(
    async (type: 'media' | 'document') => {
      try {
        setIsUploadingFile(true);

        if (type === 'media') {
          // Use image picker for media
          const result = await launchMediaLibraryAsync({
            ...pickerAllMediaTypesProp(),
            allowsEditing: false,
            quality: 1,
            videoExportPreset: VIDEO_CAPTURE_PRESET,
          });

          if (!result.canceled && result.assets[0]) {
            if (result.assets[0].type === 'image') {
              await sendImageMessage(result.assets[0]);
            } else {
              // Pick-time SANITY ceiling, not the 150MB upload cap: this is the
              // pre-compression file, and prepareVideoForUpload re-checks the
              // real MAX_VIDEO_SIZE_BYTES cap on the bytes we actually send. See
              // the MAX_PICKED_VIDEO_SIZE_BYTES rationale in constants/video.ts.
              const pickedSize = result.assets[0].fileSize || 0;
              if (pickedSize > MAX_PICKED_VIDEO_SIZE_BYTES) {
                showToast(
                  `Video is too large (${Math.round(pickedSize / (1024 * 1024))}MB) to process on your phone.`,
                  'error'
                );
                return;
              }
              // Show trim preview for video files
              setVideoToTrim({
                uri: result.assets[0].uri,
                name: `video_${Date.now()}.mp4`,
                size: pickedSize,
                durationS:
                  typeof result.assets[0].duration === 'number'
                    ? result.assets[0].duration / 1000
                    : undefined,
              });
              setVideoTrimmedUri(null);
              return; // Upload happens via confirmVideoSend
            }
          }
        } else {
          // Use document picker for documents
          await pickDocument();
        }
      } catch {
        showToast('Failed to upload file', 'error');
      } finally {
        setIsUploadingFile(false);
      }
    },
    [sendImageMessage, pickDocument, showToast]
  );

  const confirmVideoSend = useCallback(async () => {
    if (!videoToTrim) return;
    // Chat clip cap: an over-limit pick must be trimmed (the trimmer clamps
    // its window to the cap) before it can send. Early return keeps the trim
    // modal open — the finally below would otherwise dismiss it.
    if (
      !videoTrimmedUri &&
      typeof videoToTrim.durationS === 'number' &&
      videoToTrim.durationS > CHAT_VIDEO_MAX_DURATION_S + 0.25
    ) {
      showToast(
        `Videos are limited to ${CHAT_VIDEO_MAX_DURATION_S} seconds — trim the clip before sending.`,
        'error'
      );
      return;
    }
    setIsUploadingFile(true);
    try {
      const prepared = await prepareVideoForUpload(videoTrimmedUri ?? videoToTrim.uri);
      const sent = await sendFileMessage(
        {
          uri: prepared.uri,
          name: videoToTrim.name,
          size: prepared.finalSizeBytes || videoToTrim.size,
          mimeType: 'video/mp4',
        },
        { timeoutMs: uploadTimeoutMsForSize(prepared.finalSizeBytes) }
      );
      if (sent) {
        setVideoToTrim(null);
        setVideoTrimmedUri(null);
      }
    } catch (e: any) {
      showToast(
        e?.status === 429
          ? 'Too many uploads — wait a few minutes and try again.'
          : e?.message || 'Failed to send video',
        'error'
      );
    } finally {
      setIsUploadingFile(false);
    }
  }, [videoToTrim, videoTrimmedUri, sendFileMessage, showToast]);

  const getFileColor = (type: string) => {
    switch (type) {
      case 'pdf':
        return '#EF4444';
      case 'excel':
        return '#10B981';
      case 'image':
        return '#8B5CF6';
      case 'video':
        return '#F59E0B';
      default:
        return '#6B7280';
    }
  };

  const handleTextChange = useCallback(
    (text: string) => {
      setNewMessage(text);

      // Handle typing indicator
      if (!isTyping && text.length > 0) {
        setIsTyping(true);
      }

      // Clear existing timeout
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }

      // Set new timeout
      typingTimeoutRef.current = setTimeout(() => {
        setIsTyping(false);
      }, 1000);
    },
    [isTyping]
  );

  // Cleanup typing timeout
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
    };
  }, []);

  // Cleanup audio players and recorder
  useEffect(() => {
    return () => {
      const activeRecording = recordingRef.current;
      if (activeRecording?.timer) clearInterval(activeRecording.timer);
      if (activeRecording?.isRecording) {
        activeRecording.stop().catch(() => {});
      }
      Object.values(soundObjectsRef.current).forEach(sound => {
        try {
          sound.subscription?.remove?.();
          sound.pause();
          sound.remove();
        } catch {
          // Ignore cleanup errors
        }
      });
      soundObjectsRef.current = {};
    };
  }, []);

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = diff / (1000 * 60 * 60);

    if (hours < 1) {
      const minutes = Math.floor(diff / (1000 * 60));
      return `${minutes}m ago`;
    } else if (hours < 24) {
      return `${Math.floor(hours)}h ago`;
    } else {
      return date.toLocaleDateString();
    }
  };

  const handleFilePress = useCallback(
    async (file: { uri: string; name: string; type: string }) => {
      try {
        // Only allow safe URI schemes
        const uri = file.uri;
        if (!/^(https?:|mailto:|file:)/i.test(uri)) {
          showModal('Invalid File', 'This file cannot be opened for security reasons.');
          return;
        }
        // Try to open the file using the device's default app
        const supported = await Linking.canOpenURL(uri);

        if (supported) {
          await Linking.openURL(uri);
        } else {
          // If can't open directly, show options
          showModal('File Download', 'File download is not supported on this platform.');
        }
      } catch (error) {
        if (__DEV__) console.error('Error opening file:', error);
        showModal('Error', 'Unable to open file');
      }
    },
    [showModal]
  );

  const renderMessage = ({ item, index }: { item: ChatMessage; index: number }) => {
    const isAnnouncement = item.type === 'announcement';
    const isCurrentUser = item.author.id === 'current_user';
    const showAvatar = index === 0 || messages[index - 1].author.id !== item.author.id;
    const replyMessage = item.replyTo ? messages.find(m => m.id === item.replyTo) : null;

    // Get or create animation value for this message
    const messageAnim = messageAnimations.get(item.id) || new Animated.Value(1);
    if (!messageAnimations.has(item.id)) {
      messageAnimations.set(item.id, messageAnim);
    }

    const handleLongPress = () => {
      // Copy to clipboard immediately
      Clipboard.setString(item.content);
      showModal('Copied', 'Message copied to clipboard');
    };

    const handleQuickReaction = () => {
      // Quick reaction with most common emoji
      addReaction(item.id, '👍');
    };

    return (
      <Animated.View
        style={[
          styles.messageContainer,
          isCurrentUser && styles.currentUserMessage,
          isAnnouncement && styles.announcementMessage,
          {
            opacity: messageAnim,
            transform: [{ scale: messageAnim }],
          },
        ]}
      >
        {showAvatar && !isCurrentUser && (
          <View style={[styles.avatar, { backgroundColor: Colors[colorScheme].tint }]}>
            <Text style={styles.avatarText}>
              {(item.author.username || 'M').charAt(0).toUpperCase()}
            </Text>
          </View>
        )}

        <View
          style={[
            styles.messageContent,
            isCurrentUser && styles.currentUserContent,
            isAnnouncement && styles.announcementContent,
            !showAvatar && !isCurrentUser && styles.messageContentWithoutAvatar,
          ]}
        >
          {showAvatar && !isCurrentUser && (
            <View style={styles.messageHeader}>
              <Text style={[styles.authorName, { color: Colors[colorScheme].text }]}>
                {item.author.username ? `@${item.author.username}` : 'Member'}
              </Text>
              <Text style={[styles.authorRole, { color: Colors[colorScheme].mutedText }]}>
                {item.author.role}
              </Text>
              <Text style={[styles.timestamp, { color: Colors[colorScheme].mutedText }]}>
                {formatTime(item.timestamp)}
              </Text>
            </View>
          )}

          {replyMessage && (
            <View style={[styles.replyContainer, { borderColor: Colors[colorScheme].border }]}>
              <Text style={[styles.replyAuthor, { color: Colors[colorScheme].tint }]}>
                {replyMessage.author.username ? `@${replyMessage.author.username}` : 'Member'}
              </Text>
              <Text
                style={[styles.replyText, { color: Colors[colorScheme].mutedText }]}
                numberOfLines={2}
              >
                {replyMessage.content}
              </Text>
            </View>
          )}

          <Pressable
            onPress={handleQuickReaction}
            onLongPress={handleLongPress}
            style={[
              styles.messageBubble,
              {
                backgroundColor: isCurrentUser
                  ? Colors[colorScheme].tint
                  : Colors[colorScheme].surface,
                borderTopLeftRadius: isCurrentUser ? 20 : 6,
                borderTopRightRadius: isCurrentUser ? 6 : 20,
                borderBottomLeftRadius: 20,
                borderBottomRightRadius: 20,
              },
              isAnnouncement && {
                backgroundColor: '#FEF3C7',
                borderTopLeftRadius: 20,
                borderTopRightRadius: 20,
              },
            ]}
          >
            {isAnnouncement && (
              <View style={styles.announcementIcon}>
                <Ionicons name="megaphone" size={16} color="#F59E0B" />
              </View>
            )}

            {item.image && (
              <Pressable
                style={styles.imageContainer}
                onPress={() => {
                  setSelectedImage(item.image!);
                  setImageViewerVisible(true);
                }}
              >
                <Image
                  source={{ uri: optimizeImageUrl(item.image.uri, 600) }}
                  style={styles.messageImage}
                  resizeMode="cover"
                />
              </Pressable>
            )}

            {item.voice && (
              <View
                style={[
                  styles.voiceMessageContainer,
                  {
                    backgroundColor: isCurrentUser
                      ? 'rgba(255,255,255,0.1)'
                      : Colors[colorScheme].background,
                  },
                ]}
              >
                <Pressable
                  style={[
                    styles.voicePlayButton,
                    {
                      backgroundColor: isCurrentUser
                        ? 'rgba(255,255,255,0.2)'
                        : Colors[colorScheme].tint,
                    },
                  ]}
                  onPress={() => playVoiceMessage(item.id, item.voice!.uri)}
                >
                  <Ionicons
                    name={playingAudio === item.id ? 'pause' : 'play'}
                    size={16}
                    color={isCurrentUser ? '#fff' : '#fff'}
                  />
                </Pressable>

                <View style={styles.voiceWaveform}>
                  <View
                    style={[
                      styles.voiceProgress,
                      {
                        width: `${(audioPosition[item.id] || 0) * 100}%`,
                        backgroundColor: isCurrentUser
                          ? 'rgba(255,255,255,0.5)'
                          : Colors[colorScheme].tint + '80',
                      },
                    ]}
                  />
                  <View style={styles.voiceWaves}>
                    {VOICE_WAVE_HEIGHTS.map((h, i) => (
                      <View
                        key={i}
                        style={[
                          styles.voiceWave,
                          {
                            height: h,
                            backgroundColor: isCurrentUser
                              ? 'rgba(255,255,255,0.3)'
                              : Colors[colorScheme].mutedText + '60',
                          },
                        ]}
                      />
                    ))}
                  </View>
                </View>

                <Text
                  style={[
                    styles.voiceDuration,
                    {
                      color: isCurrentUser
                        ? 'rgba(255,255,255,0.8)'
                        : Colors[colorScheme].mutedText,
                    },
                  ]}
                >
                  {formatDuration(
                    item.voice.duration > 0 && item.voice.duration < 1000
                      ? item.voice.duration * 1000
                      : item.voice.duration
                  )}
                </Text>
              </View>
            )}

            {item.file && (
              <Pressable
                style={[
                  styles.fileMessageContainer,
                  {
                    backgroundColor: isCurrentUser
                      ? 'rgba(255,255,255,0.1)'
                      : Colors[colorScheme].background,
                  },
                ]}
                onPress={() => void handleFilePress(item.file!)}
              >
                <View
                  style={[styles.fileIcon, { backgroundColor: getFileIconColor(item.file.type) }]}
                >
                  <Ionicons name={getFileIcon(item.file.type) as any} size={24} color="#fff" />
                </View>
                <View style={styles.fileInfo}>
                  <Text
                    style={[
                      styles.fileName,
                      {
                        color: isCurrentUser ? '#fff' : Colors[colorScheme].text,
                      },
                    ]}
                  >
                    {item.file.name}
                  </Text>
                  <Text
                    style={[
                      styles.fileDetails,
                      {
                        color: isCurrentUser
                          ? 'rgba(255,255,255,0.8)'
                          : Colors[colorScheme].mutedText,
                      },
                    ]}
                  >
                    {item.file.size}
                  </Text>
                </View>
                <Ionicons
                  name="download-outline"
                  size={20}
                  color={isCurrentUser ? 'rgba(255,255,255,0.8)' : Colors[colorScheme].mutedText}
                />
              </Pressable>
            )}

            {item.content ? (
              <Text
                style={[
                  styles.messageText,
                  { color: isCurrentUser ? '#fff' : Colors[colorScheme].text },
                  isAnnouncement && { color: colorScheme === 'dark' ? '#FDE68A' : '#92400E' },
                  item.image && styles.messageTextWithImage,
                ]}
              >
                {item.content}
              </Text>
            ) : null}

            {/* Message Status - only show for current user's messages */}
            {isCurrentUser && item.status && (
              <View style={styles.messageStatus}>
                <Text
                  style={[
                    styles.statusTime,
                    {
                      color: isCurrentUser
                        ? 'rgba(255,255,255,0.7)'
                        : Colors[colorScheme].mutedText,
                    },
                  ]}
                >
                  {formatTime(item.timestamp)}
                </Text>
                <View style={styles.statusIcons}>
                  {item.status === 'sending' && (
                    <Ionicons
                      name="time-outline"
                      size={12}
                      color={
                        isCurrentUser ? 'rgba(255,255,255,0.7)' : Colors[colorScheme].mutedText
                      }
                    />
                  )}
                  {item.status === 'sent' && (
                    <Ionicons
                      name="checkmark"
                      size={12}
                      color={
                        isCurrentUser ? 'rgba(255,255,255,0.7)' : Colors[colorScheme].mutedText
                      }
                    />
                  )}
                  {item.status === 'delivered' && (
                    <View style={styles.doubleCheck}>
                      <Ionicons
                        name="checkmark"
                        size={12}
                        color={
                          isCurrentUser ? 'rgba(255,255,255,0.7)' : Colors[colorScheme].mutedText
                        }
                        style={styles.checkmark1}
                      />
                      <Ionicons
                        name="checkmark"
                        size={12}
                        color={
                          isCurrentUser ? 'rgba(255,255,255,0.7)' : Colors[colorScheme].mutedText
                        }
                        style={styles.checkmark2}
                      />
                    </View>
                  )}
                  {item.status === 'read' && (
                    <View style={styles.doubleCheck}>
                      <Ionicons
                        name="checkmark"
                        size={12}
                        color="#00BFA5"
                        style={styles.checkmark1}
                      />
                      <Ionicons
                        name="checkmark"
                        size={12}
                        color="#00BFA5"
                        style={styles.checkmark2}
                      />
                    </View>
                  )}
                </View>
              </View>
            )}
          </Pressable>

          {item.reactions && item.reactions.length > 0 && (
            <View style={styles.reactionsContainer}>
              {item.reactions.map((reaction, idx) => {
                const hasUserReacted = reaction.users.includes('current_user');
                return (
                  <Pressable
                    key={idx}
                    style={[
                      styles.reaction,
                      {
                        backgroundColor: hasUserReacted
                          ? Colors[colorScheme].tint + '20'
                          : Colors[colorScheme].surface,
                        borderColor: hasUserReacted ? Colors[colorScheme].tint : 'transparent',
                        borderWidth: hasUserReacted ? 1 : 0,
                      },
                    ]}
                    onPress={() => addReaction(item.id, reaction.emoji)}
                  >
                    <Text style={styles.reactionEmoji}>{reaction.emoji}</Text>
                    <Text style={[styles.reactionCount, { color: Colors[colorScheme].text }]}>
                      {reaction.count}
                    </Text>
                  </Pressable>
                );
              })}
              <Pressable
                style={[styles.reaction, { backgroundColor: Colors[colorScheme].surface }]}
                onPress={() => setShowEmojiPicker(item.id)}
              >
                <Text style={styles.reactionEmoji}>+</Text>
              </Pressable>
            </View>
          )}

          {/* Quick Action Buttons */}
          <View style={[styles.quickActions, isCurrentUser && styles.quickActionsRight]}>
            <Pressable
              style={[styles.quickActionButton, { backgroundColor: Colors[colorScheme].surface }]}
              onPress={() => replyToMessage(item)}
            >
              <Ionicons name="arrow-undo-outline" size={14} color={Colors[colorScheme].text} />
            </Pressable>
            <Pressable
              style={[styles.quickActionButton, { backgroundColor: Colors[colorScheme].surface }]}
              onPress={() => setShowEmojiPicker(item.id)}
            >
              <Ionicons name="happy-outline" size={14} color={Colors[colorScheme].text} />
            </Pressable>
          </View>

          {/* Emoji Picker */}
          {showEmojiPicker === item.id && (
            <View
              style={[
                styles.emojiPicker,
                {
                  backgroundColor: Colors[colorScheme].surface,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              {availableEmojis.map(emoji => (
                <Pressable
                  key={emoji}
                  style={styles.emojiOption}
                  onPress={() => addReaction(item.id, emoji)}
                >
                  <Text style={styles.emojiText}>{emoji}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      </Animated.View>
    );
  };

  const renderMember = ({ item }: { item: TeamMember }) => (
    <Pressable
      style={[
        styles.memberCard,
        { backgroundColor: Colors[colorScheme].surface, borderColor: Colors[colorScheme].border },
      ]}
      onPress={() => {
        if (item.user?.id) {
          void router.push(`/user-profile?id=${encodeURIComponent(item.user.id)}`);
        }
      }}
      disabled={!item.user?.id}
      accessibilityRole="button"
      accessibilityLabel={`View ${item.user?.display_name || 'team member'}`}
    >
      <View style={styles.memberInfo}>
        <View style={[styles.memberAvatar, { backgroundColor: Colors[colorScheme].tint }]}>
          <Text style={styles.memberInitials}>
            {(item.user?.display_name || 'M').charAt(0).toUpperCase()}
          </Text>
          <View
            style={[
              styles.statusIndicator,
              { backgroundColor: item.status === 'online' ? '#10B981' : '#6B7280' },
            ]}
          />
        </View>
        <View style={styles.memberDetails}>
          <Text style={[styles.memberName, { color: Colors[colorScheme].text }]}>
            {item.user?.display_name || 'Team Member'}
          </Text>
          <Text style={[styles.memberRole, { color: Colors[colorScheme].mutedText }]}>
            {item.role}
          </Text>
          {item.status === 'offline' && item.lastSeen && (
            <Text style={[styles.lastSeen, { color: Colors[colorScheme].mutedText }]}>
              Last seen {formatTime(item.lastSeen)}
            </Text>
          )}
        </View>
      </View>
      <Pressable
        style={styles.messageButton}
        onPress={() => {
          if (item.user?.id) {
            void router.push({
              pathname: '/message-thread',
              params: {
                with: item.user.id,
                fallback: id
                  ? `/team-contacts?id=${encodeURIComponent(String(id))}`
                  : explicitFallback,
              },
            } as any);
          }
        }}
        disabled={!item.user?.id}
        accessibilityRole="button"
        accessibilityLabel={`Message ${item.user?.display_name || 'team member'}`}
      >
        <Ionicons name="chatbubble-outline" size={20} color={Colors[colorScheme].tint} />
      </Pressable>
    </Pressable>
  );

  const renderTeamChatHeaderLeft = useCallback(
    () => (
      <Pressable onPress={() => safeGoBack(router, explicitFallback)} style={{ paddingRight: 8 }}>
        <Ionicons name="chevron-back" size={28} color={Colors[colorScheme].tint} />
      </Pressable>
    ),
    [colorScheme, explicitFallback, router]
  );

  const renderLoadingState = () => (
    <SafeAreaView
      style={[
        styles.container,
        styles.centerContent,
        { backgroundColor: Colors[colorScheme].background },
      ]}
      edges={['top', 'bottom']}
    >
      <Stack.Screen
        options={{
          title: 'Team Chat',
          headerShown: true,
          headerLeft: renderTeamChatHeaderLeft,
        }}
      />
      <ActivityIndicator size="large" color={Colors[colorScheme].tint} />
      <Text style={[styles.loadingText, { color: Colors[colorScheme].mutedText }]}>
        Loading team chat...
      </Text>
    </SafeAreaView>
  );

  if (coachLoading) {
    return renderLoadingState();
  }

  if (!canAccessCoachTools) {
    return (
      <CoachAccessRedirecting
        backgroundColor={Colors[colorScheme].background}
        spinnerColor={Colors[colorScheme].tint}
        textColor={Colors[colorScheme].mutedText}
      />
    );
  }

  if (loading) {
    return renderLoadingState();
  }

  if (error) {
    return (
      <SafeAreaView
        style={[
          styles.container,
          styles.centerContent,
          { backgroundColor: Colors[colorScheme].background },
        ]}
        edges={['top', 'bottom']}
      >
        <Stack.Screen
          options={{
            title: 'Team Chat',
            headerShown: true,
            headerLeft: renderTeamChatHeaderLeft,
          }}
        />
        <Ionicons name="cloud-offline-outline" size={48} color={Colors[colorScheme].mutedText} />
        <Text style={[styles.errorText, { color: '#EF4444' }]}>{error}</Text>
        <Pressable
          style={{
            marginTop: 16,
            paddingHorizontal: 24,
            paddingVertical: 10,
            backgroundColor: Colors[colorScheme].tint,
            borderRadius: 10,
          }}
          onPress={() => {
            void refetchMembers();
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>Retry</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <Stack.Screen
        options={{
          title: 'Team Chat',
          headerShown: true,
          headerStyle: { backgroundColor: Colors[colorScheme].background },
          headerTintColor: Colors[colorScheme].text,
          headerLeft: renderTeamChatHeaderLeft,
          headerRight: () => (
            <Pressable
              onPress={() =>
                showModal(
                  'Chat Settings',
                  'Chat settings are managed in the VarsityHub web dashboard.'
                )
              }
            >
              <Ionicons name="settings-outline" size={24} color={Colors[colorScheme].text} />
            </Pressable>
          ),
        }}
      />

      {/* Tab Navigation */}
      <View style={styles.tabContainer}>
        {(['chat', 'members', 'files'] as const).map(tab => (
          <Pressable
            key={tab}
            style={[
              styles.tab,
              { backgroundColor: selectedTab === tab ? Colors[colorScheme].tint : 'transparent' },
            ]}
            onPress={() => setSelectedTab(tab)}
          >
            <Text
              style={[
                styles.tabText,
                { color: selectedTab === tab ? '#fff' : Colors[colorScheme].text },
              ]}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </Text>
          </Pressable>
        ))}
      </View>

      {selectedTab === 'chat' && (
        <View style={{ flex: 1 }}>
          <Pressable style={{ flex: 1 }} onPress={Keyboard.dismiss}>
            <FlatList
              ref={flatListRef}
              data={messages}
              keyExtractor={item => item.id}
              renderItem={renderMessage}
              style={styles.messagesList}
              contentContainerStyle={styles.messagesContent}
              showsVerticalScrollIndicator={false}
              onScrollBeginDrag={Keyboard.dismiss}
              ListEmptyComponent={
                <View style={{ alignItems: 'center', paddingTop: 48 }}>
                  <Ionicons
                    name="chatbubbles-outline"
                    size={40}
                    color={Colors[colorScheme].mutedText}
                  />
                  <Text
                    style={{ color: Colors[colorScheme].mutedText, marginTop: 12, fontSize: 15 }}
                  >
                    No messages yet
                  </Text>
                  <Text
                    style={{ color: Colors[colorScheme].mutedText, fontSize: 13, marginTop: 4 }}
                  >
                    Start the conversation below
                  </Text>
                </View>
              }
            />
          </Pressable>

          {/* Typing Indicator */}
          {typingUsers.length > 0 && (
            <View
              style={[styles.typingIndicator, { backgroundColor: Colors[colorScheme].surface }]}
            >
              <View style={styles.typingDots}>
                <Animated.View
                  style={[
                    styles.typingDot,
                    {
                      backgroundColor: Colors[colorScheme].mutedText,
                      opacity: dot1Anim,
                      transform: [{ scale: dot1Anim }],
                    },
                  ]}
                />
                <Animated.View
                  style={[
                    styles.typingDot,
                    {
                      backgroundColor: Colors[colorScheme].mutedText,
                      opacity: dot2Anim,
                      transform: [{ scale: dot2Anim }],
                    },
                  ]}
                />
                <Animated.View
                  style={[
                    styles.typingDot,
                    {
                      backgroundColor: Colors[colorScheme].mutedText,
                      opacity: dot3Anim,
                      transform: [{ scale: dot3Anim }],
                    },
                  ]}
                />
              </View>
              <Text style={[styles.typingText, { color: Colors[colorScheme].mutedText }]}>
                {typingUsers.length === 1
                  ? `${typingUsers[0]} is typing...`
                  : `${typingUsers.length} people are typing...`}
              </Text>
            </View>
          )}

          {/* Recording Indicator */}
          {isRecording && (
            <View style={[styles.recordingIndicator, { backgroundColor: '#EF4444' }]}>
              <View style={styles.recordingDot} />
              <Text style={styles.recordingText}>Recording voice message...</Text>
              <Text style={styles.recordingTime}>
                {Math.floor(recordingDuration / 60)}:
                {(recordingDuration % 60).toString().padStart(2, '0')}
              </Text>
            </View>
          )}

          {/* Message Input */}
          <View
            style={[
              styles.inputContainer,
              {
                backgroundColor: Colors[colorScheme].surface,
                borderColor: Colors[colorScheme].border,
                borderTopWidth: replyingTo ? 0 : 1,
              },
            ]}
          >
            {replyingTo && (
              <View
                style={[
                  styles.replyingToContainer,
                  {
                    backgroundColor: Colors[colorScheme].background,
                    borderColor: Colors[colorScheme].border,
                  },
                ]}
              >
                <View style={styles.replyingToContent}>
                  <Text style={[styles.replyingToLabel, { color: Colors[colorScheme].tint }]}>
                    Replying to{' '}
                    {replyingTo.author.username ? `@${replyingTo.author.username}` : 'Member'}
                  </Text>
                  <Text
                    style={[styles.replyingToText, { color: Colors[colorScheme].mutedText }]}
                    numberOfLines={2}
                  >
                    {replyingTo.content}
                  </Text>
                </View>
                <Pressable style={styles.cancelReplyButton} onPress={cancelReply}>
                  <Ionicons name="close" size={20} color={Colors[colorScheme].mutedText} />
                </Pressable>
              </View>
            )}

            <View style={styles.inputRow}>
              <View
                style={[
                  styles.textInputContainer,
                  { backgroundColor: Colors[colorScheme].background },
                ]}
              >
                <Pressable
                  style={styles.inputIconButton}
                  onPress={() => setShowAttachmentMenu(true)}
                >
                  <Ionicons name="attach" size={20} color={Colors[colorScheme].mutedText} />
                </Pressable>

                <TextInput
                  ref={textInputRef}
                  style={[styles.messageInput, { color: Colors[colorScheme].text }]}
                  value={newMessage}
                  onChangeText={handleTextChange}
                  placeholder={
                    replyingTo
                      ? `Reply to ${replyingTo.author.username ? '@' + replyingTo.author.username : 'member'}...`
                      : 'Type a message...'
                  }
                  placeholderTextColor={Colors[colorScheme].mutedText}
                  multiline
                  maxLength={500}
                  blurOnSubmit={false}
                  returnKeyType="send"
                  onSubmitEditing={sendMessage}
                />

                <Pressable style={styles.inputIconButton} onPress={showImageOptions}>
                  <Ionicons name="camera" size={20} color={Colors[colorScheme].mutedText} />
                </Pressable>
              </View>

              {newMessage.trim() ? (
                <Pressable
                  style={[styles.sendButton, { backgroundColor: Colors[colorScheme].tint }]}
                  onPress={sendMessage}
                  disabled={sending}
                >
                  <Ionicons name={sending ? 'hourglass' : 'send'} size={18} color="#fff" />
                </Pressable>
              ) : (
                <Pressable
                  style={[
                    styles.micButton,
                    {
                      backgroundColor: isRecording ? '#EF4444' : Colors[colorScheme].tint,
                    },
                  ]}
                  onPress={isRecording ? stopRecording : startRecording}
                  onLongPress={!isRecording ? startRecording : undefined}
                >
                  <Ionicons name={isRecording ? 'stop' : 'mic'} size={18} color="#fff" />
                </Pressable>
              )}
            </View>
          </View>
        </View>
      )}

      {selectedTab === 'members' && (
        <FlatList
          data={members}
          keyExtractor={item => item.id}
          renderItem={renderMember}
          style={styles.membersList}
          contentContainerStyle={styles.membersContent}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', paddingTop: 48 }}>
              <Ionicons name="people-outline" size={40} color={Colors[colorScheme].mutedText} />
              <Text style={{ color: Colors[colorScheme].mutedText, marginTop: 12, fontSize: 15 }}>
                No members yet
              </Text>
            </View>
          }
        />
      )}

      {selectedTab === 'files' && (
        <View style={styles.filesList}>
          {/* Upload Button */}
          <Pressable
            style={[styles.uploadButton, { borderColor: Colors[colorScheme].border }]}
            onPress={uploadFile}
          >
            <Ionicons name="cloud-upload-outline" size={24} color={Colors[colorScheme].tint} />
            <Text style={[styles.uploadText, { color: Colors[colorScheme].tint }]}>
              Upload File
            </Text>
          </Pressable>

          {files.length > 0 ? (
            <FlatList
              data={files}
              keyExtractor={item => item.id}
              renderItem={({ item }) => (
                <Pressable
                  style={[
                    styles.fileItem,
                    {
                      backgroundColor: Colors[colorScheme].surface,
                      borderColor: Colors[colorScheme].border,
                    },
                  ]}
                  onPress={() =>
                    void handleFilePress({ uri: item.url, name: item.name, type: item.type })
                  }
                >
                  <View
                    style={[styles.fileIcon, { backgroundColor: getFileColor(item.type) + '20' }]}
                  >
                    <Ionicons
                      name={getFileIcon(item.type) as any}
                      size={24}
                      color={getFileColor(item.type)}
                    />
                  </View>
                  <View style={styles.fileInfo}>
                    <Text style={[styles.fileName, { color: Colors[colorScheme].text }]}>
                      {item.name}
                    </Text>
                    <Text style={[styles.fileDetails, { color: Colors[colorScheme].mutedText }]}>
                      {item.size} • Uploaded by {item.uploadedBy}
                    </Text>
                    <Text style={[styles.fileDetails, { color: Colors[colorScheme].mutedText }]}>
                      {formatTime(item.uploadedAt)}
                    </Text>
                  </View>
                  <Pressable
                    style={styles.fileDownloadButton}
                    onPress={() =>
                      void handleFilePress({ uri: item.url, name: item.name, type: item.type })
                    }
                  >
                    <Ionicons name="download-outline" size={20} color={Colors[colorScheme].tint} />
                  </Pressable>
                </Pressable>
              )}
              showsVerticalScrollIndicator={false}
            />
          ) : (
            <View style={styles.centerContent}>
              <Ionicons name="folder-outline" size={48} color={Colors[colorScheme].mutedText} />
              <Text style={[styles.emptyText, { color: Colors[colorScheme].mutedText }]}>
                No files shared yet
              </Text>
              <Text style={[styles.emptySubtext, { color: Colors[colorScheme].mutedText }]}>
                Upload files to share with your team
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Full Screen Image Viewer */}
      <Modal
        visible={imageViewerVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={closeImageViewer}
      >
        <View style={styles.imageViewerContainer}>
          <Pressable style={styles.imageViewerOverlay} onPress={closeImageViewer} />

          <View style={styles.imageViewerContent}>
            {selectedImage && (
              <Image
                source={{ uri: optimizeImageUrl(selectedImage.uri, 1200) }}
                style={styles.fullScreenImage}
                resizeMode="contain"
              />
            )}

            <View style={styles.imageViewerActions}>
              <Pressable
                style={[styles.imageActionButton, { backgroundColor: Colors[colorScheme].surface }]}
                onPress={closeImageViewer}
              >
                <Ionicons name="close" size={24} color={Colors[colorScheme].text} />
              </Pressable>

              <Pressable
                style={[styles.imageActionButton, { backgroundColor: Colors[colorScheme].surface }]}
                onPress={() => {
                  if (selectedImage) {
                    void saveImageToGallery(selectedImage.uri);
                  }
                }}
              >
                <Ionicons name="download" size={24} color={Colors[colorScheme].text} />
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Video Trim Preview */}
      <Modal
        visible={!!videoToTrim}
        transparent
        animationType="slide"
        onRequestClose={() => {
          setVideoToTrim(null);
          setVideoTrimmedUri(null);
        }}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.9)',
            justifyContent: 'center',
            padding: 16,
          }}
        >
          {videoToTrim && (
            <>
              {/* Trim preview: authoring surface, not a consumption one. */}
              <VideoPlayer
                uri={videoTrimmedUri ?? videoToTrim.uri}
                style={{
                  width: '100%',
                  aspectRatio: 16 / 9,
                  borderRadius: 12,
                  alignSelf: 'center',
                  maxHeight: 300,
                }}
                autoPlay={false}
              />
              {canTrimVideo ? (
                <VideoTrimmer
                  uri={videoToTrim.uri}
                  maxDurationS={CHAT_VIDEO_MAX_DURATION_S}
                  onTrimComplete={u => setVideoTrimmedUri(u)}
                  onTrimReset={() => setVideoTrimmedUri(null)}
                />
              ) : (
                <Text
                  style={{
                    color: '#E5E7EB',
                    textAlign: 'center',
                    marginTop: 12,
                    marginHorizontal: 8,
                  }}
                >
                  Web uploads the selected video as-is. Trimming is available in the iOS and Android
                  app.
                </Text>
              )}
              <View
                style={{ flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 12 }}
              >
                <Pressable
                  onPress={() => {
                    setVideoToTrim(null);
                    setVideoTrimmedUri(null);
                  }}
                  style={{
                    backgroundColor: '#333',
                    paddingHorizontal: 24,
                    paddingVertical: 12,
                    borderRadius: 8,
                  }}
                >
                  <Text style={{ color: '#fff', fontWeight: '600' }}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={confirmVideoSend}
                  disabled={isUploadingFile}
                  style={{
                    backgroundColor: '#4A90D9',
                    paddingHorizontal: 24,
                    paddingVertical: 12,
                    borderRadius: 8,
                    opacity: isUploadingFile ? 0.6 : 1,
                  }}
                >
                  {isUploadingFile ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={{ color: '#fff', fontWeight: '600' }}>Send Video</Text>
                  )}
                </Pressable>
              </View>
            </>
          )}
        </View>
      </Modal>

      {/* Custom Attachment Menu */}
      <Modal
        visible={showAttachmentMenu}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowAttachmentMenu(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setShowAttachmentMenu(false)}>
          <View style={[styles.customMenu, { backgroundColor: Colors[colorScheme].surface }]}>
            <View style={styles.menuHeader}>
              <Text style={[styles.menuTitle, { color: Colors[colorScheme].text }]}>
                Attach File
              </Text>
              <Text style={[styles.menuSubtitle, { color: Colors[colorScheme].mutedText }]}>
                Choose what to attach
              </Text>
            </View>

            <View style={styles.menuOptions}>
              <Pressable
                style={[
                  styles.menuOption,
                  {
                    backgroundColor: Colors[colorScheme].background,
                    opacity: isUploadingFile ? 0.6 : 1,
                  },
                ]}
                onPress={() => {
                  if (!isUploadingFile) {
                    setShowAttachmentMenu(false);
                    void handleFileUpload('media');
                  }
                }}
                disabled={isUploadingFile}
              >
                <View style={[styles.menuIconContainer, { backgroundColor: '#E3F2FD' }]}>
                  {isUploadingFile ? (
                    <Ionicons name="hourglass" size={24} color="#1976D2" />
                  ) : (
                    <Ionicons name="images" size={24} color="#1976D2" />
                  )}
                </View>
                <View style={styles.menuOptionText}>
                  <Text style={[styles.menuOptionTitle, { color: Colors[colorScheme].text }]}>
                    Photo & Video
                  </Text>
                  <Text
                    style={[styles.menuOptionSubtitle, { color: Colors[colorScheme].mutedText }]}
                  >
                    {isUploadingFile ? 'Processing...' : 'Share photos and videos'}
                  </Text>
                </View>
              </Pressable>

              <Pressable
                style={[
                  styles.menuOption,
                  {
                    backgroundColor: Colors[colorScheme].background,
                    opacity: isUploadingFile ? 0.6 : 1,
                  },
                ]}
                onPress={() => {
                  if (!isUploadingFile) {
                    setShowAttachmentMenu(false);
                    void handleFileUpload('document');
                  }
                }}
                disabled={isUploadingFile}
              >
                <View style={[styles.menuIconContainer, { backgroundColor: '#F3E5F5' }]}>
                  {isUploadingFile ? (
                    <Ionicons name="hourglass" size={24} color="#7B1FA2" />
                  ) : (
                    <Ionicons name="document-text" size={24} color="#7B1FA2" />
                  )}
                </View>
                <View style={styles.menuOptionText}>
                  <Text style={[styles.menuOptionTitle, { color: Colors[colorScheme].text }]}>
                    Document
                  </Text>
                  <Text
                    style={[styles.menuOptionSubtitle, { color: Colors[colorScheme].mutedText }]}
                  >
                    {isUploadingFile ? 'Processing...' : 'Share files and documents'}
                  </Text>
                </View>
              </Pressable>
            </View>

            <Pressable
              style={[styles.menuCancelButton, { backgroundColor: Colors[colorScheme].border }]}
              onPress={() => setShowAttachmentMenu(false)}
            >
              <Text style={[styles.menuCancelText, { color: Colors[colorScheme].text }]}>
                Cancel
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Custom Image Options Menu */}
      <Modal
        visible={showImageOptionsMenu}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowImageOptionsMenu(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setShowImageOptionsMenu(false)}>
          <View style={[styles.customMenu, { backgroundColor: Colors[colorScheme].surface }]}>
            <View style={styles.menuHeader}>
              <Text style={[styles.menuTitle, { color: Colors[colorScheme].text }]}>Add Image</Text>
              <Text style={[styles.menuSubtitle, { color: Colors[colorScheme].mutedText }]}>
                Choose how to add your image
              </Text>
            </View>

            <View style={styles.menuOptions}>
              <Pressable
                style={[styles.menuOption, { backgroundColor: Colors[colorScheme].background }]}
                onPress={() => {
                  setShowImageOptionsMenu(false);
                  void takePhoto();
                }}
              >
                <View style={[styles.menuIconContainer, { backgroundColor: '#E8F5E8' }]}>
                  <Ionicons name="camera" size={24} color="#2E7D32" />
                </View>
                <View style={styles.menuOptionText}>
                  <Text style={[styles.menuOptionTitle, { color: Colors[colorScheme].text }]}>
                    Camera
                  </Text>
                  <Text
                    style={[styles.menuOptionSubtitle, { color: Colors[colorScheme].mutedText }]}
                  >
                    Take a new photo
                  </Text>
                </View>
              </Pressable>

              <Pressable
                style={[styles.menuOption, { backgroundColor: Colors[colorScheme].background }]}
                onPress={() => {
                  setShowImageOptionsMenu(false);
                  void pickImage();
                }}
              >
                <View style={[styles.menuIconContainer, { backgroundColor: '#FFF3E0' }]}>
                  <Ionicons name="images" size={24} color="#F57C00" />
                </View>
                <View style={styles.menuOptionText}>
                  <Text style={[styles.menuOptionTitle, { color: Colors[colorScheme].text }]}>
                    Photo Library
                  </Text>
                  <Text
                    style={[styles.menuOptionSubtitle, { color: Colors[colorScheme].mutedText }]}
                  >
                    Choose from gallery
                  </Text>
                </View>
              </Pressable>
            </View>

            <Pressable
              style={[styles.menuCancelButton, { backgroundColor: Colors[colorScheme].border }]}
              onPress={() => setShowImageOptionsMenu(false)}
            >
              <Text style={[styles.menuCancelText, { color: Colors[colorScheme].text }]}>
                Cancel
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Toast Notification */}
      {toastMessage && (
        <Animated.View
          style={[
            styles.toast,
            {
              backgroundColor: toastType === 'success' ? '#4CAF50' : '#F44336',
              opacity: toastAnim,
              transform: [
                {
                  translateY: toastAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [100, 0],
                  }),
                },
              ],
            },
          ]}
        >
          <Ionicons
            name={toastType === 'success' ? 'checkmark-circle' : 'alert-circle'}
            size={20}
            color="#fff"
          />
          <Text style={styles.toastText}>{toastMessage}</Text>
        </Animated.View>
      )}

      {modal && (
        <CustomActionModal
          visible
          title={modal.title}
          message={modal.message}
          options={modal.options}
          onClose={() => setModal(null)}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
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
