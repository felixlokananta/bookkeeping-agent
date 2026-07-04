import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface OutputGuardResult {
  flagged: boolean;
  matchedPatterns: string[];
}

// Code-level backstop for AGENTS.md's Boundaries & Safety rules 1/4/5 (Issue
// #43), which are prompt-only and therefore not guaranteed to hold. This
// catches the concrete, regex-checkable leaks confirmed in manual testing —
// absolute filesystem paths and shell recipes for reading .env/secrets — not
// general scope-creep (e.g. answering an off-topic coding question), which
// has no reliable textual signature and is left to the prompt wording.
const OUTPUT_GUARD_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "absolute-home-path", pattern: /\/(?:Users|home)\/[^\s'"`)]+/ },
  { label: "windows-user-path", pattern: /[A-Za-z]:\\Users\\[^\s'"`)]+/i },
  {
    label: "env-file-shell-command",
    pattern: /\b(?:cat|ls|less|more|head|tail|vim|nano|type)\b[\s\S]{0,30}\.env\b/i,
  },
  {
    label: "env-file-shell-command-reversed",
    pattern: /\.env\b[\s\S]{0,30}\b(?:cat|ls|less|more|head|tail)\b/i,
  },
];

export function scanAssistantOutput(text: string | null | undefined): OutputGuardResult {
  if (!text) return { flagged: false, matchedPatterns: [] };
  const matched = OUTPUT_GUARD_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    (p) => p.label
  );
  return { flagged: matched.length > 0, matchedPatterns: matched };
}

// Assistant messages interleave text with thinking/tool-call parts; only the
// text parts are ever shown to the operator; that's the concatenation to scan.
export function extractAssistantText(message: unknown): string {
  if (
    !message ||
    typeof message !== "object" ||
    (message as { role?: unknown }).role !== "assistant" ||
    !Array.isArray((message as { content?: unknown }).content)
  ) {
    return "";
  }
  return (message as { content: unknown[] }).content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
    )
    .map((part) => part.text)
    .join("");
}

// Appends to the same operator-facing log the ledger's own anomaly checks
// use (memory/anomaly_log.json, or BOOKKEEPING_ANOMALY_LOG_PATH in tests),
// so there's one place to review anomalies rather than two. Written
// independently of .pi/extensions/bookkeeping/policy.ts's logAnomaly()
// (same file, same shape) to keep server/ free of a dependency on the pi
// extension tree, matching this directory's existing modules.
export function logBoundaryDisclosure(detail: string): void {
  const logPath =
    process.env.BOOKKEEPING_ANOMALY_LOG_PATH || join(process.cwd(), "memory", "anomaly_log.json");
  let log: unknown[] = [];

  try {
    const parsed = JSON.parse(readFileSync(logPath, "utf-8"));
    if (Array.isArray(parsed)) log = parsed;
  } catch {
    // File missing or malformed; start fresh
  }

  log.push({
    ts: new Date().toISOString(),
    kind: "boundary_disclosure",
    detail,
  });

  writeFileSync(logPath, JSON.stringify(log, null, 2), "utf-8");
}
