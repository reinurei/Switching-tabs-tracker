/**
 * routes/dashboard.js — Instructor dashboard data API (FR7)
 *
 * All routes require the X-Instructor-Key header (access-control NFR).
 *
 * GET /api/dashboard/sessions              — list all sessions (filterable by form_id)
 * GET /api/dashboard/sessions/:sessionId   — detail for a single session
 * GET /api/dashboard/forms                 — list distinct form IDs with summary stats
 */

import { Router }                from "express";
import db                        from "../db.js";
import { authenticateInstructor } from "../middleware.js";

const router = Router();

// Apply instructor auth to every route in this file.
router.use(authenticateInstructor);

// ─── Prepared statements ──────────────────────────────────────────────────────

const listSessions = db.prepare(`
  SELECT
    session_id,
    respondent_id,
    form_id,
    form_title,
    first_seen,
    last_seen,
    focus_lost_count,
    total_away_ms,
    paste_count,
    flagged
  FROM sessions
  WHERE (:form_id IS NULL OR form_id = :form_id)
  ORDER BY last_seen DESC
  LIMIT  :limit
  OFFSET :offset
`);

const countSessions = db.prepare(`
  SELECT COUNT(*) AS total
  FROM sessions
  WHERE (:form_id IS NULL OR form_id = :form_id)
`);

const getSessionDetail = db.prepare(`
  SELECT * FROM sessions WHERE session_id = ?
`);

const getSessionEvents = db.prepare(`
  SELECT event_type, client_time, server_time, duration_ms, meta
  FROM   events
  WHERE  session_id = ?
  ORDER  BY server_time ASC
`);

const listForms = db.prepare(`
  SELECT
    form_id,
    MAX(form_title)                     AS form_title,
    COUNT(*)                            AS session_count,
    SUM(flagged)                        AS flagged_count,
    AVG(focus_lost_count)               AS avg_focus_lost,
    AVG(total_away_ms)                  AS avg_away_ms,
    MAX(last_seen)                      AS latest_activity
  FROM sessions
  GROUP BY form_id
  ORDER BY latest_activity DESC
`);

const listStudents = db.prepare(`
  SELECT
    respondent_id,
    COUNT(*)                            AS session_count,
    SUM(flagged)                        AS flagged_count,
    SUM(focus_lost_count)               AS total_switches,
    SUM(total_away_ms)                  AS total_away_ms,
    SUM(paste_count)                    AS total_pastes,
    MAX(last_seen)                      AS latest_activity,
    GROUP_CONCAT(DISTINCT form_id)      AS form_ids
  FROM sessions
  WHERE (:form_id IS NULL OR form_id = :form_id)
  GROUP BY respondent_id
  ORDER BY flagged_count DESC, total_switches DESC
`);

// ─── Routes ───────────────────────────────────────────────────────────────────

/** GET /api/dashboard/sessions?form_id=&page=1&pageSize=50 */
router.get("/sessions", (req, res) => {
  const form_id  = req.query.form_id  || null;
  const page     = Math.max(parseInt(req.query.page     ?? "1",  10), 1);
  const pageSize = Math.min(parseInt(req.query.pageSize ?? "50", 10), 200);
  const offset   = (page - 1) * pageSize;

  const rows  = listSessions.all({ form_id, limit: pageSize, offset });
  const total = countSessions.get({ form_id }).total;

  res.json({
    page,
    pageSize,
    total,
    sessions: rows.map(formatSession)
  });
});

/** GET /api/dashboard/sessions/:sessionId */
router.get("/sessions/:sessionId", (req, res) => {
  const session = getSessionDetail.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const events = getSessionEvents.all(req.params.sessionId).map(ev => ({
    event_type:   ev.event_type,
    client_time:  ev.client_time,
    server_time:  ev.server_time,
    duration_ms:  ev.duration_ms,
    meta:         ev.meta ? JSON.parse(ev.meta) : null
  }));

  res.json({ ...formatSession(session), events });
});

/** GET /api/dashboard/forms */
router.get("/forms", (_req, res) => {
  res.json({ forms: listForms.all().map(f => ({
    form_id:         f.form_id,
    form_title:      f.form_title ?? f.form_id,
    session_count:   f.session_count,
    flagged_count:   f.flagged_count,
    avg_focus_lost:  Math.round(f.avg_focus_lost * 10) / 10,
    avg_away_ms:     Math.round(f.avg_away_ms),
    latest_activity: f.latest_activity
  })) });
});

/**
 * GET /api/dashboard/students?form_id=
 * Returns one row per respondent_id, aggregated across all their sessions.
 * Optionally filtered to a single form.
 */
router.get("/students", (req, res) => {
  const form_id = req.query.form_id || null;
  const rows = listStudents.all({ form_id }).map(s => ({
    respondent_id:   s.respondent_id,
    session_count:   s.session_count,
    flagged_count:   s.flagged_count,
    total_switches:  s.total_switches,
    total_away_ms:   s.total_away_ms,
    total_pastes:    s.total_pastes,
    latest_activity: s.latest_activity,
    form_ids:        s.form_ids ? s.form_ids.split(",") : [],
    flagged:         s.flagged_count > 0
  }));
  res.json({ students: rows });
});
// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatSession(row) {
  return {
    session_id:       row.session_id,
    respondent_id:    row.respondent_id,
    form_id:          row.form_id,
    form_title:       row.form_title ?? row.form_id,
    first_seen:       row.first_seen,
    last_seen:        row.last_seen,
    focus_lost_count: row.focus_lost_count,
    total_away_ms:    row.total_away_ms,
    paste_count:      row.paste_count,
    flagged:          row.flagged === 1
  };
}

export default router;
