import CustomActionModal from '@/components/CustomActionModal';
import {
  InviteScreenShell,
  inviteScreenSharedStyles as sharedStyles,
} from '@/components/InviteScreenShared';
import { Button } from '@/components/ui/button';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { safeGoBack } from '@/utils/navigation';
import { toUserMessage } from '@/utils/toUserMessage';
import { Organization } from '@/api/entities';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';

type Invite = {
  id: string;
  role?: string;
  organization?: { id: string; name?: string };
};

function OrganizationInvitesScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string; fallback?: string }>();
  const explicitFallback =
    typeof params.fallback === 'string' && params.fallback.trim().startsWith('/')
      ? params.fallback.trim()
      : '/(tabs)/notifications/index';
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [modal, setModal] = useState<null | { title: string; message?: string; options: any[] }>(
    null
  );

  // react-query owns the fetch; the params.id prioritization is a view concern
  // applied via useMemo so the cache key stays param-independent.
  const {
    data,
    isPending,
    isError,
    error: queryError,
    refetch,
  } = useQuery({
    queryKey: ['org-invites'],
    queryFn: () => Organization.myInvites() as Promise<Invite[]>,
  });
  const invites = useMemo(() => {
    const normalized = Array.isArray(data) ? data : [];
    return params.id
      ? [...normalized].sort((a, b) => (a.id === params.id ? -1 : b.id === params.id ? 1 : 0))
      : normalized;
  }, [data, params.id]);
  const loading = isPending;
  const error = isError ? toUserMessage(queryError, 'Unable to load invites') : null;

  const highlightedInviteName = useMemo(
    () => invites.find(invite => invite.id === params.id)?.organization?.name,
    [invites, params.id]
  );

  const accept = async (id: string) => {
    if (processingId) return;
    setProcessingId(id);
    try {
      await Organization.acceptInvite(id);
      await refetch();
      setModal({
        title: 'Invite Accepted',
        message: 'You are now a member of the organization.',
        options: [{ label: 'OK', onPress: () => {}, color: '#2563eb' }],
      });
    } catch (err) {
      setModal({
        title: 'Error',
        message: toUserMessage(err, 'Failed to accept invite'),
        options: [{ label: 'OK', onPress: () => {}, color: '#2563eb' }],
      });
    } finally {
      setProcessingId(null);
    }
  };

  const decline = async (id: string) => {
    if (processingId) return;
    setProcessingId(id);
    try {
      await Organization.declineInvite(id);
      await refetch();
    } catch (err) {
      setModal({
        title: 'Error',
        message: toUserMessage(err, 'Failed to decline invite'),
        options: [{ label: 'OK', onPress: () => {}, color: '#2563eb' }],
      });
    } finally {
      setProcessingId(null);
    }
  };

  return (
    <InviteScreenShell
      title="Organization Invites"
      backgroundColor={Colors[colorScheme].background}
      textColor={Colors[colorScheme].text}
      onBack={() => {
        safeGoBack(router, explicitFallback);
      }}
      subtitle={
        highlightedInviteName ? (
          <Text style={[sharedStyles.subtitle, { color: Colors[colorScheme].mutedText }]}>
            Invitation for {highlightedInviteName}
          </Text>
        ) : null
      }
    >
      {loading ? (
        <View style={sharedStyles.loading}>
          <ActivityIndicator />
        </View>
      ) : null}
      {error && !loading ? <Text style={sharedStyles.error}>{error}</Text> : null}
      {!loading && invites.length === 0 ? (
        <Text style={[sharedStyles.muted, { color: Colors[colorScheme].mutedText }]}>
          No pending invites.
        </Text>
      ) : null}
      {!loading && invites.length > 0 ? (
        <FlatList
          data={invites}
          keyExtractor={item => item.id}
          renderItem={({ item }) => (
            <View
              style={[
                sharedStyles.card,
                {
                  backgroundColor: Colors[colorScheme].card,
                  borderColor:
                    item.id === params.id ? Colors[colorScheme].tint : Colors[colorScheme].border,
                },
              ]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[sharedStyles.name, { color: Colors[colorScheme].text }]}>
                  {item.organization?.name || 'Organization'}
                </Text>
                <Text style={[sharedStyles.muted, { color: Colors[colorScheme].mutedText }]}>
                  Role: {item.role || 'member'}
                </Text>
              </View>
              <View style={sharedStyles.actions}>
                <Button size="sm" onPress={() => accept(item.id)} disabled={!!processingId}>
                  <Text>Accept</Text>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onPress={() => decline(item.id)}
                  disabled={!!processingId}
                >
                  <Text>Decline</Text>
                </Button>
              </View>
            </View>
          )}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        />
      ) : null}
      {modal ? (
        <CustomActionModal
          visible={!!modal}
          title={modal.title}
          message={modal.message}
          options={modal.options}
          onClose={() => setModal(null)}
        />
      ) : null}
    </InviteScreenShell>
  );
}

export default OrganizationInvitesScreen;
