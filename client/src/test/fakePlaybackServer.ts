import type { PlaybackQueueEntry, PlaybackSnapshot } from '../api/types.js';

/**
 * In-memory stand-in for the server's playback session (V03), for client
 * tests. Implements the same contract as server/src/services/playback.ts:
 * items with stable ids, a revision, a current item, shuffle/repeat, and
 * snapshot responses for every command.
 */
export function createFakePlaybackServer() {
  let queue: PlaybackQueueEntry[] = [];
  let index = -1;
  let revision = 0;
  let shuffle = false;
  let repeat: 'off' | 'all' | 'one' = 'off';
  let state: 'playing' | 'paused' | 'stopped' = 'stopped';
  let deviceId = 'browser';
  let seq = 0;

  const entry = (t: Record<string, unknown>, position: number): PlaybackQueueEntry => ({
    itemId: `item-${++seq}`,
    trackId: String(t.id),
    trackTitle: String(t.title ?? ''),
    artistName: String(t.artistName ?? ''),
    albumTitle: String(t.albumTitle ?? ''),
    albumId: t.albumId as string | undefined,
    duration: t.duration as number | undefined,
    source: t.source as string | undefined,
    metadata: t.metadata as Record<string, unknown> | undefined,
    position,
  });

  const current = () => queue[index] ?? null;

  const snapshot = (): PlaybackSnapshot => {
    const cur = current();
    return {
      revision,
      queue: queue.map((q, i) => ({ ...q, position: i })),
      currentItemId: cur?.itemId ?? null,
      queueIndex: index,
      state: {
        track: cur
          ? ({
              id: cur.trackId,
              title: cur.trackTitle,
              artistName: cur.artistName,
              albumTitle: cur.albumTitle,
              albumId: cur.albumId ?? '',
              artistId: '',
              source: 'local',
            } as PlaybackSnapshot['state']['track'])
          : null,
        state,
        position: 0,
        duration: cur?.duration ?? 0,
        volume: 50,
        deviceId,
      },
      shuffle,
      repeat,
      controller: { clientId: 'me', deviceId },
    };
  };

  const respond = () => Promise.resolve({ data: snapshot() });

  const api = {
    getPlaybackSession: () => respond(),
    setServerQueue: (
      tracks: Record<string, unknown>[],
      startIndex: number,
      device: string,
      sh: boolean,
      rp: 'off' | 'all' | 'one',
    ) => {
      queue = tracks.map(entry);
      index = queue.length ? Math.min(startIndex, queue.length - 1) : -1;
      deviceId = device;
      shuffle = sh;
      repeat = rp;
      state = queue.length ? 'playing' : 'stopped';
      revision++;
      return respond();
    },
    addToQueue: (track: Record<string, unknown>) => {
      queue.push(entry(track, queue.length));
      revision++;
      return respond();
    },
    removeFromQueue: (itemId: string) => {
      const i = queue.findIndex((q) => q.itemId === itemId);
      if (i >= 0) {
        queue.splice(i, 1);
        if (i <= index) index--;
        if (index >= queue.length) index = queue.length - 1;
      }
      revision++;
      return respond();
    },
    moveInQueue: (itemId: string, to: number) => {
      const from = queue.findIndex((q) => q.itemId === itemId);
      if (from >= 0) {
        const [item] = queue.splice(from, 1);
        queue.splice(to, 0, item);
        if (index === from) index = to;
        else if (from < index && to >= index) index--;
        else if (from > index && to <= index) index++;
      }
      revision++;
      return respond();
    },
    clearQueue: () => {
      queue = [];
      index = -1;
      revision++;
      return respond();
    },
    playQueueItem: (itemId: string) => {
      const i = queue.findIndex((q) => q.itemId === itemId);
      if (i < 0) return Promise.reject(new Error('not found'));
      index = i;
      state = 'playing';
      revision++;
      return respond();
    },
    playbackNext: () => {
      if (queue.length === 0) {
        state = 'stopped';
        return respond();
      }
      if (repeat === 'one') {
        state = 'playing';
        revision++;
        return respond();
      }
      let next: number;
      if (shuffle) {
        next = Math.floor(Math.random() * queue.length);
        if (next === index && queue.length > 1) next = (next + 1) % queue.length;
      } else {
        next = index + 1;
      }
      if (next >= queue.length) {
        if (repeat === 'all') next = 0;
        else {
          state = 'stopped';
          revision++;
          return respond();
        }
      }
      index = next;
      state = 'playing';
      revision++;
      return respond();
    },
    playbackPrevious: () => {
      if (index > 0) index--;
      state = 'playing';
      revision++;
      return respond();
    },
    setShuffle: (v: boolean) => {
      shuffle = v;
      revision++;
      return Promise.resolve({});
    },
    setRepeat: (v: 'off' | 'all' | 'one') => {
      repeat = v;
      revision++;
      return Promise.resolve({});
    },
    play: () => Promise.resolve({}),
    stop: () => {
      state = 'stopped';
      return Promise.resolve({});
    },
  };

  return {
    api,
    snapshot,
    get index() {
      return index;
    },
    get queue() {
      return queue;
    },
  };
}
