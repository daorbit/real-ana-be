import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DETAIL,
  areaOf,
  cronFailureAlert,
  fingerprint,
  firstAppFrame,
  opsAlertLogLine,
  parseRelayedAlert,
  presentFields,
  renderOpsAlert,
  routeShape,
  serverErrorAlert,
  serverResponseAlert,
  statusLabel,
  workspaceOf,
  type OpsAlert,
} from "./ops-alert-format.js";

const WID = "66f1a2b3c4d5e6f708192a3b";
const UID = "65a2b3c4d5e6f708192a3b4c";
const FOOTER = { environment: "production", sentAt: new Date("2026-10-24T10:12:03.000Z") };

describe("routeShape", () => {
  test("replaces object ids and numbers with :id", () => {
    assert.equal(routeShape(`/api/workspaces/${WID}/reports/42`), "/api/workspaces/:id/reports/:id");
  });

  test("drops the query string", () => {
    assert.equal(routeShape("/api/sites/123/stats?range=24h&site=all"), "/api/sites/:id/stats");
  });

  test("keeps named segments and route params untouched", () => {
    assert.equal(routeShape("/api/workspaces/:wid/reviews/sync"), "/api/workspaces/:wid/reviews/sync");
  });
});

describe("areaOf", () => {
  test("names the feature under a workspace", () => {
    assert.equal(areaOf(`/api/workspaces/${WID}/reviews/sync`), "workspaces · reviews");
  });

  test("names internal routes with their service and action", () => {
    assert.equal(areaOf(`/api/internal/forms/telegram/${WID}`), "internal · forms · telegram");
    assert.equal(areaOf("/api/internal/forms"), "internal · forms");
  });

  test("uses the first segment for everything else", () => {
    assert.equal(areaOf("/api/billing/apps/notes/purchase?x=1"), "billing");
    assert.equal(areaOf("/oauth/token"), "oauth");
    assert.equal(areaOf("/api/workspaces"), "workspaces");
  });

  test("falls back to root for an empty path", () => {
    assert.equal(areaOf("/"), "root");
  });
});

describe("workspaceOf", () => {
  test("reads the workspace id from the path", () => {
    assert.equal(workspaceOf(`/api/workspaces/${WID}/alerts`), WID);
  });

  test("returns undefined when the path has no workspace", () => {
    assert.equal(workspaceOf("/api/billing/plans"), undefined);
    assert.equal(workspaceOf("/api/workspaces/not-an-id/alerts"), undefined);
  });
});

describe("statusLabel", () => {
  test("adds the standard reason phrase", () => {
    assert.equal(statusLabel(500), "500 Internal Server Error");
    assert.equal(statusLabel(502), "502 Bad Gateway");
    assert.equal(statusLabel(503), "503 Service Unavailable");
  });

  test("shows the bare number for unknown codes", () => {
    assert.equal(statusLabel(599), "599");
  });
});

describe("firstAppFrame", () => {
  test("skips node internals and dependencies and shortens the app path", () => {
    const stack = [
      "Error: boom",
      "    at Module.load (node:internal/modules/cjs/loader:1:1)",
      "    at Layer.handle (D:/app/node_modules/express/lib/router/layer.js:95:5)",
      "    at syncReviews (file:///D:/app/src/modules/reviews/sync.service.ts:42:11)",
      "    at next (file:///D:/app/src/http/routes/reviews.ts:10:3)",
    ].join("\n");
    assert.equal(firstAppFrame(stack), "syncReviews (src/modules/reviews/sync.service.ts:42:11)");
  });

  test("handles compiled output", () => {
    const stack = "Error: boom\n    at run (file:///var/task/dist/modules/reports/report-runner.js:7:2)";
    assert.equal(firstAppFrame(stack), "run (dist/modules/reports/report-runner.js:7:2)");
  });

  test("returns undefined without a usable frame", () => {
    assert.equal(firstAppFrame(undefined), undefined);
    assert.equal(firstAppFrame("Error: boom\n    at x (D:/app/node_modules/y.js:1:1)"), undefined);
  });
});

describe("presentFields", () => {
  test("drops missing and empty values and keeps zero", () => {
    assert.deepEqual(
      presentFields([
        ["Area", "billing"],
        ["User", undefined],
        ["Code", ""],
        ["Took", 0],
      ]),
      [
        { label: "Area", value: "billing" },
        { label: "Took", value: "0" },
      ],
    );
  });
});

describe("fingerprint", () => {
  const base: OpsAlert = { title: "Request failed · 502 Bad Gateway", where: "GET /x", detail: `quota for ${WID} hit 120 times` };

  test("treats the same failure with different ids and counts as one", () => {
    const other = { ...base, detail: "quota for 0123456789abcdef01234567 hit 7 times" };
    assert.equal(fingerprint(base), fingerprint(other));
  });

  test("keeps different titles, endpoints and services apart", () => {
    assert.notEqual(fingerprint(base), fingerprint({ ...base, title: "Cron job failed" }));
    assert.notEqual(fingerprint(base), fingerprint({ ...base, where: "GET /y" }));
    assert.notEqual(fingerprint(base), fingerprint({ ...base, service: "Forms API" }));
  });

  test("defaults the service to the Quantalog API", () => {
    assert.equal(fingerprint(base), fingerprint({ ...base, service: "Quantalog API" }));
  });

  test("stays within 240 characters", () => {
    assert.ok(fingerprint({ ...base, detail: "x".repeat(5000), where: "y".repeat(500) }).length <= 240);
  });
});

describe("renderOpsAlert", () => {
  const alert: OpsAlert = {
    service: "Forms API",
    title: "Request failed · 502 Bad Gateway",
    where: "POST /api/workspaces/:id/forms/<x>",
    detail: "Upstream said <b>no</b> & left",
    fields: [{ label: "Path", value: "/api/a?b=<c>" }],
  };

  test("lays out service, endpoint, issue, fields and footer", () => {
    assert.equal(
      renderOpsAlert(alert, FOOTER),
      [
        "<b>Forms API · Request failed · 502 Bad Gateway</b>",
        "",
        "<b>Where:</b> <code>POST /api/workspaces/:id/forms/&lt;x&gt;</code>",
        "<b>Issue:</b> Upstream said &lt;b&gt;no&lt;/b&gt; &amp; left",
        "<b>Path:</b> <code>/api/a?b=&lt;c&gt;</code>",
        "",
        "<i>production · 2026-10-24T10:12:03.000Z</i>",
      ].join("\n"),
    );
  });

  test("defaults the service name and cuts a long issue", () => {
    const text = renderOpsAlert({ title: "T", where: "W", detail: "d".repeat(MAX_DETAIL + 500) }, FOOTER);
    assert.ok(text.startsWith("<b>Quantalog API · T</b>"));
    assert.ok(text.includes(`<b>Issue:</b> ${"d".repeat(MAX_DETAIL)}\n`));
  });
});

describe("opsAlertLogLine", () => {
  test("puts everything on one searchable line", () => {
    assert.equal(
      opsAlertLogLine({ title: "Cron job failed", where: "cron · reports", detail: "boom", fields: [{ label: "Job", value: "reports" }] }),
      "[ops-alert] Quantalog API | Cron job failed | cron · reports | boom | Job=reports",
    );
  });

  test("leaves out the field section when there are none", () => {
    assert.equal(opsAlertLogLine({ service: "Watchdog", title: "T", where: "W", detail: "D" }), "[ops-alert] Watchdog | T | W | D");
  });
});

describe("serverResponseAlert", () => {
  test("describes a failed request with its route pattern and context", () => {
    const alert = serverResponseAlert(502, {
      method: "POST",
      path: `/api/workspaces/${WID}/reviews/sync?force=1`,
      route: `/api/workspaces/${WID}/reviews/sync`,
      message: "Google returned 403",
      userId: UID,
      durationMs: 1840,
      requestId: "bom1::abc12",
    });
    assert.deepEqual(alert, {
      title: "Request failed · 502 Bad Gateway",
      where: "POST /api/workspaces/:id/reviews/sync",
      detail: "Google returned 403",
      fields: [
        { label: "Area", value: "workspaces · reviews" },
        { label: "Path", value: `/api/workspaces/${WID}/reviews/sync` },
        { label: "Workspace", value: WID },
        { label: "User", value: UID },
        { label: "Took", value: "1840 ms" },
        { label: "Vercel request", value: "bom1::abc12" },
      ],
    });
  });

  test("falls back to the path shape and a default issue", () => {
    const alert = serverResponseAlert(503, { method: "GET", path: "/api/billing/plans" });
    assert.equal(alert.where, "GET /api/billing/plans");
    assert.equal(alert.detail, "The endpoint answered with an error status but no error message.");
    assert.deepEqual(alert.fields, [
      { label: "Area", value: "billing" },
      { label: "Path", value: "/api/billing/plans" },
    ]);
  });
});

describe("serverErrorAlert", () => {
  test("reports the error name, message, code and where it was thrown", () => {
    const error = Object.assign(new TypeError("Cannot read properties of undefined"), {
      code: "E_BROKEN",
      stack: "TypeError: x\n    at build (file:///D:/app/src/modules/reports/digest.ts:12:4)",
    });
    const alert = serverErrorAlert(error, { method: "GET", path: `/api/workspaces/${WID}/reports`, userId: UID });
    assert.equal(alert.title, "Unhandled error · 500 Internal Server Error");
    assert.equal(alert.where, "GET /api/workspaces/:id/reports");
    assert.equal(alert.detail, "TypeError: Cannot read properties of undefined");
    assert.deepEqual(alert.fields, [
      { label: "Area", value: "workspaces · reports" },
      { label: "Path", value: `/api/workspaces/${WID}/reports` },
      { label: "Code", value: "E_BROKEN" },
      { label: "Thrown at", value: "build (src/modules/reports/digest.ts:12:4)" },
      { label: "Workspace", value: WID },
      { label: "User", value: UID },
    ]);
  });

  test("copes with values that are not errors", () => {
    const alert = serverErrorAlert("plain failure", { method: "PROCESS", path: "unhandledRejection" });
    assert.equal(alert.detail, "Error: plain failure");
    assert.equal(alert.where, "PROCESS unhandledRejection");
  });
});

describe("cronFailureAlert", () => {
  test("names the job", () => {
    assert.deepEqual(cronFailureAlert("reports", "Mongo timed out"), {
      title: "Cron job failed",
      where: "cron · reports",
      detail: "Mongo timed out",
      fields: [{ label: "Job", value: "reports" }],
    });
  });
});

describe("parseRelayedAlert", () => {
  test("accepts a complete alert and keeps its fields", () => {
    const alert = parseRelayedAlert(
      { title: "Service down", where: "Forms API", detail: "HTTP 503", fields: [{ label: "Checked URL", value: "https://f/api/health" }] },
      "Watchdog",
    );
    assert.deepEqual(alert, {
      service: "Watchdog",
      title: "Service down",
      where: "Forms API",
      detail: "HTTP 503",
      fields: [{ label: "Checked URL", value: "https://f/api/health" }],
    });
  });

  test("lets the sender name its own service", () => {
    assert.equal(parseRelayedAlert({ service: "Forms API", title: "T", where: "W", detail: "D" }, "Watchdog")?.service, "Forms API");
  });

  test("rejects alerts missing a title, where or detail", () => {
    assert.equal(parseRelayedAlert({ where: "W", detail: "D" }, "S"), null);
    assert.equal(parseRelayedAlert({ title: "T", detail: "D" }, "S"), null);
    assert.equal(parseRelayedAlert({ title: "T", where: "W", detail: "   " }, "S"), null);
    assert.equal(parseRelayedAlert(null, "S"), null);
    assert.equal(parseRelayedAlert("text", "S"), null);
  });

  test("trims and bounds every text value", () => {
    const alert = parseRelayedAlert({ title: ` ${"t".repeat(200)} `, where: "w".repeat(500), detail: "d".repeat(5000) }, "S");
    assert.equal(alert?.title.length, 80);
    assert.equal(alert?.where.length, 200);
    assert.equal(alert?.detail.length, MAX_DETAIL);
  });

  test("keeps only well-formed fields, at most twelve, each bounded", () => {
    const fields = [
      { label: "ok", value: "yes" },
      { label: "", value: "no label" },
      { label: "no value" },
      { label: 5, value: "bad label" },
      "nonsense",
      null,
      { label: "l".repeat(100), value: "v".repeat(1000) },
      ...Array.from({ length: 20 }, (_, i) => ({ label: `f${i}`, value: "x" })),
    ];
    const parsed = parseRelayedAlert({ title: "T", where: "W", detail: "D", fields }, "S")?.fields ?? [];
    assert.equal(parsed[0].label, "ok");
    assert.equal(parsed[1].label.length, 40);
    assert.equal(parsed[1].value.length, 400);
    assert.ok(parsed.length <= 12);
    assert.ok(parsed.every((f) => f.label && f.value));
  });

  test("leaves fields out when none are usable", () => {
    assert.equal(parseRelayedAlert({ title: "T", where: "W", detail: "D", fields: "x" }, "S")?.fields, undefined);
    assert.equal(parseRelayedAlert({ title: "T", where: "W", detail: "D", fields: [{}] }, "S")?.fields, undefined);
  });
});
