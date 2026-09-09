import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceMonitor } from '../services/device-monitor.js';
import type { DevicePlaybackStatus, OutputDevice } from '@audioserver/shared';
import type { DispatchStatus } from '../types/socket-events.js';

function makeStatus(
  state: DevicePlaybackStatus['state'],
  position: number,
  duration = 120,
): DevicePlaybackStatus {
  return { state, position, duration, volume: 40 };
}

function makeMonitor(
  statuses: Array<DevicePlaybackStatus | Error | (() => Promise<DevicePlaybackStatus>)>,
  activeDeviceId?: string,
  extra: {
    onUnreachable?: (deviceId: string, errors: number) => void;
    pollTimeoutMs?: number;
    endGraceSeconds?: number;
    startGraceMs?: number;
    getDispatch?: () => DispatchStatus;
  } = {},
) {
  const emit = vi.fn();
  const setState = vi.fn();
  const getPlaybackState = vi.fn(async () => {
    const next = statuses.shift();
    if (!next) throw new Error('No more statuses queued');
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    return next;
  });

  const monitor = new DeviceMonitor({
    getDevices: vi.fn(async (): Promise<OutputDevice[]> => []),
    getPlaybackState,
    getIO: () => ({ emit }),
    playback: {
      setState,
      ...(activeDeviceId ? { getActiveDeviceId: () => activeDeviceId } : {}),
      ...(extra.getDispatch ? { getDispatch: extra.getDispatch } : {}),
    },
    logger: { info: vi.fn(), debug: vi.fn() },
    ...extra,
  });

  return { monitor, emit, setState, getPlaybackState };
}

describe('DeviceMonitor realtime sync', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('feeds the UI for a non-active device but never touches the session (V03.3)', async () => {
    const { monitor, emit, setState } = makeMonitor(
      [makeStatus('playing', 12), makeStatus('stopped', 119)],
      'living-room',
    );

    await monitor.pollDeviceOnce('kitchen');
    await monitor.pollDeviceOnce('kitchen');

    expect(emit).toHaveBeenCalledTimes(2);
    expect(setState).not.toHaveBeenCalled();
  });

  it('still syncs the active device', async () => {
    const { monitor, setState } = makeMonitor([makeStatus('playing', 12)], 'living-room');
    await monitor.pollDeviceOnce('living-room');
    expect(setState).toHaveBeenCalledWith({
      deviceId: 'living-room',
      state: 'playing',
      position: 12,
    });
  });

  it('emits device updates and mirrors playing state into PlaybackService', async () => {
    const { monitor, emit, setState } = makeMonitor([makeStatus('playing', 12)]);

    await monitor.pollDeviceOnce('device-1');

    expect(emit).toHaveBeenCalledWith('device:playback-update', {
      deviceId: 'device-1',
      state: 'playing',
      position: 12,
      duration: 120,
      volume: 40,
    });
    expect(setState).toHaveBeenCalledWith({
      deviceId: 'device-1',
      state: 'playing',
      position: 12,
    });
  });

  it('mirrors external pause into PlaybackService', async () => {
    const { monitor, setState } = makeMonitor([
      makeStatus('playing', 20),
      makeStatus('paused', 21),
    ]);

    await monitor.pollDeviceOnce('device-1');
    await monitor.pollDeviceOnce('device-1');

    expect(setState).toHaveBeenLastCalledWith({
      deviceId: 'device-1',
      state: 'paused',
      position: 21,
    });
  });

  it('marks completed tracks at duration so PlaybackService can advance the queue', async () => {
    const { monitor, setState } = makeMonitor([
      makeStatus('playing', 119),
      makeStatus('stopped', 0),
    ]);

    await monitor.pollDeviceOnce('device-1');
    await monitor.pollDeviceOnce('device-1');

    expect(setState).toHaveBeenLastCalledWith({
      deviceId: 'device-1',
      state: 'stopped',
      position: 120,
      ended: true,
    });
  });

  it('does not treat a manual stop before the end as queue completion', async () => {
    const { monitor, setState } = makeMonitor([
      makeStatus('playing', 20),
      makeStatus('stopped', 0),
    ]);

    await monitor.pollDeviceOnce('device-1');
    await monitor.pollDeviceOnce('device-1');

    expect(setState).toHaveBeenLastCalledWith({
      deviceId: 'device-1',
      state: 'stopped',
      position: 0,
    });
  });

  it('advances when the renderer resets its counters at the end of a track', async () => {
    // The real failure Danny hit: polls are 2 s apart and only stored when the
    // position moves more than 3 s, so the last confirmed sample can be ~5 s
    // short of the end — and a DLNA renderer reports 0:00/0:00 when it stops.
    const { monitor, setState } = makeMonitor([
      makeStatus('playing', 114, 120),
      makeStatus('stopped', 0, 0),
    ]);

    await monitor.pollDeviceOnce('device-1');
    await monitor.pollDeviceOnce('device-1');

    expect(setState).toHaveBeenLastCalledWith({
      deviceId: 'device-1',
      state: 'stopped',
      position: 120,
      ended: true,
    });
  });

  it('ignores a stopped report while a just-dispatched track is still loading', async () => {
    const dispatch = (): DispatchStatus => ({
      state: 'loading',
      deviceId: 'device-1',
      itemId: 'item-1',
      trackId: 'track-1',
      attempts: 1,
      updatedAt: Date.now(),
    });
    const { monitor, setState } = makeMonitor([makeStatus('stopped', 0, 0)], undefined, {
      getDispatch: dispatch,
    });

    await monitor.pollDeviceOnce('device-1');

    expect(setState).not.toHaveBeenCalled();
  });

  it('does not carry the previous track\u2019s end position into the next one', async () => {
    const { monitor, setState } = makeMonitor([
      makeStatus('playing', 118, 120),
      makeStatus('playing', 3, 240),
      makeStatus('stopped', 0, 0),
    ]);

    await monitor.pollDeviceOnce('device-1');
    await monitor.pollDeviceOnce('device-1');
    await monitor.pollDeviceOnce('device-1');

    expect(setState).toHaveBeenLastCalledWith({
      deviceId: 'device-1',
      state: 'stopped',
      position: 0,
    });
  });

  it('propagates an unreachable device without publishing a false stopped state', async () => {
    const { monitor, emit, setState } = makeMonitor([new Error('device offline')]);

    await expect(monitor.pollDeviceOnce('device-1')).rejects.toThrow('device offline');
    expect(emit).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });
});

describe('DeviceMonitor bounded polling (V04.3)', () => {
  it('never overlaps polls of the same device', async () => {
    let release: (() => void) | null = null;
    const slow = () =>
      new Promise<DevicePlaybackStatus>((resolve) => {
        release = () => resolve(makeStatus('playing', 5));
      });
    const { monitor, getPlaybackState } = makeMonitor([slow, makeStatus('playing', 7)]);

    const first = monitor.tick('device-1');
    await monitor.tick('device-1'); // returns immediately: previous still in flight
    expect(getPlaybackState).toHaveBeenCalledTimes(1);
    release!();
    await first;
    await monitor.tick('device-1');
    expect(getPlaybackState).toHaveBeenCalledTimes(2);
  });

  it('treats a status request slower than the timeout as a failure', async () => {
    const never = () => new Promise<DevicePlaybackStatus>(() => {});
    const { monitor, emit } = makeMonitor([never], undefined, { pollTimeoutMs: 20 });
    await monitor.tick('device-1');
    expect(emit).not.toHaveBeenCalled();
  });

  it('tells the server player when a pinned device stays unreachable', async () => {
    const onUnreachable = vi.fn();
    const failures = Array.from({ length: 10 }, () => new Error('offline'));
    const { monitor } = makeMonitor(failures, 'device-1', { onUnreachable, pollTimeoutMs: 50 });
    monitor.pin('device-1');
    for (let i = 0; i < 10; i++) await monitor.tick('device-1');
    expect(onUnreachable).toHaveBeenCalledTimes(1);
    expect(onUnreachable).toHaveBeenCalledWith('device-1', 10);
    expect(monitor.isPinned('device-1')).toBe(false);
    monitor.stopAll();
  });

  it('gives an unpinned device only one failure', async () => {
    const onUnreachable = vi.fn();
    const { monitor, emit } = makeMonitor(
      [new Error('offline'), makeStatus('playing', 1)],
      undefined,
      {
        onUnreachable,
      },
    );
    monitor.subscribe('device-1');
    await monitor.tick('device-1');
    expect(onUnreachable).not.toHaveBeenCalled(); // not pinned → no session impact
    expect(emit).not.toHaveBeenCalled();
    monitor.stopAll();
  });
});
