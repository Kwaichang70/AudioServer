import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import type { HomeData, ListenBrainzDiscover, MixItem } from '../api/types.js';
import { useAudioContext } from '../context/AudioContext.js';
import type { TrackInfo } from '../types/playback.js';
import AlbumCover from '../components/AlbumCover.js';
import GettingStarted from '../components/GettingStarted.js';
import { CardActions, shuffledCopy } from '../components/PlayActions.js';
import Button from '../components/ui/Button.js';
import { formatTime } from '../utils/format.js';
import { isUnplayable } from '../utils/availability.js';

interface Stats {
  artists: number;
  albums: number;
  tracks: number;
}

interface TopArtist {
  id: string;
  name: string;
  play_count: number;
}

interface LibraryStats {
  totalDuration: number;
  formats: { format: string; count: number }[];
  genres: { genre: string; count: number }[];
}

function formatTotalDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

const mixToTrack = (item: MixItem): TrackInfo => ({
  id: item.id,
  title: item.title,
  artistName: item.artistName,
  albumTitle: item.albumTitle,
  albumId: item.albumId ?? undefined,
  duration: item.duration ?? undefined,
  source: item.source,
});

function Section({
  title,
  action,
  children,
  testId,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section data-testid={testId}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-xl font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * Home as Roon's overview (R08.2): continue where you left off, today's mix,
 * what ListenBrainz suggests that you can play now, what is new, the genres
 * you play — each with a cover and something to play.
 */
export default function HomePage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [home, setHome] = useState<HomeData | null>(null);
  const [forYou, setForYou] = useState<ListenBrainzDiscover | null>(null);
  const [topArtists, setTopArtists] = useState<TopArtist[]>([]);
  const [libraryStats, setLibraryStats] = useState<LibraryStats | null>(null);
  const [showWhy, setShowWhy] = useState(false);
  const { playAlbum, startRadio, seek, currentTrack, isPlaying } = useAudioContext();
  // "Continue" resumes mid-track: seek once that track is actually playing.
  const pendingSeek = useRef<{ trackId: string; position: number } | null>(null);

  useEffect(() => {
    api
      .getStats()
      .then((res) => setStats(res.data))
      .catch(() => {});
    api
      .getHome()
      .then((res) => setHome(res.data))
      .catch(() => {});
    api
      .listenbrainzDiscover()
      .then((res) => setForYou(res.data))
      .catch(() => {});
    api
      .getTopArtists()
      .then((res) => setTopArtists(res.data))
      .catch(() => {});
    api
      .getHealth()
      .then((res) => {
        if (res.libraryStats) setLibraryStats(res.libraryStats);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const pending = pendingSeek.current;
    if (pending && isPlaying && currentTrack?.id === pending.trackId) {
      pendingSeek.current = null;
      seek(pending.position);
    }
  }, [currentTrack, isPlaying, seek]);

  const resume = async (item: HomeData['continueListening'][number]) => {
    const res = await api.getAlbumTracks(item.albumId);
    const list = (res.data ?? [])
      .filter((t) => !isUnplayable(t))
      .map((t) => t as unknown as TrackInfo);
    const index = Math.max(
      0,
      list.findIndex((t) => t.id === item.resumeTrackId),
    );
    if (list.length === 0) return;
    if (item.resumePosition > 0 && item.resumeTrackId) {
      pendingSeek.current = { trackId: item.resumeTrackId, position: item.resumePosition };
    }
    playAlbum(list, index);
  };

  // ListenBrainz suggestions you can play now: the ones that matched a local track.
  const playableForYou = (forYou?.playlists ?? [])
    .flatMap((p) => p.tracks)
    .filter((t) => t.localTrackId)
    .slice(0, 12);

  const mix = home?.dailyMix.items ?? [];

  return (
    <div className="space-y-10">
      <section>
        <h2 className="text-3xl font-bold mb-2">Welcome</h2>
        {stats && (
          <div className="flex gap-6 text-sm text-gray-400">
            <Link to="/artists" className="hover:text-accent transition">
              <span className="text-2xl font-bold text-white">{stats.artists}</span> artists
            </Link>
            <Link to="/albums" className="hover:text-accent transition">
              <span className="text-2xl font-bold text-white">{stats.albums}</span> albums
            </Link>
            <span>
              <span className="text-2xl font-bold text-white">{stats.tracks}</span> tracks
            </span>
          </div>
        )}
      </section>

      {/* Guided first experience (V08.2) */}
      <GettingStarted />

      {home && home.continueListening.length > 0 && (
        <Section title="Continue listening" testId="home-continue">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {home.continueListening.map((item) => (
              <button
                key={item.albumId}
                type="button"
                onClick={() => void resume(item)}
                className="group rounded-lg bg-surface-light p-3 text-left transition hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                aria-label={`Continue ${item.title} with ${item.resumeTitle ?? 'the next track'}`}
              >
                <div className="mb-2">
                  <AlbumCover
                    albumId={item.albumId}
                    title={item.title}
                    artistName={item.artistName}
                    coverUrl={item.coverUrl ?? undefined}
                  />
                </div>
                <p className="truncate text-sm font-medium group-hover:text-accent">{item.title}</p>
                <p className="truncate text-xs text-gray-400">{item.artistName}</p>
                <p className="truncate text-[11px] text-gray-500">
                  ▶ {item.resumeTitle}
                  {item.resumePosition > 0 ? ` · ${formatTime(item.resumePosition)}` : ''}
                </p>
                <div className="mt-1 h-1 rounded bg-white/10" aria-hidden="true">
                  <div
                    className="h-1 rounded bg-accent"
                    style={{ width: `${Math.round(item.progress * 100)}%` }}
                  />
                </div>
              </button>
            ))}
          </div>
        </Section>
      )}

      {mix.length > 0 && (
        <Section
          title="Today’s mix"
          testId="home-daily-mix"
          action={
            <div className="flex items-center gap-2">
              <Button size="sm" variant="accent" onClick={() => playAlbum(mix.map(mixToTrack), 0)}>
                ▶ Play
              </Button>
              <Button size="sm" onClick={() => playAlbum(shuffledCopy(mix.map(mixToTrack)), 0)}>
                ⤮ Shuffle
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={showWhy}
                onClick={() => setShowWhy(!showWhy)}
              >
                Why these?
              </Button>
            </div>
          }
        >
          <p className="mb-3 text-xs text-gray-500">{home?.dailyMix.basis}</p>
          <ol className="grid gap-1 sm:grid-cols-2">
            {mix.slice(0, 10).map((item, i) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => playAlbum(mix.map(mixToTrack), i)}
                  className="w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-white/5"
                >
                  {item.title} <span className="text-gray-500">— {item.artistName}</span>
                  {showWhy && <span className="block text-[11px] text-gray-500">{item.why}</span>}
                </button>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {playableForYou.length > 0 && (
        <Section
          title="For you"
          testId="home-for-you"
          action={
            <Button
              size="sm"
              variant="accent"
              onClick={() =>
                playAlbum(
                  playableForYou.map((t) => ({
                    id: t.localTrackId!,
                    title: t.title,
                    artistName: t.artist,
                    albumTitle: '',
                    albumId: t.localAlbumId ?? undefined,
                  })),
                  0,
                )
              }
            >
              ▶ Play
            </Button>
          }
        >
          <p className="mb-3 text-xs text-gray-500">
            From ListenBrainz, only what is in your library.{' '}
            <Link to="/discover" className="text-accent hover:underline">
              More in Discover
            </Link>
          </p>
          <ul className="grid gap-1 sm:grid-cols-2">
            {playableForYou.map((t) => (
              <li key={t.localTrackId} className="truncate px-2 py-1 text-sm">
                {t.title} <span className="text-gray-500">— {t.artist}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {home && home.newInLibrary.length > 0 && (
        <Section
          title="New in your library"
          testId="home-new"
          action={
            <Link to="/albums?sort=added" className="text-sm text-gray-400 hover:text-accent">
              View all
            </Link>
          }
        >
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {home.newInLibrary.map((album) => (
              <div key={album.id} data-play-actions-row className="group relative">
                <Link
                  to={`/albums/${album.id}`}
                  className="block rounded-lg bg-surface-light p-3 transition hover:bg-surface"
                >
                  <div className="mb-2">
                    <AlbumCover
                      albumId={album.id}
                      title={album.title}
                      artistName={album.artistName}
                      coverUrl={album.coverUrl ?? undefined}
                    />
                  </div>
                  <p className="truncate text-sm font-medium">{album.title}</p>
                  <p className="truncate text-xs text-gray-400">
                    {album.source === 'qobuz' && (
                      <span className="mr-1 rounded bg-sky-500/20 px-1 text-[10px] uppercase text-sky-300">
                        Qobuz
                      </span>
                    )}
                    {album.artistName}
                  </p>
                </Link>
                <CardActions target={{ kind: 'album', albumId: album.id, title: album.title }} />
              </div>
            ))}
          </div>
        </Section>
      )}

      {home && home.genresForYou.length > 0 && (
        <Section title="Genres for you" testId="home-genres">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {home.genresForYou.map((g) => (
              <div key={g.genre} className="rounded-lg bg-surface-light p-3">
                <Link
                  to={`/albums?${new URLSearchParams({ genre: g.genre }).toString()}`}
                  className="block"
                >
                  <div className="mb-2 grid grid-cols-2 gap-0.5 overflow-hidden rounded">
                    {g.albumIds.slice(0, 4).map((id) => (
                      <img
                        key={id}
                        src={api.getAlbumCoverUrl(id)}
                        alt=""
                        className="aspect-square w-full object-cover"
                      />
                    ))}
                  </div>
                  <p className="truncate text-sm font-medium">{g.genre}</p>
                </Link>
                <button
                  type="button"
                  onClick={() => void startRadio({ type: 'genre', id: g.genre }).catch(() => {})}
                  className="mt-1 text-xs text-gray-400 hover:text-accent"
                  aria-label={`Start ${g.genre} radio`}
                >
                  ▶ Radio
                </button>
              </div>
            ))}
          </div>
        </Section>
      )}

      {topArtists.length > 0 && (
        <Section title="Top Artists">
          <div className="flex flex-wrap gap-2">
            {topArtists.map((artist) => (
              <Link
                key={artist.id}
                to={`/artists/${artist.id}`}
                className="rounded-full bg-surface-light px-4 py-2 text-sm transition hover:bg-surface"
              >
                {artist.name} <span className="text-xs text-gray-500">{artist.play_count}</span>
              </Link>
            ))}
          </div>
        </Section>
      )}

      {/* Library Stats */}
      {libraryStats && stats && stats.tracks > 0 && (
        <section>
          <h3 className="text-xl font-semibold mb-4">Library Stats</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="bg-surface-light rounded-lg p-4">
              <p className="text-2xl font-bold text-white">
                {formatTotalDuration(libraryStats.totalDuration)}
              </p>
              <p className="text-xs text-gray-500">Total playtime</p>
            </div>
            {libraryStats.formats.length > 0 && (
              <div className="bg-surface-light rounded-lg p-4">
                <p className="text-2xl font-bold text-white">
                  {libraryStats.formats[0].format || 'N/A'}
                </p>
                <p className="text-xs text-gray-500">
                  Top format ({libraryStats.formats[0].count} tracks)
                </p>
              </div>
            )}
            {libraryStats.genres.length > 0 && (
              <div className="bg-surface-light rounded-lg p-4 col-span-2">
                <div className="flex flex-wrap gap-1.5">
                  {libraryStats.genres.slice(0, 8).map((g) => (
                    <span
                      key={g.genre}
                      className="text-xs px-2 py-1 bg-surface-dark rounded-full text-gray-400"
                    >
                      {g.genre} <span className="text-gray-600">{g.count}</span>
                    </span>
                  ))}
                </div>
                <p className="text-xs text-gray-500 mt-2">Top genres</p>
              </div>
            )}
          </div>
        </section>
      )}

      {home && home.continueListening.length === 0 && mix.length === 0 && (
        <section className="text-center py-12">
          <p className="text-gray-500 mb-4">Start playing music to see your history here.</p>
          <div className="flex gap-4 justify-center">
            <Link
              to="/albums"
              className="px-6 py-2 bg-accent rounded-full hover:bg-accent-hover transition"
            >
              Browse Albums
            </Link>
            <Link
              to="/search"
              className="px-6 py-2 bg-surface-light border border-white/10 rounded-full hover:border-accent transition"
            >
              Search
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
