import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getRawDb, initDatabase } from '../db/index.js';

/**
 * R01.1 — "play next", "add to queue" and seeking on a speaker.
 *
 * The queue rules are the interesting half: an insert must land behind the
 * item that is playing without disturbing it, and repeated inserts must keep
 * the order the listener asked for. Seek is the other half: a speaker has to
 * be asked, it may refuse, and the answer must be honest instead of a UI that
 * jumps to a position the speaker never went to.
 */

const seekCalls: Array<{ deviceId: string; position: number }> = [];
let seekBehaviour: 'ok' | 'no-method' | 'refuses' = 'ok';
let capabilitySeek: 'supported' | 'unsupported' | 'unknown' = 'supported';
const seekFailures: string[] = [];

vi.mock('../devices/manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../devices/manager.js')>();
  const original = actual.deviceManager;
  return {
    ...actual,
    deviceManager: new Proxy(original, {
      get(target, prop, receiver) {
        if (prop === 'seek') {
          return async (deviceId: string, position: number) => {
            seekCalls.push({ deviceId, position });
            if (seekBehaviour === 'no-method') return false;
            if (seekBehaviour === 'refuses') throw new Error('Play:1 refused Seek');
            return true;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
});

vi.mock('../services/output-capabilities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/output-capabilities.js')>();
  return {
    ...actual,
    supportsSeek: async () => capabilitySeek !== 'unsupported',
    noteSeekFailed: (deviceId: string) => {
      seekFailures.push(deviceId);
    },
  };
});

// The server player would try to reach a real speaker when a queue is set on
// one; these tests are about the queue and the seek answer, not dispatch.
vi.mock('../services/server-player.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/server-player.js')>();
  return {
    ...actual,
    startServerPlayback: () => {},
    stopServerPlayback: () => {},
  };
});

const { playbackRouter } = await import('../routes/playback.js');
const { playbackService } = await import('../services/playback.js');
const { initSocketIO } = await import('../socketio.js');

let server: Server;
let baseUrl: string;
let tmp: string | null = null;

const track = (id: string, title: string, duration = 200) => ({
  id,
  title,
  artistName: 'Artist',
  albumTitle: 'Album',
  albumId: 'a1',
  duration,
});

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'audioserver-queue-insert-test-'));
  await initDatabase(join(tmp, 'test.db'));
  playbackService.initialize();

  const app = express();
  app.use(express.json());
  app.use('/api/playback', playbackRouter);
  server = createServer(app);
  initSocketIO(server);
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
  try {
    getRawDb().close();
  } catch {
    // already closed
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

interface Snapshot {
  revision: number;
  queueIndex: number;
  queue: Array<{ trackTitle: string }>;
  state: { state: string; position: number; track: { id: string } | null };
}

async function post(path: string, body?: unknown, client = 'tab-a') {
  const res = await fetch(`${baseUrl}/api/playback${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': client },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    body: (await res.json()) as { data?: Snapshot; error?: string; message?: string },
  };
}

async function session(): Promise<Snapshot> {
  const res = await fetch(`${baseUrl}/api/playback/session`);
  return ((await res.json()) as { data: Snapshot }).data;
}

/** Titles of the queue, in order — the only thing most of these tests care about. */
async function queueTitles(): Promise<string[]> {
  return (await session()).queue.map((item) => item.trackTitle);
}

beforeEach(async () => {
  seekCalls.length = 0;
  seekFailures.length = 0;
  seekBehaviour = 'ok';
  capabilitySeek = 'supported';
  // Emptying the queue lets the current track finish (the clear contract), so
  // the transport has to be stopped too, or a test would inherit "playing".
  await post('/queue/set', { tracks: [], play: false, deviceId: 'browser' });
  await post('/stop');
  await post('/shuffle', { shuffle: false });
  await post('/repeat', { repeat: 'off' });
});

describe('play next and add to queue (R01.1)', () => {
  it('puts a track straight after the one playing', async () => {
    await post('/queue/set', { tracks: [track('t1', 'One'), track('t2', 'Two')] });

    await post('/queue/add', { track: track('t9', 'Jumped'), position: 'next' });

    expect(await queueTitles()).toEqual(['One', 'Jumped', 'Two']);
  });

  it('keeps the current track playing and current', async () => {
    await post('/queue/set', { tracks: [track('t1', 'One'), track('t2', 'Two')] });
    await post('/queue/add', { track: track('t9', 'Jumped'), position: 'next' });

    const snap = await session();
    expect(snap.queueIndex).toBe(0);
    expect(snap.state.track?.id).toBe('t1');
    expect(snap.state.state).toBe('playing');
  });

  it('stacks repeated inserts, the newest closest to what plays', async () => {
    await post('/queue/set', { tracks: [track('t1', 'One'), track('t2', 'Two')] });

    await post('/queue/add', { track: track('t8', 'First choice'), position: 'next' });
    await post('/queue/add', { track: track('t9', 'Second choice'), position: 'next' });

    expect(await queueTitles()).toEqual(['One', 'Second choice', 'First choice', 'Two']);
  });

  it('adds a whole album behind the current track in album order', async () => {
    await post('/queue/set', { tracks: [track('t1', 'One'), track('t2', 'Two')] });

    await post('/queue/add', {
      tracks: [track('a1', 'Side A'), track('a2', 'Side B')],
      position: 'next',
    });

    expect(await queueTitles()).toEqual(['One', 'Side A', 'Side B', 'Two']);
  });

  it('appends at the end by default', async () => {
    await post('/queue/set', { tracks: [track('t1', 'One'), track('t2', 'Two')] });

    await post('/queue/add', { track: track('t9', 'Last') });

    expect(await queueTitles()).toEqual(['One', 'Two', 'Last']);
  });

  it('appends a whole album at the end without moving the current track', async () => {
    await post('/queue/set', { tracks: [track('t1', 'One'), track('t2', 'Two')] });

    await post('/queue/add', { tracks: [track('a1', 'Side A'), track('a2', 'Side B')] });

    expect(await queueTitles()).toEqual(['One', 'Two', 'Side A', 'Side B']);
    expect((await session()).queueIndex).toBe(0);
  });

  it('puts "play next" at the front of an idle queue without starting it', async () => {
    await post('/queue/add', { track: track('t9', 'Alone'), position: 'next' });

    expect(await queueTitles()).toEqual(['Alone']);
    expect((await session()).state.state).toBe('stopped');
  });

  it('refuses a request with neither a track nor tracks', async () => {
    const { status } = await post('/queue/add', { position: 'next' });
    expect(status).toBe(400);
  });

  it('applies a repeated command id only once', async () => {
    await post('/queue/set', { tracks: [track('t1', 'One')] });

    await post('/queue/add', { track: track('t9', 'Once'), position: 'next', commandId: 'cmd-1' });
    await post('/queue/add', { track: track('t9', 'Once'), position: 'next', commandId: 'cmd-1' });

    expect(await queueTitles()).toEqual(['One', 'Once']);
  });

  it('bumps the revision so other clients re-read the queue', async () => {
    await post('/queue/set', { tracks: [track('t1', 'One')] });
    const before = (await session()).revision;

    await post('/queue/add', { track: track('t9', 'New'), position: 'next' });

    expect((await session()).revision).toBeGreaterThan(before);
  });

  it('advances into the inserted track when the current one ends', async () => {
    await post('/queue/set', { tracks: [track('t1', 'One'), track('t2', 'Two')] });
    await post('/queue/add', { track: track('t9', 'Jumped'), position: 'next' });

    const { body } = await post('/next');

    expect(body.data?.state.track?.id).toBe('t9');
  });
});

describe('seek (R01.1)', () => {
  it('records the position for the browser without asking any device', async () => {
    await post('/queue/set', { tracks: [track('t1', 'One', 300)], deviceId: 'browser' });

    const { status, body } = await post('/seek', { position: 42 });

    expect(status).toBe(200);
    expect(body.data?.state.position).toBe(42);
    expect(seekCalls).toHaveLength(0);
  });

  it('asks the speaker when the room plays on one', async () => {
    await post('/queue/set', { tracks: [track('t1', 'One', 300)], deviceId: 'speaker-1' });

    const { status, body } = await post('/seek', { position: 90 });

    expect(status).toBe(200);
    expect(seekCalls).toEqual([{ deviceId: 'speaker-1', position: 90 }]);
    expect(body.data?.state.position).toBe(90);
  });

  it('refuses without asking when the output says it has no Seek', async () => {
    await post('/queue/set', { tracks: [track('t1', 'One', 300)], deviceId: 'speaker-1' });
    capabilitySeek = 'unsupported';

    const { status, body } = await post('/seek', { position: 90 });

    expect(status).toBe(409);
    expect(body.error).toBe('SeekUnsupported');
    expect(seekCalls).toHaveLength(0);
  });

  it('reports a refused seek and remembers that the output cannot do it', async () => {
    await post('/queue/set', { tracks: [track('t1', 'One', 300)], deviceId: 'speaker-1' });
    seekBehaviour = 'refuses';

    const { status, body } = await post('/seek', { position: 90 });

    expect(status).toBe(502);
    expect(body.message).toMatch(/refused/i);
    expect(seekFailures).toContain('speaker-1');
  });

  it('does not move the recorded position when the speaker refuses', async () => {
    await post('/queue/set', { tracks: [track('t1', 'One', 300)], deviceId: 'speaker-1' });
    seekBehaviour = 'refuses';

    await post('/seek', { position: 90 });

    expect((await session()).state.position).not.toBe(90);
  });

  it('treats a controller without the method as unsupported', async () => {
    await post('/queue/set', { tracks: [track('t1', 'One', 300)], deviceId: 'speaker-1' });
    seekBehaviour = 'no-method';

    const { status } = await post('/seek', { position: 90 });

    expect(status).toBe(409);
    expect(seekFailures).toContain('speaker-1');
  });

  it('keeps a jump inside the track, so it never acts as a skip', async () => {
    await post('/queue/set', {
      tracks: [track('t1', 'One', 300), track('t2', 'Two', 300)],
      deviceId: 'browser',
    });

    const { body } = await post('/seek', { position: 5000 });

    expect(body.data?.state.position).toBeLessThan(300);
    expect(body.data?.state.track?.id).toBe('t1');
  });

  it('refuses a negative position at the boundary', async () => {
    const { status } = await post('/seek', { position: -5 });
    expect(status).toBe(400);
  });
});

/**
 * R01.4 — "play next" is a promise, and it has to hold where the queue order
 * alone does not decide: under shuffle (the next index is random) and under
 * repeat-one (the current track would loop). Twenty shuffled albums of ten
 * tracks would otherwise hit the inserted track only one time in ten.
 */
describe('play next keeps its promise (R01.4)', () => {
  const album = Array.from({ length: 10 }, (_, i) => track(`s${i}`, `Song ${i}`));

  it('plays the inserted track next even with shuffle on', async () => {
    await post('/queue/set', { tracks: album });
    await post('/shuffle', { shuffle: true });

    for (let round = 0; round < 20; round++) {
      await post('/queue/add', { track: track(`n${round}`, `Next ${round}`), position: 'next' });
      const { body } = await post('/next');
      expect(body.data?.state.track?.id).toBe(`n${round}`);
    }
  });

  it('plays a whole inserted album in order under shuffle, then shuffles again', async () => {
    await post('/queue/set', { tracks: album });
    await post('/shuffle', { shuffle: true });

    await post('/queue/add', {
      tracks: [track('a1', 'Side A'), track('a2', 'Side B'), track('a3', 'Side C')],
      position: 'next',
    });

    const played: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { body } = await post('/next');
      played.push(body.data?.state.track?.id ?? '');
    }
    expect(played).toEqual(['a1', 'a2', 'a3']);
  });

  it('wins over repeat-one, because it was asked for explicitly', async () => {
    await post('/queue/set', { tracks: [track('t1', 'One'), track('t2', 'Two')] });
    await post('/repeat', { repeat: 'one' });

    await post('/queue/add', { track: track('t9', 'Asked for'), position: 'next' });
    const first = await post('/next');
    const second = await post('/next');

    expect(first.body.data?.state.track?.id).toBe('t9');
    // After the promise is kept, repeat-one loops the track that now plays.
    expect(second.body.data?.state.track?.id).toBe('t9');
  });

  it('skips a promised track that was removed again', async () => {
    await post('/queue/set', { tracks: [track('t1', 'One'), track('t2', 'Two')] });
    await post('/shuffle', { shuffle: true });
    const { body } = await post('/queue/add', {
      track: track('t9', 'Changed my mind'),
      position: 'next',
    });
    const inserted = (
      body.data as unknown as { queue: Array<{ itemId: string; trackId: string }> }
    ).queue.find((item) => item.trackId === 't9');

    await post('/queue/remove', { itemId: inserted?.itemId });
    const next = await post('/next');

    expect(next.body.data?.state.track?.id).not.toBe('t9');
  });

  it('offers the promised track for a gapless handover, even under shuffle', async () => {
    await post('/queue/set', { tracks: album });
    await post('/shuffle', { shuffle: true });

    await post('/queue/add', { track: track('t9', 'Handed over'), position: 'next' });

    expect(playbackService.peekNext()?.track.id).toBe('t9');
  });

  it('forgets the promise when the queue is replaced', async () => {
    await post('/queue/set', { tracks: [track('t1', 'One')] });
    await post('/queue/add', { track: track('t9', 'Old promise'), position: 'next' });

    await post('/queue/set', { tracks: [track('x1', 'New'), track('x2', 'Newer')] });
    const { body } = await post('/next');

    expect(body.data?.state.track?.id).toBe('x2');
  });

  it('lands behind the current track for a client that saw an older queue', async () => {
    // "Play next" is relative to what plays NOW, which only the server knows,
    // so it is deliberately not refused for a stale revision: a client that
    // missed an edit still gets its track in the right place.
    await post('/queue/set', { tracks: [track('t1', 'One'), track('t2', 'Two')] }, 'tab-a');
    const stale = (await session()).revision;
    await post('/next', undefined, 'tab-b'); // another tab moves on to Two

    const { status } = await post(
      '/queue/add',
      { track: track('t9', 'From tab A'), position: 'next', expectedRevision: stale },
      'tab-a',
    );

    expect(status).toBe(200);
    expect(await queueTitles()).toEqual(['One', 'Two', 'From tab A']);
  });

  it('keeps inserts from two tabs in the order they arrived', async () => {
    await post('/queue/set', { tracks: [track('t1', 'One'), track('t2', 'Two')] }, 'tab-a');

    await post('/queue/add', { track: track('ta', 'From A'), position: 'next' }, 'tab-a');
    await post('/queue/add', { track: track('tb', 'From B'), position: 'next' }, 'tab-b');

    expect(await queueTitles()).toEqual(['One', 'From B', 'From A', 'Two']);
  });
});
