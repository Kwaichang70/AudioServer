import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';

const sourceColors: Record<string, string> = {
  local: 'bg-blue-900/50 text-blue-300',
  spotify: 'bg-green-900/50 text-green-300',
  tidal: 'bg-cyan-900/50 text-cyan-300',
};

function SourceBadge({ source }: { source?: string }) {
  if (!source || source === 'local') return null;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded ${sourceColors[source] || 'bg-gray-700 text-gray-300'}`}>
      {source}
    </span>
  );
}

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [searchMode, setSearchMode] = useState<'all' | 'local'>('all');
  const { playTrack } = useAudioContext();

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      if (searchMode === 'all') {
        // Unified search: local + Spotify + Tidal
        const [localRes, providerRes] = await Promise.allSettled([
          api.search(query),
          fetch(`/api/providers/search?q=${encodeURIComponent(query)}`).then(r => r.json()),
        ]);

        const local = localRes.status === 'fulfilled' ? localRes.value.data : { artists: [], albums: [], tracks: [] };
        const providers = providerRes.status === 'fulfilled' ? providerRes.value.data : { artists: [], albums: [], tracks: [], playlists: [] };

        setResults({
          artists: [...local.artists, ...providers.artists],
          albums: [...local.albums, ...providers.albums],
          tracks: [...local.tracks, ...providers.tracks],
          playlists: providers.playlists || [],
        });
      } else {
        const res = await api.search(query);
        setResults(res.data);
      }
    } catch {
      setResults(null);
    }
    setLoading(false);
  };

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Search</h2>
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="Search artists, albums, tracks..."
          className="flex-1 px-4 py-2 bg-surface-light border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
          autoFocus
        />
        <button
          onClick={handleSearch}
          disabled={loading}
          className="px-6 py-2 bg-accent rounded hover:bg-accent-hover transition disabled:opacity-50"
        >
          {loading ? '...' : 'Search'}
        </button>
      </div>

      {/* Source toggle */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setSearchMode('all')}
          className={`px-3 py-1 text-xs rounded transition ${
            searchMode === 'all' ? 'bg-accent text-white' : 'bg-surface-light text-gray-400 hover:text-white'
          }`}
        >
          All Sources
        </button>
        <button
          onClick={() => setSearchMode('local')}
          className={`px-3 py-1 text-xs rounded transition ${
            searchMode === 'local' ? 'bg-accent text-white' : 'bg-surface-light text-gray-400 hover:text-white'
          }`}
        >
          Local Only
        </button>
      </div>

      {results && (
        <div className="space-y-8">
          {results.artists?.length > 0 && (
            <section>
              <h3 className="text-lg font-semibold mb-3 text-gray-300">Artists ({results.artists.length})</h3>
              <div className="flex gap-3 flex-wrap">
                {results.artists.map((a: any) => (
                  <Link
                    key={a.id}
                    to={a.source === 'local' ? `/artists/${a.id}` : '#'}
                    className="flex items-center gap-2 px-4 py-2 bg-surface-light rounded-full text-sm hover:bg-surface hover:text-accent transition"
                  >
                    {a.imageUrl && <img src={a.imageUrl} alt="" className="w-6 h-6 rounded-full object-cover" />}
                    {a.name}
                    <SourceBadge source={a.source} />
                  </Link>
                ))}
              </div>
            </section>
          )}

          {results.albums?.length > 0 && (
            <section>
              <h3 className="text-lg font-semibold mb-3 text-gray-300">Albums ({results.albums.length})</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                {results.albums.map((a: any) => (
                  <Link
                    key={a.id}
                    to={a.source === 'local' ? `/albums/${a.id}` : '#'}
                    className="bg-surface-light rounded-lg p-3 hover:bg-surface transition group"
                  >
                    <div className="aspect-square bg-surface-dark rounded mb-2 overflow-hidden">
                      {a.coverUrl ? (
                        <img src={a.coverUrl} alt={a.title} className="w-full h-full object-cover" />
                      ) : a.source === 'local' ? (
                        <img
                          src={api.getAlbumCoverUrl(a.id)}
                          alt={a.title}
                          className="w-full h-full object-cover"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1 mb-0.5">
                      <p className="text-sm font-medium truncate group-hover:text-accent transition flex-1">{a.title}</p>
                      <SourceBadge source={a.source} />
                    </div>
                    <p className="text-xs text-gray-400 truncate">{a.artistName}</p>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {results.tracks?.length > 0 && (
            <section>
              <h3 className="text-lg font-semibold mb-3 text-gray-300">Tracks ({results.tracks.length})</h3>
              <div className="space-y-0.5">
                {results.tracks.map((t: any, i: number) => (
                  <div
                    key={`${t.id}-${i}`}
                    onClick={() => (t.source === 'local' || t.source === 'spotify') ? playTrack(t) : null}
                    className={`flex items-center gap-4 px-3 py-2 rounded hover:bg-surface-light transition ${
                      (t.source === 'local' || t.source === 'spotify') ? 'cursor-pointer' : 'opacity-70'
                    }`}
                  >
                    <div className="w-8 h-8 rounded bg-surface-dark overflow-hidden shrink-0">
                      {t.source === 'local' && (
                        <img
                          src={api.getTrackCoverUrl(t.id)}
                          alt=""
                          className="w-full h-full object-cover"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      )}
                    </div>
                    <span className="text-sm font-medium flex-1 min-w-0 truncate">{t.title}</span>
                    <span className="text-xs text-gray-500 truncate max-w-[200px]">{t.artistName} &mdash; {t.albumTitle}</span>
                    <SourceBadge source={t.source} />
                  </div>
                ))}
              </div>
            </section>
          )}

          {results.playlists?.length > 0 && (
            <section>
              <h3 className="text-lg font-semibold mb-3 text-gray-300">Playlists ({results.playlists.length})</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {results.playlists.map((p: any) => (
                  <div key={p.id} className="bg-surface-light rounded-lg p-3">
                    <div className="flex items-center gap-1 mb-0.5">
                      <p className="text-sm font-medium truncate flex-1">{p.name}</p>
                      <SourceBadge source={p.source} />
                    </div>
                    <p className="text-xs text-gray-500">{p.trackCount || 0} tracks</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {!results.artists?.length && !results.albums?.length && !results.tracks?.length && !results.playlists?.length && (
            <p className="text-gray-500 text-center py-8">No results found for "{query}"</p>
          )}
        </div>
      )}
    </div>
  );
}
