import { CrawlerInputError } from './crawler-events.ts';
export async function readCrawlerJson(req: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '')) throw new CrawlerInputError('json_required', 415);
  const limit = 512 * 1024;
  if (Number(req.headers.get('content-length')) > limit) throw new CrawlerInputError('body_too_large', 413);
  if (!req.body) throw new CrawlerInputError('empty_body');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new CrawlerInputError('body_too_large', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new CrawlerInputError('invalid_json'); }
}
