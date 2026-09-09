import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { getRawDb } from '../db/index.js';
import { hashPassword, verifyPassword, signStreamToken, requireAdmin } from '../middleware/auth.js';
import { loginLimiter, registerLimiter } from '../middleware/rateLimiter.js';
import { logger } from '../logger.js';
import { saveTokens } from '../services/tokenstore.js';
import {
  createSession,
  listUserSessions,
  renewSession,
  revokeSession,
  revokeUserSessions,
} from '../services/sessions.js';
import {
  clearSetupCode,
  isSetupRequired,
  setupCodeSource,
  verifySetupCode,
} from '../services/setup.js';
import { validate, idParam } from '../utils/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const usernameSchema = z.string().trim().min(1).max(64);
const passwordSchema = z.string().min(8).max(256);

const credentialsSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});

const setupSchema = credentialsSchema.extend({
  setupCode: z.string().trim().min(1).max(64),
});

const createUserSchema = credentialsSchema.extend({
  role: z.enum(['admin', 'user']).optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});

const resetPasswordSchema = z.object({
  password: passwordSchema,
});

const importTokenSchema = z.object({
  provider: z.string().min(1).max(32),
  accessToken: z.string().min(1).max(8192),
  refreshToken: z.string().min(1).max(8192),
  expiresAt: z.number().int().nonnegative().optional(),
});

export const authRouter = Router();

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
}

function userAgentOf(req: { headers: { 'user-agent'?: string } }): string | null {
  return req.headers['user-agent'] ?? null;
}

// ─── Setup (zero users) ─────────────────────────────────────────

// Public: tells the SPA whether to show the setup screen or the login screen.
// Deliberately says nothing about the code itself.
authRouter.get('/setup-status', (_req, res) => {
  const needsSetup = isSetupRequired();
  res.json({
    data: {
      needsSetup,
      ...(needsSetup ? { setupCodeSource: setupCodeSource() } : {}),
    },
  });
});

// Register creates the first (admin) account and nothing else. It needs the
// one-time setup code from the server log / setup-code.txt / SETUP_CODE, so
// two visitors of a fresh install cannot race for the admin account.
authRouter.post(
  '/register',
  registerLimiter,
  validate({ body: setupSchema }),
  asyncHandler(async (req, res) => {
    const { username, password, setupCode } = req.body;
    if (!isSetupRequired()) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Setup is complete. Admins create further users in Settings.',
      });
      return;
    }
    if (!verifySetupCode(setupCode)) {
      logger.warn('Setup: registration attempt with an invalid setup code');
      res.status(403).json({ error: 'Forbidden', message: 'Invalid setup code' });
      return;
    }

    const db = getRawDb();
    const id = uuid();
    const passwordHash = await hashPassword(password);
    const role = 'admin';
    const registerFirstUser = db.transaction(() => {
      const current = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
      if (current.count !== 0) return false;
      db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(
        id,
        username,
        passwordHash,
        role,
      );
      return true;
    });
    const registered = registerFirstUser.immediate();

    if (!registered) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Setup is complete. Admins create further users in Settings.',
      });
      return;
    }

    clearSetupCode();
    const session = createSession(id, userAgentOf(req));
    logger.info(`Setup complete: admin account "${username}" created`);
    res.json({
      data: { token: session.token, expiresAt: session.expiresAt, user: { id, username, role } },
    });
  }),
);

// ─── Session ────────────────────────────────────────────────────

authRouter.post(
  '/login',
  loginLimiter,
  validate({ body: credentialsSchema }),
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    const db = getRawDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      | UserRow
      | undefined;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid credentials' });
      return;
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid credentials' });
      return;
    }

    const session = createSession(user.id, userAgentOf(req));
    res.json({
      data: {
        token: session.token,
        expiresAt: session.expiresAt,
        user: { id: user.id, username: user.username, role: user.role },
      },
    });
  }),
);

// End the current session. Idempotent: an already-dead token gets 200 too,
// so a client can always "sign out" without first checking its state.
authRouter.post('/logout', (req, res) => {
  if (req.sessionId) revokeSession(req.sessionId);
  res.json({ data: { ok: true } });
});

// Current principal. Public: answers null instead of 401 so the SPA can use
// it as its single "am I signed in?" check without triggering error toasts.
authRouter.get('/me', (req, res) => {
  if (!req.userId || !req.sessionId) {
    res.json({ data: null });
    return;
  }
  const db = getRawDb();
  const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(req.userId) as
    | { id: string; username: string; role: string }
    | undefined;
  res.json({ data: user ? { ...user, sessionId: req.sessionId } : null });
});

// Sliding renewal (V08.4): the client calls this when its token nears expiry.
authRouter.post('/refresh', (req, res) => {
  if (!req.sessionId) {
    res.status(401).json({ error: 'Unauthorized', message: 'No session to renew' });
    return;
  }
  const renewed = renewSession(req.sessionId);
  if (!renewed) {
    res.status(401).json({ error: 'Unauthorized', message: 'Session is no longer valid' });
    return;
  }
  res.json({ data: { token: renewed.token, expiresAt: renewed.expiresAt } });
});

authRouter.get('/sessions', (req, res) => {
  const sessions = listUserSessions(req.userId!).map((s) => ({
    ...s,
    current: s.id === req.sessionId,
  }));
  res.json({ data: sessions });
});

authRouter.delete('/sessions/:id', validate({ params: idParam }), (req, res) => {
  const id = String(req.params.id);
  const own = listUserSessions(req.userId!).some((s) => s.id === id);
  if (!own) {
    res.status(404).json({ error: 'NotFound', message: 'Session not found' });
    return;
  }
  revokeSession(id);
  res.json({ data: { ok: true, current: id === req.sessionId } });
});

// "Sign out everywhere else": keeps the caller's own session.
authRouter.post('/sessions/revoke-others', (req, res) => {
  const revoked = revokeUserSessions(req.userId!, req.sessionId);
  res.json({ data: { revoked } });
});

// Change own password; other sessions are ended, the current one stays.
authRouter.post(
  '/password',
  validate({ body: changePasswordSchema }),
  asyncHandler(async (req, res) => {
    const db = getRawDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId) as
      | UserRow
      | undefined;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
      return;
    }
    const valid = await verifyPassword(req.body.currentPassword, user.password_hash);
    if (!valid) {
      res.status(403).json({ error: 'Forbidden', message: 'Current password is incorrect' });
      return;
    }
    const passwordHash = await hashPassword(req.body.newPassword);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
    const revoked = revokeUserSessions(user.id, req.sessionId);
    logger.info(`Password changed for "${user.username}" (${revoked} other session(s) ended)`);
    res.json({ data: { ok: true, revokedSessions: revoked } });
  }),
);

// Issue a session-scoped stream token (1h TTL, dies with the session).
// Used by <img src> / <audio src> tags that cannot set an Authorization header.
authRouter.get('/stream-token', (req, res) => {
  if (!req.sessionId) {
    res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    return;
  }
  res.json({ data: { token: signStreamToken(req.sessionId), expiresIn: 3600 } });
});

// ─── User Management (Admin only) ───────────────────────────────

authRouter.get('/users', requireAdmin, (_req, res) => {
  const db = getRawDb();
  const users = db
    .prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at')
    .all();
  res.json({ data: users });
});

authRouter.post(
  '/users/create',
  requireAdmin,
  validate({ body: createUserSchema }),
  asyncHandler(async (req, res) => {
    const { username, password, role } = req.body;
    const db = getRawDb();
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      res.status(409).json({ error: 'Conflict', message: 'Username already taken' });
      return;
    }

    const id = uuid();
    const passwordHash = await hashPassword(password);
    const userRole = role === 'admin' ? 'admin' : 'user';
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(
      id,
      username,
      passwordHash,
      userRole,
    );

    logger.info(`Admin created user: ${username} (${userRole})`);
    res.status(201).json({ data: { id, username, role: userRole } });
  }),
);

// Managed password reset: an admin sets a new password for a user who is
// locked out. Every session of that user ends, so the old credential holder
// (or a lost device) is signed out at the same moment.
authRouter.post(
  '/users/:id/reset-password',
  requireAdmin,
  validate({ params: idParam, body: resetPasswordSchema }),
  asyncHandler(async (req, res) => {
    const db = getRawDb();
    const user = db
      .prepare('SELECT id, username FROM users WHERE id = ?')
      .get(String(req.params.id)) as { id: string; username: string } | undefined;
    if (!user) {
      res.status(404).json({ error: 'NotFound', message: 'User not found' });
      return;
    }
    const passwordHash = await hashPassword(req.body.password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
    const revoked = revokeUserSessions(user.id, user.id === req.userId ? req.sessionId : undefined);
    logger.info(`Admin reset password for "${user.username}" (${revoked} session(s) ended)`);
    res.json({ data: { ok: true, revokedSessions: revoked } });
  }),
);

authRouter.post(
  '/users/:id/revoke-sessions',
  requireAdmin,
  validate({ params: idParam }),
  (req, res) => {
    const id = String(req.params.id);
    const exists = getRawDb().prepare('SELECT 1 FROM users WHERE id = ?').get(id);
    if (!exists) {
      res.status(404).json({ error: 'NotFound', message: 'User not found' });
      return;
    }
    const revoked = revokeUserSessions(id, id === req.userId ? req.sessionId : undefined);
    res.json({ data: { revoked } });
  },
);

// Delete a user (cannot delete self). Sessions are revoked first so open
// sockets close; the FK cascade then removes the rows.
authRouter.delete('/users/:id', requireAdmin, validate({ params: idParam }), (req, res) => {
  const id = String(req.params.id);
  if (id === req.userId) {
    res.status(400).json({ error: 'BadRequest', message: 'Cannot delete yourself' });
    return;
  }
  const db = getRawDb();
  const exists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(id);
  if (!exists) {
    res.status(404).json({ error: 'NotFound', message: 'User not found' });
    return;
  }
  revokeUserSessions(id);
  const handedOver = handOverPersonalData(id, String(req.userId));
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  logger.info(
    `Deleted account ${id}; ${handedOver} shared playlist(s) handed to ${req.userId}, personal data removed`,
  );
  res.json({ data: { ok: true, sharedPlaylistsHandedOver: handedOver } });
});

/**
 * Deleting an account (V09.4). What that person kept to themselves goes with
 * them — favourites, listening history, statistics, their own playlists and
 * their scrobble accounts. What they had explicitly shared with the household
 * is the household's: those playlists are handed to the admin doing the
 * deletion, so the kitchen playlist does not disappear with the account.
 * Returns how many were handed over.
 */
function handOverPersonalData(userId: string, adminId: string): number {
  const db = getRawDb();
  const transfer = db.transaction(() => {
    let handed = 0;
    for (const table of ['playlists', 'smart_playlists']) {
      handed += db
        .prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ? AND shared = 1`)
        .run(adminId, userId).changes;
      db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
    }
    for (const table of ['favorites', 'listening_sessions', 'scrobble_config', 'scrobble_queue']) {
      db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
    }
    return handed;
  });
  return transfer();
}

// Import provider tokens (for syncing between local dev and Synology).
// A provider connection is global for the household, hence admin-only.
authRouter.post(
  '/import-token',
  requireAdmin,
  validate({ body: importTokenSchema }),
  (req, res) => {
    const { provider, accessToken, refreshToken, expiresAt } = req.body;
    saveTokens(provider, { accessToken, refreshToken, expiresAt: expiresAt ?? 0 });
    logger.info(`Token imported for ${provider}`);
    res.json({ data: { ok: true } });
  },
);
