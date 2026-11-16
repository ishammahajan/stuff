import { version } from '$app/env';
import { assets, immutable } from '$app/manifest';
import { self } from '$app/service-worker';

// One cache per deployment. A cached page references that deployment's hashed
// files, so pages and files must be dropped together when a new version activates.
const CACHE = `superapp-${version}`;

const DASHBOARD = '/';

const precached = new Set(
	[...immutable, ...assets].map((file) => new URL(file.path, self.registration.scope).pathname)
);

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll([...precached]))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
			.then(() => self.clients.claim())
	);
});

async function cacheFirst(request: Request): Promise<Response> {
	const cache = await caches.open(CACHE);
	return (await cache.match(request)) ?? fetch(request);
}

/**
 * Answers with the cached dashboard at once and refreshes the copy in the
 * background. The copy is dropped when the server no longer serves the
 * dashboard, for example because the session has ended.
 */
async function dashboard(event: FetchEvent): Promise<Response> {
	const cache = await caches.open(CACHE);
	const cached = await cache.match(DASHBOARD);

	const fresh = fetch(event.request).then(async (response) => {
		if (response.ok && !response.redirected) {
			await cache.put(DASHBOARD, response.clone());
		} else {
			await cache.delete(DASHBOARD);
		}
		return response;
	});

	if (!cached) return fresh;
	event.waitUntil(fresh.catch(() => undefined));
	return cached;
}

self.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;

	if (precached.has(url.pathname)) {
		event.respondWith(cacheFirst(request));
		return;
	}

	if (request.mode !== 'navigate') return;

	if (url.pathname === DASHBOARD) {
		event.respondWith(dashboard(event));
	} else if (url.pathname === '/login') {
		// Reaching the login page means the session is gone; forget the dashboard.
		event.waitUntil(caches.open(CACHE).then((cache) => cache.delete(DASHBOARD)));
	}
});
