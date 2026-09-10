import { getPostVisibilityFilters } from '../lib/privacyUtils.js';
import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { listEventDiscoveryItems } from '../lib/eventDiscovery.js';
import { sendError } from '../lib/http/sendError.js';
import { prisma } from '../lib/prisma.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import type { AuthedRequest } from '../middleware/auth.js';

export const eventDiscoveryRouter = Router();

function parseDateParam(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

eventDiscoveryRouter.get(
  '/',
  asyncHandler(async (req: AuthedRequest, res) => {
    const surfaceRaw = String(req.query.surface ?? 'all')
      .trim()
      .toLowerCase();
    if (!['feed', 'map', 'all'].includes(surfaceRaw)) {
      return sendError(res, 400, 'Invalid surface');
    }

    const scopeRaw = String(req.query.scope ?? 'public')
      .trim()
      .toLowerCase();
    if (!['public', 'following'].includes(scopeRaw)) {
      return sendError(res, 400, 'Invalid scope');
    }

    const typeRaw = req.query.type != null ? String(req.query.type).trim().toLowerCase() : null;
    if (typeRaw && !['game', 'event'].includes(typeRaw)) {
      return sendError(res, 400, 'Invalid type');
    }
    const sportRaw =
      typeof req.query.sport === 'string' && req.query.sport.trim() ? req.query.sport.trim() : null;

    const levelRaw = typeof req.query.level === 'string' ? req.query.level : null;
    if (levelRaw && !['major', 'minor', 'college', 'other'].includes(levelRaw)) {
      return sendError(res, 400, 'Invalid level');
    }
    const from = parseDateParam(req.query.from);
    const to = parseDateParam(req.query.to);
    if (req.query.from && !from) return sendError(res, 400, 'Invalid from');
    if (req.query.to && !to) return sendError(res, 400, 'Invalid to');
    if (from && to && from.getTime() > to.getTime()) {
      return sendError(res, 400, 'from must be before to');
    }

    const limitRaw = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
    const visibility = await getPostVisibilityFilters(req.user?.id ?? null);
    const visiblePostWhere: Prisma.PostWhereInput = {
      deleted_at: null,
      AND: [visibility.authorWhere, visibility.privateTeamWhere].filter(
        (where): where is Prisma.PostWhereInput => where != null
      ),
    };
    const payload = await listEventDiscoveryItems(prisma, {
      visiblePostWhere,
      surface: surfaceRaw as 'feed' | 'map' | 'all',
      scope: scopeRaw as 'public' | 'following',
      sport: sportRaw,
      level: levelRaw as 'major' | 'minor' | 'college' | 'other' | null,
      type: typeRaw ? (typeRaw as 'game' | 'event') : undefined,
      from,
      to,
      limit,
      viewerId: req.user?.id ?? null,
    });
    return res.json(payload);
  })
);
