// views/vocab-test.js
// Vocabulary-size test view. A quick meaning-recognition quiz that estimates the
// user's current vocabulary size via the PURE vocab-estimate module.
//
// Flow:
//   intro    -> centered card with explanation + 开始测试
//   question -> progress bar; LARGE word + phonetic; 4 full-width stacked option
//               buttons. On tap: brief correct/wrong feedback (~450ms) then advance.
//               Records {tier, correct}.
//   result   -> polished result card: big 预计词汇量 ≈ N 词 + per-tier rows +
//               programming line + caveat; persists lastVocabEstimate to settings.
//
// estimate math + sampling live in js/vocab-estimate.js (pure); this module only
// loads data (db) and renders DOM. No TTS here. The full-height layout mirrors the
// study screen (.vocab-screen flex column).

import { getAllWords, putSetting, today } from '../db.js';
import { buildVocabTest, estimateVocabulary } from '../vocab-estimate.js';
import { navigate } from '../app.js';

// Visual feedback duration (ms) after a tap before advancing to the next question.
const FEEDBACK_MS = 450;

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
 * Render the vocabulary-test view into the mount root.
 * @param {HTMLElement} root
 */
export async function renderVocabTest(root) {
  if (!root) return;
  renderIntro(root);
}

/** Intro screen: centered card with explanation + 开始测试. */
function renderIntro(root) {
  root.innerHTML = `
    <div class="vocab-screen">
      <header class="study-header">
        <button class="study-back" type="button" data-act="home" aria-label="返回首页">‹</button>
        <h1 class="app-title settings-title">词汇量测试</h1>
      </header>

      <div class="vocab-intro-region">
        <section class="vocab-intro-card">
          <p class="vocab-intro-emoji">📊</p>
          <h2 class="vocab-intro-title">词汇量测试</h2>
          <p class="vocab-intro-lead">约 30+ 题，凭直觉选出每个单词的正确中文释义。</p>
          <p class="vocab-intro-sub muted">结果为基于难度分层抽样的粗略估算值。</p>
          <button class="btn vocab-start-btn" type="button" data-act="start">开始测试</button>
        </section>
      </div>
    </div>
  `;

  root.querySelector('[data-act="home"]').addEventListener('click', () => navigate('home'));
  root.querySelector('[data-act="start"]').addEventListener('click', () => {
    startTest(root).catch((err) => {
      console.error('[vocab-test] start failed:', err);
      renderError(root, '无法加载题库，请稍后重试。');
    });
  });
}

/** Build the test from the word store and begin the quiz. */
async function startTest(root) {
  root.innerHTML = `
    <div class="vocab-screen">
      <header class="study-header"><h1 class="app-title settings-title">词汇量测试</h1></header>
      <div class="vocab-intro-region">
        <section class="vocab-intro-card"><p class="muted">正在生成题目…</p></section>
      </div>
    </div>
  `;

  const words = await getAllWords();
  const questions = buildVocabTest(words);

  if (!questions.length) {
    renderError(root, '题库为空，无法开始测试。');
    return;
  }

  runQuiz(root, questions);
}

/** Interactive quiz loop: render each question, record results, then result. */
function runQuiz(root, questions) {
  const total = questions.length;
  const results = [];
  let index = 0;
  let locked = false; // true during feedback window to block double taps

  function renderQuestion() {
    locked = false;
    const q = questions[index];
    const optionsHtml = q.options
      .map(
        (opt, i) =>
          `<button class="vocab-option" type="button" data-pick="${i}">${esc(opt)}</button>`
      )
      .join('');

    root.innerHTML = `
      <div class="vocab-screen">
        <header class="study-header">
          <button class="study-back" type="button" data-act="home" aria-label="返回首页">‹</button>
          <div class="study-progress" role="progressbar"
               aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${index}">
            <div class="study-progress-bar" style="width:${(index / total) * 100}%"></div>
          </div>
          <span class="study-counter">${index + 1} / ${total}</span>
        </header>

        <div class="vocab-question-region">
          <h2 class="vocab-word">${esc(q.word)}</h2>
          ${q.phonetic ? `<p class="vocab-phonetic">${esc(q.phonetic)}</p>` : ''}
        </div>

        <div class="vocab-options">${optionsHtml}</div>
      </div>
    `;

    const backBtn = root.querySelector('[data-act="home"]');
    if (backBtn) backBtn.addEventListener('click', () => navigate('home'));

    root.querySelectorAll('[data-pick]').forEach((el) =>
      el.addEventListener('click', () => pick(Number(el.dataset.pick)))
    );
  }

  function pick(choiceIndex) {
    if (locked) return;
    locked = true;

    const q = questions[index];
    const correct = choiceIndex === q.correctIndex;
    results.push({ tier: q.tier, correct });

    // Visual feedback: mark the chosen option green/red and reveal the correct
    // answer; disable further taps during the feedback window.
    const optionEls = root.querySelectorAll('[data-pick]');
    optionEls.forEach((el) => {
      el.disabled = true;
      const i = Number(el.dataset.pick);
      if (i === q.correctIndex) el.classList.add('is-correct');
      if (i === choiceIndex && !correct) el.classList.add('is-wrong');
    });

    window.setTimeout(() => {
      index += 1;
      if (index >= total) {
        finish();
      } else {
        renderQuestion();
      }
    }, FEEDBACK_MS);
  }

  function finish() {
    const estimate = estimateVocabulary(results);
    persistEstimate(estimate);
    renderResult(root, estimate);
  }

  renderQuestion();
}

/** Persist the latest estimate to settings (best-effort). */
function persistEstimate(estimate) {
  putSetting('lastVocabEstimate', {
    total: estimate.total,
    programming: estimate.programming.estimated,
    date: today(),
  }).catch((err) => console.error('[vocab-test] failed to persist estimate:', err));
}

/** Result screen: big total + per-tier breakdown + programming + caveat. */
function renderResult(root, estimate) {
  const rows = estimate.perTier
    .map(
      (t) => `
        <li class="vocab-result-row">
          <span class="vocab-result-label">${esc(t.label)}</span>
          <span class="vocab-result-score">${esc(t.correct)}/${esc(t.shown)}</span>
          <span class="vocab-result-rate">${esc(Math.round(t.knownRate * 100))}%</span>
          <span class="vocab-result-est">${esc(t.estimated)} 词</span>
        </li>`
    )
    .join('');

  const pg = estimate.programming;

  root.innerHTML = `
    <div class="vocab-screen vocab-result-screen">
      <header class="study-header">
        <button class="study-back" type="button" data-act="home" aria-label="返回首页">‹</button>
        <h1 class="app-title settings-title">测试结果</h1>
      </header>

      <div class="vocab-result-region">
        <section class="vocab-result-hero">
          <p class="vocab-result-hero-label">预计词汇量</p>
          <p class="vocab-result-hero-num">≈ <strong>${esc(estimate.total)}</strong> 词</p>
        </section>

        <section class="vocab-result-breakdown">
          <h2 class="settings-heading">分层明细</h2>
          <ul class="vocab-result-list">
            <li class="vocab-result-row vocab-result-head">
              <span class="vocab-result-label">层级</span>
              <span class="vocab-result-score">答对/题数</span>
              <span class="vocab-result-rate">掌握率</span>
              <span class="vocab-result-est">预计</span>
            </li>
            ${rows}
          </ul>
          <p class="vocab-result-programming">编程词汇 ≈ <strong>${esc(pg.estimated)}</strong> 词（答对 ${esc(pg.correct)}/${esc(pg.shown)}）</p>
        </section>

        <p class="settings-hint muted vocab-caveat">估算基于难度分层抽样，样本较小为粗略值，接入完整词频词库后会更准确。</p>
      </div>

      <nav class="vocab-result-actions">
        <button class="btn" type="button" data-act="retry">重新测试</button>
        <button class="btn btn-secondary" type="button" data-act="home">返回首页</button>
      </nav>
    </div>
  `;

  root.querySelectorAll('[data-act="home"]').forEach((el) =>
    el.addEventListener('click', () => navigate('home'))
  );
  root.querySelector('[data-act="retry"]').addEventListener('click', () => {
    startTest(root).catch((err) => {
      console.error('[vocab-test] retry failed:', err);
      renderError(root, '无法重新加载题库，请稍后重试。');
    });
  });
}

/** Error state with a route home. */
function renderError(root, message) {
  root.innerHTML = `
    <div class="vocab-screen">
      <header class="study-header"><h1 class="app-title settings-title">词汇量测试</h1></header>
      <div class="vocab-intro-region">
        <section class="vocab-intro-card"><p>${esc(message)}</p></section>
      </div>
      <nav class="vocab-result-actions">
        <button class="btn" type="button" data-act="home">返回首页</button>
      </nav>
    </div>
  `;
  const homeBtn = root.querySelector('[data-act="home"]');
  if (homeBtn) homeBtn.addEventListener('click', () => navigate('home'));
}

/**
 * Default export: a mount-compatible render function for app.js.
 * @returns {(root: HTMLElement) => void}
 */
export default function makeVocabTestView() {
  return (root) => {
    renderVocabTest(root).catch((err) => console.error('[vocab-test] render failed:', err));
  };
}
