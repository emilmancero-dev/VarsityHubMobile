import { toUserMessage } from '@/utils/toUserMessage';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { materializeICloudAssetIfNeeded } from '@/utils/materializeICloudAsset';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Support } from '@/api/entities';
import { uploadFile } from '@/api/upload';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Colors } from '@/constants/Colors';
import { useAuth } from '@/context/AuthProvider';
import { useColorScheme } from '@/hooks/useColorScheme';
import { getAuthSnapshot } from '@/utils/authState';
import { safeGoBack } from '@/utils/navigation';
import { pickerMediaTypesProp } from '@/utils/picker';

export default function ReportAbuseScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ target_type?: string; target_id?: string }>();
  const colorScheme = useColorScheme() ?? 'light';
  const palette = Colors[colorScheme];
  const { user, checkAuth } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('Report abuse');
  const [details, setDetails] = useState('');
  const [accused, setAccused] = useState('');
  const [evidenceImages, setEvidenceImages] = useState<string[]>([]);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const targetType = typeof params.target_type === 'string' ? params.target_type.trim() : '';
    const targetId = typeof params.target_id === 'string' ? params.target_id.trim() : '';
    if (!targetId) return;
    setAccused(prev => prev || (targetType ? `${targetType}:${targetId}` : targetId));
  }, [params.target_id, params.target_type]);

  useEffect(() => {
    let canceled = false;
    void (async () => {
      try {
        const me: any = await getAuthSnapshot(checkAuth, user);
        if (canceled) return;
        if (typeof me?.display_name === 'string') {
          setName(prev => prev || me.display_name);
        }
        if (typeof me?.email === 'string') {
          setEmail(prev => prev || me.email);
        }
      } catch {
        // Ignore, user can fill fields manually.
      }
    })();
    return () => {
      canceled = true;
    };
  }, [checkAuth, user]);

  const canSubmit = useMemo(() => {
    return Boolean(subject.trim() && details.trim() && email.trim());
  }, [subject, details, email]);

  const pickImage = async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Permission required',
          'Please allow access to your photo library to upload evidence.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ]
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        ...pickerMediaTypesProp(),
        allowsMultipleSelection: true,
        quality: 0.8,
        selectionLimit: 5,
      });

      if (!result.canceled && result.assets.length > 0) {
        setUploadingImage(true);
        const newImages: string[] = [];
        let failedCount = 0;

        for (const asset of result.assets) {
          try {
            const localUri = await materializeICloudAssetIfNeeded(asset.uri);
            const filename = localUri.split('/').pop() || 'evidence.jpg';
            const response = await uploadFile(null, localUri, filename);
            if (response?.url) {
              newImages.push(response.url);
            } else {
              failedCount++;
            }
          } catch (uploadErr) {
            failedCount++;
            if (__DEV__) console.error('Failed to upload image:', uploadErr);
          }
        }

        if (newImages.length > 0) {
          setEvidenceImages(prev => [...prev, ...newImages].slice(0, 5));
          if (failedCount > 0) {
            Alert.alert(
              'Partial upload',
              `${failedCount} image${failedCount > 1 ? 's' : ''} failed to upload. ${newImages.length} uploaded successfully.`
            );
          }
        } else {
          Alert.alert('Upload failed', 'Could not upload the selected images. Please try again.');
        }
        setUploadingImage(false);
      }
    } catch (err) {
      if (__DEV__) console.error('Image picker error:', err);
      setUploadingImage(false);
    }
  };

  const removeImage = (index: number) => {
    setEvidenceImages(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    if (!canSubmit || submitting) {
      Alert.alert('Missing information', 'Please complete the subject, details, and email fields.');
      return;
    }

    setSubmitting(true);
    try {
      const compiledMessage = [
        details.trim(),
        accused.trim() ? `Reported user: ${accused.trim()}` : null,
        evidenceImages.length > 0 ? `Evidence images:\n${evidenceImages.join('\n')}` : null,
      ]
        .filter(Boolean)
        .join('\n\n');

      await Support.contact({
        name: name.trim() || 'VarsityHub user',
        email: email.trim(),
        subject: subject.trim(),
        message: compiledMessage,
      });
      Alert.alert(
        'Report sent',
        'Thank you for letting us know. Our safety team will review your report and follow up if we need more information.'
      );
      setDetails('');
      setAccused('');
      setEvidenceImages([]);
    } catch (err: any) {
      const message = toUserMessage(
        err,
        'We were unable to send your report. Please try again in a moment.'
      );
      Alert.alert('Submission failed', message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: palette.background }]}
      edges={['top', 'bottom']}
    >
      <Stack.Screen
        options={{
          title: 'Report Abuse',
          headerShown: true,
          headerBackTitle: 'Back',
          headerLeft: () => (
            <Pressable
              onPress={() => {
                safeGoBack(router);
              }}
              style={{ paddingRight: 8 }}
            >
              <MaterialIcons name="chevron-left" size={28} color="#007AFF" />
            </Pressable>
          ),
        }}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        keyboardDismissMode="interactive"
        style={styles.flex}
        automaticallyAdjustKeyboardInsets
      >
        <View style={styles.header}>
          <Text style={[styles.title, { color: palette.text }]}>Report Abuse</Text>
          <Text style={[styles.subtitle, { color: palette.mutedText }]}>
            Tell us what happened so we can investigate. Include any usernames, teams, or posts
            involved.
          </Text>
        </View>

        <View
          style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }]}
        >
          <Text style={[styles.label, { color: palette.mutedText }]}>Your name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Optional"
            placeholderTextColor={palette.mutedText}
            style={[
              styles.input,
              {
                color: palette.text,
                borderColor: palette.border,
                backgroundColor: palette.background,
              },
            ]}
            autoCapitalize="words"
            autoComplete="name"
            returnKeyType="next"
          />

          <Text style={[styles.label, { color: palette.mutedText }]}>Email *</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@email.com"
            placeholderTextColor={palette.mutedText}
            style={[
              styles.input,
              {
                color: palette.text,
                borderColor: palette.border,
                backgroundColor: palette.background,
              },
            ]}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
          />

          <Text style={[styles.label, { color: palette.mutedText }]}>Subject *</Text>
          <SegmentedControl
            tabs={['Report abuse', 'Safety concern']}
            selected={subject}
            onChange={setSubject}
            style={{ marginBottom: 16 }}
          />

          <Text style={[styles.label, { color: palette.mutedText }]}>Details *</Text>
          <TextInput
            value={details}
            onChangeText={setDetails}
            placeholder="Describe the situation, including relevant names, dates, or links."
            placeholderTextColor={palette.mutedText}
            style={[
              styles.textArea,
              {
                color: palette.text,
                borderColor: palette.border,
                backgroundColor: palette.background,
              },
            ]}
            multiline
          />

          <Text style={[styles.label, { color: palette.mutedText }]}>
            Who are you reporting? (email or username)
          </Text>
          <TextInput
            value={accused}
            onChangeText={setAccused}
            placeholder="user@example.com or username (optional)"
            placeholderTextColor={palette.mutedText}
            style={[
              styles.input,
              {
                color: palette.text,
                borderColor: palette.border,
                backgroundColor: palette.background,
              },
            ]}
            autoCapitalize="none"
          />

          <Text style={[styles.label, { color: palette.mutedText }]}>
            Upload screenshots (optional)
          </Text>
          <View style={styles.imageGrid}>
            {evidenceImages.map((uri, index) => (
              <View key={uri} style={styles.imageWrapper}>
                <Image source={{ uri }} style={styles.uploadedImage} contentFit="cover" />
                <Pressable
                  style={[
                    styles.removeImageBtn,
                    { backgroundColor: palette.destructive || '#FF3B30' },
                  ]}
                  onPress={() => removeImage(index)}
                >
                  <MaterialIcons name="close" size={14} color="#fff" />
                </Pressable>
              </View>
            ))}
            {evidenceImages.length < 5 && (
              <Pressable
                style={[
                  styles.addImageBtn,
                  { borderColor: palette.border, backgroundColor: palette.background },
                ]}
                onPress={pickImage}
                disabled={uploadingImage}
              >
                {uploadingImage ? (
                  <ActivityIndicator size="small" color={palette.tint} />
                ) : (
                  <>
                    <MaterialIcons name="camera-alt" size={24} color={palette.mutedText} />
                    <Text style={[styles.addImageText, { color: palette.mutedText }]}>Add</Text>
                  </>
                )}
              </Pressable>
            )}
          </View>
          <Text style={[styles.imageHelper, { color: palette.mutedText }]}>
            Up to 5 images. Screenshots help us investigate faster.
          </Text>

          <Text style={[styles.helper, { color: palette.mutedText }]}>
            We keep reports confidential and only use this information to enforce community
            guidelines.
          </Text>

          <Button onPress={handleSubmit} disabled={!canSubmit || submitting}>
            {submitting ? 'Sending...' : 'Submit report'}
          </Button>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingBottom: 32,
    gap: 16,
  },
  header: {
    gap: 8,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
  },
  card: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  input: {
    height: 48,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  textArea: {
    minHeight: 140,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  helper: {
    fontSize: 13,
  },
  imageGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  imageWrapper: {
    position: 'relative',
    width: 80,
    height: 80,
  },
  uploadedImage: {
    width: 80,
    height: 80,
    borderRadius: 10,
  },
  removeImageBtn: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addImageBtn: {
    width: 80,
    height: 80,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  addImageText: {
    fontSize: 12,
    fontWeight: '500',
  },
  imageHelper: {
    fontSize: 12,
    marginTop: -4,
  },
});
