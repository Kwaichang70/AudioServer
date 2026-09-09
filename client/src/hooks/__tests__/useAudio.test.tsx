import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAudio } from '../useAudio.js';

class FakeAudio extends EventTarget {
  currentSrc = '';
  currentTime = 0;
  duration = 0;
  paused = true;
  preload = '';
  src = '';
  volume = 1;

  play = vi.fn(async () => {
    this.paused = false;
  });

  pause = vi.fn(() => {
    this.paused = true;
  });
}

describe('useAudio', () => {
  beforeEach(() => {
    vi.stubGlobal('Audio', FakeAudio);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps its API identity stable until observable audio state changes', () => {
    const { result, rerender } = renderHook(() => useAudio());
    const initialApi = result.current;

    rerender();
    expect(result.current).toBe(initialApi);
    expect(result.current.isPaused()).toBe(true);

    act(() => result.current.play('/api/library/tracks/track-1/stream'));
    expect(result.current.isPaused()).toBe(false);

    act(() => result.current.setVolume(0.42));
    const updatedApi = result.current;
    expect(updatedApi).not.toBe(initialApi);
    expect(updatedApi.volume).toBe(0.42);

    rerender();
    expect(result.current).toBe(updatedApi);
  });

  it('turns a refused play() promise into a retryable blocked state, never a false "playing"', async () => {
    class BlockedAudio extends FakeAudio {
      play = vi.fn(() => {
        const err = new Error('play() failed because the user did not interact');
        err.name = 'NotAllowedError';
        return Promise.reject(err);
      });
    }
    vi.stubGlobal('Audio', BlockedAudio);
    const { result } = renderHook(() => useAudio());

    await act(async () => {
      result.current.play('/api/library/tracks/track-1/stream');
      await Promise.resolve();
    });
    expect(result.current.isPlaying).toBe(false);
    expect(result.current.playbackBlocked).toBe('autoplay');

    // The person presses play again: the state is cleared and play() retried.
    await act(async () => {
      result.current.resume();
      await Promise.resolve();
    });
    expect(result.current.isPlaying).toBe(false);
    expect(result.current.playbackBlocked).toBe('autoplay');
    expect(BlockedAudio.prototype.play).toBeUndefined();
  });
});
