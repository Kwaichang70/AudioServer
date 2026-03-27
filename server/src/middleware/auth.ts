import { type Request, type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { getRawDb } from '../db/index.js';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

/**
 * Auth middleware — skip if no users exist (first-run setup).
 * Once a user is created, all API routes (except /auth/* and /health) require a valid JWT.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith('/api/auth') || req.path.startsWith('/api/health')) {
    next();
    return;
  }

  const db = getRawDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number } | undefined;
  if (!row || row.count === 0) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized', message: 'No token provided' });
    return;
  }

  try {
    const payload = jwt.verify(authHeader.slice(7), config.jwtSecret) as { userId: string };
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
  }
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
