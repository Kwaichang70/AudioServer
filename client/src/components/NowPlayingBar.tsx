import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAudioContext, useProgress, type TrackInfo } from '../context/AudioContext.js';
import { api } from '../api/client.js';
import DeviceSelector from './DeviceSelector.js';
import { formatTime } from '../utils/format.js';
import SortableList from './SortableList.js';
import {
  PlayIcon,
  PauseIcon,
  PrevIcon,
  NextIcon,
  ShuffleIcon,
  RepeatIcon,
  RepeatOneIcon,
  SpinnerIcon,
} from './PlayerIcons.js';

interface NowPlayingBarProps {
  onExpandClick?: () => void;
}

interface SortableQueueTrack extends TrackInfo {
  _index: number;
}

// Cover thumbnail with a fallback chain: album cover → the track file's own
// embedded art → a gradient initial. Keyed by track id so state resets per
// track. Fixes blank thumbnails when an album's cover can't be resolved (e.g.
// art was only fetched under a different album id, or the album has none).
function TrackThumb({ track }: { track: TrackInfo }) {
  const [step, setStep] = useState(track.albumId ? 0 : 1);
  // Provider tracks (spotify:/qobuz:/tidal:) aren't served by our cover
  // endpoints — skip straight to the gradient instead of firing 404s.
  const isProvider = /^(?:spotify|qobuz|tidal):/.test(track.albumId || track.id);
  const src = isProvider
    ? null
    : step === 0 && track.albumId
      ? api.getAlbumCoverUrl(track.albumId)
      : step <= 1
        ? api.getTrackCoverUrl(track.id)
        : null;
  if (!src) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-violet-900 to-indigo-800 text-white/70 text-lg font-semibold">
        {(track.title || '?').charAt(0).toUpperCase()}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      className="w-full h-full object-cover"
      onError={() => setStep((s) => s + 1)}
    />
  );
}

export default function NowPlayingBar({ onExpandClick }: NowPlayingBarProps) {
  const navigate = useNavigate();
  const {
    currentTrack,
    isPlaying,
    isLoading,
    volume,
    pause,
    resume,
    setVolume,
    seek,
    playNext,
    playPrevious,
    queue,
    queueIndex,
    selectedDeviceId,
    setSelectedDeviceId,
    shuffle,
    repeat,
    toggleShuffle,
    toggleRepeat,
    removeFromQueue,
    moveInQueue,
    clearQueue,
  } = useAudioContext();
  const { currentTime, duration } = useProgress();
  const [showQueue, setShowQueue] = useState(false);

  if (!currentTrack) {
    return (
      <div className="h-20 bg-surface border-t border-white/10 flex items-center justify-between px-4 text-gray-500">
        <span>No track playing</span>
        <DeviceSelector selectedDeviceId={selectedDeviceId} onSelect={setSelectedDeviceId} />
      </div>
    );
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const isRadio = currentTrack.id.startsWith('radio:');
  const external = selectedDeviceId !== 'browser';

  return (
    <div className="relative h-20 bg-surface border-t border-white/10 flex items-center px-2 md:px-4 gap-2 md:gap-3 safe-bottom no-select">
      {/* Phone: a hairline of progress along the top edge. There is no room
          for a scrub track next to the controls on a 390 px screen, and the
          fullscreen player (tap the cover) has a full-size one. */}
      {!isRadio && (
        <div className="md:hidden absolute inset-x-0 top-0 h-0.5 bg-white/10" aria-hidden="true">
          <div className="h-full bg-accent" style={{ width: `${progress}%` }} />
        </div>
      )}

      {/* Cover + track info. On a phone this block takes the free space (it
          used to be pinned at 10rem, which squeezed the title, hid the time
          and pushed the queue counter off the screen). */}
      <div className="flex items-center gap-2 md:gap-3 flex-1 md:flex-none md:w-72 min-w-0">
        <button
          type="button"
          className="w-12 h-12 rounded bg-surface-dark overflow-hidden shrink-0 cursor-pointer hover:opacity-80 transition"
          onClick={onExpandClick}
          title="Fullscreen view"
          aria-label="Open fullscreen player"
        >
          <TrackThumb key={currentTrack.id} track={currentTrack} />
        </button>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="block w-full min-w-0 cursor-pointer text-left"
            onClick={() => {
              if (currentTrack.albumId) navigate(`/albums/${currentTrack.albumId}`);
            }}
          >
            <p className="text-sm font-medium truncate hover:text-accent transition">
              {currentTrack.title}
              {currentTrack.id.startsWith('spotify:') && (
                <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-green-900/50 text-green-300">
                  spotify
                </span>
              )}
            </p>
            <p className="text-xs text-gray-300 truncate">
              {currentTrack.artistName} &mdash; {currentTrack.albumTitle}
              {currentTrack.id.startsWith('spotify:') && (
                <span className="ml-1 text-green-400"> &middot; via Spotify Connect</span>
              )}
              {currentTrack.format && (
                <span className="ml-1.5 hidden md:inline text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-gray-400">
                  {currentTrack.format.toUpperCase()}
                  {currentTrack.sampleRate
                    ? `/${(currentTrack.sampleRate / 1000).toFixed(1)}kHz`
                    : ''}
                  {currentTrack.bitDepth ? `/${currentTrack.bitDepth}bit` : ''}
                </span>
              )}
            </p>
          </button>
          {/* Third line: the clock the phone has no room for above, and where
              the music is coming out. Empty (and zero-height) on a desktop
              that plays in the browser. */}
          <p className="flex items-center gap-1.5 text-[11px] leading-4 text-gray-400">
            {!isRadio && (
              <span className="md:hidden tabular-nums">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            )}
            {external && <span className="truncate text-accent">Playing on external device</span>}
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-col items-center gap-1 md:flex-1 shrink-0">
        <div className="flex items-center gap-2 md:gap-3">
          <button
            onClick={toggleShuffle}
            className={`hidden md:block transition ${shuffle ? 'text-accent' : 'text-gray-500 hover:text-white'}`}
            title={shuffle ? 'Shuffle on' : 'Shuffle off'}
            aria-label={shuffle ? 'Shuffle on' : 'Shuffle off'}
            aria-pressed={shuffle}
          >
            <ShuffleIcon size={18} />
          </button>
          <button
            onClick={playPrevious}
            className="text-gray-300 hover:text-white transition"
            title="Previous"
            aria-label="Previous track"
          >
            <PrevIcon size={22} />
          </button>
          <button
            onClick={isLoading ? undefined : isPlaying ? pause : resume}
            disabled={isLoading}
            className={`w-11 h-11 md:w-9 md:h-9 rounded-full flex items-center justify-center transition ${
              isLoading ? 'bg-gray-500 text-surface' : 'bg-white text-surface hover:scale-105'
            }`}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isLoading ? (
              <SpinnerIcon size={20} />
            ) : isPlaying ? (
              <PauseIcon size={20} />
            ) : (
              <PlayIcon size={20} />
            )}
          </button>
          <button
            onClick={playNext}
            className="text-gray-300 hover:text-white transition"
            title="Next"
            aria-label="Next track"
          >
            <NextIcon size={22} />
          </button>
          <button
            onClick={toggleRepeat}
            className={`hidden md:block transition ${repeat !== 'off' ? 'text-accent' : 'text-gray-500 hover:text-white'}`}
            title={repeat === 'off' ? 'Repeat off' : repeat === 'all' ? 'Repeat all' : 'Repeat one'}
            aria-label={
              repeat === 'off' ? 'Repeat off' : repeat === 'all' ? 'Repeat all' : 'Repeat one'
            }
          >
            {repeat === 'one' ? <RepeatOneIcon size={18} /> : <RepeatIcon size={18} />}
          </button>
        </div>
        {isRadio ? (
          <div className="w-full max-w-lg flex items-center justify-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-red-900/40 text-red-300">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
              LIVE
            </span>
            <span className="hidden md:inline text-gray-400 truncate">
              {currentTrack.albumTitle}
            </span>
          </div>
        ) : (
          <div className="hidden md:flex w-full max-w-lg items-center gap-2 text-xs text-gray-400">
            <span className="w-10 text-right tabular-nums">{formatTime(currentTime)}</span>
            <div
              role="slider"
              tabIndex={0}
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              aria-valuenow={Math.round(currentTime)}
              className="flex-1 relative h-1 bg-white/10 rounded group cursor-pointer focus:outline-none focus:ring-1 focus:ring-accent"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const pos = (e.clientX - rect.left) / rect.width;
                seek(pos * duration);
              }}
              onKeyDown={(e) => {
                // Arrow keys scrub ±5s; Home/End jump to start/end.
                if (e.key === 'ArrowRight') seek(Math.min(duration, currentTime + 5));
                else if (e.key === 'ArrowLeft') seek(Math.max(0, currentTime - 5));
                else if (e.key === 'Home') seek(0);
                else if (e.key === 'End') seek(duration);
                else return;
                e.preventDefault();
              }}
            >
              <div
                className="absolute left-0 top-0 h-full bg-accent rounded"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="w-10 tabular-nums">{formatTime(duration)}</span>
          </div>
        )}
      </div>

      {/* Queue + volume + device. Always visible: on a phone the device picker
          used to live in a desktop-only block, so there was no way to send the
          music to a speaker from the player itself. */}
      <div className="flex items-center gap-1.5 md:gap-2 shrink-0 md:w-64">
        {queue.length > 0 && (
          <>
            {/* Phone: the desktop queue popup does not fit, so open the page. */}
            <button
              onClick={() => navigate('/queue')}
              className="md:hidden text-[11px] px-1.5 py-1 rounded text-gray-300 hover:text-white bg-white/5 transition tabular-nums"
              title="Open queue"
              aria-label="Open queue"
            >
              {queueIndex + 1}/{queue.length}
            </button>
            <button
              onClick={() => setShowQueue(!showQueue)}
              className={`hidden md:block text-xs px-2 py-0.5 rounded transition ${showQueue ? 'bg-accent text-white' : 'text-gray-500 hover:text-white'}`}
              title="Toggle queue"
              aria-label="Toggle queue"
            >
              {queueIndex + 1}/{queue.length}
            </button>
          </>
        )}
        <div className="hidden md:flex items-center gap-1.5 flex-1">
          <span className="text-xs text-gray-500">&#128264;</span>
          <input
            type="range"
            aria-label="Volume"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="flex-1 h-1 accent-accent"
          />
        </div>
        <DeviceSelector
          selectedDeviceId={selectedDeviceId}
          onSelect={setSelectedDeviceId}
          compact
        />
      </div>

      {/* Queue panel */}
      {showQueue && queue.length > 0 && (
        <div className="absolute bottom-full right-4 mb-2 w-96 max-h-96 overflow-y-auto bg-surface border border-white/10 rounded-lg shadow-xl z-50">
          <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
            <p className="text-xs text-gray-400 uppercase tracking-wider">
              Queue ({queue.length} tracks)
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={clearQueue}
                className="text-[10px] text-gray-500 hover:text-red-400 transition"
                title="Clear queue"
              >
                Clear
              </button>
              <button
                onClick={() => setShowQueue(false)}
                className="text-gray-500 hover:text-white text-sm"
                aria-label="Close queue"
              >
                &times;
              </button>
            </div>
          </div>
          <SortableList
            items={queue.map(
              (t, i): SortableQueueTrack => ({ ...t, id: t.itemId ?? `q-${i}-${t.id}`, _index: i }),
            )}
            onReorder={(from, to) => moveInQueue(from, to)}
            renderItem={(item) => {
              const idx = item._index;
              const isCurrent = idx === queueIndex;
              return (
                <div
                  className={`group px-2 py-1.5 text-sm flex items-center gap-2 ${
                    isCurrent ? 'text-accent bg-accent/10 rounded' : 'text-gray-400'
                  }`}
                >
                  <span className="w-5 text-xs text-right shrink-0">
                    {isCurrent && isPlaying ? '\u25B6' : idx + 1}
                  </span>
                  <span className="truncate flex-1">{item.title}</span>
                  <span className="text-xs text-gray-600 truncate">{item.artistName}</span>
                  {!isCurrent && (
                    <button
                      onClick={() => removeFromQueue(idx)}
                      className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 text-gray-500 hover:text-red-400 text-xs px-1 shrink-0 transition"
                      title="Remove"
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
      )}
    </div>
  );
}
