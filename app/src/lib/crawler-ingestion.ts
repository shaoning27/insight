import { ch, queryRows } from './clickhouse';
import { getSite } from './sites';
import { CrawlerInputError, parseCrawlerBatch, tokenMatches } from './crawler-events';
import { withCrawlerLock } from './crawler-lock';

export async function ingestCrawlerBatch(body: unknown, token: string) {
  const id = (body as { site_id?: unknown } | null)?.site_id;
  if (typeof id !== 'string' || id.length > 80) throw new CrawlerInputError('invalid_token', 401);
  // Check before acquiring a lock so untrusted arbitrary IDs cannot allocate queues.
  const first = await getSite(id);
  if (!first || !tokenMatches(token, first.crawlerTokenHash)) throw new CrawlerInputError('invalid_token', 401);
  return withCrawlerLock(id, async () => {
    const site = await getSite(id);
    if (!site || !tokenMatches(token, site.crawlerTokenHash)) throw new CrawlerInputError('invalid_token', 401);
    if (!site.crawlerLogsEnabled) throw new CrawlerInputError('log_collection_disabled', 409);
    const { rows, ignored } = parseCrawlerBatch(body, site);
    const existing = rows.length ? await queryRows<{ request_id: string; event_hash: string }>(
      'SELECT request_id, any(event_hash) AS event_hash FROM ai_hits WHERE site_id = {site:String} AND request_id IN {ids:Array(String)} GROUP BY request_id',
      { site: site.id, ids: rows.map(r => r.request_id) },
    ) : [];
    const hashes = new Map(existing.map(r => [r.request_id, r.event_hash]));
    for (const row of rows) {
      if (hashes.has(row.request_id) && hashes.get(row.request_id) !== row.event_hash) throw new CrawlerInputError('request_id_conflict', 409);
    }
    const fresh = rows.filter(r => !hashes.has(r.request_id));
    if (fresh.length) await ch().insert({
      table: 'ai_hits', values: fresh, format: 'JSONEachRow',
      clickhouse_settings: { date_time_input_format: 'best_effort', session_timezone: 'UTC' },
    });
    return { ok: true, accepted: rows.length, inserted: fresh.length, duplicates: rows.length - fresh.length, ignored };
  });
}
