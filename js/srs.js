// srs.js
// Pure SM-2 (SuperMemo-2 / Anki-style) spaced-repetition engine and daily
// queue builder. This module is intentionally PURE:
//   - no DOM, no IndexedDB, no browser globals (window/indexedDB/document)
//   - every function is deterministic given its inputs and returns NEW data
// so it is fully importable and testable under plain Node (ESM).
//
// The UI/storage layers fetch data via db.js, then hand the already-loaded
// records to these functions.
//
// reviewState shape (mirrors db.js, keyPath 'id'):
//   { id, ease, interval, reps, due, lastReviewed, introducedOn, lapses }
//     ease         : number  >= 1.3, default 2.5
//     interval     : integer days, new card = 0
//     reps         : integer count of consecutive successful reviews, new = 0
//     due          : 'YYYY-MM-DD' local date string (string-comparable)
//     lastReviewed : 'YYYY-MM-DD' string, or null for a never-reviewed card
//     introducedOn : 'YYYY-MM-DD' string of the day the card was first
//                    introduced, or null while still a brand-new card. Used to
//                    enforce a real per-day NEW-card cap (so re-entering the
//                    study session mid-day resumes instead of restarting).
//     lapses       : integer count of times the card was failed (rated 不认识 /
//                    quality < 3), default 0. A word with lapses > 0 is surfaced
//                    in the 错题本 (mistake notebook). Only ever incremented here;
//                    cleared (back to 0) explicitly by the UI / settings.
//
// A "new" (not-yet-introduced) card is identified by reps === 0 && lastReviewed === null.

// SM-2 ease (E-Factor) bounds.
export const MIN_EASE = 1.3;
export const INITIAL_EASE = 2.5;

// Default daily caps (used as fallbacks when settings omit them). These match
// config.js: DEFAULT_DAILY_NEW_LIMIT = 15, DEFAULT_DAILY_REVIEW_LIMIT = null.
export const DEFAULT_DAILY_NEW_LIMIT = 15;
export const DEFAULT_DAILY_REVIEW_LIMIT = null;

// ---------------------------------------------------------------------------
// Date helpers (operate on 'YYYY-MM-DD' strings, no Date mutation pitfalls)
// ---------------------------------------------------------------------------

/**
 * Normalize a Date (or 'YYYY-MM-DD' string) to a date-only 'YYYY-MM-DD' string.
 * Mirrors db.js today() formatting for a Date; passes through a valid string.
 * @param {Date|string} value
 * @returns {string}
 */
export function isoDate(value) {
  if (typeof value === 'string') {
    // Trust an already date-only string; trim any time component defensively.
    return value.slice(0, 10);
  }
  const date = value instanceof Date ? value : new Date(value);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Add n days to a 'YYYY-MM-DD' string and return a new 'YYYY-MM-DD' string.
 * Uses UTC arithmetic on the parsed Y/M/D so DST and local-tz boundaries can
 * never shift the calendar day (no in-place Date mutation).
 * @param {string} iso - 'YYYY-MM-DD'
 * @param {number} n - integer number of days to add (may be negative)
 * @returns {string}
 */
export function addDays(iso, n) {
  const [y, m, d] = isoDate(iso).split('-').map(Number);
  // Build a UTC timestamp at midnight, shift by n whole days, reformat.
  const ms = Date.UTC(y, m - 1, d) + n * 86400000;
  const next = new Date(ms);
  const yy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(next.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Rating -> SM-2 quality grade
// ---------------------------------------------------------------------------

/**
 * Map the 3-tier UI rating to an SM-2 quality grade (0..5).
 *
 * Canonical rating form: the string keys 'again' | 'hard' | 'good'.
 * For tolerance the UI may also send the localized labels or the numeric
 * tier index (0/1/2):
 *
 *   'again' | '不认识' | 0  -> quality 0   (failed: re-show soon)
 *   'hard'  | '模糊'   | 1  -> quality 3   (passed but difficult)
 *   'good'  | '认识'   | 2  -> quality 5   (passed easily)
 *
 * @param {('again'|'hard'|'good'|'不认识'|'模糊'|'认识'|0|1|2|string|number)} rating
 * @returns {number} SM-2 quality grade (0, 3 or 5)
 */
export function gradeFromRating(rating) {
  switch (rating) {
    case 'again':
    case '不认识': // 不认识
    case 0:
    case '0':
      return 0;
    case 'hard':
    case '模糊':       // 模糊
    case 1:
    case '1':
      return 3;
    case 'good':
    case '认识':       // 认识
    case 2:
    case '2':
      return 5;
    default:
      throw new RangeError(`gradeFromRating: unknown rating ${JSON.stringify(rating)}`);
  }
}

// ---------------------------------------------------------------------------
// SM-2 review transition
// ---------------------------------------------------------------------------

/**
 * Apply one SM-2 review to a reviewState and return a NEW state (input is
 * never mutated).
 *
 * Ease update (always applied, even on failure, per canonical SM-2):
 *   ease' = max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
 *
 * On failure (q < 3):
 *   reps     = 0
 *   interval = 1   // re-show next day. (Choice: interval 1 rather than 0 so
 *                  //  the card is not crammed into the same session forever;
 *                  //  it reappears the next day, matching Anki's "Again -> 1d"
 *                  //  baseline behaviour for a learned card.)
 *   due      = today + 1 day
 *
 * On success (q >= 3):
 *   interval = reps === 0 ? 1            // first correct review
 *            : reps === 1 ? 6            // second correct review
 *            : round(prevInterval * ease)
 *   reps     = reps + 1
 *   due      = today + interval days
 *
 * Always:
 *   lastReviewed = today
 *
 * introducedOn:
 *   If the INPUT state is a brand-new card (reps === 0 && lastReviewed === null),
 *   this review is the card's first introduction -> set introducedOn = today.
 *   Otherwise the existing state.introducedOn is carried through unchanged. The
 *   returned state always carries an introducedOn field (string or null) so the
 *   daily NEW-card cap can count what was introduced today.
 *
 * lapses:
 *   A running count of failures used to drive the 错题本 (mistake notebook).
 *   On failure (q < 3) it is incremented by 1; otherwise the existing
 *   state.lapses is carried through unchanged (defaulting to 0 when absent on
 *   legacy records). The returned state always carries a numeric lapses field.
 *
 * @param {{id:string, ease:number, interval:number, reps:number, due:string, lastReviewed:(string|null), introducedOn?:(string|null), lapses?:number}} state
 * @param {number} quality - SM-2 grade 0..5 (see gradeFromRating)
 * @param {string|Date} today - 'YYYY-MM-DD' (or Date) of the review
 * @returns {{id:string, ease:number, interval:number, reps:number, due:string, lastReviewed:string, introducedOn:(string|null), lapses:number}} new state
 */
export function applyReview(state, quality, today) {
  const todayISO = isoDate(today);

  const prevEase = typeof state.ease === 'number' ? state.ease : INITIAL_EASE;
  const prevInterval = typeof state.interval === 'number' ? state.interval : 0;
  const prevReps = typeof state.reps === 'number' ? state.reps : 0;

  // Determine whether THIS review introduces the card (input was brand-new).
  // On first introduction stamp introducedOn = today; otherwise carry through
  // the existing value (default null when absent on legacy records).
  const wasNew = prevReps === 0 && (state.lastReviewed === null || state.lastReviewed === undefined);
  const nextIntroducedOn = wasNew
    ? todayISO
    : state.introducedOn === undefined
      ? null
      : state.introducedOn;

  // Carry the lapse counter; default 0 on legacy records lacking the field.
  const prevLapses = typeof state.lapses === 'number' ? state.lapses : 0;

  // Ease is updated on every grade, then floored at 1.3.
  const easeDelta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
  const nextEase = Math.max(MIN_EASE, prevEase + easeDelta);

  let nextReps;
  let nextInterval;

  if (quality < 3) {
    // Failure: lapse. Reset the rep streak; re-show the next day.
    nextReps = 0;
    nextInterval = 1;
  } else {
    // Success: advance the interval through the SM-2 stages.
    if (prevReps === 0) {
      nextInterval = 1;
    } else if (prevReps === 1) {
      nextInterval = 6;
    } else {
      nextInterval = Math.round(prevInterval * nextEase);
    }
    nextReps = prevReps + 1;
  }

  return {
    id: state.id,
    ease: nextEase,
    interval: nextInterval,
    reps: nextReps,
    due: addDays(todayISO, nextInterval),
    lastReviewed: todayISO,
    introducedOn: nextIntroducedOn,
    // A failure (q < 3) enters / deepens the 错题本; success carries the count.
    lapses: quality < 3 ? prevLapses + 1 : prevLapses,
  };
}

// ---------------------------------------------------------------------------
// New-card ordering helpers (PURE; exported for testing)
// ---------------------------------------------------------------------------

/**
 * Map a word to a difficulty/usefulness tier used to ORDER new cards.
 *
 *   0  basic        - neither cet4/cet6/programming (e.g. 'common')
 *   1  intermediate - carries 'cet4'
 *   2  advanced     - carries 'cet6'
 *   3  programming  - carries 'programming'
 *
 * Assignment priority when a word carries several tags is
 * programming > advanced(cet6) > intermediate(cet4) > basic, but the rank is
 * deliberately ASCENDING so that high-frequency / easier words (basic, cet4)
 * surface first - high-frequency-first pedagogy.
 *
 * NOTE: tierRank is now only a FALLBACK ordering key. The ECDICT frequency-ranked
 * dataset stamps a real per-word COCA rank on each record (`freq`), and
 * buildDailyQueue orders new cards by that real frequency first; tierRank is used
 * only when `freq` is missing/0 (e.g. some programming terms absent from COCA).
 *
 * @param {{tags?:string[]}} word
 * @returns {0|1|2|3}
 */
export function tierRank(word) {
  const tags = word && Array.isArray(word.tags) ? word.tags : [];
  if (tags.includes('programming')) return 3;
  if (tags.includes('cet6')) return 2;
  if (tags.includes('cet4')) return 1;
  return 0;
}

/**
 * Real per-word ordering rank for NEW cards. Returns the word's COCA frequency
 * rank (`freq`, 1 = most frequent) when present and positive, so the most common
 * words are learned first. A missing / zero / non-positive `freq` (e.g. some
 * programming terms not in COCA) yields Infinity so those words sort AFTER all
 * frequency-ranked words; the coarse tag-based tierRank then breaks ties among
 * the unranked group via the caller.
 *
 * @param {{freq?:number}} word
 * @returns {number} positive COCA rank, or Infinity when unranked
 */
export function freqRank(word) {
  const f = word && typeof word.freq === 'number' ? word.freq : 0;
  return f > 0 ? f : Infinity;
}

/**
 * Deterministic, non-negative 32-bit string hash (FNV-1a). Used to give new
 * cards a day-stable pseudo-random ordering WITHOUT Math.random, so that
 * re-entering the same day resumes on the same set of words, while a different
 * day (different hash input) yields a different order.
 *
 * @param {string} str
 * @returns {number} non-negative 32-bit integer
 */
export function stableHash(str) {
  const s = String(str);
  // FNV-1a 32-bit.
  let h = 0x811c9dc5; // 2166136261
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    // h *= 16777619, kept in 32-bit range via Math.imul.
    h = Math.imul(h, 0x01000193);
  }
  // Coerce to a non-negative 32-bit integer.
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Daily queue builder
// ---------------------------------------------------------------------------

/**
 * Whether a review state represents a brand-new (never-introduced) card.
 * Matches db.js's initial state: reps === 0 && lastReviewed === null.
 * @param {{reps:number, lastReviewed:(string|null)}} s
 * @returns {boolean}
 */
function isNewState(s) {
  return s.reps === 0 && (s.lastReviewed === null || s.lastReviewed === undefined);
}

/**
 * Resolve a daily cap from a settings value: a positive finite number caps the
 * count; null / undefined / 0 / non-positive means "no cap" for reviews, while
 * for new cards 0 legitimately means "introduce none". The caller picks the
 * fallback; this just coerces.
 * @param {*} value
 * @returns {number|null} a non-negative cap, or null for unlimited
 */
function normalizeCap(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/**
 * Build the bounded, ordered daily study queue from already-loaded data.
 * PURE: takes plain arrays/objects, returns a new ordered array.
 *
 * @param {object} args
 * @param {Array<object>} args.words - all word records ({ id, word, tags, ... })
 * @param {Array<object>} args.reviewStates - all review-state records
 * @param {object} [args.settings] - { dailyNewLimit, dailyReviewLimit }
 * @param {string|Date} args.todayISO - 'YYYY-MM-DD' (or Date) "today"
 * @param {string|null} [args.tagFilter] - restrict to words carrying this tag
 * @returns {Array<{wordId:string, isNew:boolean}>} ordered queue
 */
export function buildDailyQueue({
  words = [],
  reviewStates = [],
  settings = {},
  todayISO,
  tagFilter = null,
} = {}) {
  const today = isoDate(todayISO);

  // Resolve caps. New limit defaults to 15 and is NEVER unlimited: null/undefined
  // both fall back to the default (0 still legitimately means "introduce none").
  // Review limit defaults to unlimited (null).
  const rawNew =
    settings.dailyNewLimit === undefined || settings.dailyNewLimit === null
      ? DEFAULT_DAILY_NEW_LIMIT
      : settings.dailyNewLimit;
  const newCapN = normalizeCap(rawNew);
  const newCap = newCapN === null ? DEFAULT_DAILY_NEW_LIMIT : newCapN;
  const reviewCap = normalizeCap(
    settings.dailyReviewLimit !== undefined
      ? settings.dailyReviewLimit
      : DEFAULT_DAILY_REVIEW_LIMIT
  );

  // How many new cards were already introduced today (across the whole deck,
  // not just the in-scope/tag-filtered subset): this is the per-day budget that
  // makes re-entering the session RESUME rather than restart.
  let introducedToday = 0;
  for (const s of reviewStates) {
    if (s && s.introducedOn === today) introducedToday += 1;
  }
  const newAllowance = Math.max(0, newCap - introducedToday);

  // Index words by id, and pre-filter the allowed id set by tag if requested.
  const wordById = new Map();
  let allowedIds = null;
  if (tagFilter != null && tagFilter !== '') {
    allowedIds = new Set();
  }
  for (const w of words) {
    if (!w || typeof w.id !== 'string') continue;
    wordById.set(w.id, w);
    if (allowedIds) {
      const tags = Array.isArray(w.tags) ? w.tags : [];
      if (tags.includes(tagFilter)) allowedIds.add(w.id);
    }
  }

  const inScope = (id) => wordById.has(id) && (allowedIds === null || allowedIds.has(id));

  // Partition review states into "due reviews" and "new cards".
  const dueReviews = [];
  const newCards = [];
  for (const s of reviewStates) {
    if (!s || typeof s.id !== 'string') continue;
    if (!inScope(s.id)) continue;

    if (isNewState(s)) {
      newCards.push(s);
    } else if (typeof s.due === 'string' && s.due <= today) {
      // An introduced card whose due date has arrived (string comparison
      // matches calendar order for 'YYYY-MM-DD').
      dueReviews.push(s);
    }
    // else: introduced card not yet due -> not in today's queue.
  }

  // Reviews ordered by due ascending (earliest/most overdue first); stable tie
  // break by id so the order is deterministic.
  dueReviews.sort((a, b) => {
    if (a.due < b.due) return -1;
    if (a.due > b.due) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Order new candidates by (real COCA freq asc, then tag tierRank asc as a
  // fallback for unranked words, then day-stable hash asc). The real frequency
  // rank means the most common words are introduced first (frequency-first
  // pedagogy); tierRank only orders words whose freq is missing/0; the hash makes
  // the within-day order deterministic (stable for resume) yet vary across days
  // and never alphabetical.
  newCards.sort((a, b) => {
    const wa = wordById.get(a.id);
    const wb = wordById.get(b.id);
    const fa = freqRank(wa);
    const fb = freqRank(wb);
    if (fa !== fb) return fa - fb;
    // Equal/both-unranked frequency: fall back to coarse tag tier.
    const ra = tierRank(wa);
    const rb = tierRank(wb);
    if (ra !== rb) return ra - rb;
    const ha = stableHash(`${a.id}|${today}`);
    const hb = stableHash(`${b.id}|${today}`);
    if (ha !== hb) return ha - hb;
    // Final deterministic tie-break by id (hash collisions only).
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const cappedReviews = reviewCap === null ? dueReviews : dueReviews.slice(0, reviewCap);
  // Cap new cards by the REMAINING daily allowance (limit minus already
  // introduced today), so resuming a session never restarts and never overflows
  // the daily new-card limit.
  const cappedNew = newCards.slice(0, newAllowance);

  // Reviews first, then new cards.
  const queue = [];
  for (const s of cappedReviews) queue.push({ wordId: s.id, isNew: false });
  for (const s of cappedNew) queue.push({ wordId: s.id, isNew: true });
  return queue;
}
