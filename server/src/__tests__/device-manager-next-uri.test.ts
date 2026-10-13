import { describe, expect, it } from 'vitest';
import { DeviceManager } from '../devices/manager.js';

/**
 * R09.4: a speaker without "take the next track in advance" must say so. A
 * quiet return made the server believe Volumio had the next track, wait for
 * it to start by itself, and leave the room silent after one track.
 */
describe('Handing the next track to a speaker', () => {
  it('refuses for Volumio instead of pretending it worked', async () => {
    const manager = new DeviceManager();
    (manager as unknown as { cachedDevices: unknown[] }).cachedDevices = [
      { id: 'volumio-10.0.0.9', name: 'Volumio (10.0.0.9)', type: 'volumio', isOnline: true },
    ];
    await expect(
      manager.setNextUri('volumio-10.0.0.9', 'http://nas/stream/t2', { title: 'Two' } as never),
    ).rejects.toThrow(/does not take the next track in advance/);
  });

  it('still does nothing for the browser, which plays its own queue', async () => {
    const manager = new DeviceManager();
    await expect(manager.setNextUri('browser', 'http://nas/stream/t2')).resolves.toBeUndefined();
  });
});
