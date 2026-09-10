/**
 * Tests for Error Handling System
 *
 * Tests the AppError classes and error handling middleware
 *
 */

import { describe, expect, it } from '@jest/globals';
import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from '../lib/errors/index.js';

describe('Error Handling System', () => {
  describe('AppError Base Class', () => {
    it('should create error with required fields', () => {
      const error = new AppError(400, 'Test error');

      expect(error.statusCode).toBe(400);
      expect(error.publicMessage).toBe('Test error');
      expect(error.isOperational).toBe(true);
      expect(error.name).toBe('AppError');
    });

    it('should include optional fields', () => {
      const error = new AppError(404, 'Not found', {
        errorCode: 'RESOURCE_NOT_FOUND',
        privateMessage: 'Detailed error message',
        metadata: { resourceId: '123' },
      });

      expect(error.errorCode).toBe('RESOURCE_NOT_FOUND');
      expect(error.privateMessage).toBe('Detailed error message');
      expect(error.metadata?.resourceId).toBe('123');
    });

    it('should convert to JSON correctly', () => {
      const error = new AppError(400, 'Bad request', {
        errorCode: 'VALIDATION_ERROR',
        metadata: { field: 'email' },
      });

      const json = error.toJSON();

      expect(json.error).toBe('Bad request');
      expect(json.errorCode).toBe('VALIDATION_ERROR');
      expect(json.metadata).toBeUndefined();
    });

    it('should get log details correctly', () => {
      const error = new AppError(500, 'Server error', {
        errorCode: 'INTERNAL_ERROR',
        privateMessage: 'Database connection failed',
      });

      const details = error.getLogDetails();

      expect(details.name).toBe('AppError');
      expect(details.statusCode).toBe(500);
      expect(details.errorCode).toBe('INTERNAL_ERROR');
      expect(details.publicMessage).toBe('Server error');
      expect(details.privateMessage).toBe('Database connection failed');
      expect(details.stack).toBeDefined();
    });
  });

  describe('ValidationError', () => {
    it('should create validation error with default code', () => {
      const error = new ValidationError('Invalid input');

      expect(error.statusCode).toBe(400);
      expect(error.errorCode).toBe('VALIDATION_ERROR');
    });

    it('should include validation issues', () => {
      const error = new ValidationError('Invalid input', {
        validationIssues: [
          { path: ['email'], message: 'Invalid email format' },
          { path: ['password'], message: 'Password too short' },
        ],
      });

      expect(error.metadata?.issues).toBeDefined();
      const issues = error.metadata?.issues as Array<{
        path: (string | number)[];
        message: string;
      }>;
      expect(issues).toHaveLength(2);
      expect(issues[0].path).toEqual(['email']);
    });
  });

  describe('AuthenticationError', () => {
    it('should create auth error with default message', () => {
      const error = new AuthenticationError();

      expect(error.statusCode).toBe(401);
      expect(error.publicMessage).toBe('Authentication required');
      expect(error.errorCode).toBe('AUTHENTICATION_REQUIRED');
    });

    it('should allow custom message', () => {
      const error = new AuthenticationError('Invalid token');

      expect(error.statusCode).toBe(401);
      expect(error.publicMessage).toBe('Invalid token');
    });
  });

  describe('AuthorizationError', () => {
    it('should create authorization error', () => {
      const error = new AuthorizationError();

      expect(error.statusCode).toBe(403);
      expect(error.publicMessage).toBe('Insufficient permissions');
      expect(error.errorCode).toBe('INSUFFICIENT_PERMISSIONS');
    });
  });

  describe('NotFoundError', () => {
    it('should create not found error', () => {
      const error = new NotFoundError();

      expect(error.statusCode).toBe(404);
      expect(error.publicMessage).toBe('Resource not found');
      expect(error.errorCode).toBe('NOT_FOUND');
    });

    it('should include resource metadata', () => {
      const error = new NotFoundError('User not found', {
        resourceType: 'User',
        resourceId: '123',
      });

      expect(error.metadata?.resourceType).toBe('User');
      expect(error.metadata?.resourceId).toBe('123');
    });
  });

  describe('ConflictError', () => {
    it('should create conflict error', () => {
      const error = new ConflictError('Email already exists');

      expect(error.statusCode).toBe(409);
      expect(error.publicMessage).toBe('Email already exists');
      expect(error.errorCode).toBe('CONFLICT');
    });
  });

  describe('RateLimitError', () => {
    it('should create rate limit error', () => {
      const error = new RateLimitError();

      expect(error.statusCode).toBe(429);
      expect(error.publicMessage).toBe('Too many requests');
      expect(error.errorCode).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('should include retry after metadata', () => {
      const error = new RateLimitError('Rate limit exceeded', {
        retryAfter: 60,
      });

      expect(error.metadata?.retryAfter).toBe(60);
    });
  });
});

describe('private error metadata', () => {
  it('keeps arbitrary diagnostic metadata out of API responses', () => {
    const error = new AppError(401, 'Authentication failed', {
      metadata: { detail: 'private-value', nested: { token: 'private-value' } },
    });
    expect(JSON.stringify(error.toJSON())).not.toContain('private-value');
    expect(error.getLogDetails().metadata).toEqual(error.metadata);
  });
});
