import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ProviderType } from '@audioserver/shared';
import { api } from '../api/client.js';
import { useAudioContext, type TrackInfo } from '../context/AudioContext.js';
import { SOURCE_COLORS } from '../constants.js';

interface SearchArtist {
  id: string;
  name: string;
  imageUrl?: string;
  source?: ProviderType;
  availableOn?: ProviderType[];
}

interface SearchAlbum {
  id: string;
  title: string;
  artistName: string;
  coverUrl?: string;
  source?: ProviderType;
  availableOn?: ProviderType[];
}

interface SearchTrack extends TrackInfo {
  source?: ProviderType;
  availableOn?: ProviderType[];
}

interface SearchPlaylist {
  id: string;
  name: string;
  trackCount?: number;
  source?: ProviderType;
  availableOn?: ProviderType[];
}

interface SearchResults {
  artists: SearchArtist[];
  albums: SearchAlbum[];
  tracks: SearchTrack[];
  playlists: SearchPlaylist[];
}

const PLAYABLE_TRACK_SOURCES = new Set<ProviderType>(['local', 'qobuz', 'spotify', 'radio']);

function SourceBadge({ source }: { source?: ProviderType }) {
  if (!source || source === 'local') return null;
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded ${SOURCE_COLORS[source] || 'bg-gray-700 text-gray-300'}`}
    >
      {source}
    </span>
  );
}

function SourceBadges({
  source,
  availableOn,
}: {
  source?: ProviderType;
  availableOn?: ProviderType[];
}) {
  const sources = availableOn?.length ? availableOn : source ? [source] : [];
  const visibleSources = sources.filter((s) => s !== 'local');
  if (visibleSources.length === 0) return null;
  return (
    <>
      {visibleSources.map((s) => (
        <SourceBadge key={s} source={s} />
      ))}
    </>
  );
}

function isPlayableTrack(track: SearchTrack): boolean {
  return PLAYABLE_TRACK_SOURCES.has(track.source ?? 'local');
}

export default function SearchPage() {
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get('q') ?? '');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchMode, setSearchMode] = useState<'all' | 'local'>('all');
  const { playTrack } = useAudioContext();
  // Monotonic sequence guards against out-of-order responses: a slow 'all
  // sources' search must not overwrite the results of a newer query.
  const searchSeqRef = useRef(0);
  const doSearch = async (mode: 'all' | 'local', q: string = query) => {
    if (!q.trim()) return;
    const seq = ++searchSeqRef.current;
    setLoading(true);
    try {
      if (mode === 'all') {
        // Unified search already includes local + active providers and performs
        // provider-priority deduplication on the server.
        const res = await api.providerSearch(q);
        if (seq !== searchSeqRef.current) return;
        setResults(res.data);
      } else {
        const res = await api.search(q);
        if (seq !== searchSeqRef.current) return;
        setResults({ playlists: [], ...res.data });
      }
    } catch {
      if (seq !== searchSeqRef.current) return;
      setResults(null);
    }
    if (seq === searchSeqRef.current) setLoading(false);
  };

  // Deep-linked search (e.g. from a ListenBrainz recommendation): pick up ?q=
  // and run it. Re-runs if the param changes while staying on the page.
  useEffect(() => {
    const q = searchParams.get('q') ?? '';
    if (q.trim()) {
      setQuery(q);
      doSearch('all', q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Search</h2>
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSearch(searchMode)}
          placeholder="Search artists, albums, tracks..."
          className="flex-1 px-4 py-2 bg-surface-light border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
        />
        <button
          onClick={() => doSearch(searchMode)}
          disabled={loading}
          className="px-6 py-2 bg-accent rounded hover:bg-accent-hover transition disabled:opacity-50"
        >
          {loading ? '...' : 'Search'}
        </button>
      </div>

      {/* Source toggle */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => {
            setSearchMode('all');
            doSearch('all');
          }}
          className={`px-3 py-1 text-xs rounded transition ${
            searchMode === 'all'
              ? 'bg-accent text-white'
              : 'bg-surface-light text-gray-400 hover:text-white'
          }`}
        >
          All Sources
        </button>
        <button
          onClick={() => {
            setSearchMode('local');
            doSearch('local');
          }}
          className={`px-3 py-1 text-xs rounded transition ${
            searchMode === 'local'
              ? 'bg-accent text-white'
              : 'bg-surface-light text-gray-400 hover:text-white'
          }`}
        >
          Local Only
        </button>
      </div>

      {results && (
        <div className="space-y-8">
          {results.artists?.length > 0 && (
            <section>
              <h3 className="text-lg font-semibold mb-3 text-gray-300">
                Artists ({results.artists.length})
              </h3>
              <div className="flex gap-3 flex-wrap">
                {results.artists.map((a, i) => (
                  <Link
                    key={`${a.source}-${a.id}-${i}`}
                    to={
                      a.source === 'local'
                        ? `/artists/${a.id}`
                        : `/search?q=${encodeURIComponent(a.name)}`
                    }
                    className="flex items-center gap-2 px-4 py-2 bg-surface-light rounded-full text-sm hover:bg-surface hover:text-accent transition"
                  >
                    {a.imageUrl && (
                      <img src={a.imageUrl} alt="" className="w-6 h-6 rounded-full object-cover" />
                    )}
                    {a.name}
                    <SourceBadges source={a.source} availableOn={a.availableOn} />
                  </Link>
                ))}
              </div>
            </section>
          )}

          {results.albums?.length > 0 && (
            <section>
              <h3 className="text-lg font-semibold mb-3 text-gray-300">
                Albums ({results.albums.length})
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                {results.albums.map((a, i) => (
                  <Link
                    key={`${a.source}-${a.id}-${i}`}
                    to={`/albums/${a.id}`}
                    className="bg-surface-light rounded-lg p-3 hover:bg-surface transition group"
                  >
                    <div className="aspect-square bg-surface-dark rounded mb-2 overflow-hidden">
                      {a.coverUrl ? (
                        <img
                          src={a.coverUrl}
                          alt={a.title}
                          className="w-full h-full object-cover"
                          loading="lazy"
                          decoding="async"
                        />
                      ) : a.source === 'local' ? (
                        <img
                          src={api.getAlbumCoverUrl(a.id)}
                          alt={a.title}
                          className="w-full h-full object-cover"
                          loading="lazy"
                          decoding="async"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1 mb-0.5">
                      <p className="text-sm font-medium truncate group-hover:text-accent transition flex-1">
                        {a.title}
                      </p>
                      <SourceBadges source={a.source} availableOn={a.availableOn} />
                    </div>
                    <p className="text-xs text-gray-400 truncate">{a.artistName}</p>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {results.tracks?.length > 0 && (
            <section>
              <h3 className="text-lg font-semibold mb-3 text-gray-300">
                Tracks ({results.tracks.length})
              </h3>
              <div className="space-y-0.5">
                {results.tracks.map((t, i) => (
                  // Use index to ensure unique keys across local + spotify results
                  <button
                    type="button"
                    key={`${t.id}-${i}`}
                    onClick={() => playTrack(t)}
                    disabled={!isPlayableTrack(t)}
                    className={`w-full text-left flex items-center gap-4 px-3 py-2 rounded hover:bg-surface-light transition ${
                      isPlayableTrack(t) ? 'cursor-pointer' : 'opacity-70'
                    }`}
                  >
                    <div className="w-8 h-8 rounded bg-surface-dark overflow-hidden shrink-0">
                      {t.source === 'local' && (
                        <img
                          src={api.getTrackCoverUrl(t.id)}
                          alt=""
                          className="w-full h-full object-cover"
                          loading="lazy"
                          decoding="async"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      )}
                    </div>
                    <span className="text-sm font-medium flex-1 min-w-0 truncate">{t.title}</span>
                    <span className="text-xs text-gray-500 truncate max-w-[200px]">
                      {t.artistName} &mdash; {t.albumTitle}
                    </span>
                    <SourceBadges source={t.source} availableOn={t.availableOn} />
                  </button>
                ))}
              </div>
            </section>
          )}

          {results.playlists?.length > 0 && (
            <section>
              <h3 className="text-lg font-semibold mb-3 text-gray-300">
                Playlists ({results.playlists.length})
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {results.playlists.map((p) => (
                  <div key={p.id} className="bg-surface-light rounded-lg p-3">
                    <div className="flex items-center gap-1 mb-0.5">
                      <p className="text-sm font-medium truncate flex-1">{p.name}</p>
                      <SourceBadges source={p.source} availableOn={p.availableOn} />
                    </div>
                    <p className="text-xs text-gray-500">{p.trackCount || 0} tracks</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {!results.artists?.length &&
            !results.albums?.length &&
            !results.tracks?.length &&
            !results.playlists?.length && (
              <p className="text-gray-500 text-center py-8">No results found for "{query}"</p>
            )}
        </div>
      )}
    </div>
  );
}
