import test from 'node:test';
import assert from 'node:assert/strict';
import { readCrawlerJson } from '../src/lib/crawler-http.ts';
test('requires JSON and rejects malformed or oversized bodies',async()=>{
 const req=(body,type='application/json')=>new Request('https://example.test',{method:'POST',body,headers:{'Content-Type':type}});
 assert.deepEqual(await readCrawlerJson(req('{"ok":true}')),{ok:true});
 await assert.rejects(()=>readCrawlerJson(req('not json')),e=>e.status===400);
 await assert.rejects(()=>readCrawlerJson(req('{}','text/plain')),e=>e.status===415);
 await assert.rejects(()=>readCrawlerJson(req(' '.repeat(524289))),e=>e.status===413);
});
