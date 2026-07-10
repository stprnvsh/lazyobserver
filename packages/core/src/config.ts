/**
 * Config / registry for lazyobserver.
 *
 * Single JSON file at $LAZYOBSERVER_HOME/config.json holding:
 *  - profiles:   auth-only — a name pointing at a Claude config dir
 *                (switched via CLAUDE_CONFIG_DIR when launching sessions)
 *  - workspaces: named sets of repo folders; a repo may belong to several
 *                workspaces; a workspace may pin ONE profile so company code
 *                never runs on a personal account
 *  - settings:   feature toggles (redaction is OFF by default, by request)
 *
 * Integration tokens (ClickUp/GitHub) do NOT live here — they go to the OS
 * keychain (M4). This file is safe to read/print.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { paths } from "./paths.js";

// --------------------------------------------------------------------------
// schema
// --------------------------------------------------------------------------

export const ProfileSchema = z.object({
  name: z.string().min(1),
  /** Absolute path to the Claude config dir this profile uses (auth only). */
  claudeConfigDir: z.string().min(1),
});

export const WorkspaceSchema = z.object({
  name: z.string().min(1),
  /** Absolute, normalized repo folder paths. May overlap across workspaces. */
  repos: z.array(z.string()).default([]),
  /** Pinned profile name (optional). */
  profile: z.string().optional(),
  /** Task-source connections (M4). */
  connections: z
    .object({
      clickup: z
        .object({
          teamId: z.string(),
          /** optional: restrict to specific lists (else assigned-to-me, team-wide) */
          listIds: z.array(z.string()).default([]),
        })
        .optional(),
      github: z.object({ repos: z.array(z.string()) }).optional(),
    })
    .default({}),
});

export const SettingsSchema = z.object({
  redaction: z.object({ enabled: z.boolean() }).default({ enabled: false }),
  embeddings: z
    .object({
      model: z.string(),
      dimensions: z.number().int().positive(),
    })
    .default({ model: "Xenova/all-MiniLM-L6-v2", dimensions: 384 }),
});

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  profiles: z.array(ProfileSchema).default([]),
  workspaces: z.array(WorkspaceSchema).default([]),
  currentWorkspace: z.string().optional(),
  settings: SettingsSchema.default({}),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type Config = z.infer<typeof ConfigSchema>;

// --------------------------------------------------------------------------
// io
// --------------------------------------------------------------------------

export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Absolute path, tilde expanded, no trailing slash — matches transcript cwds. */
export function normalizeRepoPath(p: string): string {
  const abs = path.resolve(expandTilde(p));
  return abs !== "/" ? abs.replace(/\/+$/, "") : abs;
}

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await readFile(paths.configFile(), "utf8");
    return ConfigSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return ConfigSchema.parse({});
    }
    throw err;
  }
}

export async function saveConfig(cfg: Config): Promise<void> {
  const validated = ConfigSchema.parse(cfg);
  await mkdir(paths.home(), { recursive: true });
  await writeFile(
    paths.configFile(),
    JSON.stringify(validated, null, 2) + "\n",
    "utf8",
  );
}

// --------------------------------------------------------------------------
// profiles
// --------------------------------------------------------------------------

export async function addProfile(
  name: string,
  claudeConfigDir: string,
): Promise<Profile> {
  const cfg = await loadConfig();
  if (cfg.profiles.some((p) => p.name === name)) {
    throw new Error(`Profile "${name}" already exists.`);
  }
  const profile: Profile = {
    name,
    claudeConfigDir: path.resolve(expandTilde(claudeConfigDir)),
  };
  cfg.profiles.push(profile);
  await saveConfig(cfg);
  return profile;
}

export async function removeProfile(name: string): Promise<void> {
  const cfg = await loadConfig();
  const pinnedBy = cfg.workspaces.filter((w) => w.profile === name);
  if (pinnedBy.length > 0) {
    throw new Error(
      `Profile "${name}" is pinned by workspace(s): ${pinnedBy
        .map((w) => w.name)
        .join(", ")}. Unpin first.`,
    );
  }
  const before = cfg.profiles.length;
  cfg.profiles = cfg.profiles.filter((p) => p.name !== name);
  if (cfg.profiles.length === before) {
    throw new Error(`Profile "${name}" not found.`);
  }
  await saveConfig(cfg);
}

// --------------------------------------------------------------------------
// workspaces
// --------------------------------------------------------------------------

export async function addWorkspace(
  name: string,
  opts: { repos?: string[]; profile?: string },
): Promise<Workspace> {
  const cfg = await loadConfig();
  if (cfg.workspaces.some((w) => w.name === name)) {
    throw new Error(`Workspace "${name}" already exists.`);
  }
  if (opts.profile && !cfg.profiles.some((p) => p.name === opts.profile)) {
    throw new Error(`Unknown profile "${opts.profile}".`);
  }
  const ws: Workspace = WorkspaceSchema.parse({
    name,
    repos: [...new Set((opts.repos ?? []).map(normalizeRepoPath))],
    profile: opts.profile,
  });
  cfg.workspaces.push(ws);
  await saveConfig(cfg);
  return ws;
}

export async function removeWorkspace(name: string): Promise<void> {
  const cfg = await loadConfig();
  const before = cfg.workspaces.length;
  cfg.workspaces = cfg.workspaces.filter((w) => w.name !== name);
  if (cfg.workspaces.length === before) {
    throw new Error(`Workspace "${name}" not found.`);
  }
  if (cfg.currentWorkspace === name) cfg.currentWorkspace = undefined;
  await saveConfig(cfg);
}

export async function addRepoToWorkspace(
  workspace: string,
  repoPath: string,
): Promise<void> {
  const cfg = await loadConfig();
  const ws = cfg.workspaces.find((w) => w.name === workspace);
  if (!ws) throw new Error(`Workspace "${workspace}" not found.`);
  const normalized = normalizeRepoPath(repoPath);
  if (!ws.repos.includes(normalized)) ws.repos.push(normalized);
  await saveConfig(cfg);
}

export async function setCurrentWorkspace(name: string): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.workspaces.some((w) => w.name === name)) {
    throw new Error(`Unknown workspace "${name}".`);
  }
  cfg.currentWorkspace = name;
  await saveConfig(cfg);
}

/** Which workspaces contain this repo path? (a repo may be in several) */
export function workspacesForRepo(cfg: Config, repoPath: string): Workspace[] {
  const normalized = normalizeRepoPath(repoPath);
  return cfg.workspaces.filter((w) => w.repos.includes(normalized));
}
