import FavoriteButton from '../FavoriteButton.js';

/**
 * The heart for whatever is playing (R01.3), now the shared heart of R06.3:
 * toggling it here also fills it in the queue and on the album page. Not
 * shown for Qobuz, Spotify or radio items, which have no library id.
 */
interface Props {
  trackId: string;
  title: string;
  size?: 'sm' | 'lg';
}

export default function FavoriteTrackButton({ trackId, title, size = 'sm' }: Props) {
  return <FavoriteButton kind="track" id={trackId} title={title} size={size} />;
}
