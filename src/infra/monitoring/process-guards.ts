import { captureServerError } from "./sentry.js";

let installed = false;

function report(kind: string, error: unknown) {
  console.error(`[process] ${kind}:`, error);
  void captureServerError(error, { method: "PROCESS", path: kind }).catch(() => {});
}

export function installProcessGuards(): void {
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason) => report("unhandledRejection", reason));
  process.on("uncaughtException", (err) => report("uncaughtException", err));
}
