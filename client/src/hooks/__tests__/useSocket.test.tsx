import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSocket } from '../useSocket.js';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const socket = {
    disconnect: vi.fn(),
    emit: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
      return socket;
    }),
  };
  return { listeners, socket, io: vi.fn(() => socket) };
});

vi.mock('socket.io-client', () => ({ io: mocks.io }));

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
});
