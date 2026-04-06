import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';
import { formatDuration } from '../utils/format.js';
import SortableList from '../components/SortableList.js';

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
  description?: string;
  trackCount?: number;
}

export default function PlaylistPage() {
  const { id } = useParams<{ id: string }>();
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const { playTrack, playAlbum, currentTrack, isPlaying } = useAudioContext();

  const load = () => {
    if (!id) return;
    api.getPlaylist(id).then((res) => setPlaylist(res.data));
    api.getPlaylistTracks(id).then((res) => setTracks(res.data));
  };

  useEffect(() => { load(); }, [id]);

  const handleRemove = async (trackId: string) => {
    if (!id) return;
    await api.removeFromPlaylist(id, trackId);
    load();
  };

  const handleReorder = async (from: number, to: number) => {
    const newTracks = [...tracks];
    const [moved] = newTracks.splice(from, 1);
    newTracks.splice(to, 0, moved);
    setTracks(newTracks);
    if (id) {
      await api.reorderPlaylist(id, newTracks.map((t) => t.id));
    }
  };

  const handleExport = () => {
    if (!id) return;
    const token = localStorage.getItem('audioserver_token');
    const url = api.exportPlaylist(id);
    // Download via hidden link with auth
    window.open(`${url}${url.includes('?') ? '&' : '?'}token=${token}`, '_blank');
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
        <p className="text-sm text-gray-500">{tracks.length} tracks &middot; {totalMin} min</p>
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
          items={tracks.map((t, i) => ({ ...t, id: `pl-${i}-${t.id}`, _trackId: t.id, _index: i }))}
          onReorder={handleReorder}
          renderItem={(item: any, _i: number) => {
            const track = tracks[item._index];
            if (!track) return null;
            const isCurrent = currentTrack?.id === track.id;
            return (
              <div
                onClick={() => playTrack(track)}
                className={`group flex items-center gap-2 py-2 px-1 cursor-pointer hover:bg-surface-light rounded transition ${isCurrent ? 'text-accent' : ''}`}
              >
                <span className="w-6 text-sm text-gray-500 text-right shrink-0">
                  {isCurrent && isPlaying ? <span className="text-accent animate-pulse">&#9654;</span> : item._index + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{track.title}</p>
                  <p className="text-xs text-gray-500 truncate">{track.artistName} &middot; {track.albumTitle}</p>
                </div>
                <span className="text-sm text-gray-400 shrink-0">{formatDuration(track.duration)}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleRemove(track.id); }}
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
