import cors from "cors";

 
const dashboardOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "https://real-ana-fe.vercel.app",
  "https://studio-quantalog.daorbit.in",
];

export const dashboardCors = cors({
  origin: (origin, cb) => {
    if (!origin || dashboardOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`Origin not allowed: ${origin}`));
  },
});

// sendBeacon always sends credentials, and a credentialed request rejects a
// wildcard origin, so the collector reflects the caller's origin instead.
export const beaconCors = cors({ origin: true, credentials: true });

function sameHost(origin: string, host: string | undefined): boolean {
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export const orbitCors = cors((req, cb) => {
  const origin = req.headers.origin;
  const allowed =
    !origin ||
    dashboardOrigins.includes(origin) ||
    origin.startsWith("chrome-extension://") ||
    sameHost(origin, req.headers.host);
  if (allowed) return cb(null, { origin: true });
  cb(new Error(`Origin not allowed: ${origin}`));
});
