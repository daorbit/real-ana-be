import { waitUntil } from "@vercel/functions";

export function runAfterResponse(label: string, task: () => Promise<unknown>): void {
  const work = Promise.resolve()
    .then(task)
    .catch((err: unknown) => {
      console.error(`[after-response] ${label} failed:`, err);
    });
  waitUntil(work);
}
