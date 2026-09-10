/**
 * Validation Error
 *
 * Thrown when input validation fails (400 Bad Request)
 */

import { AppError, type ErrorMetadata } from './AppError.js';

export class ValidationError extends AppError {
  constructor(
    message: string,
    options?: {
      errorCode?: string;
      metadata?: ErrorMetadata;
      validationIssues?: Array<{ path: (string | number)[]; message: string }>;
    }
  ) {
    const metadata: ErrorMetadata = {
      ...options?.metadata,
      ...(options?.validationIssues && { issues: options.validationIssues }),
    };

    super(400, message, {
      errorCode: options?.errorCode || 'VALIDATION_ERROR',
      publicMetadata: options?.validationIssues ? { issues: options.validationIssues } : undefined,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }
}
