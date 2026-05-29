// tests/vocab-estimate.test.js
// No-dependency unit tests for the pure vocab-estimate module (frequency-band
// methodology). Run with: node tests/vocab-estimate.test.js  (exit 0 on pass).
// Uses Node's built-in node:test + node:assert (no external packages).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assignTier,
  buildVocabTest,
  estimateVocabulary,
  TIERS,
  PROGRAMMING_POPULATION,
} from '../js/vocab-estimate.js';

// --------------------------------------------------------------------------
// Deterministic RNG (mulberry32) so sampling/shuffling is reproducible.
// --------------------------------------------------------------------------
function seededRng(seed = 12345) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The two band keys we sample most in tests.
const BAND_KEYS = TIERS.map((t) => t.key); // ['band1'..'band8']

// Build a synthetic corpus with a known number of words per frequency band +
// programming. Each word gets a `freq` that lands squarely inside its band, and
// a unique def_zh so distractor distinctness is easy to verify.
function makeWords({ perBand = 10, programming = 20 } = {}) {
  const words = [];
  let n = 0;
  for (const b of TIERS) {
    for (let i = 0; i < perBand; i += 1) {
      n += 1;
      // freq inside [lo, hi]: lo + i keeps each word within the band.
      const freq = Math.min(b.hi, b.lo + i);
      words.push({
        id: `w${String(n).padStart(4, '0')}`,
        word: `word${n}`,
        phonetic: `/p${n}/`,
        def_zh: `释义${n}`,
        def_en: `def ${n}`,
        examples: [],
        root_affix: '',
        tags: ['common'],
        freq,
      });
    }
  }
  // Programming words: tagged programming, freq 0 (typical for CS terms).
  for (let i = 0; i < programming; i += 1) {
    n += 1;
    words.push({
      id: `w${String(n).padStart(4, '0')}`,
      word: `prog${n}`,
      phonetic: `/p${n}/`,
      def_zh: `编程释义${n}`,
      def_en: `prog def ${n}`,
      examples: [],
      root_affix: '',
      tags: ['programming', 'cs'],
      freq: 0,
    });
  }
  return words;
}

// --------------------------------------------------------------------------
// assignTier: frequency-band assignment + programming + unranked
// --------------------------------------------------------------------------

test('assignTier maps a word to its frequency band by real COCA rank', () => {
  assert.equal(assignTier({ freq: 1 }), 'band1');
  assert.equal(assignTier({ freq: 1000 }), 'band1');
  assert.equal(assignTier({ freq: 1001 }), 'band2');
  assert.equal(assignTier({ freq: 2000 }), 'band2');
  assert.equal(assignTier({ freq: 3001 }), 'band4');
  assert.equal(assignTier({ freq: 7001 }), 'band8');
  assert.equal(assignTier({ freq: 8000 }), 'band8');
});

test('assignTier: programming tag wins over band, freq 0 / out-of-range = unranked', () => {
  // Programming wins even when a freq lands in a band.
  assert.equal(assignTier({ freq: 50, tags: ['programming'] }), 'programming');
  assert.equal(assignTier({ freq: 0, tags: ['programming', 'cs'] }), 'programming');

  // Unranked: freq 0 / missing / beyond the modelled 8000 ceiling.
  assert.equal(assignTier({ freq: 0 }), 'unranked');
  assert.equal(assignTier({}), 'unranked');
  assert.equal(assignTier({ freq: 8001 }), 'unranked');
  assert.equal(assignTier({ freq: 42127 }), 'unranked');
});

// --------------------------------------------------------------------------
// buildVocabTest: band-stratified counts (<= available)
// --------------------------------------------------------------------------

test('buildVocabTest samples stratified per-band counts capped at availability', () => {
  // band1..band8 have 10 each except we make band8 short on purpose: rebuild.
  const words = makeWords({ perBand: 10, programming: 20 });
  // Trim band8 to 3 words to test the availability cap.
  const band8 = words.filter((w) => assignTier(w) === 'band8');
  const keep = new Set(band8.slice(0, 3).map((w) => w.id));
  const trimmed = words.filter((w) => assignTier(w) !== 'band8' || keep.has(w.id));

  const rng = seededRng(1);
  const questions = buildVocabTest(trimmed, {
    perTier: 5,
    programmingCount: 10,
    distractors: 3,
    rng,
  });

  const counts = {};
  for (const k of BAND_KEYS) counts[k] = 0;
  counts.programming = 0;
  for (const q of questions) counts[q.tier] += 1;

  // 7 full bands * 5 + band8 min(5,3)=3 + programming 10.
  assert.equal(counts.band1, 5);
  assert.equal(counts.band2, 5);
  assert.equal(counts.band7, 5);
  assert.equal(counts.band8, 3, 'band8 capped at the 3 available');
  assert.equal(counts.programming, 10);
  assert.equal(questions.length, 7 * 5 + 3 + 10);
});

test('buildVocabTest never samples unranked words', () => {
  const words = makeWords({ perBand: 4, programming: 4 });
  // Add some unranked words (freq 0, not programming) that must never appear.
  for (let i = 0; i < 5; i += 1) {
    words.push({
      id: `u${i}`, word: `unr${i}`, phonetic: '', def_zh: `生僻${i}`,
      def_en: '', examples: [], root_affix: '', tags: ['common'], freq: 0,
    });
  }
  const rng = seededRng(3);
  const questions = buildVocabTest(words, { perTier: 5, programmingCount: 5, rng });
  for (const q of questions) {
    assert.notEqual(q.tier, 'unranked', 'unranked words excluded from the test');
    assert.ok(!String(q.wordId).startsWith('u'), 'no unranked id sampled');
  }
});

test('buildVocabTest: each question has distractors+1 distinct options, correctIndex points to word def_zh', () => {
  const words = makeWords();
  const rng = seededRng(7);
  const distractors = 3;
  const wordById = new Map(words.map((w) => [w.id, w]));

  const questions = buildVocabTest(words, { perTier: 5, programmingCount: 10, distractors, rng });

  for (const q of questions) {
    assert.equal(q.options.length, distractors + 1, 'option count = distractors + 1');
    assert.equal(new Set(q.options).size, q.options.length, 'options must be distinct');
    assert.ok(q.correctIndex >= 0 && q.correctIndex < q.options.length, 'correctIndex in range');
    const word = wordById.get(q.wordId);
    assert.ok(word, 'question references a real word');
    assert.equal(q.options[q.correctIndex], word.def_zh, 'correctIndex points to the word def_zh');
    const wrong = q.options.filter((_, i) => i !== q.correctIndex);
    for (const d of wrong) {
      assert.notEqual(d, word.def_zh, 'distractor must not equal correct answer');
    }
  }
});

test('buildVocabTest is deterministic for a fixed seed', () => {
  const words = makeWords();
  const a = buildVocabTest(words, { rng: seededRng(99) });
  const b = buildVocabTest(words, { rng: seededRng(99) });
  assert.deepEqual(
    a.map((q) => [q.wordId, q.correctIndex, q.options]),
    b.map((q) => [q.wordId, q.correctIndex, q.options]),
    'same seed -> identical test'
  );
});

test('buildVocabTest handles empty input gracefully', () => {
  assert.deepEqual(buildVocabTest([], { rng: seededRng(1) }), []);
  assert.deepEqual(buildVocabTest(undefined, { rng: seededRng(1) }), []);
});

// --------------------------------------------------------------------------
// estimateVocabulary: knownRate math + general total + programming separate
// --------------------------------------------------------------------------

test('estimateVocabulary computes per-band knownRate and estimated = round(rate*population)', () => {
  // band1: 8/10 correct, band2: 5/10, band3: 2/10.
  const results = [];
  const add = (tier, n, correctCount) => {
    for (let i = 0; i < n; i += 1) results.push({ tier, correct: i < correctCount });
  };
  add('band1', 10, 8);
  add('band2', 10, 5);
  add('band3', 10, 2);

  const out = estimateVocabulary(results);
  const byKey = Object.fromEntries(out.perTier.map((t) => [t.key, t]));

  assert.equal(byKey.band1.knownRate, 0.8);
  assert.equal(byKey.band2.knownRate, 0.5);
  assert.equal(byKey.band3.knownRate, 0.2);

  const pop = Object.fromEntries(TIERS.map((t) => [t.key, t.population]));
  assert.equal(byKey.band1.estimated, Math.round(0.8 * pop.band1)); // 800
  assert.equal(byKey.band2.estimated, Math.round(0.5 * pop.band2)); // 500
  assert.equal(byKey.band3.estimated, Math.round(0.2 * pop.band3)); // 200

  // General total = sum of ALL band estimates (others shown=0 -> 0).
  assert.equal(out.total, byKey.band1.estimated + byKey.band2.estimated + byKey.band3.estimated);
  assert.equal(out.total, 800 + 500 + 200);
  assert.equal(out.sampleSize, 30);

  // perTier reports all 8 bands.
  assert.equal(out.perTier.length, 8);
});

test('estimateVocabulary reports programming separately and excludes it from total', () => {
  const results = [
    // every general band fully correct (1/1 each).
    ...TIERS.map((t) => ({ tier: t.key, correct: true })),
    // programming: 6/10 correct.
    ...Array.from({ length: 10 }, (_, i) => ({ tier: 'programming', correct: i < 6 })),
  ];

  const out = estimateVocabulary(results);

  assert.equal(out.programming.shown, 10);
  assert.equal(out.programming.correct, 6);
  assert.equal(out.programming.knownRate, 0.6);
  assert.equal(out.programming.estimated, Math.round(0.6 * PROGRAMMING_POPULATION)); // 360

  // total = sum of all band populations (each 1/1 -> full population).
  const generalSum = TIERS.reduce((s, t) => s + t.population, 0); // 8000
  assert.equal(out.total, generalSum);
  assert.ok(out.total !== generalSum + out.programming.estimated, 'programming excluded from total');
});

test('estimateVocabulary ignores unranked results (excluded from total)', () => {
  const out = estimateVocabulary([
    { tier: 'band1', correct: true },
    { tier: 'unranked', correct: true },
    { tier: 'unranked', correct: true },
  ]);
  const byKey = Object.fromEntries(out.perTier.map((t) => [t.key, t]));
  assert.equal(byKey.band1.estimated, TIERS[0].population);
  // unranked never appears as a perTier band and never contributes to total.
  assert.ok(!out.perTier.some((t) => t.key === 'unranked'));
  assert.equal(out.total, TIERS[0].population);
  assert.equal(out.sampleSize, 3, 'sampleSize still counts every result row');
});

test('estimateVocabulary edge cases: 0 shown band, all correct, none correct', () => {
  // Empty results -> everything zero.
  const empty = estimateVocabulary([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.sampleSize, 0);
  assert.equal(empty.perTier.length, 8);
  for (const t of empty.perTier) {
    assert.equal(t.shown, 0);
    assert.equal(t.correct, 0);
    assert.equal(t.knownRate, 0, 'knownRate is 0 when nothing shown');
    assert.equal(t.estimated, 0);
  }
  assert.equal(empty.programming.shown, 0);
  assert.equal(empty.programming.knownRate, 0);
  assert.equal(empty.programming.estimated, 0);

  // All correct -> each band estimated == its full population.
  const allCorrect = estimateVocabulary(TIERS.map((t) => ({ tier: t.key, correct: true })));
  const byKey = Object.fromEntries(allCorrect.perTier.map((t) => [t.key, t]));
  for (const t of TIERS) {
    assert.equal(byKey[t.key].knownRate, 1);
    assert.equal(byKey[t.key].estimated, t.population);
  }
  assert.equal(allCorrect.total, TIERS.reduce((s, t) => s + t.population, 0));

  // None correct -> total 0 but bands were shown.
  const noneCorrect = estimateVocabulary(TIERS.map((t) => ({ tier: t.key, correct: false })));
  assert.equal(noneCorrect.total, 0);
  for (const t of noneCorrect.perTier) {
    assert.equal(t.shown, 1);
    assert.equal(t.correct, 0);
    assert.equal(t.knownRate, 0);
    assert.equal(t.estimated, 0);
  }
});

test('estimateVocabulary respects injected band populations (recalibration hook)', () => {
  const customBands = [
    { key: 'band1', label: 'B1', population: 2000 },
    { key: 'band2', label: 'B2', population: 2000 },
  ];
  const out = estimateVocabulary(
    [
      { tier: 'band1', correct: true },
      { tier: 'band1', correct: false }, // 1/2 = 0.5
    ],
    { tiers: customBands, programmingPopulation: 100 }
  );
  const b1 = out.perTier.find((t) => t.key === 'band1');
  assert.equal(b1.knownRate, 0.5);
  assert.equal(b1.estimated, 1000);
  assert.equal(out.total, 1000); // band2 shown=0 -> 0
});
