import { type Request, type Response, type NextFunction } from 'express';
import { logger } from '../logger.js';
import { randomBytes } from 'crypto';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const requestId = randomBytes(4).toString('hex');
  (req as any).requestId = requestId;

  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;

    // Skip noisy endpoints
    if (req.path.includes('/covers/fetch/status') || req.path.includes('/scan/status')) return;

    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    const msg = `${req.method} ${req.path} ${status} ${duration}ms`;

    if (level === 'error') logger.error(`[${requestId}] ${msg}`);
    else if (level === 'warn') logger.warn(`[${requestId}] ${msg}`);
    else if (duration > 1000) logger.info(`[${requestId}] ${msg} (slow)`);
    else logger.debug(`[${requestId}] ${msg}`);
  });

  next();
}
