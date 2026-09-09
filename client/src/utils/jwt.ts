/**
 * Read the expiry of a JWT without verifying it (the server verifies). Used
 * only to decide when to ask for a renewed token (V08.4).
 */
export function jwtExpiresAt(token: string | null | undefined): number | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      atob(
        parts[1]
          .replace(/-/g, '+')
          .replace(/_/g, '/')
          .padEnd(Math.ceil(parts[1].length / 4) * 4, '='),
      ),
    ) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export const RENEW_WHEN_LEFT_MS = 7 * 24 * 60 * 60 * 1000;

/** True when the token expires within a week (or its expiry cannot be read). */
export function shouldRenewToken(token: string | null | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const exp = jwtExpiresAt(token);
  if (exp === null) return true;
  return exp - now < RENEW_WHEN_LEFT_MS;
}
