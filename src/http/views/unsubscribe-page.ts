function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#f5f6f8; color:#111827; font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }
  main { width:min(420px,calc(100% - 32px)); padding:32px; background:#fff; border:1px solid #e5e7eb; border-radius:14px; }
  h1 { margin:0 0 8px; font-size:20px; }
  p { margin:0 0 20px; color:#4b5563; }
  p:last-child { margin-bottom:0; }
  button { padding:11px 20px; border:0; border-radius:10px; background:#111827; color:#fff; font:600 14px inherit; cursor:pointer; }
</style>
</head><body><main>${body}</main></body></html>`;
}

export function unsubscribeConfirmPage(token: string): string {
  return page(
    "Unsubscribe",
    `<h1>Unsubscribe from these emails?</h1>
     <p>You won't get any more campaign emails from this sender.</p>
     <form method="post" action="?t=${encodeURIComponent(token)}"><button type="submit">Unsubscribe</button></form>`,
  );
}

export function unsubscribeDonePage(): string {
  return page("Unsubscribed", "<h1>You're unsubscribed</h1><p>You won't get any more campaign emails from this sender.</p>");
}

export function unsubscribeInvalidPage(): string {
  return page("Link not valid", "<h1>This link isn't valid</h1><p>Please use the unsubscribe link in the email you received.</p>");
}
