import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAudioContext, type TrackInfo } from '../context/AudioContext.js';
import { useToast } from '../components/Toast.js';
import SortableList from '../components/SortableList.js';
import { formatDuration } from '../utils/format.js';

interface QueueRow extends TrackInfo {
  _index: number;
}

/**
 * Full play-queue view. The NowPlayingBar's queue popup is desktop-only and
 * the fullscreen player previews just the next few tracks — this page is the
 * always-reachable place (own nav entry) to get back to what's playing,
 * jump to another track, reorder, or clear the queue.
 */
export default function QueuePage() {
  const {
    queue,
    queueIndex,
    playQueueIndex,
    removeFromQueue,
    moveInQueue,
    clearQueue,
    currentTrack,
    isPlaying,
  } = useAudioContext();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [saving, setSaving] = useState<false | 'naming' | 'busy'>(false);
  const [name, setName] = useState('');

  // R01.3: keep what you built. Since V12.1 a playlist holds any source, so
  // Qobuz and radio items go in with their snapshot. Spotify stays out, as it
  // does everywhere: it plays through its own player, not from a stream. What
  // is left out is counted in the message, never dropped silently.
  const saveAsPlaylist = async (event: FormEvent) => {
    event.preventDefault();
    const title = name.trim();
    if (!title) return;
    setSaving('busy');
    try {
      const storable = queue.filter((t) => !t.id.startsWith('spotify:'));
      const spotify = queue.length - storable.length;
      const created = await api.createPlaylist(title);
      const res = await api.addItemsToPlaylist(
        created.data.id,
        storable.map((t) => ({
          trackId: t.id,
          title: t.title,
          artistName: t.artistName,
          albumTitle: t.albumTitle,
          albumId: t.albumId ?? null,
          duration: t.duration ?? null,
          format: t.format ?? null,
        })),
      );
      const left = res.data.skipped + spotify;
      toast(
        left > 0
          ? `Saved ${res.data.added} tracks to "${title}"; ${left} could not be stored`
          : `Saved ${res.data.added} tracks to "${title}"`,
        left > 0 ? 'info' : 'success',
      );
      setSaving(false);
      setName('');
      navigate(`/playlists/${created.data.id}`);
    } catch {
      // The global toast layer shows the server's answer; keep the form open.
      setSaving('naming');
    }
  };

  if (queue.length === 0) {
    return (
      <div className="max-w-2xl">
        <h2 className="text-2xl font-bold mb-4">Queue</h2>
        <p className="text-gray-400">
          The queue is empty. Play an{' '}
          <Link to="/albums" className="text-accent hover:underline">
            album
          </Link>{' '}
          or use the <span className="text-gray-300">&#8943;</span> menu on any track, album or
          artist to add it to the queue.
        </p>
      </div>
    );
  }

  const totalDuration = queue.reduce((sum, t) => sum + (t.duration || 0), 0);
  const totalMin = Math.floor(totalDuration / 60);

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Queue</h2>
          <p className="text-sm text-gray-500 mt-1">
            {queue.length} tracks &middot; {totalMin} min
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {saving ? (
            <form onSubmit={saveAsPlaylist} className="flex items-center gap-2">
              <input
                // eslint-disable-next-line jsx-a11y/no-autofocus -- opened by an explicit click
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Playlist name"
                aria-label="Playlist name"
                className="min-h-[44px] px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
              />
              <button
                type="submit"
                disabled={saving === 'busy' || !name.trim()}
                className="min-h-[44px] px-4 py-1.5 text-sm bg-accent rounded hover:bg-accent-hover transition disabled:opacity-40"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setSaving(false)}
                className="min-h-[44px] px-3 py-1.5 text-sm text-gray-400 hover:text-white transition"
              >
                Cancel
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setSaving('naming')}
              className="min-h-[44px] px-4 py-1.5 text-sm bg-surface-dark border border-white/10 rounded hover:border-accent transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Save as playlist
            </button>
          )}
          <button
            type="button"
            onClick={clearQueue}
            className="min-h-[44px] px-4 py-1.5 text-sm bg-surface-dark border border-white/10 rounded hover:border-red-400 hover:text-red-400 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Clear queue
          </button>
        </div>
      </div>

      <SortableList
        items={queue.map(
          (t, i): QueueRow => ({ ...t, id: t.itemId ?? `q-${i}-${t.id}`, _index: i }),
        )}
        onReorder={(from, to) => moveInQueue(from, to)}
        renderItem={(item) => {
          const idx = item._index;
          const isCurrent = idx === queueIndex && currentTrack?.id === queue[idx]?.id;
          return (
            <div
              className={`group flex items-center gap-3 px-3 py-2 rounded cursor-pointer transition ${
                isCurrent ? 'bg-accent/10 text-accent' : 'hover:bg-surface-light'
              }`}
              onClick={() => playQueueIndex(idx)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  playQueueIndex(idx);
                }
              }}
              role="button"
              tabIndex={0}
            >
              <span className="w-6 text-sm text-right shrink-0 text-gray-500">
                {isCurrent && isPlaying ? (
                  <span className="text-accent animate-pulse">&#9654;</span>
                ) : (
                  idx + 1
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className={`text-sm truncate ${isCurrent ? 'font-medium' : ''}`}>{item.title}</p>
                <p className="text-xs text-gray-500 truncate">
                  {item.artistName}
                  {item.albumTitle ? ` — ${item.albumTitle}` : ''}
                </p>
              </div>
              <span className="text-xs text-gray-500 shrink-0">
                {formatDuration(item.duration)}
              </span>
              {!isCurrent && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFromQueue(idx);
                  }}
                  type="button"
                  className="opacity-60 md:opacity-0 group-hover:opacity-100 focus:opacity-100 min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-gray-400 hover:text-red-400 text-lg shrink-0 transition rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  title="Remove from queue"
                  aria-label={`Remove ${item.title} from queue`}
                >
                  &times;
                </button>
              )}
            </div>
          );
        }}
      />
    </div>
  );
}
