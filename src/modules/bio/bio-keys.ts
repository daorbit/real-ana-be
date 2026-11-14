const DOT = "․";
const DOLLAR = "＄";

export function encodeKey(value: string): string {
  return value.replace(/\./g, DOT).replace(/\$/g, DOLLAR);
}

export function decodeKey(value: string): string {
  return value.split(DOT).join(".").split(DOLLAR).join("$");
}
