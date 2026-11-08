import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSocket } from '../useSocket.js';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const socket = {
    disconnect: vi.fn(),
    connect: vi.fn(),
    emit: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
      return socket;
    }),
  };
  return {
    listeners,
    socket,
    io: vi.fn((_opts?: unknown) => socket),
    getMe: vi.fn(),
  };
});

vi.mock('socket.io-client', () => ({ io: mocks.io }));
vi.mock('../../api/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client.js')>()),
  api: { getMe: mocks.getMe },
}));

describe('useSocket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    localStorage.clear();
  });

  it('keeps its API stable and re-subscribes after reconnect', () => {
    const { result, rerender } = renderHook(() => useSocket());
    const initialApi = result.current;

    rerender();
    expect(result.current).toBe(initialApi);

    act(() => result.current.subscribeDevice('device-1'));
    expect(mocks.socket.emit).toHaveBeenCalledWith('device:subscribe', 'device-1');

    mocks.socket.emit.mockClear();
    act(() => mocks.listeners.get('connect')?.());

    expect(result.current.connected).toBe(true);
    expect(mocks.socket.emit).toHaveBeenCalledWith('device:subscribe', 'device-1');

    const connectedApi = result.current;
    rerender();
    expect(result.current).toBe(connectedApi);
  });

  // ─── B06: a renewed token is used on reconnect ─────────────────────

  it('sends the token as it is at each (re)connect', () => {
    localStorage.setItem('audioserver_token', 'old');
    renderHook(() => useSocket());
    const auth = (mocks.io.mock.calls[0][0] as { auth: (cb: (v: unknown) => void) => void }).auth;
    const sent: unknown[] = [];
    auth((v) => sent.push(v));
    localStorage.setItem('audioserver_token', 'renewed');
    auth((v) => sent.push(v));
    expect(sent).toEqual([
      expect.objectContaining({ token: 'old' }),
      expect.objectContaining({ token: 'renewed' }),
    ]);
  });

  it('checks the login before signing out on a refused handshake', async () => {
    const lost = vi.fn();
    window.addEventListener('audioserver:session-lost', lost);
    renderHook(() => useSocket());
    // Still valid (the token was only renewed): connect again, stay signed in.
    mocks.getMe.mockResolvedValueOnce({ data: { id: 'u1' } });
    await act(async () => {
      mocks.listeners.get('connect_error')?.(new Error('authentication failed'));
    });
    expect(mocks.socket.connect).toHaveBeenCalled();
    expect(lost).not.toHaveBeenCalled();
    // Really gone: sign out.
    mocks.getMe.mockResolvedValueOnce({ data: null });
    await act(async () => {
      mocks.listeners.get('connect_error')?.(new Error('authentication failed'));
    });
    expect(lost).toHaveBeenCalledTimes(1);
    window.removeEventListener('audioserver:session-lost', lost);
  });
});
