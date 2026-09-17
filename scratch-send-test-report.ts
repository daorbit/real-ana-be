import "dotenv/config";
import { sendReportEmail } from "./src/modules/reports/report-mail.js";

await sendReportEmail({
  to: "goswamiajay526@gmail.com",
  workspaceName: "Quantalog",
  periodLabel: "24 hours to 15 Sept 2026",
  metrics: [
    { label: "Visitors", value: "17", delta: 467 },
    { label: "Pageviews", value: "73", delta: 421 },
    { label: "Sessions", value: "33", delta: 450 },
    { label: "Bounce rate", value: "71%", delta: -27 },
    { label: "Avg. session", value: "22s", delta: -40 },
    { label: "Pages / session", value: "2.2", delta: -4 },
  ],
  seo: [],
  topPages: [
    { label: "/", value: 32 },
    { label: "/docs", value: 6 },
  ],
  unsubscribeUrl: "https://quantalog.daorbit.in/unsubscribe/test",
  isTest: true,
});

console.log("sent");
