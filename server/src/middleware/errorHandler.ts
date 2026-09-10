/**
 * Centralized Error Handling Middleware
 *
 * Catches all errors and formats consistent responses.
 * Should be added as the last middleware in Express app.
 */

import { ZodError } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import { captureException, getSentryRouteTag } from '../lib/sentry.js';
import { AppError } from '../lib/errors/AppError.js';
import { ValidationError } from '../lib/errors/ValidationError.js';
import { AuthenticationError } from '../lib/errors/AuthenticationError.js';
import { AuthorizationError } from '../lib/errors/AuthorizationError.js';
import { NotFoundError } from '../lib/errors/NotFoundError.js';
import { ConflictError } from '../lib/errors/ConflictError.js';
import { RateLimitError } from '../lib/errors/RateLimitError.js';
import { sendError } from '../lib/http/sendError.js';

/**
 * Error handling middleware
 *
 * Handles:
 * - AppError instances (operational errors)
 * - Zod validation errors
 * - Prisma errors
 * - Unknown errors (500)
 */
export function errorHandler(
  err: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // If response already sent, delegate to default Express error handler
  if (res.headersSent) {
    return next(err);
  }

  // Malformed request URL — e.g. bot probes like /%c0%2eenv with invalid
  // percent-encoding. Express's router throws a URIError from
  // decodeURIComponent while matching the path (before any handler runs), so
  // this never reached app logic and served nothing. It's a client error, not
  // a server fault: respond 400 and do NOT report to Sentry. Without this,
  // every internet scanner hitting the public site produced a bogus 500 +
  // Sentry alert tagged `unknown_error`.
  if (err instanceof URIError) {
    sendError(res, 400, 'Malformed request URL', { code: 'BAD_REQUEST' });
    return;
  }

  // Handle AppError instances
  if (err instanceof AppError) {
    const logDetails = err.getLogDetails();

    // Log operational errors at appropriate level
    if (err.statusCode >= 500) {
      console.error('[AppError]', logDetails);
      // Capture server errors in Sentry
      captureException(err, {
        context: 'app_error',
        extra: logDetails,
        tags: {
          errorCode: err.errorCode,
          statusCode: String(err.statusCode),
        },
      });
    } else if (err.statusCode >= 400) {
      // Log client errors at warn level (not errors)
      console.warn('[AppError]', logDetails);
    }

    // Send error response
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  // Handle Zod validation errors (from safeParse)
  if (err instanceof ZodError) {
    const zodError = err as any;
    const validationError = new ValidationError('Invalid input', {
      validationIssues: zodError.issues.map((issue: any) => ({
        path: issue.path,
        message: issue.message,
      })),
    });

    console.warn('[ValidationError]', validationError.getLogDetails());
    res.status(400).json(validationError.toJSON());
    return;
  }

  // Handle Prisma errors
  if (err.name === 'PrismaClientKnownRequestError') {
    const prismaError = err as any;

    // Unique constraint violation (do not leak schema/column names to client)
    if (prismaError.code === 'P2002') {
      console.warn('[ConflictError] P2002', { target: prismaError.meta?.target, path: req.path });
      const conflictError = new ConflictError('Resource already exists');
      res.status(409).json(conflictError.toJSON());
      return;
    }

    // Record not found
    if (prismaError.code === 'P2025') {
      const notFoundError = new NotFoundError('Resource not found');
      console.warn('[NotFoundError]', notFoundError.getLogDetails());
      res.status(404).json(notFoundError.toJSON());
      return;
    }

    // Foreign key constraint violation (do not leak schema/field names to client)
    if (prismaError.code === 'P2003') {
      console.warn('[ValidationError] P2003', {
        field: prismaError.meta?.field_name,
        path: req.path,
      });
      const validationError = new ValidationError('Invalid reference');
      res.status(400).json(validationError.toJSON());
      return;
    }
  }

  // Handle unknown errors (500)
  console.error('[Unknown Error]', {
    name: err.name,
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  // Capture in Sentry
  const provider = typeof (err as any)?.provider === 'string' ? (err as any).provider : undefined;
  captureException(err, {
    context: 'unknown_error',
    provider,
    route: getSentryRouteTag(req),
    extra: {
      path: req.path,
      method: req.method,
    },
  });

  // Send generic error response (don't leak internal details)
  sendError(res, 500, 'Internal server error', {
    code: 'INTERNAL_SERVER_ERROR',
  });
}

/**
 * Async error wrapper
 *
 * Wraps async route handlers to catch errors and pass to error handler.
 * Usage: router.get('/path', asyncHandler(async (req, res) => { ... }))
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void | Response>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
