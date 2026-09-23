import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { AISettings, BookIndexMeta, TextChunk } from '@/services/ai/types';
import {
  estimateEmbeddingTokens,
  MAX_TOKENS_PER_EMBED_BATCH,
} from '@/services/ai/utils/embedBatch';

const embedManyMock = vi.hoisted(() => vi.fn());
vi.mock('ai', () => ({ embedMany: embedManyMock, embed: vi.fn() }));

// In-memory stand-in for the IndexedDB-backed store. `isIndexed` mirrors the
// real implementation so a 'partial' checkpoint is not mistaken for a
// finished index.
const store = vi.hoisted(() => {
  const chunks = new Map<string, Map<string, TextChunk>>();
  const metas = new Map<string, BookIndexMeta>();
  const bm25 = new Map<string, number>();
  return {
    chunks,
    metas,
    bm25,
    reset() {
      chunks.clear();
      metas.clear();
      bm25.clear();
    },
    aiStore: {
      getMeta: async (hash: string) => metas.get(hash) ?? null,
      saveMeta: async (meta: BookIndexMeta) => {
        metas.set(meta.bookHash, { ...meta });
      },
      isIndexed: async (hash: string) => {
        const meta = metas.get(hash);
        return !!meta && meta.status !== 'partial' && meta.totalChunks > 0;
      },
      getChunks: async (hash: string) => [...(chunks.get(hash)?.values() ?? [])],
      saveChunks: async (saved: TextChunk[]) => {
        for (const chunk of saved) {
          const hash = chunk.bookHash;
          if (!chunks.has(hash)) chunks.set(hash, new Map());
          chunks.get(hash)!.set(chunk.id, structuredClone(chunk));
        }
      },
      saveBM25Index: async (hash: string, saved: TextChunk[]) => {
        bm25.set(hash, saved.length);
      },
      clearBook: async (hash: string) => {
        chunks.delete(hash);
        metas.delete(hash);
        bm25.delete(hash);
      },
    },
  };
});
vi.mock('@/services/ai/storage/aiStore', () => ({ aiStore: store.aiStore }));
vi.mock('@/services/ai/providers', () => ({
  getAIProvider: () => ({ getEmbeddingModel: () => ({ modelId: 'test-embed' }) }),
}));

import { getIndexResumePoint, indexBook, type BookDocType } from '@/services/ai/ragService';

const BOOK_HASH = 'book-1';
// The failure this resume path exists for: a payload the upstream rejects.
const UPSTREAM_REJECTION =
  "All upstream providers failed: compass: Invalid 'input': maximum request size is 300000 tokens per request.";

function makeSection(index: number, text: string) {
  return {
    id: `s${index}`,
    size: text.length,
    linear: 'yes',
    createDocument: async () => {
      const doc = document.implementation.createHTMLDocument('');
      doc.body.textContent = text;
      return doc;
    },
  };
}

function makeBook(sectionTexts: string[]): BookDocType {
  return {
    sections: sectionTexts.map((text, i) => makeSection(i, text)),
    toc: sectionTexts.map((_, i) => ({ id: i, label: `Chapter ${i + 1}` })),
    metadata: { title: 'Test Book', author: 'Test Author' },
  };
}

const settings = {
  provider: 'openrouter',
  openrouterEmbeddingModel: 'text-embedding-3-small',
} as unknown as AISettings;

// Four sections, each long enough to survive the chunker's 100-char floor.
const SECTIONS = ['A'.repeat(600), 'B'.repeat(600), 'C'.repeat(600), 'D'.repeat(600)];

function embedOk() {
  embedManyMock.mockImplementation(({ values }: { values: string[] }) =>
    Promise.resolve({ embeddings: values.map(() => [1, 0, 0]) }),
  );
}

describe('indexBook resume', () => {
  beforeEach(() => {
    store.reset();
    embedManyMock.mockReset();
  });

  test('persists each section as it goes, so a failure keeps earlier work', async () => {
    let calls = 0;
    embedManyMock.mockImplementation(({ values }: { values: string[] }) => {
      if (++calls === 3) return Promise.reject(new Error(UPSTREAM_REJECTION));
      return Promise.resolve({ embeddings: values.map(() => [1, 0, 0]) });
    });

    await expect(indexBook(makeBook(SECTIONS), BOOK_HASH, settings)).rejects.toThrow(
      'maximum request size',
    );

    const saved = [...(store.chunks.get(BOOK_HASH)?.values() ?? [])];
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.every((c) => c.embedding)).toBe(true);
    expect(new Set(saved.map((c) => c.sectionIndex))).toEqual(new Set([0, 1]));
    expect(store.metas.get(BOOK_HASH)?.status).toBe('partial');
  });

  test('a partial checkpoint does not count as indexed', async () => {
    embedManyMock.mockRejectedValue(new Error(UPSTREAM_REJECTION));
    await expect(indexBook(makeBook(SECTIONS), BOOK_HASH, settings)).rejects.toThrow();

    expect(await store.aiStore.isIndexed(BOOK_HASH)).toBe(false);
  });

  test('retrying re-embeds only the sections that never finished', async () => {
    let calls = 0;
    embedManyMock.mockImplementation(({ values }: { values: string[] }) => {
      if (++calls === 3) return Promise.reject(new Error(UPSTREAM_REJECTION));
      return Promise.resolve({ embeddings: values.map(() => [1, 0, 0]) });
    });
    await expect(indexBook(makeBook(SECTIONS), BOOK_HASH, settings)).rejects.toThrow();

    embedManyMock.mockReset();
    embedOk();
    await indexBook(makeBook(SECTIONS), BOOK_HASH, settings);

    const reEmbedded = embedManyMock.mock.calls.flatMap(([args]) => args.values as string[]);
    expect(reEmbedded.every((text) => text.startsWith('C') || text.startsWith('D'))).toBe(true);
    expect(store.metas.get(BOOK_HASH)?.status).toBe('complete');
    expect(await store.aiStore.isIndexed(BOOK_HASH)).toBe(true);
    expect([...store.chunks.get(BOOK_HASH)!.values()].every((c) => c.embedding)).toBe(true);
  });

  test('discards the checkpoint when the embedding model changed', async () => {
    embedManyMock.mockImplementation(({ values }: { values: string[] }) => {
      if (embedManyMock.mock.calls.length > 2) return Promise.reject(new Error(UPSTREAM_REJECTION));
      return Promise.resolve({ embeddings: values.map(() => [1, 0, 0]) });
    });
    await expect(indexBook(makeBook(SECTIONS), BOOK_HASH, settings)).rejects.toThrow();

    embedManyMock.mockReset();
    embedOk();
    await indexBook(makeBook(SECTIONS), BOOK_HASH, {
      ...settings,
      openrouterEmbeddingModel: 'other-model',
    });

    const reEmbedded = embedManyMock.mock.calls.flatMap(([args]) => args.values as string[]);
    expect(new Set(reEmbedded.map((t: string) => t[0]))).toEqual(new Set(['A', 'B', 'C', 'D']));
    expect(store.metas.get(BOOK_HASH)?.embeddingModel).toBe('other-model');
  });

  test('discards the checkpoint when the chunk layout changed under it', async () => {
    let calls = 0;
    embedManyMock.mockImplementation(({ values }: { values: string[] }) => {
      if (++calls === 3) return Promise.reject(new Error(UPSTREAM_REJECTION));
      return Promise.resolve({ embeddings: values.map(() => [1, 0, 0]) });
    });
    await expect(indexBook(makeBook(SECTIONS), BOOK_HASH, settings)).rejects.toThrow();

    embedManyMock.mockReset();
    embedOk();
    // Same positions, but section 1's text was replaced.
    await indexBook(
      makeBook([SECTIONS[0]!, 'Z'.repeat(600), SECTIONS[2]!, SECTIONS[3]!]),
      BOOK_HASH,
      settings,
    );

    // Nothing is reused: a moved chunk boundary invalidates the whole
    // checkpoint, and no chunk from the old layout is left in the store.
    const reEmbedded = embedManyMock.mock.calls.flatMap(([args]) => args.values as string[]);
    expect(new Set(reEmbedded.map((t: string) => t[0]))).toEqual(new Set(['A', 'Z', 'C', 'D']));
    const stored = [...store.chunks.get(BOOK_HASH)!.values()];
    expect(stored.some((c) => c.text.startsWith('B'))).toBe(false);
    expect(stored.every((c) => c.embedding)).toBe(true);
  });

  test('reports a resume point the UI can show after a failure', async () => {
    let calls = 0;
    embedManyMock.mockImplementation(({ values }: { values: string[] }) => {
      if (++calls === 3) return Promise.reject(new Error(UPSTREAM_REJECTION));
      return Promise.resolve({ embeddings: values.map(() => [1, 0, 0]) });
    });
    await expect(indexBook(makeBook(SECTIONS), BOOK_HASH, settings)).rejects.toThrow();

    const resume = await getIndexResumePoint(BOOK_HASH);
    expect(resume).not.toBeNull();
    expect(resume!.embedded).toBeGreaterThan(0);
    expect(resume!.embedded).toBeLessThan(resume!.total);
  });

  test('reports no resume point once indexing completes', async () => {
    embedOk();
    await indexBook(makeBook(SECTIONS), BOOK_HASH, settings);

    expect(await getIndexResumePoint(BOOK_HASH)).toBeNull();
  });

  test('reports no resume point for a book that was never indexed', async () => {
    expect(await getIndexResumePoint('never-seen')).toBeNull();
  });

  test('indexes a book in one pass when nothing fails', async () => {
    embedOk();
    await indexBook(makeBook(SECTIONS), BOOK_HASH, settings);

    const meta = store.metas.get(BOOK_HASH)!;
    expect(meta.status).toBe('complete');
    expect(meta.totalChunks).toBe(store.chunks.get(BOOK_HASH)!.size);
    expect(store.bm25.get(BOOK_HASH)).toBe(meta.totalChunks);
  });

  test('splits a single oversized chapter across requests', async () => {
    embedOk();
    // One chapter of 200k CJK characters: ~200k tokens of chunks, which a
    // per-chapter request would still push past the upstream limit.
    await indexBook(makeBook(['\u4e2d'.repeat(200_000)]), BOOK_HASH, settings);

    expect(embedManyMock.mock.calls.length).toBeGreaterThan(1);
    for (const [args] of embedManyMock.mock.calls) {
      const tokens = (args.values as string[]).reduce(
        (sum, v) => sum + estimateEmbeddingTokens(v),
        0,
      );
      expect(tokens).toBeLessThanOrEqual(MAX_TOKENS_PER_EMBED_BATCH);
    }
  });

  test('reports embedding progress that resumes from the checkpoint', async () => {
    let calls = 0;
    embedManyMock.mockImplementation(({ values }: { values: string[] }) => {
      if (++calls === 3) return Promise.reject(new Error(UPSTREAM_REJECTION));
      return Promise.resolve({ embeddings: values.map(() => [1, 0, 0]) });
    });
    await expect(indexBook(makeBook(SECTIONS), BOOK_HASH, settings)).rejects.toThrow();

    embedManyMock.mockReset();
    embedOk();
    const progress: number[] = [];
    await indexBook(makeBook(SECTIONS), BOOK_HASH, settings, (p) => {
      if (p.phase === 'embedding') progress.push(p.current);
    });

    expect(progress[0]).toBeGreaterThan(0);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });
});
