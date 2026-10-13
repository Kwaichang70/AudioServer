import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SonosController } from '../devices/sonos.js';

/**
 * Sonos groups at the speaker (R09.1): what is actually sent. Joining sends
 * x-rincon to the member, leaving sends BecomeCoordinatorOfStandaloneGroup,
 * and a group's volume goes through GroupRenderingControl.
 */

const topology = (grouped: boolean) => `
  <ZoneGroups>
    ${
      grouped
        ? `<ZoneGroup Coordinator="RINCON_KITCHEN" ID="RINCON_KITCHEN:1">
             <ZoneGroupMember UUID="RINCON_KITCHEN" ZoneName="Kitchen" />
             <ZoneGroupMember UUID="RINCON_BEDROOM" ZoneName="Bedroom" />
           </ZoneGroup>`
        : `<ZoneGroup Coordinator="RINCON_KITCHEN" ID="RINCON_KITCHEN:1">
             <ZoneGroupMember UUID="RINCON_KITCHEN" ZoneName="Kitchen" />
           </ZoneGroup>
           <ZoneGroup Coordinator="RINCON_BEDROOM" ID="RINCON_BEDROOM:2">
             <ZoneGroupMember UUID="RINCON_BEDROOM" ZoneName="Bedroom" />
           </ZoneGroup>`
    }
  </ZoneGroups>`;

describe('Sonos groups at the speaker', () => {
  let controller: SonosController;
  let grouped: boolean;
  const calls: Array<{ url: string; action: string; body: string }> = [];

  beforeEach(() => {
    calls.length = 0;
    grouped = false;
    controller = new SonosController();
    const devices = (controller as unknown as { devices: Map<string, unknown> }).devices;
    devices.set('RINCON_KITCHEN', {
      id: 'RINCON_KITCHEN',
      name: 'Kitchen (One)',
      host: '10.0.0.2',
      port: 1400,
      isOnline: true,
    });
    devices.set('RINCON_BEDROOM', {
      id: 'RINCON_BEDROOM',
      name: 'Bedroom (One)',
      host: '10.0.0.3',
      port: 1400,
      isOnline: true,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/status/topology')) return new Response(topology(grouped));
        const action = String((init?.headers as Record<string, string>).SOAPAction);
        const body = String(init?.body);
        calls.push({ url, action, body });
        if (action.includes('#SetAVTransportURI') && body.includes('x-rincon:')) grouped = true;
        if (action.includes('BecomeCoordinatorOfStandaloneGroup')) grouped = false;
        if (action.includes('GetGroupVolume')) {
          return new Response('<CurrentVolume>35</CurrentVolume>');
        }
        return new Response('<ok/>');
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('lets the bedroom follow the kitchen, and knows who leads afterwards', async () => {
    await controller.joinGroup('RINCON_BEDROOM', 'RINCON_KITCHEN');
    const join = calls.find((c) => c.action.endsWith('#SetAVTransportURI"'))!;
    expect(join.url).toBe('http://10.0.0.3:1400/MediaRenderer/AVTransport/Control');
    expect(join.body).toContain('<CurrentURI>x-rincon:RINCON_KITCHEN</CurrentURI>');
    expect(controller.coordinatorOf('RINCON_BEDROOM')).toBe('RINCON_KITCHEN');
    expect(controller.membersOf('RINCON_KITCHEN')).toEqual(['RINCON_BEDROOM']);
    expect(controller.coordinatorOf('RINCON_KITCHEN')).toBeNull();
  });

  it('takes the bedroom out again', async () => {
    await controller.joinGroup('RINCON_BEDROOM', 'RINCON_KITCHEN');
    await controller.leaveGroup('RINCON_BEDROOM');
    const leave = calls.find((c) => c.action.includes('BecomeCoordinatorOfStandaloneGroup'))!;
    expect(leave.url).toBe('http://10.0.0.3:1400/MediaRenderer/AVTransport/Control');
    expect(controller.coordinatorOf('RINCON_BEDROOM')).toBeNull();
    expect(controller.membersOf('RINCON_KITCHEN')).toEqual([]);
  });

  it("sets a group's volume on the leader, and one speaker's volume alone", async () => {
    await controller.setVolume('RINCON_KITCHEN', 40);
    expect(calls.at(-1)!.url).toBe('http://10.0.0.2:1400/MediaRenderer/RenderingControl/Control');

    await controller.joinGroup('RINCON_BEDROOM', 'RINCON_KITCHEN');
    calls.length = 0;
    await controller.setVolume('RINCON_KITCHEN', 30);
    expect(calls.map((c) => c.action.split('#')[1])).toEqual([
      'SnapshotGroupVolume"',
      'SetGroupVolume"',
    ]);
    expect(calls[1].url).toBe('http://10.0.0.2:1400/MediaRenderer/GroupRenderingControl/Control');
    expect(calls[1].body).toContain('<DesiredVolume>30</DesiredVolume>');
    expect(await controller.getVolume('RINCON_KITCHEN')).toBe(35);
  });
});
