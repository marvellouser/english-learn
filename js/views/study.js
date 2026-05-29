// views/study.js
// Study session view. Orchestrates db (data) + srs (pure scheduling) + tts
// (pronunciation) + plain DOM. Mountable via app.js mount(viewFn): the default
// export is a factory that returns a render(root) function bound to its options.
//
// Flow (Anki-style):
//   build queue -> show card FRONT (word + phonetic + pronounce)
//   -> flip to BACK (def_zh, def_en, examples, root_affix)
//   -> 3-tier rating (不认识 / 模糊 / 认识)
//   -> grade -> applyReview -> persist -> advance
//   -> on exhaustion: session summary.
//
// srs.js stays pure; all IndexedDB + DOM lives here.

import {
  today,
  getAllWords,
  getWordsByTag,
  getAllReviewState,
  getReviewState,
  putReviewState,
  getSetting,
} from '../db.js';
import {
  buildDailyQueue,
  gradeFromRating,
  applyReview,
  freqRank,
  INITIAL_EASE,
} from '../srs.js';
import { navigate } from '../app.js';
import * as tts from '../tts.js';

// Rating tiers: stable key -> localized label + css modifier. Order matters
// (left=hardest .. right=easiest) and maps to keyboard 1/2/3.
const RATINGS = [
  { key: 'again', label: '不认识', cls: 'rating-again' },
  { key: 'hard', label: '模糊', cls: 'rating-hard' },
  { key: 'good', label: '认识', cls: 'rating-good' },
];

/**
 * Synthesize the default review state for a word that has no stored state yet.
 * Mirrors db.js initialReviewState(): a brand-new card due today.
 * @param {string} id
 * @returns {{id:string, ease:number, interval:number, reps:number, due:string, lastReviewed:null}}
 */
function synthInitialState(id) {
  return {
    id,
    ease: INITIAL_EASE,
    interval: 0,
    reps: 0,
    due: today(),
    lastReviewed: null,
  };
}

/**
 * Escape a string for safe insertion into HTML text/attribute context.
 * @param {*} value
 * @returns {string}
 */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the on-demand "复习错题" (mistake review) session queue. PURE: takes the
 * already-loaded words + review states and returns an ordered queue of every
 * lapsed word (reviewState.lapses > 0), REGARDLESS of due date, since this is a
 * deliberate on-demand review rather than the daily schedule. Ordered by lapse
 * count descending (most-missed first), then by COCA frequency ascending
 * (common words first), then id for determinism. The daily new-card cap does
 * not apply here.
 *
 * @param {Array<object>} words - all word records
 * @param {Array<object>} reviewStates - all review-state records
 * @returns {Array<{wordId:string, isNew:boolean}>} ordered queue
 */
function buildMistakeQueue(words, reviewStates) {
  const wordById = new Map();
  for (const w of words) {
    if (w && typeof w.id === 'string') wordById.set(w.id, w);
  }

  const lapsed = [];
  for (const s of reviewStates) {
    if (!s || typeof s.id !== 'string') continue;
    const lapses = typeof s.lapses === 'number' ? s.lapses : 0;
    if (lapses > 0 && wordById.has(s.id)) lapsed.push(s);
  }

  lapsed.sort((a, b) => {
    const la = typeof a.lapses === 'number' ? a.lapses : 0;
    const lb = typeof b.lapses === 'number' ? b.lapses : 0;
    if (la !== lb) return lb - la; // more lapses first
    const fa = freqRank(wordById.get(a.id));
    const fb = freqRank(wordById.get(b.id));
    if (fa !== fb) return fa - fb; // more frequent first
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Mistakes are reviews of already-introduced words, never "new" cards.
  return lapsed.map((s) => ({ wordId: s.id, isNew: false }));
}

/**
 * Render the study view into the given root element.
 *
 * @param {HTMLElement} root - the #app mount element (cleared by mount())
 * @param {{ tagFilter?: (string|null), source?: (string|null) }} [opts]
 *   source === 'mistakes' switches to the on-demand 错题本 review mode (queue
 *   built from lapsed words, ignoring due date and the daily new cap). Any other
 *   value behaves as the normal daily queue (optionally restricted by tagFilter).
 */
export async function renderStudy(root, { tagFilter = null, source = null } = {}) {
  if (!root) return;

  const isMistakeMode = source === 'mistakes';
  const headerTitle = isMistakeMode ? '复习错题' : '学习';

  // Loading placeholder while we read IndexedDB.
  root.innerHTML = `
    <header class="app-header"><h1 class="app-title">${headerTitle}</h1></header>
    <section class="card"><p class="muted">正在准备卡片…</p></section>
  `;

  // ---- Load data ---------------------------------------------------------
  let words;
  let reviewStates;
  let dailyNewLimit;
  let dailyReviewLimit;
  let ttsEnabled;
  try {
    // Mistake mode reviews lapsed words across the whole deck, so it never
    // restricts by tag; the daily queue may restrict by tag via getWordsByTag.
    [words, reviewStates] = await Promise.all([
      !isMistakeMode && tagFilter ? getWordsByTag(tagFilter) : getAllWords(),
      getAllReviewState(),
    ]);
    dailyNewLimit = await getSetting('dailyNewLimit', undefined);
    dailyReviewLimit = await getSetting('dailyReviewLimit', undefined);
    // Pronunciation is OFF by default (phonetic-only): only show the speak
    // button when the user has explicitly opted in AND the engine is available.
    ttsEnabled = (await getSetting('ttsEnabled', false)) === true;
  } catch (err) {
    console.error('[study] failed to load study data:', err);
    renderError(root, '加载学习数据失败，请稍后重试。');
    return;
  }

  const todayISO = today();

  // Build the session queue. Mistake mode pulls every lapsed word (ignoring due
  // date + the daily new cap); the normal mode builds the bounded daily queue.
  // When restricting by tag, getWordsByTag returns only matching words, but
  // buildDailyQueue filters reviewStates by the word set it is given. Pass the
  // same tagFilter so its internal scoping is consistent even if extra states
  // exist for out-of-scope words.
  const queue = isMistakeMode
    ? buildMistakeQueue(words, reviewStates)
    : buildDailyQueue({
        words,
        reviewStates,
        settings: { dailyNewLimit, dailyReviewLimit },
        todayISO,
        tagFilter,
      });

  // Index words by id for O(1) lookup during the session.
  const wordById = new Map();
  for (const w of words) {
    if (w && typeof w.id === 'string') wordById.set(w.id, w);
  }

  // Index any already-loaded review states for quick base lookup.
  const stateById = new Map();
  for (const s of reviewStates) {
    if (s && typeof s.id === 'string') stateById.set(s.id, s);
  }

  // ---- Empty queue: friendly done state ----------------------------------
  if (queue.length === 0) {
    renderEmpty(root, tagFilter, isMistakeMode);
    return;
  }

  // ---- Session state -----------------------------------------------------
  const total = queue.length;
  let index = 0;
  let flipped = false;
  const tally = { again: 0, hard: 0, good: 0, newCount: 0, reviewCount: 0 };

  // Detach any keyboard handler on teardown / navigation away.
  let keyHandler = null;
  function teardownKeys() {
    if (keyHandler) {
      window.removeEventListener('keydown', keyHandler);
      keyHandler = null;
    }
    tts.cancel();
  }

  /**
   * Resolve the working reviewState for the current word: prefer the freshly
   * stored record, then any preloaded state, then a synthesized initial state.
   * @param {string} wordId
   * @returns {Promise<object>}
   */
  async function resolveState(wordId) {
    const stored = await getReviewState(wordId);
    if (stored) return stored;
    if (stateById.has(wordId)) return stateById.get(wordId);
    return synthInitialState(wordId);
  }

  // ---- Card rendering ----------------------------------------------------
  function renderCard() {
    const entry = queue[index];
    const word = wordById.get(entry.wordId);

    if (!word) {
      // Defensive: word vanished from store; skip it.
      advance();
      return;
    }

    const examples = Array.isArray(word.examples) ? word.examples : [];
    const examplesHtml = examples.length
      ? `<ul class="study-examples">${examples
          .map((ex) => `<li>${esc(ex)}</li>`)
          .join('')}</ul>`
      : '';
    const rootAffixHtml = word.root_affix
      ? `<p class="study-root-affix"><span class="study-label">词根词缀</span>${esc(
          word.root_affix
        )}</p>`
      : '';
    const defEnHtml = word.def_en
      ? `<p class="study-def-en">${esc(word.def_en)}</p>`
      : '';

    const speakBtnHtml =
      ttsEnabled && tts.isSupported()
        ? `<button class="study-pronounce" type="button" aria-label="朗读单词" data-act="speak">🔊</button>`
        : '';

    const tag = isMistakeMode
      ? `<span class="study-badge study-badge-mistake">错题</span>`
      : entry.isNew
        ? `<span class="study-badge study-badge-new">新词</span>`
        : `<span class="study-badge study-badge-review">复习</span>`;

    const modeLabelHtml = isMistakeMode
      ? `<p class="study-mode-label">复习错题</p>`
      : '';

    root.innerHTML = `
      <div class="study-screen">
        <header class="study-header">
          <button class="study-back" type="button" data-act="home" aria-label="返回首页">‹</button>
          <div class="study-progress" role="progressbar"
               aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${index}">
            <div class="study-progress-bar" style="width:${(index / total) * 100}%"></div>
          </div>
          <span class="study-counter">${index + 1} / ${total}</span>
        </header>
        ${modeLabelHtml}

        <div class="study-card-region">
          <section class="study-card${flipped ? ' is-flipped' : ''}" data-act="flip" tabindex="0"
                   aria-label="点击翻转卡片">
            <div class="study-card-inner">
              <div class="study-face study-face-front">
                ${tag}
                <h2 class="study-word">${esc(word.word)}</h2>
                ${word.phonetic ? `<p class="study-phonetic">${esc(word.phonetic)}</p>` : ''}
                ${speakBtnHtml}
                <p class="study-hint muted">点击卡片或按空格显示答案</p>
              </div>
              <div class="study-face study-face-back">
                ${tag}
                <h2 class="study-word study-word-sm">${esc(word.word)}</h2>
                <p class="study-def-zh">${esc(word.def_zh)}</p>
                ${defEnHtml}
                ${examplesHtml}
                ${rootAffixHtml}
              </div>
            </div>
          </section>
        </div>

        ${
          flipped
            ? `<div class="study-ratings">${RATINGS.map(
                (r, i) =>
                  `<button class="study-rating ${r.cls}" type="button" data-rate="${r.key}">
                    <span class="study-rating-num">${i + 1}</span>${r.label}
                  </button>`
              ).join('')}</div>`
            : `<div class="study-actions"><button class="btn" type="button" data-act="flip">显示答案</button></div>`
        }
      </div>
    `;

    wireCard(word);
  }

  function wireCard(word) {
    // Back to home.
    root.querySelectorAll('[data-act="home"]').forEach((el) =>
      el.addEventListener('click', () => {
        teardownKeys();
        navigate('home');
      })
    );

    // Pronounce (front only; guarded by tts support at render time).
    const speakBtn = root.querySelector('[data-act="speak"]');
    if (speakBtn) {
      speakBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // don't also flip the card
        tts.speak(word.word);
      });
    }

    // Flip: clicking the card face or the explicit "显示答案" button.
    root.querySelectorAll('[data-act="flip"]').forEach((el) =>
      el.addEventListener('click', () => doFlip())
    );

    // Rating buttons (back only).
    root.querySelectorAll('[data-rate]').forEach((el) =>
      el.addEventListener('click', () => rate(el.dataset.rate))
    );
  }

  function doFlip() {
    if (flipped) return;
    flipped = true;
    renderCard();
  }

  async function rate(ratingKey) {
    if (!flipped) return;
    const entry = queue[index];

    // Disable the rating row to avoid double taps mid-persist.
    root.querySelectorAll('[data-rate]').forEach((el) => (el.disabled = true));

    try {
      const baseState = await resolveState(entry.wordId);
      const quality = gradeFromRating(ratingKey);
      const newState = applyReview(baseState, quality, today());
      await putReviewState(newState);
      // Keep the in-memory cache fresh in case the card recurs this session.
      stateById.set(entry.wordId, newState);
    } catch (err) {
      console.error('[study] failed to persist rating:', err);
      // Re-enable so the user can retry rather than getting stuck.
      root.querySelectorAll('[data-rate]').forEach((el) => (el.disabled = false));
      return;
    }

    // Tally for the summary.
    if (ratingKey === 'again') tally.again += 1;
    else if (ratingKey === 'hard') tally.hard += 1;
    else if (ratingKey === 'good') tally.good += 1;
    if (entry.isNew) tally.newCount += 1;
    else tally.reviewCount += 1;

    advance();
  }

  function advance() {
    index += 1;
    flipped = false;
    if (index >= total) {
      renderSummary();
    } else {
      renderCard();
    }
  }

  function renderSummary() {
    teardownKeys();
    const reviewed = tally.again + tally.hard + tally.good;
    const summaryTitle = isMistakeMode ? '错题复习完成 🎉' : '本组完成 🎉';
    root.innerHTML = `
      <header class="app-header"><h1 class="app-title">${summaryTitle}</h1></header>
      <section class="study-summary card">
        <p class="study-summary-total">共学习 <strong>${reviewed}</strong> 张卡片</p>
        <ul class="study-summary-list">
          <li><span class="study-summary-key">新词</span><span>${tally.newCount}</span></li>
          <li><span class="study-summary-key">复习</span><span>${tally.reviewCount}</span></li>
        </ul>
        <ul class="study-summary-breakdown">
          <li class="rating-good"><span>认识</span><span>${tally.good}</span></li>
          <li class="rating-hard"><span>模糊</span><span>${tally.hard}</span></li>
          <li class="rating-again"><span>不认识</span><span>${tally.again}</span></li>
        </ul>
      </section>
      <nav class="app-nav">
        <button class="btn" type="button" data-act="home">返回首页</button>
        <button class="btn btn-secondary" type="button" data-act="again">再来一组</button>
      </nav>
    `;

    root.querySelector('[data-act="home"]').addEventListener('click', () =>
      navigate('home')
    );
    root.querySelector('[data-act="again"]').addEventListener('click', () => {
      // Re-enter the study view to rebuild the queue from the now-updated states.
      renderStudy(root, { tagFilter, source }).catch((err) =>
        console.error('[study] re-enter failed:', err)
      );
    });
  }

  // ---- Keyboard niceties: space = flip, 1/2/3 = rate ---------------------
  keyHandler = (e) => {
    // Ignore when focus is in an input-like element.
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.code === 'Space' || e.key === ' ') {
      if (!flipped) {
        e.preventDefault();
        doFlip();
      }
    } else if (flipped && (e.key === '1' || e.key === '2' || e.key === '3')) {
      e.preventDefault();
      rate(RATINGS[Number(e.key) - 1].key);
    }
  };
  window.addEventListener('keydown', keyHandler);

  // First card.
  renderCard();
}

/** Friendly "nothing due" state. In mistake mode the 错题本 is empty. */
function renderEmpty(root, tagFilter, isMistakeMode = false) {
  if (isMistakeMode) {
    root.innerHTML = `
      <header class="app-header"><h1 class="app-title">复习错题</h1></header>
      <section class="study-empty card">
        <p class="study-empty-emoji">🎯</p>
        <p>错题本是空的，没有需要复习的错题。</p>
        <p class="muted">学习时点错的词会自动收进错题本。</p>
      </section>
      <nav class="app-nav">
        <button class="btn" type="button" data-act="home">返回首页</button>
      </nav>
    `;
    root.querySelector('[data-act="home"]').addEventListener('click', () =>
      navigate('home')
    );
    return;
  }

  const scope = tagFilter ? `（${esc(tagFilter)}）` : '';
  root.innerHTML = `
    <header class="app-header"><h1 class="app-title">学习${scope}</h1></header>
    <section class="study-empty card">
      <p class="study-empty-emoji">✅</p>
      <p>今日已完成，没有到期的卡片。</p>
      <p class="muted">明天再来，或调整每日新词上限。</p>
    </section>
    <nav class="app-nav">
      <button class="btn" type="button" data-act="home">返回首页</button>
    </nav>
  `;
  root.querySelector('[data-act="home"]').addEventListener('click', () =>
    navigate('home')
  );
}

/** Error state with a route home. */
function renderError(root, message) {
  root.innerHTML = `
    <header class="app-header"><h1 class="app-title">学习</h1></header>
    <section class="card"><p>${esc(message)}</p></section>
    <nav class="app-nav">
      <button class="btn" type="button" data-act="home">返回首页</button>
    </nav>
  `;
  const homeBtn = root.querySelector('[data-act="home"]');
  if (homeBtn) homeBtn.addEventListener('click', () => navigate('home'));
}

/**
 * Default export: a factory producing a mount-compatible render function bound
 * to the given options. Lets app.js do `mount(makeStudyView({ tagFilter }))` or
 * `mount(makeStudyView({ source: 'mistakes' }))` for the 错题本 review mode.
 * @param {{ tagFilter?: (string|null), source?: (string|null) }} [opts]
 * @returns {(root: HTMLElement) => void}
 */
export default function makeStudyView(opts = {}) {
  return (root) => {
    renderStudy(root, opts).catch((err) =>
      console.error('[study] render failed:', err)
    );
  };
}
