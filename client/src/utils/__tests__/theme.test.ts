import { describe, expect, it } from 'vitest';
import { resolveTheme } from '../theme.js';

// R00.2: before this, the stored theme was applied only by the Settings page,
// so a cold start anywhere else showed dark whatever the user had chosen.
describe('resolveTheme', () => {
  it('uses the stored choice', () => {
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('oled', true)).toBe('oled');
    expect(resolveTheme('dark', true)).toBe('dark');
  });

  it('falls back to the operating system when nothing is stored', () => {
    expect(resolveTheme(null, true)).toBe('light');
    expect(resolveTheme(null, false)).toBe('dark');
  });

  it('ignores a stored value it does not know', () => {
    expect(resolveTheme('solarized', true)).toBe('light');
    expect(resolveTheme('', false)).toBe('dark');
  });
});
