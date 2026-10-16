import { createHash, randomBytes, randomUUID } from 'crypto';
import { getRawDb } from '../db/index.js';

/**
 * API keys for assistants (step 1 of "Grok and Jarvis control AudioServer").
 *
 * A key belongs to one person and one purpose ("Grok", "Jarvis"). It is
 * shown once when it is made; the server keeps only its SHA-256 hash, so a
 * copy of the database does not hand out working keys. A key can control
 * playback and read the library — never administer, manage accounts or make
 * more keys (see `apiKeyMayUse`) — and it is revoked with one click.
 */

export const API_KEY_PREFIX = 'as_';

export interface ApiKeySummary {
  id: string;
  name: string;
  /** The first characters, so a key can be recognised in the list. */
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface ApiKeyPrincipal {
  keyId: string;
  userId: string;
  role: string;
}

interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
}

const MAX_KEYS_PER_USER = 20;
/** last_used_at is written at most this often per key. */
const LAST_USED_WRITE_MS = 60_000;

const hash = (key: string) => createHash('sha256').update(key).digest('hex');

export function looksLikeApiKey(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(API_KEY_PREFIX) && value.length > 20;
}

export class ApiKeyError extends Error {
  constructor(
    public code: 'too_many' | 'name_required',
    message: string,
  ) {
    super(message);
    this.name = 'ApiKeyError';
  }
}

export function createApiKey(
  userId: string,
  name: string,
): { key: string; summary: ApiKeySummary } {
  const label = name.trim().slice(0, 60);
  if (!label) throw new ApiKeyError('name_required', 'Give the key a name, such as "Grok".');
  const db = getRawDb();
  const count = (
    db
      .prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL')
      .get(userId) as { n: number }
  ).n;
  if (count >= MAX_KEYS_PER_USER) {
    throw new ApiKeyError('too_many', `You have ${count} keys; revoke one you no longer use.`);
  }
  const key = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  const summary: ApiKeySummary = {
    id: randomUUID(),
    name: label,
    prefix: key.slice(0, 10),
    createdAt: Date.now(),
    lastUsedAt: null,
  };
  db.prepare(
    `INSERT INTO api_keys (id, user_id, name, prefix, key_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(summary.id, userId, summary.name, summary.prefix, hash(key), summary.createdAt);
  return { key, summary };
}

export function listApiKeys(userId: string): ApiKeySummary[] {
  return (
    getRawDb()
      .prepare(
        `SELECT id, user_id, name, prefix, created_at, last_used_at FROM api_keys
          WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
      )
      .all(userId) as ApiKeyRow[]
  ).map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

/** Revoke one of your own keys; false when there is no such key. */
export function revokeApiKey(userId: string, keyId: string): boolean {
  const result = getRawDb()
    .prepare(
      'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    )
    .run(Date.now(), keyId, userId);
  return result.changes > 0;
}

/** The person behind a key, or null for an unknown or revoked one. */
export function resolveApiKey(key: unknown): ApiKeyPrincipal | null {
  if (!looksLikeApiKey(key)) return null;
  let row: (ApiKeyRow & { role: string }) | undefined;
  try {
    row = getRawDb()
      .prepare(
        `SELECT k.id, k.user_id, k.name, k.prefix, k.created_at, k.last_used_at, u.role
           FROM api_keys k JOIN users u ON u.id = k.user_id
          WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
      )
      .get(hash(key)) as typeof row;
  } catch {
    return null;
  }
  if (!row) return null;
  const now = Date.now();
  if (row.last_used_at === null || now - row.last_used_at > LAST_USED_WRITE_MS) {
    try {
      getRawDb().prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now, row.id);
    } catch {
      // best effort: a read-only database must not lock an assistant out
    }
  }
  return { keyId: row.id, userId: row.user_id, role: row.role };
}

/**
 * What a key may do: control playback (any method under /api/playback) and
 * read the library, playlists, Home and provider search. Everything else —
 * accounts, sessions, keys, settings, scanning, devices — needs a person
 * signed in. Admin-only routes inside playback are refused by requireAdmin.
 */
export function apiKeyMayUse(method: string, path: string): boolean {
  const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
  if (under('/api/playback')) return true;
  if (under('/api/health')) return true;
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (under('/api/library')) return true;
  if (under('/api/playlists') || under('/api/smart-playlists')) return true;
  if (under('/api/home')) return true;
  if (under('/api/radio')) return true;
  return /^\/api\/providers\/[a-z]+\/search$/.test(path);
}
