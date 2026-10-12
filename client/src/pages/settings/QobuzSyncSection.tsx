import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import type { QobuzSyncStatus } from '../../api/types.js';
import Button from '../../components/ui/Button.js';
import { getErrorMessage } from './shared.js';

/**
 * Library ⇄ Qobuz favourites (R07.2).
 *
 * Adding a Qobuz album in the app favourites it on Qobuz, and a favourite you
 * add on Qobuz comes into the library — every six hours, or now. What you
 * removed from the favourites on Qobuz is not deleted here behind your back:
 * it is listed below until you say remove or keep.
 */
export default function QobuzSyncSection() {
  const [status, setStatus] = useState<QobuzSyncStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.resolve()
      .then(() => api.getQobuzSync())
      .then((res) => setStatus(res.data))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  const run = async (key: string, action: () => Promise<{ data: QobuzSyncStatus }>) => {
    setBusy(key);
    setError(null);
    try {
      setStatus((await action()).data);
    } catch (err) {
      setError(getErrorMessage(err, 'Qobuz sync failed'));
    } finally {
      setBusy(null);
    }
  };

  const last = status?.last;
  return (
    <section className="mb-10" data-testid="qobuz-sync-section">
      <h3 className="mb-4 text-lg font-semibold text-gray-300">Qobuz favourites</h3>
      <div className="space-y-4 rounded-lg bg-surface-light p-4 text-sm">
        <div className="flex items-start justify-between gap-4">
          <p className="text-gray-400">
            A Qobuz album you add to the library becomes a Qobuz favourite, and a favourite you add
            on Qobuz appears in the library. Synced every six hours.
          </p>
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => void run('sync', () => api.runQobuzSync())}
          >
            {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </Button>
        </div>
        {last ? (
          <p className="text-xs text-gray-500" role="status">
            Last sync {new Date(last.at * 1000).toLocaleString()}: {last.addedToLibrary.length}{' '}
            added to the library, {last.favoritedOnQobuz.length} favourited and{' '}
            {last.unfavoritedOnQobuz.length} unfavourited on Qobuz
            {last.errors.length > 0 ? `, ${last.errors.length} could not be synced` : ''}.
          </p>
        ) : (
          <p className="text-xs text-gray-500">No sync since the server started.</p>
        )}
        {last && last.errors.length > 0 && (
          <ul className="list-disc pl-5 text-xs text-amber-300">
            {last.errors.slice(0, 5).map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="text-xs text-red-300">
            {error}
          </p>
        )}
        {status && status.waiting.length > 0 && (
          <div>
            <p className="mb-2 text-xs uppercase tracking-wider text-gray-500">
              Removed from your Qobuz favourites — remove from the library too?
            </p>
            <ul className="space-y-1" aria-label="Waiting for your decision">
              {status.waiting.map((album) => (
                <li key={album.id} className="flex items-center gap-2">
                  <Link
                    to={`/albums/${album.id}`}
                    className="min-w-0 flex-1 truncate hover:text-accent"
                  >
                    {album.title} <span className="text-gray-500">— {album.artistName}</span>
                  </Link>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(album.id, () => api.decideQobuzRemoval(album.id, 'keep'))
                    }
                  >
                    Keep
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(album.id, () => api.decideQobuzRemoval(album.id, 'remove'))
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
