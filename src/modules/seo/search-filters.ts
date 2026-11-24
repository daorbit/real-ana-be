import type { SearchAnalyticsFilter, SearchType } from "../../infra/http-client/search-console.js";
import { badRequest } from "../../shared/errors/index.js";
import { hashKey } from "./search-cache.js";
import { typeHasQueries } from "./search-types.js";

const MAX_FILTERS = 8;
const MAX_EXPRESSION = 500;

const TEXT_OPERATORS = ["contains", "notContains", "equals", "notEquals", "includingRegex", "excludingRegex"];
const CHOICE_OPERATORS = ["equals", "notEquals"];

type FilterRule = { operators: string[]; accepts: (expression: string) => boolean };

const RULES: Record<SearchAnalyticsFilter["dimension"], FilterRule> = {
  query: { operators: TEXT_OPERATORS, accepts: () => true },
  page: { operators: TEXT_OPERATORS, accepts: () => true },
  country: { operators: CHOICE_OPERATORS, accepts: (v) => /^[a-z]{3}$/i.test(v) },
  device: { operators: CHOICE_OPERATORS, accepts: (v) => ["DESKTOP", "MOBILE", "TABLET"].includes(v) },
  searchAppearance: { operators: ["equals"], accepts: (v) => /^[A-Z0-9_]{1,80}$/.test(v) },
  brandedClassification: { operators: ["equals"], accepts: (v) => ["BRANDED", "NON_BRANDED"].includes(v) },
};

function parseFilter(raw: unknown): SearchAnalyticsFilter {
  const { dimension, operator, expression } = (raw ?? {}) as Record<string, unknown>;
  const name = String(dimension ?? "");
  const value = typeof expression === "string" ? expression.trim() : "";
  if (!Object.hasOwn(RULES, name)) throw badRequest("unknown filter");
  const rule = RULES[name as SearchAnalyticsFilter["dimension"]];
  if (!rule.operators.includes(String(operator))) throw badRequest("unknown filter condition");
  if (!value || value.length > MAX_EXPRESSION || !rule.accepts(value)) throw badRequest("invalid filter value");
  return {
    dimension: name as SearchAnalyticsFilter["dimension"],
    operator: operator as SearchAnalyticsFilter["operator"],
    expression: value,
  };
}

export function parseSearchFilters(value: unknown, type: SearchType): SearchAnalyticsFilter[] {
  if (value === undefined || value === "") return [];
  let list: unknown;
  try {
    list = JSON.parse(String(value));
  } catch {
    throw badRequest("invalid filters");
  }
  if (!Array.isArray(list) || list.length > MAX_FILTERS) throw badRequest("invalid filters");

  const filters = list.map(parseFilter);
  const has = (dimension: SearchAnalyticsFilter["dimension"]) => filters.some((f) => f.dimension === dimension);
  if (has("query") && has("brandedClassification"))
    throw badRequest("Google can't combine a query filter with a brand filter");
  if (!typeHasQueries(type) && (has("query") || has("brandedClassification")))
    throw badRequest("Google does not report queries for this search type");
  return filters;
}

export function withoutDimension(
  filters: SearchAnalyticsFilter[],
  dimension: SearchAnalyticsFilter["dimension"],
): SearchAnalyticsFilter[] {
  return filters.filter((f) => f.dimension !== dimension);
}

export function filtersKey(filters: SearchAnalyticsFilter[]): string {
  if (!filters.length) return "";
  const stable = filters.map((f) => `${f.dimension}|${f.operator}|${f.expression}`).sort().join("\n");
  return `:f${hashKey(stable)}`;
}
