/**
 * Requirements encoded here:
 *  - The MEMORY.md projection only ever touches OUR marked block; existing
 *    user/auto-memory content stays byte-identical (the current auto-memory
 *    index must survive).
 *  - Re-projection is idempotent and updates in place.
 *  - repoToSlug matches Claude Code's real project-dir munging
 *    (verified on disk: /Users/x/django_base_login -> -Users-x-django-base-login).
 */
import { describe, expect, it } from "vitest";

import {
  renderMemoryBlock,
  repoToSlug,
  upsertMemoryBlock,
} from "../src/projection.js";

describe("repoToSlug", () => {
  it("matches the observed on-disk munging (slashes AND underscores)", () => {
    expect(repoToSlug("/Users/pranavsateesh/django_base_login")).toBe(
      "-Users-pranavsateesh-django-base-login",
    );
    expect(repoToSlug("/Users/pranavsateesh/od-modifications")).toBe(
      "-Users-pranavsateesh-od-modifications",
    );
  });
});

describe("upsertMemoryBlock", () => {
  const block = renderMemoryBlock([
    { kind: "gotcha", title: "WAUT ids", body: "GS_ prefix mismatch breaks SUMO load" },
  ]);

  it("appends to an existing MEMORY.md without touching its content", () => {
    const existing =
      "# Memory Index\n\n| File | Name |\n|---|---|\n| a.md | thing |\n";
    const out = upsertMemoryBlock(existing, block);
    expect(out.startsWith(existing.trimEnd())).toBe(true);
    expect(out).toContain("lazyobserver:start");
    expect(out).toContain("[gotcha] WAUT ids");
  });

  it("replaces only our block on re-projection (idempotent)", () => {
    const existing = "user header\n";
    const once = upsertMemoryBlock(existing, block);
    const newBlock = renderMemoryBlock([
      { kind: "decision", title: "RLS webhook", body: "org context from payload" },
    ]);
    const twice = upsertMemoryBlock(once, newBlock);
    expect(twice).toContain("user header");
    expect(twice).toContain("[decision] RLS webhook");
    expect(twice).not.toContain("[gotcha] WAUT ids"); // replaced, not appended
    expect(twice.match(/lazyobserver:start/g)).toHaveLength(1);
  });

  it("works on an empty file", () => {
    const out = upsertMemoryBlock("", block);
    expect(out).toContain("lazyobserver:start");
    expect(out.endsWith("\n")).toBe(true);
  });
});
