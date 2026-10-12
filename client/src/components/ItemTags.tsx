import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import type { Tag, TagItemType } from '../api/types.js';

/**
 * The tags you can see on one album or artist, as chips (R06.2). Shows
 * nothing when there are none; follows tagging done elsewhere on the page.
 */
export default function ItemTags({ type, id }: { type: TagItemType; id: string }) {
  const [tags, setTags] = useState<Tag[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      // Through a promise, so a missing endpoint (an old server) is a quiet no-op.
      Promise.resolve()
        .then(() => api.getTagsOn(type, id))
        .then((res) => {
          if (!cancelled) setTags(res.data ?? []);
        })
        .catch(() => {});
    };
    load();
    window.addEventListener('audioserver:tags-changed', load);
    return () => {
      cancelled = true;
      window.removeEventListener('audioserver:tags-changed', load);
    };
  }, [type, id]);

  if (tags.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2" aria-label="Tags">
      {tags.map((tag) => (
        <li key={tag.id}>
          <Link
            to={`/tags/${tag.id}`}
            className="inline-flex items-center rounded-full border border-white/10 bg-surface-dark px-3 py-1 text-xs text-gray-300 hover:border-accent hover:text-white"
            title={tag.mine ? undefined : `Shared by ${tag.ownerName ?? 'someone'}`}
          >
            # {tag.name}
          </Link>
        </li>
      ))}
    </ul>
  );
}
