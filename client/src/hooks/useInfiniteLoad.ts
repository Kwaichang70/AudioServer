import { useState, useCallback, useRef, useEffect } from 'react';

interface PaginatedResponse<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
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

  const loadPage = useCallback(async (pageNum: number, append: boolean) => {
    if (loadingRef.current) return;
    loadingRef.current = true;

    if (append) setLoadingMore(true); else setLoading(true);

    try {
      const res = await fetchRef.current(pageNum, limit);
      setItems((prev) => append ? [...prev, ...res.data] : res.data);
      setTotal(res.meta.total);
      setHasMore(pageNum < res.meta.totalPages);
      pageRef.current = pageNum;
    } catch {
      // Keep existing items on error
    }

    setLoading(false);
    setLoadingMore(false);
    loadingRef.current = false;
  }, [limit]);

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
