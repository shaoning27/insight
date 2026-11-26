import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { withCrawlerLock } from './crawler-lock.ts';

const dir = (): string => (process.env.SQLITE_PATH ? path.dirname(process.env.SQLITE_PATH) : '/data');
const file = (): string => path.join(dir(), 'sites.json');

export interface Ga4Config {
  propertyId: string;
}

export interface Site {
  id: string;
  name: string;
  createdAt: number;
  url?: string;
  faviconType?: string;
  stripeKey?: string;
  ga4?: Ga4Config;
  shareToken?: string;
  crawlerTokenHash?: string;
  crawlerLogsEnabled?: boolean;
}

export interface PublicSite {
  id: string;
  name: string;
  createdAt: number;
  url: string;
  favicon: boolean;
  stripe: boolean;
  ga4: boolean;
  shareToken?: string;
}

export function toPublic(s: Site): PublicSite {
  return { id: s.id, name: s.name, createdAt: s.createdAt, url: s.url ?? '', favicon: !!s.faviconType, stripe: !!s.stripeKey, ga4: !!s.ga4, shareToken: s.shareToken };
}

export async function listSites(): Promise<Site[]> {
  try {
    const sites = JSON.parse(await fs.readFile(file(), 'utf8'));
    if (!Array.isArray(sites)) throw new Error('Invalid site configuration');
    return sites as Site[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

// The deployment has one application process. Serialize every read/modify/write,
// then atomically replace the file so readers never see partial JSON.
const shared = globalThis as typeof globalThis & { insightSiteMutation?: Promise<unknown> };
shared.insightSiteMutation ??= Promise.resolve();
function mutateSites<T>(change: (sites: Site[]) => T): Promise<T> {
  const run = shared.insightSiteMutation!.then(async () => {
    const sites = await listSites();
    const result = change(sites);
    await fs.mkdir(dir(), { recursive: true, mode: 0o700 });
    const temporary = `${file()}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(sites), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file());
    } finally { await fs.rm(temporary, { force: true }); }
    return result;
  });
  shared.insightSiteMutation = run.catch(() => undefined);
  return run;
}
async function changeSite<T>(id: string, change: (site: Site) => T): Promise<T | undefined> {
  return mutateSites(sites => {
    const site = sites.find(s => s.id === id);
    return site ? change(site) : undefined;
  });
}
export async function getSite(id: string): Promise<Site | undefined> {
  return (await listSites()).find(s => s.id === id);
}

const host = (u: string): string => {
  try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, ''); } catch { return ''; }
};

// Finds a site from a hostname (e.g. the Referer of a /t.js request).
export async function getSiteByDomain(hostname: string): Promise<Site | undefined> {
  const h = hostname.replace(/^www\./, '').toLowerCase();
  if (!h) return undefined;
  return (await listSites()).find((s) => s.url && host(s.url).toLowerCase() === h);
}

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 24);
  return s || 'site';
}

export async function addSite(name: string, url?: string): Promise<Site> {
  return mutateSites(sites => {
    let id = slug(name);
    if (sites.some(s => s.id === id)) id = `${id}-${randomBytes(4).toString('hex')}`;
    const site: Site = { id, name: name.trim().slice(0, 60) || id, createdAt: Date.now(), url: url?.trim() || undefined };
    sites.push(site);
    return site;
  });
}
export async function setSiteUrl(id: string, url: string): Promise<void> {
  await withCrawlerLock(id, () => changeSite(id, s => {
    const next = url.trim() || undefined;
    if (host(s.url ?? '').toLowerCase() !== host(next ?? '').toLowerCase()) {
      s.crawlerLogsEnabled = false;
      delete s.crawlerTokenHash;
    }
    s.url = next;
  }));
}
export async function setFavicon(id: string, faviconType: string): Promise<void> {
  await changeSite(id, s => { s.faviconType = faviconType; });
}
export async function removeSite(id: string): Promise<void> {
  await withCrawlerLock(id, () => mutateSites(sites => { const index = sites.findIndex(s => s.id === id); if (index >= 0) sites.splice(index, 1); }));
}
export async function setStripeKey(id: string, key: string): Promise<void> {
  await changeSite(id, s => { s.stripeKey = key; });
}
export async function clearStripeKey(id: string): Promise<void> {
  await changeSite(id, s => { delete s.stripeKey; });
}
export async function setShareToken(id: string): Promise<string | undefined> {
  return changeSite(id, s => { s.shareToken = randomBytes(16).toString('hex'); return s.shareToken; });
}
export async function clearShareToken(id: string): Promise<void> {
  await changeSite(id, s => { delete s.shareToken; });
}
export async function getSiteByShareToken(token: string): Promise<Site | undefined> {
  if (!token || !/^[a-f0-9]{32}$/.test(token)) return undefined;
  return (await listSites()).find(s => s.shareToken === token);
}
export async function setGa4(id: string, cfg: Ga4Config): Promise<void> {
  await changeSite(id, s => { s.ga4 = cfg; });
}
export async function clearGa4(id: string): Promise<void> {
  await changeSite(id, s => { delete s.ga4; });
}
export async function setCrawlerConfig(id: string, update: { tokenHash?: string | null; enabled?: boolean }): Promise<void> {
  const result = await changeSite(id, s => {
    if (update.tokenHash === null) delete s.crawlerTokenHash;
    else if (update.tokenHash !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(update.tokenHash)) throw new Error('Invalid token digest');
      s.crawlerTokenHash = update.tokenHash;
    }
    if (update.enabled !== undefined) s.crawlerLogsEnabled = update.enabled;
    if (s.crawlerLogsEnabled && (!s.crawlerTokenHash || !host(s.url ?? ''))) throw new Error('Site URL and token required');
    return true;
  });
  if (!result) throw new Error('Site not found');
}
