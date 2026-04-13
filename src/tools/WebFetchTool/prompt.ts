export const WEB_FETCH_TOOL_NAME = "WebFetch";

export const DESCRIPTION = `Fetch content from a public URL.

Usage:
- url: fully qualified URL to fetch
- prompt: optional extraction hint used for heuristic filtering
- max_chars: optional maximum characters returned in content

Notes:
- This tool only supports publicly accessible pages.
- HTTP URLs are upgraded to HTTPS for safety.
- The returned content is plain text (HTML tags removed when needed).`;
