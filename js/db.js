// db.js
// Raw IndexedDB data layer for the vocab PWA. No libraries, native ES module.
//
// Stores (created on v1 upgrade):
//   words       (keyPath 'id')  + index by_tag (multiEntry) on 'tags'
//   reviewState (keyPath 'id')  + index by_due on 'due'
//   settings    (keyPath 'key')
//
// All IndexedDB requests are wrapped in Promises. Date/due values are stored
// as 'YYYY-MM-DD' strings so the by_due index range query works with plain
// string comparison.
//
// importWords() is the GENERIC import hook: it powers first-run seeding and is
// the reserved extension point for a future bulk dataset (ECDICT/AI) import.

import { DB_NAME, DB_VERSION } from './config.js';

// Store names (kept local; the schema is owned by this module).
const STORE_WORDS = 'words';
const STORE_REVIEW = 'reviewState';
const STORE_SETTINGS = 'settings';

// Default spaced-repetition state for a brand-new card.
const INITIAL_EASE = 2.5;

// ---------------------------------------------------------------------------
// Date helper
// ---------------------------------------------------------------------------

/**
 * Local date as a date-only 'YYYY-MM-DD' string, suitable for due comparisons
 * and the by_due index range query (string ordering matches date ordering).
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
// Connection (cached, lazily opened)
// ---------------------------------------------------------------------------

let dbPromise = null;

/**
 * Open (or create/upgrade) the IndexedDB database. The connection is cached so
 * repeated calls reuse the same handle.
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }

    request.onupgradeneeded = (event) => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_WORDS)) {
        const words = db.createObjectStore(STORE_WORDS, { keyPath: 'id' });
        words.createIndex('by_tag', 'tags', { multiEntry: true });
      }

      if (!db.objectStoreNames.contains(STORE_REVIEW)) {
        const review = db.createObjectStore(STORE_REVIEW, { keyPath: 'id' });
        review.createIndex('by_due', 'due');
      }

      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }

      // event reserved for future version-aware migrations.
      void event;
    };

    request.onsuccess = () => {
      const db = request.result;
      // If another tab triggers an upgrade, close so it is not blocked.
      db.onversionchange = () => db.close();
      resolve(db);
    };

    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      console.warn('[db] open blocked: another connection holds an older version');
  });

  // Reset the cache on failure so a later call can retry.
  dbPromise.catch(() => {
    dbPromise = null;
  });

  return dbPromise;
}

// ---------------------------------------------------------------------------
// Low-level promise helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a single IDBRequest in a Promise resolving to its result.
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Resolve when a transaction completes; reject on error/abort.
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

/**
 * Run a callback against a fresh transaction over the given store(s).
 * @template T
 * @param {string | string[]} storeNames
 * @param {IDBTransactionMode} mode
 * @param {(stores: IDBObjectStore | IDBObjectStore[], tx: IDBTransaction) => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
async function withStore(storeNames, mode, fn) {
  const db = await openDB();
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  const tx = db.transaction(names, mode);
  const stores = Array.isArray(storeNames)
    ? names.map((n) => tx.objectStore(n))
    : tx.objectStore(names[0]);

  const result = await fn(stores, tx);
  if (mode === 'readwrite') {
    await txDone(tx);
  }
  return result;
}

// ---------------------------------------------------------------------------
// words store
// ---------------------------------------------------------------------------

/** @returns {Promise<Array<object>>} all word records */
export function getAllWords() {
  return withStore(STORE_WORDS, 'readonly', (store) =>
    requestToPromise(store.getAll())
  );
}

/**
 * @param {string} id
 * @returns {Promise<object | undefined>}
 */
export function getWord(id) {
  return withStore(STORE_WORDS, 'readonly', (store) =>
    requestToPromise(store.get(id))
  );
}

/**
 * Words carrying a given tag (via the by_tag multiEntry index).
 * @param {string} tag
 * @returns {Promise<Array<object>>}
 */
export function getWordsByTag(tag) {
  return withStore(STORE_WORDS, 'readonly', (store) =>
    requestToPromise(store.index('by_tag').getAll(tag))
  );
}

/**
 * Upsert a single word.
 * @param {object} w
 * @returns {Promise<void>}
 */
export function putWord(w) {
  return withStore(STORE_WORDS, 'readwrite', (store) => {
    store.put(w);
  });
}

/**
 * Upsert many words in one transaction.
 * @param {Array<object>} arr
 * @returns {Promise<number>} number of records written
 */
export function bulkPutWords(arr) {
  const list = Array.isArray(arr) ? arr : [];
  return withStore(STORE_WORDS, 'readwrite', (store) => {
    for (const w of list) store.put(w);
    return list.length;
  });
}

// ---------------------------------------------------------------------------
// reviewState store
// ---------------------------------------------------------------------------

/**
 * @param {string} id - word id
 * @returns {Promise<object | undefined>}
 */
export function getReviewState(id) {
  return withStore(STORE_REVIEW, 'readonly', (store) =>
    requestToPromise(store.get(id))
  );
}

/**
 * Upsert a review-state record.
 * @param {object} s - must contain an 'id' matching its word
 * @returns {Promise<void>}
 */
export function putReviewState(s) {
  return withStore(STORE_REVIEW, 'readwrite', (store) => {
    store.put(s);
  });
}

/** @returns {Promise<Array<object>>} all review-state records */
export function getAllReviewState() {
  return withStore(STORE_REVIEW, 'readonly', (store) =>
    requestToPromise(store.getAll())
  );
}

/**
 * Review states due on/before todayISO, via the by_due index range query.
 * Relies on 'YYYY-MM-DD' string ordering matching date ordering.
 * @param {string} [todayISO=today()] inclusive upper bound
 * @returns {Promise<Array<object>>}
 */
export function getDueReviewStates(todayISO = today()) {
  const range = IDBKeyRange.upperBound(todayISO);
  return withStore(STORE_REVIEW, 'readonly', (store) =>
    requestToPromise(store.index('by_due').getAll(range))
  );
}

// ---------------------------------------------------------------------------
// settings store
// ---------------------------------------------------------------------------

/**
 * @param {string} key
 * @param {*} [fallback=undefined] returned when the key is absent
 * @returns {Promise<*>}
 */
export async function getSetting(key, fallback = undefined) {
  const row = await withStore(STORE_SETTINGS, 'readonly', (store) =>
    requestToPromise(store.get(key))
  );
  return row === undefined ? fallback : row.value;
}

/**
 * @param {string} key
 * @param {*} value
 * @returns {Promise<void>}
 */
export function putSetting(key, value) {
  return withStore(STORE_SETTINGS, 'readwrite', (store) => {
    store.put({ key, value });
  });
}

// ---------------------------------------------------------------------------
// Generic import hook
// ---------------------------------------------------------------------------

/**
 * Build the default review state for a brand-new card. New cards are due
 * immediately (due === today), so they surface on the first study session.
 * introducedOn stays null until the card is first studied; the daily new-card
 * cap counts states whose introducedOn equals today (see srs.buildDailyQueue).
 * lapses starts at 0; it is incremented by srs.applyReview on a failed review
 * and drives the 错题本 (mistake notebook) membership (lapses > 0).
 * @param {string} id - word id
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
 * Generic, data-shape-agnostic bulk import. Used for first-run seeding and
 * reserved for future bulk datasets (ECDICT/AI). It:
 *   1. Validates input shape (array of objects with a string id + word).
 *   2. Upserts every word by id (idempotent: re-import overwrites, no dupes).
 *   3. Creates an initial reviewState for any word that has none yet
 *      (existing review progress is never overwritten).
 *
 * @param {Array<object>} words
 * @param {{ source?: string }} [opts]
 * @returns {Promise<{ total: number, imported: number, newReviewStates: number, skipped: number, source: string }>}
 */
export async function importWords(words, { source = 'unknown' } = {}) {
  if (!Array.isArray(words)) {
    throw new TypeError('importWords: expected an array of word objects');
  }

  // Validate shape; skip malformed entries rather than crash the whole import.
  const valid = [];
  let skipped = 0;
  for (const w of words) {
    if (w && typeof w === 'object' && typeof w.id === 'string' && typeof w.word === 'string') {
      // Normalize tags to an array so the by_tag multiEntry index is well-formed.
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

  // 1. Upsert all valid words.
  const imported = await bulkPutWords(valid);

  // 2. Determine which words still lack a review state.
  const existing = await getAllReviewState();
  const existingIds = new Set(existing.map((s) => s.id));

  const newStates = [];
  for (const w of valid) {
    if (!existingIds.has(w.id)) {
      newStates.push(initialReviewState(w.id));
    }
  }

  // 3. Insert any missing review states in one transaction.
  if (newStates.length > 0) {
    await withStore(STORE_REVIEW, 'readwrite', (store) => {
      for (const s of newStates) store.put(s);
    });
  }

  const summary = {
    total: words.length,
    imported,
    newReviewStates: newStates.length,
    skipped,
    source,
  };
  console.info(
    `[db] importWords(${source}): ${imported} word(s), ${newStates.length} new review state(s)`
  );
  return summary;
}
