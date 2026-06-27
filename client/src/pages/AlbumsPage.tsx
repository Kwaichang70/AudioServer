import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useInfiniteLoad, useAutoLoadMore } from '../hooks/useInfiniteLoad.js';
import { useGridNavigation } from '../hooks/useGridNavigation.js';
import AlbumCover from '../components/AlbumCover.js';
import { formatQuality } from '../utils/format.js';
import { DEFAULT_LIBRARY_PAGE_SIZE } from '../constants.js';

interface Album {
  id: string;
  title: string;
  artistName: string;
  year?: number;
  trackCount?: number;
  format?: string;
  sampleRate?: number;
  bitDepth?: number;
}

export default function AlbumsPage() {
  const {
    items: albums,
    loading,
    loadingMore,
    total,
    hasMore,
    loadMore,
    reload,
  } = useInfiniteLoad<Album>(
    (page, limit) => api.getAlbums(page, limit),
    DEFAULT_LIBRARY_PAGE_SIZE,
  );

  // Infinite-scroll sentinel: fires loadMore when the bottom of the list is
  // within 400px of the viewport. The "Load More" button below stays as a
  // keyboard/no-JS fallback.
  const sentinelRef = useAutoLoadMore(loadMore, hasMore);
  const { containerRef, onKeyDown } = useGridNavigation<HTMLDivElement>(albums.length);

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
          {/* Roving-tabindex keyboard nav over the album cards. Deliberately
              not role="grid": these are navigable links, not tabular data, and
              the cards themselves carry focus. The div carries onKeyDown to
              delegate to its focusable <a> children (jsx-a11y warns about this;
              it's the standard event-delegation pattern). */}
          <div
            ref={containerRef}
            onKeyDown={onKeyDown}
            aria-label="Albums"
            className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4"
          >
            {albums.map((album) => (
              <Link
                key={album.id}
                to={`/albums/${album.id}`}
                data-grid-item
                className="group bg-surface-light rounded-lg p-3 hover:bg-surface transition focus:outline-none focus:ring-2 focus:ring-accent"
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
                <div className="flex items-center gap-1.5">
                  {album.year && <span className="text-xs text-gray-500">{album.year}</span>}
                  {formatQuality(album) && (
                    <span className="text-[10px] px-1 py-0.5 rounded bg-white/5 text-gray-500 truncate">
                      {formatQuality(album)}
                    </span>
                  )}
                </div>
              </Link>
            ))}
          </div>

          {hasMore && (
            <>
              <div ref={sentinelRef} className="h-10" aria-hidden="true" />
              <div className="flex justify-center mt-2">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="px-6 py-2 bg-surface-light border border-white/10 rounded hover:border-accent transition disabled:opacity-50"
                >
                  {loadingMore ? 'Loading...' : `Load More (${albums.length} of ${total})`}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
