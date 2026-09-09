import { describe, expect, it } from 'vitest';
import { parseTrustProxy } from '../config.js';

describe('parseTrustProxy', () => {
  it('maps env strings to Express trust proxy values', () => {
    expect(parseTrustProxy('loopback')).toBe('loopback');
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('10.0.0.1, 192.168.2.0/24')).toBe('10.0.0.1, 192.168.2.0/24');
  });
});
