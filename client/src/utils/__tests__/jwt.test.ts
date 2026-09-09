import { describe, expect, it } from 'vitest';
import { jwtExpiresAt, shouldRenewToken } from '../jwt.js';

function fakeJwt(exp: number): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: 'u', exp })}.sig`;
}

describe('jwt helpers (V08.4)', () => {
  it('reads the expiry and asks for renewal only in the last week', () => {
    const now = 1_800_000_000_000;
    const fresh = fakeJwt(Math.floor((now + 20 * 86_400_000) / 1000));
    const soon = fakeJwt(Math.floor((now + 3 * 86_400_000) / 1000));
    expect(jwtExpiresAt(fresh)).toBe(now + 20 * 86_400_000 - ((now + 20 * 86_400_000) % 1000));
    expect(shouldRenewToken(fresh, now)).toBe(false);
    expect(shouldRenewToken(soon, now)).toBe(true);
  });

  it('treats unreadable tokens as due for renewal and missing ones as nothing to do', () => {
    expect(jwtExpiresAt('garbage')).toBeNull();
    expect(shouldRenewToken('garbage')).toBe(true);
    expect(shouldRenewToken(null)).toBe(false);
  });
});
