import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';

interface Album {
  id: string;
  title: string;
  artistName: string;
  year?: number;
  coverUrl?: string;
  trackCount?: number;
}

export default function AlbumsPage() {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getAlbums().then((res) => {
      setAlbums(res.data);
      setLoading(false);
    });
  }, []);

  if (loading) return <p className="text-gray-400">Loading albums...</p>;

  if (albums.length === 0) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-400 mb-4">No albums found in your library.</p>
        <button
          onClick={() => api.scanLibrary().then(() => window.location.reload())}
          className="px-4 py-2 bg-accent rounded hover:bg-accent-hover transition"
        >
          Scan Library
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Albums</h2>
        <button
          onClick={() => api.scanLibrary().then(() => window.location.reload())}
          className="px-3 py-1 text-sm bg-surface-light border border-white/10 rounded hover:border-accent transition"
        >
          Rescan
        </button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        {albums.map((album) => (
          <Link
            key={album.id}
            to={`/albums/${album.id}`}
            className="group bg-surface-light rounded-lg p-3 hover:bg-surface transition"
          >
            <div className="aspect-square bg-surface-dark rounded mb-2 flex items-center justify-center text-4xl text-gray-600">
              {album.coverUrl ? (
                <img src={album.coverUrl} alt={album.title} className="w-full h-full object-cover rounded" />
              ) : (
                '♪'
              )}
            </div>
            <p className="text-sm font-medium truncate group-hover:text-accent transition">{album.title}</p>
            <p className="text-xs text-gray-400 truncate">{album.artistName}</p>
            {album.year && <p className="text-xs text-gray-500">{album.year}</p>}
          </Link>
        ))}
      </div>
    </div>
  );
}
