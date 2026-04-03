/**
 * Format seconds to "M:SS" or "H:MM:SS" for display.
 */
export function formatDuration(seconds?: number): string {
  if (!seconds || isNaN(seconds)) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Format seconds to "M:SS" for playback time display.
 * Same as formatDuration but returns "0:00" for falsy values.
 */
export function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Format track quality info (e.g. "FLAC / 44.1kHz / 16bit").
 */
export function formatQuality(track: { format?: string; sampleRate?: number; bitDepth?: number }): string {
  const parts: string[] = [];
  if (track.format) parts.push(track.format.toUpperCase());
  if (track.sampleRate) parts.push(`${(track.sampleRate / 1000).toFixed(1)}kHz`);
  if (track.bitDepth) parts.push(`${track.bitDepth}bit`);
  return parts.join(' / ');
}
