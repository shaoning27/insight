import test from 'node:test';
import assert from 'node:assert/strict';
import { withCrawlerLock } from '../src/lib/crawler-lock.ts';
test('serializes retries for one site while letting different sites progress',async()=>{
 let release;const gate=new Promise(r=>release=r);const order=[];
 const a=withCrawlerLock('a',async()=>{order.push('a1');await gate;order.push('a2');});
 const b=withCrawlerLock('a',async()=>order.push('a3'));
 await withCrawlerLock('b',async()=>order.push('b'));
 assert.deepEqual(order,['a1','b']);release();await Promise.all([a,b]);assert.deepEqual(order,['a1','b','a2','a3']);
});
test('a failed request does not block the next upload',async()=>{
 await assert.rejects(withCrawlerLock('fail',async()=>{throw new Error('failure');}));
 assert.equal(await withCrawlerLock('fail',async()=>42),42);
});
