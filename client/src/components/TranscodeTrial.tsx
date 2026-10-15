import { useCallback, useEffect, useState } from 'react';
import { api, ensureStreamToken } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';
import type { TranscodeRun } from '../api/types.js';

/**
 * The conversion trial (R10.1, measured for R10.3).
 *
 * The NAS converts only for speakers that do not take the source format, so
 * a household without such a speaker would never see a number. "Measure"
 * asks the NAS to convert the track that is playing to MP3, the way a speaker
 * would fetch it, and reads it to the end; the table shows what each
 * conversion cost: CPU per minute of music and peak memory of ffmpeg.
 */

const isLocal = (trackId: string) => !trackId.includes(':');

function cpuShare(run: TranscodeRun): string {
  if (!run.cpuMsPerAudioMinute) return '—';
  return `${(run.cpuMsPerAudioMinute / 600).toFixed(1)}%`;
}

export default function TranscodeTrial() {
  const { currentTrack } = useAudioContext();
  const [runs, setRuns] = useState<{ active: TranscodeRun[]; recent: TranscodeRun[] }>({
    active: [],
    recent: [],
  });
  const [measuring, setMeasuring] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .getTranscodes()
      .then((res) => setRuns(res.data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [load]);

  const trackId = currentTrack && isLocal(currentTrack.id) ? currentTrack.id : null;

  const measure = async (parallel: number) => {
    if (!trackId) return;
    setError(null);
    setMeasuring(parallel);
    try {
      await ensureStreamToken();
      const stamp = Date.now().toString(36);
      await Promise.all(
        Array.from({ length: parallel }, async (_, i) => {
          const base = api.getStreamUrl(trackId);
          const url = `${base}${base.includes('?') ? '&' : '?'}format=mp3&zone=meting-${stamp}-${i + 1}`;
          const res = await fetch(url);
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          // Read to the end like a speaker would, and throw the audio away.
          const reader = res.body.getReader();
          while (!(await reader.read()).done) {
            /* keep reading */
          }
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The conversion failed');
    } finally {
      setMeasuring(0);
      load();
    }
  };

  const rows = [...runs.active, ...runs.recent];

  return (
    <section className="mb-10">
      <h3 className="text-lg font-semibold mb-4 text-gray-300">Conversion trial (R10)</h3>
      <div className="bg-surface-light rounded-lg p-4 space-y-3">
        <p className="text-sm text-gray-400">
          What converting on the NAS costs. Measure converts the playing track to MP3 320 the way a
          speaker would fetch it; use it with one and with two at a time.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void measure(1)}
            disabled={!trackId || measuring > 0}
            className="px-3 py-1 text-sm bg-accent rounded hover:bg-accent-hover transition disabled:opacity-40"
          >
            {measuring === 1 ? 'Converting…' : 'Measure one'}
          </button>
          <button
            type="button"
            onClick={() => void measure(2)}
            disabled={!trackId || measuring > 0}
            className="px-3 py-1 text-sm bg-surface-dark border border-white/10 rounded hover:bg-white/10 transition disabled:opacity-40"
          >
            {measuring === 2 ? 'Converting…' : 'Measure two at once'}
          </button>
          {!trackId && (
            <span className="text-xs text-gray-500">Play a track from the library first.</span>
          )}
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
        {rows.length === 0 ? (
          <p className="text-xs text-gray-500">No conversions yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="text-gray-500">
                <tr>
                  <th className="py-1 pr-3 font-normal">Room</th>
                  <th className="py-1 pr-3 font-normal">To</th>
                  <th className="py-1 pr-3 font-normal">Outcome</th>
                  <th className="py-1 pr-3 font-normal">CPU per min. music</th>
                  <th className="py-1 pr-3 font-normal">≈ of one core</th>
                  <th className="py-1 font-normal">Peak memory</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((run) => (
                  <tr key={run.id} className="border-t border-white/5">
                    <td className="py-1 pr-3 truncate max-w-[10rem]">{run.zoneId}</td>
                    <td className="py-1 pr-3">
                      {run.target.toUpperCase()}
                      {run.gainDb ? ` ${run.gainDb} dB` : ''}
                    </td>
                    <td className="py-1 pr-3">{run.outcome ?? 'running'}</td>
                    <td className="py-1 pr-3 tabular-nums">
                      {run.cpuMsPerAudioMinute ? `${run.cpuMsPerAudioMinute} ms` : '—'}
                    </td>
                    <td className="py-1 pr-3 tabular-nums">{cpuShare(run)}</td>
                    <td className="py-1 tabular-nums">
                      {run.peakRssKb ? `${Math.round(run.peakRssKb / 1024)} MB` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
