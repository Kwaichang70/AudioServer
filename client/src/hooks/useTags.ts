import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { Tag } from '../api/types.js';

/**
 * The tags you can see (R06.2), kept fresh across the app: tagging from a
 * menu or the tag page announces it, the sidebar listens.
 */
const CHANGED = 'audioserver:tags-changed';

export function notifyTagsChanged(): void {
  window.dispatchEvent(new Event(CHANGED));
}

export function useTags() {
  const [tags, setTags] = useState<Tag[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await api.getTags();
      setTags(res.data ?? []);
    } catch {
      // No tags shown is better than a broken sidebar.
    }
  }, []);

  useEffect(() => {
    void load();
    window.addEventListener(CHANGED, load);
    return () => window.removeEventListener(CHANGED, load);
  }, [load]);

  return { tags, reload: load };
}
