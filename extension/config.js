/**
 * Shared configuration for the Form Focus Tracker extension.
 * Instructors can adjust thresholds here before distributing the extension.
 *
 * IMPORTANT: API_SECRET must also be updated in background.js (DEFAULT_CONFIG)
 * because the service worker cannot read this file directly.
 * Both values must match FFT_API_SECRET in backend/.env.
 */
const CONFIG = {
  // Backend endpoint that receives event batches
  // Use 127.0.0.1 explicitly — Chrome MV3 service workers can silently
  // resolve "localhost" to IPv6 ::1 which may be blocked.
  API_BASE_URL: "http://127.0.0.1:3000",

  // How often (ms) the background worker flushes the local queue to the backend
  FLUSH_INTERVAL_MS: 10_000,

  // Number of focus-lost events that trigger a "flagged" session
  FOCUS_LOST_THRESHOLD: 1,

  // Cumulative time away (ms) that triggers a "flagged" session
  TIME_AWAY_THRESHOLD_MS: 60_000,

  // Whether to capture paste events on form input fields
  CAPTURE_PASTE_EVENTS: true,

  // A shared secret the extension sends so the backend can reject unknown callers.
  // Change this to a long random string before deployment.
  API_SECRET: "b18d4d95e3ca7c854d4761af4d6c70e564ede8f8f426ccd02d53d491ff3f6cd2"
};
