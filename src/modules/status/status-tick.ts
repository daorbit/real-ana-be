import { runStatusChecks } from "./checks.service.js";
import { runStatusEmails } from "./email-runner.js";

export async function runStatusTick() {
  const [checks, emails] = await Promise.all([runStatusChecks(), runStatusEmails()]);
  return { checked: checks.checked, skipped: checks.skipped, emailsSent: emails.sent };
}
