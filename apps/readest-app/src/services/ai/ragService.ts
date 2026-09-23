import { embed } from 'ai';
import { aiStore } from './storage/aiStore';
import { chunkSection, extractTextFromDocument } from './utils/chunker';
import { withRetryAndTimeout, AI_TIMEOUTS, AI_RETRY_CONFIGS } from './utils/retry';
import { embedTextsInBatches } from './utils/embedBatch';
import { getAIProvider } from './providers';
import { aiLogger } from './logger';
import type { AISettings, TextChunk, ScoredChunk, EmbeddingProgress, BookIndexMeta } from './types';

interface SectionItem {
  id: string;
  size: number;
  linear: string;
  createDocument: () => Promise<Document>;
}

interface TOCItem {
  id: number;
  label: string;
  href?: string;
}

export interface BookDocType {
  sections?: SectionItem[];
  toc?: TOCItem[];
  metadata?: { title?: string | { [key: string]: string }; author?: string | { name?: string } };
}

const indexingStates = new Map<string, IndexingState>();

export async function isBookIndexed(bookHash: string): Promise<boolean> {
  const indexed = await aiStore.isIndexed(bookHash);
  aiLogger.rag.isIndexed(bookHash, indexed);
  return indexed;
}

function extractTitle(metadata?: BookDocType['metadata']): string {
  if (!metadata?.title) return 'Unknown Book';
  if (typeof metadata.title === 'string') return metadata.title;
  return (
    metadata.title['en'] ||
    metadata.title['default'] ||
    Object.values(metadata.title)[0] ||
    'Unknown Book'
  );
}

function extractAuthor(metadata?: BookDocType['metadata']): string {
  if (!metadata?.author) return 'Unknown Author';
  if (typeof metadata.author === 'string') return metadata.author;
  return metadata.author.name || 'Unknown Author';
}

function getChapterTitle(toc: TOCItem[] | undefined, sectionIndex: number): string {
  if (!toc || toc.length === 0) return `Section ${sectionIndex + 1}`;
  for (let i = toc.length - 1; i >= 0; i--) {
    if (toc[i]!.id <= sectionIndex) return toc[i]!.label;
  }
  return toc[0]?.label || `Section ${sectionIndex + 1}`;
}

export async function indexBook(
  bookDoc: BookDocType,
  bookHash: string,
  settings: AISettings,
  onProgress?: (progress: EmbeddingProgress) => void,
): Promise<void> {
  const startTime = Date.now();
  const title = extractTitle(bookDoc.metadata);

  if (await aiStore.isIndexed(bookHash)) {
    aiLogger.rag.isIndexed(bookHash, true);
    return;
  }

  aiLogger.rag.indexStart(bookHash, title);
  const provider = getAIProvider(settings);
  const sections = bookDoc.sections || [];
  const toc = bookDoc.toc || [];

  // calculate cumulative character sizes like toc.ts does
  const sizes = sections.map((s) => (s.linear !== 'no' && s.size > 0 ? s.size : 0));
  let cumulative = 0;
  const cumulativeSizes = sizes.map((size) => {
    const current = cumulative;
    cumulative += size;
    return current;
  });

  const state: IndexingState = {
    bookHash,
    status: 'indexing',
    progress: 0,
    chunksProcessed: 0,
    totalChunks: 0,
  };
  indexingStates.set(bookHash, state);

  try {
    onProgress?.({ current: 0, total: 1, phase: 'chunking' });
    aiLogger.rag.indexProgress('chunking', 0, sections.length);
    const allChunks: TextChunk[] = [];

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]!;
      try {
        const doc = await section.createDocument();
        const text = extractTextFromDocument(doc);
        if (text.length < 100) continue;
        const sectionChunks = chunkSection(
          doc,
          i,
          getChapterTitle(toc, i),
          bookHash,
          cumulativeSizes[i] ?? 0,
        );
        aiLogger.chunker.section(i, text.length, sectionChunks.length);
        allChunks.push(...sectionChunks);
      } catch (e) {
        aiLogger.chunker.error(i, (e as Error).message);
      }
    }

    aiLogger.chunker.complete(bookHash, allChunks.length);
    state.totalChunks = allChunks.length;

    if (allChunks.length === 0) {
      state.status = 'complete';
      state.progress = 100;
      aiLogger.rag.indexComplete(bookHash, 0, Date.now() - startTime);
      return;
    }

    const embeddingModelName =
      settings.provider === 'ollama'
        ? settings.ollamaEmbeddingModel
        : settings.provider === 'openrouter'
          ? settings.openrouterEmbeddingModel
          : settings.aiGatewayEmbeddingModel;

    const buildMeta = (status: 'partial' | 'complete', embeddedChunks: number): BookIndexMeta => ({
      bookHash,
      bookTitle: title,
      authorName: extractAuthor(bookDoc.metadata),
      totalSections: sections.length,
      totalChunks: allChunks.length,
      embeddingModel: embeddingModelName || 'none',
      lastUpdated: Date.now(),
      status,
      embeddedChunks,
    });

    // Chat-only OpenAI-compatible endpoints are valid. Without an embedding
    // model we still build the local BM25 index, so book chat works without
    // RAG/vector search instead of failing with an opaque embedding error.
    if (embeddingModelName) {
      const restored = await restoreCheckpoint(bookHash, allChunks, embeddingModelName);
      aiLogger.embedding.start(embeddingModelName, allChunks.length);
      state.chunksProcessed = restored;
      state.progress = Math.round((restored / allChunks.length) * 100);
      onProgress?.({ current: restored, total: allChunks.length, phase: 'embedding' });

      let embedded = restored;
      let dimensions = 0;

      // Embed and persist one section at a time. An interrupted run (network
      // drop, quota, app close) keeps every section it finished, and the next
      // attempt resumes from there instead of re-embedding the whole book.
      for (const section of groupBySection(allChunks)) {
        const pending = section.filter((c) => !c.embedding);
        if (pending.length === 0) continue;

        try {
          // Send token-bounded batches: embedding backends cap the request
          // payload (300k tokens on several gateways) and `embedMany` alone
          // only splits by item count, so a long section in one call overflows.
          const embeddings = await embedTextsInBatches(
            provider.getEmbeddingModel(),
            pending.map((c) => c.text),
            {
              onBatch: (completed) => {
                state.chunksProcessed = embedded + completed;
                state.progress = Math.round((state.chunksProcessed / allChunks.length) * 100);
                aiLogger.embedding.batch(state.chunksProcessed, allChunks.length);
                onProgress?.({
                  current: state.chunksProcessed,
                  total: allChunks.length,
                  phase: 'embedding',
                });
              },
            },
          );
          for (let i = 0; i < pending.length; i++) {
            pending[i]!.embedding = embeddings[i];
          }
          dimensions = embeddings[0]?.length || dimensions;
        } catch (e) {
          aiLogger.embedding.error(`section ${section[0]!.sectionIndex}`, (e as Error).message);
          throw e;
        }

        embedded += pending.length;
        await aiStore.saveChunks(section);
        await aiStore.saveMeta(buildMeta('partial', embedded));
        aiLogger.rag.indexProgress('embedding', embedded, allChunks.length);
      }

      aiLogger.embedding.complete(embedded, allChunks.length, dimensions);
    } else {
      state.chunksProcessed = allChunks.length;
      state.progress = 100;
    }

    onProgress?.({ current: 0, total: 2, phase: 'indexing' });
    aiLogger.store.saveChunks(bookHash, allChunks.length);
    await aiStore.saveChunks(allChunks);

    onProgress?.({ current: 1, total: 2, phase: 'indexing' });
    aiLogger.store.saveBM25(bookHash);
    await aiStore.saveBM25Index(bookHash, allChunks);

    const meta = buildMeta('complete', allChunks.length);
    aiLogger.store.saveMeta(meta);
    await aiStore.saveMeta(meta);

    onProgress?.({ current: 2, total: 2, phase: 'indexing' });
    state.status = 'complete';
    state.progress = 100;
    aiLogger.rag.indexComplete(bookHash, allChunks.length, Date.now() - startTime);
  } catch (error) {
    state.status = 'error';
    state.error = (error as Error).message;
    aiLogger.rag.indexError(bookHash, (error as Error).message);
    throw error;
  }
}

/**
 * Chunks are produced in section order, so grouping is a linear scan.
 */
function groupBySection(chunks: TextChunk[]): TextChunk[][] {
  const groups: TextChunk[][] = [];
  let current: TextChunk[] = [];
  for (const chunk of chunks) {
    if (current.length > 0 && current[0]!.sectionIndex !== chunk.sectionIndex) {
      groups.push(current);
      current = [];
    }
    current.push(chunk);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Carry embeddings from an interrupted run over onto freshly chunked text,
 * mutating `chunks` in place. Returns how many were recovered.
 */
async function restoreCheckpoint(
  bookHash: string,
  chunks: TextChunk[],
  embeddingModel: string,
): Promise<number> {
  const meta = await aiStore.getMeta(bookHash);
  if (meta?.status !== 'partial') return 0;

  if (meta.embeddingModel !== embeddingModel) {
    // Vectors from another model share no space with the ones we are about
    // to produce, so the half-finished index is unusable.
    aiLogger.rag.indexProgress(`resume discarded (${meta.embeddingModel})`, 0, chunks.length);
    await aiStore.clearBook(bookHash);
    return 0;
  }

  const saved = new Map((await aiStore.getChunks(bookHash)).map((c) => [c.id, c]));
  let restored = 0;
  for (const chunk of chunks) {
    const previous = saved.get(chunk.id);
    if (!previous) continue;
    if (previous.text !== chunk.text) {
      // Chunk ids are positional. Different text under the same id means the
      // chunk layout moved, so the checkpoint describes a shape we no longer
      // produce — keeping any of it would mispair vectors with text and leave
      // stale chunks behind.
      aiLogger.rag.indexProgress('resume discarded (layout changed)', 0, chunks.length);
      await aiStore.clearBook(bookHash);
      for (const c of chunks) delete c.embedding;
      return 0;
    }
    if (previous.embedding) {
      chunk.embedding = previous.embedding;
      restored++;
    }
  }
  aiLogger.rag.indexProgress('resume', restored, chunks.length);
  return restored;
}

/**
 * Progress left behind by an interrupted index, so the UI can offer to
 * resume rather than presenting the retry as starting over. `null` when
 * there is nothing to resume.
 */
export async function getIndexResumePoint(
  bookHash: string,
): Promise<{ embedded: number; total: number } | null> {
  const meta = await aiStore.getMeta(bookHash);
  if (meta?.status !== 'partial') return null;
  const embedded = meta.embeddedChunks ?? 0;
  if (embedded <= 0 || meta.totalChunks <= 0) return null;
  return { embedded, total: meta.totalChunks };
}

export async function hybridSearch(
  bookHash: string,
  query: string,
  settings: AISettings,
  topK = 10,
  maxPage?: number,
): Promise<ScoredChunk[]> {
  aiLogger.search.query(query, maxPage);
  const provider = getAIProvider(settings);
  let queryEmbedding: number[] | null = null;

  try {
    // use AI SDK embed with provider's embedding model
    const { embedding } = await withRetryAndTimeout(
      () =>
        embed({
          model: provider.getEmbeddingModel(),
          value: query,
          // Retries are withRetry's job; see embedBatch for why.
          maxRetries: 0,
        }),
      AI_TIMEOUTS.EMBEDDING_SINGLE,
      AI_RETRY_CONFIGS.EMBEDDING,
    );
    queryEmbedding = embedding;
  } catch {
    // bm25 only fallback
  }

  const results = await aiStore.hybridSearch(bookHash, queryEmbedding, query, topK, maxPage);
  aiLogger.search.hybridResults(results.length, [...new Set(results.map((r) => r.searchMethod))]);
  return results;
}

export async function clearBookIndex(bookHash: string): Promise<void> {
  aiLogger.store.clear(bookHash);
  await aiStore.clearBook(bookHash);
  indexingStates.delete(bookHash);
}

// internal type for indexing state tracking
interface IndexingState {
  bookHash: string;
  status: 'idle' | 'indexing' | 'complete' | 'error';
  progress: number;
  chunksProcessed: number;
  totalChunks: number;
  error?: string;
}
