import { classifyEditIntent } from "./src/modules/forms-ai/intent.js";
const cases: [string, string][] = [
  ["update theme i want blackish and greenish", "theme"],
  ["make it dark", "theme"],
  ["use #0b0f14 as the background", "theme"],
  ["make the card corners rounder", "theme"],
  ["softer palette please", "theme"],
  ["make it look more premium", "theme"],
  ["add a phone number field", "form"],
  ["make the email field optional", "form"],
  ["make it dark and add a phone field", "form"],
  ["rewrite the description to be friendlier", "form"],
  ["remove the company field", "form"],
  ["change the submit button label to Send", "form"],
  ["shorten the form", "form"],
  ["a darker deadline reminder question", "form"],
];
let bad = 0;
for (const [p, want] of cases) {
  const got = classifyEditIntent(p);
  if (got !== want) { bad++; console.log(`FAIL want=${want} got=${got}  "${p}"`); }
}
console.log(bad === 0 ? `all ${cases.length} pass` : `${bad} failed`);
