/**
 * Locked out of the app? Run this in the container:
 *
 *   npm run user:password --workspace=server              → list the users
 *   npm run user:password --workspace=server -- <user>    → set a new password
 *
 * With docker, use `docker exec -it` so the password can be typed unseen.
 * It works while the server runs; the user is signed out everywhere.
 */
import Database from 'better-sqlite3';
import { createInterface } from 'readline';
import { config } from '../config.js';
import { listUsers, setUserPassword, MIN_PASSWORD_LENGTH } from '../services/user-recovery.js';

/** Ask a question without echoing what is typed (when on a terminal). */
function askHidden(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let asked = false;
  const out = rl as unknown as { _writeToOutput: (s: string) => void };
  out._writeToOutput = (s: string) => {
    if (!asked) {
      process.stdout.write(s);
      asked = true;
    }
  };
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main(): Promise<number> {
  const db = new Database(config.databasePath, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  try {
    const name = process.argv[2];
    if (!name) {
      const users = listUsers(db);
      if (users.length === 0) console.log('No users yet: open the app and create the first one.');
      for (const u of users) console.log(`${u.username} (${u.role})`);
      return 0;
    }
    if (!process.stdin.isTTY) {
      console.error('Run this with "docker exec -it" so the password can be typed unseen.');
      return 1;
    }
    const first = await askHidden(
      `New password for ${name} (at least ${MIN_PASSWORD_LENGTH} characters): `,
    );
    const second = await askHidden('Type it again: ');
    if (first !== second) {
      console.error('The two passwords differ; nothing changed.');
      return 1;
    }
    const r = await setUserPassword(db, name, first);
    console.log(
      `Password of ${r.username} changed; ${r.revokedSessions} session(s) signed out. Log in with the new password.`,
    );
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    db.close();
  }
}

process.exit(await main());
