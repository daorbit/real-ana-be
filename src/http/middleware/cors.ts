import cors from "cors";

 
const dashboardOrigins = [
  "http://localhost:5173",
  "https://real-ana-fe.vercel.app",
  "https://studio-quantalog.daorbit.in",
];

export const dashboardCors = cors({
  origin: (origin, cb) => {
    if (!origin || dashboardOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`Origin not allowed: ${origin}`));
  },
});

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
