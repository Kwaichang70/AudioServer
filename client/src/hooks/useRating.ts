import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../api/client.js';

/**
 * Your ratings (R06.4), one shared map per type — like the hearts of R06.3:
 * one request fills a whole list, and stars set anywhere show everywhere.
 */

export type RatingKind = 'track' | 'album';

interface Store {
  ratings: Map<string, number>;
  state: 'idle' | 'loading' | 'ready';
  listeners: Set<() => void>;
}

const stores = new Map<RatingKind, Store>();

function store(kind: RatingKind): Store {
  let s = stores.get(kind);
  if (!s) {
    s = { ratings: new Map(), state: 'idle', listeners: new Set() };
    stores.set(kind, s);
  }
  return s;
}

const emit = (s: Store) => s.listeners.forEach((listener) => listener());

function load(kind: RatingKind) {
  const s = store(kind);
  if (s.state !== 'idle') return;
  s.state = 'loading';
  Promise.resolve()
    .then(() => api.getRatings(kind))
    .then((res) => {
      s.ratings = new Map(Object.entries(res.data ?? {}));
      s.state = 'ready';
      emit(s);
    })
    .catch(() => {
      s.state = 'idle';
    });
}

/** Forget everything (sign-in, sign-out, tests). */
export function resetRatings(): void {
  stores.clear();
}

export function useRating(
  kind: RatingKind,
  id: string,
): [number | null, (rating: number | null) => Promise<void>] {
  const s = store(kind);
  useEffect(() => load(kind), [kind]);
  const rating = useSyncExternalStore(
    (listener) => {
      s.listeners.add(listener);
      return () => s.listeners.delete(listener);
    },
    () => s.ratings.get(id) ?? null,
  );
  const set = async (next: number | null) => {
    await api.setRating(kind, id, next);
    if (next === null) s.ratings.delete(id);
    else s.ratings.set(id, next);
    emit(s);
  };
  return [rating, set];
}
