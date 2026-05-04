export const WEB_FETCH_TOOL_NAME = "WebFetch";

export const DESCRIPTION = `Fetch content from a public URL.

Usage:
- url: fully qualified URL to fetch
- prompt: optional extraction hint used for heuristic filtering
- format: optional return format for HTML responses, one of text, markdown, html. Defaults to markdown.
- max_chars: optional maximum characters returned in content
- max_bytes: optional maximum response bytes to download

Notes:
- This tool only supports publicly accessible pages.
- HTTP URLs are upgraded to HTTPS for safety.
- Requests use approval gates, public DNS/IP checks, response-size limits, cross-origin redirect approval, and browser-compatible headers.
- Wikimedia-like sites use a transparent User-Agent with a contact URL by default.
- If a site returns a managed challenge or Wikimedia-style "Too Many Reqs", Alyce retries once with a transparent User-Agent.
- Successful responses are cached briefly in memory with a total byte budget to avoid repeated requests.
- The returned content defaults to markdown for HTML pages, preserving links and headings better than plain text.`;
