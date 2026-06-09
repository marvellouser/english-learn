// db.js
// CLOUD data layer for the vocab PWA. No libraries, native ES module.
//
// This module replaces the original IndexedDB layer. The app is now "pure
// online": the user's mutable progress lives in Cloudflare D1 and is read/written
// through the Pages Functions API under /api/*. The 7500-word vocabulary stays a
// STATIC asset (data/seed-words.json) served from the Cloudflare Pages CDN and is
// loaded once into memory.
//
// Data split:
//   words        static JSON (CDN) -> in-memory map. Reference data, identical
//                for everyone, never written to D1.
//   reviewState  Cloudflare D1 via GET/PUT /api/review-states. A word with no D1
//                row is a brand-new card: its initial state is SYNTHESIZED in
//                memory, so first-run needs zero inserts and a row is written only
//                once the card is actually studied.
//   settings     Cloudflare D1 via GET/PUT /api/settings.
//
// The exported function NAMES and SIGNATURES are unchanged from the IndexedDB
// version, so the views/srs/settings code is untouched. openDB() now means
// "ensure the in-memory caches are loaded from the CDN + cloud".

import { resolveAsset } from './config.js';

// Default spaced-repetition state for a brand-new card.
const INITIAL_EASE = 2.5;

// ---------------------------------------------------------------------------
// Date helper
// ---------------------------------------------------------------------------

/**
 * Local date as a date-only 'YYYY-MM-DD' string, suitable for due comparisons.
 * @param {Date} [date=new Date()]
 * @returns {string}
 */
export function today(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

// Endpoints resolve against the deployment root (BASE_PATH), so the app works at
// any base path. On Cloudflare Pages the site is at the root, so these become
// '/api/review-states' and '/api/settings'.
const REVIEW_URL = () => resolveAsset('api/review-states');
const SETTINGS_URL = () => resolveAsset('api/settings');
const RESET_URL = () => resolveAsset('api/reset');

/**
 * GET a JSON endpoint. Returns the parsed body, or `fallback` if the request
 * fails (so a momentarily unreachable API degrades instead of bricking the app).
 * @template T
 * @param {string} url
 * @param {T} fallback
 * @returns {Promise<T>}
 */
async function apiGet(url, fallback) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('[db] API GET failed, using fallback:', url, err);
    return fallback;
  }
}

/**
 * Send a JSON body to an endpoint and resolve on success. THROWS on failure so
 * the caller (e.g. study.js's rate handler) can surface it and let the user
 * retry instead of silently losing progress.
 * @param {string} url
 * @param {object|Array} body
 * @param {string} [method='PUT']
 * @returns {Promise<object>}
 */
async function apiSend(url, body, method = 'PUT') {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${url} failed: ${res.status} ${res.statusText}`);
  }
  return res.json().catch(() => ({}));
}

// ---------------------------------------------------------------------------
// In-memory caches (loaded once via openDB)
// ---------------------------------------------------------------------------

let readyPromise = null;

// words: static reference data keyed by id.
const wordById = new Map();
// reviewState: ONLY the rows D1 actually has (studied/touched cards).
const reviewById = new Map();
// settings: key -> value.
const settingsMap = new Map();

/**
 * Build the default review state for a brand-new card (due immediately so it
 * surfaces on the first study session). Mirrors the original IndexedDB seed.
 * @param {string} id
 * @returns {object}
 */
function initialReviewState(id) {
  return {
    id,
    ease: INITIAL_EASE,
    interval: 0,
    reps: 0,
    due: today(),
    lastReviewed: null,
    introducedOn: null,
    lapses: 0,
  };
}

/**
 * Load the static vocabulary + cloud progress into memory. Words are required
 * (the app cannot run without them); a failed API read degrades to "empty cloud
 * state" (all words new, default settings) rather than crashing the shell.
 * @returns {Promise<void>}
 */
async function load() {
  // 1. Static vocabulary (CDN / SW cache). This MUST succeed.
  const wordsRes = await fetch(resolveAsset('data/seed-words.json'));
  if (!wordsRes.ok) {
    throw new Error(`seed fetch failed: ${wordsRes.status} ${wordsRes.statusText}`);
  }
  const words = await wordsRes.json();
  wordById.clear();
  for (const w of Array.isArray(words) ? words : []) {
    if (w && typeof w.id === 'string') wordById.set(w.id, w);
  }

  // 2. Cloud progress (tolerant: fall back to empty on failure).
  const [states, settings] = await Promise.all([
    apiGet(REVIEW_URL(), []),
    apiGet(SETTINGS_URL(), {}),
  ]);

  reviewById.clear();
  for (const s of Array.isArray(states) ? states : []) {
    if (s && typeof s.id === 'string') reviewById.set(s.id, s);
  }

  settingsMap.clear();
  if (settings && typeof settings === 'object') {
    for (const [k, v] of Object.entries(settings)) settingsMap.set(k, v);
  }
}

/**
 * Ensure the in-memory caches are loaded. Cached; retries on failure.
 * (Kept named `openDB` so existing callers in app.js are unchanged.)
 * @returns {Promise<void>}
 */
export function openDB() {
  if (!readyPromise) {
    readyPromise = load().catch((err) => {
      readyPromise = null; // allow a later retry
      throw err;
    });
  }
  return readyPromise;
}

// ---------------------------------------------------------------------------
// words store (in-memory; static reference data)
// ---------------------------------------------------------------------------

/** @returns {Promise<Array<object>>} all word records */
export async function getAllWords() {
  await openDB();
  return Array.from(wordById.values());
}

/**
 * @param {string} id
 * @returns {Promise<object | undefined>}
 */
export async function getWord(id) {
  await openDB();
  return wordById.get(id);
}

/**
 * Words carrying a given tag.
 * @param {string} tag
 * @returns {Promise<Array<object>>}
 */
export async function getWordsByTag(tag) {
  await openDB();
  const out = [];
  for (const w of wordById.values()) {
    const tags = Array.isArray(w.tags) ? w.tags : [];
    if (tags.includes(tag)) out.push(w);
  }
  return out;
}

/**
 * Upsert a single word into the in-memory set. Words are static reference data
 * (not persisted to D1); this only affects the current session and exists for
 * backup-restore compatibility.
 * @param {object} w
 * @returns {Promise<void>}
 */
export async function putWord(w) {
  await openDB();
  if (w && typeof w.id === 'string') wordById.set(w.id, w);
}

/**
 * Upsert many words into the in-memory set (not persisted; see putWord).
 * @param {Array<object>} arr
 * @returns {Promise<number>} number of records written
 */
export async function bulkPutWords(arr) {
  await openDB();
  const list = Array.isArray(arr) ? arr : [];
  let n = 0;
  for (const w of list) {
    if (w && typeof w.id === 'string') {
      wordById.set(w.id, w);
      n += 1;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// reviewState store (Cloudflare D1)
// ---------------------------------------------------------------------------

/**
 * Resolve the working review state for a word: the stored D1 row if present,
 * otherwise a freshly synthesized brand-new state.
 * @param {string} id - word id
 * @returns {Promise<object>}
 */
export async function getReviewState(id) {
  await openDB();
  return reviewById.get(id) || initialReviewState(id);
}

/**
 * Upsert a review-state record to Cloudflare D1 (write-through). Updates the
 * in-memory cache first so the session stays consistent even if the network
 * write is retried. THROWS on a failed write so the UI can prompt a retry.
 * @param {object} s - must contain an 'id' matching its word
 * @returns {Promise<void>}
 */
export async function putReviewState(s) {
  await openDB();
  if (!s || typeof s.id !== 'string') return;
  reviewById.set(s.id, s);
  await apiSend(REVIEW_URL(), s, 'PUT');
}

/**
 * Bulk upsert review states to D1 in one request (used by backup restore).
 * @param {Array<object>} arr
 * @returns {Promise<number>} number of records written
 */
export async function bulkPutReviewStates(arr) {
  await openDB();
  const list = (Array.isArray(arr) ? arr : []).filter(
    (s) => s && typeof s.id === 'string'
  );
  if (list.length === 0) return 0;
  for (const s of list) reviewById.set(s.id, s);
  await apiSend(REVIEW_URL(), list, 'PUT');
  return list.length;
}

/**
 * All review states. Every word gets an entry: its stored D1 row if present,
 * otherwise a synthesized brand-new state (so the SRS queue sees unseen words as
 * new cards, exactly like the old pre-seeded model).
 * @returns {Promise<Array<object>>} one state per word
 */
export async function getAllReviewState() {
  await openDB();
  const out = [];
  for (const id of wordById.keys()) {
    out.push(reviewById.get(id) || initialReviewState(id));
  }
  return out;
}

/**
 * Review states due on/before todayISO (computed in memory over the merged set).
 * @param {string} [todayISO=today()] inclusive upper bound
 * @returns {Promise<Array<object>>}
 */
export async function getDueReviewStates(todayISO = today()) {
  const all = await getAllReviewState();
  return all.filter((s) => typeof s.due === 'string' && s.due <= todayISO);
}

/**
 * Reset all progress: delete every D1 review-state row in one request (every
 * word reverts to "new"). Clears the in-memory cache too.
 * @returns {Promise<number>} number of rows deleted
 */
export async function resetReviewStates() {
  await openDB();
  const res = await apiSend(RESET_URL(), {}, 'POST');
  reviewById.clear();
  return typeof res.reset === 'number' ? res.reset : 0;
}

// ---------------------------------------------------------------------------
// settings store (Cloudflare D1)
// ---------------------------------------------------------------------------

/**
 * @param {string} key
 * @param {*} [fallback=undefined] returned when the key is absent
 * @returns {Promise<*>}
 */
export async function getSetting(key, fallback = undefined) {
  await openDB();
  return settingsMap.has(key) ? settingsMap.get(key) : fallback;
}

/**
 * Persist a single setting to Cloudflare D1 (write-through). THROWS on failure.
 * @param {string} key
 * @param {*} value
 * @returns {Promise<void>}
 */
export async function putSetting(key, value) {
  await openDB();
  settingsMap.set(key, value);
  await apiSend(SETTINGS_URL(), { key, value }, 'PUT');
}

// ---------------------------------------------------------------------------
// Generic import hook
// ---------------------------------------------------------------------------

/**
 * Generic, data-shape-agnostic bulk word import. In the cloud model words are
 * static reference data, so this only merges them into the in-memory set (it does
 * NOT persist words, and review states are synthesized lazily — see
 * getReviewState). Kept for backup-restore compatibility; the returned summary
 * shape is unchanged (newReviewStates is always 0 now).
 *
 * @param {Array<object>} words
 * @param {{ source?: string }} [opts]
 * @returns {Promise<{ total: number, imported: number, newReviewStates: number, skipped: number, source: string }>}
 */
export async function importWords(words, { source = 'unknown' } = {}) {
  if (!Array.isArray(words)) {
    throw new TypeError('importWords: expected an array of word objects');
  }
  await openDB();

  const valid = [];
  let skipped = 0;
  for (const w of words) {
    if (w && typeof w === 'object' && typeof w.id === 'string' && typeof w.word === 'string') {
      if (w.tags != null && !Array.isArray(w.tags)) {
        skipped += 1;
        continue;
      }
      valid.push(w);
    } else {
      skipped += 1;
    }
  }

  if (skipped > 0) {
    console.warn(`[db] importWords(${source}): skipped ${skipped} malformed record(s)`);
  }

  for (const w of valid) wordById.set(w.id, w);

  const summary = {
    total: words.length,
    imported: valid.length,
    newReviewStates: 0,
    skipped,
    source,
  };
  console.info(`[db] importWords(${source}): merged ${valid.length} word(s) into memory`);
  return summary;
}
