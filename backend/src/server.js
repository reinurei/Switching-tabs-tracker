/**
 * server.js — Form Focus Tracker Express server
 *
 * Mounts:
 *   POST /api/events                    — receive event batches from the extension
 *   GET  /api/dashboard/sessions        — instructor: list sessions
 *   GET  /api/dashboard/sessions/:id    — instructor: session detail + events
 *   GET  /api/dashboard/forms           — instructor: form-level summary
 *   GET  /                              — serve the static instructor dashboard UI
 */

import "dotenv/config";
import express      from "express";
import helmet       from "helmet";
import cors         from "cors";
import rateLimit    from "express-rate-limit";
import path         from "node:path";
import { fileURLToPath } from "node:url";

import eventsRouter    from "./routes/events.js";
import dashboardRouter from "./routes/dashboard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = process.env.PORT ?? 3000;

// ─── Allowed CORS origins ─────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map(o => o.trim());

// ─── App ──────────────────────────────────────────────────────────────────────
const app = express();

// Security headers
app.use(helmet({
  // Relax CSP enough for the inline dashboard styles; tighten for production.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:"],
      connectSrc: ["'self'"]
    }
  }
}));

// CORS — allows the extension's service worker (no origin) and the dashboard.
app.use(cors({
  origin: (origin, cb) => {
    // No origin = direct requests (curl, Postman, service workers on some Chrome versions)
    if (!origin) return cb(null, true);
    // Chrome/Edge extension origins
    if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) return cb(null, true);
    // Configured allowed origins (dashboard, dev)
    if (allowedOrigins.includes(origin)) return cb(null, true);
    // Reject everything else — return null (no CORS headers) rather than throwing
    return cb(null, false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-FFT-Secret", "X-Instructor-Key"],
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

// Explicitly handle OPTIONS pre-flight for all routes.
app.options("*", cors());

// Body parsing — cap at 1 MB to prevent oversized payloads.
app.use(express.json({ limit: "1mb" }));

// Rate limiting — extension endpoint: 60 batches/min per IP.
const extensionLimiter = rateLimit({
  windowMs: 60_000,
  max:      60,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: "Too many requests — slow down." }
});

// Dashboard endpoint: 120 req/min per IP.
const dashboardLimiter = rateLimit({
  windowMs: 60_000,
  max:      120,
  standardHeaders: true,
  legacyHeaders:   false
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use("/api/events",    extensionLimiter, eventsRouter);
app.use("/api/dashboard", dashboardLimiter, dashboardRouter);

// Serve the static instructor dashboard for any non-API GET.
const dashboardDir = path.join(__dirname, "..", "dashboard");
app.use(express.static(dashboardDir));

// SPA fallback — all unmatched GETs serve index.html so client-side routing works.
app.get("*", (_req, res) => {
  res.sendFile(path.join(dashboardDir, "index.html"));
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[FFT] Server running on http://localhost:${PORT}`);
  console.log(`[FFT] Dashboard: http://localhost:${PORT}/`);
  console.log(`[FFT] API:       http://localhost:${PORT}/api/events`);
});

export default app;
