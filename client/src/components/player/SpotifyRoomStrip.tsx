import { useState } from 'react';
import { api } from '../../api/client.js';
import { useAudioContext } from '../../context/AudioContext.js';
import { useToast } from '../Toast.js';

/**
 * When Spotify plays on the speaker of the room this tab steers — started by
 * Homey, Grok or "Play in" on a playlist page — AudioServer's own queue for
 * that room is stopped, so the player bar alone would say nothing plays. This
 * strip says what Spotify plays there and pauses or skips it.
 */
export default function SpotifyRoomStrip() {
  const { zones, zoneId, refreshZones } = useAudioContext();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const zone = zones.find((z) => z.id === zoneId);
  const sp = zone?.spotify;
  if (!zone || !sp) return null;

  const run = (action: 'pause' | 'resume' | 'next' | 'previous') => {
    setBusy(true);
    api
      .roomCommand(zone.id, action)
      .catch((err: unknown) => toast(err instanceof Error ? err.message : String(err), 'error'))
      .finally(() => {
        setBusy(false);
        // The server looks again shortly after a command and then tells the app.
        setTimeout(refreshZones, 2000);
      });
  };
  const button =
    'w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/10 transition disabled:opacity-40';

  return (
    <section
      aria-label={`Spotify in ${zone.name}`}
      className="flex items-center gap-3 border-t border-white/10 bg-surface px-4 py-2 text-sm"
    >
      {sp.track?.coverUrl && (
        <img src={sp.track.coverUrl} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
      )}
      <p className="flex-1 min-w-0 truncate">
        <span className="text-green-400">Spotify</span>
        <span className="text-gray-500"> in {zone.name} · </span>
        {sp.track ? (
          <>
            {sp.track.title}
            <span className="text-gray-500"> — {sp.track.artistName}</span>
          </>
        ) : (
          sp.playing
        )}
        {sp.state === 'paused' && <span className="text-gray-500"> (paused)</span>}
      </p>
      <button
        className={button}
        disabled={busy}
        onClick={() => run('previous')}
        aria-label="Previous"
      >
        &#9198;
      </button>
      {sp.state === 'playing' ? (
        <button className={button} disabled={busy} onClick={() => run('pause')} aria-label="Pause">
          &#9208;
        </button>
      ) : (
        <button className={button} disabled={busy} onClick={() => run('resume')} aria-label="Play">
          &#9654;
        </button>
      )}
      <button className={button} disabled={busy} onClick={() => run('next')} aria-label="Next">
        &#9197;
      </button>
    </section>
  );
}
