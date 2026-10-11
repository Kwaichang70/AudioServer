import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import type { LibraryTrack } from '../api/types.js';
import { useAudioContext } from '../context/AudioContext.js';
import { useAutoLoadMore, useInfiniteLoad } from '../hooks/useInfiniteLoad.js';
import { useFocus, useReloadOnQuery } from '../hooks/useFocus.js';
import { FocusBar } from '../components/FocusPanel.js';
import PlayActions, { toTrackInfo } from '../components/PlayActions.js';
import { formatDuration, formatQuality } from '../utils/format.js';
import { filterCount, type SortKey } from '../utils/focus.js';

/**
 * Every track, as a list you can question (R05.2). The sidebar had no Tracks
 * entry because there was only a bare paginated endpoint; with Focus it is a
 * real page: filter, sort, play from any row.
 */

const TRACK_SORTS: SortKey[] = [
  'title',
  'artist',
  'year',
  'added',
  'lastPlayed',
  'plays',
  'duration',
];
const PAGE_SIZE = 100;

export default function TracksPage() {
  const focus = useFocus();
  const { playAlbum } = useAudioContext();
  const { items, loading, loadingMore, total, hasMore, loadMore, reload } =
    useInfiniteLoad<LibraryTrack>(
      (page, limit) => api.getTracks(page, limit, focus.query),
      PAGE_SIZE,
    );
  useReloadOnQuery(focus.query, reload);
  const sentinelRef = useAutoLoadMore(loadMore, hasMore);
  const filtered = filterCount(focus.params) > 0;

  // Rows that can play, as the player wants them; a missing file is listed
  // but skipped when playing from a row.
  const playable = useMemo(() => items.filter((t) => t.availability !== 'missing'), [items]);
  const infos = useMemo(() => playable.map((t) => toTrackInfo(t)), [playable]);

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">
        Tracks <span className="text-sm font-normal text-gray-500">({total})</span>
      </h2>
      <FocusBar
        focus={focus}
        sorts={TRACK_SORTS}
        countNote="The numbers count albums; the list shows their tracks."
      />

      {loading && items.length === 0 ? (
        <p className="text-gray-400">Loading tracks...</p>
      ) : items.length === 0 ? (
        <p className="text-gray-400 text-center py-20">
          {filtered ? 'No tracks match this Focus.' : 'No tracks found. Scan your library first.'}
        </p>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-gray-500 border-b border-white/10">
              <th className="py-2 font-normal">Title</th>
              <th className="py-2 font-normal hidden md:table-cell">Album</th>
              <th className="py-2 font-normal hidden lg:table-cell">Quality</th>
              <th className="py-2 font-normal text-right">Time</th>
              <th className="py-2 w-10">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((track) => {
              const missing = track.availability === 'missing';
              const index = playable.indexOf(track);
              return (
                <tr
                  key={track.id}
                  data-play-actions-row
                  className={`border-b border-white/5 hover:bg-white/5 ${missing ? 'opacity-50' : ''}`}
                >
                  <td className="py-2.5 pr-2">
                    <button
                      type="button"
                      disabled={missing}
                      onClick={() => playAlbum(infos, index)}
                      className="w-full rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      aria-label={`Play ${track.title} by ${track.artistName}`}
                    >
                      <span className="block text-sm font-medium truncate">{track.title}</span>
                      <span className="block text-xs text-gray-500 truncate">
                        {track.artistName}
                      </span>
                    </button>
                  </td>
                  <td className="py-2.5 pr-2 text-sm text-gray-400 hidden md:table-cell">
                    {track.albumId ? (
                      <Link to={`/albums/${track.albumId}`} className="truncate hover:text-white">
                        {track.albumTitle}
                      </Link>
                    ) : (
                      track.albumTitle
                    )}
                  </td>
                  <td className="py-2.5 pr-2 text-xs text-gray-500 hidden lg:table-cell">
                    {formatQuality(track)}
                  </td>
                  <td className="py-2.5 text-sm text-gray-400 text-right">
                    {formatDuration(track.duration)}
                  </td>
                  <td className="py-2.5">
                    {!missing && index >= 0 && (
                      <PlayActions
                        target={{ kind: 'track', track: infos[index], list: infos, index }}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {hasMore && items.length > 0 && (
        <>
          <div ref={sentinelRef} className="h-10" aria-hidden="true" />
          <div className="flex justify-center mt-2">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="px-6 py-2 bg-surface-light border border-white/10 rounded hover:border-accent transition disabled:opacity-50"
            >
              {loadingMore ? 'Loading...' : `Load More (${items.length} of ${total})`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
