export interface AlertEnv {
  API_BASE: string;
  CRON_SECRET: string;
  OPS_ALERT_TELEGRAM_BOT_TOKEN?: string;
  OPS_ALERT_TELEGRAM_CHAT_ID?: string;
}

export interface OpsAlert {
  title: string;
  where: string;
  detail: string;
}

const TIMEOUT_MS = 10_000;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function relayThroughQuantalog(env: AlertEnv, alert: OpsAlert): Promise<boolean> {
  try {
    const response = await fetch(`${env.API_BASE.replace(/\/$/, "")}/api/cron/ops-alert`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CRON_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function sendDirect(env: AlertEnv, alert: OpsAlert): Promise<void> {
  if (!env.OPS_ALERT_TELEGRAM_BOT_TOKEN || !env.OPS_ALERT_TELEGRAM_CHAT_ID) {
    console.warn(`ops alert not sent, no fallback bot: ${alert.title} ${alert.detail}`);
    return;
  }
  const text = [
    `<b>Watchdog · ${escapeHtml(alert.title)}</b>`,
    `<code>${escapeHtml(alert.where)}</code>`,
    escapeHtml(alert.detail),
    `<i>${new Date().toISOString()}</i>`,
  ].join("\n");
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.OPS_ALERT_TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.OPS_ALERT_TELEGRAM_CHAT_ID,
        text: text.slice(0, 4000),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) console.warn(`ops alert not sent: HTTP ${response.status} ${await response.text()}`);
  } catch (error) {
    console.warn(`ops alert not sent: ${(error as Error).message}`);
  }
}

export async function sendOpsAlert(env: AlertEnv, alert: OpsAlert, quantalogUp: boolean): Promise<void> {
  if (quantalogUp && (await relayThroughQuantalog(env, alert))) return;
  await sendDirect(env, alert);
}
