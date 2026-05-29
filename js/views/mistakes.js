// views/mistakes.js
// 错题本 (mistake notebook) view. Lists every word the learner has ever failed
// (its reviewState carries lapses > 0) and offers an on-demand "复习错题" study
// session plus a per-row "移出错题本" action.
//
// Reachable via #/mistakes. Layout mirrors the word-list / study full-height
// flex column (.wordlist-screen) so it sits cleanly above the fixed bottom nav.
// Tapping a row expands it inline (def_en, examples, 词根词缀, tags, SRS status)
// exactly like word-list, for visual consistency.
//
// Data: getAllWords() + getAllReviewState() joined by id. db.js stays the data
// layer; this module only loads + renders DOM. srs.js stays pure.

import {
  getAllWords,
  getAllReviewState,
  putReviewState,
} from '../db.js';
import { navigate } from '../app.js';

// Sort modes for the list: by lapse count desc (most-missed first) or by
// most-recently reviewed first.
const SORTS = [
  { key: 'lapses', label: '按错误次数' },
  { key: 'recent', label: '最近' },
];

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

/** Lapse count of a review state (0 when absent). */
function lapseCount(state) {
  return state && typeof state.lapses === 'number' ? state.lapses : 0;
}

/** A word is "new" (未学) when untouched: no reps and never reviewed. */
function isNew(state) {
  if (!state) return true;
  return state.reps === 0 && state.lastReviewed == null;
}

/**
 * Short, human-readable SRS status for the expanded row (mirrors word-list).
 * @param {object|undefined} state
 * @returns {string}
 */
function srsStatusText(state) {
  if (isNew(state)) return '状态: 新';
  const stage = state.reps >= 3 ? '已掌握' : '学习中';
  const interval = Number.isFinite(Number(state.interval)) ? Number(state.interval) : 0;
  const due = typeof state.due === 'string' ? state.due : '—';
  return `状态: ${stage} · 间隔 ${interval} 天 · 下次复习 ${due}`;
}

/**
 * Render the 错题本 view into the mount root.
 * @param {HTMLElement} root - the #app mount element (cleared by mount())
 */
export async function renderMistakes(root) {
  if (!root) return;

  root.innerHTML = `
    <div class="wordlist-screen mistakes-screen">
      <header class="study-header">
        <button class="study-back" type="button" data-act="home" aria-label="返回首页">‹</button>
        <h1 class="app-title settings-title">错题本</h1>
      </header>
      <p class="muted wordlist-loading">正在加载错题…</p>
    </div>
  `;

  let words;
  let reviewStates;
  try {
    [words, reviewStates] = await Promise.all([getAllWords(), getAllReviewState()]);
  } catch (err) {
    console.error('[mistakes] failed to load data:', err);
    renderError(root, '加载错题数据失败，请稍后重试。');
    return;
  }

  // Index review states by id and collect the lapsed (lapses > 0) word ids.
  const stateById = new Map();
  for (const s of reviewStates) {
    if (s && typeof s.id === 'string') stateById.set(s.id, s);
  }

  // Join lapsed states onto their words.
  let rows = [];
  for (const w of words) {
    if (!w || typeof w.id !== 'string') continue;
    const state = stateById.get(w.id);
    if (lapseCount(state) > 0) rows.push({ word: w, state });
  }

  // ---- Empty state -------------------------------------------------------
  if (rows.length === 0) {
    root.innerHTML = `
      <div class="wordlist-screen mistakes-screen">
        <header class="study-header">
          <button class="study-back" type="button" data-act="home" aria-label="返回首页">‹</button>
          <h1 class="app-title settings-title">错题本</h1>
        </header>
        <section class="mistakes-empty card">
          <p class="mistakes-empty-emoji">🎯</p>
          <p>还没有错题，继续加油！</p>
          <p class="muted">学习时点错的词会自动收进错题本。</p>
        </section>
        <nav class="app-nav">
          <button class="btn" type="button" data-act="home">返回首页</button>
        </nav>
      </div>
    `;
    root.querySelectorAll('[data-act="home"]').forEach((el) =>
      el.addEventListener('click', () => navigate('home'))
    );
    return;
  }

  // ---- List state --------------------------------------------------------
  const expanded = new Set();
  let sortKey = 'lapses';

  /** Sort `rows` in place per the active sort key. */
  function applySort() {
    rows.sort((a, b) => {
      if (sortKey === 'recent') {
        // Most recently reviewed first; nulls last; id tie-break.
        const la = a.state && a.state.lastReviewed ? a.state.lastReviewed : '';
        const lb = b.state && b.state.lastReviewed ? b.state.lastReviewed : '';
        if (la !== lb) return la < lb ? 1 : -1;
        return a.word.id < b.word.id ? -1 : a.word.id > b.word.id ? 1 : 0;
      }
      // Default: lapses desc, then id for stability.
      const ca = lapseCount(a.state);
      const cb = lapseCount(b.state);
      if (ca !== cb) return cb - ca;
      return a.word.id < b.word.id ? -1 : a.word.id > b.word.id ? 1 : 0;
    });
  }

  const sortChipsHtml = SORTS.map(
    (s) =>
      `<button class="wordlist-chip${s.key === sortKey ? ' is-active' : ''}" type="button" data-sort="${esc(
        s.key
      )}">${esc(s.label)}</button>`
  ).join('');

  root.innerHTML = `
    <div class="wordlist-screen mistakes-screen">
      <header class="study-header">
        <button class="study-back" type="button" data-act="home" aria-label="返回首页">‹</button>
        <h1 class="app-title settings-title">错题本</h1>
      </header>

      <div class="wordlist-controls mistakes-controls">
        <div class="mistakes-summary">
          <p class="mistakes-count" data-role="count"></p>
          <button class="btn mistakes-review-btn" type="button" data-act="review">复习错题</button>
        </div>
        <div class="wordlist-chips mistakes-sorts">${sortChipsHtml}</div>
      </div>

      <div class="wordlist-body mistakes-body" data-role="list"></div>
    </div>
  `;

  const listEl = root.querySelector('[data-role="list"]');
  const countEl = root.querySelector('[data-role="count"]');
  const reviewBtn = root.querySelector('[data-act="review"]');

  root.querySelector('[data-act="home"]').addEventListener('click', () => navigate('home'));

  reviewBtn.addEventListener('click', () => navigate('study/mistakes'));

  root.querySelectorAll('[data-sort]').forEach((el) =>
    el.addEventListener('click', () => {
      sortKey = el.dataset.sort;
      root.querySelectorAll('[data-sort]').forEach((chip) =>
        chip.classList.toggle('is-active', chip.dataset.sort === sortKey)
      );
      applySort();
      renderBody();
    })
  );

  /**
   * Clear a word from the 错题本 by resetting its reviewState lapses to 0,
   * then drop it from the in-memory rows and re-render.
   * @param {string} id - word id
   */
  async function removeFromBook(id) {
    const state = stateById.get(id);
    if (!state) return;
    const cleared = { ...state, lapses: 0 };
    try {
      await putReviewState(cleared);
    } catch (err) {
      console.error('[mistakes] failed to clear lapse:', err);
      return;
    }
    stateById.set(id, cleared);
    rows = rows.filter((r) => r.word.id !== id);
    expanded.delete(id);

    if (rows.length === 0) {
      // Last one removed: re-render the whole view to show the empty state.
      renderMistakes(root).catch((e) => console.error('[mistakes] re-render failed:', e));
      return;
    }
    renderBody();
  }

  /** Render the scrolling list body + count line + review-button state. */
  function renderBody() {
    countEl.textContent = `错题 ${rows.length} 个`;
    reviewBtn.disabled = rows.length === 0;

    if (rows.length === 0) {
      listEl.innerHTML = `<p class="wordlist-empty muted">错题本已清空。</p>`;
      return;
    }

    listEl.innerHTML = rows
      .map((entry) => {
        const w = entry.word;
        const open = expanded.has(w.id);
        const examples = Array.isArray(w.examples) ? w.examples : [];
        const tags = Array.isArray(w.tags) ? w.tags : [];
        const count = lapseCount(entry.state);

        const detailHtml = open
          ? `
            <div class="wordlist-detail">
              ${w.def_en ? `<p class="wordlist-def-en">${esc(w.def_en)}</p>` : ''}
              ${
                examples.length
                  ? `<ul class="wordlist-examples">${examples
                      .map((ex) => `<li>${esc(ex)}</li>`)
                      .join('')}</ul>`
                  : ''
              }
              ${
                w.root_affix
                  ? `<p class="wordlist-root-affix"><span class="study-label">词根词缀</span>${esc(
                      w.root_affix
                    )}</p>`
                  : ''
              }
              ${
                tags.length
                  ? `<div class="wordlist-tags">${tags
                      .map((t) => `<span class="wordlist-tag">${esc(t)}</span>`)
                      .join('')}</div>`
                  : ''
              }
              <p class="wordlist-srs muted">${esc(srsStatusText(entry.state))}</p>
              <div class="mistakes-detail-actions">
                <button class="btn btn-secondary mistakes-remove" type="button" data-remove="${esc(
                  w.id
                )}">移出错题本</button>
              </div>
            </div>`
          : '';

        return `
          <div class="wordlist-row mistakes-row${open ? ' is-open' : ''}">
            <button class="wordlist-row-head" type="button" data-toggle="${esc(w.id)}"
                    aria-expanded="${open ? 'true' : 'false'}">
              <span class="wordlist-row-main">
                <span class="wordlist-row-word">${esc(w.word)}</span>
                ${w.phonetic ? `<span class="wordlist-row-phonetic">${esc(w.phonetic)}</span>` : ''}
              </span>
              <span class="wordlist-row-def">${esc(w.def_zh)}</span>
              <span class="mistakes-badge" aria-label="错误 ${count} 次">✕${esc(count)}</span>
            </button>
            ${detailHtml}
          </div>`;
      })
      .join('');

    listEl.querySelectorAll('[data-toggle]').forEach((el) =>
      el.addEventListener('click', () => {
        const id = el.dataset.toggle;
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        renderBody();
      })
    );

    listEl.querySelectorAll('[data-remove]').forEach((el) =>
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFromBook(el.dataset.remove);
      })
    );
  }

  applySort();
  renderBody();
}

/** Error state with a route home. */
function renderError(root, message) {
  root.innerHTML = `
    <div class="wordlist-screen mistakes-screen">
      <header class="study-header"><h1 class="app-title settings-title">错题本</h1></header>
      <section class="card"><p>${esc(message)}</p></section>
      <nav class="app-nav">
        <button class="btn" type="button" data-act="home">返回首页</button>
      </nav>
    </div>
  `;
  const homeBtn = root.querySelector('[data-act="home"]');
  if (homeBtn) homeBtn.addEventListener('click', () => navigate('home'));
}

/**
 * Default export: a factory producing a mount-compatible render function.
 * Lets app.js do `mount(makeMistakesView())`.
 * @returns {(root: HTMLElement) => void}
 */
export default function makeMistakesView() {
  return (root) => {
    renderMistakes(root).catch((err) =>
      console.error('[mistakes] render failed:', err)
    );
  };
}
