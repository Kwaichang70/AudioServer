import { useEffect, useState } from 'react';
import { applyServiceWorkerUpdate, useServiceWorkerState } from '../sw/register.js';

/**
 * Two small, honest banners (V08.1):
 *   - Offline: the browser lost the network. Music on a speaker keeps playing
 *     on the NAS; nothing here promises offline music.
 *   - Update ready: a new build is installed and waiting; reload when you
 *     want it. Nothing swaps under the running page by itself.
 */
export function useOnlineState(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

export default function AppStatusBanners() {
  const online = useOnlineState();
  const { updateReady } = useServiceWorkerState();
  if (online && !updateReady) return null;
  return (
    <div role="status" aria-live="polite" className="text-sm">
      {!online && (
        <div
          className="flex items-center justify-between gap-3 px-4 py-2 bg-amber-500/20 text-amber-100 border-b border-amber-400/30"
          data-testid="offline-banner"
        >
          <span>
            Offline: no connection to AudioServer. Music on a speaker keeps playing on the NAS; this
            page catches up when the connection is back.
          </span>
        </div>
      )}
      {updateReady && (
        <div
          className="flex items-center justify-between gap-3 px-4 py-2 bg-accent/20 text-white border-b border-accent/40"
          data-testid="update-banner"
        >
          <span>A new version of AudioServer is ready.</span>
          <button
            type="button"
            onClick={applyServiceWorkerUpdate}
            className="min-h-[44px] px-4 rounded bg-accent hover:bg-accent-hover transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            Reload now
          </button>
        </div>
      )}
    </div>
  );
}
