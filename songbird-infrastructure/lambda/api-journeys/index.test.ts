/**
 * Tests for the Journeys API Lambda
 *
 * Tests journey listing (merged from multiple device_uids), journey detail,
 * delete authorization, map matching, and location history.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  DeleteCommand,
  BatchWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// Mock device-lookup module
vi.mock('../shared/device-lookup', () => ({
  resolveDevice: vi.fn(),
}));

// Mock global fetch for Mapbox API calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { handler } from './index';
import { resolveDevice } from '../shared/device-lookup';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  vi.mocked(resolveDevice).mockReset();
  mockFetch.mockReset();
});

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/devices/sb01/journeys',
    pathParameters: { serial_number: 'sb01' },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {
      http: { method: 'GET', path: '/devices/sb01/journeys' },
    } as any,
    resource: '',
    ...overrides,
  };
}

function makeJourney(overrides: Record<string, any> = {}) {
  return {
    device_uid: 'dev:1234',
    journey_id: 1700000000,
    start_time: 1700000000000,
    end_time: 1700003600000,
    point_count: 50,
    total_distance: 25000,
    status: 'completed',
    ...overrides,
  };
}

function makeLocationPoint(overrides: Record<string, any> = {}) {
  return {
    device_uid: 'dev:1234',
    timestamp: 1700000000000,
    latitude: 37.77,
    longitude: -122.42,
    velocity: 15,
    bearing: 90,
    distance: 500,
    dop: 1.2,
    journey_id: 1700000000,
    source: 'gps',
    ...overrides,
  };
}

describe('request validation', () => {
  it('returns 200 for OPTIONS', async () => {
    const event = makeEvent({
      pathParameters: null,
      requestContext: { http: { method: 'OPTIONS', path: '/devices/sb01/journeys' } } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });

  it('returns 400 when serial_number is missing', async () => {
    const event = makeEvent({
      pathParameters: null,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('serial_number');
  });

  it('returns 404 when device not found', async () => {
    vi.mocked(resolveDevice).mockResolvedValue(null);

    const event = makeEvent();

    const result = await handler(event);
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toContain('Device not found');
  });
});

describe('GET /devices/{serial_number}/journeys - list journeys', () => {
  it('merges journeys from multiple device_uids and sorts by journey_id desc', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:current',
      all_device_uids: ['dev:current', 'dev:old'],
    });

    // Journeys for current device
    ddbMock.on(QueryCommand, {
      TableName: process.env.JOURNEYS_TABLE,
      ExpressionAttributeValues: { ':device_uid': 'dev:current' },
    }).resolves({
      Items: [makeJourney({ device_uid: 'dev:current', journey_id: 1700003000 })],
    });

    // Journeys for old device
    ddbMock.on(QueryCommand, {
      TableName: process.env.JOURNEYS_TABLE,
      ExpressionAttributeValues: { ':device_uid': 'dev:old' },
    }).resolves({
      Items: [makeJourney({ device_uid: 'dev:old', journey_id: 1700001000 })],
    });

    const event = makeEvent();
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.journeys).toHaveLength(2);
    expect(body.serial_number).toBe('sb01');
    // Sorted descending by journey_id
    expect(body.journeys[0].journey_id).toBe(1700003000);
    expect(body.journeys[1].journey_id).toBe(1700001000);
  });

  it('returns empty journeys when none exist', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = makeEvent();
    const result = await handler(event);

    const body = JSON.parse(result.body);
    expect(body.journeys).toEqual([]);
    expect(body.count).toBe(0);
  });
});

describe('GET /devices/{serial_number}/journeys/{journey_id} - journey detail', () => {
  it('returns journey with points sorted by timestamp', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    // Journey lookup
    ddbMock.on(QueryCommand, {
      TableName: process.env.JOURNEYS_TABLE,
    }).resolves({
      Items: [makeJourney()],
    });

    // Location points (returned out of order)
    ddbMock.on(QueryCommand, {
      TableName: process.env.LOCATIONS_TABLE,
      IndexName: 'journey-index',
    }).resolves({
      Items: [
        makeLocationPoint({ timestamp: 1700000300000 }),
        makeLocationPoint({ timestamp: 1700000100000 }),
        makeLocationPoint({ timestamp: 1700000200000 }),
      ],
    });

    // Power telemetry query
    ddbMock.on(QueryCommand, {
      TableName: process.env.TELEMETRY_TABLE,
      IndexName: 'event-type-index',
    }).resolves({ Items: [] });

    const event = makeEvent({
      pathParameters: { serial_number: 'sb01', journey_id: '1700000000' },
      path: '/devices/sb01/journeys/1700000000',
      requestContext: { http: { method: 'GET', path: '/devices/sb01/journeys/1700000000' } } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.journey.journey_id).toBe(1700000000);
    expect(body.points).toHaveLength(3);
    // Sorted by timestamp ascending
    expect(new Date(body.points[0].time).getTime()).toBeLessThan(
      new Date(body.points[1].time).getTime()
    );
    expect(new Date(body.points[1].time).getTime()).toBeLessThan(
      new Date(body.points[2].time).getTime()
    );
  });

  it('returns 404 when journey not found', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = makeEvent({
      pathParameters: { serial_number: 'sb01', journey_id: '9999' },
      path: '/devices/sb01/journeys/9999',
      requestContext: { http: { method: 'GET', path: '/devices/sb01/journeys/9999' } } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });
});

describe('DELETE /devices/{serial_number}/journeys/{journey_id}', () => {
  it('allows admin to delete a journey', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    // Journey exists
    ddbMock.on(QueryCommand, {
      TableName: process.env.JOURNEYS_TABLE,
    }).resolves({
      Items: [makeJourney()],
    });

    // Location points to delete (3 points)
    ddbMock.on(QueryCommand, {
      TableName: process.env.LOCATIONS_TABLE,
    }).resolves({
      Items: [
        { device_uid: 'dev:1234', timestamp: 1000 },
        { device_uid: 'dev:1234', timestamp: 2000 },
        { device_uid: 'dev:1234', timestamp: 3000 },
      ],
    });

    ddbMock.on(BatchWriteCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});

    const event = makeEvent({
      httpMethod: 'DELETE',
      pathParameters: { serial_number: 'sb01', journey_id: '1700000000' },
      path: '/devices/sb01/journeys/1700000000',
      requestContext: {
        http: { method: 'DELETE', path: '/devices/sb01/journeys/1700000000' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@example.com' } } },
      } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.points_deleted).toBe(3);
    expect(body.journey_id).toBe(1700000000);
  });

  it('allows device owner to delete a journey', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    // Journey exists
    ddbMock.on(QueryCommand, {
      TableName: process.env.JOURNEYS_TABLE,
    }).resolves({
      Items: [makeJourney()],
    });

    // Device ownership check
    ddbMock.on(GetCommand).resolves({
      Item: { device_uid: 'dev:1234', assigned_to: 'owner@example.com' },
    });

    // No location points
    ddbMock.on(QueryCommand, {
      TableName: process.env.LOCATIONS_TABLE,
    }).resolves({ Items: [] });

    ddbMock.on(DeleteCommand).resolves({});

    const event = makeEvent({
      httpMethod: 'DELETE',
      pathParameters: { serial_number: 'sb01', journey_id: '1700000000' },
      path: '/devices/sb01/journeys/1700000000',
      requestContext: {
        http: { method: 'DELETE', path: '/devices/sb01/journeys/1700000000' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Sales', email: 'owner@example.com' } } },
      } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });

  it('returns 403 when user is not admin or device owner', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    // Journey exists
    ddbMock.on(QueryCommand, {
      TableName: process.env.JOURNEYS_TABLE,
    }).resolves({
      Items: [makeJourney()],
    });

    // Device ownership check - different user
    ddbMock.on(GetCommand).resolves({
      Item: { device_uid: 'dev:1234', assigned_to: 'someone-else@example.com' },
    });

    const event = makeEvent({
      httpMethod: 'DELETE',
      pathParameters: { serial_number: 'sb01', journey_id: '1700000000' },
      path: '/devices/sb01/journeys/1700000000',
      requestContext: {
        http: { method: 'DELETE', path: '/devices/sb01/journeys/1700000000' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Sales', email: 'other@example.com' } } },
      } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(403);
  });

  it('deletes location points in batches of 25', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    // Journey exists
    ddbMock.on(QueryCommand, {
      TableName: process.env.JOURNEYS_TABLE,
    }).resolves({
      Items: [makeJourney()],
    });

    // Generate 30 location points (requires 2 batches)
    const points = Array.from({ length: 30 }, (_, i) => ({
      device_uid: 'dev:1234',
      timestamp: 1700000000000 + i * 1000,
    }));

    ddbMock.on(QueryCommand, {
      TableName: process.env.LOCATIONS_TABLE,
    }).resolves({ Items: points });

    ddbMock.on(BatchWriteCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});

    const event = makeEvent({
      httpMethod: 'DELETE',
      pathParameters: { serial_number: 'sb01', journey_id: '1700000000' },
      path: '/devices/sb01/journeys/1700000000',
      requestContext: {
        http: { method: 'DELETE', path: '/devices/sb01/journeys/1700000000' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@example.com' } } },
      } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    expect(batchCalls).toHaveLength(2); // 25 + 5
  });
});

describe('POST /devices/{serial_number}/journeys/{journey_id}/match', () => {
  it('returns 500 when MAPBOX_TOKEN is not configured', async () => {
    const originalToken = process.env.MAPBOX_TOKEN;
    delete process.env.MAPBOX_TOKEN;

    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    const event = makeEvent({
      httpMethod: 'POST',
      pathParameters: { serial_number: 'sb01', journey_id: '1700000000' },
      path: '/devices/sb01/journeys/1700000000/match',
      requestContext: {
        http: { method: 'POST', path: '/devices/sb01/journeys/1700000000/match' },
      } as any,
    });

    // Re-import to pick up the cleared env var - since MAPBOX_TOKEN is read at module level,
    // we need to test against the current handler which already captured the value.
    const result = await handler(event);
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error).toContain('not configured');

    if (originalToken) process.env.MAPBOX_TOKEN = originalToken;
  });
});

describe('GET /devices/{serial_number}/locations', () => {
  it('returns merged location history from all device_uids', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:current',
      all_device_uids: ['dev:current', 'dev:old'],
    });

    ddbMock.on(QueryCommand)
      .resolvesOnce({
        Items: [makeLocationPoint({ device_uid: 'dev:current', timestamp: 1700003000000 })],
      })
      .resolvesOnce({
        Items: [makeLocationPoint({ device_uid: 'dev:old', timestamp: 1700001000000 })],
      });

    const event = makeEvent({
      path: '/devices/sb01/locations',
      requestContext: { http: { method: 'GET', path: '/devices/sb01/locations' } } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.locations).toHaveLength(2);
    expect(body.serial_number).toBe('sb01');
    // Sorted most recent first
    expect(new Date(body.locations[0].time).getTime()).toBeGreaterThan(
      new Date(body.locations[1].time).getTime()
    );
  });
});
