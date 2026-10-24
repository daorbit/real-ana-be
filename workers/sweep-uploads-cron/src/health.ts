export interface HealthEnv {
  API_BASE: string;
  FORMS_API_BASE: string;
  DASHBOARD_URL?: string;
  SITE_URL?: string;
}

interface Probe {
  name: string;
  url: string;
}

const PROBE_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 5_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const trimSlash = (url: string) => url.replace(/\/$/, "");

function probesFor(env: HealthEnv): Probe[] {
  const probes: Probe[] = [
    { name: QUANTALOG_API, url: `${trimSlash(env.API_BASE)}/api/health` },
    { name: "Forms API", url: `${trimSlash(env.FORMS_API_BASE)}/api/health` },
  ];
  if (env.DASHBOARD_URL) probes.push({ name: "Dashboard", url: env.DASHBOARD_URL });
  if (env.SITE_URL) probes.push({ name: "Landing page", url: env.SITE_URL });
  return probes;
}

async function probeOnce(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return response.ok ? null : `HTTP ${response.status}`;
  } catch (error) {
    const e = error as Error;
    return e.name === "TimeoutError" ? `no answer in ${PROBE_TIMEOUT_MS / 1000}s` : e.message;
  }
}

export interface DownService {
  name: string;
  url: string;
  reason: string;
}

export const QUANTALOG_API = "Quantalog API";

async function probe(target: Probe): Promise<DownService | null> {
  if ((await probeOnce(target.url)) === null) return null;
  await sleep(RETRY_DELAY_MS);
  const reason = await probeOnce(target.url);
  return reason === null ? null : { name: target.name, url: target.url, reason };
}

export async function failingServices(env: HealthEnv): Promise<DownService[]> {
  const results = await Promise.all(probesFor(env).map(probe));
  return results.filter((down): down is DownService => down !== null);
}
