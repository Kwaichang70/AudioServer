import { afterEach, describe, expect, it, vi } from 'vitest';
import xml2js from 'xml2js';
import type { DeviceController, OutputDevice, TrackMetadata } from '@audioserver/shared';
import { DlnaController } from '../devices/dlna.js';
import { SonosController } from '../devices/sonos.js';
import { DeviceManager, DeviceUnavailableError } from '../devices/manager.js';
import { DiscoveryRoster, MISSED_ROUNDS_BEFORE_DROP } from '../devices/retention.js';

/**
 * Phase 8, the device layer: metadata a speaker can read (P04), commands
 * that stop when the caller gave up (P06), speakers that survive one lost
 * discovery answer (P01), and one parallel search instead of three in a
 * row (P10).
 */

const STREAM = 'http://nas:3001/api/library/tracks/t1/stream?t=abc&zone=zone-kitchen';
const META: TrackMetadata = {
  title: 'Rock & Roll <Live>',
  artist: 'Simon & Garfunkel',
  album: 'Bridge "Over"',
};

interface SoapCall {
  action: string;
  args: Record<string, string>;
}

/** Capture every SOAP request; answer as a renderer that is already where we want it. */
function captureSoap(): SoapCall[] {
  const calls: SoapCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { body?: string; headers?: Record<string, string> }) => {
      const action = /#(\w+)"/.exec(init?.headers?.SOAPAction ?? '')?.[1] ?? '?';
      const parsed = await xml2js.parseStringPromise(init?.body ?? '');
      const body = parsed['s:Envelope']['s:Body'][0];
      const node = body[Object.keys(body)[0]][0];
      const args: Record<string, string> = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === '$') continue;
        args[k] = String((v as unknown[])[0] ?? '');
      }
      calls.push({ action, args });
      return new Response(
        '<CurrentTransportState>STOPPED</CurrentTransportState><CurrentTransportState>PLAYING</CurrentTransportState>',
      );
    }),
  );
  return calls;
}

/** The DIDL-Lite a speaker receives, read as a speaker reads it. */
async function readDidl(text: string) {
  const didl = await xml2js.parseStringPromise(text);
  const item = didl['DIDL-Lite'].item[0];
  return {
    title: item['dc:title'][0],
    artist: item['upnp:artist'][0],
    album: item['upnp:album'][0],
    res: typeof item.res[0] === 'string' ? item.res[0] : item.res[0]._,
  };
}

function withDevice<T extends object>(controller: T, device: Record<string, unknown>): T {
  (controller as unknown as { devices: Map<string, unknown> }).devices.set(
    device.id as string,
    device,
  );
  return controller;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('metadata handed to a speaker (P04)', () => {
  const expectReadable = async (text: string | undefined) => {
    expect(text).toBeTruthy();
    expect(text).not.toContain('&lt;DIDL'); // XML, not escaped text
    expect(await readDidl(text!)).toEqual({
      title: META.title,
      artist: META.artist,
      album: META.album,
      res: STREAM,
    });
  };

  it('is valid DIDL-Lite on Sonos, for the current and the next track', async () => {
    const calls = captureSoap();
    const sonos = withDevice(new SonosController(), {
      id: 'RINCON_1',
      name: 'Kitchen',
      host: '10.0.0.5',
      port: 1400,
      isOnline: true,
    });
    await sonos.play('RINCON_1', STREAM, META);
    await sonos.setNextUri('RINCON_1', STREAM, META);
    await expectReadable(
      calls.find((c) => c.action === 'SetAVTransportURI')?.args.CurrentURIMetaData,
    );
    await expectReadable(
      calls.find((c) => c.action === 'SetNextAVTransportURI')?.args.NextURIMetaData,
    );
  });

  it('is valid DIDL-Lite on DLNA, for the current and the next track', async () => {
    const calls = captureSoap();
    const dlna = withDevice(new DlnaController(), {
      id: 'uuid-cocktail',
      name: 'Cocktail Audio',
      host: '10.0.0.6',
      controlUrl: 'http://10.0.0.6:49152/AVTransport/control',
      location: 'http://10.0.0.6:49152/',
      isOnline: true,
    });
    await dlna.play('uuid-cocktail', STREAM, { ...META, mimeType: 'audio/flac' } as TrackMetadata);
    await dlna.setNextUri('uuid-cocktail', STREAM, META);
    const current = calls.find((c) => c.action === 'SetAVTransportURI')?.args.CurrentURIMetaData;
    await expectReadable(current);
    expect(current).toContain('protocolInfo="http-get:*:audio/flac:*"');
    await expectReadable(
      calls.find((c) => c.action === 'SetNextAVTransportURI')?.args.NextURIMetaData,
    );
  });
});

describe('a DLNA start the caller gave up on (P06)', () => {
  it('sends no SetURI or Play once aborted', async () => {
    const calls = captureSoap();
    const dlna = withDevice(new DlnaController(), {
      id: 'uuid-cocktail',
      name: 'Cocktail Audio',
      host: '10.0.0.6',
      controlUrl: 'http://10.0.0.6:49152/AVTransport/control',
      location: 'http://10.0.0.6:49152/',
      isOnline: true,
    });
    const control = new AbortController();
    control.abort();
    await expect(dlna.play('uuid-cocktail', STREAM, META, control.signal)).rejects.toThrow();
    expect(calls.map((c) => c.action)).not.toContain('SetAVTransportURI');
    expect(calls.map((c) => c.action)).not.toContain('Play');
  });
});

describe('a speaker that misses a discovery round (P01)', () => {
  type D = { id: string; isOnline: boolean; name: string };
  const map = (...ids: string[]) =>
    new Map<string, D>(ids.map((id) => [id, { id, isOnline: true, name: id }]));

  it('stays known, offline, until it missed several rounds in a row', () => {
    const roster = new DiscoveryRoster<D>();
    let known = roster.merge(new Map(), map('kitchen', 'living'));
    known = roster.merge(known, map('living')); // kitchen silent once
    expect(known.get('kitchen')).toMatchObject({ isOnline: false });
    expect(known.get('living')).toMatchObject({ isOnline: true });

    known = roster.merge(known, map('kitchen', 'living')); // back: count starts over
    expect(known.get('kitchen')).toMatchObject({ isOnline: true });

    for (let i = 1; i < MISSED_ROUNDS_BEFORE_DROP; i++) {
      known = roster.merge(known, map('living'));
      expect(known.has('kitchen')).toBe(true);
    }
    known = roster.merge(known, map('living'));
    expect(known.has('kitchen')).toBe(false);
  });
});

/** A controller with a fixed answer and a delay, counting its searches. */
function fakeController(
  type: 'dlna' | 'sonos' | 'volumio',
  devices: OutputDevice[],
  delayMs = 0,
): DeviceController & { searches: number; paused: string[] } {
  const ctl = {
    deviceType: type,
    searches: 0,
    paused: [] as string[],
    async discover() {
      ctl.searches++;
      await new Promise((r) => setTimeout(r, delayMs));
      return devices;
    },
    play: async () => {},
    pause: async (id: string) => {
      ctl.paused.push(id);
    },
    resume: async () => {},
    stop: async () => {},
    next: async () => {},
    previous: async () => {},
    setVolume: async () => {},
    getVolume: async () => 50,
    getPlaybackState: async () => ({
      state: 'playing' as const,
      position: 10,
      duration: 100,
      volume: 50,
    }),
  };
  return ctl;
}

const speaker = (id: string, type: OutputDevice['type']): OutputDevice => ({
  id,
  name: id,
  type,
  isOnline: true,
});

describe('the device manager', () => {
  it('reports an unknown speaker as unavailable instead of "stopped" (P01)', async () => {
    const manager = new DeviceManager([fakeController('dlna', [])]);
    await expect(manager.getPlaybackState('gone')).rejects.toBeInstanceOf(DeviceUnavailableError);
  });

  it('searches once more before refusing a command for an unknown speaker (P01)', async () => {
    const dlna = fakeController('dlna', []);
    const manager = new DeviceManager([dlna]);
    await expect(manager.pause('gone')).rejects.toBeInstanceOf(DeviceUnavailableError);
    expect(dlna.searches).toBe(1);
  });

  it('still leaves the browser and Spotify Connect alone', async () => {
    const manager = new DeviceManager([fakeController('dlna', [])]);
    await expect(manager.pause('browser')).resolves.toBeUndefined();
    await expect(manager.stop('spotify-connect:abc')).resolves.toBeUndefined();
    await expect(manager.getPlaybackState('browser')).resolves.toMatchObject({ state: 'stopped' });
  });

  it('asks every controller at once, and shares a search already under way (P10)', async () => {
    const dlna = fakeController('dlna', [speaker('cocktail', 'dlna')], 150);
    const sonos = fakeController('sonos', [speaker('kitchen', 'sonos')], 150);
    const manager = new DeviceManager([dlna, sonos]);
    const started = Date.now();
    const [a, b] = await Promise.all([manager.getDevices(true), manager.getDevices(true)]);
    expect(Date.now() - started).toBeLessThan(280); // not 150 + 150
    expect(dlna.searches).toBe(1);
    expect(sonos.searches).toBe(1);
    expect(a.map((d) => d.id).sort()).toEqual(['browser', 'cocktail', 'kitchen']);
    expect(b.map((d) => d.id).sort()).toEqual(a.map((d) => d.id).sort());

    await manager.pause('kitchen');
    expect(sonos.paused).toEqual(['kitchen']);
  });

  it('tries once more on its own only when asked to (P06)', async () => {
    const dlna = fakeController('dlna', [speaker('cocktail', 'dlna')]);
    let attempts = 0;
    dlna.play = async () => {
      attempts++;
      throw new Error('renderer busy');
    };
    const manager = new DeviceManager([dlna]);
    await manager.getDevices(true);

    await expect(manager.play('cocktail', STREAM, META, { retry: false })).rejects.toThrow('busy');
    expect(attempts).toBe(1);
    attempts = 0;
    await expect(manager.play('cocktail', STREAM, META)).rejects.toThrow('busy');
    expect(attempts).toBe(2);
  });
});
