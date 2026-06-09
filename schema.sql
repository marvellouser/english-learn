-- schema.sql
-- Cloudflare D1 schema for the vocab PWA's CLOUD-PERSISTED progress.
--
-- Only the user's mutable progress lives here. The 7500-word vocabulary stays a
-- STATIC asset (data/seed-words.json) served from the Cloudflare Pages CDN, so it
-- is never queried per-request.
--
-- Apply with Wrangler:
--   wrangler d1 execute vocab --remote --file=./schema.sql
-- (drop --remote to seed the local dev database used by `wrangler pages dev`).

-- Per-word SM-2 review state. A word with NO row here is treated as a brand-new
-- card (the frontend synthesizes its initial state in memory), so first-run does
-- NOT need to insert 7500 rows; a row is written only once a card is studied.
CREATE TABLE IF NOT EXISTS review_state (
  id            TEXT PRIMARY KEY,
  ease          REAL    NOT NULL DEFAULT 2.5,
  "interval"    INTEGER NOT NULL DEFAULT 0,
  reps          INTEGER NOT NULL DEFAULT 0,
  due           TEXT,
  lastReviewed  TEXT,
  introducedOn  TEXT,
  lapses        INTEGER NOT NULL DEFAULT 0
);

-- Speeds up "due today" range scans (string ordering matches calendar order for
-- 'YYYY-MM-DD'). The frontend currently filters in memory, but the index keeps
-- the door open for server-side due queries.
CREATE INDEX IF NOT EXISTS idx_review_due ON review_state(due);

-- Key/value application settings (dailyNewLimit, difficultyMix, streak, ...).
-- `value` holds the JSON-encoded setting value.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
