import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';

/**
 * The heart for whatever is playing (R01.3). Only library tracks can be a
 * favorite — a Qobuz, Spotify or radio item has no library id to store — so
 * for those the button is not shown rather than shown and failing.
 */

const PROVIDER_PREFIX = /^(?:spotify|qobuz|tidal|radio):/;

interface Props {
  trackId: string;
  title: string;
  size?: 'sm' | 'lg';
}

export default function FavoriteTrackButton({ trackId, title, size = 'sm' }: Props) {
  const [favorited, setFavorited] = useState(false);
  const isLibraryTrack = !PROVIDER_PREFIX.test(trackId);

  useEffect(() => {
    if (!isLibraryTrack) return;
    let cancelled = false;
    setFavorited(false);
    api
      .checkFavorite('track', trackId)
      .then((res) => {
        if (!cancelled) setFavorited(res.data.favorited);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [trackId, isLibraryTrack]);

  if (!isLibraryTrack) return null;

  const toggle = async () => {
    try {
      const res = await api.toggleFavorite('track', trackId);
      setFavorited(res.data.favorited);
    } catch {
      // The global toast layer reports the server's answer.
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={favorited}
      aria-label={favorited ? `Remove ${title} from favorites` : `Add ${title} to favorites`}
      title={favorited ? 'Remove from favorites' : 'Add to favorites'}
      className={`shrink-0 leading-none transition ${size === 'lg' ? 'text-2xl' : 'text-lg'} ${
        favorited ? 'text-accent' : 'text-gray-500 hover:text-accent'
      }`}
    >
      {favorited ? '♥' : '♡'}
    </button>
  );
}
