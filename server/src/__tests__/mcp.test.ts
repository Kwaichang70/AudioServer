import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import { zones } from '../services/zones.js';
import { stopServerPlayback } from '../services/server-player.js';
import { deviceManager } from '../devices/manager.js';

/**
 * MCP for Grok and Jarvis (step 3): the same commands as /api/control, as MCP
 * tools over Streamable HTTP, only with an API key — in a header or, for a
 * client that cannot send one, in the address.
 */

describe('MCP server', () => {
  let app: Express;
  let teardown: () => void;
  let key: string;
  let living: string;
  let id = 0;

  const rpc = (method: string, params: unknown = {}, path = '/mcp') =>
    request(app)
      .post(path)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: ++id, method, params });

  /** The JSON-RPC message, whether it came as JSON or as one SSE event. */
  const message = (res: request.Response) => {
    if (res.type === 'application/json') return res.body;
    const data = res.text
      .split('\n')
      .find((l) => l.startsWith('data: '))
      ?.slice(6);
    return JSON.parse(data ?? 'null');
  };

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await rpc('tools/call', { name, arguments: args }).set('X-API-Key', key);
    expect(res.status).toBe(200);
    const result = message(res).result;
    return { isError: result.isError === true, data: JSON.parse(result.content[0].text) };
  };

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    const db = getRawDb();
    db.exec(`
      INSERT INTO artists (id, name) VALUES ('ar-p', 'Prince');
      INSERT INTO albums (id, title, artist_id, artist_name, year) VALUES
        ('al-1', 'Purple Rain', 'ar-p', 'Prince', 1984);
      INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, disc_number, track_number, duration, file_path) VALUES
        ('t-1', 'Let''s Go Crazy', 'al-1', 'Purple Rain', 'ar-p', 'Prince', 1, 1, 280, '/m/1'),
        ('t-2', 'Take Me with U', 'al-1', 'Purple Rain', 'ar-p', 'Prince', 1, 2, 234, '/m/2');
    `);
    living = (
      await request(app)
        .post('/api/playback/zones')
        .send({ name: 'Woonkamer', deviceId: 'dlna:cocktail' })
    ).body.data.id;
    key = (await request(app).post('/api/auth/api-keys').send({ name: 'Grok' })).body.data.key;
  });

  afterAll(() => {
    vi.restoreAllMocks();
    stopServerPlayback(living);
    teardown();
  });

  it('refuses a caller without a valid key', async () => {
    const none = await rpc('tools/list');
    expect(none.status).toBe(401);
    expect(none.body.error.message).toMatch(/API key/);
    const wrong = await rpc('tools/list').set('Authorization', 'Bearer as_nope');
    expect(wrong.status).toBe(401);
    const wrongPath = await rpc('tools/list', {}, '/mcp/as_nope');
    expect(wrongPath.status).toBe(401);
  });

  it('greets an MCP client and lists the tools', async () => {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    }).set('Authorization', `Bearer ${key}`);
    expect(init.status).toBe(200);
    expect(message(init).result.serverInfo.name).toBe('audioserver');
    const list = await rpc('tools/list').set('X-API-Key', key);
    const names = message(list).result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'list_rooms',
        'list_playlists',
        'search_library',
        'now_playing',
        'play',
        'pause',
        'resume',
        'stop',
        'next_track',
        'previous_track',
        'set_volume',
        'move_music',
      ]),
    );
  });

  it('takes the key from the address, for a client without headers', async () => {
    const res = await rpc('tools/list', {}, `/mcp/${key}`);
    expect(res.status).toBe(200);
    expect(message(res).result.tools.length).toBeGreaterThan(5);
  });

  it('finds music and plays it in a room', async () => {
    const found = await call('search_library', { query: 'purple' });
    expect(found.data.albums).toEqual([{ title: 'Purple Rain', artist: 'Prince', year: 1984 }]);
    const rooms = await call('list_rooms');
    expect(rooms.data.map((r: { name: string }) => r.name)).toContain('Woonkamer');
    const played = await call('play', { room: 'woonkamer', album: 'purple rain' });
    expect(played.isError).toBe(false);
    expect(played.data).toMatchObject({ room: 'Woonkamer', tracks: 2 });
    expect(zones.sessionFor(living).getState().state).toBe('playing');
    const now = await call('now_playing', { room: 'Woonkamer' });
    expect(now.data.track.title).toBe("Let's Go Crazy");
  });

  it('pauses and sets the volume on the speaker', async () => {
    const pause = vi.spyOn(deviceManager, 'pause').mockResolvedValue();
    const volume = vi.spyOn(deviceManager, 'setVolume').mockResolvedValue();
    await call('play', { room: 'Woonkamer', album: 'Purple Rain' });
    expect((await call('pause', { room: 'Woonkamer' })).data.state).toBe('paused');
    expect(pause).toHaveBeenCalledWith('dlna:cocktail');
    await call('set_volume', { room: 'Woonkamer', volume: 20 });
    expect(volume).toHaveBeenCalledWith('dlna:cocktail', 20);
  });

  it('answers a wrong name with the names that exist, as a tool error', async () => {
    const res = await call('play', { room: 'Zolder', album: 'Purple Rain' });
    expect(res.isError).toBe(true);
    expect(res.data.options).toContain('Woonkamer');
  });

  it('keeps no sessions: GET and DELETE are refused', async () => {
    const get = await request(app).get('/mcp').set('X-API-Key', key);
    expect(get.status).toBe(405);
    const del = await request(app).delete(`/mcp/${key}`);
    expect(del.status).toBe(405);
  });
});
