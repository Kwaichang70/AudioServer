import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import type { AlbumFacets } from '../api/types.js';
import { focusQueryString } from '../utils/focus.js';

/**
 * The Focus state of a library page (R05.2): read from and written to the
 * URL, plus the facet counts for the current query.
 *
 * Every change is a history entry, so the back button undoes a filter —
 * the same as it would on any web shop.
 */
export function useFocus() {
  const [params, setParams] = useSearchParams();
  const query = focusQueryString(params);
  const [facets, setFacets] = useState<AlbumFacets | null>(null);

  const update = useCallback(
    (change: (params: URLSearchParams) => URLSearchParams) => setParams((prev) => change(prev)),
    [setParams],
  );

  useEffect(() => {
    let cancelled = false;
    api
      .getAlbumFacets(query)
      .then((res) => {
        if (!cancelled) setFacets(res.data);
      })
      .catch(() => {
        // Without counts the panel still works; chips just show no numbers.
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  // Ids that chips show by name: composers and tags.
  const composerNames = useMemo(
    () =>
      Object.fromEntries(
        [...(facets?.composer ?? []), ...(facets?.tag ?? [])].map((c) => [c.value, c.name]),
      ),
    [facets],
  );

  return { params, query, update, facets, composerNames };
}

export type FocusHandle = ReturnType<typeof useFocus>;

/**
 * A new question is a new list: start paging over when the query changes.
 * Not a remount — that would close the Focus panel on every tap.
 */
export function useReloadOnQuery(query: string, reload: () => void) {
  const seen = useRef(query);
  useEffect(() => {
    if (seen.current === query) return;
    seen.current = query;
    reload();
  }, [query, reload]);
}
