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
