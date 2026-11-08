import { useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { useAudioContext } from '../context/AudioContext.js';
import { formatDuration } from '../utils/format.js';
import PlayActions, { toTrackInfo } from '../components/PlayActions.js';
import type { Track } from '@audioserver/shared';
import { api as apiClient, ApiError } from '../api/client.js';
import { useToast } from '../components/Toast.js';

/**
 * A playlist from the user's Spotify account, read-only: Spotify keeps it,
 * AudioServer shows and plays it. Playing goes the way every Spotify track
 * does (the Spotify player in the browser, or Spotify Connect on a speaker).
 */
interface Shown {
  name?: string;
  coverUrl?: string;
  trackCount?: number;
}

export default function SpotifyPlaylistPage() {
  const { id } = useParams<{ id: string }>();
  const shown = (useLocation().state ?? {}) as Shown;
  const [tracks, setTracks] = useState<Track[] | null>(null);
  // Why the tracks did not come: 'forbidden' is Spotify refusing to show a
  // playlist the user does not own (Development Mode); it still plays.
  const [failed, setFailed] = useState<'forbidden' | 'error' | null>(null);
  const { playAlbum, currentTrack, isPlaying, zones } = useAudioContext();
  const { toast } = useToast();
  const [busyRoom, setBusyRoom] = useState<string | null>(null);
  // Rooms whose speaker the server can start: Spotify then plays the whole
  // playlist there itself, with no list needed here and no tab kept open.
  const rooms = zones.filter(
    (z) => z.deviceId !== 'browser' && !z.deviceId.startsWith('spotify-connect:') && !z.groupedWith,
  );
  const playInRoom = (roomId: string, roomName: string) => {
    if (!id) return;
    setBusyRoom(roomId);
    apiClient
      .playSpotifyInRoom(roomId, `spotify:${id}`)
      .then((res) => toast(`Playing on ${res.data.speaker} via Spotify Connect`, 'success'))
      .catch((err: unknown) =>
        toast(err instanceof Error ? err.message : `Could not play in ${roomName}`, 'error'),
      )
      .finally(() => setBusyRoom(null));
  };

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setTracks(null);
    setFailed(null);
    apiClient
      .getSpotifyPlaylistTracks(id)
      .then((res) => {
        if (alive) setTracks(res.data);
      })
      .catch((err: unknown) => {
        if (alive)
          setFailed(err instanceof ApiError && err.statusCode === 403 ? 'forbidden' : 'error');
      });
    return () => {
      alive = false;
    };
  }, [id]);

  const infos = (tracks ?? []).map((t) => toTrackInfo(t));
  const totalMin = Math.floor((tracks ?? []).reduce((sum, t) => sum + (t.duration || 0), 0) / 60);

  return (
    <div>
      <div className="mb-8 flex gap-6 items-end">
        {shown.coverUrl && (
          <img src={shown.coverUrl} alt="" className="w-32 h-32 rounded-lg object-cover shrink-0" />
        )}
        <div className="min-w-0">
          <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Spotify playlist</p>
          <h2 className="text-3xl font-bold mb-2 truncate">{shown.name ?? 'Playlist'}</h2>
          {tracks && (
            <p className="text-sm text-gray-500">
              {tracks.length} tracks &middot; {totalMin} min
              {shown.trackCount !== undefined && shown.trackCount > tracks.length && (
                <span className="text-gray-600">
                  {' '}
                  &middot; the first {tracks.length} of {shown.trackCount}
                </span>
              )}
            </p>
          )}
          <div className="flex flex-wrap gap-3 mt-4">
            {infos.length > 0 && (
              <button
                onClick={() => playAlbum(infos)}
                className="px-6 py-2 bg-accent rounded-full hover:bg-accent-hover transition text-sm font-medium"
              >
                Play All
              </button>
            )}
            {rooms.map((room) => (
              <button
                key={room.id}
                onClick={() => playInRoom(room.id, room.name)}
                disabled={busyRoom !== null}
                className="px-4 py-2 bg-surface-light border border-white/10 rounded-full hover:border-accent transition text-sm disabled:opacity-50"
              >
                {busyRoom === room.id ? 'Starting…' : `Play in ${room.name}`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {failed === 'forbidden' ? (
        <p className="text-gray-500 text-center py-8">
          Spotify shows AudioServer the tracks of your own playlists only.
          {rooms.length > 0 && ' This one still plays on a speaker: use a "Play in" button above.'}
        </p>
      ) : failed ? (
        <p className="text-gray-500 text-center py-8">
          Spotify did not return this playlist. Is Spotify still connected?
        </p>
      ) : tracks === null ? (
        <p className="text-gray-400">Loading...</p>
      ) : tracks.length === 0 ? (
        <p className="text-gray-500 text-center py-8">This playlist is empty.</p>
      ) : (
        <div>
          {tracks.map((track, index) => {
            const isCurrent = currentTrack?.id === track.id;
            const playFrom = () => playAlbum(infos, index);
            return (
              <div
                key={`${track.id}-${index}`}
                onClick={playFrom}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    playFrom();
                  }
                }}
                role="button"
                tabIndex={0}
                className={`group flex items-center gap-2 py-2 px-1 rounded cursor-pointer hover:bg-surface-light transition ${
                  isCurrent ? 'text-accent' : ''
                }`}
              >
                <span className="w-6 text-sm text-gray-500 text-right shrink-0">
                  {isCurrent && isPlaying ? (
                    <span className="text-accent animate-pulse">&#9654;</span>
                  ) : (
                    index + 1
                  )}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{track.title}</p>
                  <p className="text-xs text-gray-500 truncate">
                    {track.artistName} &middot; {track.albumTitle}
                  </p>
                </div>
                <span className="text-sm text-gray-400 shrink-0">
                  {formatDuration(track.duration)}
                </span>
                <PlayActions target={{ kind: 'track', track: infos[index], list: infos, index }} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
