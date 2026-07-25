export interface TrackInfo {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  albumId?: string;
  duration?: number;
  format?: string;
  sampleRate?: number;
  bitDepth?: number;
  source?: string;
  // Optional ReplayGain tags (dB + 0..1 peak ratio). Backend returns these
  // from /library/tracks/:id and /library/albums/:id. If the file has no RG
  // metadata they're undefined and the player falls back to preamp-only.
  replayGainTrack?: number | null;
  replayGainTrackPeak?: number | null;
  replayGainAlbum?: number | null;
  replayGainAlbumPeak?: number | null;
}
