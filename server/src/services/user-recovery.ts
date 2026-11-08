import type Database from 'better-sqlite3';
import { hashPassword } from '../middleware/auth.js';

/**
 * Recovery for someone locked out of the app, run on the server itself
 * (npm run user:password). Only who can run commands in the container can
 * use it, which is the same person who can read the database anyway.
 */

type Db = InstanceType<typeof Database>;

export interface UserSummary {
  username: string;
  role: string;
}

export function listUsers(db: Db): UserSummary[] {
  return db.prepare('SELECT username, role FROM users ORDER BY username').all() as UserSummary[];
}

/** The user by name: exact first, otherwise ignoring case when that is unambiguous. */
export function findUser(db: Db, name: string): { id: string; username: string } | null {
  const exact = db.prepare('SELECT id, username FROM users WHERE username = ?').get(name) as
    { id: string; username: string } | undefined;
  if (exact) return exact;
  const loose = db
    .prepare('SELECT id, username FROM users WHERE lower(username) = lower(?)')
    .all(name) as Array<{ id: string; username: string }>;
  return loose.length === 1 ? loose[0] : null;
}

export const MIN_PASSWORD_LENGTH = 8;
/** bcrypt reads at most 72 bytes; a longer password would be cut off silently (B12). */
export const MAX_PASSWORD_BYTES = 72;

/**
 * Set a new password and sign the user out everywhere, as the admin reset in
 * the app does. Sessions are checked against the database on every request,
 * so a running server honours the revocation at once.
 */
export async function setUserPassword(
  db: Db,
  name: string,
  password: string,
): Promise<{ username: string; revokedSessions: number }> {
  if (
    password.length < MIN_PASSWORD_LENGTH ||
    Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES
  ) {
    throw new Error(
      `The password must be at least ${MIN_PASSWORD_LENGTH} characters and at most ${MAX_PASSWORD_BYTES} bytes.`,
    );
  }
  const user = findUser(db, name);
  if (!user) throw new Error(`No user "${name}".`);
  const hash = await hashPassword(password);
  const now = Date.now();
  const revoked = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    return db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(now, user.id).changes;
  })();
  return { username: user.username, revokedSessions: revoked };
}
