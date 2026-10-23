import { contrast, isLight, readableOn } from "./color.js";
import type { GeneratedTheme } from "./form-schema.js";
import { neutralColors } from "./palettes.js";

type ColorKey =
  | "cardBorder"
  | "accentColor"
  | "labelColor"
  | "inputBg"
  | "inputBorder"
  | "inputTextColor";

export function harmonizeTheme(theme: GeneratedTheme, base?: GeneratedTheme): GeneratedTheme {
  const out: GeneratedTheme = { ...theme };
  const effective: GeneratedTheme = { ...base, ...theme };
  const card = effective.cardBg;
  if (!card) return out;

  const cardIsLight = isLight(card);
  const mode = cardIsLight ? "dark" : "light";
  const neutral = neutralColors(mode);
  const cardChanged = "cardBg" in theme;

  const set = (key: ColorKey, value: string) => {
    if (key in theme || value !== effective[key]) {
      out[key] = value;
      effective[key] = value;
    }
  };

  if (cardChanged || "textMode" in theme) out.textMode = mode;

  if (cardChanged || "labelColor" in theme) {
    set("labelColor", readableOn(effective.labelColor, card, neutral.labelColor));
  }

  if (cardChanged || "inputBg" in theme) {
    const input = effective.inputBg;
    if (!input || isLight(input) !== cardIsLight) {
      set("inputBg", neutral.inputBg);
      set("inputBorder", neutral.inputBorder);
    }
  }

  if (cardChanged || "inputBg" in theme || "inputTextColor" in theme) {
    const input = effective.inputBg ?? card;
    const fallback = isLight(input) ? "#1f2937" : "#f8fafc";
    set("inputTextColor", readableOn(effective.inputTextColor, input, fallback));
  }

  if (cardChanged || "accentColor" in theme) {
    set("accentColor", readableOn(effective.accentColor, card, neutral.accentColor, 3));
  }

  if (cardChanged || "pageBg" in theme || "cardBorder" in theme) {
    const page = effective.pageBg;
    const border = effective.cardBorder;
    const blends = page ? contrast(card, page) < 1.15 : false;
    const borderLost = !border || contrast(border, card) < 1.08 || isLight(border) !== cardIsLight;
    if (borderLost && (blends || border)) set("cardBorder", neutral.cardBorder);
  }

  return out;
}
