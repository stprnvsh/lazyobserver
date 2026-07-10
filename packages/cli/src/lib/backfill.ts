/**
 * Targeted backfill of MID-TURN prompts.
 *
 * Capture is forward-only by design, so prompts that were skipped before the
 * attachment parser existed are absent from the store. This repair rescans
 * recent transcript files for exactly the attachment lines (cheap string
 * prefilter — no full re-ingest of multi-hundred-MB histories), and queues
 * the recovered prompts through the spool with the SAME deterministic ids the
 * live tailer uses — so it is idempotent and duplicates are impossible.
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import {
  chunkText,
  loadConfig,
  normalizeRepoPath,
  workspacesForRepo,
} from "@lazyobserver/core";
import { parseTranscriptLine } from "@lazyobserver/daemon";
import { queueMemWrite } from "@lazyobserver/daemon/memwrite";

export interface BackfillResult {
  filesScanned: number;
  promptsRecovered: number;
  eventsQueued: number;
  messagesQueued: number;
}

export async function backfillPrompts(days: number): Promise<BackfillResult> {
  const cfg = await loadConfig();
  const cutoff = Date.now() - days * 86_400_000;
  const result: BackfillResult = {
    filesScanned: 0,
    promptsRecovered: 0,
    eventsQueued: 0,
    messagesQueued: 0,
  };

  for (const profile of cfg.profiles) {
    const root = path.join(profile.claudeConfigDir, "projects");
    let entries;
    try {
      entries = await readdir(root, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => path.join(e.parentPath ?? root, e.name));

    for (const file of files) {
      try {
        if ((await stat(file)).mtimeMs < cutoff) continue;
      } catch {
        continue;
      }
      result.filesScanned++;

      const rl = readline.createInterface({
        input: createReadStream(file, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        // cheap prefilter — only attachment/queued_command lines get parsed
        if (
          !line.includes('"type":"attachment"') ||
          !line.includes("queued_command")
        ) {
          continue;
        }
        const { messages, meta } = parseTranscriptLine(line);
        const queued = messages.filter((m) => m.queuedPrompt);
        if (queued.length === 0 || !meta) continue;
        if (queued[0].ts < cutoff) continue;
        result.promptsRecovered++;

        const repo = meta.cwd ? normalizeRepoPath(meta.cwd) : "";
        const workspace = repo
          ? workspacesForRepo(cfg, repo)
              .map((w) => w.name)
              .join(",")
          : "";

        // same ids as the live tailer -> idempotent with past/future ingest
        await queueMemWrite({
          table: "events",
          row: {
            id: `att-${queued[0].uuid}`,
            ts: queued[0].ts,
            session_id: queued[0].sessionId,
            surface: meta.surface ?? "",
            actor: "user",
            kind: "prompt",
            repo,
            workspace,
            branch: meta.gitBranch ?? "",
            task_id: "",
            payload: JSON.stringify({
              prompt: queued[0].text.slice(0, 6000),
              queued: true,
            }),
            tokens_in: 0,
            tokens_out: 0,
            cost_usd: 0,
          },
        });
        result.eventsQueued++;

        for (const m of queued) {
          for (const chunk of chunkText(m.text)) {
            await queueMemWrite({
              table: "messages",
              row: {
                id: `${m.uuid}#${m.blockIx}#${chunk.seq}`,
                session_id: m.sessionId,
                ts: m.ts,
                role: "user",
                seq: chunk.seq,
                content: chunk.text,
                repo,
                profile: profile.name,
              },
            });
            result.messagesQueued++;
          }
        }
      }
    }
  }
  return result;
}
