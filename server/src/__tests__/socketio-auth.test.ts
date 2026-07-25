import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getRawDb, initDatabase } from '../db/index.js';
import { generateToken } from '../middleware/auth.js';
import { isValidSocketToken } from '../socketio.js';

describe('Socket.IO auth token validation', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'audioserver-socket-auth-'));
    await initDatabase(join(tmp, 'test.db'));
    getRawDb()
      .prepare(
        "INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'socket-user', 'hash', 'user')",
      )
      .run();
  });

  afterAll(() => {
    getRawDb().close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('accepts JWT tokens for existing users', () => {
    expect(isValidSocketToken(generateToken('user-1'))).toBe(true);
  });

  it('rejects correctly signed JWT tokens for unknown users', () => {
    expect(isValidSocketToken(generateToken('missing-user'))).toBe(false);
  });

  it('rejects a JWT after its user is deleted', () => {
    getRawDb()
      .prepare(
        "INSERT INTO users (id, username, password_hash, role) VALUES ('user-2', 'deleted-socket-user', 'hash', 'user')",
      )
      .run();
    const token = generateToken('user-2');
    expect(isValidSocketToken(token)).toBe(true);

    getRawDb().prepare("DELETE FROM users WHERE id = 'user-2'").run();
    expect(isValidSocketToken(token)).toBe(false);
  });

  it('rejects missing and invalid tokens', () => {
    expect(isValidSocketToken(undefined)).toBe(false);
    expect(isValidSocketToken('')).toBe(false);
    expect(isValidSocketToken('not-a-real-jwt')).toBe(false);
  });
});
