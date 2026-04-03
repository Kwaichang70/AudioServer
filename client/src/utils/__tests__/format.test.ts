import { describe, it, expect } from 'vitest';
import { formatDuration, formatTime, formatQuality } from '../format';

describe('formatDuration', () => {
  it('formats seconds to M:SS', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(30)).toBe('0:30');
    expect(formatDuration(3661)).toBe('1:01:01');
  });

  it('handles undefined and NaN', () => {
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(NaN)).toBe('');
  });

  it('handles large values', () => {
    expect(formatDuration(7200)).toBe('2:00:00');
  });
});

describe('formatTime', () => {
  it('formats playback time', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(90)).toBe('1:30');
    expect(formatTime(3599)).toBe('59:59');
  });

  it('handles falsy values', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(NaN)).toBe('0:00');
  });
});

describe('formatQuality', () => {
  it('formats full quality info', () => {
    expect(formatQuality({ format: 'flac', sampleRate: 44100, bitDepth: 16 }))
      .toBe('FLAC / 44.1kHz / 16bit');
  });

  it('formats partial info', () => {
    expect(formatQuality({ format: 'mp3' })).toBe('MP3');
    expect(formatQuality({ sampleRate: 96000, bitDepth: 24 })).toBe('96.0kHz / 24bit');
  });

  it('handles empty', () => {
    expect(formatQuality({})).toBe('');
  });
});
