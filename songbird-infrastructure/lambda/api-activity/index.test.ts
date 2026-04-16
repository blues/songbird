/**
 * Tests for the Activity Feed API Lambda
 *
 * Tests the unified activity feed that combines alerts, health events,
 * commands, journeys, and mode changes from multiple DynamoDB tables.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
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
    path: '/activity',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {
      http: { method: 'GET', path: '/activity' },
    } as any,
    resource: '',
    ...overrides,
  };
}

const NOW = Date.now();

// Helper to set up DynamoDB mock that returns different items per table.
// The handler issues 6 parallel scans: alerts, health, commands, journeys, mode_changes, devices
function setupDdbMock(data: {
  alerts?: any[];
  health?: any[];
  commands?: any[];
  journeys?: any[];
  modeChanges?: any[];
  devices?: any[];
}) {
  ddbMock.on(ScanCommand).callsFake((input) => {
    const table = input.TableName;

    if (table === 'test-alerts') {
      return { Items: data.alerts ?? [] };
    }
    if (table === 'test-commands') {
      return { Items: data.commands ?? [] };
    }
    if (table === 'test-journeys') {
      return { Items: data.journeys ?? [] };
    }
    if (table === 'test-devices') {
      return { Items: data.devices ?? [] };
    }
    if (table === 'test-telemetry') {
      // The handler scans telemetry table twice: once for health, once for mode_change.
      // Distinguish by FilterExpression data_type value.
      const dataType = input.ExpressionAttributeValues?.[':data_type'];
      if (dataType === 'health') {
        return { Items: data.health ?? [] };
      }
      if (dataType === 'mode_change') {
        return { Items: data.modeChanges ?? [] };
      }
    }

    return { Items: [] };
  });
}

describe('Activity Feed API Lambda', () => {
  describe('OPTIONS', () => {
    it('returns 200 for OPTIONS request', async () => {
      const event = makeEvent({
        httpMethod: 'OPTIONS',
        requestContext: { http: { method: 'OPTIONS', path: '/activity' } } as any,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(result.headers?.['Access-Control-Allow-Origin']).toBe('*');
    });
  });

  describe('activity feed', () => {
    it('returns activity feed combining alerts, health, commands, journeys, and mode changes', async () => {
      setupDdbMock({
        alerts: [
          {
            alert_id: 'alert-1',
            device_uid: 'dev:1234',
            type: 'temp_high',
            value: 35.2,
            threshold: 30,
            acknowledged: false,
            created_at: NOW - 60000,
          },
        ],
        health: [
          {
            device_uid: 'dev:1234',
            timestamp: NOW - 120000,
            data_type: 'health',
            method: 'boot',
            text: 'Device booted',
            voltage: 3.8,
          },
        ],
        commands: [
          {
            command_id: 'cmd-1',
            device_uid: 'dev:1234',
            cmd: 'ping',
            status: 'sent',
            ack_status: 'ok',
            created_at: NOW - 30000,
          },
        ],
        journeys: [
          {
            device_uid: 'dev:1234',
            journey_id: '1700000000',
            start_time: NOW - 180000,
            status: 'completed',
            end_time: NOW - 90000,
            point_count: 42,
            total_distance: 5200,
          },
        ],
        modeChanges: [
          {
            device_uid: 'dev:1234',
            timestamp: NOW - 150000,
            data_type: 'mode_change',
            previous_mode: 'storage',
            new_mode: 'transit',
          },
        ],
        devices: [
          { device_uid: 'dev:1234', name: 'Songbird Alpha', serial_number: 'songbird01-bds' },
        ],
      });

      const event = makeEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);

      // Should have: 1 alert + 1 health + 1 command + 2 journey (start + end) + 1 mode_change = 6
      expect(body.activities).toHaveLength(6);

      const types = body.activities.map((a: any) => a.type);
      expect(types).toContain('alert');
      expect(types).toContain('health');
      expect(types).toContain('command');
      expect(types).toContain('journey');
      expect(types).toContain('mode_change');

      // Verify device name is populated
      for (const activity of body.activities) {
        expect(activity.device_name).toBe('Songbird Alpha');
      }
    });

    it('sorts activities by timestamp descending (newest first)', async () => {
      setupDdbMock({
        alerts: [
          {
            alert_id: 'alert-old',
            device_uid: 'dev:1234',
            type: 'temp_high',
            value: 30.0,
            created_at: NOW - 300000, // oldest
          },
          {
            alert_id: 'alert-new',
            device_uid: 'dev:1234',
            type: 'temp_low',
            value: 5.0,
            created_at: NOW - 10000, // newest
          },
        ],
        health: [
          {
            device_uid: 'dev:1234',
            timestamp: NOW - 150000, // middle
            data_type: 'health',
            method: 'sync',
          },
        ],
        devices: [
          { device_uid: 'dev:1234', name: 'Test', serial_number: 'test01' },
        ],
      });

      const event = makeEvent();
      const result = await handler(event);
      const body = JSON.parse(result.body);

      const timestamps = body.activities.map((a: any) => new Date(a.timestamp).getTime());
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
      }
    });

    it('respects limit parameter', async () => {
      const alerts = Array.from({ length: 10 }, (_, i) => ({
        alert_id: `alert-${i}`,
        device_uid: 'dev:1234',
        type: 'temp_high',
        value: 30 + i,
        created_at: NOW - i * 10000,
      }));

      setupDdbMock({
        alerts,
        devices: [{ device_uid: 'dev:1234', name: 'Test', serial_number: 'test01' }],
      });

      const event = makeEvent({
        queryStringParameters: { limit: '3' },
      });

      const result = await handler(event);
      const body = JSON.parse(result.body);

      expect(body.activities.length).toBeLessThanOrEqual(3);
      expect(body.count).toBeLessThanOrEqual(3);
    });

    it('handles empty results gracefully', async () => {
      setupDdbMock({
        devices: [],
      });

      const event = makeEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.activities).toEqual([]);
      expect(body.count).toBe(0);
    });

    it('formats journey end message with km for distances >= 1000m', async () => {
      setupDdbMock({
        journeys: [
          {
            device_uid: 'dev:1234',
            journey_id: '1700000000',
            start_time: NOW - 180000,
            status: 'completed',
            end_time: NOW - 90000,
            point_count: 25,
            total_distance: 15400, // 15.4 km
          },
        ],
        devices: [
          { device_uid: 'dev:1234', name: 'Test', serial_number: 'test01' },
        ],
      });

      const event = makeEvent();
      const result = await handler(event);
      const body = JSON.parse(result.body);

      const endEvent = body.activities.find(
        (a: any) => a.type === 'journey' && a.data?.event === 'end'
      );
      expect(endEvent).toBeDefined();
      expect(endEvent.message).toBe('Journey ended: 15.4 km, 25 points');
    });

    it('formats journey end message with meters for distances < 1000m', async () => {
      setupDdbMock({
        journeys: [
          {
            device_uid: 'dev:1234',
            journey_id: '1700000001',
            start_time: NOW - 180000,
            status: 'completed',
            end_time: NOW - 90000,
            point_count: 5,
            total_distance: 450, // 450 m
          },
        ],
        devices: [
          { device_uid: 'dev:1234', name: 'Test', serial_number: 'test01' },
        ],
      });

      const event = makeEvent();
      const result = await handler(event);
      const body = JSON.parse(result.body);

      const endEvent = body.activities.find(
        (a: any) => a.type === 'journey' && a.data?.event === 'end'
      );
      expect(endEvent).toBeDefined();
      expect(endEvent.message).toBe('Journey ended: 450 m, 5 points');
    });
  });
});
