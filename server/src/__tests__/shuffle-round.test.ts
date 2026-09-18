import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, getRawDb, initDatabase } from '../db/index.js';
import { PlaybackService, type TrackInfo } from '../services/playback.js';
import { buildShuffleRound, configureShuffle, resetShuffleDeps } from '../services/shuffle.js';

/**
 * Shuffle rounds (V12.3).
 *
 * The acceptance: a shuffle round repeats no queue position while repeat is
 * off. Around that sit two preferences — less recently heard first, and never
 * a track that cannot play.
 */

const track = (id: string): TrackInfo => ({
  id,
  title: id.toUpperCase(),
  artistName: 'Artist',
  albumTitle: 'Album',
});

describe('Building one round', () => {
  afterEach(() => resetShuffleDeps());

  it('leaves out what cannot be played', () => {
    configureShuffle({
      isPlayable: (trackId) => trackId !== 'gone',
      lastHeard: () => new Map(),
    });
    const round = buildShuffleRound([
      { itemId: 'i1', trackId: 'a' },
      { itemId: 'i2', trackId: 'gone' },
      { itemId: 'i3', trackId: 'b' },
    ]);
    expect(round.sort()).toEqual(['i1', 'i3']);
  });

  it('draws what has not been heard lately before what has', () => {
    const now = 1_700_000_000;
    configureShuffle({
      isPlayable: () => true,
      lastHeard: () =>
        new Map([
          ['fresh', now - 200 * 86400],
          ['yesterday', now - 86400],
        ]),
      random: () => 0,
    });
    const round = buildShuffleRound(
      [
        { itemId: 'i-recent', trackId: 'yesterday' },
        { itemId: 'i-old', trackId: 'fresh' },
        { itemId: 'i-never', trackId: 'never-played' },
      ],
      { now },
    );
    expect(round[round.length - 1]).toBe('i-recent');
    expect(round.slice(0, 2).sort()).toEqual(['i-never', 'i-old']);
  });
});

describe('A shuffle round in the queue', () => {
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'audioserver-shuffle-'));
    await initDatabase(join(dir, 'shuffle.db'));
    configureShuffle({ isPlayable: () => true, lastHeard: () => new Map() });
  });

  afterAll(() => {
    resetShuffleDeps();
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  function session(size: number): PlaybackService {
    const service = new PlaybackService(`zone-shuffle-${size}-${Math.random()}`);
    service.setQueue(
      Array.from({ length: size }, (_, i) => track(`t${i}`)),
      0,
    );
    service.setShuffle(true);
    return service;
  }

  it('plays every position once before anything repeats', () => {
    const service = session(6);
    const heard = [service.getQueue()[service.getQueueIndex()].itemId];
    for (let i = 0; i < 5; i += 1) {
      const next = service.advance();
      expect(next).not.toBeNull();
      heard.push(service.getCurrentItemId()!);
    }
    expect(new Set(heard).size).toBe(6);
  });

  it('stops at the end of the round while repeat is off', () => {
    const service = session(3);
    expect(service.advance()).not.toBeNull();
    expect(service.advance()).not.toBeNull();
    // Three positions, one playing plus two advances: the round is done.
    expect(service.advance()).toBeNull();
    expect(service.getState().state).toBe('stopped');
  });

  it('starts a new round on repeat all, not the same track twice in a row', () => {
    const service = session(4);
    service.setRepeat('all');
    const seen: string[] = [service.getCurrentItemId()!];
    for (let i = 0; i < 8; i += 1) {
      service.advance();
      seen.push(service.getCurrentItemId()!);
    }
    expect(seen).toHaveLength(9);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).not.toBe(seen[i - 1]);
    }
    // Two full rounds of four: everything was heard at least twice.
    const counts = new Map<string, number>();
    for (const id of seen) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect([...counts.values()].every((n) => n >= 2)).toBe(true);
  });

  it('keeps what was already heard out of the round after a queue edit', () => {
    const service = session(4);
    const first = service.getCurrentItemId()!;
    service.advance();
    const second = service.getCurrentItemId()!;
    service.addToQueue(track('extra'));

    const rest: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      service.advance();
      const id = service.getCurrentItemId();
      if (id) rest.push(id);
    }
    expect(rest).not.toContain(first);
    expect(rest).not.toContain(second);
    expect(new Set(rest).size).toBe(rest.length);
  });

  it('never chooses a track whose file is missing', () => {
    const db = getRawDb();
    db.prepare('INSERT OR IGNORE INTO artists (id, name) VALUES (?, ?)').run('ar', 'Artist');
    db.prepare(
      'INSERT OR IGNORE INTO albums (id, title, artist_id, artist_name) VALUES (?, ?, ?, ?)',
    ).run('al', 'Album', 'ar', 'Artist');
    const insert = db.prepare(
      `INSERT OR REPLACE INTO tracks (id, title, album_id, album_title, artist_id, artist_name, availability)
       VALUES (?, ?, 'al', 'Album', 'ar', 'Artist', ?)`,
    );
    insert.run('here', 'Here', 'available');
    insert.run('lost', 'Lost', 'missing');
    resetShuffleDeps();

    const service = new PlaybackService('zone-missing');
    service.setQueue([track('here'), track('lost')], 0);
    service.setShuffle(true);
    service.setRepeat('all');
    for (let i = 0; i < 4; i += 1) {
      service.advance();
      expect(service.getCurrentTrack()?.id).toBe('here');
    }
    configureShuffle({ isPlayable: () => true, lastHeard: () => new Map() });
  });
});
