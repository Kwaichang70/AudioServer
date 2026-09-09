import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, getRawDb, initDatabase } from '../db/index.js';

/**
 * Regression for the Synology finding of 9 Sept 2026: a database created
 * before roles existed has `users(id, username, password_hash, created_at)`.
 * The initial migration's CREATE TABLE IF NOT EXISTS keeps that table, so the
 * first registration failed with "table users has no column named role".
 */
describe('legacy users table without role column', () => {
  let dir: string;

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  function createLegacyDb(withUsers: Array<[string, string]>): string {
    dir = mkdtempSync(join(tmpdir(), 'audioserver-legacy-'));
    const path = join(dir, 'legacy.db');
    const sqlite = new Database(path);
    sqlite.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    )`);
    let t = 1000;
    for (const [id, username] of withUsers) {
      sqlite
        .prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(id, username, 'x', t++);
    }
    sqlite.close();
    return path;
  }

  it('adds users.role so the first admin can be registered', async () => {
    const path = createLegacyDb([]);
    await initDatabase(path);
    const cols = (
      getRawDb().prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain('role');
    expect(() =>
      getRawDb()
        .prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)')
        .run('u1', 'admin', 'hash', 'admin'),
    ).not.toThrow();
  });

  it('promotes the oldest existing account to admin when none has a role yet', async () => {
    const path = createLegacyDb([
      ['a', 'first'],
      ['b', 'second'],
    ]);
    await initDatabase(path);
    const rows = getRawDb()
      .prepare('SELECT id, role FROM users ORDER BY created_at')
      .all() as Array<{ id: string; role: string }>;
    expect(rows).toEqual([
      { id: 'a', role: 'admin' },
      { id: 'b', role: 'user' },
    ]);
  });

  it('is idempotent on a database that already has the column', async () => {
    const path = createLegacyDb([]);
    await initDatabase(path);
    closeDatabase();
    await expect(initDatabase(path)).resolves.toBeUndefined();
  });
});
