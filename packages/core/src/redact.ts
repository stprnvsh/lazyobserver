/**
 * Secret scrubbing — the optional redaction pass (OFF by default; everything
 * is local-first, so this is for users who want defence-in-depth or plan to
 * share exports).
 *
 * When enabled it runs at CAPTURE time (event payloads, transcript messages,
 * memory writes) and at EXPORT time (reports, day docs). Deliberately
 * aggressive: a false positive costs a hint of context, a false negative
 * leaks a credential.
 */

export interface RedactionResult {
  text: string;
  hits: number;
}

const PATTERNS: [RegExp, string][] = [
  // key material blocks
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED:private-key]",
  ],
  // AWS
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED:aws-key-id]"],
  // GitHub tokens (classic + fine-grained)
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED:github-token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED:github-token]"],
  // Slack
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED:slack-token]"],
  // ClickUp personal keys
  [/\bpk_\d+_[A-Z0-9]{16,}\b/g, "[REDACTED:clickup-key]"],
  // OpenAI-style
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED:api-key]"],
  // JWTs
  [
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
    "[REDACTED:jwt]",
  ],
  // Authorization: Bearer ...
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{15,}/gi, "$1 [REDACTED]"],
  // credentials embedded in URLs — ANY scheme (postgres://, redis://, ...)
  [/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, "$1$2:[REDACTED]@"],
  // generic key/value assignments, including prefixed env-style names
  // (PGPASSWORD=..., DB_SECRET: "...", MY_API_KEY=...)
  [
    /\b(\w*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret))(["']?\s*[=:]\s*["']?)([^\s"'&,;]{6,})/gi,
    "$1$2[REDACTED]",
  ],
];

export function redactSecrets(text: string): RedactionResult {
  let out = text;
  let hits = 0;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, (...args) => {
      hits++;
      // support $1-style backrefs in replacements
      return replacement.replace(/\$(\d)/g, (_, d) => String(args[Number(d) - 1] ?? ""));
    });
  }
  return { text: out, hits };
}

/** Redact every string field of a record (memory rows, task rows, ...). */
export function redactRecord(
  row: Record<string, unknown>,
): { row: Record<string, unknown>; hits: number } {
  let hits = 0;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "string") {
      const r = redactSecrets(v);
      out[k] = r.text;
      hits += r.hits;
    } else {
      out[k] = v;
    }
  }
  return { row: out, hits };
}
