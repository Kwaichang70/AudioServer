import { useAudioContext } from '../context/AudioContext.js';

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function NowPlayingBar() {
  const { currentTrack, isPlaying, currentTime, duration, volume, pause, resume, setVolume, seek } =
    useAudioContext();

  if (!currentTrack) {
    return (
      <div className="h-20 bg-surface border-t border-white/10 flex items-center justify-center text-gray-500">
        No track playing
      </div>
    );
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="h-20 bg-surface border-t border-white/10 flex items-center px-6 gap-6">
      {/* Track info */}
      <div className="w-64 min-w-0">
        <p className="text-sm font-medium truncate">{currentTrack.title}</p>
        <p className="text-xs text-gray-400 truncate">
          {currentTrack.artistName} — {currentTrack.albumTitle}
        </p>
      </div>

      {/* Controls */}
      <div className="flex-1 flex flex-col items-center gap-1">
        <button
          onClick={isPlaying ? pause : resume}
          className="w-10 h-10 rounded-full bg-accent hover:bg-accent-hover flex items-center justify-center transition"
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
        <div className="w-full max-w-lg flex items-center gap-2 text-xs text-gray-400">
          <span>{formatTime(currentTime)}</span>
          <input
            type="range"
            min={0}
            max={duration || 0}
            value={currentTime}
            onChange={(e) => seek(Number(e.target.value))}
            className="flex-1 h-1 accent-accent"
          />
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* Volume */}
      <div className="flex items-center gap-2 w-36">
        <span className="text-xs text-gray-400">Vol</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          className="flex-1 h-1 accent-accent"
        />
      </div>
    </div>
  );
}
