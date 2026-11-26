// AI bot detection by user-agent token. IP verification (against the official ranges)
// will be added in a later phase; for now verified=0 by default.

export type BotCategory = 'answer' | 'search' | 'training';

export interface BotInfo {
  bot_name: string;
  vendor: string;
  category: BotCategory;
}

// Order matters: the most specific tokens come first (e.g. Claude-User before ClaudeBot).
export const BOT_CATALOG: (BotInfo & { tokens: string[] })[] = [
  {"tokens": ["ChatGPT-User"], "bot_name": "ChatGPT", "vendor": "openai", "category": "answer"},
  {"tokens": ["OAI-SearchBot"], "bot_name": "OAI-SearchBot", "vendor": "openai", "category": "search"},
  {"tokens": ["GPTBot"], "bot_name": "GPTBot", "vendor": "openai", "category": "training"},
  {"tokens": ["Claude-User"], "bot_name": "Claude", "vendor": "anthropic", "category": "answer"},
  {"tokens": ["Claude-SearchBot"], "bot_name": "Claude-SearchBot", "vendor": "anthropic", "category": "search"},
  {"tokens": ["ClaudeBot", "anthropic-ai"], "bot_name": "ClaudeBot", "vendor": "anthropic", "category": "training"},
  {"tokens": ["Perplexity-User"], "bot_name": "Perplexity", "vendor": "perplexity", "category": "answer"},
  {"tokens": ["PerplexityBot"], "bot_name": "PerplexityBot", "vendor": "perplexity", "category": "search"},
  {"tokens": ["Google-Extended"], "bot_name": "Google-Extended", "vendor": "google", "category": "training"},
  {"tokens": ["Google-CloudVertexBot", "GoogleAgent-Mariner", "Google-NotebookLM"], "bot_name": "Gemini", "vendor": "google", "category": "answer"},
  {"tokens": ["GoogleOther", "GoogleOther-Image", "GoogleOther-Video"], "bot_name": "GoogleOther", "vendor": "google", "category": "search"},
  {"tokens": ["Googlebot", "Googlebot-Image", "Googlebot-News", "Googlebot-Video"], "bot_name": "Googlebot", "vendor": "google", "category": "search"},
  {"tokens": ["BingBot", "bingbot", "msnbot", "msnbot-media", "MicrosoftPreview"], "bot_name": "Bing", "vendor": "microsoft", "category": "search"},
  {"tokens": ["Amazonbot"], "bot_name": "Amazon", "vendor": "amazon", "category": "search"},
  {"tokens": ["Applebot-Extended"], "bot_name": "Applebot-Extended", "vendor": "apple", "category": "training"},
  {"tokens": ["Applebot"], "bot_name": "Apple", "vendor": "apple", "category": "search"},
  {"tokens": ["meta-externalagent", "FacebookBot", "meta-externalfetcher"], "bot_name": "Meta", "vendor": "meta", "category": "training"},
  {"tokens": ["xai", "grok"], "bot_name": "Grok", "vendor": "xai", "category": "answer"},
  {"tokens": ["DuckAssistBot"], "bot_name": "DuckDuckGo", "vendor": "duckduckgo", "category": "answer"},
  {"tokens": ["DuckDuckBot", "DuckDuckGo-Favicons-Bot"], "bot_name": "DuckDuckGo", "vendor": "duckduckgo", "category": "search"},
  {"tokens": ["Bytespider"], "bot_name": "Bytespider", "vendor": "bytedance", "category": "search"},
  {"tokens": ["CCBot"], "bot_name": "CCBot", "vendor": "commoncrawl", "category": "training"},
  {"tokens": ["cohere-ai", "cohere-training-data-crawler"], "bot_name": "Cohere", "vendor": "cohere", "category": "training"},
  {"tokens": ["Timpibot"], "bot_name": "Timpi", "vendor": "timpi", "category": "training"},
  {"tokens": ["YouBot"], "bot_name": "You.com", "vendor": "you", "category": "search"},
  {"tokens": ["Kimi-User"], "bot_name": "Kimi-User", "vendor": "moonshot", "category": "answer"},
  {"tokens": ["Kimi-SearchBot"], "bot_name": "Kimi-SearchBot", "vendor": "moonshot", "category": "search"},
  {"tokens": ["KimiBot"], "bot_name": "KimiBot", "vendor": "moonshot", "category": "training"},
  {"tokens": ["HySpider"], "bot_name": "HySpider", "vendor": "tencent", "category": "training"},
  {"tokens": ["GLMBot"], "bot_name": "GLMBot", "vendor": "zhipu", "category": "training"},
  {"tokens": ["Baiduspider-render"], "bot_name": "Baiduspider-render", "vendor": "baidu", "category": "search"},
  {"tokens": ["Baiduspider"], "bot_name": "Baiduspider", "vendor": "baidu", "category": "search"},
  {"tokens": ["360Spider"], "bot_name": "360Spider", "vendor": "360", "category": "search"},
  {"tokens": ["Sogou web spider", "Sogou spider"], "bot_name": "Sogou spider", "vendor": "sogou", "category": "search"},
];

const escapeToken = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const AI_BOT_REGEX = `(?:^|[\\s;(])(?:${BOT_CATALOG.flatMap(b => b.tokens).map(escapeToken).join('|')})(?=$|[\\s;/),])`;
const rules = BOT_CATALOG.map(b => ({ ...b, token: new RegExp(`(?:^|[\\s;(])(?:${b.tokens.map(escapeToken).join('|')})(?=$|[\\s;/),])`, 'i') }));

export function detectBot(ua: string): BotInfo | null {
  if (!ua) return null;
  const products = ua.replace(/https?:\/\/[^\s;)]+/gi, '');
  for (const b of rules) {
    if (b.token.test(products)) return { bot_name: b.bot_name, vendor: b.vendor, category: b.category };
  }
  return null;
}

// Generic bots + headless browsers + previews/monitors. Used to filter the tracker
// (the same way GA4 excludes bots), so a fake visitor never shows up on the map.
const GENERIC_BOT_RE = /bot\b|crawl|spider|slurp|headless|puppeteer|playwright|phantom|lighthouse|prerender|pre-?render|preview|monitor|pingdom|uptime|statuscake|curl|wget|python-requests|node-fetch|axios|go-http|okhttp|java\/|apache-httpclient|libwww|scrapy|facebookexternalhit|whatsapp|telegram|discord|slackbot|embedly|redditbot|semrush|ahrefs|mj12|dotbot|petalbot|dataprovider|google-inspectiontool|chrome-lighthouse/i;

export function isBot(ua: string): boolean {
  if (!ua) return true; // a pageview with no User-Agent = script/bot
  return GENERIC_BOT_RE.test(ua) || detectBot(ua) !== null;
}
