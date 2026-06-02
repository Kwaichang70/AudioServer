import { useState, useCallback, useRef, useEffect } from 'react';

interface PaginatedResponse<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

/**
 * Sentinel-based infinite scroll: ref to attach to a <div> at the bottom of
 * the list. When that sentinel scrolls into view (within `rootMargin` of the
 * viewport), `loadMore` fires.
 *
 * Lives here rather than in its own file so the runtime image on the NAS
 * (where `hooks/` was created root-owned by the docker build) doesn't need
 * a brand-new file written.
 *
 * Bail-out conditions:
 *   - hasMore is false: observer is never attached.
 *   - sentinel unmounts: cleanup disconnects the observer.
 *   - IntersectionObserver missing (old WebViews): no-op, the manual
 *     "Load More" button is still rendered as a fallback.
 */
export function useAutoLoadMore(loadMore: () => void, hasMore: boolean, rootMargin = '400px') {
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Mirror loadMore in a ref so the effect doesn't tear down + reattach the
  // observer on every render.
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;
    if (typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMoreRef.current();
      },
      { rootMargin },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, rootMargin]);

  return sentinelRef;
}

export function useInfiniteLoad<T>(
  fetchFn: (page: number, limit: number) => Promise<PaginatedResponse<T>>,
  limit = 50,
) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  const fetchRef = useRef(fetchFn);
  fetchRef.current = fetchFn;
  const pageRef = useRef(1);
  const loadingRef = useRef(false);

  const loadPage = useCallback(
    async (pageNum: number, append: boolean) => {
      if (loadingRef.current) return;
      loadingRef.current = true;

      if (append) setLoadingMore(true);
      else setLoading(true);

      try {
        const res = await fetchRef.current(pageNum, limit);
        setItems((prev) => (append ? [...prev, ...res.data] : res.data));
        setTotal(res.meta.total);
        setHasMore(pageNum < res.meta.totalPages);
        pageRef.current = pageNum;
      } catch {
        // Keep existing items on error
      }

      setLoading(false);
      setLoadingMore(false);
      loadingRef.current = false;
    },
    [limit],
  );

  useEffect(() => {
    loadPage(1, false);
  }, [loadPage]);

  const loadMore = useCallback(() => {
    if (loadingRef.current || !hasMore) return;
    loadPage(pageRef.current + 1, true);
  }, [loadPage, hasMore]);

  const reload = useCallback(() => {
    setItems([]);
    pageRef.current = 1;
    loadPage(1, false);
  }, [loadPage]);

  return { items, loading, loadingMore, total, hasMore, loadMore, reload };
}
