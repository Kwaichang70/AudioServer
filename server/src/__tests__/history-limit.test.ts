import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';

/** §6: a page size of -1 or 0 is not "everything" (SQLite reads LIMIT -1 so). */
describe('history page size', () => {
  let app: Express;
  let teardown: () => void;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
  });

  afterAll(() => teardown());

  for (const limit of ['-1', '0', 'abc', '100000']) {
    it(`treats limit=${limit} as a sane page size`, async () => {
      const res = await request(app).get(`/api/history/tracks?limit=${limit}`);
      expect(res.status).toBe(200);
      const size = res.body.meta?.limit;
      if (size !== undefined) {
        expect(size).toBeGreaterThanOrEqual(1);
        expect(size).toBeLessThanOrEqual(100);
      }
    });
  }
});
