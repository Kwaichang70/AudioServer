import type { ReactNode } from 'react';

/**
 * A small pill (R02.3): a filter that is on or off, a label, a source badge.
 * `pressed` makes it a toggle for a screen reader as well as for the eye,
 * which the hand-rolled filter pills in search did not do.
 */

interface Props {
  children: ReactNode;
  /** Present = the chip is a toggle; true = it is on. */
  pressed?: boolean;
  onClick?: () => void;
  title?: string;
  className?: string;
}

export default function Chip({ children, pressed, onClick, title, className = '' }: Props) {
  const tone = pressed
    ? 'bg-accent border-accent'
    : 'bg-surface-dark border-white/10 text-gray-400 hover:border-accent hover:text-white';

  if (!onClick) {
    return (
      <span
        title={title}
        className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs ${tone} ${className}`}
      >
        {children}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={pressed}
      className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${tone} ${className}`}
    >
      {children}
    </button>
  );
}
