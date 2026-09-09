import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, getRawDb, initDatabase } from '../db/index.js';
import {
  closeOrphanedSessions,
  fail,
  getActiveSession,
  HEARTBEAT_CAP_MS,
  heartbeat,
  qualifies,
  resetListeningForTests,
  setListeningClock,
  setListeningPolicy,
  startSession,
  transport,
} from '../services/listening.js';
import { scrobbler } from '../services/scrobbler.js';

/**
 * V05.2 / V05.3: one listening session per track start; listened time is
 * confirmed playing time; a listen qualifies by Last.fm's rule; exactly one
 * scrobble per session and service.
 */
describe('listening sessions', () => {
  let dir: string;
  let now = 1_800_000_000_000;
  const tick = (ms: number) => {
    now += ms;
  };
  /** Audio plays for `ms` with a heartbeat every 5 s, like a live client. */
  const listen = (ms: number) => {
    for (let left = ms; left > 0; left -= 5_000) {
      tick(Math.min(5_000, left));
      heartbeat();
    }
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'audioserver-listening-'));
    await initDatabase(join(dir, 'listening.db'));
    scrobbler.saveConfig({ lastfmEnabled: true, lastfmSessionKey: 'key', lastfmUsername: 'u' });
    scrobbler.saveConfig({ listenbrainzEnabled: true, listenbrainzToken: 'token' });
  });

  afterAll(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetListeningForTests();
    setListeningClock(() => now);
    // Submissions never leave the process in this suite.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })),
    );
    getRawDb().exec('DELETE FROM listening_sessions; DELETE FROM scrobble_queue;');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const track = (over: Partial<Parameters<typeof startSession>[0]> = {}) => ({
    id: 'local-1',
    title: 'Song',
    artistName: 'Band',
    albumTitle: 'Album',
    albumId: 'album-1',
    artistId: 'artist-1',
    duration: 200,
    source: 'local',
    ...over,
  });

  const rows = () =>
    getRawDb()
      .prepare(
        'SELECT id, track_id, source, title, artist_name, album_id, artist_id, started_at, ended_at, listened_ms, status, qualified FROM listening_sessions ORDER BY started_at',
      )
      .all() as Array<Record<string, unknown>>;

  const queue = () =>
    getRawDb()
      .prepare('SELECT service, session_id, timestamp, status FROM scrobble_queue ORDER BY service')
      .all() as Array<{ service: string; session_id: string | null; timestamp: number }>;

  it('applies the Last.fm rule', () => {
    expect(qualifies(200, 99_000)).toBe(false);
    expect(qualifies(200, 100_000)).toBe(true);
    expect(qualifies(3600, 239_000)).toBe(false);
    expect(qualifies(3600, 240_000)).toBe(true);
    expect(qualifies(30, 30_000)).toBe(false); // too short a track
    expect(qualifies(null, 239_000)).toBe(false);
    expect(qualifies(null, 240_000)).toBe(true);
  });

  it('records a UTC start time and a metadata snapshot, also for provider tracks', () => {
    startSession(track({ id: 'qobuz:42', source: 'qobuz', albumId: null, artistId: null }), {
      queueItemId: 'item-1',
      deviceId: 'browser',
    });
    const [row] = rows();
    expect(row.started_at).toBe(Math.floor(now / 1000));
    expect(row.track_id).toBe('qobuz:42');
    expect(row.source).toBe('qobuz');
    expect(row.title).toBe('Song');
    expect(row.artist_name).toBe('Band');
    expect(row.status).toBe('active');
  });

  it('counts playing time only: pauses and seeks add nothing', () => {
    startSession(track(), {});
    tick(30_000);
    heartbeat();
    transport('paused', null);
    tick(600_000); // an hour-long coffee break must not count
    transport('playing', null);
    tick(30_000);
    heartbeat();
    expect(getActiveSession()?.listenedMs).toBe(60_000);
    // seeking: the position jumps, the clock does not
    listen(50_000);
    transport('stopped', null);
    const [row] = rows();
    expect(row.listened_ms).toBe(110_000);
    expect(row.status).toBe('ended');
    expect(row.qualified).toBe(1); // 110 s >= 100 s (half of 200)
  });

  it('an immediate skip and a failed play are not listens', () => {
    startSession(track(), {});
    tick(3_000);
    startSession(track({ id: 'local-2' }), {}); // skip
    tick(5_000);
    fail();
    const all = rows();
    expect(all.map((r) => [r.status, r.qualified])).toEqual([
      ['ended', 0],
      ['failed', 0],
    ]);
    expect(queue()).toEqual([]);
  });

  it('a dead client adds at most one capped interval', () => {
    startSession(track({ duration: 3600 }), {});
    tick(10 * 60_000); // no heartbeat for ten minutes
    transport('stopped', null);
    expect(rows()[0].listened_ms).toBe(HEARTBEAT_CAP_MS);
  });

  it('two controllers reporting the same session do not double count', () => {
    startSession(track(), {});
    for (let i = 0; i < 12; i++) {
      tick(5_000);
      heartbeat(); // tab A
      heartbeat(); // tab B, same instant
      transport('playing', null); // device sample
    }
    expect(getActiveSession()?.listenedMs).toBe(60_000);
  });

  it('queues exactly one scrobble per service with the start time, even when finished twice', () => {
    startSession(track(), { queueItemId: 'item-1' });
    const started = Math.floor(now / 1000);
    listen(150_000);
    transport('stopped', null);
    const q = queue();
    expect(q.map((r) => r.service)).toEqual(['lastfm', 'listenbrainz']);
    expect(q.every((r) => r.timestamp === started)).toBe(true);
    const sessionId = q[0].session_id!;
    // A retry / reconnect / second controller re-submitting the same session is a no-op.
    scrobbler.scrobble({ title: 'Song', artist: 'Band' }, { sessionId, timestamp: started });
    expect(queue()).toHaveLength(2);
  });

  it('radio never scrobbles; Spotify only by policy', () => {
    startSession(track({ id: 'radio:x', source: 'radio', duration: null }), {});
    listen(300_000);
    transport('stopped', null);
    expect(rows()[0].qualified).toBe(1);
    expect(queue()).toEqual([]);

    startSession(track({ id: 'spotify:t', source: 'spotify' }), {});
    listen(150_000);
    transport('stopped', null);
    expect(queue()).toEqual([]);

    setListeningPolicy({ scrobbleSpotify: true });
    startSession(track({ id: 'spotify:t2', source: 'spotify' }), {});
    listen(150_000);
    transport('stopped', null);
    expect(queue()).toHaveLength(2);
  });

  it('playing without a session opens one (restart while the speaker kept playing)', () => {
    transport('playing', { track: track(), ctx: { queueItemId: 'item-9', deviceId: 'sonos' } });
    expect(getActiveSession()?.trackId).toBe('local-1');
    listen(120_000);
    transport('stopped', null);
    expect(rows()[0].qualified).toBe(1);
  });

  it('closes sessions a previous run left open, with their accrued time', () => {
    getRawDb()
      .prepare(
        `INSERT INTO listening_sessions (id, track_id, source, title, artist_name, duration, started_at, listened_ms, status, qualified)
         VALUES ('orphan-1', 'local-9', 'local', 'Left', 'Open', 200, ?, 150000, 'active', 0),
                ('orphan-2', 'local-8', 'local', 'Short', 'One', 200, ?, 5000, 'active', 0)`,
      )
      .run(Math.floor(now / 1000) - 400, Math.floor(now / 1000) - 100);
    expect(closeOrphanedSessions()).toBe(2);
    const all = rows();
    expect(all.map((r) => [r.id, r.status, r.qualified])).toEqual([
      ['orphan-1', 'ended', 1],
      ['orphan-2', 'ended', 0],
    ]);
    expect(queue().map((r) => r.session_id)).toEqual(['orphan-1', 'orphan-1']);
    // Idempotent: a second pass finds nothing.
    expect(closeOrphanedSessions()).toBe(0);
  });
});
