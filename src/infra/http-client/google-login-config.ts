import type { GoogleClientConfig } from "./google-oauth.js";

export const GOOGLE_LOGIN_SCOPE = "openid email profile";

export const GOOGLE_LOGIN_AUTHORIZE_OVERRIDES = {
  access_type: "online",
  prompt: "select_account",
};

export function googleLoginRedirectUri(): string {
  const explicit = process.env.GOOGLE_CALLBACK_URL;
  if (explicit) return explicit;
  const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  return base ? `${base}/api/auth/google-oauth/callback` : "";
}

export function googleLoginConfig(): GoogleClientConfig {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID ?? process.env.VITE_GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri: googleLoginRedirectUri(),
  };
}

export function missingGoogleLoginConfig(): string[] {
  const { clientId, clientSecret, redirectUri } = googleLoginConfig();
  const missing: string[] = [];
  if (!clientId) missing.push("GOOGLE_CLIENT_ID");
  if (!clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
  if (!redirectUri) missing.push("GOOGLE_CALLBACK_URL (or PUBLIC_BASE_URL)");
  return missing;
}
