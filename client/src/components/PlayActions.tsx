import { useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { api } from '../api/client.js';
import type { LibraryTrack, StoredPlaylist } from '../api/types.js';
import { useAudioContext, type TrackInfo } from '../context/AudioContext.js';
import { Menu, MenuItem, MenuSeparator } from './ui/Menu.js';
import { useToast } from './Toast.js';

/**
 * The same play actions on every row (R01.2), the way Roon offers them:
 * play now, play next, add to queue, and for a track in a list "play from
 * here" — plus adding to a playlist and the heart.
 *
 * "Play now" does not throw the queue away: the item goes in straight after
 * what is playing and the queue moves on to it. Clicking a row still does
 * what it always did (start the list from that row); the menu is for the
 * cases where replacing the queue is not what you want.
 */

export type PlayActionTarget =
  | {
      kind: 'track';
      track: TrackInfo;
      /** The list this row belongs to, for "play from here". */
      list?: TrackInfo[];
      index?: number;
    }
  | { kind: 'album'; albumId: string; title: string }
  | { kind: 'artist'; artistId: string; name: string };

interface Props {
  target: PlayActionTarget;
  /**
   * -1 inside a roving-tabindex list: there the row is the tab stop and the
   * menu opens with the context-menu key, Shift+F10 or a right click on the
   * row instead (`openRowMenuFromKey`, `openRowMenuFromPointer`).
   */
  triggerTabIndex?: number;
  className?: string;
}

const PROVIDER_PREFIX = /^(?:spotify|qobuz|tidal|radio):/;

/** Only the fields the player uses — not the file path the library row carries. */
export function toTrackInfo(t: LibraryTrack | TrackInfo): TrackInfo {
  const source = t as LibraryTrack & TrackInfo;
  return {
    id: source.id,
    title: source.title,
    artistName: source.artistName,
    albumTitle: source.albumTitle,
    albumId: source.albumId,
    duration: source.duration,
    format: source.format,
    sampleRate: source.sampleRate,
    bitDepth: source.bitDepth,
    replayGainTrack: source.replayGainTrack,
    replayGainTrackPeak: source.replayGainTrackPeak,
    replayGainAlbum: source.replayGainAlbum,
    replayGainAlbumPeak: source.replayGainAlbumPeak,
    source: source.source,
  };
}

/**
 * Did this error come back from the server? Those are already shown by the
 * global toast layer (with the server's own sentence), so the menu only adds
 * a message for failures that never got an answer. Checked by name, the same
 * way the audio context does, so it does not depend on the class identity.
 */
function isApiError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'ApiError';
}

/** A shuffled copy (Fisher-Yates); the original list is left alone. */
export function shuffledCopy<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** The menu trigger that belongs to the row an event happened in. */
function rowTrigger(row: HTMLElement): HTMLButtonElement | null {
  const wrapper = row.closest('[data-play-actions-row]') ?? row.parentElement;
  return wrapper?.querySelector<HTMLButtonElement>('[data-play-actions-trigger]') ?? null;
}

/**
 * Keyboard way into a row's menu where the trigger is not a tab stop:
 * the context-menu key or Shift+F10, as on any desktop.
 */
export function openRowMenuFromKey(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
  const trigger = rowTrigger(event.currentTarget);
  if (!trigger) return;
  event.preventDefault();
  event.stopPropagation();
  trigger.click();
}

/** Right click on a row opens its menu instead of the browser's. */
export function openRowMenuFromPointer(event: MouseEvent<HTMLElement>): void {
  const trigger = rowTrigger(event.currentTarget);
  if (!trigger) return;
  event.preventDefault();
  trigger.click();
}

function favoriteKey(target: PlayActionTarget): { type: 'track' | 'album' | 'artist'; id: string } {
  if (target.kind === 'track') return { type: 'track', id: target.track.id };
  if (target.kind === 'album') return { type: 'album', id: target.albumId };
  return { type: 'artist', id: target.artistId };
}

function menuLabel(target: PlayActionTarget): string {
  if (target.kind === 'track') return target.track.title;
  if (target.kind === 'album') return target.title;
  return target.name;
}

export default function PlayActions({ target, triggerTabIndex, className }: Props) {
  const { playNow, playNextTracks, queueTracks, playAlbum } = useAudioContext();
  const { toast } = useToast();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'actions' | 'playlists'>('actions');
  const [favorited, setFavorited] = useState<boolean | null>(null);
  const [playlists, setPlaylists] = useState<StoredPlaylist[] | null>(null);
  const [busy, setBusy] = useState(false);

  const isProviderTrack = target.kind === 'track' && PROVIDER_PREFIX.test(target.track.id);
  // Favorites and server playlists hold library items; a Qobuz or radio row
  // has no library id to store, so those two actions are not offered there.
  const canFavorite = !isProviderTrack;
  const canAddToPlaylist = target.kind === 'track' && !isProviderTrack;

  const close = () => {
    setOpen(false);
    setView('actions');
  };

  const openMenu = () => {
    setOpen(true);
    setView('actions');
    if (canFavorite && favorited === null) {
      const { type, id } = favoriteKey(target);
      api
        .checkFavorite(type, id)
        .then((res) => setFavorited(res.data.favorited))
        .catch(() => {});
    }
  };

  /** The tracks behind this row; albums and artists are fetched on demand. */
  const resolveTracks = async (): Promise<TrackInfo[]> => {
    if (target.kind === 'track') return [target.track];
    const res =
      target.kind === 'album'
        ? await api.getAlbumTracks(target.albumId)
        : await api.getArtistTracks(target.artistId);
    const list = (res.data ?? [])
      .filter((t) => t.availability !== 'missing')
      .map((t) => toTrackInfo(t));
    if (list.length === 0) toast(`Nothing playable in ${menuLabel(target)}`, 'info');
    return list;
  };

  const run = async (action: (tracks: TrackInfo[]) => Promise<void> | void) => {
    setBusy(true);
    try {
      const tracks = await resolveTracks();
      if (tracks.length > 0) await action(tracks);
    } catch (err) {
      // API errors are already toasted globally with the server's message.
      if (!isApiError(err)) {
        toast(`Could not load ${menuLabel(target)}: ${(err as Error).message ?? err}`, 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const toggleFavorite = async () => {
    const { type, id } = favoriteKey(target);
    try {
      const res = await api.toggleFavorite(type, id);
      setFavorited(res.data.favorited);
      toast(res.data.favorited ? 'Added to favorites' : 'Removed from favorites', 'success');
    } catch (err) {
      if (!isApiError(err)) toast(`Favorite failed: ${(err as Error).message ?? err}`, 'error');
    }
  };

  const showPlaylists = () => {
    setView('playlists');
    if (playlists === null) {
      api
        .getPlaylists()
        .then((res) => setPlaylists(res.data ?? []))
        .catch(() => setPlaylists([]));
    }
  };

  const addToPlaylist = async (playlist: StoredPlaylist) => {
    if (target.kind !== 'track') return;
    try {
      await api.addToPlaylist(playlist.id, target.track.id);
      toast(`Added to "${playlist.name}"`, 'success');
    } catch (err) {
      if (!isApiError(err)) {
        toast(`Could not add to "${playlist.name}": ${(err as Error).message ?? err}`, 'error');
      }
    }
  };

  // The row around the trigger usually plays on click or Enter; the trigger
  // must not let either reach it.
  const stop = (event: MouseEvent | KeyboardEvent) => event.stopPropagation();

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`More actions for ${menuLabel(target)}`}
        aria-haspopup="menu"
        aria-expanded={open}
        tabIndex={triggerTabIndex}
        data-play-actions-trigger=""
        onClick={(event) => {
          stop(event);
          if (open) close();
          else openMenu();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') stop(event);
        }}
        className={
          className ??
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-400 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent'
        }
      >
        <span aria-hidden="true" className="text-lg leading-none">
          &#8943;
        </span>
      </button>

      <Menu open={open} onClose={close} anchorRef={triggerRef} label={menuLabel(target)}>
        {view === 'actions' ? (
          <>
            <MenuItem onSelect={() => void run(playNow)} onClose={close} disabled={busy}>
              Play now
            </MenuItem>
            {target.kind !== 'track' && (
              <MenuItem
                onSelect={() => void run((tracks) => playAlbum(shuffledCopy(tracks), 0))}
                onClose={close}
                disabled={busy}
              >
                Shuffle
              </MenuItem>
            )}
            <MenuItem onSelect={() => void run(playNextTracks)} onClose={close} disabled={busy}>
              Play next
            </MenuItem>
            <MenuItem onSelect={() => void run(queueTracks)} onClose={close} disabled={busy}>
              Add to queue
            </MenuItem>
            {target.kind === 'track' && target.list && target.index !== undefined && (
              <MenuItem onSelect={() => playAlbum(target.list!, target.index!)} onClose={close}>
                Play from here
              </MenuItem>
            )}
            {(canAddToPlaylist || canFavorite) && <MenuSeparator />}
            {canAddToPlaylist && (
              <MenuItem onSelect={showPlaylists} keepOpen hint={'›'}>
                Add to playlist
              </MenuItem>
            )}
            {canFavorite && (
              <MenuItem onSelect={() => void toggleFavorite()} onClose={close}>
                {favorited ? 'Remove from favorites' : 'Add to favorites'}
              </MenuItem>
            )}
          </>
        ) : (
          <>
            <MenuItem onSelect={() => setView('actions')} keepOpen hint={'‹'}>
              Back
            </MenuItem>
            <MenuSeparator />
            {playlists === null && (
              <p className="px-4 py-2 text-xs text-gray-500">Loading playlists…</p>
            )}
            {playlists?.length === 0 && (
              <p className="px-4 py-2 text-xs text-gray-500">
                No playlists yet. Create one on the Playlists page.
              </p>
            )}
            {playlists?.map((playlist) => (
              <MenuItem
                key={playlist.id}
                onSelect={() => void addToPlaylist(playlist)}
                onClose={close}
              >
                {playlist.name}
              </MenuItem>
            ))}
          </>
        )}
      </Menu>
    </>
  );
}

/**
 * The menu on an album or artist card (R01.2). A button may not sit inside
 * the card's link, so it overlays the card from a wrapper instead; the wrapper
 * needs `relative group` and `data-play-actions-row`. It shows on hover and
 * focus, stays while its menu is open, and is always visible on a touch screen
 * where there is no hover to reveal it. In a keyboard grid the card is the tab
 * stop, so the trigger is not; the card opens it with the context-menu key.
 */
export function CardActions({ target }: { target: PlayActionTarget }) {
  return (
    <div className="absolute top-2 right-2 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 touch-visible">
      <PlayActions
        target={target}
        triggerTabIndex={-1}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white shadow transition hover:bg-black/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
    </div>
  );
}
