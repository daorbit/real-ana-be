/**
 * Module loader hook for check-collect-batch.mjs.
 *
 * ES module namespaces are frozen, so the route's dependencies cannot be
 * monkey-patched after import. This substitutes them at resolve time instead,
 * which is what lets the collect route be exercised without a database.
 */

const STUBS = {
  "models/Event.js": `
    export const Event = {
      docs: [],
      async insertMany(docs) { Event.docs.push(...docs); return docs; },
    };
  `,
  "models/Site.js": `
    export const Site = { async updateOne() { return { acknowledged: true }; } };
  `,
  "event-quota.js": `
    export const meter = { counted: 0 };
    export async function canIngest() { return { allowed: true, workspaceId: "ws_test" }; }
    export function countEvent() { meter.counted++; }
    export async function maybeFlush() {}
  `,
};

export function resolve(specifier, context, next) {
  for (const key of Object.keys(STUBS)) {
    if (specifier.endsWith(key)) {
      return { url: "stub:" + key, shortCircuit: true };
    }
  }
  return next(specifier, context);
}

export function load(url, context, next) {
  if (url.startsWith("stub:")) {
    return {
      format: "module",
      source: STUBS[url.slice(5)],
      shortCircuit: true,
    };
  }
  return next(url, context);
}
