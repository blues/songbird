/**
 * Tests for the Config API Lambda
 *
 * Tests device and fleet configuration management via Notehub environment
 * variables, including schema validation, Wi-Fi credential setting, and
 * pending_mode tracking.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// Mock fetch globally before importing handler
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { handler } from './index';

const ddbMock = mockClient(DynamoDBDocumentClient);
const secretsMock = mockClient(SecretsManagerClient);

beforeEach(() => {
  ddbMock.reset();
  secretsMock.reset();
  mockFetch.mockReset();

  // Default: Secrets Manager returns a valid token
  secretsMock.on(GetSecretValueCommand).resolves({
    SecretString: JSON.stringify({ token: 'test-notehub-token' }),
  });

  // Reset the cached token between tests by re-importing would be complex,
  // so we just ensure secrets mock always returns successfully.
});

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/devices/songbird01-bds/config',
    pathParameters: { serial_number: 'songbird01-bds' },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {
      http: { method: 'GET', path: '/devices/songbird01-bds/config' },
    } as any,
    resource: '',
    ...overrides,
  };
}

// Mock the DynamoDB alias lookup (resolveDeviceUid is a local function that does a GetCommand)
function mockDeviceAlias(serialNumber: string, deviceUid: string | null) {
  ddbMock.on(GetCommand, {
    TableName: 'test-device-aliases',
    Key: { serial_number: serialNumber },
  }).resolves({
    Item: deviceUid ? { serial_number: serialNumber, device_uid: deviceUid } : undefined,
  });
}

function mockNotehubGetEnvVars(envVars: Record<string, string>, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ environment_variables: envVars }),
    text: async () => 'Notehub error',
  });
}

function mockNotehubPutEnvVars(status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    text: async () => (status >= 400 ? 'Notehub error' : ''),
  });
}

describe('Config API Lambda', () => {
  describe('OPTIONS', () => {
    it('returns 200 for OPTIONS request', async () => {
      const event = makeEvent({
        httpMethod: 'OPTIONS',
        requestContext: { http: { method: 'OPTIONS', path: '/devices/songbird01-bds/config' } } as any,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(result.headers?.['Access-Control-Allow-Origin']).toBe('*');
    });
  });

  describe('device not found', () => {
    it('returns 404 when device alias is not found', async () => {
      mockDeviceAlias('songbird01-bds', null);

      const event = makeEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body).error).toBe('Device not found for serial number');
    });
  });

  describe('GET /devices/{serial_number}/config', () => {
    it('returns parsed config values from Notehub', async () => {
      mockDeviceAlias('songbird01-bds', 'dev:1234');
      mockNotehubGetEnvVars({
        mode: 'demo',
        audio_volume: '75',
        motion_wake_enabled: 'true',
        heartbeat_hours: '6',
      });

      const event = makeEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.serial_number).toBe('songbird01-bds');
      expect(body.device_uid).toBe('dev:1234');
      // Numeric values should be parsed
      expect(body.config.audio_volume).toBe(75);
      // Boolean values should be parsed
      expect(body.config.motion_wake_enabled).toBe(true);
      // String values stay as strings
      expect(body.config.mode).toBe('demo');
      // Schema should be included
      expect(body.schema).toBeDefined();
      expect(body.schema.mode).toBeDefined();
    });
  });

  describe('PUT /devices/{serial_number}/config', () => {
    it('validates against schema - rejects invalid mode', async () => {
      mockDeviceAlias('songbird01-bds', 'dev:1234');

      const event = makeEvent({
        httpMethod: 'PUT',
        requestContext: { http: { method: 'PUT', path: '/devices/songbird01-bds/config' } } as any,
        body: JSON.stringify({ mode: 'invalid_mode' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('Invalid configuration');
      expect(body.errors).toContain('mode must be one of: demo, transit, storage, sleep');
    });

    it('validates against schema - rejects out-of-range numbers', async () => {
      mockDeviceAlias('songbird01-bds', 'dev:1234');

      const event = makeEvent({
        httpMethod: 'PUT',
        requestContext: { http: { method: 'PUT', path: '/devices/songbird01-bds/config' } } as any,
        body: JSON.stringify({ audio_volume: 200 }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.errors).toContain('audio_volume must be <= 100');
    });

    it('sets pending_mode in DynamoDB when mode is updated', async () => {
      mockDeviceAlias('songbird01-bds', 'dev:1234');
      mockNotehubPutEnvVars(200);

      const event = makeEvent({
        httpMethod: 'PUT',
        requestContext: { http: { method: 'PUT', path: '/devices/songbird01-bds/config' } } as any,
        body: JSON.stringify({ mode: 'transit' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);

      // Verify that UpdateCommand was sent to DEVICES_TABLE with pending_mode
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const pendingModeCall = updateCalls.find(
        (call) =>
          call.args[0].input.TableName === 'test-devices' &&
          call.args[0].input.ExpressionAttributeValues?.[':pm'] === 'transit'
      );
      expect(pendingModeCall).toBeDefined();
    });

    it('does not set pending_mode when mode is not in the update', async () => {
      mockDeviceAlias('songbird01-bds', 'dev:1234');
      mockNotehubPutEnvVars(200);

      const event = makeEvent({
        httpMethod: 'PUT',
        requestContext: { http: { method: 'PUT', path: '/devices/songbird01-bds/config' } } as any,
        body: JSON.stringify({ audio_volume: 50 }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);

      // No UpdateCommand should have been sent for pending_mode
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const pendingModeCall = updateCalls.find(
        (call) => call.args[0].input.TableName === 'test-devices'
      );
      expect(pendingModeCall).toBeUndefined();
    });

    it('returns 502 when Notehub API fails', async () => {
      mockDeviceAlias('songbird01-bds', 'dev:1234');
      mockNotehubPutEnvVars(500);

      const event = makeEvent({
        httpMethod: 'PUT',
        requestContext: { http: { method: 'PUT', path: '/devices/songbird01-bds/config' } } as any,
        body: JSON.stringify({ mode: 'demo' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(502);
      expect(JSON.parse(result.body).error).toBe('Failed to update config in Notehub');
    });

    it('returns 400 when body is missing', async () => {
      mockDeviceAlias('songbird01-bds', 'dev:1234');

      const event = makeEvent({
        httpMethod: 'PUT',
        requestContext: { http: { method: 'PUT', path: '/devices/songbird01-bds/config' } } as any,
        body: null,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toBe('Request body required');
    });
  });

  describe('PUT /devices/{serial_number}/wifi', () => {
    it('validates SSID is required', async () => {
      mockDeviceAlias('songbird01-bds', 'dev:1234');

      const event = makeEvent({
        httpMethod: 'PUT',
        path: '/devices/songbird01-bds/wifi',
        requestContext: { http: { method: 'PUT', path: '/devices/songbird01-bds/wifi' } } as any,
        body: JSON.stringify({ ssid: '', password: 'secret' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toBe('SSID is required');
    });

    it('validates password is required', async () => {
      mockDeviceAlias('songbird01-bds', 'dev:1234');

      const event = makeEvent({
        httpMethod: 'PUT',
        path: '/devices/songbird01-bds/wifi',
        requestContext: { http: { method: 'PUT', path: '/devices/songbird01-bds/wifi' } } as any,
        body: JSON.stringify({ ssid: 'MyNetwork' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toBe('Password is required (can be empty string for open networks)');
    });

    it('sets Wi-Fi credentials via Notehub environment variable', async () => {
      mockDeviceAlias('songbird01-bds', 'dev:1234');
      mockNotehubPutEnvVars(200);

      const event = makeEvent({
        httpMethod: 'PUT',
        path: '/devices/songbird01-bds/wifi',
        requestContext: { http: { method: 'PUT', path: '/devices/songbird01-bds/wifi' } } as any,
        body: JSON.stringify({ ssid: 'MyNetwork', password: 'secret123' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.success).toBe(true);

      // Verify fetch was called with correct _wifi env var
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/environment_variables'),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            environment_variables: { _wifi: '["MyNetwork","secret123"]' },
          }),
        })
      );
    });
  });

  describe('PUT /fleets/{fleet_uid}/config', () => {
    it('updates fleet configuration via Notehub', async () => {
      mockNotehubPutEnvVars(200);

      const event = makeEvent({
        httpMethod: 'PUT',
        path: '/fleets/fleet:1234/config',
        pathParameters: { fleet_uid: 'fleet:1234' },
        requestContext: { http: { method: 'PUT', path: '/fleets/fleet:1234/config' } } as any,
        body: JSON.stringify({ mode: 'storage', audio_volume: 50 }),
      });

      // Remove serial_number from pathParameters since this is a fleet endpoint
      event.pathParameters = { fleet_uid: 'fleet:1234' };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.fleet_uid).toBe('fleet:1234');
      expect(body.config.mode).toBe('storage');

      // Verify the Notehub fleet endpoint was called
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/fleets/fleet:1234/environment_variables'),
        expect.objectContaining({ method: 'PUT' })
      );
    });

    it('validates fleet config against schema', async () => {
      const event = makeEvent({
        httpMethod: 'PUT',
        path: '/fleets/fleet:1234/config',
        pathParameters: { fleet_uid: 'fleet:1234' },
        requestContext: { http: { method: 'PUT', path: '/fleets/fleet:1234/config' } } as any,
        body: JSON.stringify({ mode: 'bogus' }),
      });

      event.pathParameters = { fleet_uid: 'fleet:1234' };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.errors).toContain('mode must be one of: demo, transit, storage, sleep');
    });
  });
});
