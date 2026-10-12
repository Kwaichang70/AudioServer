import { zones } from './zones.js';
import { observeTrackStarts, SERVER_ORIGIN } from './playback.js';
import { connectRadio, topUp, type RadioState } from './library-radio.js';

/**
 * Radio meets the zones (R08.1): every track start in a zone may top its
 * queue up. Kept apart from both, so neither imports the other.
 */
export function initLibraryRadio(
  announce: (zoneId: string, state: RadioState & { note?: string }) => void,
): () => void {
  connectRadio({
    queue: (zoneId) => {
      const session = zones.sessionFor(zoneId);
      const current = session.getCurrentTrack();
      return {
        trackIds: session.getQueue().map((entry) => entry.trackId),
        current: current ? { id: current.id, title: current.title } : null,
      };
    },
    append: (zoneId, tracks) => {
      zones.sessionFor(zoneId).appendTracks(tracks, SERVER_ORIGIN);
    },
    announce,
  });
  return observeTrackStarts((zoneId, remaining) => {
    void topUp(zoneId, remaining);
  });
}
