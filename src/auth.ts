import { readFileSync } from "node:fs";
import { opencodeAuthPath } from "./paths.ts";

export interface OAuthCredential {
  type: "oauth";
  access: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
}

export interface ApiCredential {
  type: "api";
  key: string;
}

export type Credential = OAuthCredential | ApiCredential | { type: string };

export type AuthFile = Record<string, Credential>;

export function loadAuth(path = opencodeAuthPath()): AuthFile {
  const raw = readFileSync(path, "utf8");
  const data = JSON.parse(raw) as AuthFile;
  if (!data || typeof data !== "object") {
    throw new Error(`Invalid auth file: ${path}`);
  }
  return data;
}

export function getOAuth(
  auth: AuthFile,
  keys: string[],
): OAuthCredential | null {
  for (const key of keys) {
    const entry = auth[key];
    if (entry && entry.type === "oauth" && "access" in entry && entry.access) {
      return entry as OAuthCredential;
    }
  }
  return null;
}

export function getApiKey(auth: AuthFile, keys: string[]): string | null {
  for (const key of keys) {
    const entry = auth[key];
    if (entry && entry.type === "api" && "key" in entry && entry.key) {
      return (entry as ApiCredential).key;
    }
  }
  return null;
}

/** Decode JWT payload without verification (for account id / email claims). */
export function decodeJwtPayload(
  token: string,
): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
    const json = Buffer.from(padded, "base64url").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function chatgptAccountId(oauth: OAuthCredential): string | undefined {
  if (oauth.accountId) return oauth.accountId;
  const payload = decodeJwtPayload(oauth.access);
  if (!payload) return undefined;
  const authClaim = payload["https://api.openai.com/auth"];
  if (authClaim && typeof authClaim === "object") {
    const id = (authClaim as Record<string, unknown>).chatgpt_account_id;
    if (typeof id === "string") return id;
  }
  return undefined;
}
