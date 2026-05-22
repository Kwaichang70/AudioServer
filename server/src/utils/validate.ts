import { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { z, type ZodTypeAny } from 'zod';

type Schemas = {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
};

/**
 * Validate request body / query / params against zod schemas.
 * On success, replaces `req.body` / `req.query` / `req.params` with parsed values
 * so downstream handlers get strongly-typed input.
 * On failure, returns 400 with a structured error list.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const issues: Array<{ where: string; path: string; message: string }> = [];

    if (schemas.body) {
      const r = schemas.body.safeParse(req.body);
      if (!r.success) {
        for (const i of r.error.issues)
          issues.push({ where: 'body', path: i.path.join('.'), message: i.message });
      } else {
        req.body = r.data;
      }
    }
    if (schemas.query) {
      const r = schemas.query.safeParse(req.query);
      if (!r.success) {
        for (const i of r.error.issues)
          issues.push({ where: 'query', path: i.path.join('.'), message: i.message });
      } else {
        // Express 5's req.query getter is read-only on some versions; assign via defineProperty.
        Object.defineProperty(req, 'query', { value: r.data, writable: true, configurable: true });
      }
    }
    if (schemas.params) {
      const r = schemas.params.safeParse(req.params);
      if (!r.success) {
        for (const i of r.error.issues)
          issues.push({ where: 'params', path: i.path.join('.'), message: i.message });
      } else {
        req.params = r.data as Record<string, string>;
      }
    }

    if (issues.length > 0) {
      res.status(400).json({ error: 'ValidationError', issues });
      return;
    }
    next();
  };
}

// ─── Common reusable schemas ─────────────────────────────────────

export const idParam = z.object({ id: z.string().min(1) });
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
