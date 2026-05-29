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
 * Human-readable label for the Notification permission state.
 * @param {('default'|'granted'|'denied'|'unsupported'|string)} permission
 * @returns {string}
 */
function permissionLabel(permission) {
  switch (permission) {
    case 'granted':
      return '通知：已允许';
    case 'denied':
      return '通知：已拒绝（请在系统设置中开启）';
    case 'unsupported':
      return '此设备不支持网页通知';
    default:
      return '通知：默认（未授权）';
  }
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

  // Study-plan / reminder state (defaults applied in getSettings).
  // WEEKDAY CONVENTION: studyDays uses JS Date.getDay() indexes (0=Sun..6=Sat).
  const studyDays = Array.isArray(settings.studyDays) ? settings.studyDays : [0, 1, 2, 3, 4, 5, 6];
  const reminderEnabled = settings.reminderEnabled === true;
  const reminderTime =
    typeof settings.reminderTime === 'string' && /^\d{1,2}:\d{2}$/.test(settings.reminderTime)
      ? settings.reminderTime
      : '20:00';

  // Day chips ordered Mon..Sun for display, but each carries its JS getDay()
  // index as the value persisted into studyDays.
  const DAY_CHIPS = [
    { idx: 1, label: '一' },
    { idx: 2, label: '二' },
    { idx: 3, label: '三' },
    { idx: 4, label: '四' },
    { idx: 5, label: '五' },
    { idx: 6, label: '六' },
    { idx: 0, label: '日' },
  ];
  const daysHtml = DAY_CHIPS.map((d) => {
    const on = studyDays.indexOf(d.idx) !== -1;
    return `<button class="reminder-day-chip${on ? ' is-on' : ''}" type="button"
              data-day="${d.idx}" aria-pressed="${on ? 'true' : 'false'}"
              aria-label="周${esc(d.label)}">${esc(d.label)}</button>`;
  }).join('');

  // Notification support + current permission status (default/granted/denied).
  const notifSupported = typeof window !== 'undefined' && 'Notification' in window;
  const notifPermission = notifSupported ? Notification.permission : 'unsupported';
  const permLabel = permissionLabel(notifPermission);

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
      <h2 class="settings-heading">学习计划与提醒</h2>

      <p class="settings-field-label reminder-subhead">每周学习日</p>
      <div class="reminder-days" data-region="reminder-days" role="group" aria-label="每周学习日">
        ${daysHtml}
      </div>
      <p class="settings-hint muted">点击切换学习日（周一到周日）。仅在选中的日子提醒。</p>

      <label class="settings-field settings-field-toggle">
        <span class="settings-field-label">开启到点提醒</span>
        <input class="settings-checkbox" type="checkbox"
               data-field="reminderEnabled" aria-label="开启到点提醒"${reminderEnabled ? ' checked' : ''} />
      </label>

      <label class="settings-field reminder-time-field">
        <span class="settings-field-label">提醒时间</span>
        <input class="settings-input reminder-time-input" type="time"
               value="${esc(reminderTime)}" data-field="reminderTime" aria-label="提醒时间" />
      </label>

      <div class="reminder-notif-row">
        <button class="btn btn-secondary reminder-notif-btn" type="button"
                data-act="request-notify"${notifSupported ? '' : ' disabled'}>允许通知</button>
        <span class="reminder-notif-status muted" data-region="notif-status">${esc(permLabel)}</span>
      </div>

      <p class="settings-hint reminder-ios-note">iOS 限制：网页 App 在<strong>关闭</strong>状态无法定时弹通知。本提醒在你<strong>打开 App</strong> 时（或 App 开着到点时）生效；如需关掉也能准时提醒，请在 iPhone「时钟」或「快捷指令」里另设一个每日闹钟。</p>
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

  // --- Study-plan / reminder controls ------------------------------------
  // Weekly day chips: each click toggles that JS getDay() index in studyDays
  // and persists immediately. studyDays uses 0=Sun..6=Sat.
  const dayChips = root.querySelectorAll('[data-day]');
  dayChips.forEach((chip) => {
    chip.addEventListener('click', async () => {
      const idx = Number(chip.dataset.day);
      if (!Number.isFinite(idx)) return;
      try {
        const current = await getSettings();
        const days = Array.isArray(current.studyDays) ? current.studyDays.slice() : [];
        const at = days.indexOf(idx);
        let next;
        if (at === -1) {
          next = days.concat(idx).sort((a, b) => a - b);
        } else {
          next = days.filter((d) => d !== idx);
        }
        await updateSetting('studyDays', next);
        const on = next.indexOf(idx) !== -1;
        chip.classList.toggle('is-on', on);
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
        feedback(next.length ? '已更新学习日。' : '已清空学习日（不会提醒）。', 'ok');
      } catch (err) {
        console.error('[settings] failed to save studyDays:', err);
        feedback('保存失败，请重试。', 'error');
      }
    });
  });

  // Reminder enable toggle: persist on change.
  const reminderToggle = root.querySelector('[data-field="reminderEnabled"]');
  if (reminderToggle) {
    reminderToggle.addEventListener('change', async () => {
      const value = reminderToggle.checked === true;
      try {
        await updateSetting('reminderEnabled', value);
        feedback(value ? '已开启到点提醒。' : '已关闭到点提醒。', 'ok');
      } catch (err) {
        console.error('[settings] failed to save reminderEnabled:', err);
        feedback('保存失败，请重试。', 'error');
        reminderToggle.checked = !value;
      }
    });
  }

  // Reminder time: persist on change.
  const timeInput = root.querySelector('[data-field="reminderTime"]');
  if (timeInput) {
    timeInput.addEventListener('change', async () => {
      const value = timeInput.value;
      if (!/^\d{1,2}:\d{2}$/.test(value)) {
        feedback('时间格式无效。', 'error');
        return;
      }
      try {
        await updateSetting('reminderTime', value);
        feedback(`已设置提醒时间 ${value}。`, 'ok');
      } catch (err) {
        console.error('[settings] failed to save reminderTime:', err);
        feedback('保存失败，请重试。', 'error');
      }
    });
  }

  // Request notification permission. MUST be triggered by this user gesture.
  const notifBtn = root.querySelector('[data-act="request-notify"]');
  const notifStatus = root.querySelector('[data-region="notif-status"]');
  if (notifBtn) {
    const supported = typeof window !== 'undefined' && 'Notification' in window;
    if (!supported) {
      notifBtn.disabled = true;
    }
    notifBtn.addEventListener('click', async () => {
      if (!supported) return;
      try {
        const result = await Notification.requestPermission();
        if (notifStatus) notifStatus.textContent = permissionLabel(result);
        if (result === 'granted') {
          feedback('已允许通知。', 'ok');
        } else if (result === 'denied') {
          feedback('通知被拒绝，可在系统设置中重新开启。', 'error');
        } else {
          feedback('通知权限未变更。', 'ok');
        }
      } catch (err) {
        console.error('[settings] requestPermission failed:', err);
        feedback('无法请求通知权限。', 'error');
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
