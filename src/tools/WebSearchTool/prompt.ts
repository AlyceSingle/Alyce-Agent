export const WEB_SEARCH_TOOL_NAME = "WebSearch";

export const WEB_SEARCH_TOOL_DESCRIPTION = `Search the public web for up-to-date information.

Usage:
- query: search query text
- allowed_domains: optional allowlist for result domains
- blocked_domains: optional denylist for result domains
- max_results: optional number of results to return
- provider: optional provider override, one of auto, brave, exa, duckduckgo
- search_type: optional Exa mode, one of auto, fast, deep
- livecrawl: optional Exa crawl mode, one of fallback, preferred
- context_max_chars: optional maximum Exa context characters
- country: optional Brave Search country code, such as US or CN
- search_lang: optional Brave Search language code, such as en or zh-hans
- safe_search: optional Brave Search setting, one of off, moderate, strict
- freshness: optional Brave Search freshness filter, such as pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD

Notes:
- Use this tool when local files are insufficient and external information is needed.
- Default provider selection is controlled by ALYCE_WEB_SEARCH_PROVIDER and falls back to auto.
- auto tries Brave Search first when ALYCE_BRAVE_SEARCH_API_KEY or BRAVE_SEARCH_API_KEY is set, then Exa MCP, then DuckDuckGo HTML.
- auto also falls back when a provider returns no usable results after domain filtering.
- Results are cached briefly in memory; set ALYCE_WEB_SEARCH_CACHE_TTL_MS=0 to disable.
- DuckDuckGo HTML is a fallback and may be blocked by search-engine anti-bot systems.
- Include sources in the final answer when the response depends on web results.`;
