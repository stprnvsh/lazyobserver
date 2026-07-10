/**
 * Minimal frontmatter parser for the existing Claude auto-memory format:
 *
 *   ---
 *   name: some-slug
 *   description: "one line"
 *   metadata:
 *     type: project
 *   ---
 *   body…
 *
 * Handles the real variants found on this machine: top-level `type:`,
 * nested `metadata: type:`, quoted values, and files with no frontmatter.
 * No YAML dependency — the format is shallow and regular.
 */

export interface ParsedMemoryFile {
  name: string;
  description: string;
  type: string;
  body: string;
}

function unquote(v: string): string {
  const t = v.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

export function parseMemoryFile(content: string): ParsedMemoryFile {
  const out: ParsedMemoryFile = {
    name: "",
    description: "",
    type: "",
    body: content.trim(),
  };
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return out;

  const [, fm, body] = m;
  out.body = body.trim();
  let inMetadata = false;
  for (const raw of fm.split(/\r?\n/)) {
    const indented = /^\s+/.test(raw);
    const line = raw.trim();
    if (!line) continue;
    if (!indented) inMetadata = false;

    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;

    if (!indented && key === "metadata" && value === "") {
      inMetadata = true;
      continue;
    }
    if (key === "name" && !indented) out.name = unquote(value);
    else if (key === "description" && !indented) out.description = unquote(value);
    else if (key === "type" && (inMetadata || !indented) && !out.type)
      out.type = unquote(value);
  }
  return out;
}

/** existing auto-memory type -> lazyobserver memory kind */
export function mapKind(type: string): string {
  switch (type) {
    case "feedback":
      return "preference";
    case "user":
      return "preference";
    case "reference":
      return "reference";
    case "project":
      return "feature";
    default:
      return "feature";
  }
}
