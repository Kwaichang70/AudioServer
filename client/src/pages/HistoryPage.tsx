import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';

interface HistoryEntry {
  id: number;
  track_id: string;
  album_id: string;
  artist_id: string;
  played_at: string;
  track_title: string;
  album_title: string;
  artist_name: string;
  duration: number;
}

interface RecentAlbum {
  album_id: string;
  title: string;
  artist_name: string;
}

interface TopArtist {
  id: string;
  name: string;
  play_count: number;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const hours = diff / (1000 * 60 * 60);
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

type View = 'tracks' | 'albums' | 'artists';

export default function HistoryPage() {
  const [view, setView] = useState<View>('tracks');
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [recentAlbums, setRecentAlbums] = useState<RecentAlbum[]>([]);
  const [topArtists, setTopArtists] = useState<TopArtist[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const { playTrack } = useAudioContext();

  useEffect(() => {
    setLoading(true);
    if (view === 'tracks') {
      api.getHistoryTracks(1, 50).then((res) => {
        setEntries(res.data);
        setHasMore(res.meta?.page < res.meta?.totalPages);
        setPage(1);
      }).catch(() => {}).finally(() => setLoading(false));
    } else if (view === 'albums') {
      api.getRecentAlbums().then((res) => setRecentAlbums(res.data)).catch(() => {}).finally(() => setLoading(false));
    } else {
      api.getTopArtists().then((res) => setTopArtists(res.data)).catch(() => {}).finally(() => setLoading(false));
    }
  }, [view]);

  const loadMore = () => {
    const nextPage = page + 1;
    api.getHistoryTracks(nextPage, 50).then((res) => {
      setEntries((prev) => [...prev, ...res.data]);
      setHasMore(res.meta?.page < res.meta?.totalPages);
      setPage(nextPage);
    }).catch(() => {});
  };

  const views: { key: View; label: string }[] = [
    { key: 'tracks', label: 'All Plays' },
    { key: 'albums', label: 'Recent Albums' },
    { key: 'artists', label: 'Top Artists' },
  ];

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">History</h2>

      {/* View tabs */}
      <div className="flex gap-1 mb-6">
        {views.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={`px-4 py-1.5 rounded text-sm transition ${
              view === v.key ? 'bg-accent text-white' : 'bg-surface-light text-gray-400 hover:text-white'
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {loading && <p className="text-gray-400">Loading...</p>}

      {/* All Plays */}
      {!loading && view === 'tracks' && (
        entries.length === 0 ? (
          <p className="text-gray-500 py-12 text-center">No play history yet. Start listening to build your history.</p>
        ) : (
          <>
            <div className="space-y-1">
              {entries.map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => entry.track_id && playTrack({ id: entry.track_id, title: entry.track_title, artistName: entry.artist_name, albumId: entry.album_id, albumTitle: entry.album_title, duration: entry.duration } as any)}
                  className="w-full flex items-center gap-4 px-4 py-2 rounded hover:bg-surface-light transition text-left"
                >
                  <div className="w-10 h-10 rounded bg-surface-dark overflow-hidden flex-shrink-0">
                    {entry.album_id && (
                      <img
                        src={api.getAlbumCoverUrl(entry.album_id)}
                        alt=""
                        className="w-full h-full object-cover"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{entry.track_title || 'Unknown Track'}</p>
                    <p className="text-xs text-gray-400 truncate">{entry.artist_name} &middot; {entry.album_title}</p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    {entry.duration > 0 && <span className="text-xs text-gray-500">{formatDuration(entry.duration)}</span>}
                    <span className="text-xs text-gray-600 w-20 text-right">{formatDate(entry.played_at)}</span>
                  </div>
                </button>
              ))}
            </div>
            {hasMore && (
              <div className="flex justify-center mt-6">
                <button
                  onClick={loadMore}
                  className="px-6 py-2 bg-surface-light border border-white/10 rounded hover:border-accent transition"
                >
                  Load More
                </button>
              </div>
            )}
          </>
        )
      )}

      {/* Recent Albums */}
      {!loading && view === 'albums' && (
        recentAlbums.length === 0 ? (
          <p className="text-gray-500 py-12 text-center">No recently played albums.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {recentAlbums.map((album) => (
              <Link
                key={album.album_id}
                to={`/albums/${album.album_id}`}
                className="group bg-surface-light rounded-lg p-3 hover:bg-surface transition"
              >
                <div className="aspect-square bg-surface-dark rounded mb-2 overflow-hidden">
                  <img
                    src={api.getAlbumCoverUrl(album.album_id)}
                    alt={album.title}
                    className="w-full h-full object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                </div>
                <p className="text-sm font-medium truncate group-hover:text-accent transition">{album.title}</p>
                <p className="text-xs text-gray-400 truncate">{album.artist_name}</p>
              </Link>
            ))}
          </div>
        )
      )}

      {/* Top Artists */}
      {!loading && view === 'artists' && (
        topArtists.length === 0 ? (
          <p className="text-gray-500 py-12 text-center">No top artists yet.</p>
        ) : (
          <div className="space-y-1">
            {topArtists.map((artist, i) => (
              <Link
                key={artist.id}
                to={`/artists/${artist.id}`}
                className="flex items-center gap-4 px-4 py-3 rounded hover:bg-surface-light transition group"
              >
                <span className="text-sm text-gray-500 w-6 text-right">{i + 1}</span>
                <div className="w-10 h-10 rounded-full bg-surface-dark overflow-hidden flex-shrink-0">
                  <img
                    src={api.getArtistImageUrl(artist.id)}
                    alt=""
                    className="w-full h-full object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium group-hover:text-accent transition">{artist.name}</p>
                </div>
                <span className="text-xs text-gray-500">{artist.play_count} plays</span>
              </Link>
            ))}
          </div>
        )
      )}
    </div>
  );
}
