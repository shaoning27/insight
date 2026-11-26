import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCrawlerBatch, tokenDigest, tokenMatches } from '../src/lib/crawler-events.ts';
const now=Date.parse('2026-11-26T03:00:00Z');
const site={id:'example',url:'https://example.com'};
const event={id:'request-0001',ts:'2026-11-26T02:00:00Z',host:'www.example.com',method:'GET',content_type:'text/html; charset=utf-8',path:'/article?email=private#secret',user_agent:'Mozilla/5.0 (compatible; Kimi-User/1.0)',status_code:404};
const body=(e=event)=>({site_id:'example',source_id:'source-00001',requests:[e]});
test('keeps actual timestamp/status and strips query, fragment and IP',()=>{
 const {rows,ignored}=parseCrawlerBatch(body({...event,ip:'192.0.2.5'}),site,now);
 assert.equal(ignored,0);assert.equal(rows.length,1);assert.equal(rows[0].ts,'2026-11-26T02:00:00.000Z');
 assert.equal(rows[0].path,'/article');assert.equal(rows[0].status_code,404);assert.equal(rows[0].ip,'');assert.equal(rows[0].verified,0);
 assert.match(rows[0].request_id,/^[0-9a-f]{64}$/);
});
for(const change of [{host:'other.example.com'},{method:'POST'},{content_type:'application/javascript'},{path:'/t.js'},{path:'/image.png'},{user_agent:'Mozilla/5.0 Chrome/140.0'}]) {
 test(`ignores out-of-scope HTML observation ${JSON.stringify(change)}`,()=>assert.equal(parseCrawlerBatch(body({...event,...change}),site,now).rows.length,0));
}
for(const change of [{id:''},{ts:'invalid'},{ts:'2026-01-01T00:00:00Z'},{ts:'2026-11-26T04:00:00Z'},{path:'//other.example/path'},{status_code:999},{user_agent:'KimiBot/'+'x'.repeat(513)}]) {
 test(`rejects invalid event ${Object.keys(change)}`,()=>assert.throws(()=>parseCrawlerBatch(body({...event,...change}),site,now)));
}
test('validates site and batch boundaries',()=>{
 assert.throws(()=>parseCrawlerBatch({...body(),site_id:'other'},site,now));
 assert.throws(()=>parseCrawlerBatch({...body(),requests:Array(201).fill(event)},site,now));
});
test('deduplicates a retry and rejects conflicting reused identifiers',()=>{
 assert.equal(parseCrawlerBatch({...body(),requests:[event,event]},site,now).rows.length,1);
 assert.throws(()=>parseCrawlerBatch({...body(),requests:[event,{...event,path:'/other'}]},site,now),e=>e.status===409);
});
test('different collector sources cannot collide',()=>{
 const a=parseCrawlerBatch(body(),site,now).rows[0];
 const b=parseCrawlerBatch({...body(),source_id:'source-00002'},site,now).rows[0];
 assert.notEqual(a.request_id,b.request_id);
});
test('token digest authenticates exact secrets without storing plaintext',()=>{
 const token='a'.repeat(64);const digest=tokenDigest(token);
 assert.notEqual(token,digest);assert.equal(tokenMatches(token,digest),true);
 assert.equal(tokenMatches('b'.repeat(64),digest),false);assert.equal(tokenMatches('',digest),false);
});
