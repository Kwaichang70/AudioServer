import { useAudioContext } from '../context/AudioContext.js';
import { api } from '../api/client.js';
import DeviceSelector from './DeviceSelector.js';

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function NowPlayingBar() {
  const {
    currentTrack, isPlaying, isLoading, currentTime, duration, volume,
    pause, resume, setVolume, seek, playNext, playPrevious, queue,
    selectedDeviceId, setSelectedDeviceId,
  } = useAudioContext();

  if (!currentTrack) {
    return (
      <div className="h-20 bg-surface border-t border-white/10 flex items-center justify-between px-4 text-gray-500">
        <span>No track playing</span>
        <DeviceSelector selectedDeviceId={selectedDeviceId} onSelect={setSelectedDeviceId} />
      </div>
    );
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="h-20 bg-surface border-t border-white/10 flex items-center px-4 gap-4">
      {/* Cover + Track info */}
      <div className="flex items-center gap-3 w-72 min-w-0">
        <div className="w-12 h-12 rounded bg-surface-dark overflow-hidden shrink-0">
          <img
            src={currentTrack.albumId ? api.getAlbumCoverUrl(currentTrack.albumId) : api.getTrackCoverUrl(currentTrack.id)}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">
            {currentTrack.title}
            {currentTrack.id.startsWith('spotify:') && (
              <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-green-900/50 text-green-300">spotify</span>
            )}
          </p>
          <p className="text-xs text-gray-400 truncate">
            {currentTrack.artistName} &mdash; {currentTrack.albumTitle}
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex-1 flex flex-col items-center gap-1">
        <div className="flex items-center gap-4">
          <button
            onClick={playPrevious}
            className="text-gray-400 hover:text-white transition text-lg"
            title="Previous"
          >
            &#9198;
          </button>
          <button
            onClick={isLoading ? undefined : isPlaying ? pause : resume}
            disabled={isLoading}
            className={`w-9 h-9 rounded-full flex items-center justify-center transition text-sm ${
              isLoading ? 'bg-gray-500 text-surface animate-pulse' : 'bg-white text-surface hover:scale-105'
            }`}
          >
            {isLoading ? '\u23F3' : isPlaying ? '\u23F8' : '\u25B6'}
          </button>
          <button
            onClick={playNext}
            className="text-gray-400 hover:text-white transition text-lg"
            title="Next"
          >
            &#9197;
          </button>
        </div>
        <div className="w-full max-w-lg flex items-center gap-2 text-xs text-gray-400">
          <span className="w-10 text-right">{formatTime(currentTime)}</span>
          <div className="flex-1 relative h-1 bg-white/10 rounded group cursor-pointer"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const pos = (e.clientX - rect.left) / rect.width;
              seek(pos * duration);
            }}
          >
            <div
              className="absolute left-0 top-0 h-full bg-accent rounded"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="w-10">{formatTime(duration)}</span>
        </div>
      </div>

      {/* Volume + Device + Queue */}
      <div className="flex items-center gap-3 w-56">
        {queue.length > 0 && (
          <span className="text-xs text-gray-500">{queue.length} in queue</span>
        )}
        <div className="flex items-center gap-1.5 flex-1">
          <span className="text-xs text-gray-500">&#128264;</span>
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
        <DeviceSelector
          selectedDeviceId={selectedDeviceId}
          onSelect={setSelectedDeviceId}
        />
      </div>
    </div>
  );
}
