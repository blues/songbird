/**
 * URL sanitizer for model-controlled markdown.
 *
 * ChatMessage renders assistant/LLM-generated markdown. HTML is disabled by
 * default in react-markdown, but link/image URLs are still model-controlled,
 * so a `[click](javascript:...)` link could execute script on click.
 *
 * This guard-rail neutralizes dangerous URL schemes (javascript:, vbscript:,
 * data:, file:) before react-markdown renders them via its `urlTransform` prop.
 * Anything unsafe collapses to an empty string, which react-markdown renders as
 * an inert anchor. Keep HTML disabled (do NOT add rehype-raw) alongside this.
 */

// Schemes that must never be allowed through from model-controlled text.
const DANGEROUS_SCHEME = /^(?:javascript|vbscript|data|file):/i;

export function sanitizeUrl(url: string): string {
  if (!url) return '';

  // Strip control chars / whitespace that can be used to obfuscate the scheme
  // (e.g. "java\tscript:alert(1)" or leading newlines).
  const stripped = url.replace(/[\u0000-\u001F\u007F\s]/g, '');

  if (DANGEROUS_SCHEME.test(stripped)) {
    return '';
  }

  return url;
}
