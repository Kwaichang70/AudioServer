import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';
import PlayActions, {
  CardActions,
  openRowMenuFromKey,
  openRowMenuFromPointer,
  shuffledCopy,
  toTrackInfo,
} from '../components/PlayActions.js';
import Button from '../components/ui/Button.js';
import { formatDuration } from '../utils/format.js';
import type { ArtistBio, Discography, DiscographyEntry, TopTrack } from '../api/types.js';

/**
 * The artist page (R04.2).
 *
 * Built on the relations of R03: a guest on one track of one album has a page
 * of their own, filled by "appears on". The biography carries its source and
 * licence because both Wikipedia and Last.fm require that; top tracks are
 * this listener's own, since listening history is personal (V09).
 */

interface Artist {
  id: string;
  name: string;
}

interface SimilarArtist {
  name: string;
  match: number;
  localArtistId: string | null;
}

type SortMode = 'year' | 'title';

const ROLE_LABEL: Record<string, string> = {
  main: 'artist',
  featured: 'featured',
  composer: 'composer',
  conductor: 'conductor',
  performer: 'performer',
  producer: 'producer',
};

function sortReleases(list: DiscographyEntry[], mode: SortMode): DiscographyEntry[] {
  return [...list].sort((a, b) =>
    mode === 'title'
      ? a.title.localeCompare(b.title)
      : (a.year ?? 9999) - (b.year ?? 9999) || a.title.localeCompare(b.title),
  );
}

function ReleaseGrid({
  title,
  releases,
  note,
}: {
  title: string;
  releases: DiscographyEntry[];
  note?: string;
}) {
  if (releases.length === 0) return null;
  return (
    <section className="mt-8">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-1">
        {title} <span className="text-gray-600">({releases.length})</span>
      </h3>
      {note && <p className="text-xs text-gray-600 mb-3">{note}</p>}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 mt-2">
        {releases.map((album) => (
          <div key={album.id} data-play-actions-row className="group relative">
            <Link
              to={`/albums/${album.id}`}
              onKeyDown={openRowMenuFromKey}
              onContextMenu={openRowMenuFromPointer}
              className="group block bg-surface-light rounded-lg p-3 hover:bg-surface transition"
            >
              <div className="aspect-square bg-surface-dark rounded mb-2 overflow-hidden">
                <img
                  src={api.getAlbumCoverUrl(album.id)}
                  alt={album.title}
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              </div>
              <p className="text-sm font-medium truncate group-hover:text-accent transition">
                {album.title}
              </p>
              <p className="text-xs text-gray-500 truncate">
                {album.year ?? '—'}
                {album.roles && album.roles.length > 0
                  ? ` · ${album.artistName} · ${album.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')}`
                  : ` · ${album.trackCount} tracks`}
              </p>
            </Link>
            <CardActions target={{ kind: 'album', albumId: album.id, title: album.title }} />
          </div>
        ))}
      </div>
    </section>
  );
}

function Biography({ bio }: { bio: ArtistBio }) {
  const [open, setOpen] = useState(false);
  const long = bio.summary.length > 360;
  return (
    <section className="mt-6 max-w-3xl" data-testid="artist-bio">
      <p
        className={`text-sm text-gray-300 leading-relaxed whitespace-pre-line ${
          long && !open ? 'line-clamp-4' : ''
        }`}
      >
        {bio.summary}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs text-gray-500">
        {long && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="text-accent hover:underline"
            aria-expanded={open}
          >
            {open ? 'Show less' : 'Read more'}
          </button>
        )}
        <span>
          Source:{' '}
          {bio.url ? (
            <a href={bio.url} target="_blank" rel="noreferrer" className="hover:underline">
              {bio.source === 'wikipedia'
                ? `Wikipedia${bio.language ? ` (${bio.language})` : ''}`
                : 'Last.fm'}
            </a>
          ) : bio.source === 'wikipedia' ? (
            'Wikipedia'
          ) : (
            'Last.fm'
          )}
        </span>
        <span>{bio.license}</span>
      </div>
    </section>
  );
}

export default function ArtistPage() {
  const { id } = useParams<{ id: string }>();
  const [artist, setArtist] = useState<Artist | null>(null);
  const [discography, setDiscography] = useState<Discography | null>(null);
  const [bio, setBio] = useState<ArtistBio | null>(null);
  const [topTracks, setTopTracks] = useState<TopTrack[]>([]);
  const [similar, setSimilar] = useState<SimilarArtist[]>([]);
  const [favorited, setFavorited] = useState(false);
  const [hasImage, setHasImage] = useState(true);
  const [sort, setSort] = useState<SortMode>('year');
  const activeArtistIdRef = useRef(id);
  activeArtistIdRef.current = id;
  const { playAlbum } = useAudioContext();
  const [starting, setStarting] = useState(false);

  /** Start every available track of this artist, in album order or shuffled. */
  const playArtist = async (shuffle: boolean) => {
    if (!id) return;
    setStarting(true);
    try {
      const res = await api.getArtistTracks(id);
      const list = (res.data ?? [])
        .filter((t) => t.availability !== 'missing')
        .map((t) => toTrackInfo(t));
      if (list.length > 0) playAlbum(shuffle ? shuffledCopy(list) : list, 0);
    } catch {
      // The buttons stay usable; the toast layer reports API errors globally.
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setArtist(null);
    setDiscography(null);
    setBio(null);
    setTopTracks([]);
    setSimilar([]);
    setFavorited(false);
    setHasImage(true);
    const keep =
      <T,>(apply: (value: T) => void) =>
      (value: T) => {
        if (!cancelled) apply(value);
      };
    api
      .getArtist(id)
      .then(keep((res) => setArtist(res.data)))
      .catch(() => {});
    api
      .getArtistDiscography(id)
      .then(keep((res) => setDiscography(res.data)))
      .catch(() => {});
    // The biography may take a couple of seconds the first time (three
    // external services); the page does not wait for it.
    api
      .getArtistBio(id)
      .then(keep((res) => setBio(res.data)))
      .catch(() => {});
    api
      .getArtistTopTracks(id)
      .then(keep((res) => setTopTracks(res.data ?? [])))
      .catch(() => {});
    api
      .getSimilarArtists(id)
      .then(keep((res) => setSimilar(res.data?.similar ?? [])))
      .catch(() => {});
    api
      .checkFavorite('artist', id)
      .then(keep((res) => setFavorited(res.data.favorited)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id]);

  const sorted = useMemo(
    () =>
      discography && {
        albums: sortReleases(discography.albums, sort),
        singles: sortReleases(discography.singles, sort),
        compilations: sortReleases(discography.compilations, sort),
        appearsOn: sortReleases(discography.appearsOn, sort),
      },
    [discography, sort],
  );

  const toggleFavorite = async () => {
    if (!id) return;
    const artistId = id;
    try {
      const res = await api.toggleFavorite('artist', id);
      if (activeArtistIdRef.current === artistId) setFavorited(res.data.favorited);
    } catch {
      // ignore — UI state stays as-is
    }
  };

  if (!artist) return <p className="text-gray-400">Loading...</p>;

  const ownCount =
    (discography?.albums.length ?? 0) +
    (discography?.singles.length ?? 0) +
    (discography?.compilations.length ?? 0);

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-6 items-start mb-2">
        {hasImage && (
          <img
            src={api.getArtistImageUrl(artist.id)}
            alt=""
            className="w-32 h-32 sm:w-40 sm:h-40 rounded-full object-cover bg-surface-dark shrink-0"
            onError={() => setHasImage(false)}
          />
        )}
        <div className="min-w-0">
          <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Artist</p>
          <div className="flex items-center gap-3">
            <h2 className="text-3xl font-bold">{artist.name}</h2>
            <button
              onClick={toggleFavorite}
              className={`text-2xl leading-none transition ${
                favorited ? 'text-accent' : 'text-gray-500 hover:text-accent'
              }`}
              title={favorited ? 'Remove from favorites' : 'Add to favorites'}
              aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
              aria-pressed={favorited}
            >
              {favorited ? '♥' : '♡'}
            </button>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            {ownCount} release{ownCount === 1 ? '' : 's'}
            {discography && discography.appearsOn.length > 0
              ? ` · appears on ${discography.appearsOn.length} more`
              : ''}
          </p>
          <div className="flex flex-wrap items-center gap-3 mt-4">
            <Button
              variant="accent"
              onClick={() => void playArtist(false)}
              disabled={starting || ownCount === 0}
            >
              Play
            </Button>
            <Button onClick={() => void playArtist(true)} disabled={starting || ownCount === 0}>
              Shuffle
            </Button>
            {/* Radio arrives in R08; the button says so instead of doing nothing. */}
            <Button disabled title="Artist radio comes with a later update">
              Start radio
            </Button>
            <PlayActions target={{ kind: 'artist', artistId: artist.id, name: artist.name }} />
          </div>
        </div>
      </div>

      {bio && <Biography bio={bio} />}

      {topTracks.length > 0 && (
        <section className="mt-8 max-w-3xl" data-testid="top-tracks">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-2">
            Your most played
          </h3>
          <ol>
            {topTracks.map((track, index) => (
              <li key={track.id}>
                <button
                  type="button"
                  onClick={() =>
                    playAlbum(
                      topTracks.map((t) =>
                        toTrackInfo({
                          id: t.id,
                          title: t.title,
                          artistName: t.artistName,
                          albumTitle: t.albumTitle,
                          albumId: t.albumId,
                          duration: t.duration ?? undefined,
                          format: t.format ?? undefined,
                          source: 'local',
                        }),
                      ),
                      index,
                    )
                  }
                  className="w-full flex items-center gap-3 py-1.5 px-2 rounded hover:bg-surface-light transition text-left"
                >
                  <span className="w-5 text-xs text-gray-500 text-right">{index + 1}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm truncate">{track.title}</span>
                    <span className="block text-xs text-gray-500 truncate">{track.albumTitle}</span>
                  </span>
                  <span className="text-xs text-gray-500 shrink-0">
                    {track.plays}× · {formatDuration(track.duration ?? undefined)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      {sorted && (
        <>
          <div className="flex items-center gap-2 mt-8 text-xs text-gray-500">
            <span>Sort</span>
            {(['year', 'title'] as SortMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setSort(mode)}
                aria-pressed={sort === mode}
                className={`px-2 py-1 rounded ${
                  sort === mode ? 'bg-surface-light text-white' : 'hover:text-white'
                }`}
              >
                {mode === 'year' ? 'By year' : 'By title'}
              </button>
            ))}
          </div>
          <ReleaseGrid title="Albums" releases={sorted.albums} />
          <ReleaseGrid
            title="Singles & EPs"
            releases={sorted.singles}
            note="Up to six tracks and under thirty minutes."
          />
          <ReleaseGrid title="Compilations" releases={sorted.compilations} />
          <ReleaseGrid title="Appears on" releases={sorted.appearsOn} />
        </>
      )}

      {similar.length > 0 && (
        <div className="mt-10">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-3">
            Listeners also like
          </h3>
          <div className="flex flex-wrap gap-2">
            {similar.map((s) => (
              <Link
                key={s.name}
                to={
                  s.localArtistId
                    ? `/artists/${s.localArtistId}`
                    : `/search?q=${encodeURIComponent(s.name)}`
                }
                className={`px-3 py-1.5 rounded-full text-sm border transition ${
                  s.localArtistId
                    ? 'border-accent/40 text-accent hover:bg-accent/10'
                    : 'border-white/10 text-gray-300 hover:bg-surface-light'
                }`}
                title={s.localArtistId ? 'In your library' : 'Search across your sources'}
              >
                {s.name}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
