import crypto from 'node:crypto';
import type { prisma } from './prisma.js';
export function storyRequestIdentity(
  owner: string,
  entity: string,
  request: Record<string, unknown>
) {
  if (!request.client_request_id) return null;
  return {
    id: `story_${crypto
      .createHash('sha256')
      .update(JSON.stringify([owner, entity, request.client_request_id]))
      .digest('hex')}`,
    hash: crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex'),
  };
}
export async function recoverStoryRequest(
  db: typeof prisma,
  identity: ReturnType<typeof storyRequestIdentity>,
  owner: string
) {
  if (!identity) return null;
  const story = await db.story.findUnique({ where: { id: identity.id } });
  if (story && (story.user_id !== owner || story.client_request_hash !== identity.hash)) {
    throw Object.assign(new Error('This story request was already used with different content'), {
      status: 409,
      code: 'IDEMPOTENCY_CONFLICT',
    });
  }
  return story;
}
