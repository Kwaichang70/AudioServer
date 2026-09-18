import { describe, expect, it } from 'vitest';
import { peekNextIndex } from '../queue.js';

// The browser prepares the next track (R00.1) only when it agrees with the
// server about what that is. These are the same cases as the server's
// peekNext: shuffle has no fixed answer, repeat decides the wrap.
describe('peekNextIndex', () => {
  it('walks forward through the queue', () => {
    expect(peekNextIndex(3, 0, false, 'off')).toBe(1);
    expect(peekNextIndex(3, 1, false, 'off')).toBe(2);
  });

  it('stops after the last track without repeat', () => {
    expect(peekNextIndex(3, 2, false, 'off')).toBeNull();
  });

  it('wraps to the start with repeat all', () => {
    expect(peekNextIndex(3, 2, false, 'all')).toBe(0);
  });

  it('stays on the same track with repeat one', () => {
    expect(peekNextIndex(3, 1, false, 'one')).toBe(1);
  });

  it('refuses an answer under shuffle', () => {
    expect(peekNextIndex(3, 0, true, 'off')).toBeNull();
    expect(peekNextIndex(3, 0, true, 'all')).toBeNull();
    expect(peekNextIndex(3, 0, true, 'one')).toBeNull();
  });

  it('has no answer for an empty queue or a position outside it', () => {
    expect(peekNextIndex(0, -1, false, 'all')).toBeNull();
    expect(peekNextIndex(3, -1, false, 'off')).toBeNull();
    expect(peekNextIndex(3, 3, false, 'off')).toBeNull();
  });
});
