import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import AlbumCover from '../components/AlbumCover.js';
import { useAudioContext, type TrackInfo } from '../context/AudioContext.js';
import { useGridNavigation } from '../hooks/useGridNavigation.js';
import { formatDuration } from '../utils/format.js';

type Tab = 'album' | 'artist' | 'track' | 'station';

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
  duration?: number;
}

interface FavStation {
  id: string;
  uuid: string;
  name: string;
  genre?: string;
  country?: string;
  faviconUrl?: string;
}

export default function FavoritesPage() {
  const [tab, setTab] = useState<Tab>('album');
  const [albums, setAlbums] = useState<FavAlbum[]>([]);
  const [artists, setArtists] = useState<FavArtist[]>([]);
  const [tracks, setTracks] = useState<FavTrack[]>([]);
  const [stations, setStations] = useState<FavStation[]>([]);
  const [loading, setLoading] = useState(true);
  const requestEpochRef = useRef(0);
  const { playTrack } = useAudioContext();
  const trackNav = useGridNavigation<HTMLDivElement>(tracks.length, { orientation: 'vertical' });

  useEffect(() => {
    const requestEpoch = ++requestEpochRef.current;
    const isCurrent = () => requestEpochRef.current === requestEpoch;
    setLoading(true);
    const done = () => {
      if (isCurrent()) setLoading(false);
    };
    if (tab === 'album') {
      api
        .getFavorites('album')
        .then((res) => {
          if (isCurrent()) setAlbums(res.data);
        })
        .catch(() => {})
        .finally(done);
    } else if (tab === 'artist') {
      api
        .getFavorites('artist')
        .then((res) => {
          if (isCurrent()) setArtists(res.data);
        })
        .catch(() => {})
        .finally(done);
    } else if (tab === 'station') {
      api
        .getFavorites('station')
        .then((res) => {
          if (isCurrent()) setStations(res.data);
        })
        .catch(() => {})
        .finally(done);
    } else {
      api
        .getFavoriteTracks()
        .then((res) => {
          if (isCurrent()) setTracks(res.data);
        })
        .catch(() => {})
        .finally(done);
    }

    return () => {
      if (isCurrent()) requestEpochRef.current += 1;
    };
  }, [tab]);

  const tabs: { key: Tab; label: string }[] = [
    { key: 'album', label: 'Albums' },
    { key: 'artist', label: 'Artists' },
    { key: 'track', label: 'Tracks' },
    { key: 'station', label: 'Radio' },
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
              tab === t.key
                ? 'bg-accent text-white'
                : 'bg-surface-light text-gray-400 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && <p className="text-gray-400">Loading...</p>}

      {/* Albums */}
      {!loading &&
        tab === 'album' &&
        (albums.length === 0 ? (
          <p className="text-gray-500 py-12 text-center">
            No favorite albums yet. Tap the heart on an album to add it here.
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {albums.map((album) => (
              <Link
                key={album.id}
                to={`/albums/${album.id}`}
                className="group bg-surface-light rounded-lg p-3 hover:bg-surface transition"
              >
                <div className="mb-2">
                  <AlbumCover
                    albumId={album.id}
                    title={album.title}
                    artistName={album.artistName}
                  />
                </div>
                <p className="text-sm font-medium truncate group-hover:text-accent transition">
                  {album.title}
                </p>
                <p className="text-xs text-gray-400 truncate">{album.artistName}</p>
                {album.year && <p className="text-xs text-gray-500">{album.year}</p>}
              </Link>
            ))}
          </div>
        ))}

      {/* Artists */}
      {!loading &&
        tab === 'artist' &&
        (artists.length === 0 ? (
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
                    loading="lazy"
                    decoding="async"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                </div>
                <p className="text-sm font-medium truncate group-hover:text-accent transition">
                  {artist.name}
                </p>
              </Link>
            ))}
          </div>
        ))}

      {/* Tracks */}
      {!loading &&
        tab === 'track' &&
        (tracks.length === 0 ? (
          <p className="text-gray-500 py-12 text-center">No favorite tracks yet.</p>
        ) : (
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- delegates arrow keys to focusable track buttons
          <div
            ref={trackNav.containerRef}
            onKeyDown={trackNav.onKeyDown}
            role="group"
            aria-label="Favorite tracks"
            className="space-y-1"
          >
            {tracks.map((track) => (
              <button
                key={track.id}
                data-grid-item
                onClick={() => playTrack(track satisfies TrackInfo)}
                className="w-full flex items-center gap-4 px-4 py-2 rounded hover:bg-surface-light transition text-left focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <div className="w-10 h-10 rounded bg-surface-dark overflow-hidden flex-shrink-0">
                  <img
                    src={api.getAlbumCoverUrl(track.albumId)}
                    alt=""
                    className="w-full h-full object-cover"
                    loading="lazy"
                    decoding="async"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{track.title}</p>
                  <p className="text-xs text-gray-400 truncate">
                    {track.artistName} &middot; {track.albumTitle}
                  </p>
                </div>
                <span className="text-xs text-gray-500 flex-shrink-0">
                  {track.duration ? formatDuration(track.duration) : ''}
                </span>
              </button>
            ))}
          </div>
        ))}

      {/* Radio stations */}
      {!loading &&
        tab === 'station' &&
        (stations.length === 0 ? (
          <p className="text-gray-500 py-12 text-center">
            No favorite stations yet. Tap the heart on a station in Radio.
          </p>
        ) : (
          <div className="space-y-1">
            {stations.map((s) => (
              <button
                key={s.id}
                onClick={() =>
                  playTrack({
                    id: s.id,
                    title: s.name,
                    artistName: 'Live Radio',
                    albumTitle: s.genre || 'Online Radio',
                    duration: 0,
                  })
                }
                className="w-full flex items-center gap-4 px-4 py-2 rounded hover:bg-surface-light transition text-left focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <div className="w-10 h-10 rounded bg-surface-dark overflow-hidden flex-shrink-0 flex items-center justify-center text-gray-500">
                  {s.faviconUrl ? (
                    <img
                      src={s.faviconUrl}
                      alt=""
                      className="w-full h-full object-cover"
                      loading="lazy"
                      decoding="async"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  ) : (
                    <span aria-hidden="true">📻</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{s.name}</p>
                  <p className="text-xs text-gray-400 truncate">
                    {[s.genre, s.country].filter(Boolean).join(' · ') || 'Online Radio'}
                  </p>
                </div>
              </button>
            ))}
          </div>
        ))}
    </div>
  );
}
