/**
 * Tests for the Public Device API Lambda
 *
 * Tests unauthenticated read-only device access, recent telemetry fetching,
 * and audit log writing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
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
  ddbMock.on(PutCommand).resolves({}); // Default: audit log succeeds
});

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: { 'User-Agent': 'test-agent' },
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/public/devices/sb01',
    pathParameters: { serial_number: 'sb01' },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {
      http: { method: 'GET', sourceIp: '1.2.3.4' },
      identity: { sourceIp: '1.2.3.4' },
    } as any,
    resource: '',
    ...overrides,
  };
}

function makeDdbDevice(overrides: Record<string, any> = {}) {
  return {
    device_uid: 'dev:1234',
    serial_number: 'sb01',
    name: 'My Songbird',
    fleet: 'default',
    status: 'online',
    last_seen: Date.now() - 60000,
    current_mode: 'demo',
    voltage: 3.8,
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
    },
    firmware_version: '1.0.0',
    notecard_version: '7.2.2',
    notecard_sku: 'NOTE-WBGLW',
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

  it('returns 405 for non-GET methods', async () => {
    const event = makeEvent({
      httpMethod: 'POST',
      requestContext: { http: { method: 'POST' } } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(405);
  });

  it('returns 400 when serial_number is missing', async () => {
    const event = makeEvent({
      pathParameters: null,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('Serial number');
  });

  it('returns 404 when device not found via resolveDevice', async () => {
    vi.mocked(resolveDevice).mockResolvedValue(null);

    const event = makeEvent();
    const result = await handler(event);

    expect(result.statusCode).toBe(404);
  });

  it('returns 404 when device_uid not found in devices table', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:gone',
      all_device_uids: ['dev:gone'],
    });
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const event = makeEvent();
    const result = await handler(event);

    expect(result.statusCode).toBe(404);
  });
});

describe('GET /public/devices/{serial_number}', () => {
  it('returns device with recent telemetry', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    ddbMock.on(GetCommand).resolves({ Item: makeDdbDevice() });

    // Recent telemetry
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { device_uid: 'dev:1234', timestamp: Date.now() - 3600000, temp: 22.5, humidity: 45, pressure: 1013, voltage: 3.8 },
        { device_uid: 'dev:1234', timestamp: Date.now() - 7200000, temp: 21.0, humidity: 50, pressure: 1012, voltage: 3.7 },
      ],
    });

    const event = makeEvent();
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.device_uid).toBe('dev:1234');
    expect(body.serial_number).toBe('sb01');
    expect(body.latitude).toBe(37.77);
    expect(body.longitude).toBe(-122.42);
    expect(body.temperature).toBe(22.5);
    expect(body.recent_telemetry).toHaveLength(2);
  });

  it('transforms device data correctly', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    ddbMock.on(GetCommand).resolves({ Item: makeDdbDevice() });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = makeEvent();
    const result = await handler(event);

    const body = JSON.parse(result.body);
    expect(body.mode).toBe('demo');
    expect(body.voltage).toBe(3.8);
    expect(body.location_source).toBe('gps');
    expect(body.location_name).toBe('San Francisco, CA');
    expect(body.firmware_version).toBe('1.0.0');
  });
});

describe('audit logging', () => {
  it('writes audit log on successful access', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    ddbMock.on(GetCommand).resolves({ Item: makeDdbDevice() });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    const event = makeEvent();
    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    // Find the audit log PutCommand (writes to AUDIT_TABLE)
    const auditCall = putCalls.find(
      (call) => call.args[0].input.TableName === process.env.AUDIT_TABLE
    );
    expect(auditCall).toBeDefined();
    expect(auditCall!.args[0].input.Item?.action).toBe('public_device_view');
    expect(auditCall!.args[0].input.Item?.result).toBe('success');
  });

  it('writes audit log with not_found result when device missing', async () => {
    vi.mocked(resolveDevice).mockResolvedValue(null);
    ddbMock.on(PutCommand).resolves({});

    const event = makeEvent();
    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const auditCall = putCalls.find(
      (call) => call.args[0].input.TableName === process.env.AUDIT_TABLE
    );
    expect(auditCall).toBeDefined();
    expect(auditCall!.args[0].input.Item?.result).toBe('not_found');
  });

  it('does not fail the request if audit logging fails', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });

    ddbMock.on(GetCommand).resolves({ Item: makeDdbDevice() });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    // Audit PutCommand fails
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB error'));

    const event = makeEvent();
    const result = await handler(event);

    // Response should still succeed
    expect(result.statusCode).toBe(200);
  });
});
