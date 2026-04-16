/**
 * Tests for the Telemetry API Lambda
 *
 * Tests telemetry, location, power, and health endpoints including
 * serial number resolution, multi-device-uid merging, and response
 * transformation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// Mock device-lookup module before importing handler
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
    path: '/devices/songbird01-bds/telemetry',
    pathParameters: { serial_number: 'songbird01-bds' },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {
      http: { method: 'GET', path: '/devices/songbird01-bds/telemetry' },
    } as any,
    resource: '',
    ...overrides,
  };
}

const NOW = Date.now();

function makeTelemetryItem(deviceUid: string, timestamp: number, overrides: Record<string, any> = {}) {
  return {
    device_uid: deviceUid,
    event_type_timestamp: `telemetry#${timestamp}`,
    timestamp,
    temperature: 22.5,
    humidity: 45,
    pressure: 1013.25,
    motion: false,
    ...overrides,
  };
}

function makePowerItem(deviceUid: string, timestamp: number, overrides: Record<string, any> = {}) {
  return {
    device_uid: deviceUid,
    event_type_timestamp: `power#${timestamp}`,
    timestamp,
    mojo_voltage: 3.8,
    milliamp_hours: 150,
    ...overrides,
  };
}

function makeHealthItem(deviceUid: string, timestamp: number, overrides: Record<string, any> = {}) {
  return {
    device_uid: deviceUid,
    event_type_timestamp: `health#${timestamp}`,
    timestamp,
    method: 'boot',
    text: 'Device booted',
    voltage: 3.8,
    voltage_mode: 'lipo',
    milliamp_hours: 150,
    ...overrides,
  };
}

describe('Telemetry API Lambda', () => {
  describe('OPTIONS', () => {
    it('returns 200 for OPTIONS request', async () => {
      const event = makeEvent({
        httpMethod: 'OPTIONS',
        requestContext: { http: { method: 'OPTIONS', path: '/devices/songbird01-bds/telemetry' } } as any,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(result.headers?.['Access-Control-Allow-Origin']).toBe('*');
    });
  });

  describe('parameter validation', () => {
    it('returns 400 when serial_number is missing', async () => {
      const event = makeEvent({
        pathParameters: null,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toBe('serial_number required');
    });

    it('returns 404 when device is not found', async () => {
      vi.mocked(resolveDevice).mockResolvedValue(null);

      const event = makeEvent();

      const result = await handler(event);

      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body).error).toBe('Device not found');
    });
  });

  describe('GET /devices/{serial_number}/telemetry', () => {
    it('returns temperature, humidity, pressure, and motion', async () => {
      vi.mocked(resolveDevice).mockResolvedValue({
        serial_number: 'songbird01-bds',
        device_uid: 'dev:1234',
        all_device_uids: ['dev:1234'],
      });

      const ts = NOW - 60000;
      ddbMock.on(QueryCommand).resolves({
        Items: [
          makeTelemetryItem('dev:1234', ts, {
            temperature: 23.1,
            humidity: 50,
            pressure: 1015.0,
            motion: true,
          }),
        ],
      });

      const event = makeEvent();

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.serial_number).toBe('songbird01-bds');
      expect(body.telemetry).toHaveLength(1);
      expect(body.telemetry[0]).toEqual({
        time: new Date(ts).toISOString(),
        temperature: 23.1,
        humidity: 50,
        pressure: 1015.0,
        motion: true,
      });
      expect(body.count).toBe(1);
    });
  });

  describe('GET /devices/{serial_number}/location', () => {
    it('filters to items with lat/lon', async () => {
      vi.mocked(resolveDevice).mockResolvedValue({
        serial_number: 'songbird01-bds',
        device_uid: 'dev:1234',
        all_device_uids: ['dev:1234'],
      });

      const ts1 = NOW - 120000;
      const ts2 = NOW - 60000;
      ddbMock.on(QueryCommand).resolves({
        Items: [
          makeTelemetryItem('dev:1234', ts1, {
            latitude: 37.77,
            longitude: -122.42,
            location_source: 'gps',
          }),
          makeTelemetryItem('dev:1234', ts2), // no lat/lon
        ],
      });

      const event = makeEvent({
        path: '/devices/songbird01-bds/location',
        requestContext: { http: { method: 'GET', path: '/devices/songbird01-bds/location' } } as any,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.locations).toHaveLength(1);
      expect(body.locations[0]).toEqual({
        time: new Date(ts1).toISOString(),
        lat: 37.77,
        lon: -122.42,
        source: 'gps',
      });
      expect(body.count).toBe(1);
    });
  });

  describe('GET /devices/{serial_number}/power', () => {
    it('returns voltage and milliamp_hours', async () => {
      vi.mocked(resolveDevice).mockResolvedValue({
        serial_number: 'songbird01-bds',
        device_uid: 'dev:1234',
        all_device_uids: ['dev:1234'],
      });

      const ts = NOW - 60000;
      ddbMock.on(QueryCommand).resolves({
        Items: [makePowerItem('dev:1234', ts, { mojo_voltage: 4.1, milliamp_hours: 200 })],
      });

      const event = makeEvent({
        path: '/devices/songbird01-bds/power',
        requestContext: { http: { method: 'GET', path: '/devices/songbird01-bds/power' } } as any,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.power).toHaveLength(1);
      expect(body.power[0]).toEqual({
        time: new Date(ts).toISOString(),
        voltage: 4.1,
        milliamp_hours: 200,
      });
    });
  });

  describe('GET /devices/{serial_number}/health', () => {
    it('returns method, text, voltage, voltage_mode, and milliamp_hours', async () => {
      vi.mocked(resolveDevice).mockResolvedValue({
        serial_number: 'songbird01-bds',
        device_uid: 'dev:1234',
        all_device_uids: ['dev:1234'],
      });

      const ts = NOW - 60000;
      ddbMock.on(QueryCommand).resolves({
        Items: [
          makeHealthItem('dev:1234', ts, {
            method: 'sync',
            text: 'Sync completed',
            voltage: 3.9,
            voltage_mode: 'lipo',
            milliamp_hours: 180,
          }),
        ],
      });

      const event = makeEvent({
        path: '/devices/songbird01-bds/health',
        requestContext: { http: { method: 'GET', path: '/devices/songbird01-bds/health' } } as any,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.health).toHaveLength(1);
      expect(body.health[0]).toEqual({
        time: new Date(ts).toISOString(),
        method: 'sync',
        text: 'Sync completed',
        voltage: 3.9,
        voltage_mode: 'lipo',
        milliamp_hours: 180,
      });
    });
  });

  describe('multi-device-uid merging', () => {
    it('merges data from multiple device_uids and sorts newest first', async () => {
      vi.mocked(resolveDevice).mockResolvedValue({
        serial_number: 'songbird01-bds',
        device_uid: 'dev:5678',
        all_device_uids: ['dev:5678', 'dev:1234'],
      });

      const ts1 = NOW - 300000; // older, from old notecard
      const ts2 = NOW - 60000;  // newer, from new notecard

      // The handler queries each device_uid in parallel. The mock will
      // return items for each call in order.
      ddbMock
        .on(QueryCommand)
        .callsFake((input) => {
          const deviceUid = input.ExpressionAttributeValues?.[':device_uid'];
          if (deviceUid === 'dev:5678') {
            return {
              Items: [makeTelemetryItem('dev:5678', ts2, { temperature: 25.0, humidity: 55, pressure: 1010.0, motion: false })],
            };
          }
          if (deviceUid === 'dev:1234') {
            return {
              Items: [makeTelemetryItem('dev:1234', ts1, { temperature: 20.0, humidity: 40, pressure: 1020.0, motion: true })],
            };
          }
          return { Items: [] };
        });

      const event = makeEvent();

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.telemetry).toHaveLength(2);
      // Newest first (the handler reverses after sorting ascending)
      expect(body.telemetry[0].temperature).toBe(25.0);
      expect(body.telemetry[1].temperature).toBe(20.0);
    });
  });
});
