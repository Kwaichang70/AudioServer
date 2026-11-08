import { randomBytes } from 'crypto';

/**
 * One "Connect" click = one OAuth transaction (ANALYSE_EN_VERBETERPLAN B04).
 *
 * The provider sends the browser back with `?code=…&state=…`. The state is a
 * random value this server made when the admin clicked Connect, bound to that
 * admin's session, the provider and the redirect URI, valid for ten minutes
 * and usable once. A callback whose state is missing, foreign, expired or
 * reused is refused before any code is exchanged, so a link someone else sent
 * cannot connect their account to this installation. Tidal's PKCE verifier
 * lives in the transaction too, so two connect attempts cannot overwrite each
 * other's.
 *
 * In memory: a restart in the middle of connecting means clicking Connect
 * again, which is fine.
 */

export class OAuthStateError extends Error {
  readonly code = 'oauth_state';
  constructor() {
    super(
      'This sign-in did not come from your own "Connect" click, has expired or was already used. Click Connect again.',
    );
    this.name = 'OAuthStateError';
  }
}

export interface OAuthTransaction {
  provider: string;
  owner: string;
  redirectUri: string;
  /** Tidal: the PKCE code verifier of this attempt. */
  verifier?: string;
  expiresAt: number;
}

const TTL_MS = 10 * 60_000;
const MAX_OPEN = 50;
const open = new Map<string, OAuthTransaction>();

function prune(now: number): void {
  for (const [state, tx] of open) if (tx.expiresAt <= now) open.delete(state);
  // A flood of Connect clicks cannot grow this without bound: oldest go first.
  while (open.size >= MAX_OPEN) open.delete(open.keys().next().value!);
}

/** Start one: the state to send to the provider. */
export function beginOAuth(
  provider: string,
  owner: string,
  redirectUri: string,
  verifier?: string,
  now = Date.now(),
): string {
  prune(now);
  const state = randomBytes(24).toString('base64url');
  open.set(state, { provider, owner, redirectUri, verifier, expiresAt: now + TTL_MS });
  return state;
}

/** Finish one: the transaction, used up; or OAuthStateError. */
export function finishOAuth(
  state: string | undefined,
  provider: string,
  owner: string,
  redirectUri: string,
  now = Date.now(),
): OAuthTransaction {
  const tx = state ? open.get(state) : undefined;
  if (state) open.delete(state); // once, whatever happens next
  if (
    !tx ||
    tx.expiresAt <= now ||
    tx.provider !== provider ||
    tx.owner !== owner ||
    tx.redirectUri !== redirectUri
  ) {
    throw new OAuthStateError();
  }
  return tx;
}

/** Tests only. */
export function clearOAuthTransactions(): void {
  open.clear();
}
