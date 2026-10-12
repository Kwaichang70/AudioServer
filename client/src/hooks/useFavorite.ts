import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../api/client.js';

/**
 * One shared set of favourites per type (R06.3). A list of a hundred rows
 * asks the server once for all favourite ids instead of once per row, and a
 * heart toggled in the player bar is the same heart in the queue, the album
 * page and the search results.
 */

export type FavoriteKind = 'track' | 'album' | 'artist';

interface Store {
  ids: Set<string>;
  state: 'idle' | 'loading' | 'ready';
  listeners: Set<() => void>;
  version: number;
}

const stores = new Map<FavoriteKind, Store>();

function store(kind: FavoriteKind): Store {
  let s = stores.get(kind);
  if (!s) {
    s = { ids: new Set(), state: 'idle', listeners: new Set(), version: 0 };
    stores.set(kind, s);
  }
  return s;
}

function emit(s: Store) {
  s.version += 1;
  s.listeners.forEach((listener) => listener());
}

function load(kind: FavoriteKind) {
  const s = store(kind);
  if (s.state !== 'idle') return;
  s.state = 'loading';
  Promise.resolve()
    .then(() => api.getFavoriteIds(kind))
    .then((res) => {
      s.ids = new Set(res.data ?? []);
      s.state = 'ready';
      emit(s);
    })
    .catch(() => {
      // Try again on the next list that needs it.
      s.state = 'idle';
    });
}

/** Tell the store about a toggle made elsewhere (a menu, a page header). */
export function noteFavorite(kind: FavoriteKind, id: string, favorited: boolean): void {
  const s = store(kind);
  if (favorited) s.ids.add(id);
  else s.ids.delete(id);
  emit(s);
}

/** Forget everything (sign-out, tests). */
export function resetFavorites(): void {
  stores.clear();
}

/** Library ids only: a Qobuz, Spotify or radio item cannot be a favourite. */
export const PROVIDER_PREFIX = /^(?:spotify|qobuz|tidal|radio):/;

export function useFavorite(kind: FavoriteKind, id: string): [boolean, () => Promise<void>] {
  const s = store(kind);
  useEffect(() => load(kind), [kind]);
  const favorited = useSyncExternalStore(
    (listener) => {
      s.listeners.add(listener);
      return () => s.listeners.delete(listener);
    },
    () => s.ids.has(id),
  );

  const toggle = async () => {
    const res = await api.toggleFavorite(kind, id);
    noteFavorite(kind, id, res.data.favorited);
  };
  return [favorited, toggle];
}
