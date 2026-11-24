import type { SearchType } from "../../infra/http-client/search-console.js";

export const SEARCH_TYPES = [
  "web",
  "webMultimodal",
  "image",
  "video",
  "news",
  "discover",
  "googleNews",
] as const satisfies readonly SearchType[];

const TYPES_WITHOUT_QUERIES: readonly SearchType[] = ["webMultimodal", "discover", "googleNews"];

export function clampType(value: unknown): SearchType {
  return (SEARCH_TYPES as readonly string[]).includes(String(value)) ? (value as SearchType) : "web";
}

export function typeHasQueries(type: SearchType): boolean {
  return !TYPES_WITHOUT_QUERIES.includes(type);
}
