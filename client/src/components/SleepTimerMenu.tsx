import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';
import type { SleepTimer } from '../api/types.js';

/**
 * The sleep timer (E01).
 *
 * The timer runs on the server, so this menu only sets and cancels it: the
 * music stops even when this tab is closed, asleep or on another device. What
 * is shown is the server's own sentence about what will happen, plus a
 * countdown for a timed sleep — the countdown is cosmetic, the server decides.
 */

const PRESETS = [15, 30, 45, 60, 90];

function countdown(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0)
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export default function SleepTimerMenu() {
  const [timer, setTimer] = useState<SleepTimer | null>(null);
  const [open, setOpen] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // Another tab (or the timer firing) changes this room's timer too; the
  // context mirrors what the server last said.
  const { sleepTimer } = useAudioContext();

  const load = useCallback(() => {
    api
      .getSleepTimer()
      .then((res) => {
        setTimer(res.data);
        setRemaining(res.data?.secondsRemaining ?? null);
      })
      .catch(() => setTimer(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (sleepTimer === undefined) return;
    setTimer(sleepTimer);
    setRemaining(sleepTimer?.secondsRemaining ?? null);
  }, [sleepTimer]);

  // A local tick so the number moves; the server is what actually stops the
  // music, so reaching zero here only triggers a re-read.
  useEffect(() => {
    if (remaining === null) return;
    const handle = setInterval(() => {
      setRemaining((value) => {
        if (value === null) return null;
        if (value <= 1) {
          load();
          return null;
        }
        return value - 1;
      });
    }, 1000);
    return () => clearInterval(handle);
  }, [remaining, load]);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const set = async (mode: SleepTimer['mode'], minutes?: number) => {
    try {
      const res = await api.setSleepTimer(mode, minutes);
      setTimer(res.data);
      setRemaining(res.data.secondsRemaining);
      setNote(res.meta?.note ?? null);
      setOpen(false);
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'That did not work');
    }
  };

  const cancel = async () => {
    await api.cancelSleepTimer().catch(() => {});
    setTimer(null);
    setRemaining(null);
    setNote(null);
    setOpen(false);
  };

  const active = !!timer;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`min-h-[44px] px-2 text-sm transition ${
          active ? 'text-accent' : 'text-gray-500 hover:text-white'
        }`}
        title={timer?.description ?? 'Sleep timer'}
        aria-label={timer ? `Sleep timer: ${timer.description}` : 'Sleep timer'}
        aria-pressed={active}
      >
        <span aria-hidden="true">☾</span>
        {active && (
          <span className="ml-1 text-xs tabular-nums">
            {remaining !== null ? countdown(remaining) : 'on'}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-64 bg-surface border border-white/10 rounded-lg shadow-xl z-50 p-2 text-left">
          <p className="px-2 py-1 text-xs text-gray-500">
            The server stops the music, so this also works with the app closed.
          </p>
          <div className="grid grid-cols-3 gap-1 px-1 py-1">
            {PRESETS.map((minutes) => (
              <button
                key={minutes}
                type="button"
                onClick={() => set('in', minutes)}
                className="min-h-[36px] text-sm bg-surface-light rounded hover:bg-white/10 transition"
              >
                {minutes}m
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => set('endOfTrack')}
            className="w-full text-left px-2 py-1.5 text-sm hover:bg-surface-light rounded transition"
          >
            After this track
          </button>
          <button
            type="button"
            onClick={() => set('endOfAlbum')}
            className="w-full text-left px-2 py-1.5 text-sm hover:bg-surface-light rounded transition"
          >
            After this album
          </button>
          <button
            type="button"
            onClick={() => set('endOfQueue')}
            className="w-full text-left px-2 py-1.5 text-sm hover:bg-surface-light rounded transition"
          >
            After the queue
          </button>
          {active && (
            <button
              type="button"
              onClick={cancel}
              className="w-full text-left px-2 py-1.5 text-sm text-red-400 hover:bg-surface-light rounded transition"
            >
              Cancel the timer
            </button>
          )}
          {timer && <p className="px-2 pt-2 text-xs text-gray-500">{timer.description}</p>}
          {note && <p className="px-2 pt-1 text-xs text-amber-500/80">{note}</p>}
        </div>
      )}
    </div>
  );
}
