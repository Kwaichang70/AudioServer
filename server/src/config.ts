import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { accessSync, constants } from 'fs';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../.env') });

// ─── Schema ──────────────────────────────────────────────────────

const csv = (s: string | undefined) =>
  (s ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z
    .string()
    .default('3001')
    .transform((s) => parseInt(s, 10))
    .pipe(z.number().int().min(1).max(65535)),
  MUSIC_LIBRARY_PATHS: z.string().optional(),
  DATABASE_PATH: z.string().default('./data/audioserver.db'),
  JWT_SECRET: z.string().optional(),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),

  // Optional provider credentials
  SPOTIFY_CLIENT_ID: z.string().optional(),
  SPOTIFY_CLIENT_SECRET: z.string().optional(),
  TIDAL_CLIENT_ID: z.string().optional(),
  TIDAL_CLIENT_SECRET: z.string().optional(),
  QOBUZ_USERNAME: z.string().optional(),
  QOBUZ_PASSWORD: z.string().optional(),
  LASTFM_API_KEY: z.string().optional(),
  LASTFM_API_SECRET: z.string().optional(),
  LISTENBRAINZ_TOKEN: z.string().optional(),

  // Optional device hints
  DLNA_DEVICES: z.string().optional(),
  VOLUMIO_DEVICES: z.string().optional(),
  WATCH_LIBRARY: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

// ─── Parse + validate ────────────────────────────────────────────

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('\n❌ FATAL: Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`   - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}
const env = parsed.data;

// ─── JWT secret (special handling) ───────────────────────────────

function getJwtSecret(): string {
  if (env.NODE_ENV === 'production') {
    if (
      !env.JWT_SECRET ||
      env.JWT_SECRET === 'dev-secret-change-me' ||
      env.JWT_SECRET === 'change-me-in-production' ||
      env.JWT_SECRET.length < 32
    ) {
      console.error(
        '\n❌ FATAL: JWT_SECRET must be set to a strong (≥32 chars) value in production.',
      );
      console.error('   Generate one with: openssl rand -hex 32\n');
      process.exit(1);
    }
    return env.JWT_SECRET;
  }
  if (!env.JWT_SECRET || env.JWT_SECRET === 'dev-secret-change-me') {
    const generated = randomBytes(32).toString('hex');
    console.warn('⚠️  JWT_SECRET not set — using auto-generated secret (dev only, not persistent)');
    return generated;
  }
  return env.JWT_SECRET;
}

// ─── Exported config ─────────────────────────────────────────────

const musicLibraryPaths = csv(env.MUSIC_LIBRARY_PATHS);
if (musicLibraryPaths.length === 0) musicLibraryPaths.push('./test-music');

export const config = {
  port: env.PORT,
  nodeEnv: env.NODE_ENV,
  musicLibraryPaths,
  databasePath: env.DATABASE_PATH,
  jwtSecret: getJwtSecret(),
  allowedOrigins: csv(env.ALLOWED_ORIGINS),
  watchLibrary: env.WATCH_LIBRARY ?? false,
} as const;

// ─── Validate runtime accessibility ──────────────────────────────

export function validateConfig(): void {
  console.log('\n--- AudioServer Configuration ---');
  console.log(`  Environment: ${config.nodeEnv}`);
  console.log(`  Port: ${config.port}`);
  console.log(`  Music paths: ${config.musicLibraryPaths.join(', ')}`);
  console.log(`  Database: ${config.databasePath}`);
  console.log(`  Allowed origins: ${config.allowedOrigins.join(', ') || '(none)'}`);
  console.log(`  Spotify: ${env.SPOTIFY_CLIENT_ID ? 'configured' : 'not configured'}`);
  console.log(`  Tidal: ${env.TIDAL_CLIENT_ID ? 'configured' : 'not configured'}`);
  console.log(`  Qobuz: ${env.QOBUZ_USERNAME ? 'configured' : 'not configured'}`);
  console.log(`  Last.fm: ${env.LASTFM_API_KEY ? 'configured' : 'not configured'}`);
  console.log(`  ListenBrainz: ${env.LISTENBRAINZ_TOKEN ? 'configured' : 'not configured'}`);
  console.log(`  DLNA devices: ${env.DLNA_DEVICES || 'auto-discover'}`);
  console.log(`  Volumio devices: ${env.VOLUMIO_DEVICES || 'none'}`);
  console.log(`  Watcher: ${config.watchLibrary ? 'enabled' : 'disabled'}`);
  console.log('');

  // Warn (don't fail) on inaccessible music paths so a misconfigured share
  // doesn't kill the server — the scanner will report 0 tracks instead.
  for (const p of config.musicLibraryPaths) {
    if (p === './test-music') {
      console.warn(`⚠️  MUSIC_LIBRARY_PATHS not set (using default: ${p})`);
      continue;
    }
    try {
      accessSync(p, constants.R_OK);
    } catch {
      console.warn(`⚠️  Music path not accessible (will be skipped by scanner): ${p}`);
    }
  }
}
