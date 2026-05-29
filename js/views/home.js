// views/home.js
// Home dashboard. The default landing view: today's study load at a glance plus
// simple lifetime stats and the primary entry points into study and settings.
//
// Mountable via app.js mount(viewFn): the default export is a render(root)
// function. Stats are recomputed every time the view is (re)mounted, so
// returning from a session shows fresh numbers.
//
// Pure scheduling lives in srs.js; this view only loads data (db) and renders.

import {
  today,
  getAllWords,
  getAllReviewState,
  getSetting,
} from '../db.js';
import { buildDailyQueue } from '../srs.js';
import { getSettings, computeStreak } from '../settings.js';
import { navigate } from '../app.js';

const PROGRAMMING_TAG = 'programming';

// Day labels indexed by JS Date.getDay() (0=Sun..6=Sat) for the plan line.
const DAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * Escape for safe HTML text/attribute insertion.
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
 * Build a subtle one-line plan summary, e.g. "计划：周一/三/五 · 提醒 20:00".
 * Shows the full week as "每天" when all 7 days are selected. Returns '' when no
 * study days are configured. studyDays uses JS Date.getDay() indexes.
 * @param {Array<number>} studyDays
 * @param {string} reminderTime - 'HH:MM'
 * @returns {string}
 */
function formatPlanLine(studyDays, reminderTime) {
  const days = Array.isArray(studyDays) ? studyDays.slice().sort((a, b) => a - b) : [];
  if (days.length === 0) return '';
  const daysText =
    days.length === 7
      ? '每天'
      : '周' + days.map((d) => DAY_LABELS[d] || '?').join('/');
  return `计划：${daysText} · 提醒 ${reminderTime}`;
}

/**
 * Compute dashboard stats from already-loaded data. Kept separate from the DOM
 * so the numbers are easy to reason about/test.
 *
 * @param {object} args
 * @param {Array<object>} args.words
 * @param {Array<object>} args.reviewStates
 * @param {{dailyNewLimit:number, dailyReviewLimit:(number|null)}} args.settings
 * @param {string} args.todayISO
 * @returns {{dueCount:number, newCount:number, streak:number, totalWords:number, learnedCount:number, programmingCount:number, mistakeCount:number}}
 */
export function computeDashboard({ words, reviewStates, settings, todayISO }) {
  // Today's queue (reviews + capped new) for the full set.
  const queue = buildDailyQueue({ words, reviewStates, settings, todayISO });
  let dueCount = 0;
  let newCount = 0;
  for (const item of queue) {
    if (item.isNew) newCount += 1;
    else dueCount += 1;
  }

  // Lifetime stats.
  let learnedCount = 0;
  // 错题本 size: words whose review state carries any lapse (lapses > 0).
  let mistakeCount = 0;
  for (const s of reviewStates) {
    const isNew = s && s.reps === 0 && (s.lastReviewed === null || s.lastReviewed === undefined);
    if (s && !isNew) learnedCount += 1;
    if (s && typeof s.lapses === 'number' && s.lapses > 0) mistakeCount += 1;
  }

  let programmingCount = 0;
  for (const w of words) {
    const tags = Array.isArray(w && w.tags) ? w.tags : [];
    if (tags.includes(PROGRAMMING_TAG)) programmingCount += 1;
  }

  return {
    dueCount,
    newCount,
    streak: computeStreak(reviewStates, todayISO),
    totalWords: words.length,
    learnedCount,
    programmingCount,
    mistakeCount,
  };
}

/**
 * Render the dashboard into the mount root.
 * @param {HTMLElement} root
 */
export async function renderHome(root) {
  if (!root) return;

  root.innerHTML = `
    <header class="app-header"><h1 class="app-title">背单词</h1></header>
    <section class="card"><p class="muted">正在统计今日进度…</p></section>
  `;

  let stats;
  let lastVocabEstimate;
  let planSettings = null;
  try {
    const [words, reviewStates, settings, vocabEstimate] = await Promise.all([
      getAllWords(),
      getAllReviewState(),
      getSettings(),
      getSetting('lastVocabEstimate', null),
    ]);
    stats = computeDashboard({ words, reviewStates, settings, todayISO: today() });
    lastVocabEstimate = vocabEstimate;
    planSettings = settings;
  } catch (err) {
    console.error('[home] failed to load dashboard data:', err);
    root.innerHTML = `
      <header class="app-header"><h1 class="app-title">背单词</h1></header>
      <section class="card"><p>加载首页数据失败，请刷新重试。</p></section>
    `;
    return;
  }

  const todayTotal = stats.dueCount + stats.newCount;

  // Optional subtle plan line: shown only when the reminder is enabled. Includes
  // the configured study days, reminder time, and today's remaining count.
  const planHtml =
    planSettings && planSettings.reminderEnabled === true
      ? (() => {
          const line = formatPlanLine(planSettings.studyDays, planSettings.reminderTime);
          if (!line) return '';
          const remaining =
            todayTotal > 0 ? ` · 今日剩余 ${esc(todayTotal)}` : ' · 今日已完成 ✓';
          return `<p class="home-plan-line muted">${esc(line)}${remaining}</p>`;
        })()
      : '';

  // Optional dashboard line: last measured vocabulary estimate.
  const lastEstimateHtml =
    lastVocabEstimate && Number.isFinite(Number(lastVocabEstimate.total))
      ? `<p class="home-vocab-estimate muted">上次测得词汇量 ≈ <strong>${esc(
          lastVocabEstimate.total
        )}</strong> 词 · ${esc(lastVocabEstimate.date)}</p>`
      : '';

  root.innerHTML = `
    <header class="app-header">
      <h1 class="app-title">背单词</h1>
      <p class="home-streak">🔥 连续学习 <strong>${stats.streak}</strong> 天</p>
      ${planHtml}
    </header>

    <section class="home-today card">
      <h2 class="home-section-title">今日任务</h2>
      <div class="home-today-grid">
        <button class="home-stat home-stat-review" type="button" data-route="words/due" aria-label="查看待复习词汇">
          <span class="home-stat-num">${stats.dueCount}</span>
          <span class="home-stat-label">待复习</span>
        </button>
        <button class="home-stat home-stat-new" type="button" data-route="words/new" aria-label="查看未学词汇">
          <span class="home-stat-num">${stats.newCount}</span>
          <span class="home-stat-label">新词</span>
        </button>
      </div>
      ${
        todayTotal === 0
          ? `<p class="home-clear muted">今日没有到期任务，去学点新词或调整每日上限。</p>`
          : ''
      }
    </section>

    <nav class="home-actions">
      <button class="btn home-cta" type="button" data-route="study">开始学习</button>
      <button class="btn btn-secondary" type="button" data-route="study/programming">编程词专项 (${stats.programmingCount})</button>
      <button class="btn btn-secondary" type="button" data-route="vocab-test">📊 测词汇量</button>
    </nav>

    ${lastEstimateHtml}

    <section class="home-stats card">
      <h2 class="home-section-title">学习概览</h2>
      <ul class="home-stats-list">
        <li class="home-stats-item" role="button" tabindex="0" data-route="words/all" aria-label="查看全部词汇">
          <span class="home-stats-key">总词汇量</span><span class="home-stats-val">${stats.totalWords} ›</span>
        </li>
        <li class="home-stats-item" role="button" tabindex="0" data-route="words/learned" aria-label="查看已学词汇">
          <span class="home-stats-key">已学习</span><span class="home-stats-val">${stats.learnedCount} ›</span>
        </li>
        <li class="home-stats-item" role="button" tabindex="0" data-route="words/programming" aria-label="查看编程词汇">
          <span class="home-stats-key">编程词</span><span class="home-stats-val">${stats.programmingCount} ›</span>
        </li>
        <li class="home-stats-item home-stats-mistakes" role="button" tabindex="0" data-route="mistakes" aria-label="查看错题本">
          <span class="home-stats-key">错题本 (${stats.mistakeCount})</span><span class="home-stats-val">${stats.mistakeCount} ›</span>
        </li>
      </ul>
      <p class="home-stats-hint muted">点击任意一项查看词汇列表</p>
    </section>
  `;

  // Wire route buttons/tiles. data-route may carry a param segment
  // (e.g. study/programming, words/learned). The clickable stat tiles and list
  // rows share this delegated handling; non-button elements (role="button") also
  // respond to Enter/Space for keyboard accessibility.
  root.querySelectorAll('[data-route]').forEach((el) => {
    el.addEventListener('click', () => navigate(el.dataset.route));
    if (el.tagName !== 'BUTTON') {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.code === 'Space') {
          e.preventDefault();
          navigate(el.dataset.route);
        }
      });
    }
  });

  // Defensive: ensure the streak number is well-formed text (esc guard for any
  // future dynamic label injection). No-op for the static markup above.
  void esc;
}

/**
 * Default export: a mount-compatible render function for app.js.
 * @returns {(root: HTMLElement) => void}
 */
export default function makeHomeView() {
  return (root) => {
    renderHome(root).catch((err) => console.error('[home] render failed:', err));
  };
}
