import { NextResponse } from 'next/server';
import { ingestCrawlerBatch } from '@/lib/crawler-ingestion';
import { CrawlerInputError } from '@/lib/crawler-events';
import { readCrawlerJson } from '@/lib/crawler-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: Request) {
  const token = /^Bearer ([a-f0-9]{64})$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
  if (!token) return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
  try {
    const body = await readCrawlerJson(req);
    return NextResponse.json(await ingestCrawlerBatch(body, token), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof CrawlerInputError) return NextResponse.json({ error: error.message }, { status: error.status });
    // Do not log request payloads, tokens or ClickHouse errors containing row data.
    console.error('Crawler ingestion failed; batch was not acknowledged');
    return NextResponse.json({ error: 'ingestion_unavailable' }, { status: 503 });
  }
}
