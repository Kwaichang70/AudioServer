import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { asyncHandler } from '../utils/asyncHandler.js';
import { errorHandler } from '../middleware/errorHandler.js';

/**
 * Regression guard for the NAS crash of 9 Sept 2026: a bare
 * `async (req, res) => {...}` route that throws after its first `await` is an
 * unhandled rejection under Express 4, and Node terminates the process
 * (empty reply → 502 behind the proxy → container restart).
 */
describe('async route handlers', () => {
  it('asyncHandler turns a rejection after await into a logged 500', async () => {
    const app = express();
    app.get(
      '/boom',
      asyncHandler(async () => {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error('after await');
      }),
    );
    app.use(errorHandler);
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('InternalServerError');
  });

  it('every async route handler in src/routes is wrapped in asyncHandler', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'routes');
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(dir, file), 'utf8');
      const re = /async \(_?req(, _?res)?(, next)?\) =>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const before = src.slice(Math.max(0, m.index - 24), m.index);
        if (!/asyncHandler\(\s*$/.test(before)) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${file}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
