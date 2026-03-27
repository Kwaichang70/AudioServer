import dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(import.meta.dirname, '../../.env') });

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  musicLibraryPaths: (process.env.MUSIC_LIBRARY_PATHS || './test-music')
    .split(',')
    .map((p) => p.trim()),
  databasePath: process.env.DATABASE_PATH || './data/audioserver.db',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
} as const;
