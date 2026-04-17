/**
 * Tests for the Devices API Lambda
 *
 * Tests device CRUD operations including serial number resolution,
 * device transformation, status calculation, and fleet stats.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand, GetCommand, UpdateCommand, DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// Mock device-lookup module
vi.mock('../shared/device-lookup', () => ({
  resolveDevice: vi.fn(),
  getAliasBySerial: vi.fn(),
}));

import { handler } from './index';
import { resolveDevice, getAliasBySerial } from '../shared/device-lookup';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  vi.mocked(resolveDevice).mockReset();
  vi.mocked(getAliasBySerial).mockReset();
});

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/devices',
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

// Sample DynamoDB device record (internal format)
function makeDdbDevice(overrides: Record<string, any> = {}) {
  return {
    device_uid: 'dev:1234',
    serial_number: 'songbird01-bds',
    fleet: 'default',
    status: 'online',
    last_seen: Date.now() - 60000, // 1 minute ago
    current_mode: 'demo',
    created_at: Date.now() - 86400000,
    updated_at: Date.now() - 60000,
    last_location: {
      lat: 37.77,
      lon: -122.42,
      time: Math.floor(Date.now() / 1000) - 60,
      source: 'gps',
      name: 'San Francisco, CA',
    },
    last_telemetry: {
      temp: 22.5,
      humidity: 45,
      pressure: 1013.25,
      motion: false,
      timestamp: Math.floor(Date.now() / 1000) - 60,
    },
    voltage: 3.8,
    last_power: {
      voltage: 3.8,
      temperature: 25,
      milliamp_hours: 150,
    },
    firmware_version: '1.0.0',
    notecard_version: '7.2.2',
    notecard_sku: 'NOTE-WBGLW',
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
      httpMethod: 'PUT',
      requestContext: { http: { method: 'PUT' } } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(405);
  });
});

describe('GET /devices - list devices', () => {
  it('returns all devices via scan', async () => {
    const devices = [makeDdbDevice(), makeDdbDevice({ device_uid: 'dev:5678', serial_number: 'songbird02-bds' })];
    ddbMock.on(ScanCommand).resolves({ Items: devices });

    const event = makeEvent();

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.devices).toHaveLength(2);
    expect(body.count).toBe(2);
    expect(body.stats).toBeDefined();
    expect(body.stats.total).toBe(2);
  });

  it('filters by fleet using GSI', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [makeDdbDevice()] });

    const event = makeEvent({
      queryStringParameters: { fleet: 'demo-fleet' },
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls[0].args[0].input.IndexName).toBe('fleet-index');
  });

  it('filters by status using GSI', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [makeDdbDevice()] });

    const event = makeEvent({
      queryStringParameters: { status: 'online' },
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls[0].args[0].input.IndexName).toBe('status-index');
  });

  it('returns empty array when no devices', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const event = makeEvent();
    const result = await handler(event);

    const body = JSON.parse(result.body);
    expect(body.devices).toEqual([]);
    expect(body.count).toBe(0);
  });
});

describe('GET /devices/{serial_number}', () => {
  it('returns device by serial number', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'songbird01-bds',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });
    ddbMock.on(GetCommand).resolves({ Item: makeDdbDevice() });

    const event = makeEvent({
      pathParameters: { serial_number: 'songbird01-bds' },
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.device_uid).toBe('dev:1234');
    expect(body.serial_number).toBe('songbird01-bds');
  });

  it('returns 404 when device not found by serial', async () => {
    vi.mocked(resolveDevice).mockResolvedValue(null);

    const event = makeEvent({
      pathParameters: { serial_number: 'nonexistent' },
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });

  it('returns 404 when device_uid exists in alias but not in devices table', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:gone',
      all_device_uids: ['dev:gone'],
    });
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const event = makeEvent({
      pathParameters: { serial_number: 'sb01' },
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });

  it('includes device_uid_history when Notecard was swapped', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:current',
      all_device_uids: ['dev:current', 'dev:old1', 'dev:old2'],
    });
    ddbMock.on(GetCommand).resolves({ Item: makeDdbDevice({ device_uid: 'dev:current' }) });

    const event = makeEvent({
      pathParameters: { serial_number: 'sb01' },
    });

    const result = await handler(event);
    const body = JSON.parse(result.body);
    expect(body.device_uid_history).toEqual(['dev:old1', 'dev:old2']);
  });

  it('omits device_uid_history when no swaps', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });
    ddbMock.on(GetCommand).resolves({ Item: makeDdbDevice() });

    const event = makeEvent({
      pathParameters: { serial_number: 'sb01' },
    });

    const result = await handler(event);
    const body = JSON.parse(result.body);
    expect(body.device_uid_history).toBeUndefined();
  });
});

describe('PATCH /devices/{serial_number}', () => {
  it('updates allowed fields', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });
    ddbMock.on(UpdateCommand).resolves({
      Attributes: makeDdbDevice({ name: 'My Songbird' }),
    });

    const event = makeEvent({
      httpMethod: 'PATCH',
      requestContext: { http: { method: 'PATCH' } } as any,
      pathParameters: { serial_number: 'sb01' },
      body: JSON.stringify({ name: 'My Songbird', fleet: 'sales-demo' }),
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });

  it('rejects disallowed fields', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    const event = makeEvent({
      httpMethod: 'PATCH',
      requestContext: { http: { method: 'PATCH' } } as any,
      pathParameters: { serial_number: 'sb01' },
      body: JSON.stringify({ device_uid: 'dev:hacked', serial_number: 'hacked' }),
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('No valid fields');
  });

  it('returns 400 when body is missing', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    const event = makeEvent({
      httpMethod: 'PATCH',
      requestContext: { http: { method: 'PATCH' } } as any,
      pathParameters: { serial_number: 'sb01' },
      body: null,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  it('returns 404 when device not found', async () => {
    vi.mocked(resolveDevice).mockResolvedValue(null);

    const event = makeEvent({
      httpMethod: 'PATCH',
      requestContext: { http: { method: 'PATCH' } } as any,
      pathParameters: { serial_number: 'nonexistent' },
      body: JSON.stringify({ name: 'test' }),
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });
});

describe('device transformation', () => {
  it('flattens last_location', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });
    ddbMock.on(GetCommand).resolves({ Item: makeDdbDevice() });

    const event = makeEvent({
      pathParameters: { serial_number: 'sb01' },
    });

    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(body.latitude).toBe(37.77);
    expect(body.longitude).toBe(-122.42);
    expect(body.location_source).toBe('gps');
    expect(body.location_name).toBe('San Francisco, CA');
  });

  it('flattens last_telemetry', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });
    ddbMock.on(GetCommand).resolves({ Item: makeDdbDevice() });

    const event = makeEvent({
      pathParameters: { serial_number: 'sb01' },
    });

    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(body.temperature).toBe(22.5);
    expect(body.humidity).toBe(45);
    expect(body.pressure).toBe(1013.25);
  });

  it('flattens last_power (Mojo data)', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });
    ddbMock.on(GetCommand).resolves({ Item: makeDdbDevice() });

    const event = makeEvent({
      pathParameters: { serial_number: 'sb01' },
    });

    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(body.mojo_voltage).toBe(3.8);
    expect(body.mojo_temperature).toBe(25);
    expect(body.milliamp_hours).toBe(150);
  });

  it('includes firmware info', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });
    ddbMock.on(GetCommand).resolves({ Item: makeDdbDevice() });

    const event = makeEvent({
      pathParameters: { serial_number: 'sb01' },
    });

    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(body.firmware_version).toBe('1.0.0');
    expect(body.notecard_version).toBe('7.2.2');
    expect(body.notecard_sku).toBe('NOTE-WBGLW');
  });
});

describe('device status calculation', () => {
  it('returns online when seen within 15 minutes', async () => {
    const device = makeDdbDevice({ last_seen: Date.now() - 60000 }); // 1 min ago
    ddbMock.on(ScanCommand).resolves({ Items: [device] });

    const event = makeEvent();
    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(body.devices[0].status).toBe('online');
  });

  it('returns offline when seen more than 15 minutes ago', async () => {
    const device = makeDdbDevice({ last_seen: Date.now() - 20 * 60 * 1000 }); // 20 min ago
    ddbMock.on(ScanCommand).resolves({ Items: [device] });

    const event = makeEvent();
    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(body.devices[0].status).toBe('offline');
  });

  it('returns alert when status is explicitly alert', async () => {
    const device = makeDdbDevice({ status: 'alert', last_seen: Date.now() });
    ddbMock.on(ScanCommand).resolves({ Items: [device] });

    const event = makeEvent();
    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(body.devices[0].status).toBe('alert');
  });
});

describe('fleet stats calculation', () => {
  it('calculates correct fleet stats', async () => {
    const devices = [
      makeDdbDevice({ device_uid: 'dev:1', fleet: 'sales', last_seen: Date.now() - 60000, status: 'online' }),
      makeDdbDevice({ device_uid: 'dev:2', fleet: 'sales', last_seen: Date.now() - 20 * 60000, status: 'offline' }),
      makeDdbDevice({ device_uid: 'dev:3', fleet: 'demo', status: 'alert' }),
      makeDdbDevice({ device_uid: 'dev:4', fleet: 'demo', last_seen: Date.now() - 60000, voltage: 3.0 }),
    ];
    ddbMock.on(ScanCommand).resolves({ Items: devices });

    const event = makeEvent();
    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(body.stats.total).toBe(4);
    expect(body.stats.online).toBe(2);
    expect(body.stats.offline).toBe(1);
    expect(body.stats.alert).toBe(1);
    expect(body.stats.low_battery).toBe(1); // voltage 3.0 < 3.4
    expect(body.stats.fleets).toEqual({ sales: 2, demo: 2 });
  });
});

describe('POST /devices/merge', () => {
  it('requires admin access', async () => {
    const event = makeEvent({
      httpMethod: 'POST',
      path: '/devices/merge',
      requestContext: {
        http: { method: 'POST' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Viewer' } } },
      } as any,
      body: JSON.stringify({
        source_serial_number: 'sb-source',
        target_serial_number: 'sb-target',
      }),
    });
    // Set rawPath for path matching
    (event as any).rawPath = '/devices/merge';

    const result = await handler(event);
    expect(result.statusCode).toBe(403);
  });

  it('rejects same source and target', async () => {
    const event = makeEvent({
      httpMethod: 'POST',
      path: '/devices/merge',
      requestContext: {
        http: { method: 'POST' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Admin' } } },
      } as any,
      body: JSON.stringify({
        source_serial_number: 'sb01',
        target_serial_number: 'sb01',
      }),
    });
    (event as any).rawPath = '/devices/merge';

    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('cannot be the same');
  });

  it('returns 404 when source not found', async () => {
    vi.mocked(getAliasBySerial).mockResolvedValueOnce(null);

    const event = makeEvent({
      httpMethod: 'POST',
      path: '/devices/merge',
      requestContext: {
        http: { method: 'POST' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Admin' } } },
      } as any,
      body: JSON.stringify({
        source_serial_number: 'nonexistent',
        target_serial_number: 'sb-target',
      }),
    });
    (event as any).rawPath = '/devices/merge';

    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });

  it('merges devices successfully', async () => {
    vi.mocked(getAliasBySerial)
      .mockResolvedValueOnce({
        serial_number: 'sb-source',
        device_uid: 'dev:source',
        previous_device_uids: ['dev:source-old'],
        created_at: 1000,
        updated_at: 2000,
      })
      .mockResolvedValueOnce({
        serial_number: 'sb-target',
        device_uid: 'dev:target',
        previous_device_uids: [],
        created_at: 500,
        updated_at: 1500,
      });

    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});

    const event = makeEvent({
      httpMethod: 'POST',
      path: '/devices/merge',
      requestContext: {
        http: { method: 'POST' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Admin' } } },
      } as any,
      body: JSON.stringify({
        source_serial_number: 'sb-source',
        target_serial_number: 'sb-target',
      }),
    });
    (event as any).rawPath = '/devices/merge';

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.merged_device_uids).toContain('dev:target');
    expect(body.merged_device_uids).toContain('dev:source');
    expect(body.merged_device_uids).toContain('dev:source-old');
    expect(body.deleted_serial_number).toBe('sb-source');
  });
});
