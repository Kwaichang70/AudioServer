import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, getRawDb, initDatabase } from '../db/index.js';
import { providers } from '../providers/registry.js';
import { QobuzProviderError } from '../providers/qobuz.js';
import {
  getAllCapabilities,
  getCapabilities,
  PlaybackResolveError,
  resolveForDevice,
  sourceOf,
} from '../services/playback-resolver.js';
import { verifyStreamToken } from '../middleware/auth.js';

/**
 * V04.1: one resolver decides what the NAS can hand to a renderer.
 */
describe('playback resolver', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'audioserver-resolver-'));
    await initDatabase(join(tmp, 'test.db'));
    const db = getRawDb();
    db.exec(`
      INSERT INTO artists (id, name) VALUES ('ar1', 'Artist');
      INSERT INTO albums (id, title, artist_id, artist_name) VALUES ('al1', 'Album', 'ar1', 'Artist');
      INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, file_path, duration, format)
        VALUES ('trk1', 'Song', 'al1', 'Album', 'ar1', 'Artist', '/music/song.flac', 240, 'flac');
    `);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('classifies sources by id prefix', () => {
    expect(sourceOf('abc')).toBe('local');
    expect(sourceOf('qobuz:1')).toBe('qobuz');
    expect(sourceOf('spotify:1')).toBe('spotify');
    expect(sourceOf('tidal:1')).toBe('tidal');
    expect(sourceOf('radio:1')).toBe('radio');
  });

  it('describes capabilities per source, honest about what is unavailable', () => {
    const all = getAllCapabilities();
    expect(all.map((c) => c.source)).toEqual(['local', 'qobuz', 'radio', 'spotify', 'tidal']);
    expect(getCapabilities('local')).toMatchObject({ serverDispatch: true, browser: true });
    expect(getCapabilities('tidal')).toMatchObject({ serverDispatch: false, browser: false });
    expect(getCapabilities('spotify')).toMatchObject({
      serverDispatch: false,
      externalPlayer: 'spotify-connect',
    });
    // No Qobuz credentials in the test environment.
    const qobuz = getCapabilities('qobuz');
    expect(qobuz.serverDispatch).toBe(false);
    expect(qobuz.ephemeralUrl).toBe(true);
    expect(qobuz.reason).toBeTruthy();
  });

  it('resolves a local track to a LAN url with a fresh system token and mime type', async () => {
    const resolved = await resolveForDevice({ id: 'trk1' });
    expect(resolved.source).toBe('local');
    expect(resolved.url).toMatch(/^http:\/\/[\d.]+:\d+\/api\/library\/tracks\/trk1\/stream\?t=/);
    expect(resolved.mimeType).toBe('audio/flac');
    expect(resolved.metadata).toMatchObject({
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      duration: 240,
      mimeType: 'audio/flac',
    });
    expect(resolved.metadata.coverUrl).toMatch(/\/api\/library\/albums\/al1\/cover\?t=/);
    const token = decodeURIComponent(resolved.url.split('?t=')[1]);
    expect(verifyStreamToken(token)).toEqual({ userId: 'system' });

    // Every resolution mints a new token (never a stored one).
    const again = await resolveForDevice({ id: 'trk1' });
    expect(again.url).not.toBe(resolved.url);
  });

  it('reports a missing local track as not found', async () => {
    await expect(resolveForDevice({ id: 'nope' })).rejects.toMatchObject({
      code: 'track_not_found',
      retryable: false,
    });
  });

  it('resolves Qobuz through a fresh signed url when streaming is available', async () => {
    vi.spyOn(providers.qobuz, 'getStatus').mockReturnValue({
      available: true,
      configured: true,
      authenticated: true,
      streamingAvailable: true,
      reason: 'ready',
      formatId: '6',
    });
    let calls = 0;
    vi.spyOn(providers.qobuz, 'getStreamInfo').mockImplementation(async () => ({
      url: `https://cdn.qobuz.example/track.flac?sig=${++calls}`,
      formatId: '6',
      expiresAt: 1_800_000_000,
    }));
    const first = await resolveForDevice({
      id: 'qobuz:42',
      title: 'Q',
      artistName: 'A',
      albumTitle: 'B',
      duration: 100,
    });
    const second = await resolveForDevice({ id: 'qobuz:42' });
    expect(first.url).toContain('sig=1');
    expect(second.url).toContain('sig=2');
    expect(first.mimeType).toBe('audio/flac');
    expect(first.expiresAt).toBe(1_800_000_000_000);
    expect(first.metadata).toMatchObject({ title: 'Q', artist: 'A', album: 'B', duration: 100 });
  });

  it('maps Qobuz auth problems to a retryable resolver error', async () => {
    vi.spyOn(providers.qobuz, 'getStatus').mockReturnValue({
      available: true,
      configured: true,
      authenticated: false,
      streamingAvailable: false,
      reason: 'qobuz_not_authenticated',
      formatId: '5',
    });
    const err = await resolveForDevice({ id: 'qobuz:1' }).catch((e) => e);
    expect(err).toBeInstanceOf(PlaybackResolveError);
    expect(err.code).toBe('provider_not_authenticated');
    expect(err.retryable).toBe(true);

    vi.spyOn(providers.qobuz, 'getStatus').mockReturnValue({
      available: true,
      configured: true,
      authenticated: true,
      streamingAvailable: true,
      reason: 'ready',
      formatId: '5',
    });
    vi.spyOn(providers.qobuz, 'getStreamInfo').mockRejectedValue(
      new QobuzProviderError('qobuz_geo_or_subscription_blocked', 'blocked', 403),
    );
    const blocked = await resolveForDevice({ id: 'qobuz:1' }).catch((e) => e);
    expect(blocked.code).toBe('stream_unavailable');
    expect(blocked.retryable).toBe(false);
  });

  it('refuses Spotify (external player) and Tidal (no full playback) explicitly', async () => {
    await expect(resolveForDevice({ id: 'spotify:x' })).rejects.toMatchObject({
      code: 'external_player_only',
    });
    await expect(resolveForDevice({ id: 'tidal:x' })).rejects.toMatchObject({
      code: 'unsupported_source',
    });
  });

  it('resolves a cached radio station to its stream url', async () => {
    getRawDb()
      .prepare(
        "INSERT INTO radio_stations (uuid, name, stream_url, genre) VALUES ('st1', 'Radio 1', 'https://stream.example/live', 'news')",
      )
      .run();
    const resolved = await resolveForDevice({ id: 'radio:st1' });
    expect(resolved).toMatchObject({
      source: 'radio',
      url: 'https://stream.example/live',
      metadata: { title: 'Radio 1', artist: 'Live Radio', album: 'news' },
    });
  });
});
