import rateLimit from 'express-rate-limit';

// Global: 1000 req/min, skip covers/images/streams (those are heavy on page load)
export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
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

// Auth login: max 5 attempts per 15 minutes per IP
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again in 15 minutes' },
});

// Auth register: max 3 attempts per hour per IP
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts, please try again later' },
});
