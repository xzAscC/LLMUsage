import type { ProviderStatus, UsageSnapshot } from "./types.ts";
import { bar, formatReset } from "./util.ts";

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
    lines.push(`✓ ${head}  ·  ${pct}`);
    for (const w of p.windows) {
      if (w.usedPercent != null) {
        const reset = formatReset(w.resetsAt, w.resetAfterSeconds);
        const extra = w.note ? `  (${w.note})` : "";
        lines.push(
          `  ${w.label.padEnd(12)} ${bar(w.usedPercent)} ${Math.round(w.usedPercent).toString().padStart(3)}%  reset ${reset}${extra}`,
        );
      } else if (w.note) {
        lines.push(`  ${w.label.padEnd(12)} ${w.note}`);
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
    parts.push(`${shortName(p)}${Math.round(p.usedPercent)}%`);
  }

  const text = parts.join(" ");
  const tooltip = formatHuman(snapshot)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "\\n");

  const percentage =
    snapshot.worstUsedPercent != null
      ? Math.round(snapshot.worstUsedPercent)
      : 0;

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
    default:
      return p.id;
  }
}
