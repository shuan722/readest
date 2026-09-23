import { embedMany } from 'ai';
import type { EmbeddingModel } from 'ai';
import { withRetryAndTimeout, AI_TIMEOUTS, AI_RETRY_CONFIGS } from './retry';

/**
 * `embedMany` only splits a value list by the model's `maxEmbeddingsPerCall`
 * (2048 for OpenAI-compatible endpoints), never by token count. Embedding
 * backends cap the *payload*, not the item count — e.g. 300k tokens per
 * request — so a full-book index blows the limit long before it hits 2048
 * items. These helpers split by an estimated token budget as well.
 */

/** Conservative per-request token budget, well under common 300k caps. */
export const MAX_TOKENS_PER_EMBED_BATCH = 100_000;

/** Upper bound on items per request, independent of the token budget. */
export const MAX_ITEMS_PER_EMBED_BATCH = 96;

/** Hard cap for one value; longer text is truncated before being sent. */
export const MAX_TOKENS_PER_EMBED_VALUE = 6_000;

const CJK_PATTERN = /[ᄀ-ᇿ⺀-〿぀-ヿ㄰-㆏㐀-䶿一-鿿ꥠ-꥿가-퟿豈-﫿＀-￯]/gu;

/**
 * Cheap token estimate that stays honest on CJK text. The usual chars/4
 * heuristic assumes English prose and under-counts a Chinese book by ~4x,
 * which is exactly the case that overflows the request limit. Count CJK
 * codepoints as ~1 token each and the rest as ~1/4 char per token.
 */
export function estimateEmbeddingTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = text.match(CJK_PATTERN)?.length ?? 0;
  const restCount = Math.max(0, text.length - cjkCount);
  return Math.ceil(cjkCount + restCount / 4);
}

/** Inverse of the estimate, used to truncate an over-long single value. */
function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (estimateEmbeddingTokens(text) <= maxTokens) return text;
  // Binary search the longest prefix that fits; the estimate is monotonic
  // in length, so this converges in ~log2(len) steps.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateEmbeddingTokens(text.slice(0, mid)) <= maxTokens) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(0, low);
}

export interface EmbedBatchOptions {
  maxTokensPerBatch?: number;
  maxItemsPerBatch?: number;
  maxTokensPerValue?: number;
}

/**
 * Group indices of `texts` into batches that respect both the item cap and
 * the token budget. Returns index groups rather than text groups so callers
 * can map results back onto their own chunk list.
 */
export function planEmbeddingBatches(texts: string[], options: EmbedBatchOptions = {}): number[][] {
  const maxTokens = options.maxTokensPerBatch ?? MAX_TOKENS_PER_EMBED_BATCH;
  const maxItems = options.maxItemsPerBatch ?? MAX_ITEMS_PER_EMBED_BATCH;
  const batches: number[][] = [];
  let current: number[] = [];
  let currentTokens = 0;

  for (let i = 0; i < texts.length; i++) {
    const tokens = estimateEmbeddingTokens(texts[i] ?? '');
    if (current.length > 0 && (current.length >= maxItems || currentTokens + tokens > maxTokens)) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(i);
    currentTokens += tokens;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

export interface EmbedInBatchesOptions extends EmbedBatchOptions {
  /** Called after each batch resolves, with the running completed count. */
  onBatch?: (completed: number, total: number) => void;
}

/**
 * Embed every text, splitting into token-bounded requests. Results are
 * returned in the same order as the input.
 */
export async function embedTextsInBatches(
  model: EmbeddingModel,
  texts: string[],
  options: EmbedInBatchesOptions = {},
): Promise<number[][]> {
  const maxTokensPerValue = options.maxTokensPerValue ?? MAX_TOKENS_PER_EMBED_VALUE;
  const values = texts.map((text) => truncateToTokenBudget(text, maxTokensPerValue));
  const batches = planEmbeddingBatches(values, options);
  const embeddings = new Array<number[]>(values.length);
  let completed = 0;

  for (const batch of batches) {
    const batchValues = batch.map((index) => values[index]!);
    const result = await withRetryAndTimeout(
      // maxRetries: 0 disables the AI SDK's own retry loop. It retries a
      // rejected payload as if it were transient (hence "Failed after 3
      // attempts" on a 400), and layering it under withRetry would multiply
      // the attempts. One retry policy, ours, which gives up immediately on
      // errors that cannot succeed.
      () => embedMany({ model, values: batchValues, maxRetries: 0 }),
      AI_TIMEOUTS.EMBEDDING_BATCH,
      AI_RETRY_CONFIGS.EMBEDDING,
    );
    for (let i = 0; i < batch.length; i++) {
      embeddings[batch[i]!] = result.embeddings[i]!;
    }
    completed += batch.length;
    options.onBatch?.(completed, values.length);
  }

  return embeddings;
}
