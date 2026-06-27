import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';

interface FreshRelease {
  title: string;
  artist: string;
  releaseDate: string | null;
  localAlbumId: string | null;
}
interface DiscoverTrack {
  title: string;
  artist: string;
  localTrackId: string | null;
  localAlbumId: string | null;
}
interface DiscoverPlaylist {
  title: string;
  tracks: DiscoverTrack[];
}
interface Discover {
  configured: boolean;
  freshReleases: FreshRelease[];
  playlists: DiscoverPlaylist[];
}

// A recommended item we don't own: link to a unified search (local + Spotify +
// Qobuz) pre-filled with "artist title" so the user can play it from a source
// they have.
function searchHref(artist: string, title: string) {
  return `/search?q=${encodeURIComponent(`${artist} ${title}`.trim())}`;
}

function Item({
  primary,
  secondary,
  albumId,
  searchQ,
}: {
  primary: string;
  secondary?: string;
  albumId: string | null;
  searchQ: string;
}) {
  const to = albumId ? `/albums/${albumId}` : searchQ;
  const owned = !!albumId;
  return (
    <li>
      <Link
        to={to}
        className="flex items-center gap-3 py-1.5 px-2 rounded hover:bg-surface-light transition"
        title={owned ? 'In your library' : 'Search across your sources'}
      >
        <div className="min-w-0 flex-1">
          <p className="text-sm truncate text-white">{primary}</p>
          {secondary && <p className="text-xs text-gray-500 truncate">{secondary}</p>}
        </div>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${
            owned ? 'bg-accent/20 text-accent' : 'bg-white/5 text-gray-500'
          }`}
        >
          {owned ? 'library' : 'search'}
        </span>
      </Link>
    </li>
  );
}

export default function DiscoverPage() {
  const [data, setData] = useState<Discover | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listenbrainzDiscover()
      .then((res) => {
        if (!cancelled) setData(res.data as Discover);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <div className="mb-4">
        <h1 className="text-2xl font-bold">Discover</h1>
        <p className="text-xs text-gray-500">
          Recommendations and new releases from ListenBrainz. Items you own link into your library;
          the rest open a search across your sources.
        </p>
      </div>

      {loading && <p className="text-gray-500 text-sm">Loading…</p>}
      {error && <p className="text-red-400 text-sm">{error}</p>}

      {!loading && data && !data.configured && (
        <div className="bg-surface rounded-lg border border-white/10 p-6 text-center">
          <p className="text-gray-300 mb-2">ListenBrainz isn't connected yet.</p>
          <p className="text-sm text-gray-500">
            Connect it in{' '}
            <Link to="/settings" className="text-accent hover:underline">
              Settings → Scrobbling
            </Link>{' '}
            to get personalised recommendations.
          </p>
        </div>
      )}

      {!loading && data?.configured && (
        <div className="space-y-6">
          {data.playlists.map((pl, i) => (
            <div key={`pl-${i}`} className="bg-surface rounded-lg border border-white/10 p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-3">
                {pl.title}
              </h2>
              <ol className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
                {pl.tracks.map((t, j) => (
                  <Item
                    key={`t-${j}`}
                    primary={t.title}
                    secondary={t.artist}
                    albumId={t.localAlbumId}
                    searchQ={searchHref(t.artist, t.title)}
                  />
                ))}
              </ol>
            </div>
          ))}

          {data.freshReleases.length > 0 && (
            <div className="bg-surface rounded-lg border border-white/10 p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-3">
                Fresh releases from your artists
              </h2>
              <ol className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
                {data.freshReleases.map((r, i) => (
                  <Item
                    key={`fr-${i}`}
                    primary={r.title}
                    secondary={`${r.artist}${r.releaseDate ? ` · ${r.releaseDate}` : ''}`}
                    albumId={r.localAlbumId}
                    searchQ={searchHref(r.artist, r.title)}
                  />
                ))}
              </ol>
            </div>
          )}

          {data.playlists.length === 0 && data.freshReleases.length === 0 && (
            <p className="text-gray-500 text-sm">
              No recommendations yet — ListenBrainz builds these from your listening history over
              time. Keep scrobbling and check back.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
