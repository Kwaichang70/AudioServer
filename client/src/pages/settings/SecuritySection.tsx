import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useToast } from '../../components/Toast.js';
import { useAuth } from '../../context/AuthContext.js';
import { describeUserAgent, formatWhen, getErrorMessage, type SessionRow } from './shared.js';

export default function SecuritySection() {
  const { user, signOut } = useAuth();
  const { toast } = useToast();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const loadSessions = useCallback(() => {
    api
      .getSessions()
      .then((r) => setSessions(r.data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const changePassword = async () => {
    if (newPassword.length < 8) {
      toast('New password needs at least 8 characters', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await api.changePassword(currentPassword, newPassword);
      toast(`Password changed; ${res.data.revokedSessions} other session(s) signed out`, 'success');
      setCurrentPassword('');
      setNewPassword('');
      loadSessions();
    } catch (err: unknown) {
      toast(getErrorMessage(err, 'Failed to change password'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (session: SessionRow) => {
    try {
      await api.revokeSession(session.id);
      if (session.current) {
        await signOut();
        return;
      }
      toast('Session signed out', 'info');
      loadSessions();
    } catch (err: unknown) {
      toast(getErrorMessage(err, 'Failed to sign out session'), 'error');
    }
  };

  const revokeOthers = async () => {
    try {
      const res = await api.revokeOtherSessions();
      toast(`${res.data.revoked} other session(s) signed out`, 'info');
      loadSessions();
    } catch (err: unknown) {
      toast(getErrorMessage(err, 'Failed to sign out other sessions'), 'error');
    }
  };

  return (
    <section className="mb-10">
      <h3 className="text-lg font-semibold mb-4 text-gray-300">Account &amp; Sessions</h3>
      <div className="bg-surface-light rounded-lg p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{user?.username}</p>
            <p className="text-xs text-gray-500">Role: {user?.role}</p>
          </div>
          <button
            onClick={() => signOut()}
            className="px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded hover:border-accent transition"
          >
            Sign out
          </button>
        </div>

        <div className="space-y-2">
          <p className="text-xs text-gray-500">
            Change password. Other devices are signed out; this one stays signed in.
          </p>
          <div className="flex gap-2 flex-wrap">
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Current password"
              autoComplete="current-password"
              className="flex-1 min-w-[140px] px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
            />
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password (8+ chars)"
              autoComplete="new-password"
              className="flex-1 min-w-[140px] px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
            />
            <button
              onClick={changePassword}
              disabled={busy || !currentPassword || !newPassword}
              className="px-4 py-1.5 text-sm bg-accent rounded hover:bg-accent-hover transition disabled:opacity-50"
            >
              Change
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-500">
              Signed-in devices ({sessions.length}). Sessions expire after 30 days.
            </p>
            {sessions.length > 1 && (
              <button onClick={revokeOthers} className="text-xs text-gray-400 hover:text-white">
                Sign out other devices
              </button>
            )}
          </div>
          {sessions.map((s) => (
            <div key={s.id} className="flex items-center justify-between text-sm">
              <div>
                <span>{describeUserAgent(s.userAgent)}</span>
                {s.current && <span className="ml-2 text-[10px] text-accent">this device</span>}
                <p className="text-xs text-gray-500">
                  Last seen {formatWhen(s.lastSeenAt)} · signed in {formatWhen(s.createdAt)}
                </p>
              </div>
              <button
                onClick={() => revoke(s)}
                className="text-xs text-gray-500 hover:text-red-400 transition"
              >
                {s.current ? 'Sign out' : 'Revoke'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
