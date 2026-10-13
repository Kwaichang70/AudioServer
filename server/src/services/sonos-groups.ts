import { zones, type Zone } from './zones.js';
import type { PlaybackOrigin } from '../types/socket-events.js';
import { stopServerPlayback } from './server-player.js';
import { deviceManager } from '../devices/manager.js';
import type { SonosController } from '../devices/sonos.js';
import { logger } from '../logger.js';

/**
 * Sonos groups (R09.1): rooms that play the same music in sync.
 *
 * Synchronised playback is something only Sonos can do among its own
 * players, so this is the one place the app offers it. A member is told to
 * follow the coordinator's stream (`x-rincon:`); the group is then one room
 * — the coordinator's zone — and the member's zone cannot be steered on its
 * own until it leaves (a speaker still belongs to exactly one zone).
 *
 * The group state is Sonos's own topology, read again after every change and
 * every minute, so grouping in the Sonos app shows up here too.
 */

export class GroupError extends Error {
  constructor(
    public code:
      | 'same_zone'
      | 'unknown_zone'
      | 'not_groupable'
      | 'member_leads_group'
      | 'not_grouped'
      | 'speaker_refused',
    message: string,
  ) {
    super(message);
    this.name = 'GroupError';
  }
}

interface GroupBackend {
  isGroupable: (deviceId: string) => boolean;
  join: (memberDeviceId: string, coordinatorDeviceId: string) => Promise<void>;
  leave: (memberDeviceId: string) => Promise<void>;
  refresh: () => Promise<void>;
  /** The device this one follows; null when it stands alone or leads. */
  coordinatorOf: (deviceId: string) => string | null;
  /** The devices following this one. */
  membersOf: (deviceId: string) => string[];
}

const sonos = () => deviceManager.controllerFor('sonos') as SonosController | undefined;

const defaults = (): GroupBackend => ({
  isGroupable: (deviceId) => deviceManager.deviceType(deviceId) === 'sonos',
  join: async (member, coordinator) => {
    const controller = sonos();
    if (!controller) throw new Error('No Sonos controller');
    await controller.joinGroup(member, coordinator);
  },
  leave: async (member) => {
    const controller = sonos();
    if (!controller) throw new Error('No Sonos controller');
    await controller.leaveGroup(member);
  },
  refresh: async () => {
    await sonos()?.refreshTopology();
  },
  coordinatorOf: (deviceId) => sonos()?.coordinatorOf(deviceId) ?? null,
  membersOf: (deviceId) => sonos()?.membersOf(deviceId) ?? [],
});

let backend = defaults();

export function configureSonosGroups(overrides: Partial<GroupBackend>): void {
  backend = { ...defaults(), ...overrides };
}

export function resetSonosGroups(): void {
  backend = defaults();
}

export interface ZoneGroupInfo {
  /** A Sonos room: it can lead a group or join one. */
  groupable: boolean;
  /** The zone this one plays along with, when it is a member. */
  groupedWith: string | null;
  /** The zones playing along with this one, when it leads a group. */
  groupMembers: string[];
}

export function groupInfo(zone: Zone): ZoneGroupInfo {
  const groupable = backend.isGroupable(zone.deviceId);
  if (!groupable) return { groupable, groupedWith: null, groupMembers: [] };
  const leader = backend.coordinatorOf(zone.deviceId);
  return {
    groupable,
    groupedWith: leader ? (zones.forDevice(leader)?.id ?? null) : null,
    groupMembers: backend
      .membersOf(zone.deviceId)
      .map((deviceId) => zones.forDevice(deviceId)?.id)
      .filter((id): id is string => !!id),
  };
}

/** The zone a member plays along with, or null when the zone can be steered itself. */
export function leaderOf(zoneId: string): Zone | null {
  const zone = zones.get(zoneId);
  if (!zone || !backend.isGroupable(zone.deviceId)) return null;
  const leader = backend.coordinatorOf(zone.deviceId);
  return leader ? zones.forDevice(leader) : null;
}

function zoneOrThrow(zoneId: string): Zone {
  const zone = zones.get(zoneId);
  if (!zone) throw new GroupError('unknown_zone', 'That room does not exist.');
  return zone;
}

/**
 * Let `memberZoneId` play along with `leaderZoneId`. The member's own music
 * stops first: from now on its speaker plays what the leader plays.
 */
export async function groupZones(
  leaderZoneId: string,
  memberZoneId: string,
  origin: PlaybackOrigin,
): Promise<ZoneGroupInfo> {
  if (leaderZoneId === memberZoneId) {
    throw new GroupError('same_zone', 'A room cannot join itself.');
  }
  const leader = zoneOrThrow(leaderZoneId);
  const member = zoneOrThrow(memberZoneId);
  for (const zone of [leader, member]) {
    if (!backend.isGroupable(zone.deviceId)) {
      throw new GroupError(
        'not_groupable',
        `“${zone.name}” is not a Sonos speaker; only Sonos rooms play in sync.`,
      );
    }
  }
  if (backend.membersOf(member.deviceId).length > 0) {
    throw new GroupError(
      'member_leads_group',
      `“${member.name}” leads its own group; take its rooms out first.`,
    );
  }
  // A leader that is itself a member: the group belongs to its own leader.
  const actualLeader = backend.coordinatorOf(leader.deviceId) ?? leader.deviceId;

  const session = zones.sessionFor(member.id);
  if (session.getState().state !== 'stopped') session.stop(origin);
  stopServerPlayback(member.id);
  try {
    await backend.join(member.deviceId, actualLeader);
  } catch (err) {
    logger.warn(`Sonos groups: ${member.deviceId} refused to join ${actualLeader}: ${err}`);
    throw new GroupError('speaker_refused', `“${member.name}” did not join the group.`);
  }
  await backend.refresh().catch(() => {});
  return groupInfo(zones.get(leaderZoneId) ?? leader);
}

/** Take a room out of its group; it stands alone again, silent, its own queue intact. */
export async function ungroupZone(memberZoneId: string): Promise<ZoneGroupInfo> {
  const member = zoneOrThrow(memberZoneId);
  if (!backend.isGroupable(member.deviceId) || !backend.coordinatorOf(member.deviceId)) {
    throw new GroupError('not_grouped', `“${member.name}” is not in a group.`);
  }
  try {
    await backend.leave(member.deviceId);
  } catch (err) {
    logger.warn(`Sonos groups: ${member.deviceId} refused to leave: ${err}`);
    throw new GroupError('speaker_refused', `“${member.name}” did not leave the group.`);
  }
  await backend.refresh().catch(() => {});
  return groupInfo(member);
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Read the topology every minute, so grouping in the Sonos app shows up here. */
export function startSonosGroupWatch(onChange: () => void, intervalMs = 60_000): void {
  if (timer) return;
  let last = '';
  timer = setInterval(() => {
    void backend
      .refresh()
      .then(() => {
        const now = JSON.stringify(zones.list().map((z) => [z.id, groupInfo(z)]));
        if (last && now !== last) onChange();
        last = now;
      })
      .catch(() => {});
  }, intervalMs);
  timer.unref?.();
}

export function stopSonosGroupWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
