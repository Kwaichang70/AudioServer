import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { Bookmark } from '../api/types.js';

/**
 * The listener's bookmarks (R05.3), kept fresh across the app: saving one in
 * the Focus panel announces it, and the sidebar listens.
 */
const CHANGED = 'audioserver:bookmarks-changed';

export function notifyBookmarksChanged(): void {
  window.dispatchEvent(new Event(CHANGED));
}

export function useBookmarks() {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await api.getBookmarks();
      setBookmarks(res.data ?? []);
    } catch {
      // No bookmarks shown is better than a broken sidebar.
    }
  }, []);

  useEffect(() => {
    void load();
    window.addEventListener(CHANGED, load);
    return () => window.removeEventListener(CHANGED, load);
  }, [load]);

  const remove = useCallback(async (id: string) => {
    await api.deleteBookmark(id);
    notifyBookmarksChanged();
  }, []);

  return { bookmarks, remove };
}

/** Where a bookmark opens: its page with its question. */
export const bookmarkHref = (b: Bookmark) => (b.query ? `${b.path}?${b.query}` : b.path);
