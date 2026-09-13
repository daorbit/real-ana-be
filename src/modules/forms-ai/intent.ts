/**
 * What an edit prompt is actually asking for.
 *
 * A revision that only restyles the form has no business going down the path
 * that regenerates fields. The models are told to leave the questions alone and
 * mostly do, but "mostly" on a live form means an author who asked for a darker
 * background occasionally gets their labels reworded too — and by the time they
 * notice, the undo they needed is several edits back.
 *
 * Routing on intent removes the possibility rather than guarding against it: a
 * theme request is answered by a model that was never shown the fields.
 *
 * Only a confident read of "this is purely appearance" earns the theme path.
 * Anything else falls through to a full revision, which is the behaviour that
 * existed before and is wrong only in being slower than it needed to be.
 */

/** Words that make a prompt about how the form looks. */
const APPEARANCE_WORDS = [
  "theme", "colour", "color", "palette", "styling", "restyle",
  "background", "bg", "font", "typeface", "typography",
  "dark", "light", "darker", "lighter", "bright", "muted", "pastel",
  "shadow", "rounded", "rounder", "round", "corner", "corners",
  "radius", "accent", "contrast", "card", "border",
  "look", "vibe", "aesthetic", "brand", "branding", "skin",
  // Named colours, which is how most restyle prompts are actually phrased.
  "black", "blackish", "white", "grey", "gray", "green", "greenish",
  "blue", "bluish", "red", "reddish", "purple", "violet", "pink",
  "orange", "yellow", "teal", "cyan", "navy", "beige", "cream",
];

/**
 * Words that mean the form's content is in play.
 *
 * Presence of any of these sends the prompt down the full path regardless of
 * how much it also talks about colour — "make it dark and add a phone field" is
 * a field edit that happens to mention a colour, and answering only the colour
 * half would silently drop what was asked.
 */
const STRUCTURE_WORDS = [
  "field", "fields", "question", "questions", "step", "steps", "page", "pages",
  "add", "remove", "delete", "drop", "rename", "reorder", "move", "swap",
  "required", "optional", "validation", "validate", "placeholder", "label",
  "option", "options", "choice", "choices", "dropdown", "checkbox", "radio",
  "title", "heading", "description", "wording", "text", "copy", "rewrite",
  "submit", "button label", "shorten", "expand", "split", "merge",
];

/** Colour words written as hex, which no structure word will ever match. */
const HEX = /#[0-9a-fA-F]{3,8}\b/;

function hasWord(prompt: string, words: string[]): boolean {
  return words.some((w) =>
    w.includes(" ")
      ? prompt.includes(w)
      : // Bounded, so "text" does not fire on "context" and "bg" does not fire
        // on "debug". The loose substring match this replaces is what let
        // unrelated prompts read as appearance requests.
        new RegExp(`\\b${w}\\b`).test(prompt),
  );
}

export type EditIntent = "theme" | "form";

/**
 * `"theme"` only when the prompt is about appearance and mentions nothing
 * structural. Every other prompt — including one that mentions neither — is a
 * form revision.
 */
export function classifyEditIntent(prompt: string): EditIntent {
  const p = prompt.toLowerCase();

  if (hasWord(p, STRUCTURE_WORDS)) return "form";
  if (HEX.test(p)) return "theme";
  if (hasWord(p, APPEARANCE_WORDS)) return "theme";

  return "form";
}
