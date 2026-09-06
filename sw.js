const CACHE_PREFIX = 'mogucchu-offline-';
const OLD_CACHE_PREFIX = 'mogucchu-adventure-';
const COMPLETE_MARKER = new URL('__mogucchu_complete__', self.registration.scope).toString();
const scopeUrl = (path) => new URL(path, self.registration.scope).toString();
const requestedVersion = new URL(self.location.href).searchParams.get('app-version');
let activeCacheName = null;
let installPromise = null;

function broadcast(message) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((clients) => Promise.all(clients.map((client) => client.postMessage(message))));
}

async function completeCaches() {
  const versionParts = (name) => name.slice(CACHE_PREFIX.length).split('.').map((part) => Number(part));
  const names = (await caches.keys()).filter((name) => name.startsWith(CACHE_PREFIX)).sort((left, right) => {
    const a = versionParts(left); const b = versionParts(right);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      if ((a[index] || 0) !== (b[index] || 0)) return (b[index] || 0) - (a[index] || 0);
    }
    return 0;
  });
  const complete = [];
  for (const name of names) {
    const cache = await caches.open(name);
    if (await cache.match(COMPLETE_MARKER)) complete.push(name);
  }
  return complete;
}

async function findActiveCache() {
  if (activeCacheName) return activeCacheName;
  activeCacheName = (await completeCaches())[0] || null;
  return activeCacheName;
}

async function validNetworkResponse(path, response) {
  if (!response || !response.ok || response.redirected || new URL(response.url).origin !== self.location.origin) return false;
  const type = (response.headers.get('content-type') || '').toLowerCase();
  if (/\.(?:png|jpe?g|webp|gif|svg)$/.test(path)) return type.startsWith('image/');
  if (/\.(?:wav|mp3|m4a|aac|ogg)$/.test(path)) return type.startsWith('audio/') || type.includes('octet-stream');
  if (path.endsWith('.css')) return type.includes('text/css');
  if (/\.(?:js|mjs)$/.test(path)) return type.includes('javascript');
  if (path.endsWith('.json') || path.endsWith('.webmanifest')) return type.includes('json') || type.includes('manifest');
  if (path.endsWith('.html')) return type.includes('text/html');
  return true;
}

async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fetchManifest() {
  const response = await fetch(scopeUrl('offline-assets.json'), { cache: 'no-store', credentials: 'include' });
  if (!await validNetworkResponse('offline-assets.json', response)) throw new Error('login');
  const manifest = await response.json();
  if (!manifest || !/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(manifest.version)
    || !Number.isSafeInteger(manifest.totalBytes) || !Array.isArray(manifest.assets) || manifest.assets.length < 10) throw new Error('manifest');
  return manifest;
}

async function installOfflinePackage() {
  try {
    if (/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(requestedVersion || '')) {
      const requestedCache = `${CACHE_PREFIX}${requestedVersion}`;
      const cached = await caches.open(requestedCache);
      const marker = await cached.match(COMPLETE_MARKER);
      if (marker) {
        const detail = await marker.json().catch(() => ({}));
        activeCacheName = requestedCache;
        await broadcast({ type: 'OFFLINE_STATUS', phase: 'ready', version: requestedVersion, totalBytes: detail.totalBytes });
        return;
      }
    }
    const manifest = await fetchManifest();
    const cacheName = `${CACHE_PREFIX}${manifest.version}`;
    const cache = await caches.open(cacheName);
    if (await cache.match(COMPLETE_MARKER)) {
      activeCacheName = cacheName;
      await broadcast({ type: 'OFFLINE_STATUS', phase: 'ready', version: manifest.version, done: manifest.assets.length, total: manifest.assets.length, bytes: manifest.totalBytes, totalBytes: manifest.totalBytes });
      return;
    }
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      const free = (estimate.quota || 0) - (estimate.usage || 0);
      if (estimate.quota && free < manifest.totalBytes * 1.15) throw new Error('space');
    }
    let done = 0;
    let bytes = 0;
    await broadcast({ type: 'OFFLINE_STATUS', phase: 'downloading', version: manifest.version, done, total: manifest.assets.length, bytes, totalBytes: manifest.totalBytes });
    for (const asset of manifest.assets) {
      if (!asset || typeof asset.path !== 'string' || asset.path.startsWith('/') || asset.path.includes('..')
        || !Number.isSafeInteger(asset.bytes) || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('manifest');
      const url = scopeUrl(asset.path);
      const cached = await cache.match(url);
      if (cached) {
        const cachedBytes = await cached.clone().arrayBuffer();
        if (cachedBytes.byteLength === asset.bytes && await sha256(cachedBytes) === asset.sha256) {
          done += 1; bytes += asset.bytes;
          if (done % 8 === 0 || done === manifest.assets.length) await broadcast({ type: 'OFFLINE_STATUS', phase: 'downloading', version: manifest.version, done, total: manifest.assets.length, bytes, totalBytes: manifest.totalBytes });
          continue;
        }
        await cache.delete(url);
      }
      const response = await fetch(url, { cache: 'reload', credentials: 'include' });
      if (!await validNetworkResponse(asset.path, response)) throw new Error('login');
      const responseForCache = response.clone();
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== asset.bytes || await sha256(buffer) !== asset.sha256) throw new Error('integrity');
      await cache.put(url, responseForCache);
      done += 1; bytes += asset.bytes;
      if (done % 8 === 0 || done === manifest.assets.length) await broadcast({ type: 'OFFLINE_STATUS', phase: 'downloading', version: manifest.version, done, total: manifest.assets.length, bytes, totalBytes: manifest.totalBytes });
    }
    await cache.put(COMPLETE_MARKER, new Response(JSON.stringify({ version: manifest.version, totalBytes: manifest.totalBytes }), { headers: { 'content-type': 'application/json' } }));
    activeCacheName = cacheName;
    const allNames = await caches.keys();
    await Promise.all(allNames.filter((name) => (name.startsWith(CACHE_PREFIX) && name !== cacheName) || name.startsWith(OLD_CACHE_PREFIX)).map((name) => caches.delete(name)));
    await broadcast({ type: 'OFFLINE_STATUS', phase: 'ready', version: manifest.version, done, total: manifest.assets.length, bytes: manifest.totalBytes, totalBytes: manifest.totalBytes });
  } catch (error) {
    const ready = await findActiveCache();
    await broadcast({ type: 'OFFLINE_STATUS', phase: ready ? 'ready-old' : 'error', reason: error instanceof Error ? error.message : 'network' });
  }
}

function ensureOfflinePackage() {
  if (!installPromise) installPromise = installOfflinePackage().finally(() => { installPromise = null; });
  return installPromise;
}

async function sendStatus() {
  const name = await findActiveCache();
  if (!name) return broadcast({ type: 'OFFLINE_STATUS', phase: 'not-saved' });
  const cache = await caches.open(name);
  const marker = await cache.match(COMPLETE_MARKER);
  const detail = marker ? await marker.json().catch(() => ({})) : {};
  return broadcast({ type: 'OFFLINE_STATUS', phase: 'ready', version: detail.version, totalBytes: detail.totalBytes });
}

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  if (event.data?.type === 'DOWNLOAD_OFFLINE') event.waitUntil(ensureOfflinePackage());
  if (event.data?.type === 'GET_OFFLINE_STATUS') event.waitUntil(sendStatus());
  if (event.data?.type === 'CLEAR_OFFLINE') event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) || name.startsWith(OLD_CACHE_PREFIX)).map((name) => caches.delete(name)));
    activeCacheName = null;
    await broadcast({ type: 'OFFLINE_STATUS', phase: 'not-saved' });
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (['version.json', 'offline-assets.json', 'sw.js'].some((name) => url.pathname.endsWith(`/${name}`)) || url.searchParams.has('_reconnect')) return;
  event.respondWith((async () => {
    const cacheName = await findActiveCache();
    const cache = cacheName ? await caches.open(cacheName) : null;
    if (request.mode === 'navigate') {
      try {
        const response = await fetch(request);
        if (await validNetworkResponse('index.html', response.clone())) return response;
        return (cache && await cache.match(scopeUrl('index.html'))) || response;
      } catch {
        return (cache && await cache.match(scopeUrl('index.html'))) || new Response('いんたーねっとに つないでね。', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    }
    const cached = cache && await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    return fetch(request);
  })());
});
