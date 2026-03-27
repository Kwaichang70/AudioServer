import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';

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

function formatDuration(seconds?: number): string {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
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
        {tracks.length > 0 && (
          <button
            onClick={() => playAlbum(tracks)}
            className="mt-4 px-6 py-2 bg-accent rounded-full hover:bg-accent-hover transition text-sm font-medium"
          >
            Play All
          </button>
        )}
      </div>

      {tracks.length === 0 ? (
        <p className="text-gray-500 text-center py-8">
          No tracks yet. Add tracks from album pages.
        </p>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="text-left text-xs text-gray-500 uppercase border-b border-white/10">
              <th className="pb-2 w-12">#</th>
              <th className="pb-2">Title</th>
              <th className="pb-2 hidden md:table-cell">Album</th>
              <th className="pb-2 w-20 text-right">Duration</th>
              <th className="pb-2 w-12"></th>
            </tr>
          </thead>
          <tbody>
            {tracks.map((track, i) => {
              const isCurrent = currentTrack?.id === track.id;
              return (
                <tr
                  key={`${track.id}-${i}`}
                  onClick={() => playTrack(track)}
                  className={`cursor-pointer hover:bg-surface-light transition ${isCurrent ? 'text-accent' : ''}`}
                >
                  <td className="py-2.5 text-sm text-gray-500">
                    {isCurrent && isPlaying ? <span className="text-accent animate-pulse">&#9654;</span> : i + 1}
                  </td>
                  <td className="py-2.5">
                    <p className="text-sm font-medium">{track.title}</p>
                    <p className="text-xs text-gray-500">{track.artistName}</p>
                  </td>
                  <td className="py-2.5 text-xs text-gray-500 hidden md:table-cell">{track.albumTitle}</td>
                  <td className="py-2.5 text-sm text-gray-400 text-right">{formatDuration(track.duration)}</td>
                  <td className="py-2.5 text-right">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleRemove(track.id); }}
                      className="text-xs text-gray-600 hover:text-red-400 transition"
                    >
                      &#10005;
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
