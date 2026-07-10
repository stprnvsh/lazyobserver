/**
 * `lzo ask "<question>"` — terminal recall across both memory planes and the
 * captured conversations. Retrieval (not generation): shows the matching
 * records so you can see exactly what the system knows.
 */
import {
  Embedder,
  smartSearch,
  Store,
  TABLES,
} from "@lazyobserver/core";

import { heading, info } from "../ui.js";

function date(ms: unknown): string {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString().slice(0, 10) : "";
}

export async function askCommand(
  question: string,
  opts: { k: string },
): Promise<void> {
  const store = await Store.open();
  const embedder = new Embedder();
  const vector = await embedder.embedOne(question);
  const k = Number(opts.k) || 5;

  const [mem, daily, msgs] = await Promise.all([
    smartSearch(store, TABLES.codebaseMemory, {
      query: question,
      vector,
      k,
      where: "status = 'active'",
    }),
    smartSearch(store, TABLES.dailyMemory, { query: question, vector, k }),
    smartSearch(store, TABLES.messages, { query: question, vector, k }),
  ]);

  if (mem.rows.length > 0) {
    heading(`codebase memory (${mem.mode})`);
    for (const r of mem.rows) {
      info(
        `[${r.kind}] ${r.title}  (${String(r.repo).split("/").pop() || "global"}, ${date(r.updated_at)})`,
      );
      console.log(`    ${String(r.body).replace(/\s+/g, " ").slice(0, 220)}`);
    }
  }
  if (daily.rows.length > 0) {
    heading("journal");
    for (const r of daily.rows) {
      info(`[${r.date} ${r.kind}] ${r.title || ""}`);
      console.log(`    ${String(r.body).replace(/\s+/g, " ").slice(0, 220)}`);
    }
  }
  if (msgs.rows.length > 0) {
    heading("conversations");
    for (const r of msgs.rows) {
      info(
        `[${date(r.ts)} ${r.role}] ${String(r.repo).split("/").pop() || ""} · session ${String(r.session_id).slice(0, 8)}`,
      );
      console.log(`    ${String(r.content).replace(/\s+/g, " ").slice(0, 220)}`);
    }
  }
  if (mem.rows.length + daily.rows.length + msgs.rows.length === 0) {
    info("nothing found — is the daemon capturing? (lzo status)");
  }
}
