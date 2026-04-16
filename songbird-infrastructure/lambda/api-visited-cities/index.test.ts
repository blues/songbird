/**
 * Tests for the Visited Cities API Lambda
 *
 * Tests city aggregation from location history, parsing of location names,
 * visit count sorting, and date range filtering.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// Mock device-lookup module
vi.mock('../shared/device-lookup', () => ({
  resolveDevice: vi.fn(),
}));

import { handler } from './index';
import { resolveDevice } from '../shared/device-lookup';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  vi.mocked(resolveDevice).mockReset();
});

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/devices/sb01/visited-cities',
    pathParameters: { serial_number: 'sb01' },
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

function makeLocation(overrides: Record<string, any> = {}) {
  return {
    device_uid: 'dev:1234',
    timestamp: 1700000000000,
    latitude: 30.27,
    longitude: -97.74,
    location_name: 'Austin, TX, USA',
    ...overrides,
  };
}

describe('request validation', () => {
  it('returns 200 for OPTIONS', async () => {
    const event = makeEvent({
      requestContext: { http: { method: 'OPTIONS' } } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });

  it('returns 400 when serial_number is missing', async () => {
    const event = makeEvent({ pathParameters: null });

    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('serial_number');
  });

  it('returns 404 when device not found', async () => {
    vi.mocked(resolveDevice).mockResolvedValue(null);

    const event = makeEvent();
    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });
});

describe('GET /devices/{serial_number}/visited-cities', () => {
  it('aggregates locations by city and sorts by visit count descending', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeLocation({ timestamp: 1700000000000, location_name: 'Austin, TX, USA' }),
        makeLocation({ timestamp: 1700001000000, location_name: 'Austin, TX, USA' }),
        makeLocation({ timestamp: 1700002000000, location_name: 'Austin, TX, USA' }),
        makeLocation({ timestamp: 1700003000000, location_name: 'San Francisco, CA, USA', latitude: 37.77, longitude: -122.42 }),
      ],
    });

    const event = makeEvent();
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);

    expect(body.cities).toHaveLength(2);
    // Austin has more visits, should be first
    expect(body.cities[0].cityName).toBe('Austin');
    expect(body.cities[0].visitCount).toBe(3);
    expect(body.cities[0].state).toBe('TX');
    expect(body.cities[0].country).toBe('USA');
    expect(body.cities[1].cityName).toBe('San Francisco');
    expect(body.cities[1].visitCount).toBe(1);
    expect(body.totalLocations).toBe(4);
  });

  it('merges locations from multiple device_uids', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:current',
      all_device_uids: ['dev:current', 'dev:old'],
    });

    // Both queries return Austin locations - mock returns same for all QueryCommand calls
    ddbMock.on(QueryCommand)
      .resolvesOnce({
        Items: [makeLocation({ device_uid: 'dev:current', location_name: 'Austin, TX, USA' })],
      })
      .resolvesOnce({
        Items: [makeLocation({ device_uid: 'dev:old', location_name: 'Austin, TX, USA', timestamp: 1699000000000 })],
      });

    const event = makeEvent();
    const result = await handler(event);

    const body = JSON.parse(result.body);
    expect(body.cities).toHaveLength(1);
    expect(body.cities[0].cityName).toBe('Austin');
    expect(body.cities[0].visitCount).toBe(2);
  });

  it('parses location_name in "City, State, Country" format', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeLocation({ location_name: 'Denver, CO, United States' }),
        makeLocation({ location_name: 'Portland, OR' }),
      ],
    });

    const event = makeEvent();
    const result = await handler(event);

    const body = JSON.parse(result.body);
    expect(body.cities).toHaveLength(2);

    const denver = body.cities.find((c: any) => c.cityName === 'Denver');
    expect(denver.state).toBe('CO');
    expect(denver.country).toBe('United States');

    const portland = body.cities.find((c: any) => c.cityName === 'Portland');
    expect(portland.state).toBe('OR');
    expect(portland.country).toBeUndefined();
  });

  it('skips locations without location_name', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeLocation({ location_name: 'Austin, TX, USA' }),
        makeLocation({ location_name: undefined }),
        makeLocation({ location_name: undefined }),
      ],
    });

    const event = makeEvent();
    const result = await handler(event);

    const body = JSON.parse(result.body);
    expect(body.cities).toHaveLength(1);
    // totalLocations includes all location records
    expect(body.totalLocations).toBe(3);
  });

  it('returns empty cities when no locations exist', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = makeEvent();
    const result = await handler(event);

    const body = JSON.parse(result.body);
    expect(body.cities).toEqual([]);
    expect(body.totalLocations).toBe(0);
    expect(body.dateRange.from).toBeNull();
    expect(body.dateRange.to).toBeNull();
  });

  it('supports from/to date range filtering', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    ddbMock.on(QueryCommand).resolves({
      Items: [makeLocation()],
    });

    const event = makeEvent({
      queryStringParameters: {
        from: '2024-01-01T00:00:00Z',
        to: '2024-12-31T23:59:59Z',
      },
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    // Verify the query used the date range in KeyConditionExpression
    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls.length).toBeGreaterThan(0);
    const input = queryCalls[0].args[0].input;
    expect(input.KeyConditionExpression).toContain('BETWEEN');
    expect(input.ExpressionAttributeValues![':from']).toBeDefined();
    expect(input.ExpressionAttributeValues![':to']).toBeDefined();
  });

  it('paginates through all results', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    // First page returns with LastEvaluatedKey
    ddbMock.on(QueryCommand)
      .resolvesOnce({
        Items: [makeLocation({ location_name: 'Austin, TX, USA' })],
        LastEvaluatedKey: { device_uid: 'dev:1234', timestamp: 1700000000000 },
      })
      .resolvesOnce({
        Items: [makeLocation({ location_name: 'Denver, CO, USA', timestamp: 1700100000000 })],
      });

    const event = makeEvent();
    const result = await handler(event);

    const body = JSON.parse(result.body);
    expect(body.cities).toHaveLength(2);
    expect(body.totalLocations).toBe(2);
  });

  it('tracks first and last visit times', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeLocation({ timestamp: 1700000000000, location_name: 'Austin, TX, USA' }),
        makeLocation({ timestamp: 1700100000000, location_name: 'Austin, TX, USA' }),
        makeLocation({ timestamp: 1700050000000, location_name: 'Austin, TX, USA' }),
      ],
    });

    const event = makeEvent();
    const result = await handler(event);

    const body = JSON.parse(result.body);
    const austin = body.cities[0];
    expect(new Date(austin.firstVisit).getTime()).toBe(1700000000000);
    expect(new Date(austin.lastVisit).getTime()).toBe(1700100000000);
  });
});
