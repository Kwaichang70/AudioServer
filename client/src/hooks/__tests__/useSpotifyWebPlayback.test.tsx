import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSpotifyWebPlayback } from '../useSpotifyWebPlayback';

// Mock the api client so the hook's token fetch resolves without a network call.
vi.mock('../../api/client.js', () => ({
  api: { spotifyToken: vi.fn().mockResolvedValue({ data: { accessToken: 'tok', expiresAt: 0 } }) },
}));

type Listener = (payload: unknown) => void;

// A fake Spotify.Player that records its listeners so the test can fire events.
function installFakeSdk() {
  const listeners = new Map<string, Listener>();
  const player = {
    connect: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn(),
    addListener: vi.fn((event: string, cb: Listener) => {
      listeners.set(event, cb);
      return true;
    }),
    pause: vi.fn(),
    resume: vi.fn(),
    togglePlay: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
  };
  // Must be a real function (not an arrow) so it works with `new`.
  const PlayerCtor = vi.fn(function PlayerCtor() {
    return player;
  });
  (window as unknown as { Spotify: unknown }).Spotify = { Player: PlayerCtor };
  return { player, listeners, PlayerCtor };
}

describe('useSpotifyWebPlayback', () => {
  beforeEach(() => {
    delete (window as unknown as { Spotify?: unknown }).Spotify;
    delete (window as unknown as { onSpotifyWebPlaybackSDKReady?: unknown })
      .onSpotifyWebPlaybackSDKReady;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('stays inert when disabled', () => {
    installFakeSdk();
    const { result } = renderHook(() => useSpotifyWebPlayback(false));
    expect(result.current.ready).toBe(false);
    expect(result.current.deviceId).toBeNull();
    expect((window.Spotify!.Player as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      0,
    );
  });

  it('connects and exposes the device id on ready', async () => {
    const { player, listeners } = installFakeSdk();
    const { result } = renderHook(() => useSpotifyWebPlayback(true));

    // SDK present synchronously → player created + connect() called.
    expect(player.connect).toHaveBeenCalled();

    act(() => {
      listeners.get('ready')?.({ device_id: 'abc123' });
    });

    await waitFor(() => {
      expect(result.current.ready).toBe(true);
      expect(result.current.deviceId).toBe('abc123');
    });
  });

  it('surfaces account_error (e.g. non-Premium) as error', async () => {
    const { listeners } = installFakeSdk();
    const { result } = renderHook(() => useSpotifyWebPlayback(true));

    act(() => {
      listeners.get('account_error')?.({ message: 'Premium required' });
    });

    await waitFor(() => expect(result.current.error).toBe('Premium required'));
  });
});
