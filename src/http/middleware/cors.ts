import cors from "cors";

/**
 * The origins the dashboard is served from.
 *
 * Its own module rather than a constant in `app.ts` so that a router needing
 * this middleware for only some of its routes can import it without importing
 * the app — which would be a cycle, since `app.ts` imports every router.
 */
const dashboardOrigins = [
  "http://localhost:5173",
  "https://real-ana-fe.vercel.app",
  "https://studio-quantalog.daorbit.in",
];

/** Dashboard CORS: restricted to our own frontend. */
export const dashboardCors = cors({
  origin: (origin, cb) => {
    if (!origin || dashboardOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`Origin not allowed: ${origin}`));
  },
});
