/**
 * Requirements encoded here:
 *  - Embeddings are computed 100% locally (transformers.js/ONNX) — model files
 *    cache under $LAZYOBSERVER_HOME/models, no API calls at embed time.
 *  - Output is 384-dim (all-MiniLM-L6-v2), L2-normalized, deterministic.
 *  - Semantic sanity: related sentences are closer than unrelated ones —
 *    this is the property daily/codebase memory recall depends on.
 *
 * NOTE: first run downloads the model (~25 MB) into the cache; subsequent
 * runs are offline. Timeout is generous for that first download.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Embedder } from "../src/embeddings.js";

let tmp: string;
let embedder: Embedder;

beforeAll(async () => {
  // Use the user's real model cache if present (fast/offline); fall back to tmp.
  tmp = mkdtempSync(path.join(os.tmpdir(), "lazyobs-emb-"));
  if (!process.env.LAZYOBSERVER_HOME) process.env.LAZYOBSERVER_HOME = tmp;
  embedder = new Embedder();
}, 20_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are normalized, dot == cosine
}

describe("local embedder", () => {
  it(
    "produces 384-dim normalized vectors, deterministically",
    { timeout: 300_000 },
    async () => {
      const [a1] = await embedder.embed(["fix the login rate limiter"]);
      const [a2] = await embedder.embed(["fix the login rate limiter"]);

      expect(a1).toHaveLength(384);
      const norm = Math.sqrt(a1.reduce((s, x) => s + x * x, 0));
      expect(norm).toBeCloseTo(1, 3);
      expect(cosine(a1, a2)).toBeCloseTo(1, 5);
    },
  );

  it(
    "ranks related text closer than unrelated text",
    { timeout: 300_000 },
    async () => {
      const [query, related, unrelated] = await embedder.embed([
        "why did the simulation fail with a missing signal plan?",
        "SUMO aborted because the traffic light program was not loaded",
        "the quarterly invoice was sent to the customer yesterday",
      ]);
      expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated));
    },
  );

  it("embeds batches in order", { timeout: 300_000 }, async () => {
    // Requirement: batch output order matches input order. Batched inference
    // pads mixed-length inputs, which introduces small (~1e-2) numeric jitter
    // vs single-item inference — so the contract is "each batch vector is
    // closest to ITS OWN single-embed counterpart", not bit-exactness.
    const texts = ["alpha", "beta", "gamma"];
    const batch = await embedder.embed(texts);
    expect(batch).toHaveLength(3);
    const singles = await Promise.all(texts.map((t) => embedder.embedOne(t)));
    for (let i = 0; i < texts.length; i++) {
      const sims = singles.map((s) => cosine(batch[i], s));
      expect(sims.indexOf(Math.max(...sims))).toBe(i);
      expect(sims[i]).toBeGreaterThan(0.98);
    }
  });
});
