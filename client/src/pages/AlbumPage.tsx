import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';
import PlayActions, { toTrackInfo } from '../components/PlayActions.js';
import Button from '../components/ui/Button.js';
import AlbumCover from '../components/AlbumCover.js';
import { formatDuration, formatQuality } from '../utils/format.js';
import type { AlbumCredit, AlbumVersions } from '../api/types.js';

interface Track {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  albumId: string;
  trackNumber?: number;
  discNumber?: number;
  duration?: number;
  format?: string;
  sampleRate?: number;
  bitDepth?: number;
  /** V06: 'missing' when the file is no longer where the library saw it. */
  availability?: 'available' | 'missing';
  /** The composition this track is part of, for classical music (R03.1). */
  work?: string | null;
  movement?: string | null;
}

interface Album {
  id: string;
  title: string;
  artistName: string;
  year?: number;
  genre?: string;
  trackCount?: number;
  coverUrl?: string;
  source?: string;
  format?: string;
  sampleRate?: number;
  bitDepth?: number;
  // Release data (R03.1), shown in the header when the tags or the
  // identification job provided it.
  releaseDate?: string | null;
  originalYear?: number | null;
  label?: string | null;
  catalogNumber?: string | null;
}

const ROLE_TITLE: Record<string, string> = {
  composer: 'Composer',
  conductor: 'Conductor',
  performer: 'Performers',
  featured: 'Featuring',
  producer: 'Producer',
  main: 'Artists',
};

export default function AlbumPage() {
  const { id } = useParams<{ id: string }>();
  const [album, setAlbum] = useState<Album | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [favorited, setFavorited] = useState(false);
  const [credits, setCredits] = useState<AlbumCredit[]>([]);
  const [versions, setVersions] = useState<AlbumVersions | null>(null);
  const { playAlbum, playNextTracks, queueTracks, currentTrack, isPlaying } = useAudioContext();
  const activeAlbumIdRef = useRef(id);
  activeAlbumIdRef.current = id;

  const providerType = id?.startsWith('spotify:')
    ? 'spotify'
    : id?.startsWith('qobuz:')
      ? 'qobuz'
      : id?.startsWith('tidal:')
        ? 'tidal'
        : 'local';

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    // Reset before fetching: navigating album → album must not keep showing
    // the previous album's data (or its favorite state) under the new URL
    // while the new fetch is in flight — or forever, if the new id 404s.
    setAlbum(null);
    setTracks([]);
    setFavorited(false);
    setCredits([]);
    setVersions(null);

    if (providerType === 'spotify') {
      const spotifyId = id.replace('spotify:', '');
      api
        .getSpotifyAlbum(spotifyId)
        .then((res) => {
          if (!cancelled) setAlbum(res.data);
        })
        .catch(() => {});
      api
        .getSpotifyAlbumTracks(spotifyId)
        .then((res) => {
          if (!cancelled) setTracks(res.data);
        })
        .catch(() => {});
    } else if (providerType === 'qobuz') {
      const qobuzId = id.replace('qobuz:', '');
      api
        .getQobuzAlbum(qobuzId)
        .then((res) => {
          if (!cancelled) setAlbum(res.data);
        })
        .catch(() => {});
      api
        .getQobuzAlbumTracks(qobuzId)
        .then((res) => {
          if (!cancelled) setTracks(res.data);
        })
        .catch(() => {});
    } else if (providerType === 'tidal') {
      const tidalId = id.replace('tidal:', '');
      api
        .getTidalAlbum(tidalId)
        .then((res) => {
          if (!cancelled) setAlbum(res.data);
        })
        .catch(() => {});
      api
        .getTidalAlbumTracks(tidalId)
        .then((res) => {
          if (!cancelled) setTracks(res.data);
        })
        .catch(() => {});
    } else {
      // .catch: an album pruned by a re-scan 404s here — swallow it (the page
      // keeps its Loading state) instead of surfacing an unhandled rejection.
      api
        .getAlbum(id)
        .then((res) => {
          if (!cancelled) setAlbum(res.data);
        })
        .catch(() => {});
      api
        .getAlbumTracks(id)
        .then((res) => {
          if (!cancelled) setTracks(res.data);
        })
        .catch(() => {});
      api
        .checkFavorite('album', id)
        .then((res) => {
          if (!cancelled) setFavorited(res.data.favorited);
        })
        .catch(() => {});
      // Credits and versions (R04.3). Versions asks Qobuz too, so it may take
      // a few seconds; the album shows without waiting for it.
      api
        .getAlbumCredits(id)
        .then((res) => {
          if (!cancelled) setCredits(res.data ?? []);
        })
        .catch(() => {});
      api
        .getAlbumVersions(id)
        .then((res) => {
          if (!cancelled) setVersions(res.data);
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
    };
  }, [id, providerType]);

  const toggleFavorite = async () => {
    if (!id) return;
    const albumId = id;
    const res = await api.toggleFavorite('album', id);
    if (activeAlbumIdRef.current === albumId) setFavorited(res.data.favorited);
  };

  /** Start another version of this album: a local edition or a Qobuz release. */
  const playVersion = async (versionId: string) => {
    try {
      const res = versionId.startsWith('qobuz:')
        ? await api.getQobuzAlbumTracks(versionId.replace('qobuz:', ''))
        : await api.getAlbumTracks(versionId);
      const list = (res.data ?? []) as Track[];
      if (list.length > 0) playAlbum(list.map((t) => toTrackInfo(t)));
    } catch {
      // The toast layer reports API errors; the button stays usable.
    }
  };

  if (!album) return <p className="text-gray-400">Loading...</p>;

  const releaseLine = [
    album.releaseDate ?? (album.originalYear ? String(album.originalYear) : null),
    album.label,
    album.catalogNumber,
  ].filter(Boolean);
  const hasWorks = tracks.some((t) => t.work);

  const totalDuration = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  const totalMin = Math.floor(totalDuration / 60);
  // Only a real multi-disc release gets disc headings; a single-disc album
  // would just gain a "Disc 1" line that says nothing.
  const hasMultipleDiscs = new Set(tracks.map((t) => t.discNumber ?? 1)).size > 1;
  // What goes into the queue: the player's fields only, and for "play next" /
  // "add to queue" only files that are actually there (R01.2).
  const trackInfos = tracks.map((t) => toTrackInfo(t));
  const playable = tracks.filter((t) => t.availability !== 'missing').map((t) => toTrackInfo(t));

  return (
    <div>
      {/* Album header */}
      <div className="flex gap-6 mb-8">
        <div className="w-56 h-56 shrink-0 shadow-lg">
          <AlbumCover
            albumId={album.id}
            title={album.title}
            artistName={album.artistName}
            coverUrl={album.coverUrl}
            size="lg"
          />
        </div>
        <div className="flex flex-col justify-end">
          <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Album</p>
          <h2 className="text-3xl font-bold mb-2">{album.title}</h2>
          <p className="text-gray-400">
            {album.artistName}
            {album.year && <span> &middot; {album.year}</span>}
            {album.genre && <span> &middot; {album.genre}</span>}
            {formatQuality(album) && (
              <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-white/5 text-gray-400">
                {formatQuality(album)}
              </span>
            )}
          </p>
          <p className="text-sm text-gray-500 mt-1">
            {tracks.length} tracks &middot; {totalMin} min
          </p>
          {releaseLine.length > 0 && (
            <p className="text-xs text-gray-500 mt-1" data-testid="release-line">
              {releaseLine.join(' · ')}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3 mt-4">
            <button
              onClick={() => playAlbum(tracks)}
              className="px-6 py-2 bg-accent rounded-full hover:bg-accent-hover transition text-sm font-medium"
            >
              Play Album
            </button>
            <Button onClick={() => void playNextTracks(playable)} disabled={playable.length === 0}>
              Play next
            </Button>
            <Button onClick={() => void queueTracks(playable)} disabled={playable.length === 0}>
              Add to queue
            </Button>
            <button
              type="button"
              onClick={toggleFavorite}
              className={`w-9 h-9 rounded-full border flex items-center justify-center transition text-lg ${
                favorited
                  ? 'border-accent text-accent'
                  : 'border-white/20 text-gray-500 hover:border-accent hover:text-accent'
              }`}
              title={favorited ? 'Remove from favorites' : 'Add to favorites'}
              aria-label={
                favorited
                  ? `Remove ${album.title} from favorites`
                  : `Add ${album.title} to favorites`
              }
              aria-pressed={favorited}
            >
              {favorited ? '\u2665' : '\u2661'}
            </button>
          </div>
        </div>
      </div>

      {/* Track list. A multi-disc album gets a heading per disc (R00.3):
          disc numbers were parsed by the scanner but never shown, so disc 2
          track 1 looked like a duplicate of disc 1 track 1. */}
      <table className="w-full">
        <thead>
          <tr className="text-left text-xs text-gray-500 uppercase border-b border-white/10">
            <th className="pb-2 w-12">#</th>
            <th className="pb-2">Title</th>
            <th className="pb-2 hidden md:table-cell">Quality</th>
            <th className="pb-2 w-20 text-right">Duration</th>
            <th className="pb-2 w-8"></th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((track, trackIndex) => {
            const isCurrent = currentTrack?.id === track.id;
            const missing = track.availability === 'missing';
            const disc = track.discNumber ?? 1;
            const previousDisc = trackIndex > 0 ? (tracks[trackIndex - 1].discNumber ?? 1) : null;
            const startsDisc = hasMultipleDiscs && disc !== previousDisc;
            // Classical (R04.3): a heading whenever the work changes, so the
            // four movements of a symphony read as one piece, not four songs.
            const previousWork = trackIndex > 0 ? tracks[trackIndex - 1].work : undefined;
            const startsWork =
              hasWorks && !!track.work && (track.work !== previousWork || startsDisc);
            return (
              <Fragment key={track.id}>
                {startsDisc && (
                  <tr>
                    <th
                      scope="rowgroup"
                      colSpan={5}
                      className="pt-6 pb-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500"
                    >
                      Disc {disc}
                    </th>
                  </tr>
                )}
                {startsWork && (
                  <tr>
                    <th
                      scope="rowgroup"
                      colSpan={5}
                      className="pt-5 pb-1 text-left text-sm font-semibold text-gray-300"
                    >
                      {track.work}
                    </th>
                  </tr>
                )}
                <tr
                  onClick={() => playAlbum(tracks, trackIndex)}
                  title={
                    missing ? 'File not found on disk: rescan or clean up in Settings' : undefined
                  }
                  className={`cursor-pointer hover:bg-surface-light transition ${
                    isCurrent ? 'text-accent' : ''
                  } ${missing ? 'opacity-50' : ''}`}
                >
                  <td className="py-2.5 text-sm text-gray-500 w-12">
                    {isCurrent && isPlaying ? (
                      <span className="text-accent animate-pulse">&#9654;</span>
                    ) : (
                      track.trackNumber || '\u2014'
                    )}
                  </td>
                  <td className="py-2.5">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        playAlbum(tracks, trackIndex);
                      }}
                      className="w-full rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      aria-label={`Play ${track.title} by ${track.artistName}`}
                    >
                      <span className="block text-sm font-medium">
                        {hasWorks && track.work && track.movement ? track.movement : track.title}
                        {missing && (
                          <span className="ml-2 rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-red-300">
                            missing
                          </span>
                        )}
                      </span>
                      {track.artistName !== album.artistName && (
                        <span className="block text-xs text-gray-500">{track.artistName}</span>
                      )}
                    </button>
                  </td>
                  <td className="py-2.5 text-xs text-gray-500 hidden md:table-cell">
                    {formatQuality(track)}
                  </td>
                  <td className="py-2.5 text-sm text-gray-400 text-right">
                    {formatDuration(track.duration)}
                  </td>
                  <td className="py-2.5">
                    {!missing && (
                      <PlayActions
                        target={{
                          kind: 'track',
                          track: trackInfos[trackIndex],
                          list: trackInfos,
                          index: trackIndex,
                        }}
                      />
                    )}
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>

      {credits.length > 0 && (
        <section className="mt-10 max-w-3xl" data-testid="album-credits">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-3">
            Credits
          </h3>
          <dl className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-x-6 gap-y-2 text-sm">
            {credits.map((credit) => (
              <Fragment key={credit.role}>
                <dt className="text-gray-500">{ROLE_TITLE[credit.role] ?? credit.role}</dt>
                <dd className="flex flex-wrap gap-x-3 gap-y-1">
                  {credit.people.map((person) => (
                    <Link
                      key={person.artistId}
                      to={`/artists/${person.artistId}`}
                      className="hover:text-accent transition"
                    >
                      {person.name}
                      {credit.people.length > 1 && person.tracks < tracks.length && (
                        <span className="text-xs text-gray-600"> ({person.tracks})</span>
                      )}
                    </Link>
                  ))}
                </dd>
              </Fragment>
            ))}
          </dl>
        </section>
      )}

      {versions && (versions.local.length > 0 || versions.streaming.length > 0) && (
        <section className="mt-10 max-w-3xl" data-testid="album-versions">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-3">
            Versions
          </h3>
          <ul className="space-y-2">
            {versions.local.map((version) => (
              <li key={version.id} className="flex items-center gap-3 text-sm">
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-white/5 text-gray-400 shrink-0">
                  library
                </span>
                <Link
                  to={`/albums/${version.id}`}
                  className="flex-1 min-w-0 truncate hover:text-accent transition"
                >
                  {version.title}
                </Link>
                <span className="text-xs text-gray-500 shrink-0">
                  {formatQuality({
                    format: version.format ?? undefined,
                    sampleRate: version.sampleRate ?? undefined,
                    bitDepth: version.bitDepth ?? undefined,
                  }) || version.format?.toUpperCase()}
                </span>
                <button
                  type="button"
                  onClick={() => void playVersion(version.id)}
                  className="text-xs text-accent hover:text-accent-hover shrink-0"
                  aria-label={`Play ${version.title} (${version.format ?? 'other edition'})`}
                >
                  &#9654;
                </button>
              </li>
            ))}
            {versions.streaming.map((version) => (
              <li key={version.id} className="flex items-center gap-3 text-sm">
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-white/5 text-gray-400 shrink-0">
                  qobuz
                </span>
                <Link
                  to={`/albums/${version.id}`}
                  className="flex-1 min-w-0 truncate hover:text-accent transition"
                >
                  {version.title}
                  {version.year ? ` (${version.year})` : ''}
                </Link>
                <span className="text-xs text-gray-500 shrink-0">
                  {formatQuality({
                    sampleRate: version.sampleRate ?? undefined,
                    bitDepth: version.bitDepth ?? undefined,
                  })}
                  {version.higherResolution && (
                    <span className="ml-1 text-accent">higher resolution</span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => void playVersion(version.id)}
                  className="text-xs text-accent hover:text-accent-hover shrink-0"
                  aria-label={`Play ${version.title} on Qobuz`}
                >
                  &#9654;
                </button>
              </li>
            ))}
          </ul>
          {versions.sources.qobuz === 'timeout' && (
            <p className="text-xs text-gray-600 mt-2">Qobuz did not answer in time.</p>
          )}
        </section>
      )}
    </div>
  );
}
