import { describe, expect, it } from 'vitest';
import { generateToken } from '../middleware/auth.js';
import { isValidSocketToken } from '../socketio.js';

describe('Socket.IO auth token validation', () => {
  it('accepts valid JWT tokens', () => {
    expect(isValidSocketToken(generateToken('user-1'))).toBe(true);
  });

  it('rejects missing and invalid tokens', () => {
    expect(isValidSocketToken(undefined)).toBe(false);
    expect(isValidSocketToken('')).toBe(false);
    expect(isValidSocketToken('not-a-real-jwt')).toBe(false);
  });
});
