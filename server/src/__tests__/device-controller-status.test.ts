import { afterEach, describe, expect, it, vi } from 'vitest';
import { DlnaController } from '../devices/dlna.js';
import { SonosController } from '../devices/sonos.js';
import { VolumioController } from '../devices/volumio.js';

interface StatusController {
  getPlaybackState(deviceId: string): Promise<unknown>;
}

function seedDlna(): { controller: StatusController; deviceId: string } {
  const controller = new DlnaController();
  const deviceId = 'dlna-1';
  (controller as unknown as { devices: Map<string, unknown> }).devices.set(deviceId, {
    id: deviceId,
    name: 'DLNA',
    host: '192.168.1.10',
    controlUrl: 'http://192.168.1.10/AVTransport/Control',
    location: 'http://192.168.1.10/description.xml',
    isOnline: true,
  });
  return { controller, deviceId };
}

function seedSonos(): { controller: StatusController; deviceId: string } {
  const controller = new SonosController();
  const deviceId = 'sonos-1';
  (controller as unknown as { devices: Map<string, unknown> }).devices.set(deviceId, {
    id: deviceId,
    name: 'Sonos',
    host: '192.168.1.11',
    port: 1400,
    isOnline: true,
  });
  return { controller, deviceId };
}

function seedVolumio(): { controller: StatusController; deviceId: string } {
  const controller = new VolumioController();
  const deviceId = 'volumio-1';
  (controller as unknown as { devices: Map<string, unknown> }).devices.set(deviceId, {
    id: deviceId,
    name: 'Volumio',
    host: '192.168.1.12',
    port: 3000,
    isOnline: true,
  });
  return { controller, deviceId };
}

describe('device playback status errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['DLNA', seedDlna],
    ['Sonos', seedSonos],
    ['Volumio', seedVolumio],
  ])('%s propagates an unreachable status endpoint', async (_name, seed) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    const { controller, deviceId } = seed();

    await expect(controller.getPlaybackState(deviceId)).rejects.toThrow('HTTP 503');
  });
});
