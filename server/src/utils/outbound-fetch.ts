/** How long a request to an outside service may take, headers and body together. */
export const OUTBOUND_TIMEOUT_MS = 15_000;

/**
 * `fetch` for every request the server makes to somebody else's service
 * (Qobuz, Spotify, Tidal, Last.fm, ListenBrainz, lyrics, cover sources).
 *
 * Plain `fetch` has no time limit of its own: a host that accepts the
 * connection and then says nothing held the request, and whatever waited for
 * it, for minutes (S06). The limit covers reading the body too. A signal the
 * caller passes still works; whichever fires first ends the request.
 */
export function outboundFetch(
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  timeoutMs: number = OUTBOUND_TIMEOUT_MS,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
}
