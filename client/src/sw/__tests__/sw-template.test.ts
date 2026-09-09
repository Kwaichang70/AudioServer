import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Runs the production service-worker template against a fake worker global
 * (V08.1). What must hold: API calls are never intercepted, an offline
 * navigation gets the cached shell (or offline.html), the cover cache is
 * capped, only audioserver-* caches are deleted, and a new worker only
 * takes over on SKIP_WAITING.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (event: any) => void;

interface FakeCache {
  store: Map<string, Response>;
  match(req: Request | string): Promise<Response | undefined>;
  put(req: Request | string, res: Response): Promise<void>;
  add(req: Request | string): Promise<void>;
  delete(req: Request | string): Promise<boolean>;
  keys(): Promise<Request[]>;
}

function keyOf(req: Request | string): string {
  return typeof req === 'string' ? new URL(req, 'https://nas.local').toString() : req.url;
}

function makeCaches() {
  const cachesMap = new Map<string, FakeCache>();
  const open = async (name: string): Promise<FakeCache> => {
    let c = cachesMap.get(name);
    if (!c) {
      const store = new Map<string, Response>();
      c = {
        store,
        match: async (req) => store.get(keyOf(req))?.clone(),
        put: async (req, res) => {
          store.set(keyOf(req), res);
        },
        add: async (req) => {
          store.set(keyOf(req), new Response('cached ' + keyOf(req)));
        },
        delete: async (req) => store.delete(keyOf(req)),
        keys: async () => Array.from(store.keys()).map((k) => new Request(k)),
      };
      cachesMap.set(name, c);
    }
    return c;
  };
  return {
    map: cachesMap,
    api: {
      open,
      keys: async () => Array.from(cachesMap.keys()),
      delete: async (name: string) => cachesMap.delete(name),
      match: async (req: Request | string) => {
        for (const c of cachesMap.values()) {
          const hit = await c.match(req);
          if (hit) return hit;
        }
        return undefined;
      },
    },
  };
}

function loadWorker(precache: string[]) {
  const template = readFileSync(resolve(__dirname, '../../../sw/sw.template.js'), 'utf8')
    .replace('__BUILD_ID__', 'test1')
    .replace('__PRECACHE__', JSON.stringify(precache));
  const listeners = new Map<string, Handler>();
  const caches = makeCaches();
  const fetchMock = vi.fn();
  const self = {
    location: { origin: 'https://nas.local' },
    addEventListener: (type: string, fn: Handler) => listeners.set(type, fn),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => {}) },
  };
  // Inside a worker, relative URLs resolve against the worker's location.
  class WorkerRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(
        typeof input === 'string' ? new URL(input, 'https://nas.local').toString() : input,
        init,
      );
    }
  }
  const fn = new Function('self', 'caches', 'fetch', 'Request', 'Response', 'URL', template);
  fn(self, caches.api, fetchMock, WorkerRequest, Response, URL);
  const dispatchFetch = async (request: Request, mode?: string) => {
    const holder: { response: Promise<Response> | null } = { response: null };
    // Node's Request refuses mode 'navigate'; the worker only reads url, method and mode.
    const navRequest = mode ? { url: request.url, method: request.method, mode } : request;
    const event = {
      request: navRequest,
      respondWith: (p: Promise<Response>) => {
        holder.response = p;
      },
    };
    listeners.get('fetch')!(event);
    return holder.response ? await holder.response : null;
  };
  const waitUntil = async (type: string, extra: object = {}) => {
    let pending: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ waitUntil: (p: Promise<unknown>) => (pending = p), ...extra });
    await pending;
  };
  return { self, caches, fetchMock, dispatchFetch, waitUntil, listeners };
}

describe('service worker template', () => {
  let w: ReturnType<typeof loadWorker>;

  beforeEach(() => {
    w = loadWorker(['/index.html', '/offline.html', '/assets/app-abc.js']);
  });

  it('precaches the shell on install and drops only its own stale caches on activate', async () => {
    await w.caches.api.open('audioserver-shell-old');
    await w.caches.api.open('audioserver-covers-v3');
    await w.caches.api.open('other-app-cache');
    await w.waitUntil('install');
    expect(w.caches.map.get('audioserver-shell-test1')!.store.size).toBe(3);
    await w.waitUntil('activate');
    expect(await w.caches.api.keys()).toEqual([
      'audioserver-covers-v3',
      'other-app-cache',
      'audioserver-shell-test1',
    ]);
    expect(w.self.clients.claim).toHaveBeenCalled();
  });

  it('never intercepts API or socket requests, nor other origins or non-GET', async () => {
    expect(await w.dispatchFetch(new Request('https://nas.local/api/playback/session'))).toBeNull();
    expect(await w.dispatchFetch(new Request('https://nas.local/socket.io/?x=1'))).toBeNull();
    expect(await w.dispatchFetch(new Request('https://cdn.example/x.js'))).toBeNull();
    expect(
      await w.dispatchFetch(new Request('https://nas.local/assets/app-abc.js', { method: 'POST' })),
    ).toBeNull();
    expect(w.fetchMock).not.toHaveBeenCalled();
  });

  it('serves a navigation from the network, and from the cached shell when offline', async () => {
    await w.waitUntil('install');
    w.fetchMock.mockResolvedValueOnce(new Response('fresh html'));
    const online = await w.dispatchFetch(new Request('https://nas.local/albums/1'), 'navigate');
    expect(await online!.text()).toBe('fresh html');

    w.fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    const offline = await w.dispatchFetch(new Request('https://nas.local/albums/1'), 'navigate');
    expect(await offline!.text()).toContain('cached https://nas.local/index.html');
  });

  it('falls back to offline.html, then a plain 503, when no shell is cached', async () => {
    const bare = loadWorker(['/offline.html']);
    await bare.waitUntil('install');
    bare.fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    const res = await bare.dispatchFetch(new Request('https://nas.local/'), 'navigate');
    expect(await res!.text()).toContain('offline.html');

    const empty = loadWorker([]);
    empty.fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    const none = await empty.dispatchFetch(new Request('https://nas.local/'), 'navigate');
    expect(none!.status).toBe(503);
  });

  it('caches covers under a token-free key and caps the cache', async () => {
    for (let i = 0; i < 402; i++) {
      w.fetchMock.mockResolvedValueOnce(new Response(`img${i}`));
      await w.dispatchFetch(
        new Request(`https://nas.local/api/library/albums/a${i}/cover?t=tok${i}`),
      );
    }
    const covers = w.caches.map.get('audioserver-covers-v3')!;
    expect(covers.store.size).toBe(400);
    expect(Array.from(covers.store.keys())[0]).toBe(
      'https://nas.local/api/library/albums/a2/cover',
    );
    // Same cover with a fresh token: served from cache, no fetch.
    const calls = w.fetchMock.mock.calls.length;
    const hit = await w.dispatchFetch(
      new Request('https://nas.local/api/library/albums/a401/cover?t=other'),
    );
    expect(await hit!.text()).toBe('img401');
    expect(w.fetchMock.mock.calls.length).toBe(calls);
  });

  it('takes over only on SKIP_WAITING and reports its build id', async () => {
    w.listeners.get('message')!({ data: { type: 'noise' } });
    expect(w.self.skipWaiting).not.toHaveBeenCalled();
    w.listeners.get('message')!({ data: { type: 'SKIP_WAITING' } });
    expect(w.self.skipWaiting).toHaveBeenCalledTimes(1);
    const port = { postMessage: vi.fn() };
    w.listeners.get('message')!({ data: { type: 'GET_VERSION' }, ports: [port] });
    expect(port.postMessage).toHaveBeenCalledWith({ buildId: 'test1' });
  });
});
