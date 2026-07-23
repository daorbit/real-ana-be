/**
 * JSON-LD structured data validation.
 *
 * Extracting `@type` names tells a site owner that schema exists, not whether
 * it works. Google silently drops a block that is missing a required property —
 * no rich result, and the failure is only visible in Search Console, which is
 * exactly where someone who has not set up Search Console is not looking.
 *
 * Scope is deliberate: the types below are the ones that actually produce rich
 * results. Validating the whole schema.org vocabulary would bury the findings
 * that matter under a heap of pedantry about optional properties nobody reads.
 */

export type SchemaFinding = {
  severity: "error" | "warning";
  /** The `@type` the finding concerns, or "JSON-LD" for parse failures. */
  type: string;
  property?: string;
  message: string;
};

export type SchemaBlock = {
  /** Index of the <script> tag this came from, for pointing at the source. */
  index: number;
  types: string[];
  valid: boolean;
};

export type SchemaValidation = {
  blocks: SchemaBlock[];
  /** Every distinct `@type` found across all blocks. */
  types: string[];
  findings: SchemaFinding[];
  errorCount: number;
  warningCount: number;
};

type Rule = {
  /** Absent or empty means no rich result. */
  required: string[];
  /** Allowed, but the result is weaker without them. */
  recommended: string[];
};

/**
 * Required and recommended properties per type, following Google's rich
 * results documentation rather than schema.org's own (much looser) definition
 * of what is mandatory.
 */
const RULES: Record<string, Rule> = {
  Article: {
    required: ["headline"],
    recommended: ["image", "datePublished", "dateModified", "author", "publisher"],
  },
  BlogPosting: {
    required: ["headline"],
    recommended: ["image", "datePublished", "dateModified", "author", "publisher"],
  },
  NewsArticle: {
    required: ["headline"],
    recommended: ["image", "datePublished", "dateModified", "author", "publisher"],
  },
  Product: {
    required: ["name"],
    recommended: ["image", "offers", "aggregateRating", "review", "brand", "description"],
  },
  Organization: {
    required: ["name"],
    recommended: ["url", "logo", "sameAs", "contactPoint"],
  },
  LocalBusiness: {
    required: ["name", "address"],
    recommended: ["telephone", "openingHours", "geo", "priceRange", "image"],
  },
  BreadcrumbList: {
    required: ["itemListElement"],
    recommended: [],
  },
  FAQPage: {
    required: ["mainEntity"],
    recommended: [],
  },
  Event: {
    required: ["name", "startDate", "location"],
    recommended: ["endDate", "offers", "performer", "image", "description"],
  },
  Recipe: {
    required: ["name", "image", "recipeIngredient"],
    recommended: ["author", "datePublished", "description", "prepTime", "cookTime", "nutrition"],
  },
  VideoObject: {
    required: ["name", "thumbnailUrl", "uploadDate"],
    recommended: ["description", "duration", "contentUrl"],
  },
  WebSite: {
    required: ["url"],
    recommended: ["name", "potentialAction"],
  },
  Person: {
    required: ["name"],
    recommended: ["url", "image", "sameAs", "jobTitle"],
  },
  SoftwareApplication: {
    required: ["name"],
    recommended: ["applicationCategory", "operatingSystem", "offers", "aggregateRating"],
  },
  Course: {
    required: ["name", "description"],
    recommended: ["provider", "offers"],
  },
  JobPosting: {
    required: ["title", "description", "datePosted", "hiringOrganization"],
    recommended: ["jobLocation", "baseSalary", "employmentType", "validThrough"],
  },
};

/** Google truncates a headline past this in rich results. */
const MAX_HEADLINE = 110;

/** Rich-result images below this width are rejected outright. */
const MIN_IMAGE_WIDTH = 1200;

type Node = Record<string, unknown>;

/** `@type` is a string or an array of them; normalise to a list. */
function typesOf(node: Node): string[] {
  const t = node["@type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * Flatten a parsed JSON-LD document into the nodes worth checking.
 *
 * A block legitimately arrives as a single node, an array, or a `@graph`
 * wrapper, and nested nodes (an `author` inside an `Article`) carry their own
 * types. All of those are walked.
 */
function collectNodes(value: unknown, depth = 0, out: Node[] = []): Node[] {
  if (depth > 6 || value === null || typeof value !== "object") return out;

  if (Array.isArray(value)) {
    for (const item of value) collectNodes(item, depth + 1, out);
    return out;
  }

  const node = value as Node;
  // A bare {"@id": "..."} is a reference to a node defined elsewhere. It has no
  // @type, so it must be collected on that basis or the dangling-reference
  // check never sees it.
  if (typesOf(node).length || typeof node["@id"] === "string") out.push(node);

  for (const [key, child] of Object.entries(node)) {
    if (key === "@context") continue;
    if (child && typeof child === "object") collectNodes(child, depth + 1, out);
  }

  return out;
}

/** True when a property carries something a consumer could actually use. */
function present(node: Node, property: string): boolean {
  const v = node[property];
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as Node).length > 0;
  return true;
}

/** Pull a width out of the several shapes an `image` property can take. */
function imageWidth(image: unknown): number | null {
  if (!image || typeof image !== "object") return null;
  const node = Array.isArray(image) ? (image[0] as Node) : (image as Node);
  if (!node || typeof node !== "object") return null;
  const w = node.width;
  if (typeof w === "number") return w;
  if (typeof w === "string") {
    const n = Number(w.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Validate every JSON-LD block on a page.
 *
 * `raw` is the unparsed text of each `<script type="application/ld+json">`, in
 * document order, so a parse failure can name which block broke.
 */
export function validateStructuredData(raw: string[]): SchemaValidation {
  const findings: SchemaFinding[] = [];
  const blocks: SchemaBlock[] = [];
  const allTypes = new Set<string>();
  // Collected across blocks so an `@id` defined in one can be referenced by
  // another, which is normal and must not be reported as dangling.
  const declaredIds = new Set<string>();
  const referencedIds: { id: string; type: string }[] = [];

  const parsed: { index: number; nodes: Node[] }[] = [];

  raw.forEach((text, index) => {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      blocks.push({ index, types: [], valid: false });
      findings.push({
        severity: "error",
        type: "JSON-LD",
        message: `Block ${index + 1} is not valid JSON and is ignored entirely by search engines: ${
          (e as Error).message
        }`,
      });
      return;
    }

    const nodes = collectNodes(doc);
    const types = [...new Set(nodes.flatMap(typesOf))];
    types.forEach((t) => allTypes.add(t));
    blocks.push({ index, types, valid: true });

    if (!nodes.length) {
      findings.push({
        severity: "error",
        type: "JSON-LD",
        message: `Block ${index + 1} declares no @type, so search engines cannot tell what it describes.`,
      });
      return;
    }

    // A missing @context means the block is not JSON-LD as far as a consumer
    // is concerned, even though it parses as JSON.
    const root = doc as Node;
    if (!Array.isArray(doc) && !present(root, "@context")) {
      findings.push({
        severity: "error",
        type: types[0] ?? "JSON-LD",
        property: "@context",
        message: `Block ${index + 1} has no @context. It should be "https://schema.org".`,
      });
    }

    parsed.push({ index, nodes });
  });

  for (const { nodes } of parsed) {
    for (const node of nodes) {
      const id = node["@id"];
      const types = typesOf(node);

      // A node that is purely a pointer ({"@id": "..."}, optionally with a
      // @type) defines nothing and must not be judged against the rules — it
      // is a reference to a definition that should exist elsewhere.
      const isReference = Object.keys(node).every((k) => k === "@id" || k === "@type");

      if (typeof id === "string") {
        if (isReference) referencedIds.push({ id, type: types[0] ?? "reference" });
        else declaredIds.add(id);
      }

      if (isReference) continue;

      for (const type of types) {
        const rule = RULES[type];
        if (!rule) continue;

        for (const property of rule.required) {
          if (!present(node, property)) {
            findings.push({
              severity: "error",
              type,
              property,
              message: `${type} is missing "${property}". Google will not show a rich result without it.`,
            });
          }
        }

        for (const property of rule.recommended) {
          if (!present(node, property)) {
            findings.push({
              severity: "warning",
              type,
              property,
              message: `${type} has no "${property}". It is optional, but the rich result is weaker without it.`,
            });
          }
        }

        const headline = node.headline;
        if (typeof headline === "string" && headline.length > MAX_HEADLINE) {
          findings.push({
            severity: "warning",
            type,
            property: "headline",
            message: `Headline is ${headline.length} characters. Google truncates past ${MAX_HEADLINE}.`,
          });
        }

        const width = imageWidth(node.image);
        if (width !== null && width < MIN_IMAGE_WIDTH) {
          findings.push({
            severity: "warning",
            type,
            property: "image",
            message: `Image is ${width}px wide. Rich results need at least ${MIN_IMAGE_WIDTH}px.`,
          });
        }

        // Both of these are containers whose whole purpose is their contents.
        if (type === "BreadcrumbList" && Array.isArray(node.itemListElement)) {
          if (node.itemListElement.length === 0) {
            findings.push({
              severity: "error",
              type,
              property: "itemListElement",
              message: "BreadcrumbList is empty, so no breadcrumb trail will be shown.",
            });
          }
        }

        if (type === "FAQPage" && Array.isArray(node.mainEntity)) {
          const bad = node.mainEntity.filter((q) => {
            const question = q as Node;
            return !present(question, "name") || !present(question, "acceptedAnswer");
          });
          if (bad.length) {
            findings.push({
              severity: "error",
              type,
              property: "mainEntity",
              message: `${bad.length} FAQ entr${
                bad.length === 1 ? "y is" : "ies are"
              } missing a question name or an acceptedAnswer.`,
            });
          }
        }
      }
    }
  }

  // Checked after every block, so a cross-block reference resolves correctly.
  for (const ref of referencedIds) {
    if (!declaredIds.has(ref.id)) {
      findings.push({
        severity: "warning",
        type: ref.type,
        property: "@id",
        message: `References "${ref.id}", which is not defined anywhere on this page.`,
      });
    }
  }

  return {
    blocks,
    types: [...allTypes],
    findings,
    errorCount: findings.filter((f) => f.severity === "error").length,
    warningCount: findings.filter((f) => f.severity === "warning").length,
  };
}
