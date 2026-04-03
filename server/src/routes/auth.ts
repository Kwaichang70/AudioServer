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
}

// Register (only works if no users exist yet — first-run setup)
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
  if (row.count > 0) {
    res.status(403).json({ error: 'Registration disabled. A user already exists.' });
    return;
  }

  const id = uuid();
  const passwordHash = await hashPassword(password);
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(id, username, passwordHash);

  const token = generateToken(id);
  logger.info(`User registered: ${username}`);
  res.json({ data: { token, user: { id, username } } });
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
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.userId) as { id: string; username: string } | undefined;
  res.json({ data: user || null });
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
