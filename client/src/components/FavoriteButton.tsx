import { PROVIDER_PREFIX, useFavorite, type FavoriteKind } from '../hooks/useFavorite.js';

/**
 * The heart (R06.3), the same on every row: player bar, full screen, search,
 * queue, playlists, Focus lists. Backed by one shared store, so toggling it
 * anywhere updates it everywhere. Not shown for items without a library id.
 */
interface Props {
  kind: FavoriteKind;
  id: string;
  /** What the heart is for, for a screen reader: "Pink Moon". */
  title: string;
  size?: 'sm' | 'lg';
  className?: string;
  /** -1 inside a roving-tabindex grid, where the card is the tab stop. */
  tabIndex?: number;
}

export default function FavoriteButton({
  kind,
  id,
  title,
  size = 'sm',
  className = '',
  tabIndex,
}: Props) {
  if (!id || PROVIDER_PREFIX.test(id)) return null;
  return (
    <Heart
      kind={kind}
      id={id}
      title={title}
      size={size}
      className={className}
      tabIndex={tabIndex}
    />
  );
}

function Heart({ kind, id, title, size, className, tabIndex }: Props) {
  const [favorited, toggle] = useFavorite(kind, id);
  return (
    <button
      type="button"
      onClick={(event) => {
        // Rows play on click; the heart must not.
        event.stopPropagation();
        void toggle().catch(() => {
          // The global toast layer reports the server's answer.
        });
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
      }}
      tabIndex={tabIndex}
      aria-pressed={favorited}
      aria-label={favorited ? `Remove ${title} from favorites` : `Add ${title} to favorites`}
      title={favorited ? 'Remove from favorites' : 'Add to favorites'}
      className={`shrink-0 leading-none transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded ${
        size === 'lg' ? 'text-2xl' : 'text-lg'
      } ${favorited ? 'text-accent' : 'text-gray-500 hover:text-accent'} ${className}`}
    >
      {favorited ? '♥' : '♡'}
    </button>
  );
}
