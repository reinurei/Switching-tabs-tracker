/**
 * middleware.js — Shared Express middleware
 *
 * authenticateExtension  — validates the X-FFT-Secret header on /api routes
 * authenticateInstructor — validates the X-Instructor-Key header on /dashboard routes
 */

const FFT_API_SECRET  = process.env.FFT_API_SECRET  ?? "CHANGE_ME_BEFORE_DEPLOY";
const INSTRUCTOR_KEYS = new Set(
  (process.env.INSTRUCTOR_KEYS ?? "")
    .split(",")
    .map(k => k.trim())
    .filter(Boolean)
);

/**
 * Middleware that checks the X-FFT-Secret header.
 * Rejects requests from anything other than the extension.
 */
export function authenticateExtension(req, res, next) {
  const secret = req.headers["x-fft-secret"];
  if (!secret || secret !== FFT_API_SECRET) {
    return res.status(401).json({ error: "Unauthorised" });
  }
  next();
}

/**
 * Middleware that checks the X-Instructor-Key header.
 * Restricts dashboard data API to instructors (Access-control NFR).
 */
export function authenticateInstructor(req, res, next) {
  const key = req.headers["x-instructor-key"];
  if (!key || !INSTRUCTOR_KEYS.has(key)) {
    return res.status(401).json({ error: "Unauthorised — instructor key required" });
  }
  next();
}
