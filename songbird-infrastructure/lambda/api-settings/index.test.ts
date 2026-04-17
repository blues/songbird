/**
 * Tests for the Settings API Lambda
 *
 * Tests fleet defaults CRUD operations including validation,
 * DynamoDB storage, and Notehub sync.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// Must set env vars before importing the handler (test-setup.ts covers most,
// but we ensure SETTINGS_TABLE is set here for clarity)
process.env.SETTINGS_TABLE = 'test-settings';
process.env.USER_POOL_ID = 'us-east-1_test';

import { handler } from './index';

const ddbMock = mockClient(DynamoDBDocumentClient);
const secretsMock = mockClient(SecretsManagerClient);

beforeEach(() => {
  ddbMock.reset();
  secretsMock.reset();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeEvent(overrides: Record<string, any> = {}) {
  return {
    version: '2.0',
    routeKey: 'GET /v1/settings/fleet-defaults',
    rawPath: '/v1/settings/fleet-defaults',
    body: null,
    headers: {},
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      http: { method: 'GET', path: '/v1/settings/fleet-defaults' },
      authorizer: {
        jwt: {
          claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' },
        },
      },
    },
    isBase64Encoded: false,
    ...overrides,
  } as any;
}

function makeAdminContext(method: string, path: string) {
  return {
    http: { method, path },
    authorizer: {
      jwt: {
        claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' },
      },
    },
  };
}

function makeViewerContext(method: string, path: string) {
  return {
    http: { method, path },
    authorizer: {
      jwt: {
        claims: { 'cognito:groups': 'Viewer', email: 'viewer@test.com' },
      },
    },
  };
}

describe('API Settings Lambda', () => {
  describe('authorization', () => {
    it('returns 403 for non-admin on PUT fleet defaults', async () => {
      const event = makeEvent({
        rawPath: '/v1/settings/fleet-defaults/fleet:1234',
        pathParameters: { fleet: 'fleet:1234' },
        requestContext: makeViewerContext('PUT', '/v1/settings/fleet-defaults/fleet:1234'),
        body: JSON.stringify({ mode: 'demo' }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body as string).error).toBe('Admin access required');
    });

    it('returns 403 for non-admin on list GET', async () => {
      const event = makeEvent({
        rawPath: '/v1/settings/fleet-defaults',
        requestContext: makeViewerContext('GET', '/v1/settings/fleet-defaults'),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(403);
    });

    it('returns 200 for OPTIONS (CORS preflight)', async () => {
      const event = makeEvent({
        requestContext: {
          http: { method: 'OPTIONS', path: '/v1/settings/fleet-defaults' },
          authorizer: { jwt: { claims: {} } },
        },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
    });
  });

  describe('GET /v1/settings/fleet-defaults/{fleet}', () => {
    it('returns empty config and schema when no fleet defaults are set', async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const event = makeEvent({
        rawPath: '/v1/settings/fleet-defaults/fleet:1234',
        pathParameters: { fleet: 'fleet:1234' },
        requestContext: makeAdminContext('GET', '/v1/settings/fleet-defaults/fleet:1234'),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.fleet_uid).toBe('fleet:1234');
      expect(body.config).toEqual({});
      expect(body.schema).toBeDefined();
      expect(body.schema.mode).toBeDefined();
    });

    it('returns stored config when fleet defaults exist', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          setting_type: 'fleet_defaults',
          setting_id: 'fleet:1234',
          config: { mode: 'transit', temp_alert_high_c: 40 },
          updated_at: 1700000000000,
          updated_by: 'admin@test.com',
        },
      });

      const event = makeEvent({
        rawPath: '/v1/settings/fleet-defaults/fleet:1234',
        pathParameters: { fleet: 'fleet:1234' },
        requestContext: makeAdminContext('GET', '/v1/settings/fleet-defaults/fleet:1234'),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.config.mode).toBe('transit');
      expect(body.config.temp_alert_high_c).toBe(40);
      expect(body.updated_by).toBe('admin@test.com');
    });
  });

  describe('GET /v1/settings/fleet-defaults', () => {
    it('lists all fleet defaults for admin', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            setting_type: 'fleet_defaults',
            setting_id: 'fleet:1234',
            config: { mode: 'demo' },
            updated_at: 1700000000000,
            updated_by: 'admin@test.com',
          },
        ],
      });

      const event = makeEvent({
        rawPath: '/v1/settings/fleet-defaults',
        requestContext: makeAdminContext('GET', '/v1/settings/fleet-defaults'),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.fleet_defaults).toHaveLength(1);
      expect(body.fleet_defaults[0].fleet_uid).toBe('fleet:1234');
    });
  });

  describe('PUT /v1/settings/fleet-defaults/{fleet}', () => {
    function setupNotehubMocks() {
      secretsMock.on(GetSecretValueCommand).resolves({
        SecretString: JSON.stringify({ token: 'test-notehub-token' }),
      });

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{}'),
      }));
    }

    it('rejects unknown settings keys', async () => {
      const event = makeEvent({
        rawPath: '/v1/settings/fleet-defaults/fleet:1234',
        pathParameters: { fleet: 'fleet:1234' },
        requestContext: makeAdminContext('PUT', '/v1/settings/fleet-defaults/fleet:1234'),
        body: JSON.stringify({ unknown_setting: 'value' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body as string);
      expect(body.error).toBe('Validation failed');
      expect(body.details).toContain('Unknown setting: unknown_setting');
    });

    it('rejects invalid mode values', async () => {
      const event = makeEvent({
        rawPath: '/v1/settings/fleet-defaults/fleet:1234',
        pathParameters: { fleet: 'fleet:1234' },
        requestContext: makeAdminContext('PUT', '/v1/settings/fleet-defaults/fleet:1234'),
        body: JSON.stringify({ mode: 'turbo' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body as string);
      expect(body.details).toEqual(
        expect.arrayContaining([expect.stringContaining('mode must be one of')])
      );
    });

    it('rejects number out of range', async () => {
      const event = makeEvent({
        rawPath: '/v1/settings/fleet-defaults/fleet:1234',
        pathParameters: { fleet: 'fleet:1234' },
        requestContext: makeAdminContext('PUT', '/v1/settings/fleet-defaults/fleet:1234'),
        body: JSON.stringify({ temp_alert_high_c: 100 }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body as string);
      expect(body.details).toEqual(
        expect.arrayContaining([expect.stringContaining('temp_alert_high_c must be at most 85')])
      );
    });

    it('rejects wrong types', async () => {
      const event = makeEvent({
        rawPath: '/v1/settings/fleet-defaults/fleet:1234',
        pathParameters: { fleet: 'fleet:1234' },
        requestContext: makeAdminContext('PUT', '/v1/settings/fleet-defaults/fleet:1234'),
        body: JSON.stringify({ audio_enabled: 'yes' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body as string);
      expect(body.details).toEqual(
        expect.arrayContaining([expect.stringContaining('audio_enabled must be a boolean')])
      );
    });

    it('stores valid config to DynamoDB and pushes to Notehub', async () => {
      setupNotehubMocks();

      ddbMock.on(PutCommand).resolves({});

      const event = makeEvent({
        rawPath: '/v1/settings/fleet-defaults/fleet:1234',
        pathParameters: { fleet: 'fleet:1234' },
        requestContext: makeAdminContext('PUT', '/v1/settings/fleet-defaults/fleet:1234'),
        body: JSON.stringify({ mode: 'demo', temp_alert_high_c: 35 }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.fleet_uid).toBe('fleet:1234');
      expect(body.config.mode).toBe('demo');
      expect(body.config.temp_alert_high_c).toBe(35);
      expect(body.updated_by).toBe('admin@test.com');

      // Verify DynamoDB PutCommand was called
      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0].args[0].input.Item).toMatchObject({
        setting_type: 'fleet_defaults',
        setting_id: 'fleet:1234',
        config: { mode: 'demo', temp_alert_high_c: 35 },
      });
    });

    it('returns notehub_sync status on success', async () => {
      setupNotehubMocks();
      ddbMock.on(PutCommand).resolves({});

      const event = makeEvent({
        rawPath: '/v1/settings/fleet-defaults/fleet:1234',
        pathParameters: { fleet: 'fleet:1234' },
        requestContext: makeAdminContext('PUT', '/v1/settings/fleet-defaults/fleet:1234'),
        body: JSON.stringify({ mode: 'transit' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.notehub_sync).toBe(true);
    });

    it('reports notehub_sync failure when Notehub API returns error', async () => {
      secretsMock.on(GetSecretValueCommand).resolves({
        SecretString: JSON.stringify({ token: 'test-notehub-token' }),
      });

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      }));

      ddbMock.on(PutCommand).resolves({});

      const event = makeEvent({
        rawPath: '/v1/settings/fleet-defaults/fleet:1234',
        pathParameters: { fleet: 'fleet:1234' },
        requestContext: makeAdminContext('PUT', '/v1/settings/fleet-defaults/fleet:1234'),
        body: JSON.stringify({ mode: 'demo' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.notehub_sync).toBe(false);
      expect(body.notehub_error).toContain('Notehub API error');
    });

    it('accepts valid boolean settings', async () => {
      setupNotehubMocks();
      ddbMock.on(PutCommand).resolves({});

      const event = makeEvent({
        rawPath: '/v1/settings/fleet-defaults/fleet:1234',
        pathParameters: { fleet: 'fleet:1234' },
        requestContext: makeAdminContext('PUT', '/v1/settings/fleet-defaults/fleet:1234'),
        body: JSON.stringify({ audio_enabled: true, led_enabled: false }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      const event = makeEvent({
        rawPath: '/v1/settings/unknown',
        requestContext: makeAdminContext('GET', '/v1/settings/unknown'),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(404);
    });
  });
});
