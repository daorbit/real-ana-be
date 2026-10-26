import type { GeneratedTheme } from "./form-schema.js";

export type PaletteColors = Required<
  Pick<
    GeneratedTheme,
    | "pageBg"
    | "cardBg"
    | "cardBorder"
    | "accentColor"
    | "labelColor"
    | "inputBg"
    | "inputBorder"
    | "inputTextColor"
    | "textMode"
  >
>;

export interface FormPalette {
  mood: string;
  colors: PaletteColors;
}

export const FORM_PALETTES = {
  classic: {
    mood: "neutral light grey and blue, safe for any business form",
    colors: {
      pageBg: "#f1f3f5",
      cardBg: "#ffffff",
      cardBorder: "#e9ecef",
      accentColor: "#4c6ef5",
      labelColor: "#212529",
      inputBg: "#ffffff",
      inputBorder: "#ced4da",
      inputTextColor: "#212529",
      textMode: "dark",
    },
  },
  paper: {
    mood: "pure white and crisp blue, minimal and clean",
    colors: {
      pageBg: "#ffffff",
      cardBg: "#ffffff",
      cardBorder: "#e5e7eb",
      accentColor: "#2563eb",
      labelColor: "#111827",
      inputBg: "#ffffff",
      inputBorder: "#d1d5db",
      inputTextColor: "#111827",
      textMode: "dark",
    },
  },
  mono: {
    mood: "black and white, editorial, design studios and portfolios",
    colors: {
      pageBg: "#fafafa",
      cardBg: "#ffffff",
      cardBorder: "#e5e5e5",
      accentColor: "#171717",
      labelColor: "#171717",
      inputBg: "#fafafa",
      inputBorder: "#d4d4d4",
      inputTextColor: "#171717",
      textMode: "dark",
    },
  },
  sky: {
    mood: "soft light blue, calm and trustworthy, schools, clinics, permission slips",
    colors: {
      pageBg: "#eef4fb",
      cardBg: "#ffffff",
      cardBorder: "#dbe6f3",
      accentColor: "#1d6fd8",
      labelColor: "#13253d",
      inputBg: "#ffffff",
      inputBorder: "#c6d5e8",
      inputTextColor: "#13253d",
      textMode: "dark",
    },
  },
  sage: {
    mood: "soft green, health, wellness, nature, volunteering",
    colors: {
      pageBg: "#eef3ee",
      cardBg: "#ffffff",
      cardBorder: "#dbe5db",
      accentColor: "#2f7d4f",
      labelColor: "#1c2b21",
      inputBg: "#ffffff",
      inputBorder: "#c9d8cc",
      inputTextColor: "#1c2b21",
      textMode: "dark",
    },
  },
  sand: {
    mood: "warm cream and amber, hospitality, food, weddings, crafts",
    colors: {
      pageBg: "#efe7db",
      cardBg: "#fdfaf5",
      cardBorder: "#e0d5c3",
      accentColor: "#a16207",
      labelColor: "#3f2d13",
      inputBg: "#ffffff",
      inputBorder: "#ded2be",
      inputTextColor: "#3f2d13",
      textMode: "dark",
    },
  },
  citrus: {
    mood: "white with bright orange, energetic, food delivery, fitness, sales, promotions",
    colors: {
      pageBg: "#fff4ec",
      cardBg: "#ffffff",
      cardBorder: "#fde0cc",
      accentColor: "#ea580c",
      labelColor: "#2b1608",
      inputBg: "#ffffff",
      inputBorder: "#f6cfb3",
      inputTextColor: "#2b1608",
      textMode: "dark",
    },
  },
  ember: {
    mood: "white with bold red, urgent, sports, events, sign-ups",
    colors: {
      pageBg: "#fdf0f0",
      cardBg: "#ffffff",
      cardBorder: "#f5d6d6",
      accentColor: "#dc2626",
      labelColor: "#2a1010",
      inputBg: "#ffffff",
      inputBorder: "#ecc4c4",
      inputTextColor: "#2a1010",
      textMode: "dark",
    },
  },
  lagoon: {
    mood: "white with teal, fresh, travel, spas, startups",
    colors: {
      pageBg: "#ecf7f6",
      cardBg: "#ffffff",
      cardBorder: "#d2ebe8",
      accentColor: "#0f8a80",
      labelColor: "#0f2725",
      inputBg: "#ffffff",
      inputBorder: "#bfe0dc",
      inputTextColor: "#0f2725",
      textMode: "dark",
    },
  },
  blush: {
    mood: "soft pink and rose, beauty, salons, baby showers, celebrations",
    colors: {
      pageBg: "#fbf0f2",
      cardBg: "#ffffff",
      cardBorder: "#f1dce1",
      accentColor: "#c2185b",
      labelColor: "#3b1a24",
      inputBg: "#ffffff",
      inputBorder: "#e8cbd3",
      inputTextColor: "#3b1a24",
      textMode: "dark",
    },
  },
  lavender: {
    mood: "soft violet, creative, education, community events",
    colors: {
      pageBg: "#f3f0fb",
      cardBg: "#ffffff",
      cardBorder: "#e3ddf3",
      accentColor: "#6d4fd6",
      labelColor: "#221a3d",
      inputBg: "#ffffff",
      inputBorder: "#d4cbec",
      inputTextColor: "#221a3d",
      textMode: "dark",
    },
  },
  steel: {
    mood: "cool grey slate, corporate, legal, finance, internal requests",
    colors: {
      pageBg: "#e2e8f0",
      cardBg: "#ffffff",
      cardBorder: "#cbd5e1",
      accentColor: "#475569",
      labelColor: "#0f172a",
      inputBg: "#f8fafc",
      inputBorder: "#cbd5e1",
      inputTextColor: "#0f172a",
      textMode: "dark",
    },
  },
  midnight: {
    mood: "near-black with bright blue, tech, gaming, developer events",
    colors: {
      pageBg: "#0b0c0f",
      cardBg: "#15171c",
      cardBorder: "#25272e",
      accentColor: "#5c7cfa",
      labelColor: "#e9ecef",
      inputBg: "#1c1e25",
      inputBorder: "#2f323b",
      inputTextColor: "#f1f3f5",
      textMode: "light",
    },
  },
  graphite: {
    mood: "dark grey, sleek and premium, product waitlists, launches",
    colors: {
      pageBg: "#1c1c1e",
      cardBg: "#2c2c2e",
      cardBorder: "#3a3a3c",
      accentColor: "#0a84ff",
      labelColor: "#f2f2f7",
      inputBg: "#3a3a3c",
      inputBorder: "#48484a",
      inputTextColor: "#ffffff",
      textMode: "light",
    },
  },
  coffee: {
    mood: "dark warm brown, cafes, bars, nightlife, music",
    colors: {
      pageBg: "#2b1d16",
      cardBg: "#3b2a20",
      cardBorder: "#543d2f",
      accentColor: "#d9a066",
      labelColor: "#f3e6da",
      inputBg: "#473327",
      inputBorder: "#63483a",
      inputTextColor: "#f8f1ea",
      textMode: "light",
    },
  },
} satisfies Record<string, FormPalette>;

export type PaletteId = keyof typeof FORM_PALETTES;

export const PALETTE_IDS = Object.keys(FORM_PALETTES) as PaletteId[];

export const DEFAULT_PALETTE: PaletteId = "classic";

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === "string" && Object.hasOwn(FORM_PALETTES, value);
}

export function paletteColors(id: PaletteId): PaletteColors {
  return { ...FORM_PALETTES[id].colors };
}

export function neutralColors(mode: "light" | "dark"): PaletteColors {
  return paletteColors(mode === "light" ? "graphite" : "classic");
}

export function paletteMenu(): string {
  return PALETTE_IDS.map((id) => `  ${id}: ${FORM_PALETTES[id].mood}`).join("\n");
}
