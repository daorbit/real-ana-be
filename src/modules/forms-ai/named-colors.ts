import type { PaletteId } from "./palettes.js";

const LIGHT_PALETTE_BY_COLOR: [RegExp, PaletteId][] = [
  [/\b(orange|tangerine|peach|saffron)\b/i, "citrus"],
  [/\b(red|crimson|scarlet|maroon)\b/i, "ember"],
  [/\b(teal|turquoise|aqua|cyan)\b/i, "lagoon"],
  [/\b(pink|rose|blush|magenta)\b/i, "blush"],
  [/\b(purple|violet|lavender|lilac)\b/i, "lavender"],
  [/\b(green|mint|sage|olive)\b/i, "sage"],
  [/\b(brown|coffee|chocolate)\b/i, "coffee"],
  [/\b(gold|amber|yellow|beige|cream)\b/i, "sand"],
  [/\b(grey|gray|slate|silver)\b/i, "steel"],
  [/\b(blue|navy|azure)\b/i, "paper"],
  [/\b(black)\b/i, "mono"],
];

export function paletteForPrompt(prompt: string): PaletteId | null {
  for (const [pattern, palette] of LIGHT_PALETTE_BY_COLOR) {
    if (pattern.test(prompt)) return palette;
  }
  return null;
}

export function mentionsTheme(prompt: string): boolean {
  return /\b(theme|colou?rs?|palette|look|style|restyle)\b/i.test(prompt);
}
