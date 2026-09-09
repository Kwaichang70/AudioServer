import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SearchResults, Track } from '@audioserver/shared';
import { closeDatabase, getRawDb, initDatabase } from '../db/index.js';
import { providers } from '../providers/registry.js';
import { searchLocal } from '../services/local-search.js';
import { parseSearchOptions, playabilityFor, unifiedSearch } from '../services/search.js';

const empty: SearchResults = { artists: [], albums: [], tracks: [], playlists: [] };

function qobuzTrack(title: string, extra: Partial<Track> = {}): Track {
  return {
    id: `qobuz:${title}`,
    title,
    albumId: 'qobuz:al',
    albumTitle: 'Album',
    artistId: 'qobuz:ar',
    artistName: 'Band',
    source: 'qobuz',
    ...extra,
  };
}

/**
 * V07.2 / V07.3 / V07.4: ranked local search, playability from the resolver,
 * filters, and a slow or broken provider that never hides the others.
 */
describe('unified search', () => {
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'audioserver-search-'));
    await initDatabase(join(dir, 'search.db'));
    const db = getRawDb();
    db.exec(`
      INSERT INTO artists (id, name, source) VALUES ('ar1', 'Band', 'local'), ('ar2', '宇多田ヒカル', 'local');
      INSERT INTO albums (id, title, artist_id, artist_name, source) VALUES ('al1', 'Album', 'ar1', 'Band', 'local'), ('al2', 'First Love', 'ar2', '宇多田ヒカル', 'local');
      INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, duration, format, sample_rate, bit_depth, file_path, source, availability) VALUES
        ('t1', 'Blue', 'al1', 'Album', 'ar1', 'Band', 200, 'flac', 44100, 16, '/m/1.flac', 'local', 'available'),
        ('t2', 'Blue Moon', 'al1', 'Album', 'ar1', 'Band', 210, 'mp3', 44100, 16, '/m/2.mp3', 'local', 'available'),
        ('t3', 'Deep Blue Sea', 'al1', 'Album', 'ar1', 'Band', 220, 'flac', 96000, 24, '/m/3.flac', 'local', 'available'),
        ('t4', 'Blue (Live)', 'al1', 'Album', 'ar1', 'Band', 230, 'flac', 44100, 16, '/m/4.flac', 'local', 'missing'),
        ('t5', 'Automatic', 'al2', 'First Love', 'ar2', '宇多田ヒカル', 300, 'flac', 44100, 16, '/m/5.flac', 'local', 'available');
    `);
  });

  afterAll(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  const forced: Array<{ target: { isAvailable: boolean }; previous: boolean }> = [];
  /** Providers keep `isAvailable` as a plain field their own code rewrites; flip it for one test. */
  function makeAvailable(target: { isAvailable: boolean }): void {
    forced.push({ target, previous: target.isAvailable });
    target.isAvailable = true;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const { target, previous } of forced.splice(0)) target.isAvailable = previous;
  });

  it('ranks exact, then prefix, then contains; missing files sort last within a rank', () => {
    const { tracks } = searchLocal('blue');
    expect(tracks.map((t) => t.id)).toEqual(['t1', 't2', 't4', 't3']);
    expect(tracks.find((t) => t.id === 't4')?.availability).toBe('missing');
  });

  it('finds non-Latin names and escapes LIKE wildcards', () => {
    expect(searchLocal('宇多田').artists.map((a) => a.name)).toEqual(['宇多田ヒカル']);
    expect(searchLocal('%').tracks).toEqual([]);
  });

  it('filters on format and quality', () => {
    expect(searchLocal('blue', { format: 'mp3' }).tracks.map((t) => t.id)).toEqual(['t2']);
    expect(searchLocal('blue', { quality: 'lossless' }).tracks.map((t) => t.id)).toEqual([
      't1',
      't4',
      't3',
    ]);
    expect(searchLocal('blue', { quality: 'hires' }).tracks.map((t) => t.id)).toEqual(['t3']);
  });

  it('derives playability from the resolver and from file availability', () => {
    expect(playabilityFor({ source: 'local', availability: 'available' })).toMatchObject({
      playable: true,
      browser: true,
      server: true,
      external: false,
    });
    expect(playabilityFor({ source: 'local', availability: 'missing' })).toMatchObject({
      playable: false,
      reason: 'missing-file',
    });
    expect(playabilityFor({ source: 'spotify' })).toMatchObject({ external: true });
    expect(playabilityFor({ source: 'tidal' })).toMatchObject({
      playable: false,
      reason: expect.any(String),
    });
  });

  it('parses query filters defensively', () => {
    expect(
      parseSearchOptions({ sources: 'local,qobuz,bogus', quality: 'hires', format: 'FLAC' }),
    ).toEqual({
      sources: ['local', 'qobuz'],
      quality: 'hires',
      format: 'flac',
    });
    expect(parseSearchOptions({ sources: '', quality: 'x', format: '../etc' })).toEqual({});
    expect(parseSearchOptions({ limit: '500', timeoutMs: '100' })).toEqual({ limit: 50 });
  });

  it('a slow provider times out and a broken one errors; local results still arrive', async () => {
    makeAvailable(providers.qobuz);
    vi.spyOn(providers.qobuz, 'search').mockImplementation(
      () => new Promise<SearchResults>(() => {}), // never answers
    );
    makeAvailable(providers.spotify);
    vi.spyOn(providers.spotify, 'search').mockRejectedValue(new Error('rate limited'));

    const results = await unifiedSearch('blue', { timeoutMs: 600 });

    expect(results.tracks.map((t) => t.id)).toContain('t1');
    const status = Object.fromEntries((results.sources ?? []).map((s) => [s.source, s]));
    expect(status.local.status).toBe('ok');
    expect(status.qobuz.status).toBe('timeout');
    expect(status.qobuz.ms).toBeGreaterThanOrEqual(500);
    expect(status.spotify).toMatchObject({ status: 'error', error: 'rate limited' });
    expect(status.tidal.status).toBe('unavailable');
  });

  it('only asks the selected sources and keeps the chosen version with its own id', async () => {
    const localSpy = vi.spyOn(providers.local, 'search');
    makeAvailable(providers.qobuz);
    vi.spyOn(providers.qobuz, 'search').mockResolvedValue({
      ...empty,
      tracks: [
        qobuzTrack('Blue', { duration: 200 }),
        qobuzTrack('Blue', { duration: 230, version: 'Live' }),
      ],
    });

    const results = await unifiedSearch('blue', { sources: ['qobuz'] });
    expect(localSpy).not.toHaveBeenCalled();
    expect((results.sources ?? []).map((s) => s.source)).toEqual(['qobuz']);
    const [studio, live] = results.tracks;
    expect(studio.alternatives?.[0]).toMatchObject({ source: 'qobuz', id: 'qobuz:Blue' });
    expect(live.version).toBe('Live');
    expect(live.playability).toBeDefined();
  });

  it('merges a local file with the same recording at a streaming source and lists both ids', async () => {
    makeAvailable(providers.qobuz);
    vi.spyOn(providers.qobuz, 'search').mockResolvedValue({
      ...empty,
      tracks: [qobuzTrack('Blue', { duration: 202 })],
    });
    const results = await unifiedSearch('blue', { sources: ['local', 'qobuz'] });
    const blue = results.tracks.find((t) => t.id === 't1')!;
    expect(blue.availableOn).toEqual(['local', 'qobuz']);
    expect(blue.alternatives?.map((a) => a.id)).toEqual(['t1', 'qobuz:Blue']);
    // The missing live file is its own result, not merged into the studio take.
    expect(results.tracks.find((t) => t.id === 't4')?.version).toBe('Live');
  });
});
