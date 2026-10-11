/**
 * routes/events.js — POST /api/events
 *
 * Accepts a batch of events from the extension's background service worker,
 * validates them, writes to the events table, and upserts the session summary.
 */

import { Router }                from "express";
import db                        from "../db.js";
import { computeSessionSummary } from "../flagging.js";
import { authenticateExtension } from "../middleware.js";

const router = Router();

// ─── Validation ───────────────────────────────────────────────────────────────

const VALID_EVENT_TYPES = new Set([
  "session_start",
  "focus_lost",
  "focus_regained",
  "paste"
]);

function validateEvent(ev) {
  const errors = [];
  if (typeof ev.session_id    !== "string" || !ev.session_id)    errors.push("missing session_id");
  if (typeof ev.respondent_id !== "string" || !ev.respondent_id) errors.push("missing respondent_id");
  if (typeof ev.form_id       !== "string" || !ev.form_id)       errors.push("missing form_id");
  if (!VALID_EVENT_TYPES.has(ev.event_type))                     errors.push(`invalid event_type: ${ev.event_type}`);
  if (typeof ev.timestamp     !== "string" || !ev.timestamp)     errors.push("missing timestamp");
  return errors;
}

// ─── Prepared statements (reused across requests — never hold transaction state) ──

const stmtInsertEvent = db.prepare(`
  INSERT INTO events
    (session_id, respondent_id, form_id, form_title, event_type, client_time, server_time, duration_ms, meta)
  VALUES
    (@session_id, @respondent_id, @form_id, @form_title, @event_type, @client_time, @server_time, @duration_ms, @meta)
`);

const stmtGetSession = db.prepare(`
  SELECT * FROM sessions WHERE session_id = ?
`);

const stmtUpsertSession = db.prepare(`
  INSERT INTO sessions
    (session_id, respondent_id, form_id, form_title, first_seen, last_seen,
     focus_lost_count, total_away_ms, paste_count, flagged)
  VALUES
    (@session_id, @respondent_id, @form_id, @form_title, @first_seen, @last_seen,
     @focus_lost_count, @total_away_ms, @paste_count, @flagged)
  ON CONFLICT(session_id) DO UPDATE SET
    last_seen         = excluded.last_seen,
    form_title        = COALESCE(excluded.form_title, sessions.form_title),
    focus_lost_count  = excluded.focus_lost_count,
    total_away_ms     = excluded.total_away_ms,
    paste_count       = excluded.paste_count,
    flagged           = excluded.flagged
`);

// ─── Route ────────────────────────────────────────────────────────────────────

router.post("/", authenticateExtension, (req, res) => {
  const { events } = req.body;

  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: "Body must contain a non-empty events array" });
  }

  for (const ev of events) {
    const errs = validateEvent(ev);
    if (errs.length > 0) {
      return res.status(400).json({ error: "Invalid event", details: errs });
    }
  }

  const serverNow = new Date().toISOString();

  // Group by session_id so we upsert each session summary exactly once.
  const bySession = new Map();
  for (const ev of events) {
    if (!bySession.has(ev.session_id)) bySession.set(ev.session_id, []);
    bySession.get(ev.session_id).push(ev);
  }

  // Use db.exec() for transaction control — never shared prepared statements —
  // so a failed request can't leave the connection stuck inside a transaction.
  try {
    db.exec("BEGIN");

    for (const ev of events) {
      stmtInsertEvent.run({
        session_id:    ev.session_id,
        respondent_id: ev.respondent_id,
        form_id:       ev.form_id,
        form_title:    ev.form_title ?? null,
        event_type:    ev.event_type,
        client_time:   ev.timestamp,
        server_time:   serverNow,
        duration_ms:   ev.duration_ms ?? null,
        meta:          ev.meta ? JSON.stringify(ev.meta) : null
      });
    }

    for (const [, sessionEvents] of bySession) {
      const sid      = sessionEvents[0].session_id;
      const existing = stmtGetSession.get(sid) ?? null;
      const summary  = computeSessionSummary(existing, sessionEvents, serverNow);
      stmtUpsertSession.run(summary);
    }

    db.exec("COMMIT");
    res.status(201).json({ received: events.length });

  } catch (err) {
    // Roll back and log the full error so we can see exactly what went wrong.
    try { db.exec("ROLLBACK"); } catch (_) { /* already rolled back */ }
    console.error("[FFT] DB error processing events:", err.message, "\nStack:", err.stack);
    console.error("[FFT] Failing payload:", JSON.stringify(req.body, null, 2));
    res.status(500).json({ error: "Internal server error", detail: err.message });
  }
});

export default router;
