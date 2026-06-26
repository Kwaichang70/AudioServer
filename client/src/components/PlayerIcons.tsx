// Bold, solid media-transport icons. Hand-rolled SVGs (no icon-library
// dependency) so the player controls have a consistent heavy weight across
// platforms — the previous Unicode glyphs (▶ ⏸ 🔀) rendered thin and varied
// per OS/font. Every icon inherits its colour from `currentColor`, so the
// existing Tailwind text-* classes (active/hover states) keep working.

import type { ReactNode } from 'react';

interface IconProps {
  /** Pixel size for both width and height. */
  size?: number;
  className?: string;
}

function Icon({ size = 24, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 5.27c0-.97 1.05-1.57 1.89-1.08l11.51 6.73c.83.49.83 1.69 0 2.18L8.89 19.81C8.05 20.3 7 19.7 7 18.73V5.27Z" />
    </Icon>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5.5" y="4" width="4.5" height="16" rx="1.4" />
      <rect x="14" y="4" width="4.5" height="16" rx="1.4" />
    </Icon>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </Icon>
  );
}

export function PrevIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5" y="5" width="2.6" height="14" rx="1.1" />
      <path d="M19 6.3v11.4c0 .92-1.02 1.47-1.79.96l-8.43-5.7a1.15 1.15 0 0 1 0-1.92l8.43-5.7c.77-.51 1.79.04 1.79.96Z" />
    </Icon>
  );
}

export function NextIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 6.3v11.4c0 .92 1.02 1.47 1.79.96l8.43-5.7a1.15 1.15 0 0 0 0-1.92l-8.43-5.7C6.02 4.83 5 5.38 5 6.3Z" />
      <rect x="16.4" y="5" width="2.6" height="14" rx="1.1" />
    </Icon>
  );
}

export function ShuffleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M16.5 4.5 19.8 7l-3.3 2.5V8h-1.3c-1.1 0-2 .5-2.7 1.4L11 10.6l-1.3-1.7.3-.4C11.1 7.1 12.7 6.4 14.5 6h.7V4.5ZM4 7.7h2.7c1.8.4 3.4 1.1 4.5 2.6l4.6 6h1.7v-1.5l3.3 2.5-3.3 2.5v-1.5h-2.9c-1.1 0-2-.5-2.7-1.4l-4.6-6c-.7-.9-1.6-1.4-2.7-1.4H4V7.7ZM16.5 14.4l3.3 2.5-3.3 2.5v-1.5h-.7c-.3 0-.6 0-.9-.1l1.2-1.6c.1 0 .3 0 .4 0Z" />
    </Icon>
  );
}

export function RepeatIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 7h9V4.8c0-.5.6-.8 1-.5l3.7 2.9c.3.2.3.7 0 .9L17 11c-.4.3-1 0-1-.5V8H7c-1.1 0-2 .9-2 2v1.5c0 .4-.3.7-.7.7H3.7a.7.7 0 0 1-.7-.7V10a4 4 0 0 1 4-3Zm10 10H8v2.2c0 .5-.6.8-1 .5l-3.7-2.9a.6.6 0 0 1 0-.9L7 13c.4-.3 1 0 1 .5V16h9c1.1 0 2-.9 2-2v-1.5c0-.4.3-.7.7-.7h.6c.4 0 .7.3.7.7V14a4 4 0 0 1-4 3Z" />
    </Icon>
  );
}

export function RepeatOneIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 7h9V4.8c0-.5.6-.8 1-.5l3.7 2.9c.3.2.3.7 0 .9L17 11c-.4.3-1 0-1-.5V8H7c-1.1 0-2 .9-2 2v1.5c0 .4-.3.7-.7.7H3.7a.7.7 0 0 1-.7-.7V10a4 4 0 0 1 4-3Zm10 10H8v2.2c0 .5-.6.8-1 .5l-3.7-2.9a.6.6 0 0 1 0-.9L7 13c.4-.3 1 0 1 .5V16h9c1.1 0 2-.9 2-2v-1.5c0-.4.3-.7.7-.7h.6c.4 0 .7.3.7.7V14a4 4 0 0 1-4 3Z" />
      <path d="M11.6 9.6h1.3v4.8h-1.2v-3.6l-.9.3-.3-1 1.1-.5Z" />
    </Icon>
  );
}

export function VolumeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 9.5h3l4-3.4c.6-.5 1.5-.1 1.5.7v10.4c0 .8-.9 1.2-1.5.7l-4-3.4H4c-.6 0-1-.4-1-1v-3c0-.6.4-1 1-1Z" />
      <path d="M15.5 8.8c1.3.7 2.2 2 2.2 3.7s-.9 3-2.2 3.7v-1.7c.5-.5.8-1.2.8-2s-.3-1.5-.8-2V8.8ZM15.5 5.2c2.6.9 4.5 3.4 4.5 6.3s-1.9 5.4-4.5 6.3v-1.6c1.8-.8 3-2.6 3-4.7s-1.2-3.9-3-4.7V5.2Z" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.7 8.5 12 14.8l6.3-6.3 1.4 1.4-7 7c-.4.4-1 .4-1.4 0l-7-7 1.4-1.4Z" />
    </Icon>
  );
}

export function SpinnerIcon({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`animate-spin ${className ?? ''}`}
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        opacity="0.25"
      />
      <path
        d="M12 3a9 9 0 0 1 9 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
