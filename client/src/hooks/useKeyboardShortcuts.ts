import { useEffect } from 'react';
import { useAudioContext } from '../context/AudioContext.js';

/**
 * Controls that answer Space, Enter or arrow keys themselves. A key pressed
 * on one of these is theirs: Space must press the focused button or tab, not
 * pause the music (U02).
 */
const OWNS_KEYS =
  'button, a[href], summary, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"], [role="radio"], [role="slider"], [role="listbox"], [role="combobox"]';

/** Is this key press a player shortcut, or does it belong to what has focus? */
export function isGlobalShortcut(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return false; // something handled it already
  if (e.ctrlKey || e.metaKey || e.altKey) return false; // browser and system shortcuts
  const target = e.target as HTMLElement | null;
  if (!target || !(target instanceof HTMLElement)) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
    return false;
  }
  const native = e.key === ' ' || e.key === 'Enter' || e.key.startsWith('Arrow');
  if (native && target.closest(OWNS_KEYS)) return false;
  // Holding Space down must not toggle play/pause over and over.
  if (e.key === ' ' && e.repeat) return false;
  return true;
}

export function useKeyboardShortcuts() {
  const {
    isPlaying,
    pause,
    resume,
    playNext,
    playPrevious,
    volume,
    setVolume,
    toggleShuffle,
    toggleRepeat,
  } = useAudioContext();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isGlobalShortcut(e)) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          isPlaying ? pause() : resume();
          break;
        case 'ArrowRight':
          if (e.shiftKey) {
            playNext();
          }
          break;
        case 'ArrowLeft':
          if (e.shiftKey) {
            playPrevious();
          }
          break;
        case 'ArrowUp':
          if (e.shiftKey) {
            e.preventDefault();
            setVolume(Math.min(1, volume + 0.05));
          }
          break;
        case 'ArrowDown':
          if (e.shiftKey) {
            e.preventDefault();
            setVolume(Math.max(0, volume - 0.05));
          }
          break;
        case 'm':
        case 'M':
          setVolume(volume > 0 ? 0 : 0.7);
          break;
        case 's':
        case 'S':
          if (!e.ctrlKey && !e.metaKey) toggleShuffle();
          break;
        case 'r':
        case 'R':
          if (!e.ctrlKey && !e.metaKey) toggleRepeat();
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    isPlaying,
    pause,
    resume,
    playNext,
    playPrevious,
    volume,
    setVolume,
    toggleShuffle,
    toggleRepeat,
  ]);
}
