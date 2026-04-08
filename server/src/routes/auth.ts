import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { getRawDb } from '../db/index.js';
import { hashPassword, verifyPassword, generateToken } from '../middleware/auth.js';
import { loginLimiter, registerLimiter } from '../middleware/rateLimiter.js';
import { logger } from '../logger.js';

export const authRouter = Router();

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
}

// Register (first user becomes admin, subsequent users need admin invite)
authRouter.post('/register', registerLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password required' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  const db = getRawDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  const isFirstUser = row.count === 0;
  const role = isFirstUser ? 'admin' : 'user';

  // If not first user, require admin auth
  if (!isFirstUser) {
    if (!req.userId) {
      res.status(403).json({ error: 'Registration requires admin invite. Use /users/create as admin.' });
      return;
    }
    const admin = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId) as { role: string } | undefined;
    if (!admin || admin.role !== 'admin') {
      res.status(403).json({ error: 'Only admins can create new users' });
      return;
    }
  }

  const id = uuid();
  const passwordHash = await hashPassword(password);
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(id, username, passwordHash, role);

  const token = generateToken(id);
  logger.info(`User registered: ${username} (${role})`);
  res.json({ data: { token, user: { id, username, role } } });
});

// Login
authRouter.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password required' });
    return;
  }

  const db = getRawDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = generateToken(user.id);
  res.json({ data: { token, user: { id: user.id, username: user.username } } });
});

// Check current user
authRouter.get('/me', (req, res) => {
  if (!req.userId) {
    res.json({ data: null });
    return;
  }

  const db = getRawDb();
  const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(req.userId) as { id: string; username: string; role: string } | undefined;
  res.json({ data: user || null });
});

// ─── User Management (Admin only) ───────────────────────────────

// List all users
authRouter.get('/users', (req, res) => {
  if (!req.userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const db = getRawDb();
  const admin = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId) as { role: string } | undefined;
  if (!admin || admin.role !== 'admin') { res.status(403).json({ error: 'Admin required' }); return; }

  const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at').all();
  res.json({ data: users });
});

// Create a new user (admin only)
authRouter.post('/users/create', registerLimiter, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) { res.status(400).json({ error: 'Username and password required' }); return; }
  if (password.length < 8) { res.status(400).json({ error: 'Password must be at least 8 characters' }); return; }
  if (!req.userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const db = getRawDb();
  const admin = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId) as { role: string } | undefined;
  if (!admin || admin.role !== 'admin') { res.status(403).json({ error: 'Admin required' }); return; }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) { res.status(409).json({ error: 'Username already taken' }); return; }

  const id = uuid();
  const passwordHash = await hashPassword(password);
  const userRole = role === 'admin' ? 'admin' : 'user';
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(id, username, passwordHash, userRole);

  logger.info(`Admin created user: ${username} (${userRole})`);
  res.status(201).json({ data: { id, username, role: userRole } });
});

// Delete a user (admin only, cannot delete self)
authRouter.delete('/users/:id', (req, res) => {
  if (!req.userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  if (req.params.id === req.userId) { res.status(400).json({ error: 'Cannot delete yourself' }); return; }

  const db = getRawDb();
  const admin = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId) as { role: string } | undefined;
  if (!admin || admin.role !== 'admin') { res.status(403).json({ error: 'Admin required' }); return; }

  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ data: { ok: true } });
});

// Import provider tokens (for syncing between local dev and Synology)
authRouter.post('/import-token', (req, res) => {
  const { provider, accessToken, refreshToken, expiresAt } = req.body;
  if (!provider || !accessToken || !refreshToken) {
    res.status(400).json({ error: 'provider, accessToken, refreshToken required' });
    return;
  }
  const db = getRawDb();
  db.prepare('INSERT OR REPLACE INTO provider_tokens (provider, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?)')
    .run(provider, accessToken, refreshToken, expiresAt || 0);
  logger.info(`Token imported for ${provider}`);
  res.json({ data: { ok: true } });
});
