import { PROVIDER_PREFIX } from '../hooks/useFavorite.js';
import { useRating, type RatingKind } from '../hooks/useRating.js';

/**
 * One to five stars (R06.4). A radio group for a screen reader; clicking the
 * star that is already set clears the rating. Not shown for items without a
 * library id.
 */
interface Props {
  kind: RatingKind;
  id: string;
  title: string;
  size?: 'sm' | 'lg';
  className?: string;
  /** A provider id that is in the library (an added Qobuz album, R07.1). */
  library?: boolean;
}

export default function RatingStars({
  kind,
  id,
  title,
  size = 'sm',
  className = '',
  library = false,
}: Props) {
  if (!id || (!library && PROVIDER_PREFIX.test(id))) return null;
  return <Stars kind={kind} id={id} title={title} size={size} className={className} />;
}

function Stars({ kind, id, title, size, className }: Required<Omit<Props, 'library'>>) {
  const [rating, setRating] = useRating(kind, id);
  return (
    <div
      role="radiogroup"
      aria-label={`Your rating for ${title}`}
      className={`inline-flex shrink-0 items-center ${className}`}
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const on = rating !== null && n <= rating;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={`${n} star${n === 1 ? '' : 's'}`}
            title={rating === n ? 'Clear rating' : `${n} star${n === 1 ? '' : 's'}`}
            onClick={(event) => {
              event.stopPropagation();
              void setRating(rating === n ? null : n).catch(() => {
                // The global toast layer reports the server's answer.
              });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
            }}
            className={`leading-none transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded ${
              size === 'lg' ? 'px-0.5 text-xl' : 'text-sm'
            } ${on ? 'text-accent' : 'text-gray-600 hover:text-accent'}`}
          >
            {on ? '★' : '☆'}
          </button>
        );
      })}
    </div>
  );
}
