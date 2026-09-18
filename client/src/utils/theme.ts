import { STORAGE_KEYS } from '../constants.js';

export type Theme = 'dark' | 'light' | 'oled';

export const THEMES: Theme[] = ['dark', 'light', 'oled'];

function isTheme(value: string | null): value is Theme {
  return value === 'dark' || value === 'light' || value === 'oled';
}

/**
 * Which theme this browser should show (R00.2): the choice the user stored,
 * and without one the theme the operating system asks for. Until now the
 * stored theme was only applied inside the Settings page, so anyone who
 * opened the app anywhere else saw dark regardless of what they picked.
 */
export function resolveTheme(stored: string | null, prefersLight: boolean): Theme {
  if (isTheme(stored)) return stored;
  return prefersLight ? 'light' : 'dark';
}

/** The stored theme, or the OS preference. Safe in private mode and in tests. */
export function readTheme(): Theme {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEYS.theme);
  } catch {
    // Storage can be blocked; the OS preference still gives a sane answer.
  }
  const prefersLight =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
      : false;
  return resolveTheme(stored, prefersLight);
}

/** Paint the document in `theme`. */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

/** Remember and apply the user's choice. */
export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEYS.theme, theme);
  } catch {
    // A theme that cannot be remembered still applies to this session.
  }
  applyTheme(theme);
}
