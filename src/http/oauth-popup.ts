import type { Response } from "express";

export function studioBase(): string {
  return (process.env.STUDIO_BASE_URL ?? "https://studio-quantalog.daorbit.in").replace(/\/+$/, "");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderOAuthPopup(
  res: Response,
  options: {
    source: string;
    title: string;
    status: string;
    reason?: string;
    successTitle: string;
    failureTitle: string;
    message: string;
    diagnostic?: string;
    fallbackUrl: string;
  },
): void {
  const ok = options.status === "connected";
  const { diagnostic } = options;

  res.type("html").send(`<!doctype html>
<meta charset="utf-8">
<title>${escapeHtml(options.title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<body style="margin:0;font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;
             display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#1c1e21">
  <div style="max-width:340px;padding:28px;text-align:center">
    ${ok
      ? `<p style="font-size:15px;font-weight:600;margin:0">${escapeHtml(options.successTitle)}</p>
         <p style="color:#65676b;margin:8px 0 0">You can close this window.</p>`
      : `<p style="font-size:15px;font-weight:600;margin:0">${escapeHtml(options.failureTitle)}</p>
         <p style="color:#65676b;margin:8px 0 16px">${escapeHtml(options.message)}</p>
         ${diagnostic
           ? `<p style="color:#8a8d91;font-size:12px;margin:0 0 16px;word-break:break-word">
                ${escapeHtml(diagnostic)}
              </p>`
           : ""}
         <button onclick="window.close()"
           style="border:1px solid #ccd0d5;background:#fff;border-radius:6px;
                  padding:7px 16px;font:inherit;cursor:pointer">Close</button>`}
  </div>
</body>
<script>
  (function () {
    var msg = {
      source: ${JSON.stringify(options.source)},
      status: ${JSON.stringify(options.status)},
      reason: ${JSON.stringify(options.reason ?? "")}
    };
    if (window.opener && window.opener !== window) {
      window.opener.postMessage(msg, ${JSON.stringify(studioBase())});
      if (${JSON.stringify(ok)}) window.close();
    } else {
      window.location.replace(${JSON.stringify(options.fallbackUrl)});
    }
  })();
</script>`);
}
