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

// ---------------------------------------------------------------------------
// Difficulty model (PURE; derived from the per-word COCA frequency rank `freq`)
// ---------------------------------------------------------------------------

// Frequency-rank cutoffs defining the 3 difficulty tiers. `freq` is the word's
// COCA rank (1 = most common). The boundaries are inclusive on the upper edge:
//   easy   : 1 .. easyMax            (the most common words)
//   medium : easyMax+1 .. mediumMax  (mid-frequency words)
//   hard   : > mediumMax, OR freq missing/0 (unranked / rare / specialized)
export const DIFFICULTY_THRESHOLDS = { easyMax: 2000, mediumMax: 5000 };

// Localized labels for the three difficulty tiers (Chinese UI).
export const DIFFICULTY_LABELS = { easy: '简单', medium: '中等', hard: '困难' };

// Default daily new-word difficulty mix (percentages summing to 100). Used as
// the fallback when settings omit / supply an invalid difficultyMix.
export const DEFAULT_DIFFICULTY_MIX = { easy: 20, medium: 50, hard: 30 };

/**
 * Classify a word into a difficulty tier from its COCA frequency rank `freq`.
 * A numeric, positive freq within easyMax is 'easy'; within mediumMax is
 * 'medium'; anything beyond mediumMax is 'hard'. A missing / zero / non-positive
 * freq means unranked (rare / specialized) and is treated as 'hard'.
 *
 * @param {{freq?:number}} word
 * @returns {('easy'|'medium'|'hard')}
 */
export function difficultyOf(word) {
  const f = word && typeof word.freq === 'number' ? word.freq : 0;
  if (f >= 1 && f <= DIFFICULTY_THRESHOLDS.easyMax) return 'easy';
  if (f > DIFFICULTY_THRESHOLDS.easyMax && f <= DIFFICULTY_THRESHOLDS.mediumMax) return 'medium';
  // f > mediumMax OR missing / 0 / non-positive -> hard (rare / unranked).
  return 'hard';
}

/**
 * Validate + normalize a difficulty-mix object to whole-number percentages that
 * sum to exactly 100. Invalid / partial input falls back to the default mix.
 * The normalization scales each tier proportionally, then fixes any rounding
 * drift by absorbing it into the largest tier so the three values always sum to
 * 100 (and never go negative).
 *
 * @param {*} mix - candidate { easy, medium, hard } (percentages)
 * @returns {{easy:number, medium:number, hard:number}} normalized to sum 100
 */
export function normalizeDifficultyMix(mix) {
  const pick = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  };
  let e = mix ? pick(mix.easy) : NaN;
  let m = mix ? pick(mix.medium) : NaN;
  let h = mix ? pick(mix.hard) : NaN;

  // Any invalid tier, or an all-zero total, falls back to the default mix.
  if (Number.isNaN(e) || Number.isNaN(m) || Number.isNaN(h)) {
    return { ...DEFAULT_DIFFICULTY_MIX };
  }
  const total = e + m + h;
  if (total <= 0) {
    return { ...DEFAULT_DIFFICULTY_MIX };
  }

  // Scale to 100 and round; absorb rounding drift into the largest tier.
  let re = Math.round((e / total) * 100);
  let rm = Math.round((m / total) * 100);
  let rh = Math.round((h / total) * 100);
  const drift = 100 - (re + rm + rh);
  if (drift !== 0) {
    // Add the drift to whichever tier is currently largest (stable: easy>med>hard).
    if (re >= rm && re >= rh) re += drift;
    else if (rm >= rh) rm += drift;
    else rh += drift;
  }
  // Guard against a negative produced by a large negative drift on a tiny tier.
  re = Math.max(0, re);
  rm = Math.max(0, rm);
  rh = Math.max(0, rh);
  return { easy: re, medium: rm, hard: rh };
}

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
 * Build the word index + tag-scope predicate shared by the queue builders.
 * @param {Array<object>} words
 * @param {string|null} tagFilter
 * @returns {{wordById: Map<string,object>, inScope: (id:string)=>boolean}}
 */
function buildScope(words, tagFilter) {
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
  return { wordById, inScope };
}

/**
 * Stable freq-asc comparator (then tag tier, then day-stable hash, then id) used
 * to order NEW candidates. Shared by both queue builders so their ordering is
 * identical.
 * @param {Map<string,object>} wordById
 * @param {string} today
 * @returns {(a:{id:string}, b:{id:string}) => number}
 */
function newCardComparator(wordById, today) {
  return (a, b) => {
    const wa = wordById.get(a.id);
    const wb = wordById.get(b.id);
    const fa = freqRank(wa);
    const fb = freqRank(wb);
    if (fa !== fb) return fa - fb;
    const ra = tierRank(wa);
    const rb = tierRank(wb);
    if (ra !== rb) return ra - rb;
    const ha = stableHash(`${a.id}|${today}`);
    const hb = stableHash(`${b.id}|${today}`);
    if (ha !== hb) return ha - hb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/**
 * Compose up to `budget` NEW cards from freq-ordered candidates honoring the
 * difficulty mix (with cross-tier backfill), then re-sort the picked set by
 * freq-asc for a smooth session. PURE: returns a NEW array of states.
 *
 * The per-tier whole-day targets come from `mix` scaled to `targetN`; the
 * per-tier `introduced` counts reduce each tier's remaining quota (resume
 * support); the running total never exceeds `budget`. buildDailyQueue passes
 * targetN === budget (whole-day budget). buildExtraQueue passes targetN ===
 * budget === limit with introduced all-zero (no daily-cap accounting).
 *
 * @param {Array<{id:string}>} newCards - freq-ordered new candidate states
 * @param {Map<string,object>} wordById
 * @param {{easy:number, medium:number, hard:number}} mix - normalized to 100
 * @param {number} targetN - N used to derive per-tier targets
 * @param {number} budget - hard cap on the number of cards returned
 * @param {{easy:number, medium:number, hard:number}} introduced - per-tier already-taken
 * @param {string} today - 'YYYY-MM-DD' for the day-stable hash
 * @returns {Array<{id:string}>} composed + freq-ordered picks
 */
function composeNewCards(newCards, wordById, mix, targetN, budget, introduced, today) {
  // Whole-day per-tier targets. Hard absorbs the rounding remainder so the
  // three targets sum to exactly targetN.
  const tEasy = Math.round((targetN * mix.easy) / 100);
  const tMed = Math.round((targetN * mix.medium) / 100);
  const tHard = targetN - tEasy - tMed;
  const target = { easy: tEasy, medium: tMed, hard: Math.max(0, tHard) };

  // Group the freq-ordered candidates by difficulty (order preserved).
  const candByTier = { easy: [], medium: [], hard: [] };
  for (const s of newCards) {
    const w = wordById.get(s.id);
    candByTier[difficultyOf(w)].push(s);
  }

  const overallAllowance = Math.max(0, budget);

  // First pass: take up to each tier's remaining quota (target - introduced),
  // but never let the running total exceed overallAllowance.
  const picked = [];
  const pickedIds = new Set();
  const cursor = { easy: 0, medium: 0, hard: 0 };
  for (const tier of ['easy', 'medium', 'hard']) {
    const remaining = Math.max(0, target[tier] - introduced[tier]);
    const list = candByTier[tier];
    let taken = 0;
    while (taken < remaining && cursor[tier] < list.length && picked.length < overallAllowance) {
      const s = list[cursor[tier]];
      cursor[tier] += 1;
      picked.push(s);
      pickedIds.add(s.id);
      taken += 1;
    }
  }

  // Backfill: if the first pass picked fewer than overallAllowance, fill the
  // shortfall from the remaining unseen candidates of ALL tiers, ordered freq-asc.
  if (picked.length < overallAllowance) {
    const leftovers = [];
    for (const tier of ['easy', 'medium', 'hard']) {
      const list = candByTier[tier];
      for (let i = cursor[tier]; i < list.length; i += 1) {
        if (!pickedIds.has(list[i].id)) leftovers.push(list[i]);
      }
    }
    leftovers.sort(newCardComparator(wordById, today));
    for (const s of leftovers) {
      if (picked.length >= overallAllowance) break;
      if (pickedIds.has(s.id)) continue;
      picked.push(s);
      pickedIds.add(s.id);
    }
  }

  // Final new list ordered by freq asc (stable) for a smooth session.
  picked.sort(newCardComparator(wordById, today));
  return picked;
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

  // Index words by id, and pre-filter the allowed id set by tag if requested.
  const { wordById, inScope } = buildScope(words, tagFilter);

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
  newCards.sort(newCardComparator(wordById, today));

  const cappedReviews = reviewCap === null ? dueReviews : dueReviews.slice(0, reviewCap);

  // --- NEW-card composition by difficulty mix (with backfill) --------------
  // N = whole-day new-card budget (dailyNewLimit). Per-tier whole-day targets
  // come from the user's difficultyMix; per-tier "already introduced today"
  // counts (across the whole deck, grouped by difficulty) reduce each tier's
  // remaining quota so re-entering the session RESUMES rather than restarts.
  const N = newCap;
  const mix = normalizeDifficultyMix(settings.difficultyMix);

  // Per-tier already-introduced-today: count states stamped introducedOn=today
  // across the WHOLE deck (the daily budget is deck-wide), grouped by the
  // difficulty of their word. States whose word is unknown are ignored.
  const introduced = { easy: 0, medium: 0, hard: 0 };
  let introducedToday = 0;
  for (const s of reviewStates) {
    if (!s || s.introducedOn !== today) continue;
    introducedToday += 1;
    const w = wordById.get(s.id);
    if (!w) continue;
    introduced[difficultyOf(w)] += 1;
  }

  // The whole-day allowance left after accounting for everything already
  // introduced today (deck-wide). The composed new list never exceeds this, so
  // the daily new-card cap is honored even when some introduced-today states
  // belong to out-of-scope words.
  const overallAllowance = Math.max(0, N - introducedToday);

  const cappedNew = composeNewCards(
    newCards,
    wordById,
    mix,
    N,
    overallAllowance,
    introduced,
    today
  );

  // Reviews first, then new cards.
  const queue = [];
  for (const s of cappedReviews) queue.push({ wordId: s.id, isNew: false });
  for (const s of cappedNew) queue.push({ wordId: s.id, isNew: true });
  return queue;
}

/**
 * Build an EXTRA study queue of unseen new words, IGNORING the daily
 * `introducedToday` cap. PURE.
 *
 * Used by the "继续学习更多新词" flow: after finishing the daily set (or when the
 * daily queue is empty on entry), the learner can keep going through fresh
 * vocabulary. Each call returns up to `limit` brand-new words
 * (reps === 0 && lastReviewed === null), composed by the SAME difficulty-mix
 * logic as buildDailyQueue (with cross-tier backfill) and ordered freq-asc, but
 * WITHOUT subtracting anything already introduced today — the whole point of an
 * "extra" batch is to go beyond the daily quota.
 *
 * Rating these cards still flows through applyReview/putReviewState in the UI;
 * they get scheduled normally and stamped introducedOn=today (harmless: the cap
 * is deliberately bypassed here). Calling again after finishing a batch yields
 * the NEXT `limit` unseen words, because the studied ones are no longer new.
 *
 * @param {object} args
 * @param {Array<object>} args.words - all word records
 * @param {Array<object>} args.reviewStates - all review-state records
 * @param {object} [args.settings] - { difficultyMix } (only the mix is read)
 * @param {string|Date} args.todayISO - 'YYYY-MM-DD' (or Date) "today"
 * @param {string|null} [args.tagFilter] - restrict to words carrying this tag
 * @param {number} [args.limit=20] - max unseen words to return
 * @returns {Array<{wordId:string, isNew:boolean}>} ordered queue (all isNew:true)
 */
export function buildExtraQueue({
  words = [],
  reviewStates = [],
  settings = {},
  todayISO,
  tagFilter = null,
  limit = 20,
} = {}) {
  const today = isoDate(todayISO);

  // A non-positive / invalid limit yields an empty batch.
  const cap = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : 0;
  if (cap === 0) return [];

  const { wordById, inScope } = buildScope(words, tagFilter);

  // Collect every brand-new (unseen) in-scope card.
  const newCards = [];
  for (const s of reviewStates) {
    if (!s || typeof s.id !== 'string') continue;
    if (!inScope(s.id)) continue;
    if (isNewState(s)) newCards.push(s);
  }

  // Order by the same freq-asc / tier / day-stable-hash key as the daily queue.
  newCards.sort(newCardComparator(wordById, today));

  // Compose up to `cap` cards by the difficulty mix, IGNORING the daily cap:
  // introduced counts are all-zero and both targetN and budget are the limit.
  const mix = normalizeDifficultyMix(settings.difficultyMix);
  const picked = composeNewCards(
    newCards,
    wordById,
    mix,
    cap,
    cap,
    { easy: 0, medium: 0, hard: 0 },
    today
  );

  return picked.map((s) => ({ wordId: s.id, isNew: true }));
}
