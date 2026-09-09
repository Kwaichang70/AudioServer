import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { getRawDb } from '../db/index.js';

/**
 * Login sessions (V02.3).
 *
 * A bearer token is still a JWT, but it now carries a session id (`sid`) and
 * only counts while the matching `sessions` row exists, is not revoked and
 * has not expired. That makes every token revocable: logout, "sign out
 * everywhere", an admin password reset or deleting the account all end the
 * session server-side, and sockets/stream tokens bound to it stop working too.
 */

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;

export interface SessionPrincipal {
  userId: string;
  sessionId: string;
  username: string;
  role: string;
}

export interface SessionSummary {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number | null;
  userAgent: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  user_agent: string | null;
  username: string;
  role: string;
}

interface TokenPayload {
  userId?: unknown;
  sid?: unknown;
}

type RevokeListener = (sessionIds: string[]) => void;
const revokeListeners = new Set<RevokeListener>();

/** Called with the ids of every session that just became invalid. */
export function onSessionsRevoked(listener: RevokeListener): () => void {
  revokeListeners.add(listener);
  return () => revokeListeners.delete(listener);
}

function notifyRevoked(sessionIds: string[]): void {
  if (sessionIds.length === 0) return;
  for (const listener of revokeListeners) {
    try {
      listener(sessionIds);
    } catch {
      // a listener failure must never block the revocation itself
    }
  }
}

export function createSession(
  userId: string,
  userAgent?: string | null,
): { sessionId: string; token: string; expiresAt: number } {
  const sessionId = randomUUID();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  getRawDb()
    .prepare(
      'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(sessionId, userId, now, expiresAt, now, userAgent?.slice(0, 256) ?? null);
  const token = jwt.sign({ userId, sid: sessionId }, config.jwtSecret, {
    expiresIn: Math.floor(SESSION_TTL_MS / 1000),
  });
  return { sessionId, token, expiresAt };
}

/**
 * Sliding renewal (V08.4): a valid session gets a fresh token and a new
 * 30-day horizon, so a phone that opens the app every week never hits the
 * hard expiry. Revoked or expired sessions are not revived.
 */
export function renewSession(
  sessionId: string,
): { sessionId: string; token: string; expiresAt: number } | null {
  const row = loadValidSession(sessionId);
  if (!row) return null;
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  getRawDb()
    .prepare('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?')
    .run(expiresAt, now, sessionId);
  const token = jwt.sign({ userId: row.user_id, sid: sessionId }, config.jwtSecret, {
    expiresIn: Math.floor(SESSION_TTL_MS / 1000),
  });
  return { sessionId, token, expiresAt };
}

function loadValidSession(sessionId: string): SessionRow | null {
  const row = getRawDb()
    .prepare(
      `SELECT s.id, s.user_id, s.created_at, s.expires_at, s.last_seen_at, s.revoked_at, s.user_agent,
              u.username, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
    )
    .get(sessionId) as SessionRow | undefined;
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at <= Date.now()) return null;
  return row;
}

/** Resolve a session by id (no token check). Used for stream tokens. */
export function resolveSessionById(sessionId: string): SessionPrincipal | null {
  const row = loadValidSession(sessionId);
  if (!row) return null;
  return { userId: row.user_id, sessionId: row.id, username: row.username, role: row.role };
}

/**
 * Verify a bearer token and return its principal, or null when the token is
 * malformed, expired, signed for a session that no longer exists, was revoked,
 * or belongs to a deleted user.
 */
export function resolveSessionToken(token: unknown): SessionPrincipal | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  let payload: TokenPayload;
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    if (typeof decoded !== 'object' || decoded === null) return null;
    payload = decoded as TokenPayload;
  } catch {
    return null;
  }
  if (typeof payload.sid !== 'string' || typeof payload.userId !== 'string') return null;
  const row = loadValidSession(payload.sid);
  if (!row || row.user_id !== payload.userId) return null;
  touchSession(row);
  return { userId: row.user_id, sessionId: row.id, username: row.username, role: row.role };
}

function touchSession(row: SessionRow): void {
  const now = Date.now();
  if (row.last_seen_at !== null && now - row.last_seen_at < LAST_SEEN_WRITE_INTERVAL_MS) return;
  try {
    getRawDb().prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, row.id);
  } catch {
    // best effort; a read-only database must not break authentication
  }
}

export function listUserSessions(userId: string): SessionSummary[] {
  const rows = getRawDb()
    .prepare(
      `SELECT id, user_id, created_at, expires_at, last_seen_at, user_agent
         FROM sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY last_seen_at DESC, created_at DESC`,
    )
    .all(userId, Date.now()) as Array<Omit<SessionRow, 'revoked_at' | 'username' | 'role'>>;
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastSeenAt: r.last_seen_at,
    userAgent: r.user_agent,
  }));
}

/** Revoke one session. Returns false when it did not exist or was already revoked. */
export function revokeSession(sessionId: string): boolean {
  const result = getRawDb()
    .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(Date.now(), sessionId);
  if (result.changes > 0) notifyRevoked([sessionId]);
  return result.changes > 0;
}

/** Revoke every active session of a user, optionally keeping one (the caller's). */
export function revokeUserSessions(userId: string, exceptSessionId?: string): number {
  const db = getRawDb();
  const ids = (
    db
      .prepare('SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL')
      .all(userId) as Array<{ id: string }>
  )
    .map((r) => r.id)
    .filter((id) => id !== exceptSessionId);
  if (ids.length === 0) return 0;
  const stmt = db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?');
  const now = Date.now();
  db.transaction(() => {
    for (const id of ids) stmt.run(now, id);
  })();
  notifyRevoked(ids);
  return ids.length;
}

/** Drop rows that can never validate again. Safe to run at startup and periodically. */
export function purgeExpiredSessions(): number {
  const cutoff = Date.now();
  const result = getRawDb()
    .prepare('DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL')
    .run(cutoff);
  return result.changes;
}
