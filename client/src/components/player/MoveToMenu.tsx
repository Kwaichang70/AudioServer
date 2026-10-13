import { useCallback, useRef, useState } from 'react';
import { useAudioContext } from '../../context/AudioContext.js';
import { useToast } from '../Toast.js';
import { Menu, MenuItem } from '../ui/Menu.js';
import type { ZoneOverview } from '../../api/types.js';

/**
 * Move the music to another room (R09.2): the queue, the track and how far
 * into it go along, and this room stops. It is a hand-over, not a sync, so it
 * works from a Sonos to a DLNA amplifier and from the browser to a speaker.
 *
 * Only rooms the server can play on by itself are offered: a browser room
 * plays only while a tab is open there, and Spotify Connect is steered by
 * Spotify itself. A room that plays along in a Sonos group is not offered.
 */

const serverPlayable = (zone: ZoneOverview) =>
  zone.deviceId !== 'browser' && !zone.deviceId.startsWith('spotify-connect:');

// A room in a Sonos group plays what its leader plays; it is not a target.
const standsAlone = (zone: ZoneOverview) => !zone.groupedWith;

export default function MoveToMenu({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  const { zones, zoneId, moveToZone, currentTrack } = useAudioContext();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  const targets = zones.filter((z) => z.id !== zoneId && serverPlayable(z) && standsAlone(z));
  if (!currentTrack || targets.length === 0) return null;

  const move = async (zone: ZoneOverview) => {
    setBusy(true);
    try {
      const result = await moveToZone(zone);
      toast(result.note ?? `Now playing in ${zone.name}`, result.note ? 'info' : 'success');
    } catch {
      // The API error is already shown as a toast, with the server's reason.
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Move the music to another room"
        className={`shrink-0 rounded-full border border-white/15 px-2 py-0.5 text-gray-500 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 ${
          size === 'lg' ? 'text-sm' : 'text-[11px]'
        }`}
      >
        Move to…
      </button>
      <Menu open={open} onClose={close} anchorRef={triggerRef} label="Move to room">
        {targets.map((zone) => (
          <MenuItem
            key={zone.id}
            onSelect={() => void move(zone)}
            onClose={close}
            disabled={busy}
            hint={zone.state === 'playing' ? 'playing now' : undefined}
          >
            {zone.name}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
