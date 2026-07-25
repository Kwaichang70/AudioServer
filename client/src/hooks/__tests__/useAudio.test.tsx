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
});
