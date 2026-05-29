// reminder.js
// Weekly study-plan reminder engine for the offline vocab PWA. Native ES module,
// no dependencies, relative imports only.
//
// DESIGN CONSTRAINT (honor it):
//   This is a serverless static PWA. True background push when the app is CLOSED
//   is NOT possible on iOS without a push server. So this engine implements the
//   FEASIBLE version:
//     1. A reliable IN-APP BANNER shown when the app is opened (or while open and
//        the reminder time arrives) on a study day when today's task isn't done.
//     2. PLUS an optional system Notification (Notification API) when permission
//        is granted AND the app is running (foreground). On iOS the system
//        notification only fires while the installed PWA is actually running.
//        We do NOT claim background delivery.
//
// WEEKDAY CONVENTION:
//   studyDays is an array of integers using JavaScript's native Date.getDay():
//     0 = 周日 (Sunday), 1 = 周一 (Monday), ... 6 = 周六 (Saturday).
//   Default is all 7 days [0,1,2,3,4,5,6].
//
// All work is defensive: nothing here throws into the app shell. Browser
// capabilities (Notification, serviceWorker) are feature-detected per use.

import {
  today,
  getAllWords,
  getAllReviewState,
  getSetting,
  putSetting,
} from './db.js';
import { buildDailyQueue } from './srs.js';

// Setting keys (kept in sync with settings.js SETTING_KEYS / getSettings).
const KEY_STUDY_DAYS = 'studyDays';
const KEY_REMINDER_ENABLED = 'reminderEnabled';
const KEY_REMINDER_TIME = 'reminderTime';
const KEY_REMINDER_LAST_NOTIFIED = 'reminderLastNotified';

// Defaults mirrored from settings.js. Keep these aligned.
const DEFAULT_STUDY_DAYS = [0, 1, 2, 3, 4, 5, 6];
const DEFAULT_REMINDER_ENABLED = false;
const DEFAULT_REMINDER_TIME = '20:00';

// Single armed timer handle so re-arming never stacks duplicate timeouts.
let armedTimer = null;

// Track whether listeners were already attached (initReminders is idempotent).
let listenersAttached = false;

// ---------------------------------------------------------------------------
// Pure helpers (exported for clarity / future testing)
// ---------------------------------------------------------------------------

/**
 * Whether the given date falls on one of the configured study days.
 * Uses Date.getDay() (0=Sun..6=Sat). A non-array / empty studyDays means no
 * study days configured -> false.
 * @param {Date} date
 * @param {Array<number>} studyDays - weekday indexes 0..6
 * @returns {boolean}
 */
export function isStudyDay(date, studyDays) {
  if (!Array.isArray(studyDays) || studyDays.length === 0) return false;
  const dow = (date instanceof Date ? date : new Date()).getDay();
  return studyDays.indexOf(dow) !== -1;
}

/**
 * Whether the current wall-clock time on `nowDate` has reached the 'HH:MM'
 * reminder time (today, local). Compares minutes-since-midnight so it is
 * timezone-safe (uses the Date's own local getters).
 * @param {Date} nowDate
 * @param {string} hhmm - 'HH:MM' 24h
 * @returns {boolean}
 */
export function timeReached(nowDate, hhmm) {
  const target = parseHHMM(hhmm);
  if (target === null) return false;
  const now = nowDate instanceof Date ? nowDate : new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return nowMinutes >= target;
}

/**
 * Parse 'HH:MM' to minutes-since-midnight, or null when malformed.
 * @param {string} hhmm
 * @returns {number|null}
 */
function parseHHMM(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Escape for safe HTML insertion. Mirrors the project-wide esc() pattern used in
 * the view modules.
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

// ---------------------------------------------------------------------------
// Banner (in-app reminder)
// ---------------------------------------------------------------------------

// Per-session dismissal flag. A user ✕ hides the banner until the next
// checkReminder() (next visibilitychange/focus/app open) or a re-arm fires.
let bannerDismissed = false;

/**
 * Show (or refresh) the in-app reminder banner with the pending count. The
 * banner lives outside #app (fixed near the top) so it survives view swaps and
 * never overlaps the fixed bottom nav. Idempotent: builds once, then updates.
 * @param {number} pending
 */
function showBanner(pending) {
  if (typeof document === 'undefined' || !document.body) return;
  if (bannerDismissed) return;

  let banner = document.getElementById('reminder-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'reminder-banner';
    banner.className = 'reminder-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    banner.innerHTML = `
      <span class="reminder-banner-text" data-region="reminder-text"></span>
      <button class="reminder-banner-go" type="button" data-act="reminder-go">去学习</button>
      <button class="reminder-banner-close" type="button" data-act="reminder-dismiss" aria-label="关闭提醒">✕</button>
    `;
    document.body.appendChild(banner);

    const goBtn = banner.querySelector('[data-act="reminder-go"]');
    if (goBtn) {
      goBtn.addEventListener('click', () => {
        hideBanner();
        navigateToStudy();
      });
    }
    const closeBtn = banner.querySelector('[data-act="reminder-dismiss"]');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        bannerDismissed = true;
        hideBanner();
      });
    }
  }

  const textEl = banner.querySelector('[data-region="reminder-text"]');
  if (textEl) {
    textEl.textContent = `今天还有 ${pending} 个单词没学，别断签 📚`;
    // Keep esc referenced for safe dynamic insertion patterns; textContent above
    // is already safe, esc() guards any future innerHTML use.
    void esc;
  }
  banner.hidden = false;
}

/**
 * Hide/remove the in-app banner if present. Safe to call when absent.
 */
function hideBanner() {
  if (typeof document === 'undefined') return;
  const banner = document.getElementById('reminder-banner');
  if (banner) banner.hidden = true;
}

/**
 * Navigate to the study route without a hard dependency on app.js (avoids a
 * circular import: app.js imports reminder.js). Falls back to setting the hash.
 */
function navigateToStudy() {
  try {
    if (typeof location !== 'undefined') {
      location.hash = '#/study';
    }
  } catch (err) {
    console.error('[reminder] navigate to study failed:', err);
  }
}

// ---------------------------------------------------------------------------
// System notification (foreground only; no background-push claim)
// ---------------------------------------------------------------------------

/**
 * Fire a one-per-day system notification when supported and permission granted.
 * Prefers the service-worker registration's showNotification (better behaviour
 * on installed PWAs), falling back to the Notification constructor. Fully
 * wrapped so a failure never escapes.
 * @param {number} pending
 * @returns {Promise<void>}
 */
async function fireSystemNotification(pending) {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  const title = '背单词提醒';
  const options = {
    body: `今天还有 ${pending} 个单词要学`,
    icon: './icons/icon-192.png',
    tag: 'vocab-daily-reminder',
  };

  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.serviceWorker &&
      typeof navigator.serviceWorker.getRegistration === 'function'
    ) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && typeof reg.showNotification === 'function') {
        await reg.showNotification(title, options);
        return;
      }
    }
    // Fallback: direct Notification (works in foreground on most browsers).
    new Notification(title, options);
  } catch (err) {
    console.warn('[reminder] system notification failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

/**
 * Load the reminder-related settings with defaults.
 * @returns {Promise<{studyDays:Array<number>, reminderEnabled:boolean, reminderTime:string, reminderLastNotified:(string|null)}>}
 */
async function loadReminderSettings() {
  const [studyDays, reminderEnabled, reminderTime, reminderLastNotified] =
    await Promise.all([
      getSetting(KEY_STUDY_DAYS, DEFAULT_STUDY_DAYS),
      getSetting(KEY_REMINDER_ENABLED, DEFAULT_REMINDER_ENABLED),
      getSetting(KEY_REMINDER_TIME, DEFAULT_REMINDER_TIME),
      getSetting(KEY_REMINDER_LAST_NOTIFIED, null),
    ]);
  return {
    studyDays: Array.isArray(studyDays) ? studyDays : DEFAULT_STUDY_DAYS,
    reminderEnabled: reminderEnabled === true,
    reminderTime: typeof reminderTime === 'string' ? reminderTime : DEFAULT_REMINDER_TIME,
    reminderLastNotified:
      typeof reminderLastNotified === 'string' ? reminderLastNotified : null,
  };
}

/**
 * Evaluate the reminder conditions and (when due) surface the banner + optional
 * system notification. Defensive: never throws into the app shell.
 *
 * Logic:
 *   1. Load settings.
 *   2. !reminderEnabled            -> ensure no banner, return.
 *   3. today not a study day       -> ensure no banner, return.
 *   4. now < reminderTime          -> re-arm timer, return.
 *   5. pending === 0 (done)        -> clear banner, return.
 *   6. pending > 0 && time reached -> show banner; fire one-per-day notification.
 *
 * @returns {Promise<void>}
 */
export async function checkReminder() {
  try {
    const now = new Date();
    const settings = await loadReminderSettings();

    if (!settings.reminderEnabled) {
      hideBanner();
      clearTimer();
      return;
    }

    if (!isStudyDay(now, settings.studyDays)) {
      hideBanner();
      // Still re-arm so that if the app is left open across midnight into a
      // study day, the timer (re-armed below) keeps the engine alive on focus.
      armTimer(settings.reminderTime);
      return;
    }

    if (!timeReached(now, settings.reminderTime)) {
      // Before the reminder time today: no banner yet, but arm a timer so a
      // left-open app fires exactly at reminderTime.
      hideBanner();
      armTimer(settings.reminderTime);
      return;
    }

    // Time reached on a study day: compute today's pending workload.
    const pending = await computePending(settings);

    if (pending === 0) {
      // Today already done / nothing due: no nudge needed.
      hideBanner();
      return;
    }

    // Pending work + time reached -> always show the in-app banner.
    // A new check after the user dismissed earlier in the session keeps it
    // dismissed for the session; visibilitychange/focus reset is handled by the
    // app-open path (initReminders resets bannerDismissed).
    showBanner(pending);

    // Additionally fire a system notification at most once per calendar day.
    const todayISO = today(now);
    if (settings.reminderLastNotified !== todayISO) {
      await fireSystemNotification(pending);
      try {
        await putSetting(KEY_REMINDER_LAST_NOTIFIED, todayISO);
      } catch (err) {
        console.warn('[reminder] failed to persist reminderLastNotified:', err);
      }
    }
  } catch (err) {
    // Absolutely never let the reminder engine break the app shell.
    console.error('[reminder] checkReminder failed:', err);
  }
}

/**
 * Compute how many cards are pending in today's queue (reviews + capped new).
 * Reuses srs.buildDailyQueue; its length is the unfinished-task count.
 * @param {{studyDays:Array<number>}} _settings - reserved, not used here
 * @returns {Promise<number>}
 */
async function computePending() {
  const [words, reviewStates] = await Promise.all([
    getAllWords(),
    getAllReviewState(),
  ]);
  // Daily caps come from the same settings store used elsewhere; pull the
  // relevant ones so the queue length matches the home dashboard.
  const [dailyNewLimit, dailyReviewLimit] = await Promise.all([
    getSetting('dailyNewLimit', undefined),
    getSetting('dailyReviewLimit', undefined),
  ]);
  const queue = buildDailyQueue({
    words,
    reviewStates,
    settings: { dailyNewLimit, dailyReviewLimit },
    todayISO: today(),
  });
  return queue.length;
}

// ---------------------------------------------------------------------------
// Timer arming
// ---------------------------------------------------------------------------

/**
 * Clear any previously armed timer.
 */
function clearTimer() {
  if (armedTimer !== null) {
    clearTimeout(armedTimer);
    armedTimer = null;
  }
}

/**
 * Arm a setTimeout to fire checkReminder() at today's reminderTime, but only if
 * that time is still in the future today. Re-arming first clears the previous
 * timer so duplicates never stack. A left-open app thus triggers at the time.
 * @param {string} hhmm - 'HH:MM'
 */
function armTimer(hhmm) {
  if (typeof window === 'undefined') return;
  clearTimer();

  const target = parseHHMM(hhmm);
  if (target === null) return;

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (target <= nowMinutes) {
    // Time already passed today: nothing to arm (checkReminder handles "now").
    return;
  }

  // Milliseconds until the target minute today (account for seconds/millis so we
  // land just inside the target minute).
  const targetDate = new Date(now);
  targetDate.setHours(Math.floor(target / 60), target % 60, 0, 0);
  let delay = targetDate.getTime() - now.getTime();
  // setTimeout max is ~24.8 days; our delay is always < 24h so this is safe.
  if (delay < 0) delay = 0;

  armedTimer = setTimeout(() => {
    armedTimer = null;
    // Re-allow the banner at the armed time even if dismissed earlier today.
    bannerDismissed = false;
    checkReminder();
  }, delay);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Initialize the reminder engine. Called from app bootstrap AFTER the DB is
 * ready. Runs an immediate check, re-checks when the page becomes visible or
 * the window regains focus (treating each as an "app open"), and arms a timer
 * for today's reminderTime. Idempotent: safe to call once at startup.
 */
export function initReminders() {
  // Immediate check on startup.
  checkReminder();

  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (listenersAttached) return;
  listenersAttached = true;

  // Becoming visible again = a fresh "app open": reset the per-session dismissal
  // so the banner can re-appear if still warranted.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      bannerDismissed = false;
      checkReminder();
    }
  });

  window.addEventListener('focus', () => {
    bannerDismissed = false;
    checkReminder();
  });
}
