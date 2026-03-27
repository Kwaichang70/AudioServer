import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any>(null);
  const { playTrack } = useAudioContext();

  const handleSearch = async () => {
    if (!query.trim()) return;
    const res = await api.search(query);
    setResults(res.data);
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
        />
        <button
          onClick={handleSearch}
          className="px-6 py-2 bg-accent rounded hover:bg-accent-hover transition"
        >
          Search
        </button>
      </div>

      {results && (
        <div className="space-y-8">
          {results.artists?.length > 0 && (
            <section>
              <h3 className="text-lg font-semibold mb-3 text-gray-300">Artists</h3>
              <div className="flex gap-3 flex-wrap">
                {results.artists.map((a: any) => (
                  <span key={a.id} className="px-3 py-1 bg-surface-light rounded text-sm">{a.name}</span>
                ))}
              </div>
            </section>
          )}

          {results.albums?.length > 0 && (
            <section>
              <h3 className="text-lg font-semibold mb-3 text-gray-300">Albums</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {results.albums.map((a: any) => (
                  <Link
                    key={a.id}
                    to={`/albums/${a.id}`}
                    className="bg-surface-light rounded p-3 hover:bg-surface transition"
                  >
                    <p className="text-sm font-medium truncate">{a.title}</p>
                    <p className="text-xs text-gray-400">{a.artistName}</p>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {results.tracks?.length > 0 && (
            <section>
              <h3 className="text-lg font-semibold mb-3 text-gray-300">Tracks</h3>
              <div className="space-y-1">
                {results.tracks.map((t: any) => (
                  <div
                    key={t.id}
                    onClick={() => playTrack(t)}
                    className="flex items-center gap-4 px-3 py-2 rounded hover:bg-surface-light cursor-pointer transition"
                  >
                    <span className="text-sm font-medium">{t.title}</span>
                    <span className="text-xs text-gray-500">{t.artistName} — {t.albumTitle}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
