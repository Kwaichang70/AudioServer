import { type Request, type Response, type NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config.js';
import { getRawDb } from '../db/index.js';
import {
  resolveSessionById,
  resolveSessionToken,
  type SessionPrincipal,
} from '../services/sessions.js';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      sessionId?: string;
      userRole?: string;
      requestId?: string;
    }
  }
}

/**
 * The only routes that answer without a session. Everything else, including
 * the full /api/health diagnostics, needs a valid bearer token, also while
 * the installation still has zero users (setup mode).
 */
const PUBLIC_PATHS = [
  '/api/auth/login',
  '/api/auth/logout', // idempotent: a dead token still gets 200 so clients can always sign out
  '/api/auth/register',
  '/api/auth/setup-status',
  '/api/auth/me',
  '/api/health/live',
  '/api/health/ready',
  '/api/openapi.json',
  '/api/csp-report',
];

/** Principal used for stream URLs the server hands to DLNA/Sonos devices itself. */
export const SYSTEM_USER_ID = 'system';

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

/**
 * Verify a session JWT and return its user only while that session is still
 * valid (not revoked, not expired) and the account still exists.
 */
export function getExistingUserIdFromToken(token: unknown): string | null {
  return resolveSessionToken(token)?.userId ?? null;
}

export function getPrincipalFromToken(token: unknown): SessionPrincipal | null {
  return resolveSessionToken(token);
}

function attachPrincipal(req: Request, principal: SessionPrincipal): void {
  req.userId = principal.userId;
  req.sessionId = principal.sessionId;
  req.userRole = principal.role;
}

/**
 * Attach req.userId / req.sessionId / req.userRole if a valid Bearer token is
 * present. Never fails; requireAuth decides what an anonymous request may do.
 */
export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const principal = resolveSessionToken(authHeader.slice(7));
    if (principal) attachPrincipal(req, principal);
  }
  next();
}

/**
 * Require a valid session for any non-public route. There is no first-run
 * bypass any more: with zero users only the setup routes are reachable, and
 * the first account is created with the setup code (services/setup.ts).
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Static assets (the bundled SPA, /assets/*, /sw.js, /manifest.json, /) are
  // served by express.static in production. Auth only applies to /api/*;
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
      const principal = verifyStreamToken(token);
      if (principal) {
        req.userId = principal.userId;
        req.sessionId = principal.sessionId;
        next();
        return;
      }
    }
    // fall through to bearer check for clients that can send headers
  }

  if (!req.userId) {
    res.status(401).json({
      error: 'Unauthorized',
      message: isFirstRun() ? 'Setup required' : 'Authentication required',
    });
    return;
  }
  next();
}

/**
 * Admin-only routes: global provider connections, token import, scans, user
 * management and other system-wide mutations. See docs/permissions.md.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.userId) {
    res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    return;
  }
  if (req.userRole !== 'admin') {
    res.status(403).json({ error: 'Forbidden', message: 'Admin role required' });
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

// ─── Signed stream tokens ────────────────────────────────────────
//
// HTML5 <audio> / <img> tags cannot send Authorization headers, so streaming
// and cover endpoints accept a short-lived HMAC token in the ?t= query param.
// Token = base64url(`${expiresAt}.${subject}`) + "." + base64url(hmac).
// The subject is either `s:<sessionId>` (a browser session: the token dies
// with the session) or `system` (the server itself, for URLs it hands to
// DLNA/Sonos renderers). A token is session-scoped, not resource-scoped, so
// the client fetches one per session and reuses it for every cover/stream.

const STREAM_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const SYSTEM_STREAM_TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // long enough for a queued album

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function signStreamSubject(subject: string, ttlMs: number): string {
  const expiresAt = Date.now() + ttlMs;
  const payload = `${expiresAt}.${subject}`;
  const sig = createHmac('sha256', config.jwtSecret).update(payload).digest();
  return `${b64url(payload)}.${b64url(sig)}`;
}

/** Stream token for a browser session; invalid as soon as that session is revoked. */
export function signStreamToken(sessionId: string, ttlMs = STREAM_TOKEN_TTL_MS): string {
  return signStreamSubject(`s:${sessionId}`, ttlMs);
}

/** Stream token for URLs the server itself gives to output devices. */
export function signSystemStreamToken(ttlMs = SYSTEM_STREAM_TOKEN_TTL_MS): string {
  return signStreamSubject(SYSTEM_USER_ID, ttlMs);
}

export interface StreamPrincipal {
  userId: string;
  sessionId?: string;
}

/**
 * Verify a stream token. Returns the bound principal on success, null otherwise.
 */
export function verifyStreamToken(token: string): StreamPrincipal | null {
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
  const subject = payload.slice(dot + 1);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  if (!subject) return null;
  const expected = createHmac('sha256', config.jwtSecret).update(payload).digest();
  if (expected.length !== sig.length) return null;
  if (!timingSafeEqual(expected, sig)) return null;

  if (subject === SYSTEM_USER_ID) return { userId: SYSTEM_USER_ID };
  if (subject.startsWith('s:')) {
    const session = resolveSessionById(subject.slice(2));
    return session ? { userId: session.userId, sessionId: session.sessionId } : null;
  }
  return null;
}
