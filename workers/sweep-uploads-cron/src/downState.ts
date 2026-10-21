import type { DownService } from "./health";

export interface StateEnv {
  OPS_STATE?: KVNamespace;
}

const KEY = "down-services";

export interface DownChange {
  newlyDown: DownService[];
  recovered: string[];
}

export async function diffDownState(env: StateEnv, down: DownService[]): Promise<DownChange> {
  if (!env.OPS_STATE) return { newlyDown: down, recovered: [] };

  const previous: string[] = JSON.parse((await env.OPS_STATE.get(KEY)) ?? "[]");
  const current = down.map((d) => d.name);
  const change = {
    newlyDown: down.filter((d) => !previous.includes(d.name)),
    recovered: previous.filter((name) => !current.includes(name)),
  };

  if (change.newlyDown.length || change.recovered.length) {
    await env.OPS_STATE.put(KEY, JSON.stringify(current));
  }
  return change;
}
