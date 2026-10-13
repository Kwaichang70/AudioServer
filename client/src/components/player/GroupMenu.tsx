import { useCallback, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { useAudioContext } from '../../context/AudioContext.js';
import { useToast } from '../Toast.js';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu.js';
import type { ZoneOverview } from '../../api/types.js';

/**
 * Sonos groups (R09.1), in the player.
 *
 * On a Sonos room: "Group…" lets other Sonos rooms play along in sync, or
 * takes them out again. On a room that plays along with another: it says
 * with which, and offers to steer that room or to leave the group — the
 * member itself cannot be steered while it follows (the server refuses).
 * Only Sonos does this in sync, so other speakers never appear here.
 */

const triggerClass = (size: 'sm' | 'lg', active: boolean) =>
  `shrink-0 rounded-full border px-2 py-0.5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 ${
    size === 'lg' ? 'text-sm' : 'text-[11px]'
  } ${active ? 'border-accent text-accent' : 'border-white/15 text-gray-500 hover:text-white'}`;

export default function GroupMenu({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  const { zones, zoneId, refreshZones, setSelectedDeviceId } = useAudioContext();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  const here = zones.find((z) => z.id === zoneId);
  if (!here?.groupable) return null;
  const leader = here.groupedWith ? zones.find((z) => z.id === here.groupedWith) : undefined;
  const members = new Set(here.groupMembers ?? []);
  // Rooms that could join: other Sonos rooms that do not lead a group of their own.
  const candidates = zones.filter(
    (z) => z.id !== here.id && z.groupable && (z.groupMembers ?? []).length === 0,
  );
  if (!leader && candidates.length === 0) return null;

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await action();
      toast(done, 'success');
    } catch {
      // The API error is already shown as a toast, with the server's reason.
    } finally {
      setBusy(false);
      refreshZones();
    }
  };

  const toggle = (zone: ZoneOverview) =>
    members.has(zone.id)
      ? run(() => api.ungroupZone(zone.id), `${zone.name} plays on its own again`)
      : run(() => api.groupZone(zone.id), `${zone.name} plays along with ${here.name}`);

  const label = leader
    ? `With ${leader.name}`
    : members.size > 0
      ? `Group · ${members.size + 1}`
      : 'Group…';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          leader
            ? `${here.name} plays along with ${leader.name}`
            : 'Let other Sonos rooms play along, in sync'
        }
        className={triggerClass(size, !!leader || members.size > 0)}
      >
        {label}
      </button>
      <Menu open={open} onClose={close} anchorRef={triggerRef} label="Sonos group">
        {leader ? (
          <>
            <MenuItem onSelect={() => setSelectedDeviceId(leader.deviceId)} onClose={close}>
              Steer {leader.name}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              onSelect={() =>
                void run(() => api.ungroupZone(here.id), `${here.name} plays on its own again`)
              }
              onClose={close}
              disabled={busy}
            >
              Leave the group
            </MenuItem>
          </>
        ) : (
          candidates.map((zone) => (
            <MenuItem
              key={zone.id}
              onSelect={() => void toggle(zone)}
              onClose={close}
              disabled={busy}
              hint={
                members.has(zone.id)
                  ? 'in group'
                  : zone.groupedWith
                    ? `with ${zones.find((z) => z.id === zone.groupedWith)?.name ?? 'another room'}`
                    : undefined
              }
            >
              {members.has(zone.id) ? `✓ ${zone.name}` : zone.name}
            </MenuItem>
          ))
        )}
      </Menu>
    </>
  );
}
