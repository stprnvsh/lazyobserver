/**
 * Requirements encoded here:
 *  - Merge installs hooks for every captured event + OTel env WITHOUT
 *    touching anything the user already has (their settings survive intact).
 *  - Idempotent: merging twice === merging once.
 *  - Env conflicts (user runs their own OTel) are REPORTED, never overwritten.
 *  - Unmerge removes exactly ours; user hooks/env keys stay.
 */
import { describe, expect, it } from "vitest";

import {
  HOOK_EVENTS,
  mergeSettings,
  otelEnv,
  unmergeSettings,
} from "../src/capture/settings.js";

const CMD = "/Users/x/.lazyobserver/bin/lazyobserver-hook.sh";

describe("mergeSettings", () => {
  it("adds hooks for all events and OTel env, preserving user settings", () => {
    const user = {
      model: "claude-fable-5[1m]",
      permissions: { allow: ["Bash(ls)"] },
      hooks: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "/my/own.sh" }] },
        ],
      },
    };
    const { settings, changed, envConflicts } = mergeSettings(user, CMD, 43179);

    expect(changed).toBe(true);
    expect(envConflicts).toEqual([]);
    // user's stuff untouched
    expect(settings.model).toBe("claude-fable-5[1m]");
    expect((settings.permissions as { allow: string[] }).allow).toEqual([
      "Bash(ls)",
    ]);
    const hooks = settings.hooks as Record<string, { hooks: { command: string }[] }[]>;
    expect(hooks.PostToolUse[0].hooks[0].command).toBe("/my/own.sh");
    // ours added everywhere
    for (const event of HOOK_EVENTS) {
      const all = hooks[event].flatMap((g) => g.hooks.map((h) => h.command));
      expect(all).toContain(CMD);
    }
    // env
    const env = settings.env as Record<string, string>;
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://127.0.0.1:43179");
    expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/json");
  });

  it("is idempotent", () => {
    const once = mergeSettings({}, CMD, 43179);
    const twice = mergeSettings(once.settings, CMD, 43179);
    expect(twice.changed).toBe(false);
    expect(JSON.stringify(twice.settings)).toBe(JSON.stringify(once.settings));
  });

  it("reports env conflicts without overwriting", () => {
    const user = { env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://my-collector:4318" } };
    const { settings, envConflicts } = mergeSettings(user, CMD, 43179);
    expect((settings.env as Record<string, string>).OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
      "http://my-collector:4318",
    );
    expect(envConflicts).toHaveLength(1);
    expect(envConflicts[0].key).toBe("OTEL_EXPORTER_OTLP_ENDPOINT");
  });
});

describe("unmergeSettings", () => {
  it("removes exactly ours; user hooks and env survive", () => {
    const user = {
      hooks: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "/my/own.sh" }] },
        ],
      },
      env: { MY_VAR: "1" },
    };
    const merged = mergeSettings(user, CMD, 43179).settings;
    const { settings, changed } = unmergeSettings(merged, 43179);

    expect(changed).toBe(true);
    const hooks = settings.hooks as Record<string, { hooks: { command: string }[] }[]>;
    // only the user's PostToolUse group remains; our events are gone
    expect(Object.keys(hooks)).toEqual(["PostToolUse"]);
    expect(hooks.PostToolUse.flatMap((g) => g.hooks.map((h) => h.command))).toEqual([
      "/my/own.sh",
    ]);
    expect(settings.env).toEqual({ MY_VAR: "1" });
    // every otel key we set is gone
    for (const key of Object.keys(otelEnv(43179))) {
      expect((settings.env as Record<string, string>)[key]).toBeUndefined();
    }
  });
});
