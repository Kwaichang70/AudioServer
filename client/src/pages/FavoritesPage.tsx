import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import AlbumCover from '../components/AlbumCover.js';
import { useAudioContext } from '../context/AudioContext.js';

type Tab = 'album' | 'artist' | 'track';

interface FavAlbum {
  id: string;
  title: string;
  artistName: string;
  year?: number;
}

interface FavArtist {
  id: string;
  name: string;
}

interface FavTrack {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  albumId: string;
  duration: number;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function FavoritesPage() {
  const [tab, setTab] = useState<Tab>('album');
  const [albums, setAlbums] = useState<FavAlbum[]>([]);
  const [artists, setArtists] = useState<FavArtist[]>([]);
  const [tracks, setTracks] = useState<FavTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const { playTrack } = useAudioContext();

  useEffect(() => {
    setLoading(true);
    if (tab === 'album') {
      api.getFavorites('album').then((res) => setAlbums(res.data)).catch(() => {}).finally(() => setLoading(false));
    } else if (tab === 'artist') {
      api.getFavorites('artist').then((res) => setArtists(res.data)).catch(() => {}).finally(() => setLoading(false));
    } else {
      api.getFavoriteTracks().then((res) => setTracks(res.data)).catch(() => {}).finally(() => setLoading(false));
    }
  }, [tab]);

  const tabs: { key: Tab; label: string }[] = [
    { key: 'album', label: 'Albums' },
    { key: 'artist', label: 'Artists' },
    { key: 'track', label: 'Tracks' },
  ];

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Favorites</h2>

      {/* Tabs */}
      <div className="flex gap-1 mb-6">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-1.5 rounded text-sm transition ${
              tab === t.key ? 'bg-accent text-white' : 'bg-surface-light text-gray-400 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && <p className="text-gray-400">Loading...</p>}

      {/* Albums */}
      {!loading && tab === 'album' && (
        albums.length === 0 ? (
          <p className="text-gray-500 py-12 text-center">No favorite albums yet. Tap the heart on an album to add it here.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {albums.map((album) => (
              <Link
                key={album.id}
                to={`/albums/${album.id}`}
                className="group bg-surface-light rounded-lg p-3 hover:bg-surface transition"
              >
                <div className="mb-2">
                  <AlbumCover albumId={album.id} title={album.title} artistName={album.artistName} />
                </div>
                <p className="text-sm font-medium truncate group-hover:text-accent transition">{album.title}</p>
                <p className="text-xs text-gray-400 truncate">{album.artistName}</p>
                {album.year && <p className="text-xs text-gray-500">{album.year}</p>}
              </Link>
            ))}
          </div>
        )
      )}

      {/* Artists */}
      {!loading && tab === 'artist' && (
        artists.length === 0 ? (
          <p className="text-gray-500 py-12 text-center">No favorite artists yet.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {artists.map((artist) => (
              <Link
                key={artist.id}
                to={`/artists/${artist.id}`}
                className="group bg-surface-light rounded-lg p-4 hover:bg-surface transition text-center"
              >
                <div className="w-20 h-20 mx-auto mb-3 rounded-full bg-surface-dark overflow-hidden">
                  <img
                    src={api.getArtistImageUrl(artist.id)}
                    alt={artist.name}
                    className="w-full h-full object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                </div>
                <p className="text-sm font-medium truncate group-hover:text-accent transition">{artist.name}</p>
              </Link>
            ))}
          </div>
        )
      )}

      {/* Tracks */}
      {!loading && tab === 'track' && (
        tracks.length === 0 ? (
          <p className="text-gray-500 py-12 text-center">No favorite tracks yet.</p>
        ) : (
          <div className="space-y-1">
            {tracks.map((track) => (
              <button
                key={track.id}
                onClick={() => playTrack(track as any)}
                className="w-full flex items-center gap-4 px-4 py-2 rounded hover:bg-surface-light transition text-left"
              >
                <div className="w-10 h-10 rounded bg-surface-dark overflow-hidden flex-shrink-0">
                  <img
                    src={api.getAlbumCoverUrl(track.albumId)}
                    alt=""
                    className="w-full h-full object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{track.title}</p>
                  <p className="text-xs text-gray-400 truncate">{track.artistName} &middot; {track.albumTitle}</p>
                </div>
                <span className="text-xs text-gray-500 flex-shrink-0">
                  {track.duration ? formatDuration(track.duration) : ''}
                </span>
              </button>
            ))}
          </div>
        )
      )}
    </div>
  );
}
