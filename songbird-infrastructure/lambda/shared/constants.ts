/**
 * Shared constants for Lambda functions
 */

// Stored as strings because DynamoDB GSI partition keys cannot be boolean
export const ACKNOWLEDGED = {
  TRUE: 'true' as const,
  FALSE: 'false' as const,
} as const;

// Number of shards used by the alerts `status-shard-index` GSI.
//
// The legacy `status-index` partitions solely on `acknowledged` (two possible
// values), which concentrates every unacknowledged alert into one partition —
// a write/read hot partition as volume grows. `ack_shard` fans writes across a
// small, fixed set of partitions ("<acknowledged>#<shard>"); readers
// scatter-gather across all shards and merge by `created_at`.
//
// Keep this in sync with any reader that queries `status-shard-index`.
export const ACK_SHARD_COUNT = 8;

/**
 * Compute the composite `ack_shard` GSI partition value for an alert.
 *
 * Deterministically derives a shard from the alert id so the same alert always
 * maps to the same shard. Falls back to a random shard when no id is supplied.
 */
export function computeAckShard(acknowledged: string, alertId?: string): string {
  let shard = 0;
  if (alertId) {
    let hash = 0;
    for (let i = 0; i < alertId.length; i++) {
      hash = (hash * 31 + alertId.charCodeAt(i)) | 0;
    }
    shard = Math.abs(hash) % ACK_SHARD_COUNT;
  } else {
    shard = Math.floor(Math.random() * ACK_SHARD_COUNT);
  }
  return `${acknowledged}#${shard}`;
}
