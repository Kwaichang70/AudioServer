import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';
import type {
  ListenBrainzDiscover,
  MixItem,
  MixMeta,
  RecommendationSettings,
} from '../api/types.js';
import type { TrackInfo } from '../types/playback.js';

/**
 * Discover (V12.2).
 *
 * Two things this page insists on. A recommendation is only started when the
 * server is CERTAIN which local recording it is: a probable match opens the
 * album instead of playing something that merely shares a name. And every
 * item says where it came from — the basis is visible, and the personal part
 * of it can be switched off right here, after which nothing from the
 * listener's history is read at all.
 */

type Discover = ListenBrainzDiscover;

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
  why,
  onPlay,
  matchNote,
}: {
  primary: string;
  secondary?: string;
  albumId: string | null;
  searchQ: string;
  why?: string;
  /** Only set when the server is certain which local recording this is. */
  onPlay?: () => void;
  matchNote?: string;
}) {
  const to = albumId ? `/albums/${albumId}` : searchQ;
  const owned = !!albumId;
  return (
    <li className="flex items-center gap-2">
      <Link
        to={to}
        className="flex items-center gap-3 py-1.5 px-2 rounded hover:bg-surface-light transition flex-1 min-w-0"
        title={owned ? 'In your library' : 'Search across your sources'}
      >
        <div className="min-w-0 flex-1">
          <p className="text-sm truncate text-white">{primary}</p>
          {secondary && <p className="text-xs text-gray-500 truncate">{secondary}</p>}
          {why && <p className="text-[11px] text-gray-600 truncate">{why}</p>}
          {matchNote && <p className="text-[11px] text-amber-500/70 truncate">{matchNote}</p>}
        </div>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${
            owned ? 'bg-accent/20 text-accent' : 'bg-white/5 text-gray-500'
          }`}
        >
          {owned ? 'library' : 'search'}
        </span>
      </Link>
      {onPlay && (
        <button
          type="button"
          onClick={onPlay}
          className="shrink-0 min-h-[36px] px-2 text-xs text-accent hover:text-accent-hover"
          aria-label={`Play ${primary}`}
        >
          &#9654;
        </button>
      )}
    </li>
  );
}

export default function DiscoverPage() {
  const [data, setData] = useState<Discover | null>(null);
  const [mix, setMix] = useState<MixItem[]>([]);
  const [mixMeta, setMixMeta] = useState<MixMeta | null>(null);
  const [settings, setSettings] = useState<RecommendationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { playAlbum, playTrack } = useAudioContext();

  const loadMix = useCallback(() => {
    return api
      .getRecommendationMix(25)
      .then((res) => {
        setMix(res.data);
        setMixMeta(res.meta ?? null);
      })
      .catch(() => {
        setMix([]);
        setMixMeta(null);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      api.listenbrainzDiscover(),
      api.getRecommendationMix(25),
      api.getRecommendationSettings(),
    ])
      .then(([discover, mixRes, settingsRes]) => {
        if (cancelled) return;
        if (discover.status === 'fulfilled') setData(discover.value.data);
        else
          setError(discover.reason instanceof Error ? discover.reason.message : 'Failed to load');
        if (mixRes.status === 'fulfilled') {
          setMix(mixRes.value.data);
          setMixMeta(mixRes.value.meta ?? null);
        }
        if (settingsRes.status === 'fulfilled') setSettings(settingsRes.value.data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleHistory = async () => {
    if (!settings) return;
    const next = !settings.useHistory;
    const res = await api.updateRecommendationSettings({
      useHistory: next,
      useFavorites: next ? settings.useFavorites : false,
    });
    setSettings(res.data);
    await loadMix();
  };

  const asTrack = (item: MixItem): TrackInfo => ({
    id: item.id,
    title: item.title,
    artistName: item.artistName,
    albumTitle: item.albumTitle,
    albumId: item.albumId ?? undefined,
    duration: item.duration ?? undefined,
    source: 'local',
  });

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <div className="mb-4">
        <h1 className="text-2xl font-bold">Discover</h1>
        <p className="text-xs text-gray-500">
          A mix from your own library, plus recommendations from ListenBrainz when it is connected.
          Every item says where it came from, and a recommendation is only played when the server is
          certain which recording in your library it is.
        </p>
      </div>

      {loading && <p className="text-gray-500 text-sm">Loading&hellip;</p>}
      {error && <p className="text-red-400 text-sm">{error}</p>}

      {!loading && (
        <div className="space-y-6">
          <div className="bg-surface rounded-lg border border-white/10 p-4" data-testid="local-mix">
            <div className="flex items-start justify-between gap-4 mb-2">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
                Mix from your library
              </h2>
              {mix.length > 0 && (
                <button
                  type="button"
                  onClick={() => playAlbum(mix.map(asTrack))}
                  className="text-xs px-3 py-1.5 bg-accent rounded-full hover:bg-accent-hover transition"
                >
                  Play mix
                </button>
              )}
            </div>
            {mixMeta && <p className="text-xs text-gray-500 mb-3">{mixMeta.basis}</p>}
            {settings && (
              <label className="flex items-center gap-2 text-xs text-gray-400 mb-3">
                <input
                  type="checkbox"
                  checked={settings.useHistory}
                  onChange={toggleHistory}
                  className="accent-accent"
                />
                Use my listening history and favourites for recommendations
              </label>
            )}
            {mix.length === 0 ? (
              <p className="text-gray-500 text-sm">
                No mix yet &mdash; there is nothing playable in the library to build one from.
              </p>
            ) : (
              <ol className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
                {mix.map((item) => (
                  <Item
                    key={item.id}
                    primary={item.title}
                    secondary={item.artistName}
                    albumId={item.albumId}
                    searchQ={searchHref(item.artistName, item.title)}
                    why={item.why}
                    onPlay={() => playTrack(asTrack(item))}
                  />
                ))}
              </ol>
            )}
          </div>

          {data && !data.configured && (
            <div className="bg-surface rounded-lg border border-white/10 p-4 text-sm text-gray-500">
              ListenBrainz isn&apos;t connected. The mix above needs no account; connect it in{' '}
              <Link to="/settings" className="text-accent hover:underline">
                Settings &rarr; Scrobbling
              </Link>{' '}
              to also get recommendations built from your scrobbles.
            </div>
          )}

          {data?.configured &&
            data.playlists.map((pl, i) => (
              <div key={`pl-${i}`} className="bg-surface rounded-lg border border-white/10 p-4">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-1">
                  {pl.title}
                </h2>
                <p className="text-xs text-gray-500 mb-3">{pl.why}</p>
                <ol className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
                  {pl.tracks.map((t, j) => (
                    <Item
                      key={`t-${j}`}
                      primary={t.title}
                      secondary={t.artist}
                      albumId={t.localAlbumId}
                      searchQ={searchHref(t.artist, t.title)}
                      matchNote={t.match && !t.match.playable ? t.match.note : undefined}
                      onPlay={
                        t.match?.playable
                          ? () =>
                              playTrack({
                                id: t.match!.trackId,
                                title: t.match!.title,
                                artistName: t.match!.artistName,
                                albumTitle: t.match!.albumTitle,
                                albumId: t.match!.albumId ?? undefined,
                                duration: t.match!.duration ?? undefined,
                                source: 'local',
                              })
                          : undefined
                      }
                    />
                  ))}
                </ol>
              </div>
            ))}

          {data?.configured && data.freshReleases.length > 0 && (
            <div className="bg-surface rounded-lg border border-white/10 p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-3">
                Fresh releases from your artists
              </h2>
              <ol className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
                {data.freshReleases.map((r, i) => (
                  <Item
                    key={`fr-${i}`}
                    primary={r.title}
                    secondary={`${r.artist}${r.releaseDate ? ` \u00b7 ${r.releaseDate}` : ''}`}
                    albumId={r.localAlbumId}
                    searchQ={searchHref(r.artist, r.title)}
                    why={r.why}
                  />
                ))}
              </ol>
            </div>
          )}

          {data?.configured && data.playlists.length === 0 && data.freshReleases.length === 0 && (
            <p className="text-gray-500 text-sm">
              No ListenBrainz recommendations yet &mdash; those are built from your listening over
              time. The mix above does not wait for that.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
