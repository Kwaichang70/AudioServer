import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../.env') });

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  const nodeEnv = process.env.NODE_ENV || 'development';

  if (nodeEnv === 'production') {
    if (!secret || secret === 'dev-secret-change-me' || secret === 'change-me-in-production') {
      console.error('\n❌ FATAL: JWT_SECRET is not set or is using a default value.');
      console.error('   In production, you MUST set a secure JWT_SECRET.');
      console.error('   Generate one with: openssl rand -hex 32\n');
      process.exit(1);
    }
    return secret;
  }

  // Development: auto-generate with warning
  if (!secret || secret === 'dev-secret-change-me') {
    const generated = randomBytes(32).toString('hex');
    console.warn('⚠️  JWT_SECRET not set — using auto-generated secret (dev only, not persistent)');
    return generated;
  }

  return secret;
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  musicLibraryPaths: (process.env.MUSIC_LIBRARY_PATHS || './test-music')
    .split(',')
    .map((p) => p.trim()),
  databasePath: process.env.DATABASE_PATH || './data/audioserver.db',
  jwtSecret: getJwtSecret(),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((o) => o.trim()),
} as const;
