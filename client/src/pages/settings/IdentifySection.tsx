import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { useToast } from '../../components/Toast.js';
import type { DoubtfulAlbum, IdentifyStatus } from '../../api/types.js';
import { getErrorMessage } from './shared.js';

/**
 * Album identification (R03.3/R03.4).
 *
 * The job links only what is beyond doubt, which means the interesting part
 * of this screen is the list of what it refused to decide. Every candidate is
 * shown with the things that tell releases apart — label, catalogue number,
 * date and track count — so the choice can be made on evidence instead of on
 * which one happened to rank first.
 */
export default function IdentifySection() {
  const { toast } = useToast();
  const [status, setStatus] = useState<IdentifyStatus | null>(null);
  const [doubtful, setDoubtful] = useState<DoubtfulAlbum[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  const load = useCallback(async () => {
    try {
      const [statusRes, doubtfulRes] = await Promise.all([
        api.getIdentifyStatus(),
        api.getDoubtfulAlbums(),
      ]);
      setStatus(statusRes.data);
      setDoubtful(doubtfulRes.data);
      return statusRes.data;
    } catch {
      // A failing poll must not keep retrying forever.
      stopPolling();
      return null;
    }
  }, [stopPolling]);

  useEffect(() => {
    void load();
    return stopPolling;
  }, [load, stopPolling]);

  const start = async () => {
    try {
      const res = await api.identifyAlbums();
      setStatus(res.data);
      toast(res.message || 'Identification started', 'info');
      stopPolling();
      pollRef.current = setInterval(async () => {
        const next = await load();
        if (next && !next.isRunning) {
          stopPolling();
          toast(
            `Identification done: ${next.linked} linked, ${next.doubtful} to decide, ${next.notFound} not found`,
            'success',
          );
        }
      }, 5000);
    } catch (err) {
      toast(`Identification failed: ${getErrorMessage(err, 'unknown error')}`, 'error');
    }
  };

  const choose = async (albumId: string, mbid: string) => {
    setBusy(albumId);
    try {
      await api.chooseAlbumIdentity(albumId, mbid);
      toast('Album linked', 'success');
      await load();
    } catch (err) {
      toast(`Could not link that release: ${getErrorMessage(err, 'unknown error')}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async (albumId: string) => {
    setBusy(albumId);
    try {
      await api.dismissAlbumCandidates(albumId);
      toast('Left unidentified', 'info');
      await load();
    } catch (err) {
      toast(`Could not dismiss: ${getErrorMessage(err, 'unknown error')}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mb-10" data-testid="identify-section">
      <h3 className="text-lg font-semibold mb-4 text-gray-300">Album identification</h3>

      <div className="bg-surface-light rounded-lg p-4 space-y-4 text-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Identify albums at MusicBrainz</p>
            <p className="text-xs text-gray-500">
              For albums whose files carry no MusicBrainz tags. One request per second, so a large
              library takes a while. Only an unambiguous match is linked; the rest end up below.
            </p>
          </div>
          <button
            type="button"
            onClick={start}
            disabled={status?.isRunning}
            className="px-4 py-1.5 text-sm bg-surface-dark border border-white/10 rounded hover:border-accent transition disabled:opacity-50 shrink-0"
          >
            {status?.isRunning ? 'Running…' : 'Identify albums'}
          </button>
        </div>

        {status && (status.isRunning || status.processed > 0) && (
          <p className="text-xs text-gray-400">
            {status.processed}/{status.total} checked · {status.linked} linked · {status.doubtful}{' '}
            to decide · {status.notFound} not found
          </p>
        )}
      </div>

      <h4 className="text-sm font-semibold text-gray-400 mt-6 mb-2">
        Waiting for your decision {doubtful.length > 0 && `(${doubtful.length})`}
      </h4>
      <div className="bg-surface-light rounded-lg p-4 space-y-4 text-sm">
        {doubtful.length === 0 ? (
          <p className="text-gray-500">
            Nothing to decide. Albums the job could not pin down with certainty appear here.
          </p>
        ) : (
          doubtful.map((album) => (
            <div
              key={album.albumId}
              className="border-b border-white/5 pb-4 last:border-0 last:pb-0"
            >
              <p className="font-medium">
                {album.title}{' '}
                <span className="text-xs text-gray-500">
                  — {album.artistName}
                  {album.trackCount ? ` · ${album.trackCount} tracks` : ''}
                </span>
              </p>
              <ul className="mt-2 space-y-1">
                {album.candidates.map((candidate) => (
                  <li
                    key={candidate.mbid}
                    className="flex items-center justify-between gap-3 flex-wrap"
                  >
                    <span className="text-xs text-gray-400 min-w-0">
                      {candidate.title} — {candidate.artist}
                      {candidate.date ? ` · ${candidate.date}` : ''}
                      {candidate.label ? ` · ${candidate.label}` : ''}
                      {candidate.catalogNumber ? ` · ${candidate.catalogNumber}` : ''}
                      {candidate.trackCount ? ` · ${candidate.trackCount} tracks` : ''}
                      <span className="ml-1 text-gray-600">({candidate.score})</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => choose(album.albumId, candidate.mbid)}
                      disabled={busy === album.albumId}
                      className="text-xs px-3 py-1 bg-surface-dark border border-white/10 rounded hover:border-accent transition disabled:opacity-50"
                    >
                      This one
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => dismiss(album.albumId)}
                disabled={busy === album.albumId}
                className="mt-2 text-xs text-gray-500 hover:text-gray-300 disabled:opacity-50"
              >
                None of these — leave it unidentified
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
