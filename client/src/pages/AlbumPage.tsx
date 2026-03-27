import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';

interface Track {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  trackNumber?: number;
  discNumber?: number;
  duration?: number;
  format?: string;
}

interface Album {
  id: string;
  title: string;
  artistName: string;
  year?: number;
  genre?: string;
  trackCount?: number;
}

function formatDuration(seconds?: number): string {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function AlbumPage() {
  const { id } = useParams<{ id: string }>();
  const [album, setAlbum] = useState<Album | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const { playTrack, currentTrack, isPlaying } = useAudioContext();

  useEffect(() => {
    if (!id) return;
    api.getAlbum(id).then((res) => setAlbum(res.data));
    api.getAlbumTracks(id).then((res) => setTracks(res.data));
  }, [id]);

  if (!album) return <p className="text-gray-400">Loading...</p>;

  return (
    <div>
      {/* Album header */}
      <div className="flex gap-6 mb-8">
        <div className="w-48 h-48 bg-surface-light rounded-lg flex items-center justify-center text-6xl text-gray-600 shrink-0">
          ♪
        </div>
        <div className="flex flex-col justify-end">
          <p className="text-xs text-gray-400 uppercase tracking-wider">Album</p>
          <h2 className="text-3xl font-bold mb-1">{album.title}</h2>
          <p className="text-gray-400">
            {album.artistName}
            {album.year && <span> · {album.year}</span>}
            {album.genre && <span> · {album.genre}</span>}
            {album.trackCount && <span> · {album.trackCount} tracks</span>}
          </p>
        </div>
      </div>

      {/* Track list */}
      <table className="w-full">
        <thead>
          <tr className="text-left text-xs text-gray-500 uppercase border-b border-white/10">
            <th className="pb-2 w-12">#</th>
            <th className="pb-2">Title</th>
            <th className="pb-2 w-20">Format</th>
            <th className="pb-2 w-20 text-right">Duration</th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((track) => {
            const isCurrent = currentTrack?.id === track.id;
            return (
              <tr
                key={track.id}
                onClick={() => playTrack(track)}
                className={`cursor-pointer hover:bg-surface-light transition ${
                  isCurrent ? 'text-accent' : ''
                }`}
              >
                <td className="py-2 text-sm text-gray-500">
                  {isCurrent && isPlaying ? '▶' : track.trackNumber || '—'}
                </td>
                <td className="py-2">
                  <p className="text-sm font-medium">{track.title}</p>
                  <p className="text-xs text-gray-500">{track.artistName}</p>
                </td>
                <td className="py-2 text-xs text-gray-500 uppercase">{track.format}</td>
                <td className="py-2 text-sm text-gray-400 text-right">{formatDuration(track.duration)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
