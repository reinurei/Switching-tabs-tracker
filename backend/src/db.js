/**
 * db.js — SQLite database setup and schema
 *
 * Uses the built-in `node:sqlite` module (Node >= 22.5, stable in Node 24).
 * No native compilation or npm package required.
 *
 * Schema
 * ──────
 * events   — immutable append-only event log (one row per captured event)
 * sessions — derived per-session summary (upserted after each batch)
 */

import { DatabaseSync } from "node:sqlite";
import path             from "node:path";
import fs               from "node:fs";

const DB_PATH = process.env.DB_PATH ?? "./data/tracker.db";

// Ensure the parent directory exists before opening the file.
const dbDir = path.dirname(path.resolve(DB_PATH));
fs.mkdirSync(dbDir, { recursive: true });

const db = new DatabaseSync(DB_PATH);

// WAL mode gives better concurrent-read performance.
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// ─── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT    NOT NULL,
    respondent_id TEXT    NOT NULL,
    form_id       TEXT    NOT NULL,
    form_title    TEXT,
    event_type    TEXT    NOT NULL CHECK(event_type IN (
                            'session_start',
                            'focus_lost',
                            'focus_regained',
                            'paste'
                          )),
    client_time   TEXT    NOT NULL,
    server_time   TEXT    NOT NULL,
    duration_ms   INTEGER,
    meta          TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_form    ON events(form_id);

  CREATE TABLE IF NOT EXISTS sessions (
    session_id         TEXT    PRIMARY KEY,
    respondent_id      TEXT    NOT NULL,
    form_id            TEXT    NOT NULL,
    form_title         TEXT,
    first_seen         TEXT    NOT NULL,
    last_seen          TEXT    NOT NULL,
    focus_lost_count   INTEGER NOT NULL DEFAULT 0,
    total_away_ms      INTEGER NOT NULL DEFAULT 0,
    paste_count        INTEGER NOT NULL DEFAULT 0,
    flagged            INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_form    ON sessions(form_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_flagged ON sessions(flagged);
`);

export default db;
