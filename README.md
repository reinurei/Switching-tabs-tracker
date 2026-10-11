# Form Focus Tracker

A Chrome/Edge extension (Manifest V3) paired with a small Node/Express backend that monitors focus events on Google Forms for academic-integrity proctoring.

> **Consent first.** A blocking modal notifies respondents that tab-switch count, time away, and paste events are recorded *before* monitoring begins. No screenshots, URLs, clipboard text, or destination-app identity are ever collected.

---

## Repository layout

```
TrackerExtension/
├── extension/          # Chrome/Edge MV3 extension
│   ├── manifest.json
│   ├── config.js       # ← edit thresholds & secrets here
│   ├── content.js      # injected into Google Forms
│   └── background.js   # service worker / queue / flush
│
└── backend/            # Node 18 + Express API + dashboard
    ├── .env.example    # ← copy to .env and fill in secrets
    ├── package.json
    ├── dashboard/
    │   └── index.html  # instructor dashboard (no build step)
    └── src/
        ├── server.js
        ├── db.js
        ├── flagging.js
        ├── middleware.js
        └── routes/
            ├── events.js
            └── dashboard.js
```

---

## Quick-start

### 1 — Backend

**Prerequisites:** Node ≥ 18

```bash
cd backend
npm install
cp .env.example .env
```

Edit `.env`:

| Variable | Purpose |
|---|---|
| `PORT` | Port the server listens on (default `3000`) |
| `FFT_API_SECRET` | Shared secret between extension and backend — **change this** |
| `INSTRUCTOR_KEYS` | Comma-separated keys that unlock the dashboard |
| `DB_PATH` | Path to the SQLite file (created automatically) |
| `FOCUS_LOST_THRESHOLD` | Switch count that flags a session (default `3`) |
| `TIME_AWAY_THRESHOLD_MS` | Cumulative ms away that flags a session (default `60000`) |
| `CORS_ORIGINS` | Allowed origins for CORS (use your domain in production) |

Generate secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Start the server:

```bash
npm start          # production
npm run dev        # auto-restart on file changes (Node 18 --watch)
```

The server starts at `http://localhost:3000`.  
The instructor dashboard is at `http://localhost:3000/`.

---

### 2 — Extension

**Step 1 — set the shared secret and API URL**

Open `extension/config.js` and set:

```js
API_BASE_URL: "https://your-backend-domain.com",   // or http://localhost:3000 for dev
API_SECRET:   "the-same-value-as-FFT_API_SECRET",
```

You can also tune the thresholds here — they are mirrored in the backend `.env` and the backend value wins for flagging decisions.

**Step 2 — load the extension in Chrome / Edge**

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (toggle, top-right).
3. Click **Load unpacked** and select the `extension/` folder.
4. The extension icon appears in the toolbar — it is active on any `docs.google.com/forms/*` URL.

**Step 3 — distribute to respondents**

Send respondents the following instructions (see also the [Respondent install guide](#respondent-install-guide) below).

---

## How it works

### Extension flow

```
Google Form tab
  └─ content.js
       ├─ Shows consent modal (blocks form until dismissed)
       ├─ visibilitychange → focus_lost / focus_regained events
       ├─ window blur/focus → same (fallback)
       ├─ paste on form inputs → paste event (field label only, never content)
       └─ chrome.runtime.sendMessage → background.js
            ├─ Appends event to chrome.storage.local queue
            ├─ chrome.alarms fires every ~10 s → flushQueue()
            │    POST /api/events  { events: [...] }
            │    ✓ success → removes sent events from queue
            │    ✗ failure → leaves events; retried next alarm tick
            └─ FLUSH_NOW on form submit / pagehide
```

### Backend flow

```
POST /api/events
  ├─ Validates X-FFT-Secret header
  ├─ Validates event shape
  ├─ Inserts rows into events table
  └─ Upserts sessions row (focus_lost_count, total_away_ms, paste_count, flagged)

GET /api/dashboard/*
  ├─ Validates X-Instructor-Key header
  ├─ /sessions          → paginated session list (filterable by form_id)
  ├─ /sessions/:id      → session detail + full event log
  └─ /forms             → per-form aggregates
```

### Flagging rules (FR3, FR4)

A session is marked **flagged** when either:

- `focus_lost_count > FOCUS_LOST_THRESHOLD` (default **3** switches), or  
- `total_away_ms > TIME_AWAY_THRESHOLD_MS` (default **60 000 ms = 1 minute** away).

Both thresholds are configurable in the backend `.env` without touching code.

---

## Instructor dashboard

Open `http://localhost:3000/` in your browser.

1. Enter an **instructor API key** (from `INSTRUCTOR_KEYS` in `.env`).
2. The **Sessions** tab lists every monitored form-fill with switch count, time away, paste count, and flagged status. Click **Detail** for the full event log.
3. The **Forms** tab summarises all tracked forms with aggregate stats.

---

## Respondent install guide

> Copy and share this section with your students/respondents.

---

### Installing the Form Focus Tracker extension

This form is monitored for academic integrity. You must install the Form Focus Tracker extension **before** opening the form link.

**Step 1** — Download the extension

Your instructor will provide a `.zip` of the extension folder (or a direct link). Unzip it to a permanent location on your computer (do not delete it while the course is running).

**Step 2** — Load it in Chrome or Edge

1. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
2. Turn on **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Navigate to and select the unzipped `extension` folder.
5. You should see "Form Focus Tracker" appear in the list.

**Step 3** — Open the form

Open the form link your instructor gave you. A notice will appear explaining what is monitored. Click **"I understand — start the form"** to proceed.

**What is recorded:**
- How many times you switch away from the form tab or window
- How long you spend away
- Whether you paste text into any answer field

**What is NOT recorded:**
- Screenshots or video
- The URLs or content of any other tab or app
- The text you paste (only that a paste happened)

If you do not consent, close the tab and contact your instructor.

---

## Privacy notes (NFR)

- **No screenshots or screen capture** — the extension uses the browser's Page Visibility API and `window blur/focus` events only.
- **No destination tracking** — browsers do not expose what the user switched to, by design. Only the fact of switching (and duration) is recorded.
- **No clipboard content** — paste events record only the form field's `aria-label`, never the pasted text.
- **Data minimisation** — only timestamps, durations, and counts leave the browser. No keystrokes, mouse movements, or form-answer content are collected.

---

## Security checklist before going to production

- [ ] Replace `CHANGE_ME_BEFORE_DEPLOY` with a real random secret in both `extension/config.js` and the backend `.env`.
- [ ] Set `INSTRUCTOR_KEYS` to long random strings; treat them like passwords.
- [ ] Put the backend behind HTTPS (nginx reverse proxy, or deploy to a platform like Railway/Fly.io).
- [ ] Set `CORS_ORIGINS` to your exact frontend origin.
- [ ] Add the production backend URL to `host_permissions` in `manifest.json` before packaging the extension.
- [ ] Remove `http://localhost:3000/*` from `host_permissions` in the production build.
- [ ] Consider rate-limiting instructor key attempts at the reverse proxy level.

---

## Development tips

**Reload the extension after editing JS files:**  
`chrome://extensions` → click the refresh icon on the extension card.

**Inspect the background service worker:**  
`chrome://extensions` → "Inspect views: service worker" link.

**Clear the local event queue:**  
In the service worker DevTools console:
```js
chrome.storage.local.remove("fft_event_queue")
```

**Manually trigger a flush:**
```js
chrome.runtime.sendMessage({ type: "FLUSH_NOW" })
```

**Watch backend logs:**
```bash
npm run dev
```

---

## Stretch goal — native desktop companion

The browser cannot report *which* application the respondent switched to — that requires OS-level window APIs (Win32 `GetForegroundWindow`, macOS `NSWorkspace`, Linux `_NET_ACTIVE_WINDOW`). If destination identification is required, a separate native messaging host would be needed. That is a materially larger and more invasive build; scope it independently.
