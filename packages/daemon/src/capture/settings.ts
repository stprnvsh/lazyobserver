/**
 * Non-destructive merge of lazyobserver's hooks + OTel env into a Claude
 * settings.json object. Pure functions — file IO lives in install.ts.
 *
 * Rules:
 *  - Never remove or reorder anything the user already has.
 *  - Idempotent: re-running install produces the identical object.
 *  - Our entries are identified by HOOK_MARKER in the command path, so
 *    uninstall removes exactly ours and nothing else.
 *  - env keys are only ADDED; an existing conflicting value is reported,
 *    never overwritten (the user may run their own OTel collector).
 */
import { HOOK_MARKER } from "./script.js";

/** Events we capture. PostToolUse carries the granular tool trace. */
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "SessionEnd",
  "PreCompact",
] as const;

/** Tool-name-matched events need a matcher; "*" = all tools. */
const MATCHER_EVENTS = new Set(["PostToolUse"]);

export function otelEnv(otlpPort: number): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${otlpPort}`,
    OTEL_METRIC_EXPORT_INTERVAL: "30000",
    OTEL_LOGS_EXPORT_INTERVAL: "10000",
  };
}

interface HookEntry {
  type: "command";
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

type Settings = Record<string, unknown> & {
  hooks?: Record<string, HookGroup[]>;
  env?: Record<string, string>;
};

function isOurs(entry: HookEntry): boolean {
  return (
    typeof entry.command === "string" && entry.command.includes(HOOK_MARKER)
  );
}

export interface MergeResult {
  settings: Settings;
  changed: boolean;
  envConflicts: { key: string; existing: string; wanted: string }[];
}

/** Add our hooks + env to a settings object (deep-copied). */
export function mergeSettings(
  input: Record<string, unknown>,
  hookCommand: string,
  otlpPort: number,
  briefCommand?: string,
): MergeResult {
  const settings = JSON.parse(JSON.stringify(input)) as Settings;
  let changed = false;

  settings.hooks = settings.hooks ?? {};
  for (const event of HOOK_EVENTS) {
    const groups: HookGroup[] = (settings.hooks[event] =
      settings.hooks[event] ?? []);
    const present = groups.some((g) => (g.hooks ?? []).some(isOurs));
    if (!present) {
      const group: HookGroup = {
        hooks: [{ type: "command", command: hookCommand, timeout: 5 }],
      };
      if (MATCHER_EVENTS.has(event)) group.matcher = "*";
      groups.push(group);
      changed = true;
    }
  }

  // SessionStart context brief — a SECOND SessionStart command whose stdout
  // Claude Code injects as session context (yesterday, repo memories, tools).
  if (briefCommand) {
    const groups = (settings.hooks.SessionStart = settings.hooks.SessionStart ?? []);
    const present = groups.some((g) =>
      (g.hooks ?? []).some((h) => h.command === briefCommand),
    );
    if (!present) {
      groups.push({
        hooks: [{ type: "command", command: briefCommand, timeout: 10 }],
      });
      changed = true;
    }
  }

  const envConflicts: MergeResult["envConflicts"] = [];
  settings.env = settings.env ?? {};
  for (const [key, wanted] of Object.entries(otelEnv(otlpPort))) {
    const existing = settings.env[key];
    if (existing === undefined) {
      settings.env[key] = wanted;
      changed = true;
    } else if (existing !== wanted) {
      envConflicts.push({ key, existing, wanted });
    }
  }

  return { settings, changed, envConflicts };
}

/** Remove exactly our hooks and our (unchanged) env keys. */
export function unmergeSettings(
  input: Record<string, unknown>,
  otlpPort: number,
): { settings: Settings; changed: boolean } {
  const settings = JSON.parse(JSON.stringify(input)) as Settings;
  let changed = false;

  if (settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      const groups = settings.hooks[event]
        .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
        .filter((g) => g.hooks.length > 0);
      if (groups.length !== settings.hooks[event].length ||
          groups.some((g, i) => g.hooks.length !== (settings.hooks![event][i]?.hooks ?? []).length)) {
        changed = true;
      }
      if (groups.length === 0) delete settings.hooks[event];
      else settings.hooks[event] = groups;
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }

  if (settings.env) {
    for (const [key, ours] of Object.entries(otelEnv(otlpPort))) {
      if (settings.env[key] === ours) {
        delete settings.env[key];
        changed = true;
      }
    }
    if (Object.keys(settings.env).length === 0) delete settings.env;
  }

  return { settings, changed };
}
