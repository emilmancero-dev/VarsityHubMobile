/**
 * Base Application Error Class
 *
 * All application errors should extend this class to ensure consistent
 * error handling, logging, and response formatting.
 */

export interface ErrorMetadata {
  [key: string]: unknown;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorCode?: string;
  public readonly publicMessage: string;
  public readonly privateMessage?: string;
  public readonly metadata?: ErrorMetadata;
  public readonly publicMetadata?: ErrorMetadata;
  public readonly isOperational: boolean;

  constructor(
    statusCode: number,
    publicMessage: string,
    options?: {
      errorCode?: string;
      privateMessage?: string;
      metadata?: ErrorMetadata;
      /** Explicitly approved response fields; diagnostic metadata stays private. */
      publicMetadata?: ErrorMetadata;
      isOperational?: boolean;
    }
  ) {
    super(publicMessage);

    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
    this.errorCode = options?.errorCode;
    this.privateMessage = options?.privateMessage;
    this.metadata = options?.metadata;
    this.publicMetadata = options?.publicMetadata;
    this.isOperational = options?.isOperational ?? true;

    // Maintains proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }

    this.name = this.constructor.name;
  }

  /**
   * Convert error to JSON for API responses
   */
  toJSON(): {
    error: string;
    code?: string;
    details?: ErrorMetadata;
    errorCode?: string;
    message?: string;
    metadata?: ErrorMetadata;
  } {
    return {
      error: this.publicMessage,
      ...(this.errorCode && { code: this.errorCode, errorCode: this.errorCode }),
      ...(this.publicMetadata &&
        Object.keys(this.publicMetadata).length > 0 && {
          details: this.publicMetadata,
          metadata: this.publicMetadata,
        }),
    };
  }

  /**
   * Get full error details for logging
   */
  getLogDetails(): {
    name: string;
    statusCode: number;
    errorCode?: string;
    publicMessage: string;
    privateMessage?: string;
    metadata?: ErrorMetadata;
    stack?: string;
  } {
    return {
      name: this.name,
      statusCode: this.statusCode,
      errorCode: this.errorCode,
      publicMessage: this.publicMessage,
      privateMessage: this.privateMessage,
      metadata: this.metadata,
      stack: this.stack,
    };
  }
}
