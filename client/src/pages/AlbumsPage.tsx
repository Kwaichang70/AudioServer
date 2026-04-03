import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useInfiniteLoad } from '../hooks/useInfiniteLoad.js';
import AlbumCover from '../components/AlbumCover.js';

interface Album {
  id: string;
  title: string;
  artistName: string;
  year?: number;
  trackCount?: number;
}

export default function AlbumsPage() {
  const { items: albums, loading, loadingMore, total, hasMore, loadMore, reload } = useInfiniteLoad<Album>(
    (page, limit) => api.getAlbums(page, limit),
    60,
  );

  const startScan = async () => {
    await api.scanLibrary();
    reload();
  };

  if (loading) return <p className="text-gray-400">Loading albums...</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">
          Albums <span className="text-sm font-normal text-gray-500">({total})</span>
        </h2>
        <button
          onClick={startScan}
          className="px-3 py-1 text-sm bg-surface-light border border-white/10 rounded hover:border-accent transition"
        >
          Scan Library
        </button>
      </div>

      {albums.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-gray-400 mb-4">No albums found in your library.</p>
          <button
            onClick={startScan}
            className="px-4 py-2 bg-accent rounded hover:bg-accent-hover transition"
          >
            Scan Library
          </button>
        </div>
      ) : (
        <>
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

          {hasMore && (
            <div className="flex justify-center mt-8">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="px-6 py-2 bg-surface-light border border-white/10 rounded hover:border-accent transition disabled:opacity-50"
              >
                {loadingMore ? 'Loading...' : `Load More (${albums.length} of ${total})`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
