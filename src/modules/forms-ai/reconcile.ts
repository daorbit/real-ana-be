import type { GeneratedField, GeneratedForm } from "./form-schema.js";

/**
 * Repair a revision the model got carelessly wrong.
 *
 * The small models on the generation path are told to return the whole form
 * again and keep everything the prompt did not touch. They mostly do — but a
 * 8B model under token pressure also drops fields it was meant to keep and
 * restyles a form nobody asked it to restyle. Both are silent: the reply still
 * parses, so nothing downstream notices.
 *
 * This runs only on a revision (there is a `previous` to compare against) and
 * pulls the answer back toward it:
 *
 *  - **Theme** is discarded unless the prompt actually asked about
 *    appearance. An "add a phone field" request has no business recolouring
 *    the form, and the user's own theme — set in the Theme panel or on a
 *    previous turn — is what should survive.
 *
 *  - **Dropped fields** are restored. Any field that was in `previous` but is
 *    missing from the reply is added back, unless the prompt reads like a
 *    removal ("remove the phone field", "get rid of the address"). A revision
 *    that was meant to reword one label should never come back three fields
 *    shorter.
 *
 * It cannot fix a bad rewrite of a field the model *did* return — that is the
 * edit that was asked for, and second-guessing it would defeat the point.
 */

const APPEARANCE_WORDS = [
  "theme", "colour", "color", "palette", "style", "styling", "background",
  "font", "typeface", "dark", "light", "brand", "branding", "look", "shadow",
  "rounded", "radius", "accent",
];

const REMOVAL_WORDS = [
  "remove", "delete", "drop", "get rid", "take out", "without", "no longer",
  "don't need", "dont need", "cut",
];

function mentions(prompt: string, words: string[]): boolean {
  const p = prompt.toLowerCase();
  return words.some((w) => p.includes(w));
}

/** A stable key for matching a field across the two versions. */
function fieldKey(f: GeneratedField): string {
  return `${f.type}::${(f.label ?? "").trim().toLowerCase()}`;
}

export function reconcileRevision(
  previous: GeneratedForm,
  generated: GeneratedForm,
  prompt: string,
): GeneratedForm {
  const out: GeneratedForm = { ...generated };

  // Keep the user's theme unless they asked about appearance. If the prompt is
  // about the look and the model returned nothing, fall back to what was there.
  if (!mentions(prompt, APPEARANCE_WORDS)) {
    out.theme = previous.theme;
  } else if (!out.theme) {
    out.theme = previous.theme;
  }

  // Restore any field the model dropped, unless the prompt asked for a removal.
  if (!mentions(prompt, REMOVAL_WORDS)) {
    const returned = new Set(out.fields.map(fieldKey));
    const restored: GeneratedField[] = [];
    previous.fields.forEach((prev, i) => {
      if (returned.has(fieldKey(prev))) return;
      // Put it back roughly where it was: after the field that preceded it in
      // the old form, if that field is still present; otherwise at the end.
      const anchorKey = i > 0 ? fieldKey(previous.fields[i - 1]) : null;
      const at = anchorKey
        ? out.fields.findIndex((f) => fieldKey(f) === anchorKey)
        : -1;
      if (at >= 0) out.fields.splice(at + 1, 0, prev);
      else restored.push(prev);
    });
    if (restored.length) out.fields = [...out.fields, ...restored];
  }

  return out;
}
