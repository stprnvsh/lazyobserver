/**
 * Local text embeddings via transformers.js (ONNX runtime, CPU).
 *
 * Hard requirement: local-first — no text ever leaves the machine to be
 * indexed. Model weights (all-MiniLM-L6-v2, ~25 MB quantized) are downloaded
 * once into $LAZYOBSERVER_HOME/models and cached; embedding itself is fully
 * offline. 384 dimensions, mean-pooled, L2-normalized — dot product == cosine.
 */
import { paths } from "./paths.js";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMENSIONS = 384;

type FeatureExtractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

export class Embedder {
  private extractorPromise: Promise<FeatureExtractor> | null = null;

  private async extractor(): Promise<FeatureExtractor> {
    if (!this.extractorPromise) {
      this.extractorPromise = (async () => {
        const { pipeline, env } = await import("@huggingface/transformers");
        // Cache models inside the lazyobserver home, not a global HF cache.
        env.cacheDir = paths.models();
        const pipe = await pipeline("feature-extraction", EMBEDDING_MODEL, {
          // int8 quantization: ~4x smaller download, negligible recall loss
          dtype: "q8",
        });
        return pipe as unknown as FeatureExtractor;
      })();
    }
    return this.extractorPromise;
  }

  /** Embed a batch of texts; order-preserving. */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extract = await this.extractor();
    const output = await extract(texts, { pooling: "mean", normalize: true });
    return output.tolist();
  }

  /** Convenience for a single query string. */
  async embedOne(text: string): Promise<number[]> {
    const [v] = await this.embed([text]);
    return v;
  }
}
