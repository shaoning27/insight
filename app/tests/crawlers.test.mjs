import test from 'node:test';
import assert from 'node:assert/strict';
import { detectBot, isBot, AI_BOT_REGEX } from '../src/lib/bots.ts';

for (const [token, name, vendor, category] of [
 ['Kimi-User','Kimi-User','moonshot','answer'], ['Kimi-SearchBot','Kimi-SearchBot','moonshot','search'],
 ['KimiBot','KimiBot','moonshot','training'], ['HySpider','HySpider','tencent','training'],
 ['GLMBot','GLMBot','zhipu','training'], ['Baiduspider','Baiduspider','baidu','search'],
 ['360Spider','360Spider','360','search'], ['Bytespider','Bytespider','bytedance','search'],
 ['ChatGPT-User','ChatGPT','openai','answer'], ['ClaudeBot','ClaudeBot','anthropic','training'],
 ['PerplexityBot','PerplexityBot','perplexity','search'], ['Applebot-Extended','Applebot-Extended','apple','training'],
]) test(`identifies ${token} with its purpose`,()=>{
 const ua=`Mozilla/5.0 (compatible; ${token}/1.0; +https://vendor.example/bot)`;
 assert.deepEqual(detectBot(ua), {bot_name:name,vendor,category});
 assert.equal(isBot(ua),true);
 assert.match(ua,new RegExp(AI_BOT_REGEX,'i'));
});
for(const ua of ['', 'Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
 'Mozilla/5.0 myKimiBotBrowser/1.0', 'Mozilla/5.0 (contact https://example.com/GPTBot)',
 'Mozilla/5.0 (https://example.com/HySpider/1.0)', 'Mozilla/5.0 DeepSeekBot/1.0']) {
 test(`does not identify unsupported or misleading UA ${ua}`,()=>assert.equal(detectBot(ua),null));
}
for (const token of ['Googlebot-Image','Googlebot-News','Googlebot-Video','GoogleOther-Image','msnbot-media']) {
 test(`preserves existing indexing family ${token}`,()=>assert.ok(detectBot(`${token}/1.0`)));
}
