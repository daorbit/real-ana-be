import sharp from "sharp";

/**
 * The share card, drawn server-side for link previews.
 *
 * This exists because a social scraper never runs our JavaScript: the card the
 * composer draws on a canvas is invisible to LinkedIn, which fetches the share
 * URL and reads whatever `og:image` it is given. So the same design is built
 * again here as SVG and rasterised to PNG, which is the only format the
 * networks reliably accept.
 *
 * Kept deliberately in step with the client's `shareCard.ts` — same 1200x630
 * frame, same palette, same wording — so the preview in the composer is an
 * honest picture of what will appear in the feed.
 */

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

export type ShareCardInput = {
  workspace: string;
  /** Shown in the footer so a screenshot of the card is still actionable. */
  url: string;
  rangeLabel: string;
  visitors: number;
  pageviews: number;
  /** Omitted from the card when null — an unpublished panel has no number. */
  live: number | null;
};

/**
 * Every label on the card uses the generic `sans-serif` family.
 *
 * Naming Inter here looked right and rendered wrong: the server has no such
 * font installed, and the renderer fell through the whole list to a *serif*
 * default — so the workspace name and the footer URL came out in a bookish
 * face while the numbers did not. A generic family is honest about what is
 * actually available and renders consistently wherever this runs.
 */

/** Compact figures — a card reading `1,482,904` is noise at feed size. */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * Escape text bound for SVG.
 *
 * The workspace name is user-supplied and lands inside markup, so this is a
 * correctness *and* a safety requirement: an unescaped `&` breaks the parse and
 * an unescaped `<` would let a workspace name inject elements into the card.
 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Trim to a width budget, measured in approximate glyph widths.
 *
 * Without a font metrics library this is an estimate, deliberately conservative
 * — a slightly short title reads fine, one that runs past the frame does not.
 */
function fit(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

/** Strip the scheme so the footer reads as a destination rather than a URL. */
function prettyLink(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

function cardSvg(input: ShareCardInput): string {
  const tiles = [
    { label: "Visitors", value: compact(input.visitors), accent: "#34d399" },
    { label: "Pageviews", value: compact(input.pageviews), accent: "#f4f6f8" },
    ...(input.live === null
      ? []
      : [{ label: "Online now", value: compact(input.live), accent: "#34d399" }]),
  ];

  const gap = 24;
  const tileWidth = (CARD_WIDTH - 144 - gap * (tiles.length - 1)) / tiles.length;
  const tileY = 312;
  const tileHeight = 148;

  const tileMarkup = tiles
    .map((tile, i) => {
      const x = 72 + i * (tileWidth + gap);
      return `
    <rect x="${x}" y="${tileY}" width="${tileWidth}" height="${tileHeight}" rx="22"
          fill="rgba(255,255,255,0.045)" stroke="rgba(255,255,255,0.08)" stroke-width="1.5" />
    <text x="${x + 28}" y="${tileY + 78}" fill="${tile.accent}" font-size="56" font-weight="800"
          font-family="sans-serif">${esc(tile.value)}</text>
    <text x="${x + 28}" y="${tileY + 120}" fill="#8d94a5" font-size="22" font-weight="600"
          font-family="sans-serif">${esc(tile.label)}</text>`;
    })
    .join("");

  // A decorative sparkline. Shape only — no real series is published here.
  const points = [0.22, 0.45, 0.3, 0.62, 0.5, 0.78, 0.66, 0.92, 0.8, 1];
  const sparkX = 72;
  const sparkY = 494;
  const sparkW = CARD_WIDTH - 144;
  const sparkH = 62;
  const step = sparkW / (points.length - 1);
  const line = points
    .map((p, i) => `${i ? "L" : "M"}${sparkX + i * step} ${sparkY + sparkH - p * sparkH}`)
    .join(" ");
  const area = `${line} L${sparkX + sparkW} ${sparkY + sparkH} L${sparkX} ${sparkY + sparkH} Z`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#121317" />
      <stop offset="1" stop-color="#0b1a16" />
    </linearGradient>
    <radialGradient id="glow" cx="0.875" cy="0.889" r="0.55">
      <stop offset="0" stop-color="#10b981" stop-opacity="0.28" />
      <stop offset="1" stop-color="#10b981" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="logo" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#34d399" />
      <stop offset="1" stop-color="#059669" />
    </linearGradient>
    <linearGradient id="spark" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#34d399" />
      <stop offset="1" stop-color="#6ee7b7" />
    </linearGradient>
    <linearGradient id="sparkArea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#34d399" stop-opacity="0.35" />
      <stop offset="1" stop-color="#34d399" stop-opacity="0" />
    </linearGradient>
  </defs>

  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#bg)" />
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#glow)" />

  <!-- Brand mark, matching the app's own logo paths. -->
  <g transform="translate(72 64) scale(${56 / 36})">
    <rect x="1" y="1" width="34" height="34" rx="11" fill="url(#logo)" />
    <path d="M8 19h4.2l2.3-7.5 4 15 2.6-11 1.7 3.5H28" stroke="#fff" stroke-width="2.4"
          stroke-linecap="round" stroke-linejoin="round" fill="none" />
  </g>
  <text x="146" y="103" fill="#f4f6f8" font-size="30" font-weight="700"
        font-family="sans-serif">Quantalog</text>

  <rect x="${CARD_WIDTH - 72 - 210}" y="74" width="210" height="40" rx="20" fill="rgba(52,211,153,0.14)" />
  <text x="${CARD_WIDTH - 72 - 105}" y="101" fill="#6ee7b7" font-size="20" font-weight="600"
        text-anchor="middle" font-family="sans-serif">LIVE DASHBOARD</text>

  <text x="72" y="236" fill="#ffffff" font-size="64" font-weight="800"
        font-family="sans-serif">${esc(fit(input.workspace, 26))}</text>
  <text x="72" y="276" fill="#8d94a5" font-size="26" font-weight="500"
        font-family="sans-serif">${esc(input.rangeLabel)}</text>
${tileMarkup}

  <path d="${area}" fill="url(#sparkArea)" />
  <path d="${line}" fill="none" stroke="url(#spark)" stroke-width="5"
        stroke-linecap="round" stroke-linejoin="round" />

  <text x="72" y="598" fill="#6b7280" font-size="22" font-weight="500"
        font-family="sans-serif">${esc(fit(prettyLink(input.url), 76))}</text>
</svg>`;
}

/** Render the card to a PNG buffer, which is what the networks accept. */
export async function renderShareCardPng(input: ShareCardInput): Promise<Buffer> {
  return sharp(Buffer.from(cardSvg(input))).png().toBuffer();
}
