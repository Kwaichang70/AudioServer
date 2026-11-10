import rateLimit from 'express-rate-limit';

const LIBRARY_MEDIA = /^\/api\/library\/(tracks|albums|artists)\/[^/]+\/(stream|cover|image)$/;

/**
 * Requests the global limit does not count: the covers and audio of the own
 * library (a page of albums is a hundred covers), the live Spotify stream a
 * speaker holds open, status polls, and the app's own files. The test used
 * to be "the path contains /stream, /cover, /image or /status", which also
 * exempted routes that call Qobuz or a radio directory on every hit (S04).
 */
export function skipsGlobalLimit(path: string): boolean {
  return (
    LIBRARY_MEDIA.test(path) ||
    path === '/api/librespot/stream' ||
    path.endsWith('/status') ||
    path.startsWith('/assets/')
  );
}

// Global: 100 req/min per address, except what skipsGlobalLimit names.
export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
  skip: (req) => skipsGlobalLimit(req.path),
});

// Auth login: max 10 FAILED attempts per 15 minutes per IP. Successful logins
// are not counted, so a household that signs in on several devices in a row
// is not locked out while a password guesser still is.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'TooManyRequests',
    message: 'Too many login attempts, try again in 15 minutes',
  },
});

// Setup registration: max 10 failed attempts per hour per IP. The setup code
// has 2^32 possibilities, so this makes guessing it impractical while still
// forgiving a few typos.
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TooManyRequests', message: 'Too many setup attempts, try again later' },
});
