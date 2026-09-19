import { formatTime } from '../../utils/format.js';

/**
 * The seek bar both players share (R01.3).
 *
 * It used to be written twice, and both copies accepted a click on any output
 * — also on a speaker that cannot jump, where the bar moved and the music did
 * not. `disabledReason` turns it into a read-only progress bar that says why,
 * both to the eye (no pointer, dimmed thumb) and to a screen reader
 * (`aria-disabled` plus the reason as its description).
 */

interface Props {
  currentTime: number;
  duration: number;
  onSeek: (time: number) => void;
  /** When set, the bar shows progress only and this sentence explains why. */
  disabledReason?: string;
  size?: 'sm' | 'lg';
  /** Show the elapsed and total time under the bar. */
  showTimes?: boolean;
}

export default function SeekBar({
  currentTime,
  duration,
  onSeek,
  disabledReason,
  size = 'sm',
  showTimes = false,
}: Props) {
  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const disabled = !!disabledReason || duration <= 0;

  return (
    <div className="w-full">
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentTime)}
        aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
        aria-disabled={disabled || undefined}
        title={disabledReason}
        className={`relative ${size === 'lg' ? 'h-1.5' : 'h-1'} bg-white/10 rounded-full group focus:outline-none focus:ring-1 focus:ring-accent ${
          disabled ? 'cursor-default' : 'cursor-pointer'
        }`}
        onClick={(e) => {
          if (disabled) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const pos = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
          onSeek(pos * duration);
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          // Arrow keys scrub ±5 s; Home/End jump to the start and the end.
          if (e.key === 'ArrowRight') onSeek(Math.min(duration, currentTime + 5));
          else if (e.key === 'ArrowLeft') onSeek(Math.max(0, currentTime - 5));
          else if (e.key === 'Home') onSeek(0);
          else if (e.key === 'End') onSeek(duration);
          else return;
          e.preventDefault();
        }}
      >
        <div
          className="absolute left-0 top-0 h-full bg-accent rounded-full"
          style={{ width: `${progress}%` }}
        />
        {!disabled && (
          <div
            className={`absolute top-1/2 -translate-y-1/2 ${size === 'lg' ? 'w-3 h-3' : 'w-2.5 h-2.5'} bg-white rounded-full opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition`}
            style={{ left: `${progress}%`, marginLeft: size === 'lg' ? '-6px' : '-5px' }}
          />
        )}
      </div>
      {showTimes && (
        <div className="flex justify-between text-xs text-gray-500 mt-1 tabular-nums">
          <span>{formatTime(currentTime)}</span>
          {disabledReason ? (
            <span className="truncate px-2 text-gray-600">{disabledReason}</span>
          ) : null}
          <span>{formatTime(duration)}</span>
        </div>
      )}
    </div>
  );
}

/** Why the current output cannot seek, or undefined when it can (or might). */
export function seekDisabledReason(
  seekSupport: 'supported' | 'unsupported' | 'unknown',
  trackId: string | undefined,
): string | undefined {
  if (seekSupport === 'unsupported') return 'This output cannot jump inside a track';
  if (trackId?.startsWith('spotify:')) return 'Spotify tracks are steered from Spotify';
  return undefined;
}
