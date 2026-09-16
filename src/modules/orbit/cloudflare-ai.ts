
/** One account's credentials for the Workers AI REST API. */
type CloudflareCreds = { token: string; account: string };

/**
 * Every configured Cloudflare account, in try order.
 *
 * A second account exists purely as a fallback for the first's shared
 * 10,000-neuron/day free allocation — hitting it fails every model in the
 * chain at once, since they're really one account's quota. Filtered to pairs
 * that are actually complete, so a half-set env (token with no account, or
 * vice versa) is silently dropped rather than attempted.
 */
function cloudflareCredentials(): CloudflareCreds[] {
  const pairs: (CloudflareCreds | null)[] = [
    process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID
      ? { token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID }
      : null,
    process.env.NO_REPLY_MAIL_CLOUDFLARE_API_TOKEN && process.env.NO_REPLY_MAIL_CLOUDFLARE_ACCOUNT_ID
      ? {
          token: process.env.NO_REPLY_MAIL_CLOUDFLARE_API_TOKEN,
          account: process.env.NO_REPLY_MAIL_CLOUDFLARE_ACCOUNT_ID,
        }
      : null,
  ];
  return pairs.filter((p): p is CloudflareCreds => p != null);
}

/** Cloudflare's code for "this account's daily free neuron allocation is
 * spent" — the one failure worth retrying against a different account, since
 * every other failure (bad model id, malformed request, model itself down)
 * would fail identically on a second account too. */
function isNeuronLimitError(detail: string): boolean {
  return detail.includes('"code":4006') || detail.includes("daily free allocation");
}

export interface CloudflareChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export type CloudflareChatResult =
  | { ok: true; text: string }
  | { ok: false; status: number; detail: string };

export interface CloudflareVisionRequest {
  model: string;
  /** Base64 payload only — no `data:image/...;base64,` prefix. */
  image: string;
  prompt: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface CloudflareImageGenRequest {
  model: string;
  prompt: string;
  steps?: number;
  signal?: AbortSignal;
}

export type CloudflareImageGenResult =
  | { ok: true; /** Base64, no prefix. */ image: string }
  | { ok: false; status: number; detail: string };


export function cloudflareReady(): boolean {
  return cloudflareCredentials().length > 0;
}


export async function cloudflareChat(
  req: CloudflareChatRequest,
): Promise<CloudflareChatResult> {
  const creds = cloudflareCredentials();
  if (!creds.length) return { ok: false, status: 503, detail: "no Cloudflare credentials configured" };

  let last: CloudflareChatResult = { ok: false, status: 503, detail: "no Cloudflare credentials configured" };

  for (const { token, account } of creds) {
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${req.model}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messages: req.messages,
            max_tokens: req.maxTokens,
            temperature: req.temperature,
          }),
          signal: req.signal,
        },
      );

      const body = await res.text();

      if (!res.ok) {
        last = { ok: false, status: res.status, detail: body.slice(0, 300) };
        if (isNeuronLimitError(body)) continue;
        return last;
      }

      const data = JSON.parse(body) as {
        result?: {
          response?: unknown;
          choices?: { message?: { content?: string } }[];
        };
      };

      const raw = data.result?.choices?.[0]?.message?.content ?? data.result?.response;

      const text =
        typeof raw === "string"
          ? raw
          : raw && typeof raw === "object"
            ? JSON.stringify(raw)
            : "";

      if (!text.trim()) return { ok: false, status: 502, detail: "empty completion" };

      return { ok: true, text };
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError";
      last = {
        ok: false,
        status: aborted ? 504 : 502,
        detail: e instanceof Error ? e.message : "request failed",
      };
      if (aborted) return last;
    }
  }

  return last;
}


export async function cloudflareVisionChat(
  req: CloudflareVisionRequest,
): Promise<CloudflareChatResult> {
  const creds = cloudflareCredentials();
  if (!creds.length) return { ok: false, status: 503, detail: "no Cloudflare credentials configured" };

  let last: CloudflareChatResult = { ok: false, status: 503, detail: "no Cloudflare credentials configured" };

  for (const { token, account } of creds) {
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${req.model}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            image: req.image,
            prompt: req.prompt,
            max_tokens: req.maxTokens,
          }),
          signal: req.signal,
        },
      );

      const body = await res.text();

      if (!res.ok) {
        last = { ok: false, status: res.status, detail: body.slice(0, 300) };
        if (isNeuronLimitError(body)) continue;
        return last;
      }

      const data = JSON.parse(body) as { result?: { response?: unknown } };
      const raw = data.result?.response;

      const text =
        typeof raw === "string"
          ? raw
          : raw && typeof raw === "object"
            ? JSON.stringify(raw)
            : "";

      if (!text.trim()) return { ok: false, status: 502, detail: "empty completion" };

      return { ok: true, text };
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError";
      last = {
        ok: false,
        status: aborted ? 504 : 502,
        detail: e instanceof Error ? e.message : "request failed",
      };
      if (aborted) return last;
    }
  }

  return last;
}

/**
 * Cloudflare's text-to-image models — a third request shape again:
 * `{prompt, steps}` in, a base64 image out under `result.image`, not
 * `result.response`.
 */
export async function cloudflareGenerateImage(
  req: CloudflareImageGenRequest,
): Promise<CloudflareImageGenResult> {
  const creds = cloudflareCredentials();
  if (!creds.length) return { ok: false, status: 503, detail: "no Cloudflare credentials configured" };

  let last: CloudflareImageGenResult = { ok: false, status: 503, detail: "no Cloudflare credentials configured" };

  for (const { token, account } of creds) {
    const abort = new AbortController();
    const timer = req.signal ? null : setTimeout(() => abort.abort(), 30_000);

    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${req.model}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prompt: req.prompt, steps: req.steps }),
          signal: req.signal ?? abort.signal,
        },
      );

      const body = await res.text();

      if (!res.ok) {
        last = { ok: false, status: res.status, detail: body.slice(0, 300) };
        if (isNeuronLimitError(body)) continue;
        return last;
      }

      const data = JSON.parse(body) as { result?: { image?: string } };
      const image = data.result?.image;

      if (!image) return { ok: false, status: 502, detail: "empty image" };

      return { ok: true, image };
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError";
      last = {
        ok: false,
        status: aborted ? 504 : 502,
        detail: e instanceof Error ? e.message : "request failed",
      };
      if (aborted) return last;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return last;
}


/** One model's activity today on one account, for the admin card's breakdown
 * table — what's actually spending the neuron budget and how much of it is
 * failing. */
export type WorkersAiModelUsage = {
  modelId: string;
  requests: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  neurons: number;
  /** Average inference time across this model's requests today, ms. */
  avgLatencyMs: number;
  bytesIn: number;
  bytesOut: number;
  /** Failures broken out by Cloudflare's own error code (e.g. 4006 is the
   * daily neuron limit) rather than collapsed into one `failed` count. */
  errorsByCode: { code: number; count: number }[];
};

export type WorkersAiUsage = {

  label: string;
  neuronsToday: number;
  dailyLimit: number;
  unavailable?: string;

  models: WorkersAiModelUsage[];
};

const WORKERS_AI_DAILY_NEURONS = 10_000;

/** One account's usage, for `workersAiUsage` to run over each configured pair. */
async function accountUsage(label: string, creds: CloudflareCreds): Promise<WorkersAiUsage> {
  const { token, account } = creds;

  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);

  const query = `
    query Usage($account: String!, $start: Time!, $end: Time!) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          aiInferenceAdaptiveGroups(
            limit: 1000
            filter: { datetime_geq: $start, datetime_leq: $end }
          ) {
            count
            sum {
              totalNeurons
              totalInputTokens
              totalOutputTokens
              totalInferenceTimeMs
              totalRequestBytesIn
              totalRequestBytesOut
            }
            dimensions { modelId errorCode }
          }
        }
      }
    }`;

  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: {
          account,
          start: start.toISOString(),
          end: new Date().toISOString(),
        },
      }),
    });

    const body = (await res.json()) as {
      errors?: { message: string }[];
      data?: {
        viewer?: {
          accounts?: {
            aiInferenceAdaptiveGroups?: {
              count?: number;
              sum?: {
                totalNeurons?: number;
                totalInputTokens?: number;
                totalOutputTokens?: number;
                totalInferenceTimeMs?: number;
                totalRequestBytesIn?: number;
                totalRequestBytesOut?: number;
              };
              dimensions?: { modelId?: string; errorCode?: number };
            }[];
          }[];
        };
      };
    };

    if (body.errors?.length) {
      return {
        label,
        neuronsToday: 0,
        dailyLimit: WORKERS_AI_DAILY_NEURONS,
        unavailable: body.errors[0].message,
        models: [],
      };
    }

    const groups =
      body.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups ?? [];
    const neuronsToday = groups.reduce(
      (sum, g) => sum + (g.sum?.totalNeurons ?? 0),
      0,
    );


    const byModel = new Map<string, WorkersAiModelUsage>();
    for (const g of groups) {
      const modelId = g.dimensions?.modelId;
      if (!modelId) continue;
      const requests = g.count ?? 0;
      const errorCode = g.dimensions?.errorCode ?? 0;
      const failed = errorCode ? requests : 0;

      const row = byModel.get(modelId) ?? {
        modelId,
        requests: 0,
        failed: 0,
        inputTokens: 0,
        outputTokens: 0,
        neurons: 0,
        avgLatencyMs: 0,
        bytesIn: 0,
        bytesOut: 0,
        errorsByCode: [],
      };
      const priorTimeMs = row.avgLatencyMs * row.requests;

      row.requests += requests;
      row.failed += failed;
      row.inputTokens += g.sum?.totalInputTokens ?? 0;
      row.outputTokens += g.sum?.totalOutputTokens ?? 0;
      row.neurons += g.sum?.totalNeurons ?? 0;
      row.bytesIn += g.sum?.totalRequestBytesIn ?? 0;
      row.bytesOut += g.sum?.totalRequestBytesOut ?? 0;
      row.avgLatencyMs = row.requests
        ? (priorTimeMs + (g.sum?.totalInferenceTimeMs ?? 0)) / row.requests
        : 0;

      if (errorCode) {
        const existing = row.errorsByCode.find((e) => e.code === errorCode);
        if (existing) existing.count += requests;
        else row.errorsByCode.push({ code: errorCode, count: requests });
      }

      byModel.set(modelId, row);
    }

    const models = [...byModel.values()].sort((a, b) => b.requests - a.requests);

    return { label, neuronsToday, dailyLimit: WORKERS_AI_DAILY_NEURONS, models };
  } catch (e) {
    return {
      label,
      neuronsToday: 0,
      dailyLimit: WORKERS_AI_DAILY_NEURONS,
      unavailable: e instanceof Error ? e.message : "analytics request failed",
      models: [],
    };
  }
}


export async function workersAiUsage(): Promise<WorkersAiUsage[]> {
  const creds = cloudflareCredentials();
  if (!creds.length) return [];

  const labels = ["Primary", "Fallback"];
  return Promise.all(creds.map((c, i) => accountUsage(labels[i] ?? `Account ${i + 1}`, c)));
}

export type WorkersAiTrendPoint = {
  /** ISO hour (today) or ISO date (7d) this bucket covers. */
  bucket: string;
  neurons: number;
  requests: number;
};

/** One account's trend buckets, before accounts are merged. */
async function accountTrend(
  creds: CloudflareCreds,
  range: "today" | "7d",
): Promise<WorkersAiTrendPoint[]> {
  const { token, account } = creds;

  const end = new Date();
  const start = new Date();
  if (range === "today") {
    start.setUTCHours(0, 0, 0, 0);
  } else {
    start.setUTCDate(start.getUTCDate() - 6);
    start.setUTCHours(0, 0, 0, 0);
  }


  const bucketField = range === "today" ? "datetimeHour" : "date";

  const query = `
    query Trend($account: String!, $start: Time!, $end: Time!) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          aiInferenceAdaptiveGroups(
            limit: 1000
            filter: { datetime_geq: $start, datetime_leq: $end }
          ) {
            count
            sum { totalNeurons }
            dimensions { ${bucketField} }
          }
        }
      }
    }`;

  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { account, start: start.toISOString(), end: end.toISOString() },
      }),
    });

    const body = (await res.json()) as {
      errors?: { message: string }[];
      data?: {
        viewer?: {
          accounts?: {
            aiInferenceAdaptiveGroups?: {
              count?: number;
              sum?: { totalNeurons?: number };
              dimensions?: Record<string, string | undefined>;
            }[];
          }[];
        };
      };
    };

    if (body.errors?.length) return [];

    const groups = body.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups ?? [];
    const byBucket = new Map<string, WorkersAiTrendPoint>();
    for (const g of groups) {
      const bucket = g.dimensions?.[bucketField];
      if (!bucket) continue;
      const row = byBucket.get(bucket) ?? { bucket, neurons: 0, requests: 0 };
      row.neurons += g.sum?.totalNeurons ?? 0;
      row.requests += g.count ?? 0;
      byBucket.set(bucket, row);
    }
    return [...byBucket.values()];
  } catch {
    return [];
  }
}


export async function workersAiTrend(range: "today" | "7d"): Promise<WorkersAiTrendPoint[]> {
  const creds = cloudflareCredentials();
  if (!creds.length) return [];

  const perAccount = await Promise.all(creds.map((c) => accountTrend(c, range)));

  const merged = new Map<string, WorkersAiTrendPoint>();
  for (const points of perAccount) {
    for (const p of points) {
      const row = merged.get(p.bucket) ?? { bucket: p.bucket, neurons: 0, requests: 0 };
      row.neurons += p.neurons;
      row.requests += p.requests;
      merged.set(p.bucket, row);
    }
  }

  const end = new Date();
  const buckets: string[] = [];
  if (range === "today") {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    for (let h = new Date(start); h <= end; h.setUTCHours(h.getUTCHours() + 1)) {
      buckets.push(new Date(h).toISOString().slice(0, 13) + ":00:00Z");
    }
  } else {
    for (let i = 6; i >= 0; i--) {
      const d = new Date(end);
      d.setUTCDate(d.getUTCDate() - i);
      buckets.push(d.toISOString().slice(0, 10));
    }
  }

  return buckets.map((b) => merged.get(b) ?? { bucket: b, neurons: 0, requests: 0 });
}
