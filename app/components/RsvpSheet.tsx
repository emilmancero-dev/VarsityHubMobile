import { Colors } from '@/constants/Colors';
import { useMemo } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';

export type RsvpSheetProps = {
  visible: boolean;
  onClose: () => void;
  goingCount?: number;
  capacity?: number | null;
  isGoing?: boolean;
  onToggleRsvp: () => Promise<void> | void;
};

export default function RsvpSheet({
  visible,
  onClose,
  goingCount = 0,
  capacity = null,
  isGoing = false,
  onToggleRsvp,
}: RsvpSheetProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const theme = Colors[colorScheme];
  const remaining = useMemo(
    () => (typeof capacity === 'number' ? Math.max(0, capacity - (goingCount || 0)) : null),
    [capacity, goingCount]
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: theme.background }]}>
          <View style={{ alignItems: 'center', marginBottom: 8 }}>
            <View style={[styles.handle, { backgroundColor: theme.border }]} />
          </View>
          <Text style={[styles.title, { color: theme.text }]}>📺 Watching</Text>
          <Text style={[styles.meta, { color: theme.mutedText }]}>
            Watching: {goingCount}
            {typeof capacity === 'number' ? ` / ${capacity}` : ''}
          </Text>
          {typeof remaining === 'number' && (
            <Text style={[styles.metaMuted, { color: theme.mutedText }]}>
              {remaining} spots remaining
            </Text>
          )}

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
            <Pressable
              style={[styles.primaryBtn, { backgroundColor: theme.tint }]}
              onPress={onToggleRsvp}
            >
              <Text style={styles.primaryBtnText}>{isGoing ? 'Undo' : "I'm Watching"}</Text>
            </Pressable>
            <Pressable style={[styles.outlineBtn, { borderColor: theme.border }]} onPress={onClose}>
              <Text style={[styles.outlineBtnText, { color: theme.text }]}>Close</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16 },
  handle: { width: 44, height: 4, borderRadius: 2 },
  title: { fontSize: 18, fontWeight: '800', marginTop: 4 },
  meta: { marginTop: 6 },
  metaMuted: { color: Colors.light.mutedText },
  primaryBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
  primaryBtnText: { color: 'white', fontWeight: '700' },
  outlineBtn: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10 },
  outlineBtnText: { fontWeight: '700' },
});
