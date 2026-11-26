import { createHash, timingSafeEqual } from 'node:crypto';
import { detectBot } from './bots.ts';

export class CrawlerInputError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export function tokenDigest(token: string): string { return createHash('sha256').update(token).digest('hex'); }
export function tokenMatches(token: string, digest?: string): boolean {
  if (!digest || !/^[a-f0-9]{64}$/.test(digest) || !/^[a-f0-9]{64}$/.test(token)) return false;
  return timingSafeEqual(Buffer.from(tokenDigest(token), 'hex'), Buffer.from(digest, 'hex'));
}
export const CRAWLER_COUNT_SQL = "countIf(request_id = '') + uniqExactIf(tuple(site_id, request_id), request_id != '')";
export interface CrawlerRow {
  ts: string; site_id: string; request_id: string; event_hash: string;
  path: string; bot_name: string; vendor: string; category: string;
  ua_string: string; ip: string; verified: number; status_code: number;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CrawlerInputError('invalid_object');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new CrawlerInputError('invalid_string');
  return value;
}
export function siteHostname(url?: string): string {
  try { return new URL(/^https?:\/\//i.test(url ?? '') ? url! : `https://${url}`).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''); }
  catch { return ''; }
}
export function parseCrawlerBatch(body: unknown, site: { id: string; url?: string }, now = Date.now()): { rows: CrawlerRow[]; ignored: number } {
  const b = object(body);
  if (b.site_id !== site.id) throw new CrawlerInputError('site_mismatch', 403);
  const source = text(b.source_id, 80);
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(source)) throw new CrawlerInputError('invalid_source');
  if (!Array.isArray(b.requests) || b.requests.length < 1 || b.requests.length > 200) throw new CrawlerInputError('batch_requires_1_to_200_events');
  const hostname = siteHostname(site.url);
  if (!hostname) throw new CrawlerInputError('site_url_required', 409);
  const rows = new Map<string, CrawlerRow>();
  let ignored = 0;
  for (const raw of b.requests) {
    const e = object(raw);
    const id = text(e.id, 128);
    if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(id)) throw new CrawlerInputError('invalid_request_id');
    const host = text(e.host, 253).toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    const method = text(e.method, 16);
    const contentType = text(e.content_type, 160).toLowerCase();
    const path = text(e.path, 2048);
    if (!path.startsWith('/') || path.startsWith('//')) throw new CrawlerInputError('invalid_path');
    const cleanPath = path.split(/[?#]/, 1)[0];
    const ua = text(e.user_agent, 512);
    const timestamp = text(e.ts, 48);
    const time = Date.parse(timestamp);
    if (!/^\d{4}-\d\d-\d\dT/.test(timestamp) || !/(?:Z|[+-]\d\d:\d\d)$/.test(timestamp) || !Number.isFinite(time) || time < now - 90 * 86400000 || time > now + 300000) throw new CrawlerInputError('timestamp_outside_90_day_window');
    if (!Number.isInteger(e.status_code) || Number(e.status_code) < 100 || Number(e.status_code) > 599) throw new CrawlerInputError('invalid_status');
    const bot = detectBot(ua);
    if (host !== hostname || !['GET', 'HEAD'].includes(method) || !/^text\/html(?:\s*;|$)/.test(contentType) || /\.(?:js|css|map|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|pdf|xml|txt)$/i.test(cleanPath) || !bot) { ignored++; continue; }
    const row: CrawlerRow = {
      ts: new Date(time).toISOString(), site_id: site.id,
      request_id: tokenDigest(`${source}\n${id}`), event_hash: '',
      path: cleanPath, ...bot, ua_string: ua, ip: '', verified: 0, status_code: Number(e.status_code),
    };
    row.event_hash = tokenDigest(JSON.stringify([row.ts, row.path, row.bot_name, row.vendor, row.category, row.ua_string, row.status_code]));
    const prior = rows.get(row.request_id);
    if (prior && prior.event_hash !== row.event_hash) throw new CrawlerInputError('request_id_conflict', 409);
    rows.set(row.request_id, row);
  }
  return { rows: [...rows.values()], ignored };
}
