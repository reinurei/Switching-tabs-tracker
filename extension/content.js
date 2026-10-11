/**
 * content.js — Form Focus Tracker content script
 *
 * Injected into every page matching https://docs.google.com/forms/*
 *
 * Only active on /viewform pages (the actual form).
 * Does NOT run on /formResponse (the confirmation page after submit).
 */

// ─── Guard: only run on the actual form, not the confirmation page ────────────
// Google Forms URLs:
//   Active form:    /forms/d/<id>/viewform
//   Confirmation:   /forms/d/<id>/formResponse   ← skip this
if (!location.pathname.endsWith("/viewform")) {
  // Nothing to do on the confirmation or any other sub-page.
  throw new Error("[FFT] Not a viewform page — skipping.");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function now() {
  return new Date().toISOString();
}

function getFormId() {
  const match = location.pathname.match(/\/forms\/d\/([^/]+)/);
  return match ? match[1] : "unknown";
}

function getFormTitle() {
  const selectors = [
    ".freebirdFormviewerViewHeaderTitle",
    ".o8QhHb",
    "[data-item-id] .M7eMe",
    "head title"
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const text = el?.textContent?.trim();
    if (text && text.length > 0 && text !== "Google Forms") return text;
  }
  return getFormId();
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Session state ────────────────────────────────────────────────────────────

const SESSION_ID = crypto.randomUUID();
const FORM_ID    = getFormId();
const FORM_TITLE = getFormTitle();
let   RESPONDENT_NAME = "";

// Set to true after consent is given — prevents focus events firing
// while the consent banner is open (e.g. Alt-Tab to read instructions).
let monitoringActive = false;

function sendEvent(eventObj) {
  chrome.runtime.sendMessage({ type: "TRACK_EVENT", payload: eventObj });
}

// ─── Consent banner ───────────────────────────────────────────────────────────

function injectConsentBanner() {
  if (document.getElementById("fft-consent-banner")) return;

  const banner = document.createElement("div");
  banner.id = "fft-consent-banner";
  banner.setAttribute("role", "alertdialog");
  banner.setAttribute("aria-modal", "true");
  banner.setAttribute("aria-labelledby", "fft-consent-title");
  banner.setAttribute("aria-describedby", "fft-consent-desc");
  banner.style.cssText = `
    position:fixed;inset:0;z-index:2147483647;
    background:rgba(0,0,0,0.65);
    display:flex;align-items:center;justify-content:center;
    font-family:Google Sans,Roboto,sans-serif;
  `;

  const formLabel = FORM_TITLE !== FORM_ID
    ? `<p style="margin:0 0 16px;font-size:13px;color:#5f6368;">
         📄 Form: <strong>${escapeHtml(FORM_TITLE)}</strong>
       </p>`
    : "";

  banner.innerHTML = `
    <div style="background:#fff;border-radius:12px;max-width:480px;width:90%;
                padding:32px;box-shadow:0 8px 32px rgba(0,0,0,0.24);">
      <h2 id="fft-consent-title" style="margin:0 0 12px;font-size:18px;color:#202124;">
        📋 Activity Monitoring Notice
      </h2>
      ${formLabel}
      <p id="fft-consent-desc" style="margin:0 0 16px;font-size:14px;color:#3c4043;line-height:1.6;">
        This form is proctored for academic integrity. A browser extension will record:
      </p>
      <ul style="margin:0 0 16px;padding-left:20px;font-size:14px;color:#3c4043;line-height:1.8;">
        <li>How many times you switch away from this tab or window</li>
        <li>How long you spend away from this tab</li>
        <li>Whether you paste text into any answer field</li>
      </ul>
      <p style="margin:0 0 20px;font-size:13px;color:#5f6368;line-height:1.5;">
        <strong>No screenshots, URLs, or content from other apps are recorded.</strong>
        If you do not consent, please close this tab and contact your instructor.
      </p>
      <label for="fft-name-input"
             style="display:block;font-size:13px;font-weight:600;color:#202124;margin-bottom:6px;">
        Your full name <span style="color:#d93025">*</span>
      </label>
      <input id="fft-name-input" type="text" placeholder="e.g. Jane Smith"
             autocomplete="name"
             style="width:100%;padding:10px 12px;border:1px solid #bdc1c6;
                    border-radius:6px;font-size:14px;margin-bottom:6px;
                    box-sizing:border-box;outline:none;" />
      <div id="fft-name-error"
           style="color:#d93025;font-size:12px;min-height:16px;margin-bottom:12px;"></div>
      <button id="fft-consent-accept"
              style="background:#1a73e8;color:#fff;border:none;border-radius:6px;
                     padding:10px 24px;font-size:14px;cursor:pointer;width:100%;">
        I understand — start the form
      </button>
    </div>
  `;

  document.body.appendChild(banner);
  document.getElementById("fft-name-input").focus();

  document.getElementById("fft-name-input")
    .addEventListener("keydown", e => { if (e.key === "Enter") acceptConsent(); });
  document.getElementById("fft-consent-accept")
    .addEventListener("click", acceptConsent);

  function acceptConsent() {
    const nameInput = document.getElementById("fft-name-input");
    const name = nameInput.value.trim();
    if (!name) {
      document.getElementById("fft-name-error").textContent =
        "Please enter your full name to continue.";
      nameInput.style.borderColor = "#d93025";
      nameInput.focus();
      return;
    }

    RESPONDENT_NAME = name.replace(/[^\x20-\x7E\u00C0-\u024F]/g, "").slice(0, 80);
    banner.remove();

    sendEvent({
      session_id:    SESSION_ID,
      respondent_id: RESPONDENT_NAME,
      form_id:       FORM_ID,
      form_title:    FORM_TITLE,
      event_type:    "session_start",
      timestamp:     now(),
      duration_ms:   null
    });

    startMonitoring();
  }
}

// ─── Focus / visibility monitoring ───────────────────────────────────────────

let focusLostAt = null;

function onFocusLost() {
  if (!monitoringActive) return;      // ignore events before consent
  if (focusLostAt !== null) return;   // already tracking
  focusLostAt = Date.now();
  sendEvent({
    session_id:    SESSION_ID,
    respondent_id: RESPONDENT_NAME,
    form_id:       FORM_ID,
    form_title:    FORM_TITLE,
    event_type:    "focus_lost",
    timestamp:     new Date(focusLostAt).toISOString(),
    duration_ms:   null
  });
}

function onFocusRegained() {
  if (!monitoringActive) return;
  if (focusLostAt === null) return;
  const duration_ms = Date.now() - focusLostAt;
  focusLostAt = null;
  sendEvent({
    session_id:    SESSION_ID,
    respondent_id: RESPONDENT_NAME,
    form_id:       FORM_ID,
    form_title:    FORM_TITLE,
    event_type:    "focus_regained",
    timestamp:     now(),
    duration_ms
  });
}

// ─── Paste monitoring ─────────────────────────────────────────────────────────

function attachPasteListener() {
  const formRoot =
    document.querySelector("form, .freebirdFormviewerViewFormCard") || document.body;
  formRoot.addEventListener("paste", (e) => {
    if (!monitoringActive) return;
    const t = e.target;
    if (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA" && !t.isContentEditable) return;

    const fieldLabel =
      t.getAttribute("aria-label") ||
      t.closest("[data-params]")
       ?.querySelector(".freebirdFormviewerComponentsQuestionBaseTitle")
       ?.textContent?.trim()?.slice(0, 80) ||
      "unknown_field";

    sendEvent({
      session_id:    SESSION_ID,
      respondent_id: RESPONDENT_NAME,
      form_id:       FORM_ID,
      form_title:    FORM_TITLE,
      event_type:    "paste",
      timestamp:     now(),
      duration_ms:   null,
      meta:          { field_label: fieldLabel }
    });
  }, true);
}

// ─── Submit / unload flush ────────────────────────────────────────────────────

function requestFlush() {
  chrome.runtime.sendMessage({ type: "FLUSH_NOW", session_id: SESSION_ID });
}

// ─── Start monitoring (called after consent is accepted) ──────────────────────

function startMonitoring() {
  monitoringActive = true;

  // visibilitychange is the primary signal — fires on tab switch,
  // minimize, and app switch (Alt-Tab / Cmd-Tab).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") onFocusLost();
    else onFocusRegained();
  });

  // window blur/focus is a secondary fallback only.
  // We deduplicate with focusLostAt so double-firing is harmless.
  window.addEventListener("blur",  onFocusLost);
  window.addEventListener("focus", onFocusRegained);

  if (typeof CONFIG !== "undefined" && CONFIG.CAPTURE_PASTE_EVENTS) {
    attachPasteListener();
  }

  // Flush on submit and on tab/window close.
  document.addEventListener("submit", requestFlush, true);
  window.addEventListener("pagehide", requestFlush);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", injectConsentBanner);
} else {
  injectConsentBanner();
}
