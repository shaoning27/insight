import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { validSession } from '@/lib/auth';
import { getSite, setCrawlerConfig } from '@/lib/sites';
import { tokenDigest } from '@/lib/crawler-events';
import { withCrawlerLock } from '@/lib/crawler-lock';
const reply = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
const owner = async () => validSession((await cookies()).get('insight_session')?.value);
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  if (!(await owner())) return reply({ error: 'unauthorized' }, 401);
  const site = await getSite(new URL(req.url).searchParams.get('id') ?? '');
  if (!site) return reply({ error: 'site_not_found' }, 404);
  return reply({ configured: !!site.crawlerTokenHash, enabled: !!site.crawlerLogsEnabled });
}
async function update(req: Request, action: 'rotate' | 'enable' | 'revoke') {
  if (!(await owner())) return reply({ error: 'unauthorized' }, 401);
  const body = await req.json().catch(() => null);
  if (!body || typeof body.id !== 'string' || body.id.length > 80) return reply({ error: 'site_required' }, 400);
  if (action === 'enable' && typeof body.enabled !== 'boolean') return reply({ error: 'enabled_must_be_boolean' }, 400);
  return withCrawlerLock(body.id, async () => {
    const site = await getSite(body.id);
    if (!site) return reply({ error: 'site_not_found' }, 404);
    if (action === 'rotate') {
      const token = randomBytes(32).toString('hex');
      await setCrawlerConfig(site.id, { tokenHash: tokenDigest(token) });
      return reply({ token, configured: true, enabled: !!site.crawlerLogsEnabled });
    }
    if (action === 'enable' && body.enabled && (!site.crawlerTokenHash || !site.url)) return reply({ error: 'site_url_and_token_required' }, 409);
    await setCrawlerConfig(site.id, action === 'revoke' ? { tokenHash: null, enabled: false } : { enabled: body.enabled });
    return reply({ configured: action !== 'revoke' && !!site.crawlerTokenHash, enabled: action !== 'revoke' && body.enabled });
  });
}
export async function POST(req: Request) { return update(req, 'rotate'); }
export async function PATCH(req: Request) { return update(req, 'enable'); }
export async function DELETE(req: Request) { return update(req, 'revoke'); }
