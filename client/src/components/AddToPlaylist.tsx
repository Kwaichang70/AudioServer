import { useEffect, useState, useRef } from 'react';
import { api } from '../api/client.js';

interface Playlist {
  id: string;
  name: string;
}

interface Props {
  trackId: string;
}

export default function AddToPlaylist({ trackId }: Props) {
  const [open, setOpen] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [added, setAdded] = useState('');
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Playlists are local-only: playlist_tracks has a foreign key to the local
  // tracks table, so provider/radio ids can never be added — the insert would
  // just 500. Don't offer the button for them.
  const isProviderTrack = /^(?:spotify|qobuz|tidal|radio):/.test(trackId);

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

  if (isProviderTrack) return null;

  const handleAdd = async (playlistId: string, playlistName: string) => {
    try {
      await api.addToPlaylist(playlistId, trackId);
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
