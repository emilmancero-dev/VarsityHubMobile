/**
 * Rate Limit Error
 *
 * Thrown when rate limit is exceeded (429 Too Many Requests)
 */

import { AppError, type ErrorMetadata } from './AppError.js';

export class RateLimitError extends AppError {
  constructor(
    message: string = 'Too many requests',
    options?: {
      errorCode?: string;
      metadata?: ErrorMetadata;
      retryAfter?: number; // seconds
    }
  ) {
    const metadata: ErrorMetadata = {
      ...options?.metadata,
      ...(options?.retryAfter && { retryAfter: options.retryAfter }),
    };

    super(429, message, {
      errorCode: options?.errorCode || 'RATE_LIMIT_EXCEEDED',
      publicMetadata: options?.retryAfter ? { retryAfter: options.retryAfter } : undefined,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }
}
