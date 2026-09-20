import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useToast } from '../../components/Toast.js';
import { useAuth } from '../../context/AuthContext.js';
import { getErrorMessage, type UserAccount } from './shared.js';

export default function UsersSection() {
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('user');
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const { toast } = useToast();
  const { user: me } = useAuth();

  useEffect(() => {
    api
      .getUsers()
      .then((r) => setUsers(r.data))
      .catch(() => {});
  }, []);

  const handleResetPassword = async (id: string, username: string) => {
    if (resetPassword.length < 8) {
      toast('Password needs at least 8 characters', 'error');
      return;
    }
    try {
      const res = await api.resetUserPassword(id, resetPassword);
      toast(
        `Password for "${username}" reset (${res.data.revokedSessions} session(s) signed out)`,
        'success',
      );
      setResetFor(null);
      setResetPassword('');
    } catch (err: unknown) {
      toast(getErrorMessage(err, 'Failed to reset password'), 'error');
    }
  };

  const handleRevokeSessions = async (id: string, username: string) => {
    try {
      const res = await api.revokeUserSessions(id);
      toast(`"${username}" signed out everywhere (${res.data.revoked} session(s))`, 'info');
    } catch (err: unknown) {
      toast(getErrorMessage(err, 'Failed to revoke sessions'), 'error');
    }
  };

  const handleCreate = async () => {
    if (!newUsername.trim() || !newPassword) return;
    try {
      await api.createUser(newUsername.trim(), newPassword, newRole);
      toast(`User "${newUsername}" created`, 'success');
      setNewUsername('');
      setNewPassword('');
      setShowCreate(false);
      api
        .getUsers()
        .then((r) => setUsers(r.data))
        .catch(() => {});
    } catch (err: unknown) {
      toast(getErrorMessage(err, 'Failed to create user'), 'error');
    }
  };

  const handleDelete = async (id: string, username: string) => {
    try {
      await api.deleteUser(id);
      toast(`User "${username}" deleted`, 'info');
      setUsers((prev) => prev.filter((u) => u.id !== id));
    } catch (err: unknown) {
      toast(getErrorMessage(err, 'Failed to delete user'), 'error');
    }
  };

  return (
    <section className="mb-10">
      <h3 className="text-lg font-semibold mb-4 text-gray-300">User Management</h3>
      <div className="bg-surface-light rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-400">{users.length} user(s)</p>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="px-3 py-1 text-sm bg-accent rounded hover:bg-accent-hover transition"
          >
            + Add User
          </button>
        </div>

        {showCreate && (
          <div className="flex gap-2 flex-wrap">
            <input
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder="Username"
              className="flex-1 min-w-[140px] px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
            />
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Password (8+ chars)"
              className="flex-1 min-w-[140px] px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
            />
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
              className="px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded text-white"
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
            <button
              onClick={handleCreate}
              className="px-4 py-1.5 text-sm bg-accent rounded hover:bg-accent-hover transition"
            >
              Create
            </button>
          </div>
        )}

        {users.map((user) => (
          <div key={user.id} className="py-1 space-y-1">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm">{user.username}</span>
                <span
                  className={`ml-2 text-[10px] px-1.5 py-0.5 rounded ${
                    user.role === 'admin' ? 'bg-accent/20 text-accent' : 'bg-white/5 text-gray-500'
                  }`}
                >
                  {user.role}
                </span>
                {user.id === me?.id && <span className="ml-2 text-[10px] text-gray-500">you</span>}
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setResetFor(resetFor === user.id ? null : user.id);
                    setResetPassword('');
                  }}
                  className="text-xs text-gray-500 hover:text-white transition"
                >
                  Reset password
                </button>
                {user.id !== me?.id && (
                  <button
                    onClick={() => handleRevokeSessions(user.id, user.username)}
                    className="text-xs text-gray-500 hover:text-white transition"
                  >
                    Sign out everywhere
                  </button>
                )}
                {user.role !== 'admin' && (
                  <button
                    onClick={() => handleDelete(user.id, user.username)}
                    className="text-xs text-gray-600 hover:text-red-400 transition"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
            {resetFor === user.id && (
              <div className="flex gap-2">
                <input
                  type="password"
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                  placeholder="New password (8+ chars)"
                  autoComplete="new-password"
                  className="flex-1 px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
                />
                <button
                  onClick={() => handleResetPassword(user.id, user.username)}
                  className="px-3 py-1.5 text-sm bg-accent rounded hover:bg-accent-hover transition"
                >
                  Set
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
