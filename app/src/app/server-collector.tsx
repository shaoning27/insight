'use client';
import { useEffect, useState } from 'react';

export default function ServerCollector({ site }: { site: { id: string; url: string } }) {
  const [configured, setConfigured] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/sites/ingestion?id=${encodeURIComponent(site.id)}`, { signal: controller.signal })
      .then(async r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(s => { setConfigured(s.configured); setEnabled(s.enabled); setLoading(false); })
      .catch(e => { if (e.name !== 'AbortError') setError('Could not load collection settings. Reopen this window to retry.'); });
    return () => controller.abort();
  }, [site.id]);
  const update = async (method: string, value: Record<string, unknown> = {}) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await fetch('/api/sites/ingestion', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: site.id, ...value }) });
      const s = await r.json();
      if (!r.ok) throw new Error(s.error === 'site_url_and_token_required' ? 'Set the website URL and generate a token first.' : 'Could not save collection settings.');
      setConfigured(s.configured); setEnabled(s.enabled);
      if (s.token) { setToken(s.token); setNotice('Save this token now. It will not be displayed again.'); }
      if (method === 'DELETE') setToken('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); }
    finally { setBusy(false); }
  };
  let host = '';
  try { host = new URL(/^https?:\/\//i.test(site.url) ? site.url : `https://${site.url}`).hostname; } catch { /* URL required before enabling */ }
  const config = JSON.stringify({
    endpoint: `${typeof window === 'undefined' ? '' : window.location.origin}/api/crawlers/ingest`,
    site_id: site.id, token: token || 'PASTE_YOUR_SAVED_INGESTION_TOKEN', host,
    log_glob: `/var/log/nginx/insight-${site.id}.access.log*`,
    state_path: `/var/lib/insight-collector/${site.id}.json`,
  }, null, 2);
  const download = () => {
    const url = URL.createObjectURL(new Blob([config + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `insight-${site.id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="mt-5 space-y-3 border-t border-[var(--card-border)] pt-4">
      <h4 className="text-sm font-semibold">Server log collection</h4>
      <p className="text-xs leading-relaxed text-zinc-500">Capture HTML requests from crawlers that never load the tracking script. Supports Kimi, Tencent Hy, Zhipu GLM, Chinese search crawlers and the existing international catalog. A User-Agent match is an unverified identity claim.</p>
      {loading ? <p className="text-xs text-zinc-500">Loading collection settings…</p> : <>
        <p className="text-xs font-medium">{enabled ? 'Log mode enabled — HTML logs are the crawler source.' : 'Script mode — crawlers that do not request the script are not observed.'}</p>
        <div className="flex flex-wrap gap-2">
          <button disabled={busy} className="btn-primary" onClick={() => {
            if (configured && !window.confirm('Rotate this site’s token? Existing collectors must be updated with the new token.')) return;
            void update('POST');
          }}>{configured ? 'Rotate token' : 'Generate server token'}</button>
          {configured && <button disabled={busy || (!enabled && !host)} className="rounded-lg border border-[var(--card-border)] px-3 py-2 text-xs" onClick={() => {
            if (!enabled && !window.confirm('Enable log mode? Crawler counts will come from the server collector; script crawler logging will stop. Install and start the collector after enabling.')) return;
            void update('PATCH', { enabled: !enabled });
          }}>{enabled ? 'Disable log mode' : 'Enable log mode'}</button>}
        </div>
        {!host && <p className="text-xs text-amber-700 dark:text-amber-400">Set this site’s website URL before enabling log mode.</p>}
        {notice && <p role="status" className="text-xs text-amber-700 dark:text-amber-400">{notice}</p>}
        {token && <div>
          <label className="text-xs font-medium" htmlFor="crawler-token">Server token — keep private</label>
          <input id="crawler-token" readOnly value={token} onFocus={e => e.currentTarget.select()} className="field mt-1 font-mono text-xs" />
          <button className="mt-2 text-xs font-semibold text-[#b06a1f] dark:text-[#ffa950]" onClick={download}>Download private collector configuration</button>
        </div>}
        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer font-medium text-zinc-700 dark:text-zinc-300">Install on the website’s server</summary>
          <ol className="mt-2 list-decimal space-y-2 pl-4 leading-relaxed">
            <li>Add the JSON access-log format from the setup guide to the website’s Nginx configuration.</li>
            <li>Download <a className="underline" href="/insight-log-collector.py" download>the Python collector</a> and save its private configuration with mode 0600.</li>
            <li>Enable log mode here, then start the collector on that server. Enabling alone does not install it or connect any logs.</li>
          </ol>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-100 p-2 dark:bg-zinc-900">{`chmod 600 insight-${site.id}.json\npython3 insight-log-collector.py --config insight-${site.id}.json --once`}</pre>
          <a className="mt-2 inline-block underline" href="/crawler-collection.txt" target="_blank" rel="noreferrer">Full setup guide / 中文接入说明</a>
        </details>
        {configured && <button disabled={busy} className="text-xs text-red-600 dark:text-red-400" onClick={() => { if (window.confirm('Revoke this token and return to script mode?')) void update('DELETE'); }}>Revoke token and disable</button>}
      </>}
      {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}
