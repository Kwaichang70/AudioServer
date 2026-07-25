import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getRawDb, initDatabase } from '../db/index.js';
import { scrobbler } from '../services/scrobbler.js';

describe('scrobbler queue processing', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'audioserver-scrobbler-'));
    await initDatabase(join(tempDir, 'test.db'));
    scrobbler.saveConfig({ listenbrainzEnabled: true, listenbrainzToken: 'token' });
  });

  afterAll(() => {
    getRawDb().close();
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('coalesces concurrent queue flushes so a row is submitted once', async () => {
    getRawDb()
      .prepare(
        `INSERT INTO scrobble_queue
          (service, track_title, artist_name, album_title, duration, timestamp)
         VALUES ('listenbrainz', 'Track', 'Artist', 'Album', 180, 1234567890)`,
      )
      .run();

    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = scrobbler.flush();
    const second = scrobbler.flush();
    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(new Response('{}', { status: 200 }));
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getRawDb().prepare('SELECT status FROM scrobble_queue').pluck().get()).toBe('sent');
  });
});
