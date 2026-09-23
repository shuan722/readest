import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  estimateEmbeddingTokens,
  planEmbeddingBatches,
  embedTextsInBatches,
  MAX_TOKENS_PER_EMBED_BATCH,
  MAX_ITEMS_PER_EMBED_BATCH,
} from '@/services/ai/utils/embedBatch';

const embedManyMock = vi.hoisted(() => vi.fn());
vi.mock('ai', () => ({ embedMany: embedManyMock }));

const fakeModel = { modelId: 'test-embed' } as never;

describe('estimateEmbeddingTokens', () => {
  test('counts CJK characters as roughly one token each', () => {
    expect(estimateEmbeddingTokens('中文测试内容')).toBe(6);
  });

  test('counts latin text as roughly a quarter token per char', () => {
    expect(estimateEmbeddingTokens('x'.repeat(400))).toBe(100);
  });

  test('handles empty text', () => {
    expect(estimateEmbeddingTokens('')).toBe(0);
  });
});

describe('planEmbeddingBatches', () => {
  test('keeps every batch under the token budget', () => {
    // 3000 chunks of 500 CJK chars ≈ 1.5M tokens, far over any request cap
    const texts = Array.from({ length: 3000 }, () => '中'.repeat(500));
    const batches = planEmbeddingBatches(texts);

    expect(batches.flat()).toHaveLength(texts.length);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(MAX_ITEMS_PER_EMBED_BATCH);
      const tokens = batch.reduce((sum, i) => sum + estimateEmbeddingTokens(texts[i]!), 0);
      expect(tokens).toBeLessThanOrEqual(MAX_TOKENS_PER_EMBED_BATCH);
    }
  });

  test('preserves order and covers every index exactly once', () => {
    const texts = Array.from({ length: 250 }, (_, i) => `chunk ${i}`);
    expect(planEmbeddingBatches(texts).flat()).toEqual(texts.map((_, i) => i));
  });

  test('never drops a single value larger than the budget', () => {
    const batches = planEmbeddingBatches(['中'.repeat(200_000)]);
    expect(batches).toEqual([[0]]);
  });

  test('returns no batches for an empty list', () => {
    expect(planEmbeddingBatches([])).toEqual([]);
  });
});

describe('embedTextsInBatches', () => {
  beforeEach(() => {
    embedManyMock.mockReset();
    embedManyMock.mockImplementation(({ values }: { values: string[] }) =>
      Promise.resolve({ embeddings: values.map((v) => [v.length]) }),
    );
  });

  test('splits a book-sized list into multiple requests', async () => {
    const texts = Array.from({ length: 500 }, (_, i) => '中'.repeat(500) + i);
    const embeddings = await embedTextsInBatches(fakeModel, texts);

    expect(embedManyMock.mock.calls.length).toBeGreaterThan(1);
    for (const [args] of embedManyMock.mock.calls) {
      const tokens = (args.values as string[]).reduce(
        (sum, v) => sum + estimateEmbeddingTokens(v),
        0,
      );
      expect(tokens).toBeLessThanOrEqual(MAX_TOKENS_PER_EMBED_BATCH);
    }
    expect(embeddings).toHaveLength(texts.length);
  });

  test('returns embeddings aligned with the input order', async () => {
    const texts = ['a', 'bb', 'ccc'];
    const embeddings = await embedTextsInBatches(fakeModel, texts, { maxItemsPerBatch: 2 });

    expect(embedManyMock).toHaveBeenCalledTimes(2);
    expect(embeddings).toEqual([[1], [2], [3]]);
  });

  test('truncates an oversized value instead of failing the request', async () => {
    await embedTextsInBatches(fakeModel, ['中'.repeat(50_000)], { maxTokensPerValue: 1000 });

    const sent = embedManyMock.mock.calls[0]![0].values[0] as string;
    expect(estimateEmbeddingTokens(sent)).toBeLessThanOrEqual(1000);
    expect(sent.length).toBeGreaterThan(0);
  });

  test('reports progress after each batch', async () => {
    const onBatch = vi.fn();
    await embedTextsInBatches(fakeModel, ['a', 'b', 'c', 'd'], { maxItemsPerBatch: 2, onBatch });

    expect(onBatch.mock.calls).toEqual([
      [2, 4],
      [4, 4],
    ]);
  });
});
