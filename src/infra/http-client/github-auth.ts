import axios from "axios";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const EMAILS_URL = "https://api.github.com/user/emails";

export const GITHUB_LOGIN_SCOPES = ["read:user", "user:email"];

const API_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "Quantalog",
  "X-GitHub-Api-Version": "2022-11-28",
};

export type GitHubProfile = {
  sub: string;
  login: string;
  name: string;
  email: string;
  picture: string;
};

function clientId(): string {
  return process.env.GIT_CLIENT_ID ?? process.env.GITHUB_CLIENT_ID ?? "";
}

function clientSecret(): string {
  return process.env.GIT_CLIENT_SECRET ?? process.env.GITHUB_CLIENT_SECRET ?? "";
}

export function gitHubRedirectUri(): string {
  const explicit = process.env.GITHUB_CALLBACK_URL;
  if (explicit) return explicit;
  const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  return base ? `${base}/auth/github/callback` : "";
}

export function missingGitHubConfig(): string[] {
  const missing: string[] = [];
  if (!clientId()) missing.push("GIT_CLIENT_ID");
  if (!clientSecret()) missing.push("GIT_CLIENT_SECRET");
  if (!gitHubRedirectUri()) missing.push("GITHUB_CALLBACK_URL (or PUBLIC_BASE_URL)");
  return missing;
}

export function buildGitHubAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: gitHubRedirectUri(),
    scope: GITHUB_LOGIN_SCOPES.join(" "),
    state,
    allow_signup: "true",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeGitHubCode(code: string): Promise<string> {
  const { status, data } = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      code,
      redirect_uri: gitHubRedirectUri(),
    }).toString(),
    {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 10000,
      validateStatus: () => true,
    },
  );

  if (status !== 200 || !data?.access_token) {
    const detail = [data?.error, data?.error_description]
      .filter((v) => typeof v === "string" && v)
      .join(": ");
    throw new Error(
      `github token exchange failed (status ${status})${detail ? ` — ${detail}` : ""}`,
    );
  }

  return String(data.access_token);
}

type GitHubEmail = { email: string; primary: boolean; verified: boolean };

async function fetchVerifiedEmail(accessToken: string): Promise<string> {
  const { status, data } = await axios.get<GitHubEmail[]>(EMAILS_URL, {
    headers: { ...API_HEADERS, Authorization: `Bearer ${accessToken}` },
    timeout: 10000,
    validateStatus: () => true,
  });
  if (status !== 200 || !Array.isArray(data)) return "";

  const verified = data.filter((e) => e.verified && e.email && !e.email.endsWith("@users.noreply.github.com"));
  const pick = verified.find((e) => e.primary) ?? verified[0];
  return pick ? pick.email.toLowerCase().trim() : "";
}

export async function fetchGitHubProfile(accessToken: string): Promise<GitHubProfile> {
  const { status, data } = await axios.get(USER_URL, {
    headers: { ...API_HEADERS, Authorization: `Bearer ${accessToken}` },
    timeout: 10000,
    validateStatus: () => true,
  });

  if (status !== 200 || !data?.id) {
    throw new Error(`github user lookup failed (status ${status})`);
  }

  const login = String(data.login ?? "");

  return {
    sub: String(data.id),
    login,
    name: String(data.name ?? "").trim() || login,
    email: await fetchVerifiedEmail(accessToken),
    picture: String(data.avatar_url ?? ""),
  };
}
