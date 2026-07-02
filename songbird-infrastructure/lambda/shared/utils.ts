/**
 * Shared utility helpers for Lambda handlers
 */

/**
 * Safely parse an integer query-string parameter.
 *
 * Returns `defaultVal` when the value is missing, non-numeric, less than 1,
 * or not finite — preventing NaN from propagating into DynamoDB Limit params.
 * Optionally clamps the result to `max`.
 */
export function parseIntParam(
  value: string | undefined,
  defaultVal: number,
  max?: number
): number {
  const parsed = parseInt(value || String(defaultVal), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultVal;
  return max !== undefined ? Math.min(parsed, max) : parsed;
}

const REDACTED = '[REDACTED]';

// Header names (lower-cased) whose values must never reach CloudWatch.
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'x-api-key',
  'x-amz-security-token',
  'x-session-token',
]);

// Body/field names (lower-cased) that carry secrets or credentials.
const SENSITIVE_FIELDS = new Set([
  'authorization',
  'password',
  'passwd',
  'secret',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'idtoken',
  'id_token',
  'apikey',
  'api_key',
  'ssid',
  'wifi',
  'credentials',
  'authtoken',
  'auth_token',
]);

/**
 * Recursively redact sensitive header and body fields from an arbitrary value
 * so it is safe to `console.log`. Never mutates the input.
 *
 * - Header objects (`headers`/`multiValueHeaders`) have their sensitive
 *   entries replaced case-insensitively.
 * - Any property whose (lower-cased) name is in {@link SENSITIVE_FIELDS} is
 *   replaced with `[REDACTED]`.
 * - `Authorization`/`Bearer` tokens embedded in string values are masked.
 */
export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    // Mask any inline bearer token regardless of where it appears.
    return value.replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, `$1${REDACTED}`);
  }

  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((v) => redact(v));
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_HEADERS.has(lower) || SENSITIVE_FIELDS.has(lower)) {
      out[key] = REDACTED;
    } else {
      out[key] = redact(val);
    }
  }
  return out;
}

/**
 * Serialize an object for logging with all sensitive fields redacted.
 * Drop-in replacement for `JSON.stringify(event)` in handler entry logs.
 */
export function safeStringify(value: unknown, space?: number): string {
  return JSON.stringify(redact(value), null, space);
}
