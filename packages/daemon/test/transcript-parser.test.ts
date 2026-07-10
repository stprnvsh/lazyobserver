/**
 * Requirements encoded here (fixtures mirror REAL transcript lines observed
 * on this machine, 2026-07 — user/assistant among 11 line types):
 *  - user text, assistant text AND thinking blocks become messages;
 *    thinking is first-class (role "thinking") — it IS the thought process
 *    daily memory must capture.
 *  - tool_use / tool_result / image blocks are NOT messages (events own them).
 *  - non-conversation line types (queue-operation, ai-title, ...) are ignored.
 *  - assistant usage tokens and model are extracted; entrypoint
 *    "claude-vscode" maps to surface vscode.
 *  - malformed lines never throw.
 */
import { describe, expect, it } from "vitest";

import { parseTranscriptLine } from "../src/transcript/parser.js";

const base = {
  parentUuid: null,
  isSidechain: false,
  userType: "external",
  cwd: "/Users/pranavsateesh/django_base_login",
  sessionId: "45ea59d9-6634-4e17-bf29-04144bc896ea",
  version: "2.1.107",
  gitBranch: "add-mfa-status",
  entrypoint: "claude-vscode",
  uuid: "aaaa-1111",
  timestamp: "2026-07-10T08:48:49.382Z",
};

describe("parseTranscriptLine", () => {
  it("extracts user text with session meta and surface", () => {
    const line = JSON.stringify({
      ...base,
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "fix the webhook" }] },
    });
    const { messages, meta } = parseTranscriptLine(line);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "user",
      text: "fix the webhook",
      uuid: "aaaa-1111",
      sessionId: base.sessionId,
    });
    expect(meta).toMatchObject({
      cwd: base.cwd,
      gitBranch: "add-mfa-status",
      surface: "vscode",
    });
  });

  it("extracts assistant text + thinking, model and usage", () => {
    const line = JSON.stringify({
      ...base,
      type: "assistant",
      uuid: "bbbb-2222",
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        usage: { input_tokens: 3017, output_tokens: 329, cache_read_input_tokens: 17243 },
        content: [
          { type: "thinking", thinking: "the RLS context is missing" },
          { type: "text", text: "The webhook never sets the org context." },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    const { messages, meta } = parseTranscriptLine(line);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "thinking", blockIx: 0 });
    expect(messages[1]).toMatchObject({ role: "assistant", blockIx: 1 });
    expect(meta).toMatchObject({
      model: "claude-opus-4-8",
      usage: { input: 3017, output: 329 },
    });
  });

  it("handles string content (162 such lines in the real file)", () => {
    const line = JSON.stringify({
      ...base,
      type: "user",
      message: { role: "user", content: "plain string prompt" },
    });
    expect(parseTranscriptLine(line).messages[0].text).toBe("plain string prompt");
  });

  it("ignores tool_result-only user lines and non-conversation types", () => {
    const toolResult = JSON.stringify({
      ...base,
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "big output" }],
      },
    });
    expect(parseTranscriptLine(toolResult).messages).toHaveLength(0);

    for (const t of ["queue-operation", "ai-title", "file-history-snapshot", "summary"]) {
      const line = JSON.stringify({ type: t, sessionId: "s", data: "x" });
      const parsed = parseTranscriptLine(line);
      expect(parsed.messages).toHaveLength(0);
      expect(parsed.meta).toBeNull();
    }
  });

  it("never throws on malformed input", () => {
    expect(parseTranscriptLine("not json {{{")).toEqual({ messages: [], meta: null });
    expect(parseTranscriptLine('{"type":"user"}')).toEqual({ messages: [], meta: null });
  });
});
