import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';

/**
 * Custom error class with an HTTP status code. Throw from any handler:
 *   throw new HttpError(404, 'Album not found')
 * The error middleware will turn it into { error, message } with the right status.
 */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * 404 handler — mount AFTER all routes so any unmatched path falls through to here.
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: 'NotFound', message: `${req.method} ${req.path} not found` });
}

/**
 * Global error middleware — mount LAST in the middleware chain.
 * Logs with request-id (set by requestLogger) and returns a structured JSON error.
 *
 * Express recognises an error-handler by its 4-arity signature, so the unused
 * `_next` parameter is required even though we don't call it.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,

  _next: NextFunction,
): void {
  const reqId = (req as Request & { requestId?: string }).requestId ?? '-';

  if (err instanceof HttpError) {
    logger.warn(`[${reqId}] ${req.method} ${req.path} → ${err.statusCode} ${err.message}`);
    res.status(err.statusCode).json({
      error: err.code ?? err.name,
      message: err.message,
      requestId: reqId,
    });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logger.error(`[${reqId}] ${req.method} ${req.path} → 500 ${message}\n${stack ?? ''}`);

  res.status(500).json({
    error: 'InternalServerError',
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : message,
    requestId: reqId,
  });
}
