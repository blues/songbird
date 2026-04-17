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
