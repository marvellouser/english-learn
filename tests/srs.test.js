// tests/srs.test.js
// No-dependency unit tests for the pure SM-2 engine in js/srs.js.
// Run with:  node tests/srs.test.js      (exit 0 on pass, 1 on failure)
// Uses Node's built-in node:test + node:assert (no external packages).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  gradeFromRating,
  applyReview,
  buildDailyQueue,
  addDays,
  isoDate,
  tierRank,
  freqRank,
  stableHash,
  MIN_EASE,
  INITIAL_EASE,
} from '../js/srs.js';

const TODAY = '2026-05-29';

// Build a fresh, never-reviewed (new) card state.
function newState(id = 'w1') {
  return {
    id,
    ease: INITIAL_EASE,
    interval: 0,
    reps: 0,
    due: TODAY,
    lastReviewed: null,
    introducedOn: null,
  };
}

// --------------------------------------------------------------------------
// Date helpers
// --------------------------------------------------------------------------

test('addDays advances calendar days and crosses month/year boundaries', () => {
  assert.equal(addDays('2026-05-29', 1), '2026-05-30');
  assert.equal(addDays('2026-05-29', 6), '2026-06-04'); // crosses month end
  assert.equal(addDays('2026-12-31', 1), '2027-01-01'); // crosses year
  assert.equal(addDays('2026-05-29', 0), '2026-05-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('isoDate normalizes Date and passes through date strings', () => {
  assert.equal(isoDate('2026-05-29'), '2026-05-29');
  assert.equal(isoDate('2026-05-29T13:45:00Z'), '2026-05-29');
  // Construct a local Date to avoid tz drift, then verify formatting.
  const d = new Date(2026, 4, 29); // May = month index 4
  assert.equal(isoDate(d), '2026-05-29');
});

// --------------------------------------------------------------------------
// gradeFromRating
// --------------------------------------------------------------------------

test('gradeFromRating maps all three tiers (string keys, localized, numeric)', () => {
  // 不认识 -> 0
  assert.equal(gradeFromRating('again'), 0);
  assert.equal(gradeFromRating('不认识'), 0); // 不认识
  assert.equal(gradeFromRating(0), 0);

  // 模糊 -> 3
  assert.equal(gradeFromRating('hard'), 3);
  assert.equal(gradeFromRating('模糊'), 3); // 模糊
  assert.equal(gradeFromRating(1), 3);

  // 认识 -> 5
  assert.equal(gradeFromRating('good'), 5);
  assert.equal(gradeFromRating('认识'), 5); // 认识
  assert.equal(gradeFromRating(2), 5);
});

test('gradeFromRating rejects unknown ratings', () => {
  assert.throws(() => gradeFromRating('nope'), RangeError);
});

// --------------------------------------------------------------------------
// applyReview: interval progression 1 -> 6 -> round(interval * ease)
// --------------------------------------------------------------------------

test('successive good reviews progress interval 1 -> 6 -> round(interval*ease)', () => {
  const q = gradeFromRating('good'); // 5

  const s0 = newState();
  // First correct review: reps 0 -> 1, interval -> 1.
  const s1 = applyReview(s0, q, TODAY);
  assert.equal(s1.reps, 1);
  assert.equal(s1.interval, 1);
  assert.equal(s1.due, addDays(TODAY, 1));
  assert.equal(s1.lastReviewed, TODAY);
  // q=5 raises ease by +0.1.
  assert.ok(Math.abs(s1.ease - (INITIAL_EASE + 0.1)) < 1e-9);

  // Second correct review: reps 1 -> 2, interval -> 6.
  const s2 = applyReview(s1, q, addDays(TODAY, 1));
  assert.equal(s2.reps, 2);
  assert.equal(s2.interval, 6);
  assert.equal(s2.due, addDays(addDays(TODAY, 1), 6));

  // Third correct review: interval = round(prevInterval * newEase).
  const day3 = addDays(TODAY, 7);
  const s3 = applyReview(s2, q, day3);
  const expectedEase3 = s2.ease + 0.1; // q=5 again
  const expectedInterval3 = Math.round(s2.interval * expectedEase3);
  assert.equal(s3.reps, 3);
  assert.ok(Math.abs(s3.ease - expectedEase3) < 1e-9);
  assert.equal(s3.interval, expectedInterval3);
  assert.equal(s3.due, addDays(day3, expectedInterval3));
  // The interval grew beyond the previous value (forgetting curve lengthens).
  assert.ok(s3.interval > s2.interval);
});

// --------------------------------------------------------------------------
// applyReview: ease factor behaviour
// --------------------------------------------------------------------------

test('ease increases on good, decreases on hard, never below 1.3', () => {
  // 'good' (q=5): delta = +0.1
  const good = applyReview(newState(), gradeFromRating('good'), TODAY);
  assert.ok(good.ease > INITIAL_EASE);

  // 'hard' (q=3): delta = 0.1 - 2*(0.08 + 2*0.02) = 0.1 - 2*0.12 = -0.14
  const hard = applyReview(newState(), gradeFromRating('hard'), TODAY);
  assert.ok(Math.abs(hard.ease - (INITIAL_EASE - 0.14)) < 1e-9);
  assert.ok(hard.ease < INITIAL_EASE);

  // Ease floor: drive a low-ease card with repeated 'again' grades.
  let low = { id: 'w1', ease: 1.4, interval: 50, reps: 5, due: TODAY, lastReviewed: TODAY };
  for (let i = 0; i < 10; i += 1) {
    low = applyReview(low, gradeFromRating('again'), TODAY);
    assert.ok(low.ease >= MIN_EASE, `ease ${low.ease} must stay >= ${MIN_EASE}`);
  }
  assert.equal(low.ease, MIN_EASE);
});

// --------------------------------------------------------------------------
// applyReview: reset on wrong (q < 3)
// --------------------------------------------------------------------------

test('again resets reps and shortens interval, recomputing due to today+1', () => {
  // A mature card with a long interval.
  const mature = { id: 'w1', ease: 2.6, interval: 45, reps: 6, due: TODAY, lastReviewed: '2026-04-14' };
  const lapsed = applyReview(mature, gradeFromRating('again'), TODAY);

  assert.equal(lapsed.reps, 0, 'reps reset to 0 on failure');
  assert.equal(lapsed.interval, 1, 'interval shortened to 1 day');
  assert.equal(lapsed.due, addDays(TODAY, 1), 'due brought back to tomorrow');
  assert.equal(lapsed.lastReviewed, TODAY);
  // Failure still lowers the ease.
  assert.ok(lapsed.ease < mature.ease);
  // And it must be far below the long interval it replaced.
  assert.ok(lapsed.interval < mature.interval);
});

test('applyReview does not mutate the input state', () => {
  const s = newState();
  const snapshot = JSON.stringify(s);
  applyReview(s, gradeFromRating('good'), TODAY);
  assert.equal(JSON.stringify(s), snapshot, 'input state must be untouched');
});

// --------------------------------------------------------------------------
// buildDailyQueue
// --------------------------------------------------------------------------

function sampleWords() {
  return [
    { id: 'w1', word: 'alpha', tags: ['common'] },
    { id: 'w2', word: 'beta', tags: ['common', 'programming'] },
    { id: 'w3', word: 'gamma', tags: ['programming'] },
    { id: 'w4', word: 'delta', tags: ['common'] },
    { id: 'w5', word: 'epsilon', tags: ['common'] },
  ];
}

test('buildDailyQueue: reviews first (by due asc) then new cards, respecting dailyNewLimit', () => {
  const words = sampleWords();
  const reviewStates = [
    // Two due reviews with different due dates (w4 earlier than w1).
    { id: 'w1', ease: 2.5, interval: 3, reps: 2, due: '2026-05-28', lastReviewed: '2026-05-25' },
    { id: 'w4', ease: 2.5, interval: 3, reps: 2, due: '2026-05-20', lastReviewed: '2026-05-17' },
    // A not-yet-due review (future) -> excluded.
    { id: 'w5', ease: 2.5, interval: 10, reps: 3, due: '2026-06-10', lastReviewed: '2026-05-20' },
    // Two brand-new cards.
    { id: 'w2', ease: 2.5, interval: 0, reps: 0, due: TODAY, lastReviewed: null },
    { id: 'w3', ease: 2.5, interval: 0, reps: 0, due: TODAY, lastReviewed: null },
  ];

  const queue = buildDailyQueue({
    words,
    reviewStates,
    settings: { dailyNewLimit: 1, dailyReviewLimit: null },
    todayISO: TODAY,
  });

  // Reviews first, sorted by due ascending: w4 (05-20) then w1 (05-28).
  assert.deepEqual(queue[0], { wordId: 'w4', isNew: false });
  assert.deepEqual(queue[1], { wordId: 'w1', isNew: false });
  // dailyNewLimit = 1 -> exactly one new card (first in input order: w2).
  const newItems = queue.filter((i) => i.isNew);
  assert.equal(newItems.length, 1, 'new cards capped by dailyNewLimit');
  assert.deepEqual(newItems[0], { wordId: 'w2', isNew: true });
  // The future-due review w5 must not appear.
  assert.ok(!queue.some((i) => i.wordId === 'w5'));
  // Total = 2 reviews + 1 new.
  assert.equal(queue.length, 3);
});

test('buildDailyQueue: dailyReviewLimit caps reviews; null = unlimited', () => {
  const words = sampleWords();
  const reviewStates = [
    { id: 'w1', ease: 2.5, interval: 3, reps: 2, due: '2026-05-26', lastReviewed: '2026-05-23' },
    { id: 'w2', ease: 2.5, interval: 3, reps: 2, due: '2026-05-27', lastReviewed: '2026-05-24' },
    { id: 'w3', ease: 2.5, interval: 3, reps: 2, due: '2026-05-28', lastReviewed: '2026-05-25' },
  ];

  const capped = buildDailyQueue({
    words, reviewStates, settings: { dailyReviewLimit: 2, dailyNewLimit: 0 }, todayISO: TODAY,
  });
  assert.equal(capped.length, 2, 'reviews capped at 2');
  assert.deepEqual(capped.map((i) => i.wordId), ['w1', 'w2']); // earliest due first

  const unlimited = buildDailyQueue({
    words, reviewStates, settings: { dailyReviewLimit: null, dailyNewLimit: 0 }, todayISO: TODAY,
  });
  assert.equal(unlimited.length, 3, 'null review limit = unlimited');
});

test('buildDailyQueue: tagFilter restricts both reviews and new cards', () => {
  const words = sampleWords();
  const reviewStates = [
    // due reviews
    { id: 'w1', ease: 2.5, interval: 3, reps: 2, due: '2026-05-28', lastReviewed: '2026-05-25' }, // common only
    { id: 'w2', ease: 2.5, interval: 3, reps: 2, due: '2026-05-28', lastReviewed: '2026-05-25' }, // programming
    // new cards
    { id: 'w3', ease: 2.5, interval: 0, reps: 0, due: TODAY, lastReviewed: null }, // programming
    { id: 'w4', ease: 2.5, interval: 0, reps: 0, due: TODAY, lastReviewed: null }, // common only
  ];

  const queue = buildDailyQueue({
    words,
    reviewStates,
    settings: { dailyNewLimit: 15, dailyReviewLimit: null },
    todayISO: TODAY,
    tagFilter: 'programming',
  });

  const ids = queue.map((i) => i.wordId);
  // Only programming-tagged words survive: review w2 + new w3.
  assert.deepEqual(ids, ['w2', 'w3']);
  assert.ok(!ids.includes('w1'));
  assert.ok(!ids.includes('w4'));
});

test('buildDailyQueue: dailyNewLimit default (15) and 0 = no new cards', () => {
  const words = sampleWords();
  const reviewStates = words.map((w) => ({
    id: w.id, ease: 2.5, interval: 0, reps: 0, due: TODAY, lastReviewed: null,
  }));

  // No dailyNewLimit specified -> default 15 -> all 5 new cards included.
  const dflt = buildDailyQueue({ words, reviewStates, settings: {}, todayISO: TODAY });
  assert.equal(dflt.filter((i) => i.isNew).length, 5);

  // dailyNewLimit 0 -> introduce no new cards.
  const none = buildDailyQueue({
    words, reviewStates, settings: { dailyNewLimit: 0 }, todayISO: TODAY,
  });
  assert.equal(none.length, 0);
});

// --------------------------------------------------------------------------
// PROBLEM 1: introducedOn stamping + per-day new-card cap
// --------------------------------------------------------------------------

test('applyReview stamps introducedOn=today on first introduction and carries it through', () => {
  const q = gradeFromRating('good'); // 5

  // First introduction: input is a brand-new card -> introducedOn = today.
  const s0 = newState();
  const s1 = applyReview(s0, q, TODAY);
  assert.equal(s1.introducedOn, TODAY, 'first introduction stamps today');

  // A later review on a different day must NOT re-stamp; it carries through.
  const later = addDays(TODAY, 1);
  const s2 = applyReview(s1, q, later);
  assert.equal(s2.introducedOn, TODAY, 'introducedOn carried through unchanged');

  // And again on a third day.
  const s3 = applyReview(s2, gradeFromRating('again'), addDays(TODAY, 7));
  assert.equal(s3.introducedOn, TODAY, 'introducedOn survives a later lapse too');

  // Legacy record lacking introducedOn that is NOT new -> defaults to null.
  const legacy = { id: 'w9', ease: 2.5, interval: 5, reps: 2, due: TODAY, lastReviewed: '2026-05-20' };
  const s4 = applyReview(legacy, q, TODAY);
  assert.equal(s4.introducedOn, null, 'non-new legacy state defaults introducedOn to null');
});

test('applyReview output always includes an introducedOn field and stays immutable', () => {
  const s = newState();
  const snapshot = JSON.stringify(s);
  const out = applyReview(s, gradeFromRating('good'), TODAY);
  assert.ok('introducedOn' in out, 'returned state always carries introducedOn');
  assert.equal(JSON.stringify(s), snapshot, 'input untouched');
});

test('buildDailyQueue caps new by (dailyNewLimit - introducedToday); reviews still appear', () => {
  // 6 brand-new words available + 1 due review.
  const words = [
    { id: 'n1', word: 'apple', tags: ['common'] },
    { id: 'n2', word: 'apply', tags: ['common'] },
    { id: 'n3', word: 'apricot', tags: ['common'] },
    { id: 'n4', word: 'arc', tags: ['common'] },
    { id: 'n5', word: 'arch', tags: ['common'] },
    { id: 'n6', word: 'area', tags: ['common'] },
    { id: 'r1', word: 'review', tags: ['common'] },
  ];
  // 10 states already introduced today (these words need not be in scope; the
  // cap counts the whole-deck budget).
  const introducedStates = [];
  for (let i = 0; i < 10; i += 1) {
    introducedStates.push({
      id: `done${i}`, ease: 2.5, interval: 1, reps: 1,
      due: addDays(TODAY, 1), lastReviewed: TODAY, introducedOn: TODAY,
    });
  }
  const newStates = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'].map((id) => ({
    id, ease: 2.5, interval: 0, reps: 0, due: TODAY, lastReviewed: null, introducedOn: null,
  }));
  const reviewStates = [
    ...introducedStates,
    ...newStates,
    { id: 'r1', ease: 2.5, interval: 3, reps: 2, due: '2026-05-28', lastReviewed: '2026-05-25', introducedOn: '2026-05-25' },
  ];

  // limit 15, 10 introduced today -> allowance 5 new.
  const q1 = buildDailyQueue({
    words, reviewStates, settings: { dailyNewLimit: 15 }, todayISO: TODAY,
  });
  assert.equal(q1.filter((i) => i.isNew).length, 5, 'new capped to remaining allowance (5)');
  assert.ok(q1.some((i) => i.wordId === 'r1' && !i.isNew), 'due review still appears');

  // Saturate today: 15 introduced -> 0 new, reviews unaffected.
  const fullIntroduced = [];
  for (let i = 0; i < 15; i += 1) {
    fullIntroduced.push({
      id: `f${i}`, ease: 2.5, interval: 1, reps: 1,
      due: addDays(TODAY, 1), lastReviewed: TODAY, introducedOn: TODAY,
    });
  }
  const q2 = buildDailyQueue({
    words,
    reviewStates: [
      ...fullIntroduced,
      ...newStates,
      { id: 'r1', ease: 2.5, interval: 3, reps: 2, due: '2026-05-28', lastReviewed: '2026-05-25', introducedOn: '2026-05-25' },
    ],
    settings: { dailyNewLimit: 15 },
    todayISO: TODAY,
  });
  assert.equal(q2.filter((i) => i.isNew).length, 0, 'no new once daily limit reached');
  assert.ok(q2.some((i) => i.wordId === 'r1'), 'reviews still appear when new is exhausted');
});

test('buildDailyQueue: re-entering mid-session resumes (no restart, no overflow)', () => {
  const words = Array.from({ length: 8 }, (_, i) => ({
    id: `w${i}`, word: `word${i}`, tags: ['common'],
  }));
  // First entry: nothing introduced yet, limit 3.
  let reviewStates = words.map((w) => ({
    id: w.id, ease: 2.5, interval: 0, reps: 0, due: TODAY, lastReviewed: null, introducedOn: null,
  }));
  const first = buildDailyQueue({
    words, reviewStates, settings: { dailyNewLimit: 3 }, todayISO: TODAY,
  });
  const firstNew = first.filter((i) => i.isNew).map((i) => i.wordId);
  assert.equal(firstNew.length, 3, 'first entry introduces 3');

  // Simulate studying those 3 (stamp introducedOn=today via applyReview).
  reviewStates = reviewStates.map((s) =>
    firstNew.includes(s.id) ? applyReview(s, gradeFromRating('good'), TODAY) : s
  );

  // Re-enter the same day: allowance is 3 - 3 = 0 new (already done).
  const second = buildDailyQueue({
    words, reviewStates, settings: { dailyNewLimit: 3 }, todayISO: TODAY,
  });
  const secondNew = second.filter((i) => i.isNew).map((i) => i.wordId);
  assert.equal(secondNew.length, 0, 're-entry introduces no further new (resume, no restart)');
  // The 3 studied cards got due=tomorrow, so they leave today's queue.
  assert.equal(second.length, 0, 'session does not restart or overflow');
});

// --------------------------------------------------------------------------
// PROBLEM 2: new-card ordering (tierRank + day-stable hash, not alphabetical)
// --------------------------------------------------------------------------

test('tierRank maps tag buckets (basic<intermediate<advanced<programming)', () => {
  assert.equal(tierRank({ tags: ['common'] }), 0);
  assert.equal(tierRank({ tags: [] }), 0);
  assert.equal(tierRank({}), 0);
  assert.equal(tierRank({ tags: ['cet4'] }), 1);
  assert.equal(tierRank({ tags: ['cet6'] }), 2);
  assert.equal(tierRank({ tags: ['programming'] }), 3);
  // Assignment priority: programming > cet6 > cet4 > basic when several apply.
  assert.equal(tierRank({ tags: ['common', 'cet4', 'cet6', 'programming'] }), 3);
  assert.equal(tierRank({ tags: ['cet4', 'cet6'] }), 2);
  assert.equal(tierRank({ tags: ['common', 'cet4'] }), 1);
});

test('stableHash is deterministic, non-negative, and input-sensitive', () => {
  assert.equal(stableHash('abc'), stableHash('abc'), 'same input -> same hash');
  assert.ok(stableHash('abc') >= 0, 'non-negative');
  assert.ok(Number.isInteger(stableHash('abc')), 'integer');
  assert.notEqual(stableHash('w1|2026-05-29'), stableHash('w1|2026-05-30'), 'day-sensitive');
  assert.notEqual(stableHash('w1|2026-05-29'), stableHash('w2|2026-05-29'), 'id-sensitive');
});

test('buildDailyQueue: new cards ordered by tier then day-stable hash, NOT alphabetical', () => {
  // Mixed tiers; ids/words chosen so alphabetical order is obvious.
  const words = [
    { id: 'aaa', word: 'aaa', tags: ['programming'] }, // tier 3
    { id: 'bbb', word: 'bbb', tags: ['common'] },       // tier 0
    { id: 'ccc', word: 'ccc', tags: ['cet6'] },         // tier 2
    { id: 'ddd', word: 'ddd', tags: ['common'] },       // tier 0
    { id: 'eee', word: 'eee', tags: ['cet4'] },         // tier 1
    { id: 'fff', word: 'fff', tags: ['common'] },       // tier 0
  ];
  const reviewStates = words.map((w) => ({
    id: w.id, ease: 2.5, interval: 0, reps: 0, due: TODAY, lastReviewed: null, introducedOn: null,
  }));

  const queue = buildDailyQueue({
    words, reviewStates, settings: { dailyNewLimit: 15 }, todayISO: TODAY,
  });
  const order = queue.map((i) => i.wordId);

  // All tier-0 (common) words must come before higher tiers.
  const tierOf = (id) => tierRank(words.find((w) => w.id === id));
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(tierOf(order[i - 1]) <= tierOf(order[i]), 'tiers ascending');
  }
  // programming ('aaa', tier 3) must be LAST despite being alphabetically first.
  assert.equal(order[order.length - 1], 'aaa', 'programming sinks to the bottom');
  // common-tier words precede cet6 ('ccc') and programming ('aaa').
  const idxCcc = order.indexOf('ccc');
  const idxAaa = order.indexOf('aaa');
  assert.ok(order.indexOf('bbb') < idxCcc && order.indexOf('bbb') < idxAaa, 'basic before advanced/programming');

  // Order is NOT the input/alphabetical order.
  const alphabetical = words.map((w) => w.id).slice().sort();
  assert.notDeepEqual(order, alphabetical, 'not alphabetical');

  // Determinism: same todayISO -> identical order.
  const again = buildDailyQueue({
    words, reviewStates, settings: { dailyNewLimit: 15 }, todayISO: TODAY,
  }).map((i) => i.wordId);
  assert.deepEqual(order, again, 'deterministic for a fixed day');

  // Changing the day changes the (within-tier) order.
  const otherDay = buildDailyQueue({
    words, reviewStates, settings: { dailyNewLimit: 15 }, todayISO: '2026-07-15',
  }).map((i) => i.wordId);
  assert.notDeepEqual(order, otherDay, 'order varies across days');
});

// --------------------------------------------------------------------------
// Frequency-based new-card ordering (real COCA rank: most-frequent-first)
// --------------------------------------------------------------------------

test('freqRank returns positive COCA rank, Infinity when missing/0', () => {
  assert.equal(freqRank({ freq: 1 }), 1);
  assert.equal(freqRank({ freq: 4050 }), 4050);
  assert.equal(freqRank({ freq: 0 }), Infinity, 'freq 0 = unranked -> Infinity');
  assert.equal(freqRank({}), Infinity, 'missing freq -> Infinity');
  assert.equal(freqRank({ freq: -5 }), Infinity, 'non-positive -> Infinity');
  assert.equal(freqRank(null), Infinity);
});

test('buildDailyQueue: new cards ordered by freq ascending (most-frequent-first)', () => {
  // Frequencies intentionally NOT matching alphabetical or input order.
  const words = [
    { id: 'wa', word: 'zeta', tags: ['common'], freq: 500 },
    { id: 'wb', word: 'alpha', tags: ['common'], freq: 10 },
    { id: 'wc', word: 'mid', tags: ['common'], freq: 200 },
    { id: 'wd', word: 'beta', tags: ['common'], freq: 1 },
    { id: 'we', word: 'gamma', tags: ['common'], freq: 50 },
  ];
  const reviewStates = words.map((w) => ({
    id: w.id, ease: 2.5, interval: 0, reps: 0, due: TODAY, lastReviewed: null, introducedOn: null,
  }));

  const order = buildDailyQueue({
    words, reviewStates, settings: { dailyNewLimit: 15 }, todayISO: TODAY,
  }).map((i) => i.wordId);

  // Most frequent (smallest freq) first: 1, 10, 50, 200, 500.
  assert.deepEqual(order, ['wd', 'wb', 'we', 'wc', 'wa'], 'ordered by freq ascending');
});

test('buildDailyQueue: freq beats tag tier (a high-freq cet6 word precedes a low-freq common word)', () => {
  const words = [
    // common (tier 0) but RARE.
    { id: 'rare', word: 'rare', tags: ['common'], freq: 7000 },
    // cet6 (tier 2) but VERY COMMON -> must come first under freq ordering.
    { id: 'freqadv', word: 'freqadv', tags: ['cet6'], freq: 5 },
  ];
  const reviewStates = words.map((w) => ({
    id: w.id, ease: 2.5, interval: 0, reps: 0, due: TODAY, lastReviewed: null, introducedOn: null,
  }));

  const order = buildDailyQueue({
    words, reviewStates, settings: { dailyNewLimit: 15 }, todayISO: TODAY,
  }).map((i) => i.wordId);

  assert.deepEqual(order, ['freqadv', 'rare'], 'real frequency overrides coarse tag tier');
});

test('buildDailyQueue: unranked (freq 0) words sort AFTER frequency-ranked, tierRank breaks unranked ties', () => {
  const words = [
    { id: 'r1', word: 'common1', tags: ['common'], freq: 100 },
    { id: 'r2', word: 'common2', tags: ['common'], freq: 300 },
    // Unranked (freq 0): a programming term not in COCA and a plain common word.
    { id: 'u_prog', word: 'async', tags: ['programming'], freq: 0 }, // tier 3
    { id: 'u_common', word: 'widget', tags: ['common'], freq: 0 },   // tier 0
  ];
  const reviewStates = words.map((w) => ({
    id: w.id, ease: 2.5, interval: 0, reps: 0, due: TODAY, lastReviewed: null, introducedOn: null,
  }));

  const order = buildDailyQueue({
    words, reviewStates, settings: { dailyNewLimit: 15 }, todayISO: TODAY,
  }).map((i) => i.wordId);

  // Ranked words first, in freq order.
  assert.equal(order[0], 'r1');
  assert.equal(order[1], 'r2');
  // Both unranked come last; among them, lower tierRank (common) precedes programming.
  assert.ok(order.indexOf('u_common') < order.indexOf('u_prog'), 'unranked common before unranked programming');
  assert.equal(order[order.length - 1], 'u_prog', 'unranked programming sinks last');
});

test('buildDailyQueue: equal-freq new cards are day-stable shuffled (deterministic per day, varies across days, not alphabetical)', () => {
  // All identical freq -> ordering driven purely by the day-stable hash.
  const words = [
    { id: 'k_a', word: 'aaa', tags: ['common'], freq: 100 },
    { id: 'k_b', word: 'bbb', tags: ['common'], freq: 100 },
    { id: 'k_c', word: 'ccc', tags: ['common'], freq: 100 },
    { id: 'k_d', word: 'ddd', tags: ['common'], freq: 100 },
    { id: 'k_e', word: 'eee', tags: ['common'], freq: 100 },
  ];
  const reviewStates = words.map((w) => ({
    id: w.id, ease: 2.5, interval: 0, reps: 0, due: TODAY, lastReviewed: null, introducedOn: null,
  }));

  const order = buildDailyQueue({
    words, reviewStates, settings: { dailyNewLimit: 15 }, todayISO: TODAY,
  }).map((i) => i.wordId);

  assert.equal(order.length, 5);
  const alphabetical = words.map((w) => w.id).slice().sort();
  assert.notDeepEqual(order, alphabetical, 'equal-freq -> hash-shuffle, not alphabetical');

  // Deterministic per day.
  const same = buildDailyQueue({
    words, reviewStates, settings: { dailyNewLimit: 15 }, todayISO: TODAY,
  }).map((i) => i.wordId);
  assert.deepEqual(order, same, 'deterministic for a fixed day');

  // Varies across days.
  const otherDay = buildDailyQueue({
    words, reviewStates, settings: { dailyNewLimit: 15 }, todayISO: '2026-09-01',
  }).map((i) => i.wordId);
  assert.notDeepEqual(order, otherDay, 'day-stable shuffle varies across days');
});

test('buildDailyQueue: within a tagFilter set, tier ties so hash-shuffle (not alphabetical) orders', () => {
  // All programming -> identical tier; ordering driven purely by day-stable hash.
  const words = [
    { id: 'p_a', word: 'array', tags: ['programming'] },
    { id: 'p_b', word: 'buffer', tags: ['programming'] },
    { id: 'p_c', word: 'cache', tags: ['programming'] },
    { id: 'p_d', word: 'daemon', tags: ['programming'] },
    { id: 'p_e', word: 'enum', tags: ['programming'] },
  ];
  const reviewStates = words.map((w) => ({
    id: w.id, ease: 2.5, interval: 0, reps: 0, due: TODAY, lastReviewed: null, introducedOn: null,
  }));

  const order = buildDailyQueue({
    words, reviewStates, settings: { dailyNewLimit: 15 }, todayISO: TODAY, tagFilter: 'programming',
  }).map((i) => i.wordId);

  assert.equal(order.length, 5, 'all programming words included');
  const alphabetical = words.map((w) => w.id).slice().sort();
  assert.notDeepEqual(order, alphabetical, 'hash-shuffle, not alphabetical');

  // Deterministic per-day, varies across days.
  const same = buildDailyQueue({
    words, reviewStates, settings: { dailyNewLimit: 15 }, todayISO: TODAY, tagFilter: 'programming',
  }).map((i) => i.wordId);
  assert.deepEqual(order, same, 'deterministic per day');
});
