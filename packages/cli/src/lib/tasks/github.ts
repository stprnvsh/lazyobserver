/**
 * GitHub Issues adapter — rides on the `gh` CLI (already authenticated
 * locally; zero token management, auth never leaves the machine).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { mapGitHubStatus, type UnifiedTask } from "./model.js";

const run = promisify(execFile);

export type GhRunner = (args: string[]) => Promise<string>;

export const defaultGhRunner: GhRunner = async (args) => {
  const { stdout } = await run("gh", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

interface GhIssue {
  number: number;
  title: string;
  body?: string;
  state: string;
  url: string;
  labels?: { name: string }[];
  milestone?: { title?: string } | null;
  assignees?: { login: string }[];
  updatedAt?: string;
}

export class GitHubAdapter {
  constructor(
    private readonly repos: string[],
    private readonly gh: GhRunner = defaultGhRunner,
  ) {}

  private toUnified(repo: string, i: GhIssue): UnifiedTask {
    return {
      id: `github:${repo}#${i.number}`,
      source: "github",
      source_id: `${repo}#${i.number}`,
      title: i.title,
      description: i.body ?? "",
      status: mapGitHubStatus(i),
      raw_status: i.state,
      sprint: i.milestone?.title ?? "",
      url: i.url,
      assignee: (i.assignees ?? []).map((a) => a.login).filter(Boolean).join(", "),
      due: "",
      updated_at: i.updatedAt ? Date.parse(i.updatedAt) : Date.now(),
    };
  }

  async pull(): Promise<UnifiedTask[]> {
    const all: UnifiedTask[] = [];
    for (const repo of this.repos) {
      const out = await this.gh([
        "issue",
        "list",
        "-R",
        repo,
        "--assignee",
        "@me",
        "--state",
        "open",
        "--json",
        "number,title,body,state,url,labels,milestone,assignees,updatedAt",
        "--limit",
        "200",
      ]);
      const issues = JSON.parse(out || "[]") as GhIssue[];
      all.push(...issues.map((i) => this.toUnified(repo, i)));
    }
    return all;
  }

  private split(sourceId: string): { repo: string; number: string } {
    const [repo, number] = sourceId.split("#");
    return { repo, number };
  }

  async start(sourceId: string): Promise<void> {
    const { repo, number } = this.split(sourceId);
    // GitHub has no native in-progress state — a label is the convention.
    await this.gh([
      "issue",
      "edit",
      number,
      "-R",
      repo,
      "--add-label",
      "in-progress",
    ]).catch(() => undefined); // label may not exist — non-fatal
  }

  async complete(sourceId: string, note: string): Promise<void> {
    const { repo, number } = this.split(sourceId);
    if (note) {
      await this.gh(["issue", "comment", number, "-R", repo, "--body", note]);
    }
    await this.gh(["issue", "close", number, "-R", repo]);
  }

  /** Best-effort PR lookup for a branch (enriches tasks + reports). */
  async prForBranch(
    repo: string,
    branch: string,
  ): Promise<{ url: string; state: string } | null> {
    try {
      const out = await this.gh([
        "pr",
        "list",
        "-R",
        repo,
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "url,state",
        "--limit",
        "1",
      ]);
      const prs = JSON.parse(out || "[]") as { url: string; state: string }[];
      return prs[0] ?? null;
    } catch {
      return null;
    }
  }
}
