import type { LibraryScanProgress } from '../../hooks/useSocket.js';
import type { MissingTrack, MissingTrackCandidate } from '../../api/types.js';

/** Types and small helpers shared by the settings sections (R02.4). */

export interface ProviderStatus {
  available: boolean;
  authenticated: boolean;
  configured?: boolean;
  streamingAvailable?: boolean;
  reason?: string;
  formatId?: string;
  accountName?: string;
}

export interface AllStatus {
  tidal: ProviderStatus;
  spotify: ProviderStatus;
  qobuz: ProviderStatus;
}

export interface UserAccount {
  id: string;
  username: string;
  role: 'admin' | 'user' | string;
}

export interface SessionRow {
  id: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number | null;
  userAgent: string | null;
  current: boolean;
}

export function describeUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Other';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  return `${browser} on ${os}`;
}

export function formatWhen(ts: number | null): string {
  if (!ts) return 'never';
  return new Date(ts).toLocaleString();
}

export interface ScrobbleConfig {
  lastfm?: {
    enabled?: boolean;
    configured?: boolean;
    username?: string | null;
  };
  listenbrainz?: {
    enabled?: boolean;
  };
}

export function getErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function best(m: MissingTrack): MissingTrackCandidate {
  return m.candidates[0];
}

export function formatScanInfo(status: LibraryScanProgress): string {
  if (status.phase === 'idle') return '';
  const percent =
    status.totalFiles > 0
      ? ` (${Math.round((status.processedFiles / status.totalFiles) * 100)}%)`
      : '';
  const current =
    status.currentFile || status.currentDir ? ` | ${status.currentFile || status.currentDir}` : '';
  const relinked = status.relinkedTracks ? ` / moved ${status.relinkedTracks}` : '';
  const changed =
    status.newTracks || status.updatedTracks || status.removedTracks || status.relinkedTracks
      ? ` | +${status.newTracks} / ~${status.updatedTracks} / missing ${status.removedTracks}${relinked}`
      : '';

  return `${status.phase}: ${status.processedFiles}/${status.totalFiles} files${percent} | ${status.artists} artists | ${status.albums} albums | ${status.tracks} tracks${changed}${current}`;
}
