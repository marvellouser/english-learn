// config.js
// Centralized runtime configuration for the vocab PWA.
// No build step / no bundler: this is a native ES module.
//
// BASE_PATH resolution lets the app run from any GitHub Pages sub-path
// (e.g. https://user.github.io/english-learn/) without absolute URLs.

// Resolve the directory that contains the /js folder, then step up one level
// to the application root. import.meta.url points at this file (.../js/config.js),
// so new URL('..', import.meta.url) yields the app root (.../).
const APP_ROOT_URL = new URL('..', import.meta.url);

// BASE_PATH is the pathname of the app root, always ending with a trailing slash.
// Examples:
//   served at site root      -> '/'
//   served at /english-learn -> '/english-learn/'
export const BASE_PATH = APP_ROOT_URL.pathname;

// --- Default application settings -------------------------------------------

// Maximum number of brand-new words introduced per day.
export const DEFAULT_DAILY_NEW_LIMIT = 15;

// Daily review cap. null means unlimited reviews per day.
export const DEFAULT_DAILY_REVIEW_LIMIT = null;

// --- Persistence + cache identifiers ----------------------------------------

// IndexedDB database (created by a later task; referenced here as the
// single source of truth).
export const DB_NAME = 'vocab-pwa';
export const DB_VERSION = 1;

// Service worker cache version. Must match CACHE_NAME in service-worker.js.
// Bump whenever shipped code/data changes so existing installs drop the old
// cache and fetch fresh assets (incl. the latest data/seed-words.json).
// NOTE: the /api/* endpoints (Cloudflare D1 progress) are explicitly NOT cached
// by the service worker, so progress is always read fresh from the server.
export const CACHE_NAME = 'vocab-pwa-v8';

// Bundled-dataset version. Bump this whenever data/seed-words.json changes
// (new words, new fields like `freq`, enriched examples). On launch the app
// re-imports the seed when the stored version differs — non-destructively:
// word records are updated and new words added, while existing review
// progress is preserved. This is what lets an already-seeded install pick up
// the expanded 7500-word dataset instead of staying on the old 441 words.
export const DATA_VERSION = '2026-05-29.3';

// --- Helpers ----------------------------------------------------------------

/**
 * Resolve an asset path against the application root (BASE_PATH).
 * Accepts either a bare relative path ('css/styles.css') or a './'-prefixed
 * path ('./css/styles.css') and returns an absolute URL string rooted at
 * the deployment base path.
 *
 * @param {string} path - relative asset path
 * @returns {string} absolute URL string for the asset
 */
export function resolveAsset(path) {
  const clean = String(path).replace(/^\.?\//, '');
  return new URL(clean, APP_ROOT_URL).href;
}
