import { useAudioContext, type ReplayGainMode } from '../../context/AudioContext.js';

/** ReplayGain and the volume it levels (R02.4: moved out of SettingsPage). */
export default function PlaybackSection() {
  const { replayGainMode, setReplayGainMode, replayGainPreamp, setReplayGainPreamp } =
    useAudioContext();

  return (
    <section className="mb-10">
      <h3 className="text-lg font-semibold mb-4 text-gray-300">Playback</h3>
      <div className="bg-surface-light rounded-lg p-4 space-y-4">
        <div>
          <p className="text-sm font-medium mb-1">ReplayGain mode</p>
          <p className="text-xs text-gray-500 mb-2">
            Normalise volume across tracks using metadata tags. Track-mode levels every song
            individually; album-mode preserves intentional loudness differences within an album. Off
            disables normalisation entirely.
          </p>
          <div className="flex gap-2">
            {(['off', 'track', 'album'] as ReplayGainMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setReplayGainMode(m)}
                className={`px-3 py-1.5 text-sm rounded border transition ${
                  replayGainMode === m
                    ? 'bg-accent border-accent text-white'
                    : 'bg-surface-dark border-white/10 hover:border-accent'
                }`}
              >
                {m === 'off' ? 'Off' : m === 'track' ? 'Track' : 'Album'}
              </button>
            ))}
          </div>
        </div>

        <div className="pt-3 border-t border-white/5">
          <div className="flex items-center justify-between mb-1">
            <p className="text-sm font-medium">Preamp</p>
            <span className="text-xs text-gray-400 tabular-nums">
              {replayGainPreamp > 0 ? '+' : ''}
              {replayGainPreamp.toFixed(1)} dB
            </span>
          </div>
          <p className="text-xs text-gray-500 mb-2">
            Global gain offset applied on top of ReplayGain. Use +6&nbsp;dB if normalised tracks
            sound too quiet, &minus;3&nbsp;dB if they clip on aggressive masters.
          </p>
          <input
            type="range"
            min={-15}
            max={15}
            step={0.5}
            value={replayGainPreamp}
            onChange={(e) => setReplayGainPreamp(Number(e.target.value))}
            className="w-full accent-accent"
          />
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>&minus;15 dB</span>
            <span>0</span>
            <span>+15 dB</span>
          </div>
        </div>
      </div>
    </section>
  );
}
