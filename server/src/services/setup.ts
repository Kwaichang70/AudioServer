import { randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { config } from '../config.js';
import { getRawDb } from '../db/index.js';
import { logger } from '../logger.js';

/**
 * First-run setup (V02.1).
 *
 * Until the first account exists, the API is closed except for the setup
 * routes. Creating that first (admin) account requires a one-time setup code
 * that only someone with access to the server itself can read: it is printed
 * to the server log and written next to the database (`setup-code.txt`).
 * Operators who prefer to choose it set `SETUP_CODE` in the environment.
 *
 * This closes the window in which two visitors of a fresh installation could
 * race for the admin account, without adding an interactive install wizard.
 */

let generatedCode: string | null = null;

export function isSetupRequired(): boolean {
  const row = getRawDb().prepare('SELECT COUNT(*) AS count FROM users').get() as
    | { count: number }
    | undefined;
  return !row || row.count === 0;
}

export function setupCodePath(): string {
  return join(dirname(resolve(config.databasePath)), 'setup-code.txt');
}

function formatCode(bytes: Buffer): string {
  // 8 hex chars split in two groups: easy to read off a log line or a phone.
  const hex = bytes.toString('hex').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

/**
 * The code that unlocks first registration, or null once a user exists.
 * Generated lazily so a test can read it, and persisted to disk so a restart
 * before the first registration does not change it under the operator.
 */
export function getSetupCode(): string | null {
  if (!isSetupRequired()) return null;
  const fromEnv = process.env.SETUP_CODE?.trim();
  if (fromEnv) return fromEnv;
  if (generatedCode) return generatedCode;
  generatedCode = formatCode(randomBytes(4));
  try {
    const path = setupCodePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${generatedCode}\n`, { mode: 0o600 });
  } catch (err) {
    logger.warn(`Setup: could not write setup-code file: ${err}`);
  }
  return generatedCode;
}

export function setupCodeSource(): 'env' | 'generated' {
  return process.env.SETUP_CODE?.trim() ? 'env' : 'generated';
}

export function verifySetupCode(candidate: unknown): boolean {
  const expected = getSetupCode();
  if (!expected || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate.trim().toUpperCase());
  const b = Buffer.from(expected.trim().toUpperCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Called after the first account exists: the code must not linger on disk. */
export function clearSetupCode(): void {
  generatedCode = null;
  try {
    const path = setupCodePath();
    if (existsSync(path)) rmSync(path, { force: true });
  } catch {
    // best effort
  }
}

/** Startup hook: make the code visible to the operator while setup is pending. */
export function announceSetupIfRequired(): void {
  if (!isSetupRequired()) {
    clearSetupCode();
    return;
  }
  const code = getSetupCode();
  const where =
    setupCodeSource() === 'env' ? 'taken from SETUP_CODE' : `also written to ${setupCodePath()}`;
  logger.warn(
    `No user accounts yet. Open the app and create the admin account with setup code ${code} (${where}).`,
  );
}
