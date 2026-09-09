import type { NextFunction, Request, RequestHandler, Response } from 'express';

/* eslint-disable @typescript-eslint/no-explicit-any */
// Route params are always single strings for our path patterns; `any` for
// body/query mirrors Express's own defaults so validated bodies keep working.
type Params = Record<string, string>;
type AsyncRequest = Request<Params, any, any, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Wraps an async route handler so a rejected promise reaches Express's error
 * middleware (→ logged 500) instead of becoming an unhandled promise
 * rejection. Express 4 does not await handlers, and Node 15+ terminates the
 * process on an unhandled rejection, so a bare `async (req, res) => {...}`
 * that throws after its first `await` takes the whole server down: the
 * client sees an empty reply (502 behind a reverse proxy) and the container
 * restarts.
 *
 * Every async route handler must be wrapped.
 *
 * Usage: router.get('/x/:id', asyncHandler(async (req, res) => { ... }))
 */
export function asyncHandler(
  fn: (req: AsyncRequest, res: Response, next: NextFunction) => Promise<unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): RequestHandler<Params, any, any, any> {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
