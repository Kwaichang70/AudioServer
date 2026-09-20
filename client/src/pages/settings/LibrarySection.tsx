import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { useToast } from '../../components/Toast.js';
import { DEVICE_POLL_INTERVAL } from '../../constants.js';
import { useSocket, type LibraryScanProgress } from '../../hooks/useSocket.js';
import type { MissingTrack, ScanRun } from '../../api/types.js';
import { best, formatScanInfo, getErrorMessage } from './shared.js';

/** Scanning, missing files, covers and artist images (R02.4). */
export default function LibrarySection() {
  const { toast } = useToast();
  const socket = useSocket();
  const [scanning, setScanning] = useState(false);
  const [scanInfo, setScanInfo] = useState('');
  const scanPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scanCompleteToastRef = useRef(false);
  // Cover/artist-image fetch progress polls. Kept in refs so they can be
  // cleared on unmount, on error, and before starting a new one (a double
  // click used to stack intervals that then leaked forever).
  const coverPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const artistPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(
    () => () => {
      if (coverPollRef.current) clearInterval(coverPollRef.current);
      if (artistPollRef.current) clearInterval(artistPollRef.current);
    },
    [],
  );
  const [lastRun, setLastRun] = useState<ScanRun | null>(null);
  const [configuredRoots, setConfiguredRoots] = useState<string[]>([]);
  const [missing, setMissing] = useState<MissingTrack[]>([]);
  const [missingTotal, setMissingTotal] = useState(0);
  const loadLibraryHealth = useCallback(() => {
    api
      .getScanStatus()
      .then((r) => {
        setLastRun(r.lastSuccessfulRun ?? null);
        setConfiguredRoots(r.configuredRoots ?? []);
        if (r.data.isScanning) applyScanStatusRef.current?.(r.data);
      })
      .catch(() => {});
    api
      .getMissingTracks()
      .then((r) => {
        setMissing(r.data);
        setMissingTotal(r.meta?.total ?? r.data.length);
      })
      .catch(() => {});
  }, []);
  const applyScanStatusRef = useRef<((s: LibraryScanProgress) => void) | null>(null);

  useEffect(() => {
    loadLibraryHealth();
  }, [loadLibraryHealth]);

  const stopScanPolling = useCallback(() => {
    if (scanPollRef.current) {
      clearInterval(scanPollRef.current);
      scanPollRef.current = null;
    }
  }, []);

  const applyScanStatus = useCallback(
    (s: LibraryScanProgress) => {
      setScanning(s.isScanning);
      setScanInfo(formatScanInfo(s));

      if (s.isScanning) {
        scanCompleteToastRef.current = false;
        return;
      }

      stopScanPolling();
      if (s.phase === 'done' && !scanCompleteToastRef.current) {
        scanCompleteToastRef.current = true;
        const missingNote = s.missingTracks ? `, ${s.missingTracks} file(s) missing` : '';
        toast(`Library scan complete${missingNote}`, s.missingTracks ? 'info' : 'success');
        loadLibraryHealth();
      }
    },
    [stopScanPolling, toast, loadLibraryHealth],
  );
  applyScanStatusRef.current = applyScanStatus;

  const startScanPolling = useCallback(() => {
    stopScanPolling();
    scanPollRef.current = setInterval(async () => {
      const res = await api.getScanStatus();
      applyScanStatus(res.data);
    }, DEVICE_POLL_INTERVAL);
  }, [applyScanStatus, stopScanPolling]);

  useEffect(() => {
    if (socket.scanProgress) applyScanStatus(socket.scanProgress);
  }, [applyScanStatus, socket.scanProgress]);

  useEffect(() => () => stopScanPolling(), [stopScanPolling]);

  const startScan = async (force = false) => {
    setScanning(true);
    scanCompleteToastRef.current = false;
    try {
      const res = await api.scanLibrary({ force });
      applyScanStatus(res.data);
      if (!socket.connected) startScanPolling();
    } catch (err) {
      // Without this, a failed POST left the button stuck on "Scanning..."
      setScanning(false);
      toast(`Scan failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  return (
    <section className="mb-10">
      <h3 className="text-lg font-semibold mb-4 text-gray-300">Local Library</h3>
      <div className="bg-surface-light rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Music Library Scanner</p>
            <p className="text-xs text-gray-500">Scan your local music folders for new tracks</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => startScan(false)}
              disabled={scanning}
              className="px-4 py-1.5 text-sm bg-accent rounded hover:bg-accent-hover transition disabled:opacity-50"
            >
              {scanning ? 'Scanning...' : 'Scan Now'}
            </button>
            <button
              onClick={() => startScan(true)}
              disabled={scanning}
              title="Re-read every file, also unchanged ones (after tag repairs or new metadata rules)"
              className="px-3 py-1.5 text-sm bg-surface rounded border border-white/10 hover:bg-surface-light transition disabled:opacity-50"
            >
              Full rescan
            </button>
          </div>
        </div>
        {(scanning || scanInfo) && (
          <p className="text-xs text-gray-400 animate-pulse">{scanInfo}</p>
        )}

        {/* Library health (V06.3) */}
        <div
          className="pt-2 border-t border-white/5 text-xs space-y-1"
          data-testid="library-health"
        >
          <p className="text-gray-400">
            Last successful scan:{' '}
            {lastRun?.finishedAt ? (
              <span className="text-gray-200">
                {new Date(lastRun.finishedAt * 1000).toLocaleString()} · {lastRun.totalFiles} files,
                +{lastRun.newTracks} new, {lastRun.relinkedTracks} moved, {lastRun.missingTracks}{' '}
                missing
                {lastRun.failedRoots.length > 0
                  ? `, ${lastRun.failedRoots.length} root(s) unreadable`
                  : ''}
              </span>
            ) : (
              <span className="text-gray-500">none recorded yet</span>
            )}
          </p>
          {configuredRoots.length > 0 && (
            <p className="text-gray-500">Roots: {configuredRoots.join(', ')}</p>
          )}
          {lastRun && lastRun.failedRoots.length > 0 && (
            <ul className="text-amber-300">
              {lastRun.failedRoots.map((r) => (
                <li key={r.path}>
                  Unreachable: {r.path} ({r.error}). Its music was kept as is.
                </li>
              ))}
            </ul>
          )}
          {missingTotal > 0 && (
            <div className="flex items-start justify-between gap-3 pt-1">
              <div>
                <p className="text-amber-300">
                  {missingTotal} file(s) missing since the last scans. Playlists, favorites and
                  history are kept until you clean up.
                </p>
                <ul className="text-gray-500 mt-1 space-y-0.5">
                  {missing.slice(0, 5).map((m) => (
                    <li key={m.id}>
                      {m.artistName} – {m.title}
                      {m.candidates.length > 0 && (
                        <button
                          className="ml-2 text-accent hover:underline"
                          onClick={async () => {
                            const best = m.candidates[0];
                            try {
                              await api.relinkMissingTrack(m.id, best.id);
                              toast(`Linked to ${best.title}`, 'success');
                              loadLibraryHealth();
                            } catch (err) {
                              toast(getErrorMessage(err, 'Relink failed'), 'error');
                            }
                          }}
                          title={`${best(m).strength === 'strong' ? 'Same file signature' : 'Same title and artist only'}: ${best(m).filePath ?? best(m).title}`}
                        >
                          link to {best(m).title}
                          {best(m).strength === 'weak' ? ' (doubtful)' : ''}
                        </button>
                      )}
                    </li>
                  ))}
                  {missingTotal > 5 && <li>… and {missingTotal - 5} more</li>}
                </ul>
              </div>
              <button
                className="px-3 py-1 text-xs bg-red-500/20 text-red-200 rounded hover:bg-red-500/30 transition shrink-0"
                onClick={async () => {
                  if (
                    !window.confirm(
                      `Remove ${missingTotal} missing file(s) from the library, including their playlist positions and favorites?`,
                    )
                  )
                    return;
                  try {
                    const r = await api.purgeMissingTracks();
                    toast(`Removed ${r.data.purged} missing file(s)`, 'info');
                    loadLibraryHealth();
                  } catch (err) {
                    toast(getErrorMessage(err, 'Clean-up failed'), 'error');
                  }
                }}
              >
                Clean up missing
              </button>
            </div>
          )}
        </div>

        {/* Cover Art Fetch */}
        <div className="flex items-center justify-between pt-2 border-t border-white/5">
          <div>
            <p className="text-sm font-medium">Fetch Missing Cover Art</p>
            <p className="text-xs text-gray-500">
              Download covers from MusicBrainz for albums without embedded art
            </p>
          </div>
          <button
            onClick={async () => {
              try {
                // Use the api client so the Bearer token is attached — requireAuth
                // would otherwise 401 these /api/* calls.
                const data = await api.fetchCovers();
                toast(data.message || 'Cover fetch started', 'info');
                if (coverPollRef.current) clearInterval(coverPollRef.current);
                coverPollRef.current = setInterval(async () => {
                  try {
                    const statusRes = await api.getCoverFetchStatus();
                    const s = statusRes.data;
                    if (s.isRunning) {
                      toast(`Covers: ${s.processed}/${s.total} (${s.found} found)`, 'info');
                    } else {
                      if (coverPollRef.current) clearInterval(coverPollRef.current);
                      coverPollRef.current = null;
                      toast(`Cover art done: ${s.found} found, ${s.notFound} not found`, 'success');
                    }
                  } catch {
                    // A failing status poll must stop the interval, not loop forever
                    if (coverPollRef.current) clearInterval(coverPollRef.current);
                    coverPollRef.current = null;
                  }
                }, 10000);
              } catch (err) {
                toast(`Cover fetch failed: ${String(err)}`, 'error');
              }
            }}
            className="px-4 py-1.5 text-sm bg-surface-dark border border-white/10 rounded hover:border-accent transition"
          >
            Fetch Covers
          </button>
        </div>

        {/* Artist Images */}
        <div className="flex items-center justify-between pt-2 border-t border-white/5">
          <div>
            <p className="text-sm font-medium">Fetch Artist Images</p>
            <p className="text-xs text-gray-500">
              Download artist photos from Spotify (requires Spotify connection)
            </p>
          </div>
          <button
            onClick={async () => {
              try {
                const data = await api.fetchArtistImages();
                toast(data.message || 'Artist image fetch started', 'info');
                if (artistPollRef.current) clearInterval(artistPollRef.current);
                artistPollRef.current = setInterval(async () => {
                  try {
                    const statusRes = await api.getArtistImageFetchStatus();
                    const s = statusRes.data;
                    if (s.isRunning) {
                      toast(`Artists: ${s.processed}/${s.total} (${s.found} found)`, 'info');
                    } else {
                      if (artistPollRef.current) clearInterval(artistPollRef.current);
                      artistPollRef.current = null;
                      toast(`Artist images done: ${s.found} found`, 'success');
                    }
                  } catch {
                    if (artistPollRef.current) clearInterval(artistPollRef.current);
                    artistPollRef.current = null;
                  }
                }, 10000);
              } catch (err) {
                toast(`Artist image fetch failed: ${String(err)}`, 'error');
              }
            }}
            className="px-4 py-1.5 text-sm bg-surface-dark border border-white/10 rounded hover:border-accent transition"
          >
            Fetch Images
          </button>
        </div>
      </div>
    </section>
  );
}
