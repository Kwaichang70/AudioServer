import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';
import { formatDuration } from '../utils/format.js';
import type { ComposerDetail, ComposerSummary } from '../api/types.js';
import type { TrackInfo } from '../types/playback.js';

/**
 * Composers (R04.4).
 *
 * A composer made none of the recordings and is on all of them, so this page
 * is organised by WORK: the symphony, with every recording of it in the
 * library underneath, each playable from its first movement. Tracks without
 * a work tag are listed under "Other pieces" instead of being hidden — the
 * tags of a classical collection are rarely complete, and the page says so
 * by showing them rather than by pretending they do not exist.
 */

function ComposerList() {
  const [composers, setComposers] = useState<ComposerSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getComposers()
      .then((res) => {
        if (!cancelled) setComposers(res.data);
      })
      .catch(() => {
        if (!cancelled) setComposers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!composers) return <p className="text-gray-400">Loading...</p>;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-1">Composers</h2>
      <p className="text-xs text-gray-500 mb-6">
        From the composer tags in your files. A composer appears here once their name is in a
        composer tag; a folder without those tags does not show up.
      </p>
      {composers.length === 0 ? (
        <p className="text-gray-500 text-sm">No composer tags found in the library yet.</p>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {composers.map((composer) => (
            <li key={composer.id}>
              <Link
                to={`/composers/${composer.id}`}
                className="block bg-surface-light rounded-lg px-4 py-3 hover:bg-surface transition"
              >
                <p className="text-sm font-medium">{composer.name}</p>
                <p className="text-xs text-gray-500">
                  {composer.workCount > 0
                    ? `${composer.workCount} work${composer.workCount === 1 ? '' : 's'} · `
                    : ''}
                  {composer.albumCount} album{composer.albumCount === 1 ? '' : 's'} ·{' '}
                  {composer.trackCount} track{composer.trackCount === 1 ? '' : 's'}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ComposerWorks({ id }: { id: string }) {
  const [composer, setComposer] = useState<ComposerDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const { playAlbum } = useAudioContext();

  useEffect(() => {
    let cancelled = false;
    setComposer(null);
    setFailed(false);
    api
      .getComposer(id)
      .then((res) => {
        if (!cancelled) setComposer(res.data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (failed) return <p className="text-gray-500">This composer is not in the library.</p>;
  if (!composer) return <p className="text-gray-400">Loading...</p>;

  /** One recording of a work, as a queue: its movements in order. */
  const playRecording = (
    recording: ComposerDetail['works'][number]['recordings'][number],
    from = 0,
  ) => {
    const list: TrackInfo[] = recording.tracks
      .filter((t) => !t.missing)
      .map((t) => ({
        id: t.id,
        title: t.title,
        artistName: recording.albumArtist,
        albumTitle: recording.albumTitle,
        albumId: recording.albumId,
        duration: t.duration ?? undefined,
        source: 'local',
      }));
    if (list.length > 0) playAlbum(list, Math.min(from, list.length - 1));
  };

  return (
    <div>
      <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Composer</p>
      <div className="flex flex-wrap items-baseline gap-3 mb-6">
        <h2 className="text-3xl font-bold">{composer.name}</h2>
        <Link to={`/artists/${composer.id}`} className="text-xs text-accent hover:underline">
          Artist page
        </Link>
      </div>

      {composer.works.map((work) => (
        <section key={work.work ?? '__other'} className="mb-8">
          <h3 className="text-lg font-semibold mb-2">{work.work ?? 'Other pieces'}</h3>
          {work.work === null && (
            <p className="text-xs text-gray-600 mb-2">
              Tracks whose files carry this composer but no work tag.
            </p>
          )}
          <ul className="space-y-3">
            {work.recordings.map((recording) => (
              <li key={recording.albumId} className="bg-surface-light rounded-lg p-3">
                <div className="flex items-center justify-between gap-3">
                  <Link
                    to={`/albums/${recording.albumId}`}
                    className="min-w-0 hover:text-accent transition"
                  >
                    <span className="block text-sm font-medium truncate">
                      {recording.albumArtist}
                    </span>
                    <span className="block text-xs text-gray-500 truncate">
                      {recording.albumTitle}
                      {recording.year ? ` · ${recording.year}` : ''}
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => playRecording(recording)}
                    className="text-xs px-3 py-1.5 bg-accent rounded-full hover:bg-accent-hover transition shrink-0"
                    aria-label={`Play ${work.work ?? 'these pieces'} by ${recording.albumArtist}`}
                  >
                    Play
                  </button>
                </div>
                <ol className="mt-2">
                  {recording.tracks.map((track, index) => (
                    <li key={track.id}>
                      <button
                        type="button"
                        disabled={track.missing}
                        onClick={() => playRecording(recording, index)}
                        className="w-full flex items-center gap-3 py-1 text-left text-sm text-gray-300 hover:text-white disabled:opacity-50 transition"
                      >
                        <span className="flex-1 min-w-0 truncate">
                          {track.movement ?? track.title}
                        </span>
                        <span className="text-xs text-gray-500 shrink-0">
                          {track.missing ? 'missing' : formatDuration(track.duration ?? undefined)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export default function ComposersPage() {
  const { id } = useParams<{ id: string }>();
  return id ? <ComposerWorks id={id} /> : <ComposerList />;
}
