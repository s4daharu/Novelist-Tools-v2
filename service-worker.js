
// Novelist-Tools-main/service-worker.js
const CACHE_VERSION = 'novelist-tools-v1.6'; // Incremented version
const ASSETS = [
  './', 
  './index.html',
  './index.css', 
  './index.js',  
  './manifest.json',

  './icons/icon-192.png',
  './icons/icon-512.png',
  './screenshots/screenshot1.png', // Keep placeholders, user can update actual files
  './screenshots/screenshot2.png',

  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.7.1/jszip.min.js',
  'https://esm.sh/react@^19.1.0',
  'https://esm.sh/react-dom@^19.1.0/client',
  'https://esm.sh/react@^19.1.0/jsx-runtime'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => {
        console.log('Service Worker: Caching app shell files. Assets to cache:', ASSETS);
        const assetPromises = ASSETS.map(assetUrl => {
          // Use default 'cors' mode for CDN assets that support it (esm.sh, cdnjs usually do)
          // For same-origin assets, 'cors' is also appropriate or default.
          const request = new Request(assetUrl); 
          return fetch(request)
            .then(response => {
              if (!response.ok) {
                // Allow optional assets like screenshots to fail gracefully
                if (!assetUrl.includes('screenshots')) { 
                  console.error(`Service Worker: Failed to fetch ${assetUrl} during install. Status: ${response.status}`);
                  // Potentially throw to fail SW install if it's a critical asset.
                  // For this setup, we'll resolve to not block the entire install for one failed non-screenshot asset.
                  return Promise.resolve(); 
                }
                console.warn(`Service Worker: Optional asset ${assetUrl} failed to fetch. Status: ${response.status}`);
                return Promise.resolve();
              }
              return cache.put(assetUrl, response);
            })
            .catch(err => {
              if (!assetUrl.includes('screenshots')) {
                console.error(`Service Worker: Failed to cache ${assetUrl} due to network error`, err);
              }
              return Promise.resolve(); // Resolve to not block install for optional assets
            });
        });
        return Promise.all(assetPromises);
      })
      .then(() => {
        console.log('Service Worker: All specified assets processed for caching. Attempting to skip waiting.');
        return self.skipWaiting(); // Ensure new SW activates quickly
      })
      .catch(error => {
        console.error('Service Worker: Caching failed significantly during install', error);
      })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_VERSION) {
            console.log('Service Worker: Deleting old cache', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => {
      console.log('Service Worker: Claiming clients');
      return self.clients.claim(); // Ensure new SW takes control of open pages
    })
  );
});

self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // If successful, cache the response for the navigation request
          if (response && response.ok) {
            const responseToCache = response.clone();
            caches.open(CACHE_VERSION).then(cache => {
              cache.put(event.request, responseToCache);
            });
          }
          return response;
        })
        .catch(() => {
          // Network failed, try to serve from cache
          return caches.match(event.request)
            .then(cachedResponse => {
              // If in cache, return it, otherwise return the main index.html as a fallback for navigation
              return cachedResponse || caches.match('./index.html'); 
            });
        })
    );
    return; // Exit early for navigation requests
  }

  // For non-navigation requests (assets, API calls, etc.)
  event.respondWith(
    caches.match(event.request)
      .then(cachedResponse => {
        if (cachedResponse) {
          return cachedResponse; // Serve from cache if found
        }

        // Not in cache, fetch from network
        return fetch(event.request).then(
          async networkResponse => { // Mark callback as async
            // Check if we received a valid response and it's a GET request
            // Also check if it's from our origin or an explicitly whitelisted CDN
            if (
              networkResponse && 
              networkResponse.ok && 
              event.request.method === 'GET'
            ) {
              // Determine if the resource should be cached based on its URL
              const canCache = event.request.url.startsWith(self.location.origin) ||
                               ASSETS.includes(event.request.url) || // If it was part of initial assets
                               event.request.url.startsWith('https://cdnjs.cloudflare.com') ||
                               event.request.url.startsWith('https://esm.sh');

              if (canCache) {
                const responseToCache = networkResponse.clone();
                try {
                  const cache = await caches.open(CACHE_VERSION); // Use await here
                  await cache.put(event.request, responseToCache); // And here
                } catch (putError) {
                  console.error('Service Worker: cache.put() FAILED for:', event.request.url, putError);
                  // Don't let a failed cache.put break the network response to the page
                }
              }
            }
            return networkResponse; // Return the network response to the page
          }
        ).catch(error => {
          console.error('Service Worker: Fetch failed (non-navigation):', event.request.url, error);
          // For non-navigation requests, if it's not in cache and network fails,
          // there's usually no specific fallback asset unless defined (e.g., placeholder image).
          // Re-throwing the error or just returning undefined/error response is common.
          throw error; 
        });
      })
  );
});

// Listen for messages from the client (page)
self.addEventListener('message', event => {
  if (event.data && event.data.action === 'SKIP_WAITING') {
    console.log('Service Worker: Received SKIP_WAITING message, activating new worker.');
    self.skipWaiting();
  }
});
