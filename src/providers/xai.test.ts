import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchXai,
  grpcWebPayloads,
  parseGrokResetsProto,
  parseGrokResetsResponse,
  resetsFromJson,
} from "./xai.ts";
import type { AuthFile } from "../auth.ts";
import { setRunningProcesses } from "../procs.ts";

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  setRunningProcesses([]);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempAuthFile(auth: AuthFile): string {
  const dir = mkdtempSync(join(tmpdir(), "llm-usage-xai-test-"));
  tempDirs.push(dir);
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify(auth));
  return path;
}

describe("fetchXai", () => {
  test("missing oauth", async () => {
    const r = await fetchXai({});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No xAI OAuth/i);
  });

  test("maps weekly SuperGrok only (no monthly)", async () => {
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes("format=credits")) {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-grok-cli-version")).toBe("1.0.13");
        expect(headers.get("x-grok-client-version")).toBe("1.0.13");
        expect(headers.get("x-grok-client-surface")).toBe("grok-cli");
        expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
        expect(headers.get("user-agent")).toBe("grok-cli/1.0.13");
        return new Response(
          JSON.stringify({
            config: {
              currentPeriod: {
                type: "USAGE_PERIOD_TYPE_WEEKLY",
                end: "2026-07-19T08:17:27.853505+00:00",
              },
              creditUsagePercent: 36.0,
              productUsage: [{ product: "Api", usagePercent: 36.0 }],
              onDemandCap: { val: 0 },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v1/settings")) {
        return new Response(
          JSON.stringify({ subscription_tier_display: "X Premium+" }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const auth: AuthFile = {
      xai: { type: "oauth", access: "SECRET_XAI_TOKEN" },
    };
    const r = await fetchXai(auth);
    expect(r.ok).toBe(true);
    expect(r.usedPercent).toBe(36);
    expect(r.windows.some((w) => w.label === "Weekly")).toBe(true);
    expect(r.windows.some((w) => w.label === "Monthly")).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/SECRET_XAI_TOKEN/);
  });

  test("leaves the refresh token alone while the owning agent runs", async () => {
    let tokenEndpointCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("auth.x.ai/oauth2/token")) {
        tokenEndpointCalls += 1;
        return new Response("{}", { status: 500 });
      }
      if (url.includes("format=credits")) {
        return new Response("unauthorized", { status: 401 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const auth: AuthFile = {
      xai: {
        type: "oauth",
        access: "EXPIRED_XAI_TOKEN",
        refresh: "SHARED_REFRESH_TOKEN",
        expires: Date.now() - 1_000,
      },
    };
    setRunningProcesses(["opencode"]);
    const r = await fetchXai(auth, tempAuthFile(auth));
    expect(r.ok).toBe(false);
    expect(tokenEndpointCalls).toBe(0);
    expect(r.error).toBe("Updates on your next OpenCode message");
  });

  test("refreshes and persists when the owning agent is idle", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("auth.x.ai/oauth2/token")) {
        expect(String(init?.body)).toContain("refresh_token=OLD_REFRESH");
        return new Response(
          JSON.stringify({ access_token: "NEW_ACCESS", refresh_token: "NEW_REFRESH", expires_in: 3600 }),
          { status: 200 },
        );
      }
      if (url.includes("format=credits")) {
        const ok = String((init?.headers as Record<string, string>).Authorization).includes("NEW_ACCESS");
        return ok
          ? new Response(JSON.stringify({ config: { creditUsagePercent: 5 } }), { status: 200 })
          : new Response("unauthorized", { status: 401 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const auth: AuthFile = {
      xai: { type: "oauth", access: "OLD", refresh: "OLD_REFRESH", expires: Date.now() - 1_000 },
    };
    const path = tempAuthFile(auth);
    const r = await fetchXai(auth, path);
    expect(r.ok).toBe(true);
    const saved = JSON.parse(await Bun.file(path).text());
    expect(saved.xai.access).toBe("NEW_ACCESS");
    expect(saved.xai.refresh).toBe("NEW_REFRESH");
  });

  test("does not swallow billing authentication failures", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("format=credits")) {
        return new Response("unauthorized", { status: 401 });
      }
      if (url.includes("/v1/settings")) {
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const auth: AuthFile = {
      xai: { type: "oauth", access: "EXPIRED_XAI_TOKEN" },
    };
    const r = await fetchXai(auth);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/token rejected/i);
    expect(r.error).not.toMatch(/No Grok weekly/i);
  });

  test("weekly period without percent still ok", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("format=credits")) {
        return new Response(
          JSON.stringify({
            config: {
              currentPeriod: {
                type: "USAGE_PERIOD_TYPE_WEEKLY",
                end: "2026-07-19T08:17:27.853505+00:00",
              },
              onDemandCap: { val: 0 },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v1/settings")) {
        return new Response(
          JSON.stringify({ subscription_tier_display: "X Premium+" }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const auth: AuthFile = {
      xai: { type: "oauth", access: "SECRET_XAI_TOKEN" },
    };
    const r = await fetchXai(auth);
    expect(r.ok).toBe(true);
    expect(r.windows.some((w) => w.label === "Weekly")).toBe(true);
    expect(r.windows.some((w) => w.label === "Monthly")).toBe(false);
    expect(r.usedPercent).toBe(0);
  });
});

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function encodeVarint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b += 128;
    out.push(b);
  } while (v > 0);
  return out;
}

function lenDelimited(field: number, bytes: number[]): number[] {
  return [...encodeVarint(field * 8 + 2), ...encodeVarint(bytes.length), ...bytes];
}

function grpcFrame(payload: number[], trailer = false): number[] {
  const len = payload.length;
  return [
    trailer ? 0x80 : 0,
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...payload,
  ];
}

function tokenMessage(tokenId: string, expiryFieldSeconds: number): number[] {
  const idBytes = Array.from(new TextEncoder().encode(tokenId));
  const timestamp = [...encodeVarint(1 * 8), ...encodeVarint(expiryFieldSeconds)];
  return [
    ...lenDelimited(10, idBytes),
    ...lenDelimited(30, timestamp),
  ];
}

const FAR_FUTURE_SECONDS = 4_102_444_800;

describe("grok resets parsing", () => {
  test("parses captured GetRemainingResets grpc-web response", () => {
    const payloadHex =
      "5221520d726573746f6b5f76705944716fa20106089c80f3d306f20106089cbd96d506";
    const trailer = Array.from(new TextEncoder().encode("grpc-status:0\r\n"));
    const body = new Uint8Array([
      ...grpcFrame(Array.from(hexToBytes(payloadHex))),
      ...grpcFrame(trailer, true),
    ]);

    const tokens = parseGrokResetsResponse(body, "application/grpc-web+proto");
    expect(tokens.length).toBe(1);
    expect(tokens[0]?.tokenId).toBe("restok_vpYDqo");
    expect(tokens[0]?.expiresAt).toBe(
      new Date(1_789_238_940 * 1000).toISOString(),
    );
    expect(tokens[0]?.expiresAt).not.toBe(
      new Date(1_786_560_540 * 1000).toISOString(),
    );
  });

  test("grpcWebPayloads falls back to unframed data", () => {
    const unframed = lenDelimited(
      10,
      tokenMessage("solo", FAR_FUTURE_SECONDS),
    );
    const bytes = new Uint8Array(unframed);
    const payloads = grpcWebPayloads(bytes);
    expect(payloads.length).toBe(1);
    const tokens = parseGrokResetsProto(payloads[0]!);
    expect(tokens[0]?.tokenId).toBe("solo");
  });

  test("parses json reset responses", () => {
    const tokens = resetsFromJson({
      tokens: [
        { tokenId: "r1", validityEnd: { seconds: FAR_FUTURE_SECONDS, nanos: 0 } },
        { tokenId: "r2", validityEnd: new Date(FAR_FUTURE_SECONDS * 1000).toISOString() },
      ],
    });
    expect(tokens.length).toBe(2);
    expect(tokens[0]?.expiresAt).toBe(
      new Date(FAR_FUTURE_SECONDS * 1000).toISOString(),
    );
    expect(tokens[1]?.expiresAt).toBe(
      new Date(FAR_FUTURE_SECONDS * 1000).toISOString(),
    );
  });
});

describe("fetchXai resets integration", () => {
  function billingMock(overrides?: {
    resetsBody?: number[];
    resetsStatus?: number;
  }) {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("format=credits")) {
        return new Response(
          JSON.stringify({
            config: {
              currentPeriod: {
                type: "USAGE_PERIOD_TYPE_WEEKLY",
                end: "2026-07-19T08:17:27.853505+00:00",
              },
              creditUsagePercent: 22,
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v1/settings")) {
        return new Response(
          JSON.stringify({ subscription_tier_display: "X Premium+" }),
          { status: 200 },
        );
      }
      if (url.includes("GetRemainingResets")) {
        if (overrides?.resetsStatus && overrides.resetsStatus !== 200) {
          return new Response("nope", { status: overrides.resetsStatus });
        }
        const tokens = [
          tokenMessage("expired-one", Math.floor(Date.now() / 1000) - 3600),
          tokenMessage("live-one", FAR_FUTURE_SECONDS),
        ];
        const body = new Uint8Array([
          ...grpcFrame(lenDelimited(10, tokens[0]!)),
          ...grpcFrame(lenDelimited(10, tokens[1]!)),
          ...grpcFrame(Array.from(new TextEncoder().encode("grpc-status:0")), true),
        ]);
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/grpc-web+proto" },
        });
      }
      expect(url.includes("grok.com") && init?.method !== "POST").toBe(false);
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
  }

  test("appends Resets windows from the reset RPC", async () => {
    globalThis.fetch = billingMock();
    const auth: AuthFile = {
      xai: { type: "oauth", access: "SECRET_XAI_TOKEN" },
    };
    const r = await fetchXai(auth);
    expect(r.ok).toBe(true);
    const resets = r.windows.find((w) => w.id === "resets");
    expect(resets?.note).toBe("1 available");
    const first = r.windows.find((w) => w.id === "reset-0");
    expect(first?.label).toBe("  #1");
    expect(first?.resetsAt).toBe(
      new Date(FAR_FUTURE_SECONDS * 1000).toISOString(),
    );
    expect(r.usedPercent).toBe(22);
    expect(JSON.stringify(r)).not.toMatch(/SECRET_XAI_TOKEN/);
  });

  test("hides resets when the RPC is unavailable", async () => {
    globalThis.fetch = billingMock({ resetsStatus: 404 });
    const auth: AuthFile = {
      xai: { type: "oauth", access: "SECRET_XAI_TOKEN" },
    };
    const r = await fetchXai(auth);
    expect(r.ok).toBe(true);
    expect(r.windows.some((w) => w.id === "resets")).toBe(false);
    expect(r.windows.some((w) => w.id === "weekly")).toBe(true);
  });
});
