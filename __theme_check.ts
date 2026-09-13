import { parseGeneratedTheme } from "./src/modules/forms-ai/form-schema.js";

// Wrapped shape.
const a = parseGeneratedTheme({ theme: { cardBg: "#131a22", accentColor: "#22c55e" } });
console.log("wrapped:", JSON.stringify(a));

// Bare shape.
const b = parseGeneratedTheme({ cardBg: "#ffffff", accentColor: "#0f172a" });
console.log("bare:", JSON.stringify(b));

// A disobedient model that returned a whole form. Fields must not survive.
const c = parseGeneratedTheme({
  title: "Contact us",
  fields: [{ type: "name", label: "Renamed!" }],
  theme: { cardBg: "#0b0f14", labelColor: "#e6edf3" },
});
console.log("full form:", JSON.stringify(c), "hasFields:", "fields" in (c as any).theme);

// Junk.
console.log("junk:", JSON.stringify(parseGeneratedTheme({ theme: { cardBg: "not-a-hex" } })));
