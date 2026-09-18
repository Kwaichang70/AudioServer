import { useEffect, useState } from 'react';
import type { OutputDevice } from '@audioserver/shared';
import { api } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';
import { useToast } from './Toast.js';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Rooms (R00.4). Zones arrived in V10 with working endpoints and a room picker
 * in the player, but no way to make a room: creating, renaming and removing one
 * needed `curl`. A device belongs to at most one room — the server keeps that
 * as a UNIQUE index and answers 409 — so the picker below offers only outputs
 * no room has claimed, and still shows the server's own message when a room was
 * created elsewhere in the meantime. The default room cannot be removed: it is
 * where a client without a room lands.
 */
export default function ZonesSection() {
  const { zones, refreshZones } = useAudioContext();
  const { toast } = useToast();
  const [devices, setDevices] = useState<OutputDevice[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDeviceId, setNewDeviceId] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getDevices()
      .then((res) => setDevices(Array.isArray(res.data) ? res.data : []))
      .catch(() => {});
  }, []);

  const deviceName = (deviceId: string) => devices.find((d) => d.id === deviceId)?.name ?? deviceId;
  const claimed = new Set(zones.map((z) => z.deviceId));
  const free = devices.filter((d) => !claimed.has(d.id));

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || !newDeviceId) {
      toast('A room needs a name and an output device', 'error');
      return;
    }
    setBusy(true);
    try {
      await api.createZone(name, newDeviceId);
      toast(`Room "${name}" added`, 'success');
      setNewName('');
      setNewDeviceId('');
      setShowCreate(false);
      refreshZones();
    } catch (err) {
      // 409: that speaker already plays in another room, and the server says which.
      toast(errorMessage(err, 'Could not add the room'), 'error');
      refreshZones();
    } finally {
      setBusy(false);
    }
  };

  const handleRename = async (id: string) => {
    const name = renameValue.trim();
    if (!name) return;
    setBusy(true);
    try {
      await api.renameZone(id, name);
      setRenaming(null);
      refreshZones();
    } catch (err) {
      toast(errorMessage(err, 'Could not rename the room'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Remove the room "${name}"? Its queue stops and the output becomes free.`))
      return;
    setBusy(true);
    try {
      await api.deleteZone(id);
      toast(`Room "${name}" removed`, 'info');
      refreshZones();
    } catch (err) {
      toast(errorMessage(err, 'Could not remove the room'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-10">
      <h3 className="text-lg font-semibold mb-4 text-gray-300">Rooms</h3>
      <div className="bg-surface-light rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-gray-400">
            {zones.length} room(s); each one has its own queue, volume and output
          </p>
          <button
            onClick={() => setShowCreate(!showCreate)}
            disabled={free.length === 0}
            title={free.length === 0 ? 'Every known output already belongs to a room' : undefined}
            className="shrink-0 px-3 py-1 text-sm bg-accent rounded hover:bg-accent-hover transition disabled:opacity-40 disabled:hover:bg-accent"
          >
            + Add Room
          </button>
        </div>

        {showCreate && (
          <div className="flex gap-2 flex-wrap">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Room name (e.g. Kitchen)"
              aria-label="Room name"
              className="flex-1 min-w-[140px] px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
            />
            <select
              value={newDeviceId}
              onChange={(e) => setNewDeviceId(e.target.value)}
              aria-label="Output device"
              className="px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded text-white"
            >
              <option value="">Choose an output</option>
              {free.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <button
              onClick={handleCreate}
              disabled={busy}
              className="px-4 py-1.5 text-sm bg-accent rounded hover:bg-accent-hover transition disabled:opacity-40"
            >
              Create
            </button>
          </div>
        )}

        {zones.map((zone) => (
          <div key={zone.id} className="py-1">
            <div className="flex items-center justify-between gap-2">
              {renaming === zone.id ? (
                <div className="flex gap-2 flex-wrap">
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    aria-label={`New name for ${zone.name}`}
                    className="px-2 py-1 text-sm bg-surface-dark border border-white/10 rounded text-white focus:outline-none focus:border-accent"
                  />
                  <button
                    onClick={() => handleRename(zone.id)}
                    disabled={busy}
                    className="px-3 py-1 text-xs bg-accent rounded hover:bg-accent-hover transition disabled:opacity-40"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setRenaming(null)}
                    className="px-3 py-1 text-xs text-gray-500 hover:text-white transition"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <div className="min-w-0">
                    <p className="text-sm truncate">
                      {zone.name}
                      {zone.isDefault && (
                        <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-gray-500">
                          default
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-gray-500 truncate">
                      {deviceName(zone.deviceId)}
                      {` · ${zone.state}`}
                      {zone.track ? ` · ${zone.track.title}` : ''}
                    </p>
                  </div>
                  <div className="flex gap-3 shrink-0">
                    <button
                      onClick={() => {
                        setRenaming(zone.id);
                        setRenameValue(zone.name);
                      }}
                      className="text-xs text-gray-500 hover:text-white transition"
                    >
                      Rename
                    </button>
                    {!zone.isDefault && (
                      <button
                        onClick={() => handleDelete(zone.id, zone.name)}
                        className="text-xs text-gray-600 hover:text-red-400 transition"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
