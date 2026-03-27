import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';

interface Stats {
  artists: number;
  albums: number;
  tracks: number;
}

interface RecentAlbum {
  album_id: string;
  title: string;
  artist_name: string;
  year?: number;
}

interface TopArtist {
  id: string;
  name: string;
  play_count: number;
}

export default function HomePage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentAlbums, setRecentAlbums] = useState<RecentAlbum[]>([]);
  const [topArtists, setTopArtists] = useState<TopArtist[]>([]);

  useEffect(() => {
    api.getStats().then((res) => setStats(res.data)).catch(() => {});
    api.getRecentAlbums().then((res) => setRecentAlbums(res.data)).catch(() => {});
    api.getTopArtists().then((res) => setTopArtists(res.data)).catch(() => {});
  }, []);

  return (
    <div className="space-y-10">
      {/* Welcome + Stats */}
      <section>
        <h2 className="text-3xl font-bold mb-2">Welcome</h2>
        {stats && (
          <div className="flex gap-6 text-sm text-gray-400">
            <Link to="/artists" className="hover:text-accent transition">
              <span className="text-2xl font-bold text-white">{stats.artists}</span> artists
            </Link>
            <Link to="/albums" className="hover:text-accent transition">
              <span className="text-2xl font-bold text-white">{stats.albums}</span> albums
            </Link>
            <span>
              <span className="text-2xl font-bold text-white">{stats.tracks}</span> tracks
            </span>
          </div>
        )}
      </section>

      {/* Recently Played */}
      {recentAlbums.length > 0 && (
        <section>
          <h3 className="text-xl font-semibold mb-4">Recently Played</h3>
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
        </section>
      )}

      {/* Top Artists */}
      {topArtists.length > 0 && (
        <section>
          <h3 className="text-xl font-semibold mb-4">Top Artists</h3>
          <div className="flex gap-4 flex-wrap">
            {topArtists.map((artist) => (
              <Link
                key={artist.id}
                to={`/artists/${artist.id}`}
                className="flex items-center gap-3 bg-surface-light rounded-full px-4 py-2 hover:bg-surface transition group"
              >
                <div className="w-8 h-8 rounded-full bg-surface-dark flex items-center justify-center text-sm text-gray-500">
                  &#9835;
                </div>
                <div>
                  <p className="text-sm font-medium group-hover:text-accent transition">{artist.name}</p>
                  <p className="text-xs text-gray-500">{artist.play_count} plays</p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Quick Links */}
      {recentAlbums.length === 0 && (
        <section className="text-center py-12">
          <p className="text-gray-500 mb-4">Start playing music to see your history here.</p>
          <div className="flex gap-4 justify-center">
            <Link to="/albums" className="px-6 py-2 bg-accent rounded-full hover:bg-accent-hover transition">
              Browse Albums
            </Link>
            <Link to="/search" className="px-6 py-2 bg-surface-light border border-white/10 rounded-full hover:border-accent transition">
              Search
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
