import { describe, expect, test } from "bun:test";
import { isOAuthExpired } from "./oauth-refresh.ts";
import type { OAuthCredential } from "./auth.ts";

describe("isOAuthExpired", () => {
  test("fresh token", () => {
    const oauth: OAuthCredential = {
      type: "oauth",
      access: "a",
      expires: Date.now() + 3_600_000,
    };
    expect(isOAuthExpired(oauth)).toBe(false);
  });

  test("expired token", () => {
    const oauth: OAuthCredential = {
      type: "oauth",
      access: "a",
      expires: Date.now() - 1_000,
    };
    expect(isOAuthExpired(oauth)).toBe(true);
  });

  test("within skew treated as expired", () => {
    const oauth: OAuthCredential = {
      type: "oauth",
      access: "a",
      expires: Date.now() + 30_000,
    };
    expect(isOAuthExpired(oauth, 120_000)).toBe(true);
  });

  test("missing expires is not expired", () => {
    const oauth: OAuthCredential = { type: "oauth", access: "a" };
    expect(isOAuthExpired(oauth)).toBe(false);
  });
});
