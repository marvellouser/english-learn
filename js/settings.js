// settings.js
// Settings + local backup helpers. Sits between the views and db.js, keeping
// the testable/pure-ish logic (payload assembly, streak derivation) separable
// from the DOM. Native ES module, no dependencies.
//
// Responsibilities:
//   - getSettings()/updateSetting()  thin typed wrappers over db settings.
//   - resetProgress()                rewrite every reviewState back to "new".
//   - exportData()                   assemble a single JSON backup + download.
//   - importData()                   parse a backup and restore via db hooks.
//   - computeStreak()                PURE: derive the streak from study dates.
//
// The backup payload covers all three stores so a single .json file is a full
// single-device snapshot.

import {
  today,
  getAllWords,
  getAllReviewState,
  putReviewState,
  importWords,
  bulkPutWords,
  getSetting,
  putSetting,
} from './db.js';
import { INITIAL_EASE } from './srs.js';
import { DEFAULT_DAILY_NEW_LIMIT, DEFAULT_DAILY_REVIEW_LIMIT } from './config.js';

// Backup envelope identity. Imports are validated against this app tag.
const BACKUP_APP = 'vocab-pwa';
const BACKUP_VERSION = 1;

// Settings keys owned by the app (used by export/import to round-trip them).
const SETTING_KEYS = [
  'dailyNewLimit',
  'dailyReviewLimit',
  'streak',
  'seeded',
  'ttsEnabled',
  'lastVocabEstimate',
];

// Pronunciation (TTS) is OFF by default: phonetic-only cards. Opt-in via settings.
const DEFAULT_TTS_ENABLED = false;

// ---------------------------------------------------------------------------
// Settings wrappers
// ---------------------------------------------------------------------------

/**
 * Read the user-facing settings with sensible defaults.
 * @returns {Promise<{ dailyNewLimit: number, dailyReviewLimit: (number|null), ttsEnabled: boolean }>}
 */
export async function getSettings() {
  const [dailyNewLimit, dailyReviewLimit, ttsEnabled] = await Promise.all([
    getSetting('dailyNewLimit', DEFAULT_DAILY_NEW_LIMIT),
    getSetting('dailyReviewLimit', DEFAULT_DAILY_REVIEW_LIMIT),
    getSetting('ttsEnabled', DEFAULT_TTS_ENABLED),
  ]);
  return { dailyNewLimit, dailyReviewLimit, ttsEnabled: ttsEnabled === true };
}

/**
 * Persist a single setting immediately.
 * @param {string} key
 * @param {*} value
 * @returns {Promise<void>}
 */
export function updateSetting(key, value) {
  return putSetting(key, value);
}

// ---------------------------------------------------------------------------
// Reset progress
// ---------------------------------------------------------------------------

/**
 * Build the fresh "new card" review state. Mirrors db.js initialReviewState():
 * due today, never reviewed, default ease, not-yet-introduced.
 * @param {string} id
 * @returns {{id:string, ease:number, interval:number, reps:number, due:string, lastReviewed:null, introducedOn:null}}
 */
function freshState(id) {
  return {
    id,
    ease: INITIAL_EASE,
    interval: 0,
    reps: 0,
    due: today(),
    lastReviewed: null,
    introducedOn: null,
  };
}

/**
 * Reset all learning progress: every reviewState row returns to a brand-new
 * state (so all words become new again) and the streak resets to 0. Word data
 * is preserved. Confirm-gating is the caller's (UI) responsibility.
 * @returns {Promise<{ reset: number }>} number of review states reset
 */
export async function resetProgress() {
  const states = await getAllReviewState();
  for (const s of states) {
    if (s && typeof s.id === 'string') {
      await putReviewState(freshState(s.id));
    }
  }
  await putSetting('streak', 0);
  return { reset: states.length };
}

// ---------------------------------------------------------------------------
// Streak (PURE)
// ---------------------------------------------------------------------------

/**
 * Derive the current study streak from review history. Counts consecutive
 * calendar days (ending today, or yesterday if today has no study yet) on which
 * at least one card was reviewed. Pure: no DOM/db, deterministic given inputs.
 *
 * @param {Array<{lastReviewed:(string|null)}>} reviewStates - all review states
 * @param {string} todayISO - 'YYYY-MM-DD' for "today"
 * @returns {number} consecutive-day streak (0 when no qualifying history)
 */
export function computeStreak(reviewStates, todayISO) {
  // Distinct study dates (drop nulls), as a fast lookup set.
  const studied = new Set();
  for (const s of reviewStates || []) {
    if (s && typeof s.lastReviewed === 'string' && s.lastReviewed) {
      studied.add(s.lastReviewed.slice(0, 10));
    }
  }
  if (studied.size === 0) return 0;

  const todayKey = String(todayISO).slice(0, 10);
  const yesterdayKey = shiftDay(todayKey, -1);

  // Anchor the streak at today if studied today, else at yesterday (grace day);
  // if neither, the streak is broken -> 0.
  let cursor;
  if (studied.has(todayKey)) cursor = todayKey;
  else if (studied.has(yesterdayKey)) cursor = yesterdayKey;
  else return 0;

  let streak = 0;
  while (studied.has(cursor)) {
    streak += 1;
    cursor = shiftDay(cursor, -1);
  }
  return streak;
}

/**
 * Shift a 'YYYY-MM-DD' string by n days (UTC arithmetic, no tz drift).
 * Local helper to keep computeStreak pure without importing srs.addDays
 * (avoids coupling, identical math).
 * @param {string} iso
 * @param {number} n
 * @returns {string}
 */
function shiftDay(iso, n) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d) + n * 86400000;
  const next = new Date(ms);
  const yy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(next.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Assemble the full backup payload from the database. Separated from the
 * download so the payload shape stays testable.
 * @returns {Promise<{ meta: object, words: Array, reviewState: Array, settings: object }>}
 */
export async function buildBackupPayload() {
  const [words, reviewState] = await Promise.all([
    getAllWords(),
    getAllReviewState(),
  ]);

  const settings = {};
  for (const key of SETTING_KEYS) {
    const value = await getSetting(key, undefined);
    if (value !== undefined) settings[key] = value;
  }

  return {
    meta: {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
    },
    words,
    reviewState,
    settings,
  };
}

/**
 * Build the backup payload, serialize to JSON, and trigger a browser download
 * of vocab-backup-YYYY-MM-DD.json. Returns the payload for inspection/testing.
 * @returns {Promise<object>} the exported payload
 */
export async function exportData() {
  const payload = await buildBackupPayload();
  const json = JSON.stringify(payload, null, 2);
  triggerDownload(json, `vocab-backup-${today()}.json`);
  return payload;
}

/**
 * Trigger a client-side file download of a text blob via a temporary anchor.
 * No-op-safe in non-DOM contexts (e.g. unit tests) where document is absent.
 * @param {string} text
 * @param {string} filename
 */
function triggerDownload(text, filename) {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Release the object URL on the next tick (after the click is processed).
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Parse a backup (File/Blob or JSON text) and restore it into the database.
 * Overwrite-restore semantics: words are upserted (via importWords so missing
 * review states are seeded), then stored reviewState rows overwrite per id, and
 * settings overwrite per key.
 *
 * @param {File|Blob|string} fileOrText - a backup file/blob or raw JSON text
 * @returns {Promise<{ words:number, reviewState:number, settings:number, warnings:string[] }>}
 */
export async function importData(fileOrText) {
  const text = await readAsText(fileOrText);

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    throw new Error('备份文件不是有效的 JSON。');
  }

  const warnings = [];

  // Validate the envelope; tolerate a missing meta with a warning.
  if (!payload || typeof payload !== 'object') {
    throw new Error('备份内容无效。');
  }
  if (!payload.meta || typeof payload.meta !== 'object') {
    warnings.push('备份缺少 meta 信息，按宽松模式导入。');
  } else if (payload.meta.app !== BACKUP_APP) {
    throw new Error(`无法识别的备份来源 (meta.app=${payload.meta.app}).`);
  }

  const words = Array.isArray(payload.words) ? payload.words : [];
  const reviewState = Array.isArray(payload.reviewState) ? payload.reviewState : [];
  const settings =
    payload.settings && typeof payload.settings === 'object' ? payload.settings : {};

  // 1. Restore words. importWords seeds initial review states for words that
  //    have none; reviewState restore below then overwrites with backed-up
  //    progress. Fall back to bulkPutWords if the shape is non-standard.
  let wordCount = 0;
  if (words.length > 0) {
    try {
      const res = await importWords(words, { source: 'import' });
      wordCount = res.imported;
    } catch (err) {
      console.warn('[settings] importWords failed, falling back to bulkPutWords:', err);
      wordCount = await bulkPutWords(words);
      warnings.push('单词以宽松模式写入。');
    }
  }

  // 2. Restore review states (overwrite per id), preserving backed-up progress.
  let stateCount = 0;
  for (const s of reviewState) {
    if (s && typeof s.id === 'string') {
      await putReviewState(s);
      stateCount += 1;
    }
  }

  // 3. Restore settings (overwrite per key).
  let settingCount = 0;
  for (const key of Object.keys(settings)) {
    await putSetting(key, settings[key]);
    settingCount += 1;
  }

  return {
    words: wordCount,
    reviewState: stateCount,
    settings: settingCount,
    warnings,
  };
}

/**
 * Read a File/Blob as text, or pass through an already-string input.
 * @param {File|Blob|string} fileOrText
 * @returns {Promise<string>}
 */
function readAsText(fileOrText) {
  if (typeof fileOrText === 'string') return Promise.resolve(fileOrText);

  // Prefer Blob.text() when available (modern browsers); fall back to FileReader.
  if (fileOrText && typeof fileOrText.text === 'function') {
    return fileOrText.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败。'));
    reader.readAsText(fileOrText);
  });
}
