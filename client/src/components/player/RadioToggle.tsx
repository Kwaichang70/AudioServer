import { useAudioContext } from '../../context/AudioContext.js';

/**
 * Radio on/off for this room (R08.1), in the player. On, the server keeps the
 * queue going with related music from the library once it runs low.
 */
export default function RadioToggle({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  const { radio, setRadioEnabled } = useAudioContext();
  const on = radio?.enabled === true;
  const label = on
    ? `Radio on${radio?.seed ? ` · from ${radio.seed.label}` : ''}`
    : 'Radio off: the music stops when the queue ends';
  return (
    <button
      type="button"
      onClick={() => void setRadioEnabled(!on).catch(() => {})}
      aria-pressed={on}
      aria-label={on ? 'Radio on' : 'Radio off'}
      title={label}
      className={`shrink-0 rounded-full border px-2 py-0.5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        size === 'lg' ? 'text-sm' : 'text-[11px]'
      } ${on ? 'border-accent text-accent' : 'border-white/15 text-gray-500 hover:text-white'}`}
    >
      Radio
    </button>
  );
}

/** Why radio chose the track that is playing, if radio chose it. */
export function useRadioReason(trackId: string | undefined): string | null {
  const { radio } = useAudioContext();
  if (!trackId || !radio) return null;
  return radio.reasons[trackId] ?? null;
}
