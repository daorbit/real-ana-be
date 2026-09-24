function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

export function renderStatusPage(uptimeSeconds: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Quantalog API</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: radial-gradient(60% 50% at 50% 0%, rgba(5,150,105,0.14), transparent 70%), #0b0e14;
    color: #e6e9ef;
  }
  .card {
    width: 100%; max-width: 440px; padding: 32px; border-radius: 16px;
    background: #12161f; border: 1px solid #232838;
    box-shadow: 0 24px 60px -30px rgba(0,0,0,0.8);
  }
  .status { display: flex; align-items: center; gap: 10px; margin: 0 0 6px; font-size: 18px; font-weight: 650; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #34d399; box-shadow: 0 0 0 4px rgba(52,211,153,0.18); }
  .meta { margin: 0 0 24px; color: #8b93a3; font-size: 13px; }
  .primary {
    display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%;
    padding: 12px 16px; border-radius: 10px; background: #059669; color: #fff;
    font-weight: 600; font-size: 14px; text-decoration: none;
  }
  .primary:hover { background: #047857; }
  .links { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
  .link {
    display: block; padding: 10px 12px; border-radius: 10px; border: 1px solid #262c3a;
    color: #c3c9d4; font-size: 13px; text-decoration: none; text-align: center;
  }
  .link:hover { border-color: #3a4352; color: #fff; }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; color: #7fdbca; }
</style>
</head>
<body>
  <main class="card">
    <h1 class="status"><span class="dot"></span>Quantalog API is running</h1>
    <p class="meta">Uptime ${formatUptime(uptimeSeconds)}</p>
    <a class="primary" href="/docs/">Open API playground &rarr;</a>
    <div class="links">
      <a class="link" href="/openapi.json"><code>openapi.json</code></a>
      <a class="link" href="/api/health"><code>/api/health</code></a>
    </div>
  </main>
</body>
</html>`;
}
