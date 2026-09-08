import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, clearStreamToken, ensureStreamToken, onApiError } from '../api/client.js';
import type { UserAccount } from '../api/types.js';
import { STORAGE_KEYS } from '../constants.js';

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

export type AuthStatus = 'loading' | 'setup' | 'anonymous' | 'authenticated';

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

function clearLocalSession() {
  try {
    localStorage.removeItem(STORAGE_KEYS.authToken);
  } catch {
    // storage may be unavailable (private mode); nothing to clear then
  }
  clearStreamToken();
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
        return;
      }
    } catch {
      // fall through: treat as signed out
    }
    clearLocalSession();
    setUser(null);
    setStatus('anonymous');
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const forceSignOut = useCallback(() => {
    clearLocalSession();
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
