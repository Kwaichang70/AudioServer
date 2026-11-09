import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, getRawDb, initDatabase } from '../db/index.js';
import {
  getActiveSession,
  heartbeat,
  resetListeningForTests,
  setListeningClock,
  startSession,
  transport,
} from '../services/listening.js';
import { DeviceMonitor } from '../services/device-monitor.js';
import type { DevicePlaybackStatus, OutputDevice } from '@audioserver/shared';

/**
 * Phase 8 (P05, P07, P08): two rooms listen at the same time without taking
 * each other's listens; the device monitor tells only the tabs that watch a
 * speaker, announces only changes, and leaves a Sonos group member alone.
 */

describe('listening in two rooms at once (P07)', () => {
  let dir: string;
  let now = 1_800_000_000_000;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'audioserver-zone-listening-'));
    await initDatabase(join(dir, 'listening.db'));
  });

  afterAll(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  beforeEach(() => {
    resetListeningForTests();
    setListeningClock(() => now);
  });

  afterEach(() => resetListeningForTests());

  const track = (id: string) => ({ id, title: id, artistName: 'Artist', duration: 200 });

  it('keeps one open listen per room', () => {
    const living = startSession(track('living-1'), { zoneId: 'zone-living' });
    now += 30_000;
    heartbeat('zone-living');
    // The kitchen starts a track: the living room's listen must stay open.
    startSession(track('kitchen-1'), { zoneId: 'zone-kitchen' });
    expect(getActiveSession('zone-living')?.id).toBe(living);
    expect(getActiveSession('zone-kitchen')?.trackId).toBe('kitchen-1');

    // Heartbeats credit only their own room.
    now += 20_000;
    heartbeat('zone-kitchen');
    expect(getActiveSession('zone-kitchen')?.listenedMs).toBe(20_000);
    heartbeat('zone-living');
    expect(getActiveSession('zone-living')?.listenedMs).toBe(50_000);

    // Stopping the kitchen closes the kitchen's listen only.
    transport('stopped', null, 'zone-kitchen');
    expect(getActiveSession('zone-kitchen')).toBeNull();
    expect(getActiveSession('zone-living')?.id).toBe(living);

    const rows = getRawDb()
      .prepare('SELECT track_id, status FROM listening_sessions ORDER BY started_at, track_id')
      .all() as Array<{ track_id: string; status: string }>;
    expect(rows).toEqual([
      { track_id: 'living-1', status: 'active' },
      { track_id: 'kitchen-1', status: 'ended' },
    ]);
  });

  it('treats a call without a room as the default room, as before', () => {
    startSession(track('a'));
    now += 10_000;
    heartbeat();
    expect(getActiveSession()?.listenedMs).toBe(10_000);
  });
});

describe('the device monitor', () => {
  const status = (state: DevicePlaybackStatus['state'], position: number, trackUri?: string) => ({
    state,
    position,
    duration: 100,
    volume: 30,
    ...(trackUri ? { trackUri } : {}),
  });

  function build(opts: {
    devices?: OutputDevice[];
    getPlaybackState?: (id: string) => Promise<DevicePlaybackStatus>;
  }) {
    const broadcast: Array<{ event: string; payload: unknown }> = [];
    const rooms: Array<{ room: string; event: string }> = [];
    const setState = vi.fn();
    const monitor = new DeviceMonitor({
      getDevices: async () => opts.devices ?? [],
      getPlaybackState: opts.getPlaybackState ?? (async () => status('playing', 10)),
      getIO: () =>
        ({
          emit: (event: string, payload: unknown) => {
            broadcast.push({ event, payload });
            return true;
          },
          to: (room: string) => ({
            emit: (event: string) => {
              rooms.push({ room, event });
              return true;
            },
          }),
        }) as never,
      playback: { setState },
      logger: { info: vi.fn(), debug: vi.fn() },
      pollTimeoutMs: 50,
    });
    return { monitor, broadcast, rooms, setState };
  }

  it('sends a speaker’s position only to the tabs that watch it (P08)', async () => {
    const { monitor, broadcast, rooms } = build({});
    await monitor.pollDeviceOnce('kitchen');
    expect(rooms).toEqual([{ room: 'device:kitchen', event: 'device:playback-update' }]);
    expect(broadcast.filter((b) => b.event === 'device:playback-update')).toEqual([]);
  });

  it('leaves the room of a Sonos that plays along in a group alone (P07)', async () => {
    const { monitor, setState } = build({
      getPlaybackState: async () => status('playing', 10, 'x-rincon:RINCON_LEADER'),
    });
    await monitor.pollDeviceOnce('member');
    expect(setState).not.toHaveBeenCalled();
  });

  it('announces a lost and a returning speaker once each, not every minute (P05)', async () => {
    let answers = false;
    const devices: OutputDevice[] = [
      { id: 'cocktail', name: 'Cocktail', type: 'dlna', isOnline: true },
    ];
    const { monitor, broadcast } = build({
      devices,
      getPlaybackState: async () => {
        if (!answers) throw new Error('no answer');
        return status('stopped', 0);
      },
    });
    const announced = () => broadcast.map((b) => b.event);

    await monitor.checkHealth();
    await monitor.checkHealth();
    expect(announced()).toEqual(['device:lost']);

    answers = true;
    await monitor.checkHealth();
    await monitor.checkHealth();
    expect(announced()).toEqual(['device:lost', 'device:discovered']);
  });

  it('runs one health check at a time and gives up on a speaker that hangs (P05)', async () => {
    let asked = 0;
    const { monitor, broadcast } = build({
      devices: [{ id: 'stuck', name: 'Stuck', type: 'sonos', isOnline: true }],
      getPlaybackState: () => {
        asked++;
        return new Promise(() => {}); // never answers
      },
    });
    const first = monitor.checkHealth();
    await monitor.checkHealth(); // overlaps the first: skipped
    await first; // ends through the time limit, not never
    expect(asked).toBe(1);
    expect(broadcast.map((b) => b.event)).toEqual(['device:lost']);
  });
});
