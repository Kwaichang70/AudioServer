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
    }
  }
}

const PUBLIC_PATHS = ['/api/auth/login', '/api/auth/register', '/api/auth/me', '/api/health'];

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

/**
 * Attach req.userId if a valid Bearer token is present. Never fails.
 * Runs on every request so downstream handlers can do role-checks.
 */
export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(authHeader.slice(7), config.jwtSecret) as { userId: string };
      req.userId = payload.userId;
    } catch {
      // ignore invalid token; requireAuth handles rejection
    }
  }
  next();
}

/**
 * Require a valid user for any non-public route.
 * First-run (no users in DB) is allowed without auth so the operator can register.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isPublicPath(req.path)) {
    next();
    return;
  }

  if (isSignedStreamPath(req.path)) {
    const token = typeof req.query.t === 'string' ? req.query.t : '';
    if (token) {
      const userId = verifyStreamToken(token);
      if (userId) {
        req.userId = userId;
        next();
        return;
      }
    }
    // fall through to bearer check for clients that can send headers
  }

  // First-run: no users yet → allow everything so the operator can register.
  const db = getRawDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as
    | { count: number }
    | undefined;
  if (!row || row.count === 0) {
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
