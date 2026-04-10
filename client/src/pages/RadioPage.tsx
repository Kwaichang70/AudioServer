import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';
import { useToast } from '../components/Toast.js';

interface Station {
  id: string;
  uuid: string;
  name: string;
  streamUrl: string;
  genre?: string;
  country?: string;
  language?: string;
  homepage?: string;
  faviconUrl?: string;
  bitrate?: number;
  codec?: string;
  curated?: boolean;
}

const GENRE_TAGS = ['pop', 'rock', 'news', 'dance', 'classical', 'jazz', 'hip-hop', 'electronic'];

export default function RadioPage() {
  const { playTrack } = useAudioContext();
  const { toast } = useToast();
  const [tab, setTab] = useState<'featured' | 'search' | 'genre'>('featured');
  const [featured, setFeatured] = useState<Station[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Station[]>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [tagResults, setTagResults] = useState<Station[]>([]);
  const [loading, setLoading] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.getRadioFeatured().then((res) => setFeatured(res.data || [])).catch(() => {});
    api.getFavorites('station').then((res) => {
      const s = new Set<string>((res.data || []).map((x: Station) => x.uuid));
      setFavorites(s);
    }).catch(() => {});
  }, []);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setLoading(true);
    try {
      const res = await api.searchRadio(searchQuery.trim());
      setSearchResults(res.data || []);
    } catch (err) {
      toast(`Search failed: ${err}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [searchQuery, toast]);

  const handleTag = useCallback(async (tag: string) => {
    setActiveTag(tag);
    setLoading(true);
    try {
      const res = await api.searchRadio('', 'NL', tag);
      setTagResults(res.data || []);
    } catch (err) {
      toast(`Browse failed: ${err}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const playStation = (station: Station) => {
    playTrack({
      id: station.id,
      title: station.name,
      artistName: 'Live Radio',
      albumTitle: station.genre || 'Online Radio',
      duration: 0,
    });
  };

  const toggleFavorite = async (station: Station, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      // Cache metadata first so the Favorites page can render without
      // hitting radio-browser again.
      await api.cacheRadioStation({
        uuid: station.uuid,
        name: station.name,
        streamUrl: station.streamUrl,
        genre: station.genre,
        country: station.country,
        language: station.language,
        homepage: station.homepage,
        faviconUrl: station.faviconUrl,
        bitrate: station.bitrate,
        codec: station.codec,
      });
      const res = await api.toggleFavorite('station', station.uuid);
      setFavorites((prev) => {
        const next = new Set(prev);
        if (res.data?.favorited) next.add(station.uuid);
        else next.delete(station.uuid);
        return next;
      });
    } catch (err) {
      toast(`Favorite failed: ${err}`, 'error');
    }
  };

  const renderGrid = (stations: Station[]) => {
    if (stations.length === 0) {
      return <p className="text-gray-500 text-center py-12">No stations found.</p>;
    }
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {stations.map((station) => {
          const isFav = favorites.has(station.uuid);
          return (
            <div
              key={station.uuid}
              onClick={() => playStation(station)}
              className="group bg-surface hover:bg-surface-light rounded-lg p-3 cursor-pointer transition flex items-center gap-3"
            >
              <div className="w-12 h-12 shrink-0 rounded bg-surface-dark overflow-hidden flex items-center justify-center text-lg">
                {station.faviconUrl ? (
                  <img
                    src={station.faviconUrl}
                    alt=""
                    className="w-full h-full object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                ) : (
                  <span className="text-gray-500">&#128251;</span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{station.name}</p>
                <p className="text-xs text-gray-400 truncate">
                  {station.genre || 'Radio'}
                  {station.bitrate ? ` • ${station.bitrate}kbps` : ''}
                </p>
              </div>
              <button
                onClick={(e) => toggleFavorite(station, e)}
                className={`shrink-0 text-lg transition ${
                  isFav ? 'text-accent' : 'text-gray-600 hover:text-accent opacity-0 group-hover:opacity-100'
                }`}
                title={isFav ? 'Remove from favorites' : 'Add to favorites'}
              >
                {isFav ? '\u2605' : '\u2606'}
              </button>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Radio</h2>

      {/* Tab bar */}
      <div className="flex gap-2 mb-6 border-b border-white/10">
        <TabButton active={tab === 'featured'} onClick={() => setTab('featured')}>
          Uitgelicht NL
        </TabButton>
        <TabButton active={tab === 'search'} onClick={() => setTab('search')}>
          Zoeken
        </TabButton>
        <TabButton active={tab === 'genre'} onClick={() => setTab('genre')}>
          Genres
        </TabButton>
      </div>

      {tab === 'featured' && renderGrid(featured)}

      {tab === 'search' && (
        <>
          <form
            className="mb-6 flex gap-2"
            onSubmit={(e) => { e.preventDefault(); handleSearch(); }}
          >
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Zoek NL stations…"
              className="flex-1 bg-surface border border-white/10 rounded px-3 py-2 text-sm focus:outline-none focus:border-accent"
            />
            <button
              type="submit"
              className="px-4 py-2 bg-accent text-white rounded text-sm hover:bg-accent/90 transition"
            >
              Zoek
            </button>
          </form>
          {loading ? <p className="text-gray-400">Laden…</p> : renderGrid(searchResults)}
        </>
      )}

      {tab === 'genre' && (
        <>
          <div className="flex flex-wrap gap-2 mb-6">
            {GENRE_TAGS.map((tag) => (
              <button
                key={tag}
                onClick={() => handleTag(tag)}
                className={`px-3 py-1.5 rounded-full text-sm transition ${
                  activeTag === tag
                    ? 'bg-accent text-white'
                    : 'bg-surface text-gray-400 hover:text-white'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
          {loading ? (
            <p className="text-gray-400">Laden…</p>
          ) : activeTag ? (
            renderGrid(tagResults)
          ) : (
            <p className="text-gray-500">Kies een genre om te browsen.</p>
          )}
        </>
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
        active ? 'border-accent text-white' : 'border-transparent text-gray-400 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}
