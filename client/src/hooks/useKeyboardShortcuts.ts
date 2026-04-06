import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAudioContext } from '../context/AudioContext.js';

export function useKeyboardShortcuts() {
  const {
    isPlaying, pause, resume, playNext, playPrevious,
    volume, setVolume, toggleShuffle, toggleRepeat,
  } = useAudioContext();
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore when typing in inputs
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.target as HTMLElement).isContentEditable) return;

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
        case '/':
          e.preventDefault();
          navigate('/search');
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isPlaying, pause, resume, playNext, playPrevious, volume, setVolume, toggleShuffle, toggleRepeat, navigate]);
}
