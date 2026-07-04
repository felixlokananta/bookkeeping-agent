import { readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

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
    // Deliberately shell-specific verbs only (not "more"/"head"/"tail"/"type",
    // which are common English words and would false-positive on ordinary
    // sentences that merely mention ".env" without suggesting a command).
    label: "env-file-shell-command",
    pattern: /\b(?:cat|ls|less|vim|nano)\b[\s\S]{0,30}\.env\b/i,
  },
  {
    label: "env-file-shell-command-reversed",
    pattern: /\.env\b[\s\S]{0,30}\b(?:cat|ls|less|vim|nano)\b/i,
  },
];

// Tools legitimately echo back absolute paths under the project's own data/
// directory (e.g. tax_year_export's confirmation text names the exact CSV
// path it just wrote, built from process.cwd()). AGENTS.md rule 4 carves
// this out as in-scope ("what's my auto-post limit?"-style specific
// answers); the guard needs the same carve-out or every export/import tool
// call would falsely read as pi disclosing its own working directory.
const SAFE_PATH_PREFIX = join(process.cwd(), "data") + sep;

function stripSafePaths(text: string): string {
  const escapedPrefix = SAFE_PATH_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${escapedPrefix}[^\\s'"\`)]*`, "g"), "");
}

export function scanAssistantOutput(text: string | null | undefined): OutputGuardResult {
  if (!text) return { flagged: false, matchedPatterns: [] };
  const sanitized = stripSafePaths(text);
  const matched = OUTPUT_GUARD_PATTERNS.filter(({ pattern }) => pattern.test(sanitized)).map(
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
// This runs synchronously inside session.subscribe()'s listener
// (server/server.ts), which pi-agent-core invokes with no surrounding
// try/catch — an uncaught throw here would propagate out of message_end
// handling and turn an already-successfully-streamed chat response into a
// user-facing SSE error. As a best-effort audit log, a write failure must
// never do that, so every failure mode here is swallowed (and reported to
// stderr for operator visibility) rather than thrown.
export function logBoundaryDisclosure(detail: string): void {
  try {
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
  } catch (err) {
    console.error("logBoundaryDisclosure: failed to write anomaly log:", err);
  }
}
