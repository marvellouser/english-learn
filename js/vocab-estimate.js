// vocab-estimate.js
// PURE vocabulary-size estimation module: FREQUENCY-BAND stratified sampling +
// per-band extrapolation. No DOM, no IndexedDB, no browser globals, so it is
// fully importable and testable under plain Node (ESM).
//
// METHODOLOGY
// -----------
// Every word now carries a REAL COCA frequency rank (`freq`, 1 = most frequent),
// stamped by the ECDICT data pipeline (tools/build_vocab.py). We partition the
// general vocabulary into 8 frequency BANDS of 1000 ranks each (1-1000, ...,
// 7001-8000) and assume each band contains 1000 distinct general-vocabulary
// words (the documented per-band population). Stratified sampling draws a few
// words from each band; the measured per-band known-rate is extrapolated against
// the 1000-word band population, and the band estimates are summed for the total.
// This is far more principled than the previous tag-tier heuristic: difficulty is
// now keyed off measured corpus frequency rather than coarse exam tags.
//
// Words whose freq is 0 / missing / beyond rank 8000 are 'unranked' and are
// EXCLUDED from the general total (they are out of the modelled 8000-word
// ceiling). Programming vocabulary is still handled SEPARATELY by tag and is
// excluded from the general total.
//
// API COMPATIBILITY
// -----------------
// The exported surface is unchanged so js/views/vocab-test.js keeps working:
//   assignTier(word)            -> band key (or 'programming' / 'unranked')
//   buildVocabTest(words, opts) -> same question shape, now stratified by band
//   estimateVocabulary(results) -> { total, perTier:[{key,label,population,...}],
//                                    programming:{...}, sampleSize }
//   TIERS                       -> now the frequency BANDS
//   PROGRAMMING_POPULATION
//
// Word shape consumed (mirrors db.js):
//   { id, word, phonetic, def_zh, def_en, examples[], root_affix, tags[], freq }

// ---------------------------------------------------------------------------
// Frequency-band configuration (documented assumptions — recalibratable)
// ---------------------------------------------------------------------------

/**
 * General-vocabulary FREQUENCY BANDS, easiest (most frequent) first. Each band
 * spans 1000 COCA ranks and is ASSUMED to hold `population` = 1000 distinct
 * general-vocabulary words. The 8 bands sum to an 8000-word general-vocabulary
 * ceiling. `lo`/`hi` are the inclusive COCA-rank bounds used by assignTier.
 *
 * (Exported as TIERS to keep the historical name/shape that vocab-test.js and
 * the tests consume; semantically these are now frequency bands, not tag tiers.)
 *
 * @type {Array<{key:string, label:string, population:number, lo:number, hi:number}>}
 */
export const TIERS = [
  { key: 'band1', label: '最常用 1-1000', population: 1000, lo: 1, hi: 1000 },
  { key: 'band2', label: '高频 1001-2000', population: 1000, lo: 1001, hi: 2000 },
  { key: 'band3', label: '常用 2001-3000', population: 1000, lo: 2001, hi: 3000 },
  { key: 'band4', label: '中频 3001-4000', population: 1000, lo: 3001, hi: 4000 },
  { key: 'band5', label: '中频 4001-5000', population: 1000, lo: 4001, hi: 5000 },
  { key: 'band6', label: '较低频 5001-6000', population: 1000, lo: 5001, hi: 6000 },
  { key: 'band7', label: '低频 6001-7000', population: 1000, lo: 6001, hi: 7000 },
  { key: 'band8', label: '低频 7001-8000', population: 1000, lo: 7001, hi: 8000 },
];

/**
 * Assumed programming-vocabulary population. Programming is reported SEPARATELY
 * and is NOT included in the general vocabulary total.
 * @type {number}
 */
export const PROGRAMMING_POPULATION = 600;

// The general-vocabulary modelled ceiling (sum of band populations).
const MODELLED_CEILING = TIERS[TIERS.length - 1].hi; // 8000

// ---------------------------------------------------------------------------
// Tier (band) assignment
// ---------------------------------------------------------------------------

/**
 * Assign a word to a frequency band key by its real COCA rank (`freq`).
 *
 * Priority:
 *   has 'programming' tag                 -> 'programming'  (reported separately)
 *   freq within a band (1..8000)          -> that band key ('band1'..'band8')
 *   freq 0 / missing / > 8000             -> 'unranked' (excluded from total)
 *
 * Programming wins first so CS terms (often unranked in COCA) are still reported
 * in the programming block rather than dropped as 'unranked'.
 *
 * @param {{freq?:number, tags?:string[]}} word
 * @returns {('band1'|'band2'|'band3'|'band4'|'band5'|'band6'|'band7'|'band8'|'programming'|'unranked')}
 */
export function assignTier(word) {
  const tags = Array.isArray(word && word.tags) ? word.tags : [];
  if (tags.includes('programming')) return 'programming';
  const freq = word && typeof word.freq === 'number' ? word.freq : 0;
  if (freq > 0 && freq <= MODELLED_CEILING) {
    for (const b of TIERS) {
      if (freq >= b.lo && freq <= b.hi) return b.key;
    }
  }
  return 'unranked';
}

// ---------------------------------------------------------------------------
// Deterministic shuffle / sampling helpers (use injected rng for testability)
// ---------------------------------------------------------------------------

/**
 * Fisher-Yates shuffle into a NEW array, using the injected rng for every draw.
 * @template T
 * @param {T[]} arr
 * @param {() => number} rng - returns a float in [0, 1)
 * @returns {T[]}
 */
function shuffle(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Sample up to n items from arr without replacement (shuffled order).
 * @template T
 * @param {T[]} arr
 * @param {number} n
 * @param {() => number} rng
 * @returns {T[]} min(n, arr.length) items in shuffled order
 */
function sample(arr, n, rng) {
  return shuffle(arr, rng).slice(0, Math.max(0, Math.min(n, arr.length)));
}

// ---------------------------------------------------------------------------
// Test builder
// ---------------------------------------------------------------------------

/**
 * Build an ordered, frequency-band-stratified vocabulary test from a word list.
 *
 * Sampling: up to `perTier` words from EACH general band (band1..band8) plus up
 * to `programmingCount` programming words. Each sampled count is
 * min(requested, available). 'unranked' words are never sampled. The combined
 * question order is shuffled.
 *
 * Each question:
 *   {
 *     wordId, word, phonetic, tier,   // tier = band key (or 'programming')
 *     options: string[]  // (distractors + 1) distinct Chinese definitions
 *     correctIndex       // index of the word's own def_zh within options
 *   }
 * The correct option is the word's def_zh; distractors are other words' def_zh,
 * chosen at random, all DISTINCT and none equal to the correct answer.
 *
 * @param {Array<object>} words - all word records
 * @param {object} [opts]
 * @param {number} [opts.perTier=5] - words sampled per frequency band
 * @param {number} [opts.programmingCount=10] - programming words sampled
 * @param {number} [opts.distractors=3] - wrong options per question
 * @param {() => number} [opts.rng=Math.random] - injected rng for sampling/shuffle
 * @returns {Array<{wordId:string, word:string, phonetic:string, tier:string, options:string[], correctIndex:number}>}
 */
export function buildVocabTest(
  words,
  { perTier = 5, programmingCount = 10, distractors = 3, rng = Math.random } = {}
) {
  const list = Array.isArray(words) ? words : [];

  // Bucket words by band/programming; only keep words with a usable def_zh
  // (needed as both the correct option and as a potential distractor).
  const byTier = {};
  for (const b of TIERS) byTier[b.key] = [];
  byTier.programming = [];
  byTier.unranked = [];
  const allDefs = [];
  for (const w of list) {
    if (!w || typeof w.id !== 'string') continue;
    const def = typeof w.def_zh === 'string' ? w.def_zh : '';
    if (!def) continue;
    const tier = assignTier(w);
    if (byTier[tier]) byTier[tier].push(w);
    allDefs.push(def);
  }

  // Stratified sample: each general band, then programming. 'unranked' excluded.
  const chosen = [];
  for (const b of TIERS) {
    for (const w of sample(byTier[b.key], perTier, rng)) chosen.push(w);
  }
  for (const w of sample(byTier.programming, programmingCount, rng)) chosen.push(w);

  // Unique pool of all definitions for distractor selection.
  const uniqueDefs = Array.from(new Set(allDefs));

  // Build one question per chosen word.
  const questions = chosen.map((w) => {
    const correct = w.def_zh;

    // Candidate distractors: every distinct def_zh that is not the correct one.
    const pool = uniqueDefs.filter((d) => d !== correct);
    const picks = sample(pool, distractors, rng);

    // Assemble options (correct + distractors), then shuffle and record index.
    const options = shuffle([correct, ...picks], rng);
    const correctIndex = options.indexOf(correct);

    return {
      wordId: w.id,
      word: w.word,
      phonetic: typeof w.phonetic === 'string' ? w.phonetic : '',
      tier: assignTier(w),
      options,
      correctIndex,
    };
  });

  // Shuffle the overall question order so bands are interleaved.
  return shuffle(questions, rng);
}

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

/**
 * Estimate vocabulary size from per-question results.
 *
 * For each general frequency band: knownRate = correct / shown (0 when nothing
 * shown), estimated = round(knownRate * population). The general TOTAL is the sum
 * of the bands' estimates. Programming is computed the same way but reported
 * SEPARATELY (excluded from total). 'unranked' results, if any, are ignored.
 *
 * @param {Array<{tier:string, correct:boolean}>} results
 * @param {object} [opts]
 * @param {Array<{key:string,label:string,population:number}>} [opts.tiers=TIERS]
 * @param {number} [opts.programmingPopulation=PROGRAMMING_POPULATION]
 * @returns {{
 *   total:number,
 *   perTier: Array<{key:string,label:string,population:number,shown:number,correct:number,knownRate:number,estimated:number}>,
 *   programming: {shown:number,correct:number,knownRate:number,estimated:number},
 *   sampleSize:number
 * }}
 */
export function estimateVocabulary(
  results,
  { tiers = TIERS, programmingPopulation = PROGRAMMING_POPULATION } = {}
) {
  const list = Array.isArray(results) ? results : [];

  // Tally shown/correct per tier (band) key.
  const tally = new Map(); // key -> { shown, correct }
  const bump = (key, ok) => {
    const cur = tally.get(key) || { shown: 0, correct: 0 };
    cur.shown += 1;
    if (ok) cur.correct += 1;
    tally.set(key, cur);
  };
  for (const r of list) {
    if (!r || typeof r.tier !== 'string') continue;
    bump(r.tier, r.correct === true);
  }

  // General bands: estimate + sum into total.
  let total = 0;
  const perTier = tiers.map((t) => {
    const cur = tally.get(t.key) || { shown: 0, correct: 0 };
    const knownRate = cur.shown ? cur.correct / cur.shown : 0;
    const estimated = Math.round(knownRate * t.population);
    total += estimated;
    return {
      key: t.key,
      label: t.label,
      population: t.population,
      shown: cur.shown,
      correct: cur.correct,
      knownRate,
      estimated,
    };
  });

  // Programming: separate, excluded from total.
  const pg = tally.get('programming') || { shown: 0, correct: 0 };
  const pgKnownRate = pg.shown ? pg.correct / pg.shown : 0;
  const programming = {
    shown: pg.shown,
    correct: pg.correct,
    knownRate: pgKnownRate,
    estimated: Math.round(pgKnownRate * programmingPopulation),
  };

  return {
    total,
    perTier,
    programming,
    sampleSize: list.length,
  };
}
