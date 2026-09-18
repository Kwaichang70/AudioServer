import { useEffect, useState, useRef } from 'react';
import { api } from '../api/client.js';

interface Playlist {
  id: string;
  name: string;
}

/** Enough of a track to describe it later; an external one has no local row. */
export interface AddableTrack {
  id: string;
  title?: string;
  artistName?: string;
  albumTitle?: string;
  albumId?: string | null;
  duration?: number | null;
  coverUrl?: string | null;
  format?: string | null;
}

interface Props {
  trackId: string;
  /**
   * The track itself (V12.1). A Qobuz or radio track has no row on the server,
   * so its name travels with it and becomes the playlist item's snapshot.
   * Without it, only local tracks can be added.
   */
  track?: AddableTrack;
}

export default function AddToPlaylist({ trackId, track }: Props) {
  const [open, setOpen] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [added, setAdded] = useState('');
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // A playlist holds any source since V12.1, but an external track is only
  // storable when the caller can say what it is: the server has no row to read
  // it from. Spotify is the exception — it plays through its own player, never
  // from a stream URL the server hands out, so it stays out of playlists.
  const isExternal = /^(?:spotify|qobuz|tidal|radio):/.test(trackId);
  const canAdd = !isExternal
    ? true
    : !trackId.startsWith('spotify:') && !!track?.title && !!track?.artistName;

  useEffect(() => {
    if (open && playlists.length === 0) {
      api
        .getPlaylists()
        .then((res) => setPlaylists(res.data))
        .catch(() => {});
    }
  }, [open, playlists.length]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (!canAdd) return null;

  const handleAdd = async (playlistId: string, playlistName: string) => {
    try {
      await api.addToPlaylist(
        playlistId,
        track
          ? {
              trackId,
              title: track.title,
              artistName: track.artistName,
              albumTitle: track.albumTitle,
              albumId: track.albumId,
              duration: track.duration,
              coverUrl: track.coverUrl,
              format: track.format,
            }
          : trackId,
      );
      setFailed(false);
      setAdded(playlistName);
      setTimeout(() => {
        setAdded('');
        setOpen(false);
      }, 1000);
    } catch {
      setFailed(true);
      setTimeout(() => setFailed(false), 2000);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className="text-gray-600 hover:text-accent transition text-sm px-1"
        title="Add to playlist"
      >
        +
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-surface border border-white/10 rounded-lg shadow-xl z-50 py-1">
          {failed ? (
            <p className="px-3 py-2 text-xs text-red-400">Failed to add track</p>
          ) : added ? (
            <p className="px-3 py-2 text-xs text-accent">Added to {added}</p>
          ) : playlists.length === 0 ? (
            <p className="px-3 py-2 text-xs text-gray-500">No playlists yet</p>
          ) : (
            playlists.map((pl) => (
              <button
                key={pl.id}
                onClick={(e) => {
                  e.stopPropagation();
                  handleAdd(pl.id, pl.name);
                }}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-surface-light transition"
              >
                {pl.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
