import { Link } from 'react-router-dom';
import { useAudioContext, type TrackInfo } from '../context/AudioContext.js';
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

  if (queue.length === 0) {
    return (
      <div className="max-w-2xl">
        <h2 className="text-2xl font-bold mb-4">Queue</h2>
        <p className="text-gray-400">
          The queue is empty. Play an{' '}
          <Link to="/albums" className="text-accent hover:underline">
            album
          </Link>{' '}
          or add tracks with the <span className="text-gray-300">+</span> button to build one.
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
        <button
          onClick={clearQueue}
          className="px-4 py-1.5 text-sm bg-surface-dark border border-white/10 rounded hover:border-red-400 hover:text-red-400 transition"
        >
          Clear queue
        </button>
      </div>

      <SortableList
        items={queue.map((t, i): QueueRow => ({ ...t, id: `q-${i}-${t.id}`, _index: i }))}
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
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-gray-500 hover:text-red-400 text-sm px-1 shrink-0 transition"
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
