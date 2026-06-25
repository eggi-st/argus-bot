const CACHE = 'argus-v1'
const STATIC = ['/', '/index.html', '/logo.png', '/favicon.ico', '/manifest.json']

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)))
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ))
  self.clients.claim()
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  // API and WebSocket — always network, never cache
  if (url.pathname.startsWith('/api') || e.request.url.startsWith('ws')) return
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  )
})
