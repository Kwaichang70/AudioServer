import { spawn, type ChildProcess } from 'child_process';
import { createServer } from 'net';
import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, afterAll } from 'vitest';

/**
 * V01.1 startup/shutdown proof.
 *
 * Boots the REAL entrypoint (server/src/index.ts) as a child process with a
 * throwaway database and an empty music folder, no provider credentials and no
 * device hints, so nothing on the LAN or the internet is contacted. Then it
 * checks liveness + readiness and asks the process to shut down gracefully.
 *
 * This is deliberately a black-box test: the unit suites mount routers on a
 * bare Express app, so they never prove that `main()` wires everything up in
 * the right order or that SIGTERM actually ends the process.
 */

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitFor(url: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

function waitForExit(child: ChildProcess, timeoutMs: number) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveExit({ code: null, signal: 'SIGKILL' });
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

describe('server startup and shutdown (smoke)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'audioserver-smoke-'));
  const musicDir = join(tmp, 'music');
  mkdirSync(musicDir);
  let child: ChildProcess | undefined;
  let output = '';

  afterAll(async () => {
    if (child && child.exitCode === null && !child.killed) {
      child.kill('SIGKILL');
      await waitForExit(child, 5_000);
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it(
    'boots the real entrypoint, answers liveness/readiness and stops on SIGTERM',
    {
      timeout: 60_000,
    },
    async () => {
      const port = await freePort();
      child = spawn(process.execPath, ['--import', 'tsx/esm', 'src/index.ts'], {
        cwd: serverDir,
        env: {
          // Keep PATH so `tsx` and native modules resolve, drop everything else
          // (a developer's .env-style variables must not leak in).
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          NODE_ENV: 'production',
          PORT: String(port),
          DATABASE_PATH: join(tmp, 'smoke.db'),
          MUSIC_LIBRARY_PATHS: musicDir,
          JWT_SECRET: 'smoke-test-secret-that-is-long-enough-for-production-checks',
          LOG_FORMAT: 'json',
          LOG_LEVEL: 'info',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (chunk) => (output += chunk.toString()));
      child.stderr?.on('data', (chunk) => (output += chunk.toString()));

      const base = `http://127.0.0.1:${port}`;
      const live = await waitFor(`${base}/api/health/live`, 30_000).then((r) => r.json());
      expect(live.status).toBe('ok');

      const readyRes = await waitFor(`${base}/api/health/ready`, 15_000);
      const ready = await readyRes.json();
      expect(readyRes.status).toBe(200);
      expect(ready.status).toBe('ready');
      expect(ready.db.status).toBe('ok');

      // Fresh database → setup mode: the public surface is setup-status plus
      // the probes; full diagnostics need a session.
      const setup = await fetch(`${base}/api/auth/setup-status`).then((r) => r.json());
      expect(setup.data.needsSetup).toBe(true);
      const anonymousHealth = await fetch(`${base}/api/health`);
      expect(anonymousHealth.status).toBe(401);
      expect(output).toContain('setup code');

      // Anonymous requests never learn which routes exist.
      const anonymousMissing = await fetch(`${base}/api/does-not-exist`);
      expect(anonymousMissing.status).toBe(401);

      // Complete setup the way an operator would: read the code the server
      // wrote next to the database, create the admin, use the session.
      const setupCode = readFileSync(join(tmp, 'setup-code.txt'), 'utf8').trim();
      expect(setupCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
      const register = await fetch(`${base}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'smoke-test-pass', setupCode }),
      });
      expect(register.status).toBe(200);
      const token = (await register.json()).data.token as string;
      expect(existsSync(join(tmp, 'setup-code.txt'))).toBe(false);
      const auth = { Authorization: `Bearer ${token}` };

      const health = await fetch(`${base}/api/health`, { headers: auth }).then((r) => r.json());
      expect(health.status).toBe('ok');
      expect(health.library.tracks).toBe(0);

      // Unknown API routes must be a JSON 404 even in production (no SPA fallback).
      const missing = await fetch(`${base}/api/does-not-exist`, { headers: auth });
      expect(missing.status).toBe(404);

      child.kill('SIGTERM');
      const exit = await waitForExit(child, 15_000);
      if (process.platform === 'win32') {
        // Windows has no SIGTERM; kill() terminates the process hard.
        expect(exit.signal ?? exit.code).not.toBeNull();
      } else {
        expect(exit, `server did not exit cleanly.\n${output}`).toEqual({ code: 0, signal: null });
        expect(output).toContain('Shutdown complete');
      }
    },
  );
});
