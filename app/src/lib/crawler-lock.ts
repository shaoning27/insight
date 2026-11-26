// Shared across Next.js route bundles in this single-process deployment.
const shared = globalThis as typeof globalThis & { insightCrawlerLocks?: Map<string, Promise<unknown>> };
const locks = shared.insightCrawlerLocks ??= new Map();
export async function withCrawlerLock<T>(id: string, task: () => Promise<T>): Promise<T> {
  const run = (locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(task);
  const tail = run.then(() => undefined, () => undefined);
  locks.set(id, tail);
  try { return await run; }
  finally { if (locks.get(id) === tail) locks.delete(id); }
}
