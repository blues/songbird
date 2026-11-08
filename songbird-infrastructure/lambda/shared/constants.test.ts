import { describe, it, expect } from 'vitest';
import { ACK_SHARD_COUNT, ACKNOWLEDGED, computeAckShard } from './constants';

describe('computeAckShard', () => {
  it('produces a "<acknowledged>#<shard>" composite value', () => {
    const value = computeAckShard(ACKNOWLEDGED.FALSE, 'alert_abc');
    expect(value).toMatch(/^false#\d+$/);
  });

  it('is deterministic for a given alert id', () => {
    const a = computeAckShard(ACKNOWLEDGED.FALSE, 'alert_abc');
    const b = computeAckShard(ACKNOWLEDGED.FALSE, 'alert_abc');
    expect(a).toBe(b);
  });

  it('keeps the shard within the configured shard count', () => {
    for (let i = 0; i < 200; i++) {
      const value = computeAckShard(ACKNOWLEDGED.FALSE, `alert_${i}`);
      const shard = Number(value.split('#')[1]);
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(ACK_SHARD_COUNT);
    }
  });

  it('distributes different alert ids across multiple shards', () => {
    const shards = new Set<string>();
    for (let i = 0; i < 200; i++) {
      shards.add(computeAckShard(ACKNOWLEDGED.FALSE, `alert_${i}`));
    }
    // Should land in more than one partition (the whole point of sharding)
    expect(shards.size).toBeGreaterThan(1);
  });

  it('reflects the acknowledged prefix', () => {
    expect(computeAckShard(ACKNOWLEDGED.TRUE, 'alert_x')).toMatch(/^true#\d+$/);
    expect(computeAckShard(ACKNOWLEDGED.FALSE, 'alert_x')).toMatch(/^false#\d+$/);
  });

  it('falls back to a valid shard when no alert id is supplied', () => {
    const value = computeAckShard(ACKNOWLEDGED.FALSE);
    const shard = Number(value.split('#')[1]);
    expect(shard).toBeGreaterThanOrEqual(0);
    expect(shard).toBeLessThan(ACK_SHARD_COUNT);
  });
});
