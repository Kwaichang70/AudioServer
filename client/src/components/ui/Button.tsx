import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * The button shapes this app uses (R02.3). Three variants, because that is
 * what the screens actually contain: the one accent action, a bordered
 * secondary, and a quiet one that only shows on hover or focus.
 *
 * `buttonClasses` is exported separately so a `<Link>` can look like a button
 * without an anchor pretending to be one.
 */

export type ButtonVariant = 'accent' | 'outline' | 'ghost';
export type ButtonSize = 'sm' | 'md';

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-full font-medium transition ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ' +
  'disabled:opacity-40 disabled:cursor-not-allowed';

const VARIANTS: Record<ButtonVariant, string> = {
  // `bg-accent` also sets accent-safe letters (see index.css), so this stays
  // readable in every theme without naming a text colour here.
  accent: 'bg-accent hover:bg-accent-hover',
  outline: 'border border-white/20 hover:border-accent',
  ghost: 'text-gray-400 hover:text-white hover:bg-white/10',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
};

export function buttonClasses(variant: ButtonVariant = 'outline', size: ButtonSize = 'md'): string {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]}`;
}

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

export default function Button({
  variant = 'outline',
  size = 'md',
  className = '',
  type = 'button',
  children,
  ...rest
}: Props) {
  return (
    <button type={type} className={`${buttonClasses(variant, size)} ${className}`} {...rest}>
      {children}
    </button>
  );
}
