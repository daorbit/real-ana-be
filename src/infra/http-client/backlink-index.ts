import axios from "axios";

export type IndexedLink = {
  sourceUrl: string;
  sourceDomain: string;
  targetUrl: string;
  anchorText: string;
  dofollow: boolean;
  attributes: string[];
  isImage: boolean;
  authority: number | null;
};

type DataForSeoItem = {
  url_from?: string;
  domain_from?: string;
  url_to?: string;
  anchor?: string | null;
  alt?: string | null;
  dofollow?: boolean;
  attributes?: string[] | null;
  item_type?: string;
  domain_from_rank?: number | null;
};

const ENDPOINT = "https://api.dataforseo.com/v3/backlinks/backlinks/live";
const DEFAULT_LIMIT = 100;

export function backlinkIndexConfigured(): boolean {
  return Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
}

export async function fetchIndexedBacklinks(domain: string, limit = DEFAULT_LIMIT): Promise<IndexedLink[]> {
  if (!backlinkIndexConfigured()) throw new Error("backlink index is not configured");

  const { data } = await axios.post(
    ENDPOINT,
    [
      {
        target: domain,
        mode: "one_per_domain",
        limit,
        rank_scale: "one_hundred",
        order_by: ["domain_from_rank,desc"],
        backlinks_status_type: "live",
      },
    ],
    {
      auth: { username: process.env.DATAFORSEO_LOGIN!, password: process.env.DATAFORSEO_PASSWORD! },
      timeout: 30_000,
    }
  );

  const task = data?.tasks?.[0];
  if (!task || task.status_code !== 20000) {
    throw new Error(task?.status_message ?? data?.status_message ?? "backlink index request failed");
  }

  const items: DataForSeoItem[] = task.result?.[0]?.items ?? [];
  return items
    .filter((i) => i.url_from && i.domain_from)
    .map((i) => {
      const isImage = i.item_type === "image";
      return {
        sourceUrl: i.url_from!,
        sourceDomain: i.domain_from!.replace(/^www\./, "").toLowerCase(),
        targetUrl: i.url_to ?? "",
        anchorText: String((isImage ? i.alt : i.anchor) ?? "").trim().slice(0, 200),
        dofollow: Boolean(i.dofollow),
        attributes: i.attributes ?? [],
        isImage,
        authority: typeof i.domain_from_rank === "number" ? i.domain_from_rank : null,
      };
    });
}
