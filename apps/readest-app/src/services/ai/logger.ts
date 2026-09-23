/**
 * On by default, including release builds: a failing request that leaves no
 * trace anywhere costs far more than the console noise. Silence it at runtime
 * with `localStorage.setItem('readest-ai-debug', '0')`.
 */
function isDebugEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem('readest-ai-debug') !== '0';
  } catch {
    // Storage can be blocked; never let logging break the caller.
    return true;
  }
}

const PREFIX = '[AI]';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

type TauriLogModule = typeof import('@tauri-apps/plugin-log');
let logModulePromise: Promise<TauriLogModule | null> | undefined;

function getTauriLog(): Promise<TauriLogModule | null> {
  if (!logModulePromise) {
    const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    logModulePromise = inTauri
      ? import('@tauri-apps/plugin-log').catch(() => null)
      : Promise.resolve(null);
  }
  return logModulePromise;
}

/**
 * Mirror the line into the app's log file (`~/Library/Logs/<bundle id>/` on
 * macOS). The console only exists while devtools are open, so without this a
 * user-reported failure leaves nothing to read afterwards. Fire-and-forget:
 * logging must never delay or break the caller. The Rust side filters at
 * Info, so `debug` lines stay out of the file.
 */
function forwardToLogFile(level: LogLevel, line: string): void {
  void getTauriLog().then((mod) => {
    if (!mod) return;
    const write =
      level === 'error'
        ? mod.error
        : level === 'warn'
          ? mod.warn
          : level === 'debug'
            ? mod.debug
            : mod.info;
    void write(line).catch(() => {
      // A failed log write is not worth surfacing anywhere.
    });
  });
}

function formatData(data: unknown): string {
  if (data === undefined) return '';
  if (typeof data === 'object') {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }
  return String(data);
}

function log(level: LogLevel, module: string, message: string, data?: unknown) {
  if (!isDebugEnabled()) return;
  const timestamp = new Date().toISOString().split('T')[1]?.slice(0, 12);
  const prefix = `${PREFIX}[${timestamp}][${module}]`;
  const formatted = data !== undefined ? `${message} ${formatData(data)}` : message;

  forwardToLogFile(level, `${prefix} ${formatted}`);

  switch (level) {
    case 'info':
      console.log(`%c${prefix} ${formatted}`, 'color: #4fc3f7');
      break;
    case 'warn':
      console.warn(`${prefix} ${formatted}`);
      break;
    case 'error':
      console.error(`${prefix} ${formatted}`);
      break;
    case 'debug':
      console.log(`%c${prefix} ${formatted}`, 'color: #81c784');
      break;
  }
}

export const aiLogger = {
  chunker: {
    start: (bookHash: string, sectionCount: number) =>
      log('info', 'CHUNKER', `Starting chunking`, { bookHash, sectionCount }),
    section: (sectionIndex: number, charCount: number, chunkCount: number) =>
      log('debug', 'CHUNKER', `Section ${sectionIndex}: ${charCount} chars → ${chunkCount} chunks`),
    complete: (bookHash: string, totalChunks: number) =>
      log('info', 'CHUNKER', `Chunking complete`, { bookHash, totalChunks }),
    error: (sectionIndex: number, error: string) =>
      log('error', 'CHUNKER', `Section ${sectionIndex} failed: ${error}`),
  },
  embedding: {
    start: (model: string, chunkCount: number) =>
      log('info', 'EMBED', `Starting embedding`, { model, chunkCount }),
    batch: (current: number, total: number) =>
      log(
        'debug',
        'EMBED',
        `Embedded ${current}/${total} (${Math.round((current / total) * 100)}%)`,
      ),
    complete: (successCount: number, totalCount: number, dimensions: number) =>
      log('info', 'EMBED', `Embedding complete`, { successCount, totalCount, dimensions }),
    error: (chunkId: string, error: string) =>
      log('error', 'EMBED', `Failed chunk ${chunkId}: ${error}`),
  },
  store: {
    saveChunks: (bookHash: string, count: number) =>
      log('info', 'STORE', `Saving ${count} chunks`, { bookHash }),
    saveMeta: (meta: object) => log('info', 'STORE', `Saving book meta`, meta),
    saveBM25: (bookHash: string) => log('info', 'STORE', `Saving BM25 index`, { bookHash }),
    loadChunks: (bookHash: string, count: number) =>
      log('debug', 'STORE', `Loaded ${count} chunks`, { bookHash }),
    clear: (bookHash: string) => log('info', 'STORE', `Cleared book data`, { bookHash }),
    error: (operation: string, error: string) =>
      log('error', 'STORE', `${operation} failed: ${error}`),
  },
  search: {
    query: (query: string, maxSection?: number) =>
      log('info', 'SEARCH', `Query: "${query.slice(0, 50)}..."`, { maxSection }),
    bm25Results: (count: number, topScore: number) =>
      log('debug', 'SEARCH', `BM25: ${count} results, top score: ${topScore.toFixed(3)}`),
    vectorResults: (count: number, topScore: number) =>
      log('debug', 'SEARCH', `Vector: ${count} results, top similarity: ${topScore.toFixed(4)}`),
    hybridResults: (count: number, methods: string[]) =>
      log('info', 'SEARCH', `Hybrid: ${count} results`, { methods }),
    spoilerFiltered: (before: number, after: number, maxSection: number) =>
      log('debug', 'SEARCH', `Spoiler filter: ${before} → ${after} (max section: ${maxSection})`),
  },
  chat: {
    send: (messageLength: number, hasContext: boolean) =>
      log('info', 'CHAT', `Sending message`, { messageLength, hasContext }),
    context: (chunks: number, totalChars: number) =>
      log('debug', 'CHAT', `Context: ${chunks} chunks, ${totalChars} chars`),
    stream: (tokens: number) => log('debug', 'CHAT', `Streamed ${tokens} tokens`),
    complete: (responseLength: number) =>
      log('info', 'CHAT', `Response complete: ${responseLength} chars`),
    error: (error: string) => log('error', 'CHAT', error),
  },
  rag: {
    indexStart: (bookHash: string, title: string) =>
      log('info', 'RAG', `Index start`, { bookHash, title }),
    indexProgress: (phase: string, current: number, total: number) =>
      log('debug', 'RAG', `Index progress: ${phase} ${current}/${total}`),
    indexComplete: (bookHash: string, chunks: number, duration: number) =>
      log('info', 'RAG', `Index complete`, { bookHash, chunks, durationMs: duration }),
    indexError: (bookHash: string, error: string) =>
      log('error', 'RAG', `Index failed`, { bookHash, error }),
    isIndexed: (bookHash: string, indexed: boolean) =>
      log('debug', 'RAG', `isIndexed check`, { bookHash, indexed }),
  },
  provider: {
    init: (provider: string, model: string) =>
      log('info', 'PROVIDER', `Initialized`, { provider, model }),
    embed: (provider: string, textLength: number) =>
      log('debug', 'PROVIDER', `Embed request: ${textLength} chars`, { provider }),
    chat: (provider: string, messageCount: number) =>
      log('debug', 'PROVIDER', `Chat request: ${messageCount} messages`, { provider }),
    error: (provider: string, error: string) =>
      log('error', 'PROVIDER', `${provider} error: ${error}`),
  },
};
