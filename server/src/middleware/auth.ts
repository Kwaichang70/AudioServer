import { type Request, type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config.js';
import { getRawDb } from '../db/index.js';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      requestId?: string;
    }
  }
}

const PUBLIC_PATHS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/me',
  '/api/health',
  '/api/openapi.json',
];

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + '/'));
}

function isSignedStreamPath(path: string): boolean {
  return (
    (path.startsWith('/api/library/tracks/') &&
      (path.endsWith('/stream') || path.endsWith('/cover'))) ||
    (path.startsWith('/api/library/albums/') && path.endsWith('/cover')) ||
    (path.startsWith('/api/library/artists/') && path.endsWith('/image'))
  );
}

interface UserTokenPayload {
  userId?: unknown;
}

export function isFirstRun(): boolean {
  const row = getRawDb().prepare('SELECT COUNT(*) as count FROM users').get() as
    | { count: number }
    | undefined;
  return !row || row.count === 0;
}

export function userExists(userId: unknown): userId is string {
  if (typeof userId !== 'string' || userId.length === 0) return false;
  const row = getRawDb().prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
  return row !== undefined;
}

/** Verify a session JWT and return its user only while that account still exists. */
export function getExistingUserIdFromToken(token: unknown): string | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (typeof payload !== 'object' || payload === null) return null;
    const userId = (payload as UserTokenPayload).userId;
    return userExists(userId) ? userId : null;
  } catch {
    return null;
  }
}

function isAuthorizedStreamUser(userId: string): boolean {
  if (userId === 'first-run') return isFirstRun();
  return userExists(userId);
}

/**
 * Attach req.userId if a valid Bearer token is present. Never fails.
 * Runs on every request so downstream handlers can do role-checks.
 */
export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const userId = getExistingUserIdFromToken(authHeader.slice(7));
    if (userId) req.userId = userId;
  }
  next();
}

/**
 * Require a valid user for any non-public route.
 * First-run (no users in DB) is allowed without auth so the operator can register.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Static assets (the bundled SPA, /assets/*, /sw.js, /manifest.json, /) are
  // served by express.static in production. Auth only applies to /api/* —
  // gating the assets would break the page load entirely (no JS, no CSS).
  if (!req.path.startsWith('/api/')) {
    next();
    return;
  }

  if (isPublicPath(req.path)) {
    next();
    return;
  }

  if (isSignedStreamPath(req.path)) {
    const token = typeof req.query.t === 'string' ? req.query.t : '';
    if (token) {
      const userId = verifyStreamToken(token);
      if (userId && isAuthorizedStreamUser(userId)) {
        req.userId = userId;
        next();
        return;
      }
    }
    // fall through to bearer check for clients that can send headers
  }

  // First-run: no users yet → allow everything so the operator can register.
  if (isFirstRun()) {
    next();
    return;
  }

  if (!req.userId) {
    res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    return;
  }
  next();
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateToken(userId: string): string {
  return jwt.sign({ userId }, config.jwtSecret, { expiresIn: '30d' });
}

// ─── Signed stream tokens ────────────────────────────────────────
//
// HTML5 <audio> / <img> tags cannot send Authorization headers, so streaming
// and cover endpoints accept a short-lived HMAC token in the ?t= query param.
// Token = base64url(`${expiresAt}.${userId}`) + "." + base64url(hmac).
// A token is session-scoped (binds to userId, not to a single resource) so
// the client fetches one token per session and reuses it for every cover/stream.

const STREAM_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

export function signStreamToken(userId: string, ttlMs = STREAM_TOKEN_TTL_MS): string {
  const expiresAt = Date.now() + ttlMs;
  const payload = `${expiresAt}.${userId}`;
  const sig = createHmac('sha256', config.jwtSecret).update(payload).digest();
  return `${b64url(payload)}.${b64url(sig)}`;
}

/**
 * Verify a stream token. Returns the bound userId on success, null otherwise.
 */
export function verifyStreamToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  let payload: string;
  let sig: Buffer;
  try {
    payload = Buffer.from(parts[0], 'base64url').toString('utf8');
    sig = Buffer.from(parts[1], 'base64url');
  } catch {
    return null;
  }
  const dot = payload.indexOf('.');
  if (dot < 0) return null;
  const expiresAt = Number(payload.slice(0, dot));
  const userId = payload.slice(dot + 1);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  if (!userId) return null;
  const expected = createHmac('sha256', config.jwtSecret).update(payload).digest();
  if (expected.length !== sig.length) return null;
  return timingSafeEqual(expected, sig) ? userId : null;
}
