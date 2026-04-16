import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { handler } from './sync-to-aurora';
import { DynamoDBStreamEvent } from 'aws-lambda';

const rdsMock = mockClient(RDSDataClient);

beforeEach(() => {
  rdsMock.reset();
});

function makeStreamEvent(
  tableName: string,
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE',
  image: Record<string, any>,
  imageKey: 'NewImage' | 'OldImage' = eventName === 'REMOVE' ? 'OldImage' : 'NewImage',
): DynamoDBStreamEvent {
  return {
    Records: [{
      eventName,
      eventSourceARN: `arn:aws:dynamodb:us-east-1:123:table/${tableName}/stream/2024-01-01`,
      dynamodb: {
        [imageKey]: image,
      },
    }],
  };
}

describe('sync-to-aurora handler', () => {
  it('processes INSERT events for devices table', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({});

    const event = makeStreamEvent('songbird-devices', 'INSERT', {
      serial_number: { S: 'sb01' },
      device_uid: { S: 'dev:123' },
      name: { S: 'Songbird 01' },
      status: { S: 'active' },
    });

    await handler(event);

    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    expect(calls).toHaveLength(1);
    const sql = calls[0].args[0].input.sql!;
    expect(sql).toContain('INSERT INTO analytics.devices');
    expect(sql).toContain("'sb01'");
    expect(sql).toContain("'dev:123'");
    expect(sql).toContain('ON CONFLICT');
  });

  it('processes MODIFY events as upserts', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({});

    const event = makeStreamEvent('songbird-devices', 'MODIFY', {
      serial_number: { S: 'sb01' },
      device_uid: { S: 'dev:123' },
      status: { S: 'inactive' },
      temperature: { N: '25.5' },
    });

    await handler(event);

    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    expect(calls).toHaveLength(1);
    const sql = calls[0].args[0].input.sql!;
    expect(sql).toContain('INSERT INTO analytics.devices');
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('EXCLUDED');
  });

  it('processes REMOVE events as deletes', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({});

    const event = makeStreamEvent('songbird-devices', 'REMOVE', {
      serial_number: { S: 'sb01' },
    }, 'OldImage');

    await handler(event);

    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    expect(calls).toHaveLength(1);
    const sql = calls[0].args[0].input.sql!;
    expect(sql).toContain('DELETE FROM analytics.devices');
    expect(sql).toContain("serial_number = 'sb01'");
  });

  it('handles telemetry table with timestamp conversion', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({});

    // Timestamp in milliseconds (> 9999999999)
    const event = makeStreamEvent('songbird-telemetry', 'INSERT', {
      serial_number: { S: 'sb01' },
      device_uid: { S: 'dev:123' },
      timestamp: { N: '1704067200000' }, // ms
      temperature: { N: '22.5' },
      humidity: { N: '45' },
    });

    await handler(event);

    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    expect(calls).toHaveLength(1);
    const sql = calls[0].args[0].input.sql!;
    expect(sql).toContain('TO_TIMESTAMP(1704067200)');
    expect(sql).toContain('analytics.telemetry');
  });

  it('handles telemetry timestamp already in seconds', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({});

    const event = makeStreamEvent('songbird-telemetry', 'INSERT', {
      serial_number: { S: 'sb01' },
      device_uid: { S: 'dev:123' },
      timestamp: { N: '1704067200' }, // seconds
      temperature: { N: '22.5' },
    });

    await handler(event);

    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    const sql = calls[0].args[0].input.sql!;
    expect(sql).toContain('TO_TIMESTAMP(1704067200)');
  });

  it('handles locations table with lat/lon mapping', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({});

    const event = makeStreamEvent('songbird-locations', 'INSERT', {
      serial_number: { S: 'sb01' },
      device_uid: { S: 'dev:123' },
      timestamp: { N: '1704067200000' },
      latitude: { N: '37.7749' },
      longitude: { N: '-122.4194' },
      source: { S: 'gps' },
    });

    await handler(event);

    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    const sql = calls[0].args[0].input.sql!;
    expect(sql).toContain('analytics.locations');
    expect(sql).toContain('lat');
    expect(sql).toContain('lon');
    expect(sql).toContain('37.7749');
    expect(sql).toContain('-122.4194');
  });

  it('handles alerts table with boolean values', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({});

    const event = makeStreamEvent('songbird-alerts', 'INSERT', {
      alert_id: { S: 'alert-001' },
      serial_number: { S: 'sb01' },
      device_uid: { S: 'dev:123' },
      alert_type: { S: 'temperature_high' },
      severity: { S: 'warning' },
      acknowledged: { BOOL: false },
    });

    await handler(event);

    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    const sql = calls[0].args[0].input.sql!;
    expect(sql).toContain('analytics.alerts');
    expect(sql).toContain('FALSE');
  });

  it('handles journeys with device_uid but no serial_number (subquery)', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({});

    const event = makeStreamEvent('songbird-journeys', 'INSERT', {
      device_uid: { S: 'dev:123' },
      journey_id: { N: '1704067200' },
      status: { S: 'active' },
    });

    await handler(event);

    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    const sql = calls[0].args[0].input.sql!;
    expect(sql).toContain('FROM analytics.devices WHERE device_uid');
    expect(sql).toContain("'dev:123'");
  });

  it('skips records from unknown tables', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({});

    const event: DynamoDBStreamEvent = {
      Records: [{
        eventName: 'INSERT',
        eventSourceARN: 'arn:aws:dynamodb:us-east-1:123:table/unknown-table/stream/2024-01-01',
        dynamodb: {
          NewImage: { id: { S: 'test' } },
        },
      }],
    };

    await handler(event);

    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    expect(calls).toHaveLength(0);
  });

  it('returns early for empty Records array', async () => {
    const event: DynamoDBStreamEvent = { Records: [] };

    await handler(event);

    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    expect(calls).toHaveLength(0);
  });

  it('continues processing other records when one fails', async () => {
    let callCount = 0;
    rdsMock.on(ExecuteStatementCommand).callsFake(() => {
      callCount++;
      if (callCount === 1) {
        throw new Error('SQL error');
      }
      return {};
    });

    const event: DynamoDBStreamEvent = {
      Records: [
        {
          eventName: 'INSERT',
          eventSourceARN: 'arn:aws:dynamodb:us-east-1:123:table/songbird-devices/stream/2024-01-01',
          dynamodb: { NewImage: { serial_number: { S: 'sb01' }, device_uid: { S: 'dev:1' } } },
        },
        {
          eventName: 'INSERT',
          eventSourceARN: 'arn:aws:dynamodb:us-east-1:123:table/songbird-devices/stream/2024-01-01',
          dynamodb: { NewImage: { serial_number: { S: 'sb02' }, device_uid: { S: 'dev:2' } } },
        },
      ],
    };

    // Should not throw even though first SQL execution fails
    await handler(event);

    expect(callCount).toBe(2);
  });

  it('escapes single quotes in string values', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({});

    const event = makeStreamEvent('songbird-devices', 'INSERT', {
      serial_number: { S: 'sb01' },
      device_uid: { S: 'dev:123' },
      name: { S: "O'Reilly's Device" },
    });

    await handler(event);

    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    const sql = calls[0].args[0].input.sql!;
    expect(sql).toContain("O''Reilly''s Device");
  });
});
