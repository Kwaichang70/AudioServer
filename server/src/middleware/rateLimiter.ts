import rateLimit from 'express-rate-limit';

// Global: 100 req/min, skip covers/images/streams (those are heavy on page load)
export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
  skip: (req) =>
    req.path.includes('/cover') ||
    req.path.includes('/image') ||
    req.path.includes('/stream') ||
    req.path.includes('/status') ||
    req.path.startsWith('/assets/'),
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
