// views/word-list.js
// Searchable word-list / browse view. Reachable via #/words and #/words/<filter>
// (also from tapping the dashboard stat tiles). Lets the user browse every word
// in the store, filter by learning status, and live-search by word or 中文释义.
//
// Layout: a full-height .wordlist-screen flex column — a fixed header (search +
// filter chips + count) on top and a scrolling list below that fits above the
// fixed bottom nav. Tapping a row expands it inline to show def_en, examples,
// 词根词缀, tags, and a short SRS status line.
//
// Data: getAllWords() + getAllReviewState() joined by id. db.js stays the data
// layer; this module only loads + renders DOM. Pure, theme-consistent markup.

import { today, getAllWords, getAllReviewState } from '../db.js';
import { difficultyOf, DIFFICULTY_LABELS } from '../srs.js';
import { navigate } from '../app.js';
import { renderExampleItems, renderDefWithPos } from './study.js';

const PROGRAMMING_TAG = 'programming';

// Difficulty filter keys -> their tier (used so #/words/easy|medium|hard work as
// difficulty filters). Keys are kept distinct from status filters.
const DIFFICULTY_FILTERS = { easy: 'easy', medium: 'medium', hard: 'hard' };

// Built-in status filters (in addition to any raw tag name like 'cet4').
// key matches the URL segment; label is the chip text. The trailing three are
// difficulty filters (#/words/easy|medium|hard).
const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'learned', label: '已学' },
  { key: 'new', label: '未学' },
  { key: 'due', label: '待复习' },
  { key: 'programming', label: '编程' },
  { key: 'easy', label: DIFFICULTY_LABELS.easy },
  { key: 'medium', label: DIFFICULTY_LABELS.medium },
  { key: 'hard', label: DIFFICULTY_LABELS.hard },
];
const FILTER_KEYS = new Set(FILTERS.map((f) => f.key));

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

/** A word is "learned" once it has any reps or has ever been reviewed. */
function isLearned(state) {
  if (!state) return false;
  return state.reps > 0 || state.lastReviewed != null;
}

/** A word is "new" (未学) when untouched: no reps and never reviewed. */
function isNew(state) {
  if (!state) return true;
  return state.reps === 0 && state.lastReviewed == null;
}

/** A word is "due" when reviewed at least once and its due date has arrived. */
function isDue(state, todayISO) {
  if (!state) return false;
  return state.lastReviewed != null && typeof state.due === 'string' && state.due <= todayISO;
}

/** Has the programming tag. */
function isProgramming(word) {
  const tags = Array.isArray(word && word.tags) ? word.tags : [];
  return tags.includes(PROGRAMMING_TAG);
}

/**
 * Short, human-readable SRS status for the expanded row.
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
 * Render the word-list view into the mount root.
 * @param {HTMLElement} root
 * @param {{ filter?: (string|null) }} [opts]
 */
export async function renderWordList(root, { filter = 'all' } = {}) {
  if (!root) return;

  const activeFilter = filter || 'all';

  root.innerHTML = `
    <div class="wordlist-screen">
      <header class="study-header">
        <button class="study-back" type="button" data-act="home" aria-label="返回首页">‹</button>
        <h1 class="app-title settings-title">词汇列表</h1>
      </header>
      <p class="muted wordlist-loading">正在加载词汇…</p>
    </div>
  `;

  let words;
  let reviewStates;
  try {
    [words, reviewStates] = await Promise.all([getAllWords(), getAllReviewState()]);
  } catch (err) {
    console.error('[word-list] failed to load data:', err);
    renderError(root, '加载词汇数据失败，请稍后重试。');
    return;
  }

  const todayISO = today();

  // Join review state onto each word by id.
  const stateById = new Map();
  for (const s of reviewStates) {
    if (s && typeof s.id === 'string') stateById.set(s.id, s);
  }
  const rows = words.map((w) => ({ word: w, state: stateById.get(w.id) }));

  // Status filter (built-in keys) OR raw tag name (e.g. 'cet4').
  function passesFilter(entry) {
    switch (activeFilter) {
      case 'all':
        return true;
      case 'learned':
        return isLearned(entry.state);
      case 'new':
        return isNew(entry.state);
      case 'due':
        return isDue(entry.state, todayISO);
      case 'programming':
        return isProgramming(entry.word);
      case 'easy':
      case 'medium':
      case 'hard':
        // Difficulty filters (#/words/easy|medium|hard).
        return difficultyOf(entry.word) === DIFFICULTY_FILTERS[activeFilter];
      default: {
        // Treat an unknown filter as a tag name match.
        const tags = Array.isArray(entry.word.tags) ? entry.word.tags : [];
        return tags.includes(activeFilter);
      }
    }
  }

  // Track which rows are expanded across re-renders of the list body.
  const expanded = new Set();
  let searchTerm = '';

  // Build the static shell once (header + chips + count + search + list body),
  // then re-render only the list body + count on search/expand changes.
  const chipsHtml = FILTERS.map(
    (f) =>
      `<button class="wordlist-chip${f.key === activeFilter ? ' is-active' : ''}" type="button" data-filter="${esc(
        f.key
      )}">${esc(f.label)}</button>`
  ).join('');

  // When the active filter is a raw tag (not a built-in), surface it as an extra
  // active chip so the user sees what is applied.
  const extraChipHtml = FILTER_KEYS.has(activeFilter)
    ? ''
    : `<button class="wordlist-chip is-active" type="button" data-filter="${esc(
        activeFilter
      )}">#${esc(activeFilter)}</button>`;

  root.innerHTML = `
    <div class="wordlist-screen">
      <header class="study-header">
        <button class="study-back" type="button" data-act="home" aria-label="返回首页">‹</button>
        <h1 class="app-title settings-title">词汇列表</h1>
      </header>

      <div class="wordlist-controls">
        <input class="wordlist-search" type="search" inputmode="search"
               placeholder="搜索单词或释义…" aria-label="搜索单词或释义" />
        <div class="wordlist-chips">${chipsHtml}${extraChipHtml}</div>
        <p class="wordlist-count muted" data-role="count"></p>
      </div>

      <div class="wordlist-body" data-role="list"></div>
    </div>
  `;

  const listEl = root.querySelector('[data-role="list"]');
  const countEl = root.querySelector('[data-role="count"]');
  const searchEl = root.querySelector('.wordlist-search');

  root.querySelector('[data-act="home"]').addEventListener('click', () => navigate('home'));

  // Filter chips update the route (and thus the active filter) via the router.
  root.querySelectorAll('[data-filter]').forEach((el) =>
    el.addEventListener('click', () => {
      const key = el.dataset.filter;
      navigate(key === 'all' ? 'words' : `words/${key}`);
    })
  );

  // Live search: filter by word OR def_zh substring, case-insensitive.
  searchEl.addEventListener('input', () => {
    searchTerm = searchEl.value.trim().toLowerCase();
    renderBody();
  });

  /** Compute the currently visible entries (filter + search). */
  function visibleEntries() {
    const base = rows.filter(passesFilter);
    if (!searchTerm) return base;
    return base.filter((entry) => {
      const w = (entry.word.word || '').toLowerCase();
      const d = (entry.word.def_zh || '').toLowerCase();
      return w.includes(searchTerm) || d.includes(searchTerm);
    });
  }

  /**
   * Render the scrolling list body + count line.
   * NOTE: 441 rows render fine as plain DOM. For the future 7-8k dataset, swap
   * this for a virtualized/windowed list (render only the visible slice).
   */
  function renderBody() {
    const entries = visibleEntries();
    countEl.textContent = `共 ${entries.length} 词`;

    if (entries.length === 0) {
      listEl.innerHTML = `<p class="wordlist-empty muted">没有匹配的词。</p>`;
      return;
    }

    listEl.innerHTML = entries
      .map((entry) => {
        const w = entry.word;
        const open = expanded.has(w.id);
        const examples = Array.isArray(w.examples) ? w.examples : [];
        const tags = Array.isArray(w.tags) ? w.tags : [];

        const exampleItems = renderExampleItems(examples);
        const detailHtml = open
          ? `
            <div class="wordlist-detail">
              ${w.def_en ? `<p class="wordlist-def-en">${renderDefWithPos(w.def_en)}</p>` : ''}
              ${
                exampleItems
                  ? `<ul class="wordlist-examples">${exampleItems}</ul>`
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
            </div>`
          : '';

        const diff = difficultyOf(w);
        const diffBadge = `<span class="diff-badge diff-${diff}">${esc(DIFFICULTY_LABELS[diff])}</span>`;

        return `
          <div class="wordlist-row${open ? ' is-open' : ''}">
            <button class="wordlist-row-head" type="button" data-toggle="${esc(w.id)}"
                    aria-expanded="${open ? 'true' : 'false'}">
              <span class="wordlist-row-main">
                <span class="wordlist-row-word-line">
                  <span class="wordlist-row-word">${esc(w.word)}</span>
                  ${diffBadge}
                </span>
                ${w.phonetic ? `<span class="wordlist-row-phonetic">${esc(w.phonetic)}</span>` : ''}
              </span>
              <span class="wordlist-row-def">${renderDefWithPos(w.def_zh)}</span>
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
  }

  renderBody();
}

/** Error state with a route home. */
function renderError(root, message) {
  root.innerHTML = `
    <div class="wordlist-screen">
      <header class="study-header"><h1 class="app-title settings-title">词汇列表</h1></header>
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
 * Default export: a factory producing a mount-compatible render function bound to
 * the given options. Lets app.js do `mount(makeWordListView({ filter }))`.
 * @param {{ filter?: (string|null) }} [opts]
 * @returns {(root: HTMLElement) => void}
 */
export default function makeWordListView(opts = {}) {
  return (root) => {
    renderWordList(root, opts).catch((err) =>
      console.error('[word-list] render failed:', err)
    );
  };
}
