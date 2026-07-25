import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';
import { formatDuration } from '../utils/format.js';
import SortableList from '../components/SortableList.js';
import { STORAGE_KEYS } from '../constants.js';

interface Track {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  albumId?: string;
  duration?: number;
  format?: string;
  playlistPosition?: number;
}

interface Playlist {
  id: string;
  name: string;
  description?: string | null;
  trackCount?: number;
}

interface SortablePlaylistTrack extends Track {
  _trackId: string;
  _index: number;
}

export default function PlaylistPage() {
  const { id } = useParams<{ id: string }>();
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const { playTrack, playAlbum, currentTrack, isPlaying } = useAudioContext();
  const loadRequestRef = useRef(0);
  const activePlaylistIdRef = useRef(id);
  activePlaylistIdRef.current = id;
  const invalidateLoads = useCallback(() => {
    loadRequestRef.current++;
  }, []);

  const load = useCallback(async () => {
    if (!id) return;
    const requestId = ++loadRequestRef.current;
    try {
      const [playlistResponse, tracksResponse] = await Promise.all([
        api.getPlaylist(id),
        api.getPlaylistTracks(id),
      ]);
      if (requestId !== loadRequestRef.current) return;
      setPlaylist(playlistResponse.data);
      setTracks(tracksResponse.data);
    } catch {
      // Keep the reset/loading state when this playlist no longer exists.
    }
  }, [id]);

  useEffect(() => {
    setPlaylist(null);
    setTracks([]);
    void load();
    return invalidateLoads;
  }, [invalidateLoads, load]);

  const handleRemove = async (trackId: string) => {
    if (!id) return;
    const playlistId = id;
    await api.removeFromPlaylist(id, trackId);
    if (activePlaylistIdRef.current === playlistId) void load();
  };

  const handleReorder = async (from: number, to: number) => {
    const newTracks = [...tracks];
    const [moved] = newTracks.splice(from, 1);
    newTracks.splice(to, 0, moved);
    setTracks(newTracks);
    if (id) {
      await api.reorderPlaylist(
        id,
        newTracks.map((t) => t.id),
      );
    }
  };

  const handleExport = async () => {
    if (!id) return;
    // The API only accepts Bearer auth — a ?token= query param is ignored, so
    // the old window.open() approach always got a 401. Fetch with the header
    // and download the result as a blob instead.
    try {
      const token = localStorage.getItem(STORAGE_KEYS.authToken);
      const res = await fetch(api.exportPlaylist(id), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${playlist?.name || 'playlist'}.m3u`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      // network/auth failure — nothing to download
    }
  };

  if (!playlist) return <p className="text-gray-400">Loading...</p>;

  const totalDuration = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  const totalMin = Math.floor(totalDuration / 60);

  return (
    <div>
      <div className="mb-8">
        <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Playlist</p>
        <h2 className="text-3xl font-bold mb-2">{playlist.name}</h2>
        {playlist.description && <p className="text-gray-400 mb-1">{playlist.description}</p>}
        <p className="text-sm text-gray-500">
          {tracks.length} tracks &middot; {totalMin} min
        </p>
        <div className="flex gap-3 mt-4">
          {tracks.length > 0 && (
            <button
              onClick={() => playAlbum(tracks)}
              className="px-6 py-2 bg-accent rounded-full hover:bg-accent-hover transition text-sm font-medium"
            >
              Play All
            </button>
          )}
          {tracks.length > 0 && (
            <button
              onClick={handleExport}
              className="px-4 py-2 bg-surface-light border border-white/10 rounded-full hover:border-accent transition text-sm text-gray-400"
            >
              Export M3U
            </button>
          )}
        </div>
      </div>

      {tracks.length === 0 ? (
        <p className="text-gray-500 text-center py-8">
          No tracks yet. Add tracks from album pages.
        </p>
      ) : (
        <>
          <div className="text-left text-xs text-gray-500 uppercase border-b border-white/10 pb-2 mb-1 flex items-center gap-2 px-2">
            <span className="w-8">#</span>
            <span className="flex-1">Title</span>
            <span className="w-20 text-right">Duration</span>
            <span className="w-8"></span>
          </div>
          <SortableList
            items={tracks.map(
              (t, i): SortablePlaylistTrack => ({
                ...t,
                id: `pl-${i}-${t.id}`,
                _trackId: t.id,
                _index: i,
              }),
            )}
            onReorder={handleReorder}
            renderItem={(item) => {
              const track = tracks[item._index];
              if (!track) return null;
              const isCurrent = currentTrack?.id === track.id;
              return (
                <div
                  onClick={() => playTrack(track)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      playTrack(track);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  className={`group flex items-center gap-2 py-2 px-1 cursor-pointer hover:bg-surface-light rounded transition ${isCurrent ? 'text-accent' : ''}`}
                >
                  <span className="w-6 text-sm text-gray-500 text-right shrink-0">
                    {isCurrent && isPlaying ? (
                      <span className="text-accent animate-pulse">&#9654;</span>
                    ) : (
                      item._index + 1
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
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemove(track.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 text-xs text-gray-600 hover:text-red-400 transition shrink-0 px-1"
                  >
                    &#10005;
                  </button>
                </div>
              );
            }}
          />
        </>
      )}
    </div>
  );
}
