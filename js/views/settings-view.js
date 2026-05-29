// views/settings-view.js
// Settings view. Edit the daily new-word limit, reset learning progress, and
// export/import a full JSON backup. All persistence + backup logic lives in
// settings.js; this module is DOM wiring + confirm-gating + feedback.
//
// Mountable via app.js mount(viewFn): the default export is a render(root)
// function.

import {
  getSettings,
  updateSetting,
  resetProgress,
  exportData,
  importData,
} from '../settings.js';
import { DEFAULT_DAILY_NEW_LIMIT } from '../config.js';
import { navigate } from '../app.js';

/**
 * Escape for safe HTML insertion.
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
 * Render the settings view into the mount root.
 * @param {HTMLElement} root
 */
export async function renderSettings(root) {
  if (!root) return;

  let settings;
  try {
    settings = await getSettings();
  } catch (err) {
    console.error('[settings] failed to load settings:', err);
    settings = { dailyNewLimit: DEFAULT_DAILY_NEW_LIMIT, dailyReviewLimit: null };
  }

  const dailyNewLimit = Number.isFinite(Number(settings.dailyNewLimit))
    ? Number(settings.dailyNewLimit)
    : DEFAULT_DAILY_NEW_LIMIT;
  const ttsEnabled = settings.ttsEnabled === true;

  root.innerHTML = `
    <header class="study-header">
      <button class="study-back" type="button" data-act="home" aria-label="返回首页">‹</button>
      <h1 class="app-title settings-title">设置</h1>
    </header>

    <section class="card settings-section">
      <h2 class="settings-heading">学习</h2>
      <label class="settings-field">
        <span class="settings-field-label">每日新词上限</span>
        <input class="settings-input" type="number" inputmode="numeric"
               min="0" max="999" step="1" value="${esc(dailyNewLimit)}"
               data-field="dailyNewLimit" aria-label="每日新词上限" />
      </label>
      <p class="settings-hint muted">下次学习时按此数量引入新词。</p>

      <label class="settings-field settings-field-toggle">
        <span class="settings-field-label">朗读发音（实验性 · iOS 系统语音）</span>
        <input class="settings-checkbox" type="checkbox"
               data-field="ttsEnabled" aria-label="朗读发音"${ttsEnabled ? ' checked' : ''} />
      </label>
      <p class="settings-hint muted">默认关闭，仅显示音标。开启后学习卡片显示朗读按钮（系统语音音质有限）。</p>
    </section>

    <section class="card settings-section">
      <h2 class="settings-heading">数据备份</h2>
      <p class="settings-hint muted">导出包含所有单词、复习进度与设置的单一 JSON 文件，可在本机恢复。</p>
      <div class="settings-actions">
        <button class="btn" type="button" data-act="export">导出备份 (JSON)</button>
        <button class="btn btn-secondary" type="button" data-act="import">导入备份</button>
      </div>
      <input class="settings-file" type="file" accept="application/json,.json"
             data-act="import-file" hidden />
    </section>

    <section class="card settings-section">
      <h2 class="settings-heading">危险区</h2>
      <p class="settings-hint muted">重置后所有单词重新变为新词，单词数据保留。</p>
      <button class="btn settings-danger" type="button" data-act="reset">重置学习进度</button>
    </section>

    <p class="settings-feedback" data-region="feedback" role="status" aria-live="polite"></p>
  `;

  wire(root);
}

/**
 * Attach all event handlers for the settings view.
 * @param {HTMLElement} root
 */
function wire(root) {
  const feedbackEl = root.querySelector('[data-region="feedback"]');

  /**
   * Show transient feedback text.
   * @param {string} msg
   * @param {('ok'|'error')} [kind='ok']
   */
  function feedback(msg, kind = 'ok') {
    if (!feedbackEl) return;
    feedbackEl.textContent = msg;
    feedbackEl.className = `settings-feedback settings-feedback-${kind}`;
  }

  // Back to home.
  const backBtn = root.querySelector('[data-act="home"]');
  if (backBtn) backBtn.addEventListener('click', () => navigate('home'));

  // Daily new-word limit: persist on change/blur.
  const limitInput = root.querySelector('[data-field="dailyNewLimit"]');
  if (limitInput) {
    limitInput.addEventListener('change', async () => {
      const raw = Number(limitInput.value);
      const value = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_DAILY_NEW_LIMIT;
      limitInput.value = String(value);
      try {
        await updateSetting('dailyNewLimit', value);
        feedback(`已保存：每日新词上限 ${value}`, 'ok');
      } catch (err) {
        console.error('[settings] failed to save dailyNewLimit:', err);
        feedback('保存失败，请重试。', 'error');
      }
    });
  }

  // Pronunciation toggle (ttsEnabled): persist on change.
  const ttsToggle = root.querySelector('[data-field="ttsEnabled"]');
  if (ttsToggle) {
    ttsToggle.addEventListener('change', async () => {
      const value = ttsToggle.checked === true;
      try {
        await updateSetting('ttsEnabled', value);
        feedback(value ? '已开启朗读发音。' : '已关闭朗读发音。', 'ok');
      } catch (err) {
        console.error('[settings] failed to save ttsEnabled:', err);
        feedback('保存失败，请重试。', 'error');
        ttsToggle.checked = !value;
      }
    });
  }

  // Export backup.
  const exportBtn = root.querySelector('[data-act="export"]');
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      try {
        const payload = await exportData();
        const n = Array.isArray(payload.words) ? payload.words.length : 0;
        feedback(`已导出备份（${n} 个单词）。`, 'ok');
      } catch (err) {
        console.error('[settings] export failed:', err);
        feedback('导出失败，请重试。', 'error');
      }
    });
  }

  // Import backup: button opens the hidden file input.
  const importBtn = root.querySelector('[data-act="import"]');
  const fileInput = root.querySelector('[data-act="import-file"]');
  if (importBtn && fileInput) {
    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (!window.confirm('导入备份将覆盖当前数据，确定继续？')) {
        fileInput.value = '';
        return;
      }
      feedback('正在导入…', 'ok');
      try {
        const summary = await importData(file);
        const warn = summary.warnings && summary.warnings.length
          ? `（${summary.warnings.join(' ')}）`
          : '';
        feedback(
          `导入完成：${summary.words} 单词 / ${summary.reviewState} 进度 / ${summary.settings} 设置${warn}`,
          'ok'
        );
        // Return home so the dashboard reflects the restored data.
        setTimeout(() => navigate('home'), 600);
      } catch (err) {
        console.error('[settings] import failed:', err);
        feedback(err && err.message ? err.message : '导入失败。', 'error');
      } finally {
        fileInput.value = '';
      }
    });
  }

  // Reset progress: confirm-gated.
  const resetBtn = root.querySelector('[data-act="reset"]');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      if (!window.confirm('确定重置所有学习进度？所有单词将重新变为新词（单词数据保留）。')) {
        return;
      }
      resetBtn.disabled = true;
      try {
        const res = await resetProgress();
        feedback(`已重置 ${res.reset} 个单词的学习进度。`, 'ok');
        setTimeout(() => navigate('home'), 600);
      } catch (err) {
        console.error('[settings] reset failed:', err);
        feedback('重置失败，请重试。', 'error');
        resetBtn.disabled = false;
      }
    });
  }
}

/**
 * Default export: a mount-compatible render function for app.js.
 * @returns {(root: HTMLElement) => void}
 */
export default function makeSettingsView() {
  return (root) => {
    renderSettings(root).catch((err) => console.error('[settings] render failed:', err));
  };
}
