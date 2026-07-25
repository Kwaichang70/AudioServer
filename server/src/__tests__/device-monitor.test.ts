import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceMonitor } from '../services/device-monitor.js';
import type { DevicePlaybackStatus, OutputDevice } from '@audioserver/shared';

function makeStatus(
  state: DevicePlaybackStatus['state'],
  position: number,
  duration = 120,
): DevicePlaybackStatus {
  return { state, position, duration, volume: 40 };
}

function makeMonitor(statuses: Array<DevicePlaybackStatus | Error>) {
  const emit = vi.fn();
  const setState = vi.fn();
  const getPlaybackState = vi.fn(async () => {
    const next = statuses.shift();
    if (!next) throw new Error('No more statuses queued');
    if (next instanceof Error) throw next;
    return next;
  });

  const monitor = new DeviceMonitor({
    getDevices: vi.fn(async (): Promise<OutputDevice[]> => []),
    getPlaybackState,
    getIO: () => ({ emit }),
    playback: { setState },
    logger: { info: vi.fn(), debug: vi.fn() },
  });

  return { monitor, emit, setState, getPlaybackState };
}

describe('DeviceMonitor realtime sync', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

  it('propagates an unreachable device without publishing a false stopped state', async () => {
    const { monitor, emit, setState } = makeMonitor([new Error('device offline')]);

    await expect(monitor.pollDeviceOnce('device-1')).rejects.toThrow('device offline');
    expect(emit).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });
});
