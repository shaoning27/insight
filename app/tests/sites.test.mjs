import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as sites from '../src/lib/sites.ts';
const dir=await mkdtemp(path.join(os.tmpdir(),'insight-sites-'));
process.env.SQLITE_PATH=path.join(dir,'insight.db');
test.after(()=>rm(dir,{recursive:true,force:true}));
test('concurrent site mutations do not overwrite each other',async()=>{
 await Promise.all(Array.from({length:12},(_,i)=>sites.addSite(`Site ${i}`,`https://site${i}.example`)));
 assert.equal((await sites.listSites()).length,12);
});
test('crawler settings stay private and updates preserve other site fields',async()=>{
 assert.equal(typeof sites.setCrawlerConfig,'function');
 const site=await sites.addSite('Crawler site','https://example.com');
 await Promise.all([sites.setCrawlerConfig(site.id,{tokenHash:'a'.repeat(64)}),sites.setStripeKey(site.id,'test-key')]);
 await sites.setCrawlerConfig(site.id,{enabled:true});
 const saved=await sites.getSite(site.id);
 assert.equal(saved.crawlerLogsEnabled,true);assert.equal(saved.stripeKey,'test-key');
 assert.equal(saved.crawlerTokenHash,'a'.repeat(64));
 assert.equal('crawlerTokenHash' in sites.toPublic(saved),false);
 await sites.setCrawlerConfig(site.id,{tokenHash:null,enabled:false});
 assert.equal((await sites.getSite(site.id)).crawlerTokenHash,undefined);
 assert.equal((await stat(path.join(dir,'sites.json'))).mode & 0o777,0o600);
});
test('cannot enable log capture without an ingestion token',async()=>{
 assert.equal(typeof sites.setCrawlerConfig,'function');
 const s=await sites.addSite('No token','https://example.com');
 await assert.rejects(()=>sites.setCrawlerConfig(s.id,{enabled:true}));
});
test('changing or clearing hostname revokes log mode while www changes preserve it',async()=>{
 const site=await sites.addSite('URL boundary','https://example.com');
 await sites.setCrawlerConfig(site.id,{tokenHash:'b'.repeat(64),enabled:true});
 await sites.setSiteUrl(site.id,'https://www.example.com');
 assert.equal((await sites.getSite(site.id)).crawlerLogsEnabled,true);
 await sites.setSiteUrl(site.id,'');
 assert.equal((await sites.getSite(site.id)).crawlerLogsEnabled,false);
 assert.equal((await sites.getSite(site.id)).crawlerTokenHash,undefined);
});
