import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const { playTrack } = useAudioContext();

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    const res = await api.search(query);
    setResults(res.data);
    setLoading(false);
  };

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Search</h2>
      <div className="flex gap-2 mb-8">
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

      {results && (
        <div className="space-y-8">
          {results.artists?.length > 0 && (
            <section>
              <h3 className="text-lg font-semibold mb-3 text-gray-300">Artists ({results.artists.length})</h3>
              <div className="flex gap-3 flex-wrap">
                {results.artists.map((a: any) => (
                  <Link
                    key={a.id}
                    to={`/artists/${a.id}`}
                    className="px-4 py-2 bg-surface-light rounded-full text-sm hover:bg-surface hover:text-accent transition"
                  >
                    {a.name}
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
                    to={`/albums/${a.id}`}
                    className="bg-surface-light rounded-lg p-3 hover:bg-surface transition group"
                  >
                    <div className="aspect-square bg-surface-dark rounded mb-2 overflow-hidden">
                      <img
                        src={api.getAlbumCoverUrl(a.id)}
                        alt={a.title}
                        className="w-full h-full object-cover"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    </div>
                    <p className="text-sm font-medium truncate group-hover:text-accent transition">{a.title}</p>
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
                {results.tracks.map((t: any) => (
                  <div
                    key={t.id}
                    onClick={() => playTrack(t)}
                    className="flex items-center gap-4 px-3 py-2 rounded hover:bg-surface-light cursor-pointer transition"
                  >
                    <div className="w-8 h-8 rounded bg-surface-dark overflow-hidden shrink-0">
                      <img
                        src={api.getTrackCoverUrl(t.id)}
                        alt=""
                        className="w-full h-full object-cover"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    </div>
                    <span className="text-sm font-medium">{t.title}</span>
                    <span className="text-xs text-gray-500">{t.artistName} &mdash; {t.albumTitle}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {!results.artists?.length && !results.albums?.length && !results.tracks?.length && (
            <p className="text-gray-500 text-center py-8">No results found for "{query}"</p>
          )}
        </div>
      )}
    </div>
  );
}
