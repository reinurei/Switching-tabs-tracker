/**
 * flagging.js — Session flagging logic (FR3, FR4)
 *
 * Determines whether a session should be marked `flagged` based on
 * configurable thresholds:
 *   - focus_lost_count  > FOCUS_LOST_THRESHOLD      (FR3)
 *   - total_away_ms     > TIME_AWAY_THRESHOLD_MS     (FR4)
 *
 * Thresholds are read from environment variables so instructors can tune
 * them per deployment without touching code.
 */

const FOCUS_LOST_THRESHOLD   = parseInt(process.env.FOCUS_LOST_THRESHOLD   ?? "3",     10);
const TIME_AWAY_THRESHOLD_MS = parseInt(process.env.TIME_AWAY_THRESHOLD_MS ?? "60000", 10);

/**
 * Given the current session summary counters, returns true if the session
 * should be flagged.
 *
 * @param {object} summary
 * @param {number} summary.focus_lost_count   - Number of focus_lost events recorded.
 * @param {number} summary.total_away_ms      - Cumulative milliseconds away from the form.
 * @returns {boolean}
 */
/**
 * Thresholds use >= so that hitting exactly the threshold triggers a flag.
 * e.g. FOCUS_LOST_THRESHOLD=3 means 3 or more switches → flagged.
 */
export function isFlagged({ focus_lost_count, total_away_ms }) {
  return (
    focus_lost_count >= FOCUS_LOST_THRESHOLD ||
    total_away_ms    >= TIME_AWAY_THRESHOLD_MS
  );
}

/**
 * Derives an updated session summary by folding a batch of new events into
 * the existing summary row (or a zero-baseline if the session is new).
 *
 * @param {object|null} existing  - Current sessions row, or null for a new session.
 * @param {object[]}    events    - New events from the current batch.
 * @param {string}      serverNow - ISO-8601 server timestamp for this batch.
 * @returns {object} Updated summary ready to upsert into the sessions table.
 */
export function computeSessionSummary(existing, events, serverNow) {
  // Start from existing counts or zero-baseline.
  let focus_lost_count = existing?.focus_lost_count ?? 0;
  let total_away_ms    = existing?.total_away_ms    ?? 0;
  let paste_count      = existing?.paste_count      ?? 0;

  for (const ev of events) {
    switch (ev.event_type) {
      case "focus_lost":
        focus_lost_count += 1;
        break;
      case "focus_regained":
        // duration_ms is computed by the content script from matched pairs.
        if (typeof ev.duration_ms === "number" && ev.duration_ms > 0) {
          total_away_ms += ev.duration_ms;
        }
        break;
      case "paste":
        paste_count += 1;
        break;
      // session_start carries no counters.
      default:
        break;
    }
  }

  const flagged = isFlagged({ focus_lost_count, total_away_ms }) ? 1 : 0;

  // Derive respondent_id and form_id from the first event that carries them
  // (all events in a batch share the same session, so any event will do).
  const ref           = events[0] ?? {};
  const respondent_id = existing?.respondent_id ?? ref.respondent_id ?? "unknown";
  const form_id       = existing?.form_id       ?? ref.form_id       ?? "unknown";
  const form_title    = ref.form_title           ?? existing?.form_title ?? null;
  const first_seen    = existing?.first_seen     ?? serverNow;

  return {
    session_id:      ref.session_id ?? existing?.session_id,
    respondent_id,
    form_id,
    form_title,
    first_seen,
    last_seen:       serverNow,
    focus_lost_count,
    total_away_ms,
    paste_count,
    flagged
  };
}
