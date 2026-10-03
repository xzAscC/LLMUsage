import type { AuthFile, OAuthCredential } from "../auth.ts";
import { loadConfig, type ResetCreditsDisplay } from "../config.ts";
import {
  authFileSource,
  callWithOAuth,
  CredentialError,
  loadStores,
  xaiSources,
  type OAuthSource,
} from "../credentials.ts";
import { xaiRefresher } from "../oauth-refresh.ts";
import { finalizeProvider } from "../severity.ts";
import type { ProviderStatus, UsageWindow } from "../types.ts";
import {
  clampPercent,
  fetchJson,
  secondsUntil,
} from "../util.ts";

interface MoneyVal {
  val?: number;
}

interface GrokProductUsage {
  product?: string;
  usagePercent?: number;
}

interface GrokBillingConfig {
  monthlyLimit?: MoneyVal;
  used?: MoneyVal;
  onDemandCap?: MoneyVal;
  onDemandUsed?: MoneyVal;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  currentPeriod?: {
    type?: string;
    start?: string;
    end?: string;
  };
  creditUsagePercent?: number;
  productUsage?: GrokProductUsage[];
  isUnifiedBillingUser?: boolean;
}

interface GrokBillingResponse {
  config?: GrokBillingConfig;
}

interface GrokSettingsResponse {
  subscription_tier_display?: string;
}

// keep ≥ settings.min_client_version or the proxy may start refusing us
const GROK_CLI_VERSION = "1.0.13";

function periodLabel(type?: string): string {
  if (!type) return "Weekly";
  if (type.includes("WEEKLY")) return "Weekly";
  if (type.includes("MONTHLY")) return "Monthly";
  if (type.includes("DAILY")) return "Daily";
  return "Period";
}

function grokHeaders(oauth: OAuthCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${oauth.access}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "X-Grok-Cli-Version": GROK_CLI_VERSION,
    "X-Grok-Client-Version": GROK_CLI_VERSION,
    "X-Grok-Client-Surface": "grok-cli",
    "X-Grok-Client-Identifier": "llm-usage",
    Accept: "application/json",
    "User-Agent": `grok-cli/${GROK_CLI_VERSION}`,
  };
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof CredentialError) {
    return msg === "no credentials"
      ? "No xAI OAuth — log in with the grok CLI (or pi / OpenCode)"
      : msg;
  }
  const m = msg.match(/HTTP\s+(\d+)/);
  if (m) return `HTTP ${m[1]} from Grok billing`;
  return msg.length > 120 ? msg.slice(0, 120) + "…" : msg;
}

function windowsFromBilling(weekly: GrokBillingConfig): UsageWindow[] {
  const windows: UsageWindow[] = [];

  const weeklyEnd = weekly.currentPeriod?.end || weekly.billingPeriodEnd;
  const weeklyStart = weekly.currentPeriod?.start || weekly.billingPeriodStart;
  const span =
    weeklyStart && weeklyEnd
      ? (Date.parse(weeklyEnd) - Date.parse(weeklyStart)) / 1000
      : NaN;
  const windowSeconds =
    Number.isFinite(span) && span > 0
      ? span
      : weekly.currentPeriod?.type?.includes("WEEKLY")
        ? 7 * 86400
        : undefined;
  if (weekly.creditUsagePercent != null) {
    const usedPercent = clampPercent(weekly.creditUsagePercent);
    windows.push({
      id: "weekly",
      label: periodLabel(weekly.currentPeriod?.type),
      usedPercent,
      remainingPercent: clampPercent(100 - usedPercent),
      resetsAt: weeklyEnd,
      resetAfterSeconds: secondsUntil(weeklyEnd),
      windowSeconds,
    });
  } else if (weekly.currentPeriod?.type && weeklyEnd) {
    // proto3 JSON omits zero values: a period with no percent means 0% used
    windows.push({
      id: "weekly",
      label: periodLabel(weekly.currentPeriod.type),
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt: weeklyEnd,
      resetAfterSeconds: secondsUntil(weeklyEnd),
      windowSeconds,
    });
  }

  const odCap = weekly.onDemandCap?.val ?? 0;
  const odUsed = weekly.onDemandUsed?.val ?? 0;
  if (odCap > 0) {
    const usedPercent = clampPercent((odUsed / odCap) * 100);
    windows.push({
      id: "ondemand",
      label: "On-demand",
      usedPercent,
      remainingPercent: clampPercent(100 - usedPercent),
      used: odUsed,
      limit: odCap,
      remaining: Math.max(0, odCap - odUsed),
    });
  }

  return windows;
}

export interface GrokResetToken {
  tokenId?: string;
  expiresAt?: string;
}

interface WireField {
  field: number;
  wireType: number;
  varint?: number;
  bytes?: Uint8Array;
}

const TOKEN_ID_FIELDS = new Set([1, 10]);
const TOKEN_EXPIRY_FIELDS = new Set([2, 3, 20, 30]);

function decodeVarint(
  data: Uint8Array,
  offset: number,
): [number, number] | null {
  let value = 0;
  let multiplier = 1;
  let pos = offset;
  while (pos < data.length) {
    const byte = data[pos];
    if (byte === undefined) return null;
    pos += 1;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return [value, pos];
    multiplier *= 128;
    if (multiplier > 2 ** 53) return null;
  }
  return null;
}

function readWireFields(data: Uint8Array): WireField[] {
  const out: WireField[] = [];
  let pos = 0;
  while (pos < data.length) {
    const tag = decodeVarint(data, pos);
    if (!tag) return out;
    const [tagValue, afterTag] = tag;
    pos = afterTag;
    const field = Math.floor(tagValue / 8);
    const wireType = tagValue % 8;
    if (field <= 0) return out;
    if (wireType === 0) {
      const value = decodeVarint(data, pos);
      if (!value) return out;
      pos = value[1];
      out.push({ field, wireType, varint: value[0] });
    } else if (wireType === 2) {
      const length = decodeVarint(data, pos);
      if (!length) return out;
      pos = length[1];
      const end = pos + length[0];
      if (end > data.length) return out;
      out.push({ field, wireType, bytes: data.subarray(pos, end) });
      pos = end;
    } else if (wireType === 1) {
      const end = pos + 8;
      if (end > data.length) return out;
      out.push({ field, wireType, bytes: data.subarray(pos, end) });
      pos = end;
    } else if (wireType === 5) {
      const end = pos + 4;
      if (end > data.length) return out;
      out.push({ field, wireType, bytes: data.subarray(pos, end) });
      pos = end;
    } else {
      return out;
    }
  }
  return out;
}

function timestampFromMessage(data: Uint8Array): string | undefined {
  let seconds: number | undefined;
  let nanos = 0;
  for (const f of readWireFields(data)) {
    if (f.wireType !== 0 || f.varint == null) continue;
    if (f.field === 1) seconds = f.varint;
    else if (f.field === 2) nanos = f.varint;
  }
  if (seconds != null && Number.isFinite(seconds)) {
    return new Date(seconds * 1000 + Math.floor(nanos / 1_000_000)).toISOString();
  }
  const text = new TextDecoder().decode(data);
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function resetTokenFromMessage(data: Uint8Array): GrokResetToken | null {
  let tokenId: string | undefined;
  let expiresAt: string | undefined;
  for (const f of readWireFields(data)) {
    if (f.wireType !== 2 || !f.bytes) continue;
    if (TOKEN_ID_FIELDS.has(f.field)) {
      if (tokenId == null) {
        const candidate = new TextDecoder().decode(f.bytes).trim();
        if (candidate) tokenId = candidate;
      }
    } else if (TOKEN_EXPIRY_FIELDS.has(f.field)) {
      const ts = timestampFromMessage(f.bytes);
      if (ts) expiresAt = ts;
    }
  }
  return tokenId ? { tokenId, expiresAt } : null;
}

export function parseGrokResetsProto(data: Uint8Array): GrokResetToken[] {
  const out: GrokResetToken[] = [];
  const walk = (msg: Uint8Array) => {
    for (const f of readWireFields(msg)) {
      if (f.wireType !== 2 || !f.bytes) continue;
      if (!TOKEN_ID_FIELDS.has(f.field)) continue;
      const token = resetTokenFromMessage(f.bytes);
      if (token) out.push(token);
      else walk(f.bytes);
    }
  };
  walk(data);
  const seen = new Set<string>();
  return out.filter((t) => {
    const key = `${t.tokenId}|${t.expiresAt ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function grpcWebPayloads(data: Uint8Array): Uint8Array[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const payloads: Uint8Array[] = [];
  let pos = 0;
  while (pos + 5 <= data.length) {
    const flag = data[pos];
    if (flag === undefined) break;
    const length = view.getUint32(pos + 1);
    const end = pos + 5 + length;
    if (end > data.length) break;
    if ((flag & 0x80) === 0) payloads.push(data.subarray(pos + 5, end));
    pos = end;
  }
  if (payloads.length > 0 && pos === data.length) return payloads;
  return [data];
}

function jsonTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
    return undefined;
  }
  if (value && typeof value === "object") {
    const obj = value as { seconds?: unknown; nanos?: unknown };
    const seconds = Number(obj.seconds);
    if (Number.isFinite(seconds)) {
      const nanos = Number(obj.nanos);
      const nanoMs = Number.isFinite(nanos) ? Math.floor(nanos / 1_000_000) : 0;
      return new Date(seconds * 1000 + nanoMs).toISOString();
    }
  }
  return undefined;
}

export function resetsFromJson(parsed: unknown): GrokResetToken[] {
  let rawItems: unknown[] = [];
  if (Array.isArray(parsed)) {
    rawItems = parsed;
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    for (const key of ["tokens", "stillRedeemable", "resets"]) {
      if (Array.isArray(obj[key])) {
        rawItems = obj[key] as unknown[];
        break;
      }
    }
  }
  const out: GrokResetToken[] = [];
  for (const item of rawItems) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const tokenId = [obj.tokenId, obj.token_id, obj.id].find(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
    if (!tokenId) continue;
    const expiresAt = [
      obj.validityEnd,
      obj.validity_end,
      obj.expiresAt,
      obj.expires,
    ]
      .map(jsonTimestamp)
      .find((v): v is string => v != null);
    out.push({ tokenId: tokenId.trim(), expiresAt });
  }
  return out;
}

export function parseGrokResetsResponse(
  body: Uint8Array,
  contentType: string,
): GrokResetToken[] {
  const looksJson =
    contentType.toLowerCase().includes("json") ||
    body[0] === 0x7b ||
    body[0] === 0x5b;
  if (looksJson) {
    try {
      return resetsFromJson(JSON.parse(new TextDecoder().decode(body)));
    } catch {
      return [];
    }
  }
  const out: GrokResetToken[] = [];
  for (const payload of grpcWebPayloads(body)) {
    out.push(...parseGrokResetsProto(payload));
  }
  return out;
}

const GROK_RESET_RPC_BASES = [
  "https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets",
  "https://grok.com/grok_api_v2.ConsumerUiSvc/GetRemainingResets",
];

async function requestGrokResets(
  url: string,
  oauth: OAuthCredential,
  timeoutMs: number,
): Promise<GrokResetToken[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/grpc-web+proto",
        Accept: "application/grpc-web+proto, application/json",
        "connect-protocol-version": "1",
        "x-grpc-web": "1",
        Authorization: `Bearer ${oauth.access}`,
        Origin: "https://grok.com",
        Referer: "https://grok.com/",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      },
      body: new Uint8Array([0, 0, 0, 0, 0]),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    return parseGrokResetsResponse(buf, res.headers.get("content-type") || "");
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGrokResets(
  oauth: OAuthCredential,
  timeoutMs = 10_000,
): Promise<GrokResetToken[] | null> {
  for (const url of GROK_RESET_RPC_BASES) {
    const resets = await requestGrokResets(url, oauth, timeoutMs).catch(
      () => null,
    );
    if (resets) return resets;
  }
  return null;
}

function formatUtcMd(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function grokResetsToWindows(
  resets: GrokResetToken[] | null,
  display: ResetCreditsDisplay,
): UsageWindow[] {
  if (resets == null) return [];

  const now = Date.now();
  const available = resets
    .filter((r) => !r.expiresAt || Date.parse(r.expiresAt) > now)
    .sort(
      (a, b) =>
        (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) -
        (b.expiresAt ? Date.parse(b.expiresAt) : Infinity),
    );

  if (available.length === 0) {
    return [{ id: "resets", label: "Resets", note: "0 available" }];
  }

  const count = available.length;
  const soonest = available[0]?.expiresAt;

  if (display === "summary") {
    const parts: string[] = [`${count} available`];
    if (soonest) parts.push(`next exp ${formatUtcMd(soonest)}`);
    return [
      {
        id: "resets",
        label: "Resets",
        note: parts.join(" · "),
        resetsAt: soonest,
        resetAfterSeconds: secondsUntil(soonest),
      },
    ];
  }

  const out: UsageWindow[] = [
    { id: "resets", label: "Resets", note: `${count} available` },
  ];
  available.forEach((r, i) => {
    if (!r.expiresAt) return;
    out.push({
      id: `reset-${i}`,
      label: `  #${i + 1}`,
      note: `exp ${formatUtcMd(r.expiresAt)}`,
      resetsAt: r.expiresAt,
      resetAfterSeconds: secondsUntil(r.expiresAt),
    });
  });
  return out;
}

export async function fetchXai(
  auth?: AuthFile,
  sourcesOrPath?: OAuthSource[] | string,
): Promise<ProviderStatus> {
  const now = new Date().toISOString();
  const base = { id: "xai" as const, name: "Grok / xAI", fetchedAt: now };
  const sources = Array.isArray(sourcesOrPath)
    ? sourcesOrPath
    : typeof sourcesOrPath === "string" && auth
      ? [authFileSource("opencode", sourcesOrPath, auth, ["xai", "grok"])].filter(
          (s): s is OAuthSource => s != null,
        )
      : xaiSources(loadStores(auth));

  const fetchAll = async (token: OAuthCredential) => {
    const headers = grokHeaders(token);
    const [weekly, settings] = await Promise.all([
      fetchJson<GrokBillingResponse>(
        "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
        { headers },
      ),
      fetchJson<GrokSettingsResponse>(
        "https://cli-chat-proxy.grok.com/v1/settings",
        { headers },
      ).catch(() => null),
    ]);
    return { weekly, settings };
  };

  try {
    const { result: pack, source, cred } = await callWithOAuth(
      sources,
      (s) => xaiRefresher(s.clientId),
      fetchAll,
    );
    const windows = windowsFromBilling(pack.weekly.config || {});

    if (windows.length === 0) {
      return finalizeProvider({
        ...base,
        plan: pack.settings?.subscription_tier_display,
        ok: false,
        error: "No Grok weekly SuperGrok usage data",
        windows: [],
      });
    }

    const resets = await fetchGrokResets(cred);
    const cfg = loadConfig();
    windows.push(...grokResetsToWindows(resets, cfg.xai.resetCreditsDisplay));

    return finalizeProvider({
      ...base,
      plan: pack.settings?.subscription_tier_display,
      source: source.label,
      ok: true,
      windows,
    });
  } catch (err) {
    return finalizeProvider({
      ...base,
      ok: false,
      error: shortError(err),
      windows: [],
    });
  }
}
