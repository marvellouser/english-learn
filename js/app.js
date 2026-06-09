// app.js
// Application entry point. Native ES module, no bundler.
//
// Responsibilities:
//   1. Register the service worker (offline support).
//   2. Provide a minimal hash-based router + mount skeleton.
//   3. Expose a bootstrap() startup hook that later tasks extend
//      (DB open + first-run seed in TASK-002, view wiring in TASK-005/006).
//
// EXTENSION POINTS for later tasks are marked with `// [EXTENSION POINT]`.

import { BASE_PATH, DEFAULT_DAILY_NEW_LIMIT, DEFAULT_DAILY_REVIEW_LIMIT } from './config.js';
import { openDB, getSetting, putSetting } from './db.js';
import { initReminders } from './reminder.js';
import makeStudyView from './views/study.js';
import makeHomeView from './views/home.js';
import makeSettingsView from './views/settings-view.js';
import makeVocabTestView from './views/vocab-test.js';
import makeWordListView from './views/word-list.js';
import makeMistakesView from './views/mistakes.js';

// ---------------------------------------------------------------------------
// Service worker registration
// ---------------------------------------------------------------------------

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    return;
  }
  window.addEventListener('load', () => {
    // Relative path so the SW scope matches the deployment base path.
    navigator.serviceWorker
      .register('./service-worker.js')
      .catch((err) => console.error('[app] SW registration failed:', err));
  });
}

// ---------------------------------------------------------------------------
// Mount + router skeleton
// ---------------------------------------------------------------------------

const appEl = () => document.getElementById('app');

/**
 * Render a view into #app.
 * @param {(root: HTMLElement) => void | string} viewFn
 *   Either a function that receives the root element and populates it, or a
 *   string of HTML to inject. Later view modules will pass render functions.
 */
export function mount(viewFn) {
  const root = appEl();
  if (!root) return;
  root.innerHTML = '';
  if (typeof viewFn === 'function') {
    viewFn(root);
  } else if (typeof viewFn === 'string') {
    root.innerHTML = viewFn;
  }
}

// Route table. Real views register here.
//
// A route value is either a view function (mount-compatible) or a factory
// receiving the remaining hash segments (params) and returning a view function.
// 'study' uses the factory form so an optional tag filter can flow in from the
// URL: '#/study'            -> all words
//      '#/study/programming' -> tagFilter = 'programming'.
//
// 'home' is the default landing view (empty hash -> home). 'settings' renders
// the settings/backup view. Both come from their dedicated view modules.
//
// 'study' segments 'mistakes' and 'extra' are special, NOT tag filters:
//   '#/study/mistakes' -> 错题本 review mode (source='mistakes').
//   '#/study/extra'    -> "继续学习更多新词" mode (source='extra'), studying unseen
//                         new words beyond the daily cap.
// Any other segment is treated as a tag filter (e.g. '#/study/programming').
const routes = {
  '': makeHomeView(),
  home: makeHomeView(),
  settings: makeSettingsView(),
  study: (params) =>
    params[0] === 'mistakes'
      ? makeStudyView({ source: 'mistakes' })
      : params[0] === 'extra'
        ? makeStudyView({ source: 'extra' })
        : makeStudyView({ tagFilter: params[0] || null }),
  // '#/words'            -> filter = 'all'
  // '#/words/learned'    -> filter = 'learned' (also new/due/programming or any tag)
  words: (params) => makeWordListView({ filter: params[0] || 'all' }),
  // '#/mistakes' -> the 错题本 (mistake notebook) view.
  mistakes: makeMistakesView(),
  'vocab-test': makeVocabTestView(),
};

/**
 * Navigate to a named route by updating the location hash.
 * The hashchange handler performs the actual mount.
 * @param {string} route
 */
export function navigate(route) {
  const target = `#/${route}`;
  if (location.hash === target) {
    renderCurrentRoute();
  } else {
    location.hash = target;
  }
}

function currentRouteSegments() {
  // Hash format: "#/route/param/...". Strip the leading "#/" and split.
  const raw = location.hash.replace(/^#\/?/, '');
  return raw.split('/').filter((s) => s.length > 0);
}

function renderCurrentRoute() {
  const segments = currentRouteSegments();
  const name = segments[0] || '';
  const params = segments.slice(1);
  const entry = routes[name] || routes[''];
  // Factory routes take the remaining segments and return a view function;
  // plain view functions are mounted directly.
  const view = isRouteFactory(name) ? entry(params) : entry;
  mount(view);
  // Keep the persistent bottom nav's active tab in sync with the route. The
  // home view re-runs its render on every (re)mount, so returning from study
  // shows refreshed dashboard stats automatically.
  renderBottomNav(name);
}

// Routes whose value is a factory(params) -> viewFn rather than a direct view.
function isRouteFactory(name) {
  return name === 'study' || name === 'words';
}

// ---------------------------------------------------------------------------
// Persistent bottom navigation
// ---------------------------------------------------------------------------

// Tabs shown in the persistent bottom nav. `match` decides which tab is active
// for the current route name; the study tab also activates the home tab's
// neighbour conceptually but keeps its own highlight.
const NAV_TABS = [
  { route: 'home', label: '首页', icon: '🏠', match: (name) => name === '' || name === 'home' },
  { route: 'study', label: '学习', icon: '📖', match: (name) => name === 'study' },
  { route: 'settings', label: '设置', icon: '⚙️', match: (name) => name === 'settings' },
];

/**
 * Render (or update) the persistent bottom nav, highlighting the active tab.
 * The bar lives outside #app so it survives view swaps. Idempotent: builds the
 * element once, then only refreshes the active state.
 * @param {string} activeName - current route name ('' | 'home' | 'study' | 'settings')
 */
function renderBottomNav(activeName) {
  let bar = document.getElementById('bottom-nav');
  if (!bar) {
    bar = document.createElement('nav');
    bar.id = 'bottom-nav';
    bar.className = 'bottom-nav';
    bar.innerHTML = NAV_TABS.map(
      (t) =>
        `<button class="bottom-nav-item" type="button" data-route="${t.route}">
          <span class="bottom-nav-icon">${t.icon}</span>
          <span class="bottom-nav-label">${t.label}</span>
        </button>`
    ).join('');
    document.body.appendChild(bar);
    bar.querySelectorAll('[data-route]').forEach((el) => {
      el.addEventListener('click', () => navigate(el.dataset.route));
    });
  }

  const items = bar.querySelectorAll('.bottom-nav-item');
  NAV_TABS.forEach((t, i) => {
    const el = items[i];
    if (!el) return;
    el.classList.toggle('is-active', t.match(activeName));
  });
}

// ---------------------------------------------------------------------------
// First-run initialization
// ---------------------------------------------------------------------------

/**
 * Load data + initialize first-run defaults.
 *
 * The vocabulary is now a STATIC asset (data/seed-words.json) loaded straight
 * into memory by db.js — there is no per-word seeding step and no DATA_VERSION
 * re-import, because every launch reads the latest static words from the CDN.
 *
 * The only persisted setup is writing the baseline settings to Cloudflare D1 the
 * very first time the deployment is used (when no 'seeded' marker exists yet).
 * Existing user-changed settings are never clobbered. Failures are logged but do
 * not crash the app shell.
 */
async function initData() {
  try {
    // Loads the static vocabulary + cloud progress (review states + settings)
    // into memory so later views render against ready data.
    await openDB();

    const firstRun = (await getSetting('seeded', false)) !== true;
    if (firstRun) {
      await putSetting('dailyNewLimit', DEFAULT_DAILY_NEW_LIMIT);
      await putSetting('dailyReviewLimit', DEFAULT_DAILY_REVIEW_LIMIT);
      await putSetting('streak', 0);
      // Pronunciation is OFF by default (phonetic-only); opt-in via settings.
      await putSetting('ttsEnabled', false);
      // Written last so an interrupted first run retries the defaults next launch.
      await putSetting('seeded', true);
    }
  } catch (err) {
    console.error('[app] data init failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Application startup hook.
 * Later tasks extend this to:
 *   - open IndexedDB (TASK-002)  [done]
 *   - run first-run seeding from ./data/seed-words.json (TASK-002)  [done]
 *   - register additional routes/views (TASK-005/006)
 */
export async function bootstrap() {
  // [EXTENSION POINT] open DB + first-run seed (TASK-002).
  // Runs before the home view renders so data is ready for later views.
  await initData();

  // Study-plan reminders: start AFTER the DB/seed is ready so checkReminder can
  // build today's queue. Defensive internally; never throws into the shell.
  initReminders();

  // Home/study/settings routes are registered statically in the `routes` table
  // above; the persistent bottom nav is rendered on each route change.

  window.addEventListener('hashchange', renderCurrentRoute);
  renderCurrentRoute();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

registerServiceWorker();
bootstrap().catch((err) => console.error('[app] bootstrap failed:', err));

// Expose BASE_PATH on the window for quick debugging in dev tools (harmless).
window.__VOCAB_BASE_PATH__ = BASE_PATH;
