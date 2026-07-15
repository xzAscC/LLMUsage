import { describe, expect, test } from "bun:test";
import {
  chatgptAccountId,
  decodeJwtPayload,
  getApiKey,
  getOAuth,
  type AuthFile,
} from "./auth.ts";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("decodeJwtPayload", () => {
  test("decodes payload", () => {
    const token = makeJwt({ sub: "user", n: 1 });
    expect(decodeJwtPayload(token)).toEqual({ sub: "user", n: 1 });
  });

  test("invalid returns null", () => {
    expect(decodeJwtPayload("not-a-jwt")).toBeNull();
  });
});

describe("getOAuth / getApiKey", () => {
  const auth: AuthFile = {
    openai: {
      type: "oauth",
      access: "tok",
      accountId: "acc",
    },
    "zai-coding-plan": { type: "api", key: "zk" },
  };

  test("oauth precedence", () => {
    expect(getOAuth(auth, ["missing", "openai"])?.access).toBe("tok");
    expect(getOAuth(auth, ["missing"])).toBeNull();
  });

  test("api key", () => {
    expect(getApiKey(auth, ["zai-coding-plan"])).toBe("zk");
    expect(getApiKey(auth, ["nope"])).toBeNull();
  });
});

describe("chatgptAccountId", () => {
  test("uses explicit accountId", () => {
    expect(
      chatgptAccountId({ type: "oauth", access: "x", accountId: "A1" }),
    ).toBe("A1");
  });

  test("reads from jwt claim", () => {
    const access = makeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "from-jwt" },
    });
    expect(chatgptAccountId({ type: "oauth", access })).toBe("from-jwt");
  });
});
