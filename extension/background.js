/**
 * background.js — Form Focus Tracker background service worker (Manifest V3)
 *
 * Responsibilities:
 *  1. Receive events from content scripts via chrome.runtime.onMessage.
 *  2. Persist a local event queue in chrome.storage.local (reliability NFR).
 *  3. Flush the queue to the backend on a periodic alarm and on explicit
 *     FLUSH_NOW requests (FR6).
 *  4. Retry on network failure — events are never dropped (reliability NFR).
 *
 * NOTE: Service workers are ephemeral in MV3. All durable state lives in
 * chrome.storage.local, never in module-level variables.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const ALARM_NAME        = "fft_flush_alarm";
const STORAGE_QUEUE_KEY = "fft_event_queue";   // Array<EventObject>
const STORAGE_CFG_KEY   = "fft_config";         // optional runtime config override

// Default config — overridden by values injected at build time via config.js
// (config.js is listed first in content_scripts; for the background worker we
//  embed the same defaults here since service workers can't share globals with
//  content scripts directly).
// DEFAULT_CONFIG values must be kept in sync with extension/config.js.
// The service worker cannot import config.js directly (content scripts and
// service workers run in separate contexts), so the secret is duplicated here.
const DEFAULT_CONFIG = {
  API_BASE_URL:           "http://127.0.0.1:3000",
  FLUSH_INTERVAL_MS:      10_000,
  FOCUS_LOST_THRESHOLD:   1,
  TIME_AWAY_THRESHOLD_MS: 60_000,
  API_SECRET:             "b18d4d95e3ca7c854d4761af4d6c70e564ede8f8f426ccd02d53d491ff3f6cd2"
};

// ─── Config helper ────────────────────────────────────────────────────────────

/** Returns the effective config, merging stored overrides over defaults. */
async function getConfig() {
  const stored = await chrome.storage.local.get(STORAGE_CFG_KEY);
  return { ...DEFAULT_CONFIG, ...(stored[STORAGE_CFG_KEY] ?? {}) };
}

// ─── Queue helpers ────────────────────────────────────────────────────────────

/** Read the current queue from storage. Always returns an array. */
async function readQueue() {
  const data = await chrome.storage.local.get(STORAGE_QUEUE_KEY);
  return Array.isArray(data[STORAGE_QUEUE_KEY]) ? data[STORAGE_QUEUE_KEY] : [];
}

/** Persist the queue back to storage. */
async function writeQueue(queue) {
  await chrome.storage.local.set({ [STORAGE_QUEUE_KEY]: queue });
}

/**
 * Append one or more events to the persistent queue.
 * Uses a read-modify-write pattern; concurrent calls are serialised by
 * chrome.storage's transactional semantics within the same service-worker
 * activation.
 */
async function enqueue(events) {
  const queue = await readQueue();
  queue.push(...events);
  await writeQueue(queue);
}

// ─── Flush logic (FR6, Reliability NFR) ──────────────────────────────────────

/**
 * Attempt to POST all queued events to the backend.
 *
 * On success  → clear those events from the queue.
 * On failure  → leave events in the queue; they'll be retried on the next
 *               alarm tick or the next FLUSH_NOW message.
 */
async function flushQueue() {
  const queue = await readQueue();
  if (queue.length === 0) return;

  const cfg = await getConfig();

  const url = `${cfg.API_BASE_URL}/api/events`;
  console.debug("[FFT] Flushing", queue.length, "event(s) to", url);

  let response;
  try {
    response = await fetch(url, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "X-FFT-Secret":  cfg.API_SECRET
      },
      body: JSON.stringify({ events: queue })
    });
  } catch (networkErr) {
    // Log the full error object so we can see exactly what Chrome is blocking.
    console.warn("[FFT] Flush failed (network error), will retry:", networkErr.message, networkErr);
    return;
  }

  if (!response.ok) {
    console.warn("[FFT] Flush failed (HTTP", response.status, "), will retry.");
    return;
  }

  // Success — clear the events we just sent.
  // Re-read first in case new events arrived during the fetch.
  const currentQueue = await readQueue();
  const sentCount    = queue.length;
  const remaining    = currentQueue.slice(sentCount);
  await writeQueue(remaining);

  console.debug("[FFT] Flushed", sentCount, "event(s) to backend.");
}

// ─── Alarm setup (periodic flush) ────────────────────────────────────────────

/**
 * Ensure the periodic flush alarm is registered.
 * Called on service-worker startup and after config changes.
 */
async function ensureAlarm() {
  const cfg       = await getConfig();
  const periodMin = Math.max(cfg.FLUSH_INTERVAL_MS / 60_000, 1/6); // Chrome minimum: ~10s
  const existing  = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: periodMin });
    console.debug("[FFT] Flush alarm created, period:", periodMin, "min");
  }
}

// ─── Message handler (from content scripts) ───────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "TRACK_EVENT") {
    // Attach a server-received timestamp placeholder; real server time is
    // stamped by the backend on receipt.
    const event = {
      ...message.payload,
      queued_at: new Date().toISOString()
    };
    enqueue([event]).then(() => sendResponse({ ok: true }));
    return true; // keep message channel open for async response
  }

  if (message.type === "FLUSH_NOW") {
    flushQueue().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "UPDATE_CONFIG") {
    // Allow the options page (or tests) to update config at runtime.
    chrome.storage.local.set({ [STORAGE_CFG_KEY]: message.config })
      .then(() => ensureAlarm())
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ─── Alarm listener ───────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    flushQueue();
  }
});

// ─── Service-worker lifecycle ─────────────────────────────────────────────────

// chrome.runtime.onInstalled fires on install and update.
chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  console.debug("[FFT] Extension installed/updated.");
});

// Re-register the alarm every time the service worker wakes up, because
// alarms registered without onInstalled can vanish when the worker is
// terminated and restarted.
ensureAlarm();
