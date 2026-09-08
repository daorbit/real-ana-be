
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

 
export function cloudflareReady(): boolean {
  return Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID);
}

 
export async function cloudflareChat(
  req: CloudflareChatRequest,
): Promise<CloudflareChatResult> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;

  if (!token) return { ok: false, status: 503, detail: "no CLOUDFLARE_API_TOKEN" };
  if (!account) return { ok: false, status: 503, detail: "no CLOUDFLARE_ACCOUNT_ID" };

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
      return { ok: false, status: res.status, detail: body.slice(0, 300) };
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
    return {
      ok: false,
      status: aborted ? 504 : 502,
      detail: e instanceof Error ? e.message : "request failed",
    };
  }
}

 
export type WorkersAiUsage = {
  neuronsToday: number;
  dailyLimit: number;
  unavailable?: string;
};

const WORKERS_AI_DAILY_NEURONS = 10_000;

export async function workersAiUsage(): Promise<WorkersAiUsage | null> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) return null;

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
            sum { totalNeurons }
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
            aiInferenceAdaptiveGroups?: { sum?: { totalNeurons?: number } }[];
          }[];
        };
      };
    };

    if (body.errors?.length) {
      return {
        neuronsToday: 0,
        dailyLimit: WORKERS_AI_DAILY_NEURONS,
        unavailable: body.errors[0].message,
      };
    }

    const groups =
      body.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups ?? [];
    const neuronsToday = groups.reduce(
      (sum, g) => sum + (g.sum?.totalNeurons ?? 0),
      0,
    );

    return { neuronsToday, dailyLimit: WORKERS_AI_DAILY_NEURONS };
  } catch (e) {
    return {
      neuronsToday: 0,
      dailyLimit: WORKERS_AI_DAILY_NEURONS,
      unavailable: e instanceof Error ? e.message : "analytics request failed",
    };
  }
}
