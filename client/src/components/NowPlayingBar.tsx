import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAudioContext } from '../context/AudioContext.js';
import { api } from '../api/client.js';
import DeviceSelector from './DeviceSelector.js';
import { formatTime } from '../utils/format.js';
import SortableList from './SortableList.js';

interface NowPlayingBarProps {
  onExpandClick?: () => void;
}

export default function NowPlayingBar({ onExpandClick }: NowPlayingBarProps) {
  const navigate = useNavigate();
  const {
    currentTrack, isPlaying, isLoading, currentTime, duration, volume,
    pause, resume, setVolume, seek, playNext, playPrevious, queue, queueIndex,
    selectedDeviceId, setSelectedDeviceId, shuffle, repeat, toggleShuffle, toggleRepeat,
    removeFromQueue, moveInQueue, clearQueue,
  } = useAudioContext();
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

  return (
    <div className="relative h-20 bg-surface border-t border-white/10 flex items-center px-2 md:px-4 gap-2 md:gap-4 safe-bottom no-select">
      {/* Cover + Track info */}
      <div className="flex items-center gap-2 md:gap-3 w-40 md:w-72 min-w-0 shrink-0">
        <div
          className="w-10 h-10 md:w-12 md:h-12 rounded bg-surface-dark overflow-hidden shrink-0 cursor-pointer hover:opacity-80 transition"
          onClick={onExpandClick}
          title="Fullscreen view"
        >
          <img
            src={currentTrack.albumId ? api.getAlbumCoverUrl(currentTrack.albumId) : api.getTrackCoverUrl(currentTrack.id)}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        </div>
        <div className="min-w-0 cursor-pointer" onClick={() => {
          if (currentTrack.albumId) navigate(`/albums/${currentTrack.albumId}`);
        }}>
          <p className="text-sm font-medium truncate hover:text-accent transition">
            {currentTrack.title}
            {currentTrack.id.startsWith('spotify:') && (
              <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-green-900/50 text-green-300">spotify</span>
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
                {currentTrack.sampleRate ? `/${(currentTrack.sampleRate / 1000).toFixed(1)}kHz` : ''}
                {currentTrack.bitDepth ? `/${currentTrack.bitDepth}bit` : ''}
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex-1 flex flex-col items-center gap-1">
        <div className="flex items-center gap-3">
          <button
            onClick={toggleShuffle}
            className={`text-sm transition ${shuffle ? 'text-accent' : 'text-gray-500 hover:text-white'}`}
            title={shuffle ? 'Shuffle on' : 'Shuffle off'}
          >
            &#128256;
          </button>
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
          <button
            onClick={toggleRepeat}
            className={`text-sm transition ${repeat !== 'off' ? 'text-accent' : 'text-gray-500 hover:text-white'}`}
            title={repeat === 'off' ? 'Repeat off' : repeat === 'all' ? 'Repeat all' : 'Repeat one'}
          >
            {repeat === 'one' ? '\u{1F502}' : '\u{1F501}'}
          </button>
        </div>
        {selectedDeviceId !== 'browser' && (
          <p className="text-[10px] text-gray-500 mb-0.5">
            Playing on external device
          </p>
        )}
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

      {/* Volume + Queue + Device */}
      <div className="hidden md:flex items-center gap-2 w-64">
        {queue.length > 0 && (
          <button
            onClick={() => setShowQueue(!showQueue)}
            className={`text-xs px-2 py-0.5 rounded transition ${showQueue ? 'bg-accent text-white' : 'text-gray-500 hover:text-white'}`}
          >
            {queueIndex + 1}/{queue.length}
          </button>
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

      {/* Queue panel */}
      {showQueue && queue.length > 0 && (
        <div className="absolute bottom-full right-4 mb-2 w-96 max-h-96 overflow-y-auto bg-surface border border-white/10 rounded-lg shadow-xl z-50">
          <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
            <p className="text-xs text-gray-400 uppercase tracking-wider">Queue ({queue.length} tracks)</p>
            <div className="flex items-center gap-2">
              <button
                onClick={clearQueue}
                className="text-[10px] text-gray-500 hover:text-red-400 transition"
                title="Clear queue"
              >
                Clear
              </button>
              <button onClick={() => setShowQueue(false)} className="text-gray-500 hover:text-white text-sm">&times;</button>
            </div>
          </div>
          <SortableList
            items={queue.map((t, i) => ({ ...t, id: `q-${i}-${t.id}`, _index: i }))}
            onReorder={(from, to) => moveInQueue(from, to)}
            renderItem={(item: any, _i: number) => {
              const idx = item._index;
              const isCurrent = idx === queueIndex;
              return (
                <div className={`group px-2 py-1.5 text-sm flex items-center gap-2 ${
                  isCurrent ? 'text-accent bg-accent/10 rounded' : 'text-gray-400'
                }`}>
                  <span className="w-5 text-xs text-right shrink-0">
                    {isCurrent && isPlaying ? '\u25B6' : idx + 1}
                  </span>
                  <span className="truncate flex-1">{item.title}</span>
                  <span className="text-xs text-gray-600 truncate">{item.artistName}</span>
                  {!isCurrent && (
                    <button
                      onClick={() => removeFromQueue(idx)}
                      className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 text-xs px-1 shrink-0 transition"
                      title="Remove"
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
