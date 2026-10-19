function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export function renderOAuthErrorPage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Connection failed · Quantalog</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" type="image/png" href="/favicon.png">
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #0b0e14; color: #e6e9ef;
  }
  .card { width: 100%; max-width: 420px; padding: 28px; border-radius: 16px; background: #12161f; border: 1px solid #232838; }
  h1 { margin: 0 0 8px; font-size: 18px; }
  p { margin: 0; color: #8b93a3; font-size: 14px; line-height: 1.5; }
</style>
</head>
<body>
  <main class="card">
    <h1>This connection can't continue</h1>
    <p>${escapeHtml(message)}</p>
  </main>
</body>
</html>`;
}
