/**
 * Transcript tailer — watches every profile's `<configDir>/projects` tree
 * and incrementally ingests appended JSONL lines into `messages` +
 * session rollups.
 *
 * Efficiency contract (real transcripts reach 163+ MB):
 *  - per-file byte offsets, persisted across restarts
 *  - only the appended slice is ever read; partial trailing lines wait
 *    for the next sweep
 *  - on the VERY FIRST scan, pre-existing files start at EOF (no historic
 *    backfill — that's an explicit M3 import, not a surprise CPU burn)
 */
import { open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  chunkText,
  normalizeRepoPath,
  paths,
  redactSecrets,
  workspacesForRepo,
  type Config,
} from "@lazyobserver/core";

import type { Writer } from "../ingest/writer.js";
import { parseTranscriptLine } from "./parser.js";

interface TailState {
  initializedAt: number | null;
  offsets: Record<string, number>;
}

export class TranscriptTailer {
  private state: TailState = { initializedAt: null, offsets: {} };
  private stateFile = path.join(paths.home(), "transcript-state.json");
  readonly counters = { linesParsed: 0, messagesQueued: 0, filesTracked: 0 };

  constructor(
    /** watch roots: absolute `<configDir>/projects` per profile */
    private readonly roots: { profile: string; dir: string }[],
    private readonly writer: Writer,
    private readonly getConfig: () => Config,
  ) {}

  async loadState(): Promise<void> {
    try {
      this.state = JSON.parse(await readFile(this.stateFile, "utf8"));
    } catch {
      this.state = { initializedAt: null, offsets: {} };
    }
  }

  async saveState(): Promise<void> {
    const tmp = `${this.stateFile}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state), "utf8");
    await rename(tmp, this.stateFile);
  }

  private async listTranscripts(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, {
        recursive: true,
        withFileTypes: true,
      });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => path.join(e.parentPath ?? dir, e.name));
    } catch {
      return [];
    }
  }

  /** One sweep across all roots. Returns number of new lines processed. */
  async sweep(): Promise<number> {
    const firstScan = this.state.initializedAt === null;
    let processed = 0;

    for (const root of this.roots) {
      const files = await this.listTranscripts(root.dir);
      this.counters.filesTracked = files.length;
      for (const file of files) {
        const known = this.state.offsets[file];
        let size: number;
        try {
          size = (await stat(file)).size;
        } catch {
          continue; // deleted between listing and stat
        }

        if (known === undefined) {
          // Pre-existing files (first scan ever) start at EOF: no backfill.
          this.state.offsets[file] = firstScan ? size : 0;
          if (firstScan) continue;
        }
        const offset = this.state.offsets[file];
        if (size <= offset) continue;

        processed += await this.ingestSlice(file, offset, size, root.profile);
      }
    }

    if (firstScan) this.state.initializedAt = Date.now();
    await this.saveState();
    return processed;
  }

  private async ingestSlice(
    file: string,
    offset: number,
    size: number,
    profile: string,
  ): Promise<number> {
    const fh = await open(file, "r");
    let text: string;
    try {
      const { buffer, bytesRead } = await fh.read({
        buffer: Buffer.alloc(size - offset),
        position: offset,
      });
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }

    // only complete lines; the partial tail is re-read next sweep
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return 0;
    const complete = text.slice(0, lastNl);
    this.state.offsets[file] = offset + Buffer.byteLength(complete, "utf8") + 1;

    const cfg = this.getConfig();
    let count = 0;
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      this.counters.linesParsed++;
      const { messages, meta } = parseTranscriptLine(line);

      if (meta) {
        const repo = meta.cwd ? normalizeRepoPath(meta.cwd) : "";
        this.writer.touchSession({
          id: meta.sessionId,
          started_at: meta.ts,
          ended_at: meta.ts,
          repo,
          workspace: repo
            ? workspacesForRepo(cfg, repo)
                .map((w) => w.name)
                .join(",")
            : "",
          branch: meta.gitBranch ?? "",
          profile,
          surface: meta.surface ?? "",
          model: meta.model ?? "",
          tokens_in: meta.usage?.input ?? 0,
          tokens_out: meta.usage?.output ?? 0,
        });
      }

      const redactionOn = cfg.settings.redaction.enabled;
      for (const m of messages) {
        const repo = meta?.cwd ? normalizeRepoPath(meta.cwd) : "";
        // queued mid-turn prompts fire no hook — synthesize their prompt event
        // so the timeline and user-prompt counts stay complete
        if (m.queuedPrompt && m.blockIx === 0) {
          const text = redactionOn ? redactSecrets(m.text).text : m.text;
          this.writer.queueEvent({
            id: `att-${m.uuid}`,
            ts: m.ts,
            session_id: m.sessionId,
            surface: meta?.surface ?? "",
            actor: "user",
            kind: "prompt",
            repo,
            workspace: repo
              ? workspacesForRepo(cfg, repo)
                  .map((w) => w.name)
                  .join(",")
              : "",
            branch: meta?.gitBranch ?? "",
            task_id: "",
            payload: JSON.stringify({ prompt: text.slice(0, 6000), queued: true }),
            tokens_in: 0,
            tokens_out: 0,
            cost_usd: 0,
          });
        }
        for (const chunk of chunkText(m.text)) {
          this.writer.queueMessage({
            id: `${m.uuid}#${m.blockIx}#${chunk.seq}`,
            session_id: m.sessionId,
            ts: m.ts,
            role: m.role,
            seq: chunk.seq,
            content: redactionOn ? redactSecrets(chunk.text).text : chunk.text,
            repo,
            profile,
          });
          this.counters.messagesQueued++;
        }
      }
      count++;
    }
    return count;
  }
}
