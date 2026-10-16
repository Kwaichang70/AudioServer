import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResponse, FetchStatus } from '../../api/types.js';

/**
 * One background fetch job on the server (covers, artist images) with its
 * progress on the page. The job runs on the server whatever the page does;
 * opening the page asks where it is, so the bar is there again after a
 * reload or on another device, and the last result stays readable.
 */

const POLL_MS = 3000;

interface FetchJobProps {
  title: string;
  description: string;
  button: string;
  /** What is counted: "albums", "artists". */
  noun: string;
  start: () => Promise<ApiResponse<FetchStatus>>;
  status: () => Promise<ApiResponse<FetchStatus>>;
}

export default function FetchJob({
  title,
  description,
  button,
  noun,
  start,
  status,
}: FetchJobProps) {
  const [state, setState] = useState<FetchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const poll = useCallback(async () => {
    stopPolling();
    try {
      const res = await status();
      setState(res.data);
      if (res.data.isRunning) timer.current = setTimeout(() => void poll(), POLL_MS);
    } catch {
      // A failed read stops here; the next page visit asks again.
    }
  }, [status]);

  useEffect(() => {
    void poll();
    return stopPolling;
  }, [poll]);

  const run = async () => {
    setError(null);
    try {
      const res = await start();
      setState(res.data);
      timer.current = setTimeout(() => void poll(), POLL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const running = state?.isRunning === true;
  const percent =
    state && state.total > 0 ? Math.min(100, Math.round((state.processed / state.total) * 100)) : 0;

  return (
    <div className="pt-2 border-t border-white/5 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-gray-500">{description}</p>
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className="shrink-0 px-4 py-1.5 text-sm bg-surface-dark border border-white/10 rounded hover:border-accent transition disabled:opacity-50 disabled:hover:border-white/10"
        >
          {running ? 'Fetching…' : button}
        </button>
      </div>
      {running && state && (
        <div>
          <div
            className="h-1.5 rounded bg-white/10 overflow-hidden"
            role="progressbar"
            aria-label={`${title} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="h-full bg-accent transition-all" style={{ width: `${percent}%` }} />
          </div>
          <p className="mt-1 text-xs text-gray-400 tabular-nums">
            {state.processed} of {state.total} {noun} · {state.found} found · {percent}%
          </p>
        </div>
      )}
      {!running && state && state.total > 0 && (
        <p className="text-xs text-gray-400 tabular-nums">
          Done: {state.found} found, {state.notFound} not found (of {state.total} {noun}).
        </p>
      )}
      {!running && state && state.total === 0 && state.processed === 0 && (
        <p className="text-xs text-gray-500">Not run since the server started.</p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
