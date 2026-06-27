import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { openApiSpec } from '../openapi.js';

describe('OpenAPI spec', () => {
  let app: Express;
  let teardown: () => void;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
  });

  afterAll(() => teardown());

  it('is a well-formed OpenAPI 3.1 document', () => {
    expect(openApiSpec.openapi).toBe('3.1.0');
    expect(openApiSpec.info.title).toBe('AudioServer API');
    expect(Object.keys(openApiSpec.paths).length).toBeGreaterThan(5);
    // Every path's operations must reference a method object with responses.
    for (const [path, ops] of Object.entries(openApiSpec.paths)) {
      for (const [method, op] of Object.entries(ops as Record<string, { responses?: unknown }>)) {
        expect(op.responses, `${method.toUpperCase()} ${path} has responses`).toBeTruthy();
      }
    }
  });

  it('is served publicly (no auth) at /api/openapi.json', async () => {
    const res = await request(app).get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.paths['/health']).toBeTruthy();
  });
});
