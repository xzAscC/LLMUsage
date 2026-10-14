import type { ProviderStatus, UsageSnapshot } from "./types.ts";
import { paceSummary } from "./pace.ts";
import { bar, formatReset } from "./util.ts";

function ago(iso?: string): string {
  if (!iso) return "?";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return "?";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function formatHuman(snapshot: UsageSnapshot): string {
  const lines: string[] = [];
  lines.push(`LLM Usage  ·  ${snapshot.fetchedAt}`);
  lines.push("");

  for (const p of snapshot.providers) {
    const head = p.plan ? `${p.name} (${p.plan})` : p.name;
    if (!p.ok) {
      lines.push(`✗ ${head}`);
      lines.push(`  error: ${p.error || "unknown"}`);
      lines.push("");
      continue;
    }

    const pct =
      p.usedPercent != null ? `${Math.round(p.usedPercent)}% used` : "—";
    const via = p.source ? `  ·  via ${p.source}` : "";
    lines.push(`${p.stale ? "~" : "✓"} ${head}  ·  ${pct}${via}`);
    if (p.stale) {
      lines.push(`  stale: as of ${ago(p.asOf)} — ${p.error || "refresh failed"}`);
    }
    const pad = Math.max(12, ...p.windows.map((w) => w.label.length));
    for (const w of p.windows) {
      if (w.usedPercent != null) {
        const reset = formatReset(w.resetsAt, w.resetAfterSeconds);
        const extra = w.note ? `  (${w.note})` : "";
        const pace = w.pace ? `  · ${paceSummary(w.pace)}` : "";
        lines.push(
          `  ${w.label.padEnd(pad)} ${bar(w.usedPercent)} ${Math.round(w.usedPercent).toString().padStart(3)}%  reset ${reset}${pace}${extra}`,
        );
      } else if (w.note) {
        lines.push(`  ${w.label.padEnd(pad)} ${w.note}`);
      }
    }
    lines.push("");
  }

  if (snapshot.worstUsedPercent != null) {
    lines.push(
      `worst: ${Math.round(snapshot.worstUsedPercent)}%  severity: ${snapshot.severity}`,
    );
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function formatWaybar(snapshot: UsageSnapshot): string {
  const parts: string[] = [];
  for (const p of snapshot.providers) {
    if (!p.ok) {
      parts.push(`${shortName(p)}!`);
      continue;
    }
    if (p.usedPercent == null) {
      parts.push(`${shortName(p)}—`);
      continue;
    }
    parts.push(`${shortName(p)}${Math.round(p.usedPercent)}%${p.stale ? "~" : ""}`);
  }

  const text = parts.join(" ");
  const tooltip = formatHuman(snapshot)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "\\n");

  const headline = snapshot.headlinePercent ?? snapshot.worstUsedPercent;
  const percentage = headline != null ? Math.round(headline) : 0;

  return JSON.stringify({
    text: `󰧑 ${text}`,
    tooltip,
    class: snapshot.severity,
    percentage,
    alt: snapshot.severity,
  });
}

function shortName(p: ProviderStatus): string {
  switch (p.id) {
    case "openai":
      return "OAI";
    case "zai":
      return "GLM";
    case "xai":
      return "GRK";
    case "anthropic":
      return "CLD";
    case "kimi":
      return "KMI";
    case "minimax":
      return "MMX";
    case "antigravity":
      return "AGY";
    default:
      return p.id.startsWith("anthropic-") ? `CLD ${p.name.slice("Claude ".length)}` : p.id;
  }
}
