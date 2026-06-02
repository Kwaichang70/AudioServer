import { describe, expect, it } from 'vitest';
import { parseSonosZoneGroups } from '../devices/sonos.js';

describe('parseSonosZoneGroups', () => {
  it('maps Sonos group membership and coordinator status', async () => {
    const topology = await parseSonosZoneGroups(`
      <ZoneGroups>
        <ZoneGroup Coordinator="RINCON_A" ID="RINCON_A:1">
          <ZoneGroupMember UUID="RINCON_A" ZoneName="Studeerkamer" />
          <ZoneGroupMember UUID="RINCON_B" ZoneName="Slaapkamer" />
        </ZoneGroup>
      </ZoneGroups>
    `);

    expect(topology.get('RINCON_A')).toEqual({
      groupId: 'RINCON_A:1',
      groupName: 'Studeerkamer + Slaapkamer',
      isGroupCoordinator: true,
    });
    expect(topology.get('RINCON_B')).toEqual({
      groupId: 'RINCON_A:1',
      groupName: 'Studeerkamer + Slaapkamer',
      isGroupCoordinator: false,
    });
  });
});
