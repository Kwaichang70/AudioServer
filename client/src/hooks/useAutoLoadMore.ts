import { useEffect, useRef } from 'react';

/**
 * Returns a ref to attach to a sentinel <div> at the bottom of a paginated
 * list. When that sentinel scrolls into view (or within `rootMargin` of the
 * viewport), `loadMore` fires. Bail-out conditions:
 *   - `hasMore` is false: nothing left to load, observer is never attached.
 *   - sentinel unmounts: observer auto-disconnects via the cleanup.
 *
 * Use this together with useInfiniteLoad to replace a manual "Load More"
 * button with infinite scrolling — keep the button visible too as a
 * fallback for browsers without IntersectionObserver / accessibility users.
 */
export function useAutoLoadMore(loadMore: () => void, hasMore: boolean, rootMargin = '400px') {
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Mirror loadMore in a ref so the effect doesn't tear down + reattach the
  // observer on every render (loadMore from useInfiniteLoad is stable, but
  // we don't want to rely on that contract).
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
