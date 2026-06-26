import { useState, lazy, Suspense } from 'react';
import { useAudioContext, useProgress } from '../context/AudioContext.js';
import { api } from '../api/client.js';
import { formatTime } from '../utils/format.js';
import {
  PlayIcon,
  PauseIcon,
  PrevIcon,
  NextIcon,
  ShuffleIcon,
  RepeatIcon,
  RepeatOneIcon,
  VolumeIcon,
  ChevronDownIcon,
  SpinnerIcon,
} from './PlayerIcons.js';

const LyricsDisplay = lazy(() => import('./LyricsDisplay.js'));

interface Props {
  onClose: () => void;
}

export default function NowPlayingFull({ onClose }: Props) {
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
    shuffle,
    repeat,
    toggleShuffle,
    toggleRepeat,
    crossfade,
    setCrossfade,
  } = useAudioContext();
  const { currentTime, duration } = useProgress();

  const [showLyrics, setShowLyrics] = useState(false);

  if (!currentTrack) return null;

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const isRadio = currentTrack.id.startsWith('radio:');
  const coverUrl = currentTrack.albumId
    ? api.getAlbumCoverUrl(currentTrack.albumId)
    : api.getTrackCoverUrl(currentTrack.id);

  return (
    <div className="fixed inset-0 z-[100] bg-surface-dark flex flex-col">
      {/* Background blur */}
      <div className="absolute inset-0 overflow-hidden">
        <img
          src={coverUrl}
          alt=""
          className="w-full h-full object-cover scale-110 blur-3xl opacity-20"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-surface-dark/60 via-surface-dark/80 to-surface-dark" />
      </div>

      {/* Header */}
      <div className="relative flex items-center justify-between px-6 py-4">
        <button
          onClick={onClose}
          className="text-gray-300 hover:text-white transition"
          title="Close (Esc)"
          aria-label="Close full player"
        >
          <ChevronDownIcon size={26} />
        </button>
        <p className="text-xs text-gray-500 uppercase tracking-widest">Now Playing</p>
        <button
          onClick={() => setShowLyrics(!showLyrics)}
          className={`text-sm px-3 py-1 rounded transition ${showLyrics ? 'bg-accent text-white' : 'text-gray-500 hover:text-white'}`}
          title="Toggle lyrics"
        >
          Lyrics
        </button>
      </div>

      {/* Main content */}
      <div className="relative flex-1 flex flex-col md:flex-row items-center justify-center gap-8 md:gap-16 px-6 overflow-hidden">
        {/* Album art */}
        <div className="w-64 h-64 sm:w-80 sm:h-80 md:w-96 md:h-96 rounded-lg overflow-hidden shadow-2xl shrink-0">
          <img
            src={coverUrl}
            alt={currentTrack.albumTitle}
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        </div>

        {/* Track info + queue sidebar */}
        <div className="flex flex-col items-center md:items-start gap-4 min-w-0 max-w-md">
          <div className="text-center md:text-left">
            <h2 className="text-2xl sm:text-3xl font-bold truncate max-w-md">
              {currentTrack.title}
            </h2>
            <p className="text-lg text-gray-400 truncate">{currentTrack.artistName}</p>
            <p className="text-sm text-gray-500 truncate">{currentTrack.albumTitle}</p>
            {currentTrack.format && (
              <div className="flex items-center gap-2 mt-2">
                <span className="text-xs px-2 py-0.5 rounded bg-white/10 text-gray-400">
                  {currentTrack.format.toUpperCase()}
                </span>
                {currentTrack.sampleRate && (
                  <span className="text-xs text-gray-500">
                    {(currentTrack.sampleRate / 1000).toFixed(1)} kHz
                  </span>
                )}
                {currentTrack.bitDepth && (
                  <span className="text-xs text-gray-500">{currentTrack.bitDepth}-bit</span>
                )}
              </div>
            )}
          </div>

          {/* Lyrics or Up Next */}
          {showLyrics ? (
            <div className="w-full mt-4">
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Lyrics</p>
              <Suspense fallback={<p className="text-xs text-gray-500">Loading...</p>}>
                <LyricsDisplay />
              </Suspense>
            </div>
          ) : queue.length > 0 && queueIndex < queue.length - 1 ? (
            <div className="w-full mt-4">
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Up Next</p>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {queue.slice(queueIndex + 1, queueIndex + 6).map((track, i) => (
                  <div
                    key={`fn-${i}`}
                    className="flex items-center gap-3 text-sm text-gray-400 py-1"
                  >
                    <span className="text-xs text-gray-600 w-4">{queueIndex + i + 2}</span>
                    <span className="truncate">{track.title}</span>
                    <span className="text-xs text-gray-600 ml-auto shrink-0">
                      {track.artistName}
                    </span>
                  </div>
                ))}
                {queue.length - queueIndex - 1 > 5 && (
                  <p className="text-xs text-gray-600">+{queue.length - queueIndex - 6} more</p>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Controls */}
      <div className="relative px-6 pb-8 pt-4">
        {/* Progress bar / LIVE indicator */}
        {isRadio ? (
          <div className="max-w-2xl mx-auto mb-4 flex items-center justify-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-red-900/40 text-red-300 text-xs font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
              LIVE
            </span>
          </div>
        ) : (
          <div className="max-w-2xl mx-auto mb-4">
            <div
              role="slider"
              tabIndex={0}
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              aria-valuenow={Math.round(currentTime)}
              className="relative h-1.5 bg-white/10 rounded-full cursor-pointer group focus:outline-none focus:ring-1 focus:ring-accent"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const pos = (e.clientX - rect.left) / rect.width;
                seek(pos * duration);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight') seek(Math.min(duration, currentTime + 5));
                else if (e.key === 'ArrowLeft') seek(Math.max(0, currentTime - 5));
                else if (e.key === 'Home') seek(0);
                else if (e.key === 'End') seek(duration);
                else return;
                e.preventDefault();
              }}
            >
              <div
                className="absolute left-0 top-0 h-full bg-accent rounded-full transition-all"
                style={{ width: `${progress}%` }}
              />
              <div
                className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full opacity-0 group-hover:opacity-100 transition"
                style={{ left: `${progress}%`, marginLeft: '-6px' }}
              />
            </div>
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>
        )}

        {/* Playback controls */}
        <div className="flex items-center justify-center gap-6">
          <button
            onClick={toggleShuffle}
            className={`transition ${shuffle ? 'text-accent' : 'text-gray-500 hover:text-white'}`}
            title={shuffle ? 'Shuffle on' : 'Shuffle off'}
            aria-label={shuffle ? 'Shuffle on' : 'Shuffle off'}
            aria-pressed={shuffle}
          >
            <ShuffleIcon size={22} />
          </button>
          <button
            onClick={playPrevious}
            className="text-gray-300 hover:text-white transition"
            title="Previous"
            aria-label="Previous track"
          >
            <PrevIcon size={28} />
          </button>
          <button
            onClick={isLoading ? undefined : isPlaying ? pause : resume}
            disabled={isLoading}
            className={`w-14 h-14 rounded-full flex items-center justify-center transition ${
              isLoading ? 'bg-gray-500 text-surface' : 'bg-white text-surface hover:scale-105'
            }`}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isLoading ? (
              <SpinnerIcon size={26} />
            ) : isPlaying ? (
              <PauseIcon size={26} />
            ) : (
              <PlayIcon size={26} />
            )}
          </button>
          <button
            onClick={playNext}
            className="text-gray-300 hover:text-white transition"
            title="Next"
            aria-label="Next track"
          >
            <NextIcon size={28} />
          </button>
          <button
            onClick={toggleRepeat}
            className={`transition ${repeat !== 'off' ? 'text-accent' : 'text-gray-500 hover:text-white'}`}
            title={repeat === 'off' ? 'Repeat off' : repeat === 'all' ? 'Repeat all' : 'Repeat one'}
            aria-label={
              repeat === 'off' ? 'Repeat off' : repeat === 'all' ? 'Repeat all' : 'Repeat one'
            }
          >
            {repeat === 'one' ? <RepeatOneIcon size={22} /> : <RepeatIcon size={22} />}
          </button>
        </div>

        {/* Volume + Crossfade */}
        <div className="flex items-center justify-center gap-6 mt-4">
          <div className="flex items-center gap-2">
            <VolumeIcon size={18} className="text-gray-400" />
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="w-28 h-1 accent-accent"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Crossfade</span>
            <input
              type="range"
              min={0}
              max={12}
              step={1}
              value={crossfade}
              onChange={(e) => setCrossfade(Number(e.target.value))}
              className="w-20 h-1 accent-accent"
            />
            <span className="text-xs text-gray-500 w-6">{crossfade}s</span>
          </div>
        </div>
      </div>
    </div>
  );
}
