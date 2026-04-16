import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from './backfill';

const rdsMock = mockClient(RDSDataClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  rdsMock.reset();
  ddbMock.reset();
});

describe('backfill handler', () => {
  it('returns 200 with summary on successful backfill', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
    rdsMock.on(ExecuteStatementCommand).resolves({});

    const result = await handler({});

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body).toHaveProperty('totalRecords');
    expect(body).toHaveProperty('totalErrors');
    expect(body).toHaveProperty('tables');
  });

  it('processes all 5 tables when no filter is provided', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [], LastEvaluatedKey: undefined });

    const result = await handler({});

    const body = JSON.parse(result.body);
    expect(body.tables).toHaveLength(5);
    const tableNames = body.tables.map((t: any) => t.table);
    expect(tableNames).toContain('songbird-devices');
    expect(tableNames).toContain('songbird-telemetry');
    expect(tableNames).toContain('songbird-locations');
    expect(tableNames).toContain('songbird-alerts');
    expect(tableNames).toContain('songbird-journeys');
  });

  it('filters to only specified tables', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [], LastEvaluatedKey: undefined });

    const result = await handler({ tables: ['songbird-devices'] });

    const body = JSON.parse(result.body);
    expect(body.tables).toHaveLength(1);
    expect(body.tables[0].table).toBe('songbird-devices');
  });

  it('upserts DynamoDB items to Aurora', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { serial_number: 'sb01', device_uid: 'dev:1', name: 'Songbird 01', status: 'active' },
      ],
      LastEvaluatedKey: undefined,
    });
    rdsMock.on(ExecuteStatementCommand).resolves({});

    const result = await handler({ tables: ['songbird-devices'] });

    const body = JSON.parse(result.body);
    expect(body.totalRecords).toBe(1);
    expect(body.totalErrors).toBe(0);

    const rdsCalls = rdsMock.commandCalls(ExecuteStatementCommand);
    expect(rdsCalls.length).toBe(1);
    const sql = rdsCalls[0].args[0].input.sql!;
    expect(sql).toContain('INSERT INTO analytics.devices');
    expect(sql).toContain("'sb01'");
    expect(sql).toContain('ON CONFLICT');
  });

  it('handles pagination via LastEvaluatedKey', async () => {
    ddbMock.on(ScanCommand)
      .resolvesOnce({
        Items: [{ serial_number: 'sb01', device_uid: 'dev:1' }],
        LastEvaluatedKey: { serial_number: 'sb01' },
      })
      .resolvesOnce({
        Items: [{ serial_number: 'sb02', device_uid: 'dev:2' }],
        LastEvaluatedKey: undefined,
      });
    rdsMock.on(ExecuteStatementCommand).resolves({});

    const result = await handler({ tables: ['songbird-devices'] });

    const body = JSON.parse(result.body);
    expect(body.totalRecords).toBe(2);

    const scanCalls = ddbMock.commandCalls(ScanCommand);
    expect(scanCalls).toHaveLength(2);
    // Second scan should include ExclusiveStartKey
    expect(scanCalls[1].args[0].input.ExclusiveStartKey).toEqual({ serial_number: 'sb01' });
  });

  it('handles timestamp conversion for telemetry (milliseconds to seconds)', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { serial_number: 'sb01', device_uid: 'dev:1', timestamp: 1704067200000, temperature: 22.5 },
      ],
      LastEvaluatedKey: undefined,
    });
    rdsMock.on(ExecuteStatementCommand).resolves({});

    await handler({ tables: ['songbird-telemetry'] });

    const rdsCalls = rdsMock.commandCalls(ExecuteStatementCommand);
    const sql = rdsCalls[0].args[0].input.sql!;
    expect(sql).toContain('TO_TIMESTAMP(1704067200)');
  });

  it('handles boolean values correctly', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { alert_id: 'alert-001', serial_number: 'sb01', acknowledged: true },
      ],
      LastEvaluatedKey: undefined,
    });
    rdsMock.on(ExecuteStatementCommand).resolves({});

    await handler({ tables: ['songbird-alerts'] });

    const rdsCalls = rdsMock.commandCalls(ExecuteStatementCommand);
    const sql = rdsCalls[0].args[0].input.sql!;
    expect(sql).toContain('TRUE');
  });

  it('escapes single quotes in string values', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { serial_number: 'sb01', device_uid: 'dev:1', name: "O'Brien's" },
      ],
      LastEvaluatedKey: undefined,
    });
    rdsMock.on(ExecuteStatementCommand).resolves({});

    await handler({ tables: ['songbird-devices'] });

    const rdsCalls = rdsMock.commandCalls(ExecuteStatementCommand);
    const sql = rdsCalls[0].args[0].input.sql!;
    expect(sql).toContain("O''Brien''s");
  });

  it('counts individual insert errors without failing the whole table', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { serial_number: 'sb01', device_uid: 'dev:1' },
        { serial_number: 'sb02', device_uid: 'dev:2' },
      ],
      LastEvaluatedKey: undefined,
    });
    rdsMock.on(ExecuteStatementCommand)
      .rejectsOnce(new Error('constraint violation'))
      .resolvesOnce({});

    const result = await handler({ tables: ['songbird-devices'] });

    const body = JSON.parse(result.body);
    expect(body.totalRecords).toBe(1);
    expect(body.totalErrors).toBe(1);
  });

  it('handles table-level errors gracefully', async () => {
    ddbMock.on(ScanCommand).rejects(new Error('DynamoDB access denied'));

    const result = await handler({ tables: ['songbird-devices'] });

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.tables[0].errors).toBe(-1);
    expect(body.tables[0].count).toBe(0);
  });

  it('skips items with no mapped columns', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { unmapped_field: 'value' },
      ],
      LastEvaluatedKey: undefined,
    });
    rdsMock.on(ExecuteStatementCommand).resolves({});

    const result = await handler({ tables: ['songbird-devices'] });

    const body = JSON.parse(result.body);
    expect(body.totalRecords).toBe(0);
    const rdsCalls = rdsMock.commandCalls(ExecuteStatementCommand);
    expect(rdsCalls).toHaveLength(0);
  });

  it('maps journey total_distance to distance_km', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { serial_number: 'sb01', journey_id: 1704067200, status: 'completed', total_distance: 42.5 },
      ],
      LastEvaluatedKey: undefined,
    });
    rdsMock.on(ExecuteStatementCommand).resolves({});

    await handler({ tables: ['songbird-journeys'] });

    const rdsCalls = rdsMock.commandCalls(ExecuteStatementCommand);
    const sql = rdsCalls[0].args[0].input.sql!;
    expect(sql).toContain('distance_km');
    expect(sql).toContain('42.5');
  });
});
