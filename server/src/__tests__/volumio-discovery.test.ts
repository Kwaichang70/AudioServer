import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VolumioController,
  configureVolumioDiscovery,
  parseVolumioAnswers,
} from '../devices/volumio.js';

/**
 * Volumio finds itself (R09.4): what a Volumio announces over mDNS
 * (`_Volumio._tcp`, port 3000, TXT volumioName and UUID — its
 * volumiodiscovery plugin) becomes a player, next to VOLUMIO_DEVICES.
 */

const announcement = (instance: string, host: string, ip: string, name: string) => [
  { name: '_Volumio._tcp.local', type: 'PTR', data: `${instance}._Volumio._tcp.local` },
  {
    name: `${instance}._Volumio._tcp.local`,
    type: 'SRV',
    data: { port: 3000, target: `${host}.local` },
  },
  {
    name: `${instance}._Volumio._tcp.local`,
    type: 'TXT',
    data: [Buffer.from(`volumioName=${name}`), Buffer.from('UUID=abc-123')],
  },
  { name: `${host}.local`, type: 'A', data: ip },
];

describe('Volumio over mDNS', () => {
  const saved = { devices: process.env.VOLUMIO_DEVICES, mdns: process.env.VOLUMIO_MDNS };

  beforeEach(() => {
    delete process.env.VOLUMIO_DEVICES;
    delete process.env.VOLUMIO_MDNS;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('10.0.0.66')
          ? new Response('nope', { status: 500 })
          : new Response(JSON.stringify({ volume: 40, status: 'stop' })),
      ),
    );
  });

  afterEach(() => {
    configureVolumioDiscovery(null);
    vi.unstubAllGlobals();
    process.env.VOLUMIO_DEVICES = saved.devices;
    process.env.VOLUMIO_MDNS = saved.mdns;
    if (saved.devices === undefined) delete process.env.VOLUMIO_DEVICES;
    if (saved.mdns === undefined) delete process.env.VOLUMIO_MDNS;
  });

  it('reads name, address and port from the records, in whatever order they come', () => {
    const records = announcement('living', 'volumio', '10.0.0.9', 'Living room').reverse();
    expect(parseVolumioAnswers(records)).toEqual([
      { host: '10.0.0.9', port: 3000, name: 'Living room', uuid: 'abc-123' },
    ]);
    // Other services on the network are not Volumio.
    expect(
      parseVolumioAnswers([{ name: '_googlecast._tcp.local', type: 'PTR', data: 'tv' }]),
    ).toEqual([]);
  });

  it('lists the players that announce themselves and answer, with their own name', async () => {
    configureVolumioDiscovery(async () => [
      ...announcement('living', 'volumio', '10.0.0.9', 'Living room'),
      // Announced, but its API does not answer: not listed.
      ...announcement('attic', 'attic', '10.0.0.66', 'Attic'),
    ]);
    const devices = await new VolumioController().discover();
    expect(devices).toEqual([
      expect.objectContaining({
        id: 'volumio-10.0.0.9',
        name: 'Living room (Volumio)',
        type: 'volumio',
        host: '10.0.0.9',
      }),
    ]);
  });

  it('keeps a configured player as it is, without a second copy', async () => {
    process.env.VOLUMIO_DEVICES = '10.0.0.9';
    configureVolumioDiscovery(async () =>
      announcement('living', 'volumio', '10.0.0.9', 'Living room'),
    );
    const devices = await new VolumioController().discover();
    expect(devices.map((d) => [d.id, d.name])).toEqual([
      ['volumio-10.0.0.9', 'Volumio (10.0.0.9)'],
    ]);
  });

  it('does not ask the network when told not to', async () => {
    process.env.VOLUMIO_MDNS = 'false';
    const browse = vi.fn(async () => announcement('living', 'volumio', '10.0.0.9', 'Living'));
    configureVolumioDiscovery(browse);
    expect(await new VolumioController().discover()).toEqual([]);
    expect(browse).not.toHaveBeenCalled();
  });
});
