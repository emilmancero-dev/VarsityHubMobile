// Pure request/response shaping helpers for the teams route, moved out of the
// route file to keep handlers thin (business logic one layer down). These are
// deliberately dependency-free — no prisma, auth, billing, or side effects — so
// they can be unit-reasoned in isolation and reused by any team-facing route.

export type ManagedTeamCursor = {
  orgName: string;
  teamName: string;
  teamId: string;
};

export const encodeManagedTeamCursor = (cursor: ManagedTeamCursor) =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

export const parseManagedTeamCursor = (raw: string): ManagedTeamCursor | null => {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8')
    ) as Partial<ManagedTeamCursor>;
    if (
      typeof parsed.orgName !== 'string' ||
      typeof parsed.teamName !== 'string' ||
      typeof parsed.teamId !== 'string' ||
      parsed.orgName.length === 0 ||
      parsed.teamName.length === 0 ||
      parsed.teamId.length === 0
    ) {
      return null;
    }
    return {
      orgName: parsed.orgName,
      teamName: parsed.teamName,
      teamId: parsed.teamId,
    };
  } catch {
    return null;
  }
};

export function serializeTeamMember(member: any, includeEmail: boolean) {
  const prefs = (member?.user?.preferences || {}) as any;
  return {
    id: member.id,
    role: member.role,
    status: member.status,
    position: member.custom_position || null,
    jersey_number: prefs?.jersey_number || null,
    user: {
      id: member.user_id,
      display_name: member?.user?.display_name || null,
      avatar_url: member?.user?.avatar_url || null,
      username: member?.user?.username || null,
      ...(includeEmail ? { email: member?.user?.email || null } : {}),
    },
  };
}

export function buildTeamCreateOrganizationError(status: number, error: string, message: string) {
  return {
    status,
    body: {
      error,
      message,
      code: error,
    },
  };
}
