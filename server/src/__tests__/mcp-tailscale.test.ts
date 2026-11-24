import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestApp } from './helpers/testApp.js';
import { mcpAllows, mcpRouter } from '../routes/mcp.js';
import { classifyAddress } from '../utils/network.js';
import { config } from '../config.js';
import { jsonBody } from '../middleware/jsonBody.js';
import { createApiKey } from '../services/api-keys.js';

/**
 * MCP over Tailscale: with MCP_ACCESS=tailscale the endpoint answers devices
 * in the tailnet and nobody else, whatever key they hold.
 */

describe('where a caller comes from', () => {
  it.each([
    ['100.92.242.32', 'tailscale'],
    ['100.64.0.1', 'tailscale'],
    ['100.127.255.254', 'tailscale'],
    ['::ffff:100.90.5.33', 'tailscale'],
    ['fd7a:115c:a1e0::1234', 'tailscale'],
    ['100.63.0.1', 'public'], // just below the range
    ['100.128.0.1', 'public'], // just above it
    ['192.168.2.58', 'private'],
    ['10.0.0.4', 'private'],
    ['172.16.5.5', 'private'],
    ['172.32.0.1', 'public'],
    ['fe80::1', 'private'],
    ['127.0.0.1', 'loopback'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['84.105.20.7', 'public'],
    ['2a02:a45f::1', 'public'],
    ['not an address', 'public'],
    ['', 'public'],
  ])('%s is %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it('decides per setting', () => {
    for (const from of ['loopback', 'tailscale', 'private', 'public'] as const) {
      expect(mcpAllows('any', from)).toBe(true);
    }
    expect(mcpAllows('tailscale', 'tailscale')).toBe(true);
    expect(mcpAllows('tailscale', 'loopback')).toBe(true);
    expect(mcpAllows('tailscale', 'private')).toBe(false);
    expect(mcpAllows('tailscale', 'public')).toBe(false);
    expect(mcpAllows('private', 'private')).toBe(true);
    expect(mcpAllows('private', 'tailscale')).toBe(true);
    expect(mcpAllows('private', 'public')).toBe(false);
  });
});

describe('the MCP endpoint with MCP_ACCESS=tailscale', () => {
  let teardown: () => void;
  let key: string;
  // Like production behind the Synology reverse proxy and `tailscale serve`:
  // both reach the server from loopback and name the caller in X-Forwarded-For.
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(jsonBody());
  app.use('/mcp', mcpRouter);

  const settings = config as { mcpAccess: string };
  const original = settings.mcpAccess;

  const listTools = (from?: string) => {
    const req = request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Authorization', `Bearer ${key}`);
    if (from) req.set('X-Forwarded-For', from);
    return req.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  };

  beforeAll(async () => {
    const ctx = await createTestApp();
    teardown = ctx.teardown;
    key = createApiKey(ctx.admin!.id, 'Grokbot').key;
  });
  afterEach(() => {
    settings.mcpAccess = original;
  });
  afterAll(() => teardown());

  it('answers a device in the tailnet', async () => {
    settings.mcpAccess = 'tailscale';
    const res = await listTools('100.90.5.33');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('list_rooms');
  });

  it('refuses the outside world and the home network, valid key or not', async () => {
    settings.mcpAccess = 'tailscale';
    for (const from of ['84.105.20.7', '192.168.2.40']) {
      const res = await listTools(from);
      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/Tailscale only/);
    }
  });

  it('cannot be fooled by a forged forwarding header in front of the real one', async () => {
    settings.mcpAccess = 'tailscale';
    // An outside caller claims a tailnet address; the proxy appends the real one.
    const res = await listTools('100.90.5.33, 84.105.20.7');
    expect(res.status).toBe(403);
  });

  it('still answers this machine itself, and everybody when the setting is "any"', async () => {
    settings.mcpAccess = 'tailscale';
    expect((await listTools()).status).toBe(200); // docker exec, no proxy
    settings.mcpAccess = 'any';
    expect((await listTools('84.105.20.7')).status).toBe(200);
  });

  it('lets the home network in with "private"', async () => {
    settings.mcpAccess = 'private';
    expect((await listTools('192.168.2.40')).status).toBe(200);
    expect((await listTools('84.105.20.7')).status).toBe(403);
  });
});
