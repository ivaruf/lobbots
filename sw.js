// LOBBOTS service worker: a versioned precache, so a match survives a tunnel,
// a plane, or a deploy that lands mid-round.
//
// UPDATE MODEL ("opt-in", hub CLAUDE.md §3). Bump VERSION on every committed
// batch that deploys. The page registers with { updateViaCache: 'none' } and
// calls reg.update() at launch, so a changed sw.js is noticed on arrival rather
// than whenever the browser feels like revalidating it. The new worker
// precaches the whole list below and then WAITS: js/update.js shows the
// UPDATE READY button on the setup screen, and only that tap posts
// SKIP_WAITING. There is deliberately no skipWaiting() in install — taking over
// unasked would swap the module set underneath a shell that is halfway down the
// hill, which is exactly the "a deploy must never destroy a run in progress"
// rule. The button lives inside #setup, which is hidden for the whole of a
// match, so the control does not exist on screen while a round is running.
//
// GET_VERSION lets the page print the build that is actually serving it, which
// during a botched release is the one question you cannot answer by looking.
//
// The cache name is prefixed with the slug and the cleanup filter below only
// ever deletes keys that carry that prefix: every game in this hub shares the
// ivaruf.github.io origin and therefore one CacheStorage, so a sloppy filter
// evicts a neighbour's offline copy.
//
// All paths are RELATIVE, because the game is served from a subpath
// (/tankwars/ today, /lobbots/ when the folder is renamed) and is also framed
// by the arcade from a sibling directory.

const VERSION = 'v0.2.5'; // a tablet no longer selects text or opens callouts
const CACHE = `lobbots-${VERSION}`;

// Every shipped file. install blocks until all of it is cached, so this list is
// the whole game: a file missing from it works online and silently vanishes
// offline, and a file listed but not deployed fails the install outright and
// leaves the player on the previous version. Keep it in step with the layout in
// ARCHITECTURE.md §2.
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/main.js',
  './js/update.js',
  './js/screen.js',
  './js/touch-guard.js',
  './js/input.js',
  './js/ui.js',
  './js/audio.js',
  './js/config.js',
  './js/sim/rng.js',
  './js/sim/terrain.js',
  './js/sim/ballistics.js',
  './js/sim/weapons.js',
  './js/sim/world.js',
  './js/sim/ai.js',
  './js/sim/match.js',
  './js/render/render.js',
  './js/render/sky.js',
  './js/render/terrain-draw.js',
  './js/render/mech-draw.js',
  './js/render/projectile-draw.js',
  './js/render/effects.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
  './icons/icon-maskable-512.png',
  // The eleven cues, ~150 KB for the set. Small enough to precache with
  // everything else, which is what stops the first thump of a session being
  // late — a whistle that arrives after the shell has already landed is worse
  // than no whistle at all.
  './audio/fire.m4a',
  './audio/whistle.m4a',
  './audio/boom.m4a',
  './audio/boom-big.m4a',
  './audio/bounce.m4a',
  './audio/splat.m4a',
  './audio/crumble.m4a',
  './audio/wreck.m4a',
  './audio/kaching.m4a',
  './audio/fanfare.m4a',
  './audio/click.m4a',
];

self.addEventListener('install', (event) => {
  // No skipWaiting() here: after precaching, the new worker stays WAITING until
  // the player accepts the update from the setup screen.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'SKIP_WAITING') self.skipWaiting();
  if (msg.type === 'GET_VERSION' && event.ports[0]) event.ports[0].postMessage({ version: VERSION });
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        // 'lobbots-' only. fishtank, swirls, maxgear and the rest keep their
        // caches on this same origin and none of them are ours to delete.
        keys.filter((k) => k.startsWith('lobbots-') && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  // Cache-first out of the current versioned precache, so every module in one
  // session comes from ONE deploy and the sim can never be a version ahead of
  // the renderer reading its state. New versions arrive as a whole new cache
  // through the install/activate flow above, never file by file.
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      }).catch(() => (request.mode === 'navigate' ? caches.match('./index.html') : undefined));
    })
  );
});
