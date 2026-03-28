import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';
import AddToPlaylist from '../components/AddToPlaylist.js';

interface Track {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  albumId: string;
  trackNumber?: number;
  discNumber?: number;
  duration?: number;
  format?: string;
  sampleRate?: number;
  bitDepth?: number;
}

interface Album {
  id: string;
  title: string;
  artistName: string;
  year?: number;
  genre?: string;
  trackCount?: number;
  coverUrl?: string;
  source?: string;
}

function formatDuration(seconds?: number): string {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatQuality(track: Track): string {
  const parts: string[] = [];
  if (track.format) parts.push(track.format.toUpperCase());
  if (track.sampleRate) parts.push(`${(track.sampleRate / 1000).toFixed(1)}kHz`);
  if (track.bitDepth) parts.push(`${track.bitDepth}bit`);
  return parts.join(' / ');
}

export default function AlbumPage() {
  const { id } = useParams<{ id: string }>();
  const [album, setAlbum] = useState<Album | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [favorited, setFavorited] = useState(false);
  const { playTrack, playAlbum, currentTrack, isPlaying } = useAudioContext();

  const isSpotifyAlbum = id?.startsWith('spotify:') ?? false;

  useEffect(() => {
    if (!id) return;

    if (isSpotifyAlbum) {
      // Load from Spotify API
      const spotifyId = id.replace('spotify:', '');
      fetch(`/api/providers/spotify/albums/${spotifyId}`).then(r => r.json())
        .then((res) => setAlbum(res.data)).catch(() => {});
      fetch(`/api/providers/spotify/albums/${spotifyId}/tracks`).then(r => r.json())
        .then((res) => setTracks(res.data)).catch(() => {});
    } else {
      // Load from local library
      api.getAlbum(id).then((res) => setAlbum(res.data));
      api.getAlbumTracks(id).then((res) => setTracks(res.data));
      api.checkFavorite('album', id).then((res) => setFavorited(res.data.favorited)).catch(() => {});
    }
  }, [id, isSpotifyAlbum]);

  const toggleFavorite = async () => {
    if (!id) return;
    const res = await api.toggleFavorite('album', id);
    setFavorited(res.data.favorited);
  };

  if (!album) return <p className="text-gray-400">Loading...</p>;

  const totalDuration = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  const totalMin = Math.floor(totalDuration / 60);

  return (
    <div>
      {/* Album header */}
      <div className="flex gap-6 mb-8">
        <div className="w-56 h-56 bg-surface-light rounded-lg overflow-hidden shrink-0 shadow-lg">
          <img
            src={album.coverUrl || api.getAlbumCoverUrl(album.id)}
            alt={album.title}
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        </div>
        <div className="flex flex-col justify-end">
          <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Album</p>
          <h2 className="text-3xl font-bold mb-2">{album.title}</h2>
          <p className="text-gray-400">
            {album.artistName}
            {album.year && <span> &middot; {album.year}</span>}
            {album.genre && <span> &middot; {album.genre}</span>}
          </p>
          <p className="text-sm text-gray-500 mt-1">
            {tracks.length} tracks &middot; {totalMin} min
          </p>
          <div className="flex items-center gap-3 mt-4">
            <button
              onClick={() => playAlbum(tracks)}
              className="px-6 py-2 bg-accent rounded-full hover:bg-accent-hover transition text-sm font-medium"
            >
              Play Album
            </button>
            <button
              onClick={toggleFavorite}
              className={`w-9 h-9 rounded-full border flex items-center justify-center transition text-lg ${
                favorited ? 'border-accent text-accent' : 'border-white/20 text-gray-500 hover:border-accent hover:text-accent'
              }`}
              title={favorited ? 'Remove from favorites' : 'Add to favorites'}
            >
              {favorited ? '\u2665' : '\u2661'}
            </button>
          </div>
        </div>
      </div>

      {/* Track list */}
      <table className="w-full">
        <thead>
          <tr className="text-left text-xs text-gray-500 uppercase border-b border-white/10">
            <th className="pb-2 w-12">#</th>
            <th className="pb-2">Title</th>
            <th className="pb-2 hidden md:table-cell">Quality</th>
            <th className="pb-2 w-20 text-right">Duration</th>
            <th className="pb-2 w-8"></th>
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
                <td className="py-2.5 text-sm text-gray-500 w-12">
                  {isCurrent && isPlaying ? (
                    <span className="text-accent animate-pulse">&#9654;</span>
                  ) : (
                    track.trackNumber || '\u2014'
                  )}
                </td>
                <td className="py-2.5">
                  <p className="text-sm font-medium">{track.title}</p>
                  {track.artistName !== album.artistName && (
                    <p className="text-xs text-gray-500">{track.artistName}</p>
                  )}
                </td>
                <td className="py-2.5 text-xs text-gray-500 hidden md:table-cell">{formatQuality(track)}</td>
                <td className="py-2.5 text-sm text-gray-400 text-right">{formatDuration(track.duration)}</td>
                <td className="py-2.5"><AddToPlaylist trackId={track.id} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
