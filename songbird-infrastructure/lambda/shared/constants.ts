/**
 * Shared constants for Lambda functions
 */

// Stored as strings because DynamoDB GSI partition keys cannot be boolean
export const ACKNOWLEDGED = {
  TRUE: 'true' as const,
  FALSE: 'false' as const,
} as const;
