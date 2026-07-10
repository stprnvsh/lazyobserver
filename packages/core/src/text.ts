/**
 * Text chunking for embedding. all-MiniLM effectively reads ~256 tokens;
 * we chunk long content to ~1200 chars with a small overlap so retrieval
 * hits stay coherent. Chunk boundaries prefer newlines, then spaces.
 */
export interface Chunk {
  seq: number;
  text: string;
}

export function chunkText(
  text: string,
  opts: { size?: number; overlap?: number } = {},
): Chunk[] {
  const size = opts.size ?? 1200;
  const overlap = Math.min(opts.overlap ?? 120, size - 1);
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= size) return [{ seq: 0, text: trimmed }];

  const chunks: Chunk[] = [];
  let start = 0;
  let seq = 0;
  while (start < trimmed.length) {
    let end = Math.min(start + size, trimmed.length);
    if (end < trimmed.length) {
      // prefer breaking at a newline, then a space, inside the last 20%
      const window = trimmed.slice(start + Math.floor(size * 0.8), end);
      const nl = window.lastIndexOf("\n");
      const sp = window.lastIndexOf(" ");
      const cut = nl >= 0 ? nl : sp;
      if (cut >= 0) end = start + Math.floor(size * 0.8) + cut + 1;
    }
    chunks.push({ seq, text: trimmed.slice(start, end).trim() });
    seq++;
    if (end >= trimmed.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter((c) => c.text.length > 0);
}
