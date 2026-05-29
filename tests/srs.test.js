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
  buildExtraQueue,
  addDays,
  isoDate,
  tierRank,
  freqRank,
  stableHash,
  MIN_EASE,
  INITIAL_EASE,
  difficultyOf,
  DIFFICULTY_THRESHOLDS,
  DIFFICULTY_LABELS,
  DEFAULT_DIFFICULTY_MIX,
  normalizeDifficultyMix,
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
// applyReview: lapses (错题本 / mistake-notebook membership)
// --------------------------------------------------------------------------

test('applyReview increments lapses on 不认识 and carries it through on 模糊/认识', () => {
  // Brand-new card has no lapses field; a failure stamps lapses = 1.
  const s0 = newState();
  const lapsed = applyReview(s0, gradeFromRating('again'), TODAY);
  assert.equal(lapsed.lapses, 1, '不认识 increments lapses (0 -> 1)');

  // 模糊 (hard, q=3) is a pass -> lapses carried unchanged.
  const hard = applyReview(lapsed, gradeFromRating('hard'), addDays(TODAY, 1));
  assert.equal(hard.lapses, 1, '模糊 carries lapses through unchanged');

  // 认识 (good, q=5) is a pass -> lapses carried unchanged.
  const good = applyReview(hard, gradeFromRating('good'), addDays(TODAY, 2));
  assert.equal(good.lapses, 1, '认识 carries lapses through unchanged');
});

test('applyReview accumulates lapses across multiple failures', () => {
  let s = newState();
  for (let i = 1; i <= 3; i += 1) {
    s = applyReview(s, gradeFromRating('again'), addDays(TODAY, i));
    assert.equal(s.lapses, i, `lapse #${i} accumulates`);
  }
  // A pass in between does not reset the accumulated count.
  s = applyReview(s, gradeFromRating('good'), addDays(TODAY, 4));
  assert.equal(s.lapses, 3, 'a pass keeps the accumulated lapse count');
  s = applyReview(s, gradeFromRating('again'), addDays(TODAY, 5));
  assert.equal(s.lapses, 4, 'a later failure resumes accumulating');
});

test('applyReview output always includes a numeric lapses field; legacy records default 0', () => {
  // Legacy record lacking lapses -> a pass yields lapses 0.
  const legacy = { id: 'w9', ease: 2.5, interval: 5, reps: 2, due: TODAY, lastReviewed: '2026-05-20' };
  const passed = applyReview(legacy, gradeFromRating('good'), TODAY);
  assert.equal(passed.lapses, 0, 'legacy + pass -> lapses 0');
  // Legacy record lacking lapses -> a failure yields lapses 1.
  const failed = applyReview(legacy, gradeFromRating('again'), TODAY);
  assert.equal(failed.lapses, 1, 'legacy + failure -> lapses 1');
  assert.equal(typeof passed.lapses, 'number', 'lapses is always numeric');
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

// --------------------------------------------------------------------------
// Difficulty model: difficultyOf + thresholds + labels + mix normalization
// --------------------------------------------------------------------------

test('difficultyOf: thresholds (easy<=2000, medium<=5000, hard beyond/unranked)', () => {
  assert.equal(DIFFICULTY_THRESHOLDS.easyMax, 2000);
  assert.equal(DIFFICULTY_THRESHOLDS.mediumMax, 5000);

  // easy: 1 .. 2000 inclusive.
  assert.equal(difficultyOf({ freq: 1 }), 'easy', 'rank 1 = easy');
  assert.equal(difficultyOf({ freq: 1500 }), 'easy');
  assert.equal(difficultyOf({ freq: 2000 }), 'easy', 'easyMax boundary inclusive');

  // medium: 2001 .. 5000 inclusive.
  assert.equal(difficultyOf({ freq: 2001 }), 'medium', 'just past easyMax = medium');
  assert.equal(difficultyOf({ freq: 3500 }), 'medium');
  assert.equal(difficultyOf({ freq: 5000 }), 'medium', 'mediumMax boundary inclusive');

  // hard: beyond 5000.
  assert.equal(difficultyOf({ freq: 5001 }), 'hard', 'just past mediumMax = hard');
  assert.equal(difficultyOf({ freq: 9000 }), 'hard');

  // hard: missing / 0 / non-positive freq -> unranked / rare / specialized.
  assert.equal(difficultyOf({ freq: 0 }), 'hard', 'freq 0 = hard (unranked)');
  assert.equal(difficultyOf({}), 'hard', 'missing freq = hard');
  assert.equal(difficultyOf({ freq: -3 }), 'hard', 'negative freq = hard');
  assert.equal(difficultyOf(null), 'hard', 'null word = hard');
});

test('DIFFICULTY_LABELS maps tiers to localized labels', () => {
  assert.equal(DIFFICULTY_LABELS.easy, '简单');
  assert.equal(DIFFICULTY_LABELS.medium, '中等');
  assert.equal(DIFFICULTY_LABELS.hard, '困难');
});

test('normalizeDifficultyMix: default fallback + normalization to sum 100', () => {
  // Default mix is 20/50/30 and sums to 100.
  assert.deepEqual(DEFAULT_DIFFICULTY_MIX, { easy: 20, medium: 50, hard: 30 });
  const dflt = normalizeDifficultyMix(undefined);
  assert.deepEqual(dflt, { easy: 20, medium: 50, hard: 30 }, 'absent -> default');
  assert.deepEqual(normalizeDifficultyMix({}), { easy: 20, medium: 50, hard: 30 }, 'empty -> default');
  assert.deepEqual(
    normalizeDifficultyMix({ easy: 'x', medium: 50, hard: 30 }),
    { easy: 20, medium: 50, hard: 30 },
    'invalid tier -> default'
  );
  assert.deepEqual(
    normalizeDifficultyMix({ easy: 0, medium: 0, hard: 0 }),
    { easy: 20, medium: 50, hard: 30 },
    'all-zero -> default'
  );

  // Already-valid mix passes through.
  assert.deepEqual(normalizeDifficultyMix({ easy: 30, medium: 40, hard: 30 }), { easy: 30, medium: 40, hard: 30 });

  // Non-100 sums are scaled to 100.
  const scaled = normalizeDifficultyMix({ easy: 10, medium: 25, hard: 15 }); // sum 50 -> *2
  assert.equal(scaled.easy + scaled.medium + scaled.hard, 100, 'scaled sum = 100');
  assert.deepEqual(scaled, { easy: 20, medium: 50, hard: 30 });

  // Rounding drift is absorbed so the three values always sum to exactly 100.
  const odd = normalizeDifficultyMix({ easy: 1, medium: 1, hard: 1 }); // 33.33 each
  assert.equal(odd.easy + odd.medium + odd.hard, 100, 'drift absorbed -> sum 100');
});

// --------------------------------------------------------------------------
// buildDailyQueue: NEW-card composition by difficulty mix (+ backfill)
// --------------------------------------------------------------------------

// Helper: count picked new cards per difficulty tier from a built queue.
function newCountsByTier(queue, words) {
  const byId = new Map(words.map((w) => [w.id, w]));
  const counts = { easy: 0, medium: 0, hard: 0 };
  for (const item of queue) {
    if (!item.isNew) continue;
    counts[difficultyOf(byId.get(item.wordId))] += 1;
  }
  return counts;
}

// Build `n` brand-new word + state pairs of a given difficulty (via freq).
function tierPool(prefix, freq, n) {
  const words = [];
  const states = [];
  for (let i = 0; i < n; i += 1) {
    const id = `${prefix}${i}`;
    // Distinct freq within the tier band so ordering is deterministic.
    words.push({ id, word: id, tags: ['common'], freq: freq + i });
    states.push({ id, ease: 2.5, interval: 0, reps: 0, due: TODAY, lastReviewed: null, introducedOn: null });
  }
  return { words, states };
}

test('buildDailyQueue mix: N=10 with 30/40/30 picks ~3/4/3 by difficulty', () => {
  // Plenty of unseen candidates per tier (10 each) so the mix is fully honored.
  const easy = tierPool('e', 100, 10);   // freq 100.. -> easy
  const med = tierPool('m', 3000, 10);   // freq 3000.. -> medium
  const hard = tierPool('h', 6000, 10);  // freq 6000.. -> hard
  const words = [...easy.words, ...med.words, ...hard.words];
  const reviewStates = [...easy.states, ...med.states, ...hard.states];

  const queue = buildDailyQueue({
    words,
    reviewStates,
    settings: { dailyNewLimit: 10, difficultyMix: { easy: 30, medium: 40, hard: 30 } },
    todayISO: TODAY,
  });

  const counts = newCountsByTier(queue, words);
  // round(10*0.3)=3 easy, round(10*0.4)=4 medium, hard = 10-3-4 = 3.
  assert.deepEqual(counts, { easy: 3, medium: 4, hard: 3 }, 'picks 3/4/3 by difficulty');
  // Total new equals N.
  assert.equal(queue.filter((i) => i.isNew).length, 10, 'total new = N');
  // New list ordered by freq ascending (smooth session).
  const newFreqs = queue
    .filter((i) => i.isNew)
    .map((i) => words.find((w) => w.id === i.wordId).freq);
  const sorted = newFreqs.slice().sort((a, b) => a - b);
  assert.deepEqual(newFreqs, sorted, 'new cards ordered by freq ascending');
});

test('buildDailyQueue mix: default 20/50/30 with N=15 yields 3/8/4 by difficulty', () => {
  const easy = tierPool('e', 100, 20);
  const med = tierPool('m', 3000, 20);
  const hard = tierPool('h', 6000, 20);
  const words = [...easy.words, ...med.words, ...hard.words];
  const reviewStates = [...easy.states, ...med.states, ...hard.states];

  // No difficultyMix in settings -> default 20/50/30.
  const queue = buildDailyQueue({
    words, reviewStates, settings: { dailyNewLimit: 15 }, todayISO: TODAY,
  });
  const counts = newCountsByTier(queue, words);
  // round(15*0.2)=3 easy, round(15*0.5)=8 medium ("7-8"), hard = 15-3-8 = 4.
  assert.deepEqual(counts, { easy: 3, medium: 8, hard: 4 }, 'default mix -> 3/8/4');
  assert.equal(queue.filter((i) => i.isNew).length, 15);
});

test('buildDailyQueue backfill: a short tier is topped up from other tiers to reach N', () => {
  // Only 1 medium candidate, but plenty of easy + hard. N=10, mix 30/40/30.
  const easy = tierPool('e', 100, 10);
  const med = tierPool('m', 3000, 1);   // medium pool nearly empty
  const hard = tierPool('h', 6000, 10);
  const words = [...easy.words, ...med.words, ...hard.words];
  const reviewStates = [...easy.states, ...med.states, ...hard.states];

  const queue = buildDailyQueue({
    words,
    reviewStates,
    settings: { dailyNewLimit: 10, difficultyMix: { easy: 30, medium: 40, hard: 30 } },
    todayISO: TODAY,
  });

  const counts = newCountsByTier(queue, words);
  // Medium target was 4 but only 1 medium exists -> the 3-shortfall backfills
  // from easy/hard so the total still reaches N=10.
  assert.equal(counts.medium, 1, 'medium exhausted at its single candidate');
  assert.equal(counts.easy + counts.medium + counts.hard, 10, 'backfill reaches N total');
  assert.equal(queue.filter((i) => i.isNew).length, 10, 'daily quota not wasted');
});

test('buildDailyQueue backfill: limited total candidates -> picks all (capped by overallAllowance)', () => {
  // Fewer total candidates than N -> picks them all, no overflow.
  const easy = tierPool('e', 100, 2);
  const med = tierPool('m', 3000, 1);
  const hard = tierPool('h', 6000, 1);
  const words = [...easy.words, ...med.words, ...hard.words];
  const reviewStates = [...easy.states, ...med.states, ...hard.states];

  const queue = buildDailyQueue({
    words,
    reviewStates,
    settings: { dailyNewLimit: 10, difficultyMix: { easy: 30, medium: 40, hard: 30 } },
    todayISO: TODAY,
  });
  assert.equal(queue.filter((i) => i.isNew).length, 4, 'all 4 available picked, no overflow');
});

test('buildDailyQueue mix: per-tier introducedToday reduces that tier remaining (resume)', () => {
  // N=10, mix 30/40/30 -> targets 3 easy / 4 medium / 3 hard.
  // Pre-introduce 2 easy + 1 medium TODAY (in scope, so grouped per tier).
  const easy = tierPool('e', 100, 10);
  const med = tierPool('m', 3000, 10);
  const hard = tierPool('h', 6000, 10);
  const words = [...easy.words, ...med.words, ...hard.words];

  // Mark e0,e1 (easy) and m0 (medium) as introduced today (no longer "new").
  const introducedIds = new Set(['e0', 'e1', 'm0']);
  const reviewStates = [...easy.states, ...med.states, ...hard.states].map((s) =>
    introducedIds.has(s.id)
      ? { ...s, reps: 1, interval: 1, due: addDays(TODAY, 1), lastReviewed: TODAY, introducedOn: TODAY }
      : s
  );

  const queue = buildDailyQueue({
    words,
    reviewStates,
    settings: { dailyNewLimit: 10, difficultyMix: { easy: 30, medium: 40, hard: 30 } },
    todayISO: TODAY,
  });

  const counts = newCountsByTier(queue, words);
  // easy: target 3 - 2 introduced = 1 remaining.
  assert.equal(counts.easy, 1, 'easy remaining reduced by introducedToday');
  // medium: target 4 - 1 introduced = 3 remaining.
  assert.equal(counts.medium, 3, 'medium remaining reduced by introducedToday');
  // hard: target 3 - 0 = 3 remaining.
  assert.equal(counts.hard, 3, 'hard remaining unchanged');
  // overallAllowance = N - introducedToday(3) = 7 -> total new = 1+3+3 = 7.
  assert.equal(queue.filter((i) => i.isNew).length, 7, 'overall allowance honored on resume');
});

test('buildDailyQueue mix: reviews still included alongside the mixed new cards', () => {
  const easy = tierPool('e', 100, 5);
  const med = tierPool('m', 3000, 5);
  const hard = tierPool('h', 6000, 5);
  const words = [
    ...easy.words, ...med.words, ...hard.words,
    { id: 'rev1', word: 'rev1', tags: ['common'], freq: 50 },
  ];
  const reviewStates = [
    ...easy.states, ...med.states, ...hard.states,
    // A due review (introduced earlier).
    { id: 'rev1', ease: 2.5, interval: 3, reps: 2, due: '2026-05-28', lastReviewed: '2026-05-25', introducedOn: '2026-05-25' },
  ];

  const queue = buildDailyQueue({
    words,
    reviewStates,
    settings: { dailyNewLimit: 6, difficultyMix: { easy: 30, medium: 40, hard: 30 } },
    todayISO: TODAY,
  });

  // Review first.
  assert.deepEqual(queue[0], { wordId: 'rev1', isNew: false }, 'due review leads the queue');
  // round(6*.3)=2 easy / round(6*.4)=2 medium / 6-2-2=2 hard.
  const counts = newCountsByTier(queue, words);
  assert.deepEqual(counts, { easy: 2, medium: 2, hard: 2 }, 'mix applied to new cards');
  assert.equal(queue.filter((i) => i.isNew).length, 6);
});

// --------------------------------------------------------------------------
// buildExtraQueue: unlimited "继续学习" beyond the daily cap
// --------------------------------------------------------------------------

test('buildExtraQueue: ignores the daily introducedToday cap (returns new words even when day saturated)', () => {
  // 30 unseen new words available + a deck already saturated for the day.
  const pool = tierPool('x', 100, 30);
  // 20 states stamped introducedOn=today (deck saturated under the daily cap).
  const introducedStates = [];
  for (let i = 0; i < 20; i += 1) {
    introducedStates.push({
      id: `done${i}`, ease: 2.5, interval: 1, reps: 1,
      due: addDays(TODAY, 1), lastReviewed: TODAY, introducedOn: TODAY,
    });
  }
  const reviewStates = [...introducedStates, ...pool.states];

  // The daily queue would introduce 0 new (cap fully consumed).
  const daily = buildDailyQueue({
    words: pool.words, reviewStates, settings: { dailyNewLimit: 15 }, todayISO: TODAY,
  });
  assert.equal(daily.filter((i) => i.isNew).length, 0, 'daily cap consumed -> 0 new');

  // The extra queue ignores that cap and still serves a fresh batch.
  const extra = buildExtraQueue({
    words: pool.words, reviewStates, settings: {}, todayISO: TODAY, limit: 20,
  });
  assert.equal(extra.length, 20, 'extra ignores daily cap and serves the full limit');
  assert.ok(extra.every((i) => i.isNew === true), 'every extra item is flagged new');
});

test('buildExtraQueue: respects the limit (default 20, custom honored, capped at availability)', () => {
  const pool = tierPool('x', 100, 50);
  const reviewStates = pool.states;

  // Default limit is 20.
  const dflt = buildExtraQueue({ words: pool.words, reviewStates, todayISO: TODAY });
  assert.equal(dflt.length, 20, 'default limit = 20');

  // Custom limit honored.
  const five = buildExtraQueue({ words: pool.words, reviewStates, todayISO: TODAY, limit: 5 });
  assert.equal(five.length, 5, 'custom limit honored');

  // Limit capped at the number of available unseen words.
  const small = tierPool('y', 100, 3);
  const capped = buildExtraQueue({
    words: small.words, reviewStates: small.states, todayISO: TODAY, limit: 20,
  });
  assert.equal(capped.length, 3, 'capped at availability when fewer unseen than limit');

  // A zero / invalid limit yields an empty batch.
  assert.deepEqual(
    buildExtraQueue({ words: pool.words, reviewStates, todayISO: TODAY, limit: 0 }),
    [],
    'limit 0 -> empty'
  );
});

test('buildExtraQueue: only returns UNSEEN words (skips introduced / reviewed cards)', () => {
  const words = [
    { id: 'fresh1', word: 'fresh1', tags: ['common'], freq: 100 },
    { id: 'fresh2', word: 'fresh2', tags: ['common'], freq: 200 },
    // Already introduced today (not new).
    { id: 'seen1', word: 'seen1', tags: ['common'], freq: 50 },
    // A mature review card (not new).
    { id: 'mature', word: 'mature', tags: ['common'], freq: 10 },
  ];
  const reviewStates = [
    { id: 'fresh1', ease: 2.5, interval: 0, reps: 0, due: TODAY, lastReviewed: null, introducedOn: null },
    { id: 'fresh2', ease: 2.5, interval: 0, reps: 0, due: TODAY, lastReviewed: null, introducedOn: null },
    { id: 'seen1', ease: 2.5, interval: 1, reps: 1, due: addDays(TODAY, 1), lastReviewed: TODAY, introducedOn: TODAY },
    { id: 'mature', ease: 2.6, interval: 30, reps: 5, due: addDays(TODAY, 30), lastReviewed: '2026-05-01', introducedOn: '2026-04-01' },
  ];

  const extra = buildExtraQueue({ words, reviewStates, todayISO: TODAY, limit: 20 });
  const ids = extra.map((i) => i.wordId);
  assert.deepEqual(ids.sort(), ['fresh1', 'fresh2'], 'only unseen words returned');
  assert.ok(!ids.includes('seen1'), 'introduced-today card excluded');
  assert.ok(!ids.includes('mature'), 'mature review card excluded');
});

test('buildExtraQueue: composes a batch by the difficulty mix (with backfill)', () => {
  // Plenty per tier so the mix is fully honored at limit=10.
  const easy = tierPool('e', 100, 10);   // easy
  const med = tierPool('m', 3000, 10);   // medium
  const hard = tierPool('h', 6000, 10);  // hard
  const words = [...easy.words, ...med.words, ...hard.words];
  const reviewStates = [...easy.states, ...med.states, ...hard.states];

  const extra = buildExtraQueue({
    words,
    reviewStates,
    settings: { difficultyMix: { easy: 30, medium: 40, hard: 30 } },
    todayISO: TODAY,
    limit: 10,
  });
  const counts = newCountsByTier(extra, words);
  // round(10*0.3)=3 easy, round(10*0.4)=4 medium, hard = 10-3-4 = 3.
  assert.deepEqual(counts, { easy: 3, medium: 4, hard: 3 }, 'mix applied to extra batch');
  assert.equal(extra.length, 10, 'extra batch reaches the limit');

  // Backfill: medium pool short -> shortfall topped up from other tiers.
  const easy2 = tierPool('e2', 100, 10);
  const med2 = tierPool('m2', 3000, 1); // medium nearly empty
  const hard2 = tierPool('h2', 6000, 10);
  const words2 = [...easy2.words, ...med2.words, ...hard2.words];
  const states2 = [...easy2.states, ...med2.states, ...hard2.states];
  const extra2 = buildExtraQueue({
    words: words2,
    reviewStates: states2,
    settings: { difficultyMix: { easy: 30, medium: 40, hard: 30 } },
    todayISO: TODAY,
    limit: 10,
  });
  const counts2 = newCountsByTier(extra2, words2);
  assert.equal(counts2.medium, 1, 'medium exhausted at its single candidate');
  assert.equal(extra2.length, 10, 'backfill reaches the full limit');
});

test('buildExtraQueue: tagFilter restricts to matching unseen words, ordered freq-asc', () => {
  const words = [
    { id: 'p1', word: 'p1', tags: ['programming'], freq: 300 },
    { id: 'p2', word: 'p2', tags: ['programming'], freq: 100 },
    { id: 'c1', word: 'c1', tags: ['common'], freq: 5 },
  ];
  const reviewStates = words.map((w) => ({
    id: w.id, ease: 2.5, interval: 0, reps: 0, due: TODAY, lastReviewed: null, introducedOn: null,
  }));

  const extra = buildExtraQueue({
    words, reviewStates, todayISO: TODAY, tagFilter: 'programming', limit: 20,
  });
  const ids = extra.map((i) => i.wordId);
  // Only programming words, freq-asc (p2 freq 100 before p1 freq 300); c1 excluded.
  assert.deepEqual(ids, ['p2', 'p1'], 'tagFilter restricts + freq-asc order');
});
