import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { resetFavorites } from '../hooks/useFavorite.js';
import { resetRatings } from '../hooks/useRating.js';
import type { ReactNode } from 'react';
import { api, ApiError, clearStreamToken, ensureStreamToken, onApiError } from '../api/client.js';
import type { UserAccount } from '../api/types.js';
import { STORAGE_KEYS } from '../constants.js';
import { shouldRenewToken } from '../utils/jwt.js';

/**
 * Single source of truth for "who is signed in" (V02.3).
 *
 * The app no longer guesses from a stored token or a stats request: it asks
 * GET /auth/setup-status and GET /auth/me. A token that the server no longer
 * accepts (expired, revoked, user deleted) yields `user: null`, so the login
 * screen appears even when localStorage still holds a value. Any later 401
 * from the API, or a socket that is closed because its session was revoked,
 * lands here too and flips the app back to the login screen.
 */

/**
 * `unreachable`: there is a login on this device, but the server did not
 * answer (offline, NAS restarting, 502/503). The login is kept and the app
 * keeps trying (B05); only the server saying "no such session" signs out.
 */
export type AuthStatus = 'loading' | 'setup' | 'anonymous' | 'authenticated' | 'unreachable';

export interface AuthState {
  status: AuthStatus;
  user: UserAccount | null;
  isAdmin: boolean;
  /** Store the token from login/register and load the account behind it. */
  signIn: (token: string) => Promise<void>;
  /** Revoke the session on the server and forget it locally. */
  signOut: () => Promise<void>;
  /** Forget the session locally (server already refused it). */
  forceSignOut: () => void;
  refresh: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | null>(null);

/** Window event other modules (useSocket) dispatch when the server refuses the session. */
export const SESSION_LOST_EVENT = 'audioserver:session-lost';
export const UNREACHABLE_RETRY_MS = 5000;

function hasLocalSession(): boolean {
  try {
    return !!localStorage.getItem(STORAGE_KEYS.authToken);
  } catch {
    return false;
  }
}

function clearLocalSession() {
  try {
    localStorage.removeItem(STORAGE_KEYS.authToken);
  } catch {
    // storage may be unavailable (private mode); nothing to clear then
  }
  clearStreamToken();
}

/**
 * Sliding renewal (V08.4): a phone that opens the app every week never hits
 * the 30-day hard expiry. Renewed only when less than a week is left, so the
 * server sees one refresh per week at most.
 */
async function maybeRenewToken(): Promise<void> {
  const token = localStorage.getItem(STORAGE_KEYS.authToken);
  if (!shouldRenewToken(token)) return;
  const renewed = await api.refreshSession();
  if (renewed.data?.token) localStorage.setItem(STORAGE_KEYS.authToken, renewed.data.token);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<UserAccount | null>(null);

  const refresh = useCallback(async () => {
    try {
      const setup = await api.getSetupStatus();
      if (setup.data.needsSetup) {
        clearLocalSession();
        setUser(null);
        setStatus('setup');
        return;
      }
    } catch {
      // Server unreachable or not ready: keep whatever we know, try /me anyway.
    }
    try {
      const me = await api.getMe();
      if (me.data) {
        setUser(me.data);
        setStatus('authenticated');
        ensureStreamToken().catch(() => {});
        maybeRenewToken().catch(() => {});
        return;
      }
      // The server answered: this login is not valid (any more).
    } catch (err) {
      // No answer, or a server error: that says nothing about the login.
      // Keep it and try again, unless the server said 401 (B05).
      const rejected = err instanceof ApiError && err.isUnauthorized;
      if (!rejected && hasLocalSession()) {
        setStatus('unreachable');
        return;
      }
    }
    clearLocalSession();
    setUser(null);
    setStatus('anonymous');
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Unreachable: try again every few seconds, and at once when the device
  // comes back online or the app comes to the foreground.
  useEffect(() => {
    if (status !== 'unreachable') return;
    const retry = () => void refresh();
    const timer = window.setInterval(retry, UNREACHABLE_RETRY_MS);
    const onVisible = () => document.visibilityState === 'visible' && retry();
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [status, refresh]);

  // Back to the foreground after a long sleep (phone in a pocket): renew the
  // token when it is about to expire. Playback state is resynced by the
  // socket layer (useSocket) at the same moment.
  useEffect(() => {
    if (status !== 'authenticated') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') maybeRenewToken().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [status]);

  const forceSignOut = useCallback(() => {
    clearLocalSession();
    // Favourites are personal (V09): the next person starts from their own.
    resetFavorites();
    resetRatings();
    setUser(null);
    setStatus('anonymous');
  }, []);

  // A 401 anywhere means the session is gone (revoked, expired, deleted).
  // Login/register 401s are the user's own typo and must not bounce them.
  useEffect(() => {
    if (status !== 'authenticated') return;
    return onApiError((err) => {
      if (err.isUnauthorized) forceSignOut();
    });
  }, [status, forceSignOut]);

  useEffect(() => {
    const handler = () => forceSignOut();
    window.addEventListener(SESSION_LOST_EVENT, handler);
    return () => window.removeEventListener(SESSION_LOST_EVENT, handler);
  }, [forceSignOut]);

  const signIn = useCallback(
    async (token: string) => {
      resetFavorites();
      resetRatings();
      localStorage.setItem(STORAGE_KEYS.authToken, token);
      clearStreamToken();
      await refresh();
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // the server may already consider the session dead; local cleanup still applies
    }
    forceSignOut();
  }, [forceSignOut]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      isAdmin: user?.role === 'admin',
      signIn,
      signOut,
      forceSignOut,
      refresh,
    }),
    [status, user, signIn, signOut, forceSignOut, refresh],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
