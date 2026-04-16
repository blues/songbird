/**
 * Tests for the Alerts API Lambda
 *
 * Tests alert listing (with serial number resolution), single alert retrieval,
 * acknowledge, and bulk acknowledge operations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';

import { handler } from './index';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/alerts',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {
      http: { method: 'GET' },
    } as any,
    resource: '',
    ...overrides,
  };
}

function makeAlert(overrides: Record<string, any> = {}) {
  return {
    alert_id: `alert_dev1234_${Date.now()}`,
    device_uid: 'dev:1234',
    serial_number: 'songbird01-bds',
    fleet: 'default',
    type: 'temp_high',
    value: 35,
    threshold: 30,
    message: 'Temperature exceeded threshold',
    created_at: Date.now(),
    acknowledged: 'false',
    ...overrides,
  };
}

describe('handler routing', () => {
  it('returns 200 for OPTIONS', async () => {
    const event = makeEvent({
      requestContext: { http: { method: 'OPTIONS' } } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });

  it('returns 405 for unsupported methods', async () => {
    const event = makeEvent({
      requestContext: { http: { method: 'PUT' } } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(405);
  });
});

describe('GET /alerts - list alerts', () => {
  it('returns all alerts via scan', async () => {
    const alerts = [makeAlert(), makeAlert({ alert_id: 'alert_2', type: 'low_battery' })];
    ddbMock.on(ScanCommand).resolves({ Items: alerts });

    const event = makeEvent();
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.alerts).toHaveLength(2);
    expect(body.count).toBe(2);
  });

  it('returns unacknowledged alerts when filtered', async () => {
    const alerts = [makeAlert()];
    ddbMock.on(QueryCommand).resolves({ Items: alerts });

    const event = makeEvent({
      queryStringParameters: { acknowledged: 'false' },
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls[0].args[0].input.IndexName).toBe('status-index');
  });

  it('resolves serial_number to device_uid(s) and merges alerts', async () => {
    // Device alias lookup
    ddbMock.on(GetCommand, {
      TableName: process.env.DEVICE_ALIASES_TABLE,
    }).resolves({
      Item: {
        serial_number: 'sb01',
        device_uid: 'dev:current',
        previous_device_uids: ['dev:old'],
      },
    });

    // Alerts for current device_uid
    ddbMock.on(QueryCommand, {
      ExpressionAttributeValues: { ':device_uid': 'dev:current' },
    }).resolves({
      Items: [makeAlert({ alert_id: 'a1', device_uid: 'dev:current', created_at: 2000 })],
    });

    // Alerts for old device_uid
    ddbMock.on(QueryCommand, {
      ExpressionAttributeValues: { ':device_uid': 'dev:old' },
    }).resolves({
      Items: [makeAlert({ alert_id: 'a2', device_uid: 'dev:old', created_at: 1000 })],
    });

    const event = makeEvent({
      queryStringParameters: { serial_number: 'sb01' },
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.alerts).toHaveLength(2);
    // Should be sorted by created_at descending
    expect(body.alerts[0].alert_id).toBe('a1');
    expect(body.alerts[1].alert_id).toBe('a2');
  });

  it('returns empty when serial_number has no alias', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const event = makeEvent({
      queryStringParameters: { serial_number: 'nonexistent' },
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.alerts).toEqual([]);
    expect(body.count).toBe(0);
  });

  it('calculates active_count correctly', async () => {
    const alerts = [
      makeAlert({ acknowledged: 'false' }),
      makeAlert({ acknowledged: 'false' }),
      makeAlert({ acknowledged: 'true' }),
    ];
    ddbMock.on(ScanCommand).resolves({ Items: alerts });

    const event = makeEvent();
    const result = await handler(event);

    const body = JSON.parse(result.body);
    expect(body.active_count).toBe(2);
  });
});

describe('GET /alerts/{alert_id}', () => {
  it('returns single alert', async () => {
    const alert = makeAlert({ alert_id: 'alert_123' });
    ddbMock.on(GetCommand).resolves({ Item: alert });

    const event = makeEvent({
      pathParameters: { alert_id: 'alert_123' },
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.alert_id).toBe('alert_123');
  });

  it('returns 404 when alert not found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const event = makeEvent({
      pathParameters: { alert_id: 'nonexistent' },
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });
});

describe('POST /alerts/{alert_id}/acknowledge', () => {
  it('acknowledges alert with user info', async () => {
    const acknowledged = makeAlert({
      alert_id: 'alert_123',
      acknowledged: 'true',
      acknowledged_at: Date.now(),
      acknowledged_by: 'user@example.com',
    });
    ddbMock.on(UpdateCommand).resolves({ Attributes: acknowledged });

    const event = makeEvent({
      httpMethod: 'POST',
      requestContext: { http: { method: 'POST' } } as any,
      pathParameters: { alert_id: 'alert_123' },
      path: '/alerts/alert_123/acknowledge',
      body: JSON.stringify({ acknowledged_by: 'user@example.com' }),
    });
    (event as any).rawPath = '/alerts/alert_123/acknowledge';

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues![':ack']).toBe('true');
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues![':ack_by']).toBe('user@example.com');
  });

  it('defaults acknowledged_by to system when not provided', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: makeAlert({ acknowledged: 'true' }) });

    const event = makeEvent({
      httpMethod: 'POST',
      requestContext: { http: { method: 'POST' } } as any,
      pathParameters: { alert_id: 'alert_123' },
      path: '/alerts/alert_123/acknowledge',
    });
    (event as any).rawPath = '/alerts/alert_123/acknowledge';

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues![':ack_by']).toBe('system');
  });
});

describe('POST /alerts/acknowledge-all', () => {
  it('bulk acknowledges multiple alerts', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    const event = makeEvent({
      httpMethod: 'POST',
      requestContext: { http: { method: 'POST' } } as any,
      path: '/alerts/acknowledge-all',
      body: JSON.stringify({
        alert_ids: ['alert_1', 'alert_2', 'alert_3'],
        acknowledged_by: 'admin@example.com',
      }),
    });
    (event as any).rawPath = '/alerts/acknowledge-all';

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.acknowledged).toBe(3);
    expect(body.total).toBe(3);
  });

  it('returns 400 when alert_ids is empty', async () => {
    const event = makeEvent({
      httpMethod: 'POST',
      requestContext: { http: { method: 'POST' } } as any,
      path: '/alerts/acknowledge-all',
      body: JSON.stringify({ alert_ids: [] }),
    });
    (event as any).rawPath = '/alerts/acknowledge-all';

    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  it('handles partial failures in bulk acknowledge', async () => {
    // First two succeed, third fails
    ddbMock.on(UpdateCommand)
      .resolvesOnce({ Attributes: {} })
      .resolvesOnce({ Attributes: {} })
      .rejectsOnce(new Error('ConditionalCheckFailedException'));

    const event = makeEvent({
      httpMethod: 'POST',
      requestContext: { http: { method: 'POST' } } as any,
      path: '/alerts/acknowledge-all',
      body: JSON.stringify({
        alert_ids: ['alert_1', 'alert_2', 'alert_3'],
      }),
    });
    (event as any).rawPath = '/alerts/acknowledge-all';

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.acknowledged).toBe(2);
    expect(body.failed).toBe(1);
  });
});
