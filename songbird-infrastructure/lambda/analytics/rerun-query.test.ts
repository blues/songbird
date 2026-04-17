import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { handler } from './rerun-query';
import { APIGatewayProxyEvent } from 'aws-lambda';

const rdsMock = mockClient(RDSDataClient);

function makeEvent(body: Record<string, unknown>): APIGatewayProxyEvent {
  return {
    body: JSON.stringify(body),
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
  };
}

beforeEach(() => {
  rdsMock.reset();
});

describe('rerun-query handler', () => {
  it('returns 400 when sql is missing', async () => {
    const result = await handler(makeEvent({ userEmail: 'user@test.com' }));
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('Missing required fields');
  });

  it('returns 400 when userEmail is missing', async () => {
    const result = await handler(makeEvent({ sql: 'SELECT * FROM analytics.devices WHERE serial_number IN (:deviceFilter)' }));
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('Missing required fields');
  });

  it('returns 400 when body is empty', async () => {
    const result = await handler(makeEvent({}));
    expect(result.statusCode).toBe(400);
  });

  it('returns 500 when SQL does not start with SELECT or WITH', async () => {
    const result = await handler(makeEvent({
      sql: 'INSERT INTO analytics.devices VALUES (:deviceFilter)',
      userEmail: 'user@test.com',
    }));
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error).toContain('Only SELECT queries are allowed');
  });

  it('returns 500 when SQL contains dangerous keywords', async () => {
    const result = await handler(makeEvent({
      sql: 'SELECT * FROM analytics.devices WHERE serial_number IN (:deviceFilter); DROP TABLE analytics.devices',
      userEmail: 'user@test.com',
    }));
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error).toContain("'drop'");
  });

  it('returns 500 when SQL is missing :deviceFilter placeholder', async () => {
    const result = await handler(makeEvent({
      sql: 'SELECT * FROM analytics.devices',
      userEmail: 'user@test.com',
    }));
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error).toContain(':deviceFilter');
  });

  it('executes query successfully with device serial numbers', async () => {
    // First call: fetch device serial numbers
    rdsMock.on(ExecuteStatementCommand).resolvesOnce({
      records: [
        [{ stringValue: 'sb01' }],
        [{ stringValue: 'sb02' }],
      ],
    })
    // Second call: execute the actual query
    .resolvesOnce({
      records: [
        [{ stringValue: 'sb01' }, { doubleValue: 22.5 }],
      ],
      columnMetadata: [
        { name: 'serial_number' },
        { name: 'temperature' },
      ],
    });

    const result = await handler(makeEvent({
      sql: "SELECT serial_number, temperature FROM analytics.telemetry WHERE serial_number IN (:deviceFilter)",
      userEmail: 'user@test.com',
    }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].serial_number).toBe('sb01');
    expect(body.data[0].temperature).toBe(22.5);
  });

  it('falls back to telemetry table when devices table is empty', async () => {
    // First call: devices table returns empty
    rdsMock.on(ExecuteStatementCommand).resolvesOnce({
      records: [],
    })
    // Second call: fallback to telemetry
    .resolvesOnce({
      records: [
        [{ stringValue: 'sb03' }],
      ],
    })
    // Third call: actual query execution
    .resolvesOnce({
      records: [
        [{ longValue: 5 }],
      ],
      columnMetadata: [
        { name: 'count' },
      ],
    });

    const result = await handler(makeEvent({
      sql: "SELECT count(*) as count FROM analytics.telemetry WHERE serial_number IN (:deviceFilter)",
      userEmail: 'user@test.com',
    }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data[0].count).toBe(5);
  });

  it('returns empty data when query returns no records', async () => {
    rdsMock.on(ExecuteStatementCommand).resolvesOnce({
      records: [[{ stringValue: 'sb01' }]],
    }).resolvesOnce({
      records: undefined,
    });

    const result = await handler(makeEvent({
      sql: "SELECT * FROM analytics.telemetry WHERE serial_number IN (:deviceFilter) AND temperature > 100",
      userEmail: 'user@test.com',
    }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).data).toEqual([]);
  });

  it('handles boolean and null values in response', async () => {
    rdsMock.on(ExecuteStatementCommand).resolvesOnce({
      records: [[{ stringValue: 'sb01' }]],
    }).resolvesOnce({
      records: [
        [{ booleanValue: true }, { isNull: true }],
      ],
      columnMetadata: [
        { name: 'acknowledged' },
        { name: 'acknowledged_by' },
      ],
    });

    const result = await handler(makeEvent({
      sql: "SELECT acknowledged, acknowledged_by FROM analytics.alerts WHERE serial_number IN (:deviceFilter)",
      userEmail: 'user@test.com',
    }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data[0].acknowledged).toBe(true);
    expect(body.data[0].acknowledged_by).toBeNull();
  });

  it('allows queries starting with WITH', async () => {
    rdsMock.on(ExecuteStatementCommand).resolvesOnce({
      records: [[{ stringValue: 'sb01' }]],
    }).resolvesOnce({
      records: [[{ longValue: 10 }]],
      columnMetadata: [{ name: 'total' }],
    });

    const result = await handler(makeEvent({
      sql: "WITH cte AS (SELECT * FROM analytics.devices WHERE serial_number IN (:deviceFilter)) SELECT count(*) as total FROM cte",
      userEmail: 'user@test.com',
    }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).data[0].total).toBe(10);
  });

  it('returns 500 when RDS query fails', async () => {
    rdsMock.on(ExecuteStatementCommand).rejects(new Error('RDS connection timeout'));

    const result = await handler(makeEvent({
      sql: "SELECT * FROM analytics.telemetry WHERE serial_number IN (:deviceFilter)",
      userEmail: 'user@test.com',
    }));

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error).toBe('RDS connection timeout');
  });

  it('includes CORS headers in all responses', async () => {
    const result = await handler(makeEvent({}));
    expect(result.headers?.['Access-Control-Allow-Origin']).toBe('*');
    expect(result.headers?.['Content-Type']).toBe('application/json');
  });
});
