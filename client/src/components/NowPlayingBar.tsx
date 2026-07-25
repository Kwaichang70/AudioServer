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

  return (
    <div className="relative h-20 bg-surface border-t border-white/10 flex items-center px-2 md:px-4 gap-2 md:gap-4 safe-bottom no-select">
      {/* Cover + Track info */}
      <div className="flex items-center gap-2 md:gap-3 w-40 md:w-72 min-w-0 shrink-0">
        <button
          type="button"
          className="w-10 h-10 md:w-12 md:h-12 rounded bg-surface-dark overflow-hidden shrink-0 cursor-pointer hover:opacity-80 transition"
          onClick={onExpandClick}
          title="Fullscreen view"
          aria-label="Open fullscreen player"
        >
          <TrackThumb key={currentTrack.id} track={currentTrack} />
        </button>
        <button
          type="button"
          className="min-w-0 cursor-pointer text-left"
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
          <p className="text-xs text-gray-400 truncate">
            {currentTrack.artistName} &mdash; {currentTrack.albumTitle}
            {currentTrack.id.startsWith('spotify:') && (
              <span className="ml-1 text-green-400"> &middot; via Spotify Connect</span>
            )}
            {currentTrack.format && (
              <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-gray-500">
                {currentTrack.format.toUpperCase()}
                {currentTrack.sampleRate
                  ? `/${(currentTrack.sampleRate / 1000).toFixed(1)}kHz`
                  : ''}
                {currentTrack.bitDepth ? `/${currentTrack.bitDepth}bit` : ''}
              </span>
            )}
          </p>
        </button>
      </div>

      {/* Controls */}
      <div className="flex-1 flex flex-col items-center gap-1">
        <div className="flex items-center gap-3">
          <button
            onClick={toggleShuffle}
            className={`transition ${shuffle ? 'text-accent' : 'text-gray-500 hover:text-white'}`}
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
            className={`w-9 h-9 rounded-full flex items-center justify-center transition ${
              isLoading ? 'bg-gray-500 text-surface' : 'bg-white text-surface hover:scale-105'
            }`}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isLoading ? (
              <SpinnerIcon size={18} />
            ) : isPlaying ? (
              <PauseIcon size={18} />
            ) : (
              <PlayIcon size={18} />
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
            className={`transition ${repeat !== 'off' ? 'text-accent' : 'text-gray-500 hover:text-white'}`}
            title={repeat === 'off' ? 'Repeat off' : repeat === 'all' ? 'Repeat all' : 'Repeat one'}
            aria-label={
              repeat === 'off' ? 'Repeat off' : repeat === 'all' ? 'Repeat all' : 'Repeat one'
            }
          >
            {repeat === 'one' ? <RepeatOneIcon size={18} /> : <RepeatIcon size={18} />}
          </button>
          {/* Mobile/tablet: the desktop queue popup lives in the hidden-md
              section, so navigate to the full Queue page instead. */}
          {queue.length > 0 && (
            <button
              onClick={() => navigate('/queue')}
              className="md:hidden text-[11px] px-1.5 py-0.5 rounded text-gray-500 hover:text-white bg-white/5 transition"
              title="Open queue"
              aria-label="Open queue"
            >
              {queueIndex + 1}/{queue.length}
            </button>
          )}
        </div>
        {selectedDeviceId !== 'browser' && (
          <p className="text-[10px] text-gray-500 mb-0.5">Playing on external device</p>
        )}
        {isRadio ? (
          <div className="w-full max-w-lg flex items-center justify-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-red-900/40 text-red-300">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
              LIVE
            </span>
            <span className="text-gray-500 truncate">{currentTrack.albumTitle}</span>
          </div>
        ) : (
          <div className="w-full max-w-lg flex items-center gap-2 text-xs text-gray-400">
            <span className="w-10 text-right">{formatTime(currentTime)}</span>
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
            <span className="w-10">{formatTime(duration)}</span>
          </div>
        )}
      </div>

      {/* Volume + Queue + Device */}
      <div className="hidden md:flex items-center gap-2 w-64">
        {queue.length > 0 && (
          <button
            onClick={() => setShowQueue(!showQueue)}
            className={`text-xs px-2 py-0.5 rounded transition ${showQueue ? 'bg-accent text-white' : 'text-gray-500 hover:text-white'}`}
            title="Toggle queue"
            aria-label="Toggle queue"
          >
            {queueIndex + 1}/{queue.length}
          </button>
        )}
        <div className="flex items-center gap-1.5 flex-1">
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
        <DeviceSelector selectedDeviceId={selectedDeviceId} onSelect={setSelectedDeviceId} />
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
              (t, i): SortableQueueTrack => ({ ...t, id: `q-${i}-${t.id}`, _index: i }),
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
