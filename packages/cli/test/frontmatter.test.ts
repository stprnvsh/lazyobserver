/**
 * Requirements encoded here (fixtures mirror the REAL auto-memory files on
 * this machine — two frontmatter variants exist in the wild):
 *  - top-level `type:` (older files)
 *  - nested `metadata:\n  type:` with quoted descriptions (newer files)
 *  - files without frontmatter still import (body only)
 *  - type -> kind mapping: feedback/user -> preference, project -> feature
 */
import { describe, expect, it } from "vitest";

import { mapKind, parseMemoryFile } from "../src/lib/frontmatter.js";

describe("parseMemoryFile", () => {
  it("parses the old top-level-type variant", () => {
    const parsed = parseMemoryFile(`---
name: AWS Secrets Manager bootstrap pattern
description: How to run Django management commands using Secrets Manager instead of .env files
type: feedback
---
Always bootstrap the Django backend using AWS Secrets Manager.
`);
    expect(parsed.name).toBe("AWS Secrets Manager bootstrap pattern");
    expect(parsed.type).toBe("feedback");
    expect(parsed.body).toContain("Always bootstrap");
  });

  it("parses the nested-metadata variant with quoted description", () => {
    const parsed = parseMemoryFile(`---
name: sumo-k8-capacity-model
description: "How sumo-k8 simulation capacity/scheduling works — EC2 vCPU quota"
metadata:
  node_type: memory
  type: project
  originSessionId: 45ea59d9
---

sumo-k8 simulation capacity model (eu-central-2).
`);
    expect(parsed.description).toBe(
      "How sumo-k8 simulation capacity/scheduling works — EC2 vCPU quota",
    );
    expect(parsed.type).toBe("project");
    expect(parsed.body).toContain("capacity model");
  });

  it("handles files without frontmatter", () => {
    const parsed = parseMemoryFile("just a body\nwith lines");
    expect(parsed.type).toBe("");
    expect(parsed.body).toBe("just a body\nwith lines");
  });
});

describe("mapKind", () => {
  it("maps auto-memory types to lazyobserver kinds", () => {
    expect(mapKind("feedback")).toBe("preference");
    expect(mapKind("user")).toBe("preference");
    expect(mapKind("project")).toBe("feature");
    expect(mapKind("reference")).toBe("reference");
    expect(mapKind("")).toBe("feature");
  });
});
