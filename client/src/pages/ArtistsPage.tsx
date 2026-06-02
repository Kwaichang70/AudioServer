import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useInfiniteLoad, useAutoLoadMore } from '../hooks/useInfiniteLoad.js';
import { useGridNavigation } from '../hooks/useGridNavigation.js';
import { DEFAULT_LIBRARY_PAGE_SIZE } from '../constants.js';

interface Artist {
  id: string;
  name: string;
}

function ArtistImage({ artistId, name }: { artistId: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const initial = name.charAt(0).toUpperCase();

  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;

  if (failed) {
    return (
      <div
        className="w-24 h-24 mx-auto mb-3 rounded-full flex items-center justify-center text-3xl font-bold text-white/80"
        style={{ background: `hsl(${hue}, 40%, 25%)` }}
      >
        {initial}
      </div>
    );
  }

  return (
    <div className="w-24 h-24 mx-auto mb-3 rounded-full overflow-hidden bg-surface-dark">
      <img
        src={api.getArtistImageUrl(artistId)}
        alt={name}
        className="w-full h-full object-cover"
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

export default function ArtistsPage() {
  const {
    items: artists,
    loading,
    loadingMore,
    total,
    hasMore,
    loadMore,
  } = useInfiniteLoad<Artist>(
    (page, limit) => api.getArtists(page, limit),
    DEFAULT_LIBRARY_PAGE_SIZE,
  );
  const sentinelRef = useAutoLoadMore(loadMore, hasMore);
  const { containerRef, onKeyDown } = useGridNavigation<HTMLDivElement>(artists.length);

  if (loading) return <p className="text-gray-400">Loading artists...</p>;

  if (artists.length === 0) {
    return <p className="text-gray-400">No artists found. Scan your library first.</p>;
  }

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">
        Artists <span className="text-sm font-normal text-gray-500">({total})</span>
      </h2>
      {/* Roving-tabindex keyboard nav over the artist cards. Deliberately not
          role="grid": navigable links, not tabular data. The div delegates
          onKeyDown to its focusable <a> children. */}
      <div
        ref={containerRef}
        onKeyDown={onKeyDown}
        aria-label="Artists"
        className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4"
      >
        {artists.map((artist) => (
          <Link
            key={artist.id}
            to={`/artists/${artist.id}`}
            data-grid-item
            className="bg-surface-light rounded-lg p-4 text-center hover:bg-surface transition group focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <ArtistImage artistId={artist.id} name={artist.name} />
            <p className="text-sm font-medium truncate group-hover:text-accent transition">
              {artist.name}
            </p>
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
              {loadingMore ? 'Loading...' : `Load More (${artists.length} of ${total})`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
