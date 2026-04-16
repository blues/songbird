/**
 * Tests for the Firmware API Lambda
 *
 * Tests firmware management operations including listing firmware,
 * queuing updates, cancelling updates, and DFU status.
 * All endpoints require admin access.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secretsMock = mockClient(SecretsManagerClient);

// Track fetch calls
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  secretsMock.reset();

  // Reset the cached token between tests by re-importing
  // We set up standard mocks for Secrets Manager
  secretsMock.on(GetSecretValueCommand).resolves({
    SecretString: JSON.stringify({ token: 'test-notehub-token' }),
  });

  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// Import handler after mocks are set up
import { handler } from './index';

function makeEvent(overrides: Record<string, any> = {}) {
  return {
    version: '2.0',
    routeKey: 'GET /v1/firmware',
    rawPath: '/v1/firmware',
    body: null,
    headers: {},
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      http: { method: 'GET', path: '/v1/firmware' },
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

describe('API Firmware Lambda', () => {
  describe('authorization', () => {
    it('returns 403 for non-admin users', async () => {
      const event = makeEvent({
        requestContext: {
          http: { method: 'GET', path: '/v1/firmware' },
          authorizer: {
            jwt: {
              claims: { 'cognito:groups': 'Sales', email: 'sales@test.com' },
            },
          },
        },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body as string).error).toBe('Admin access required');
    });

    it('returns 403 when no groups claim is present', async () => {
      const event = makeEvent({
        requestContext: {
          http: { method: 'GET', path: '/v1/firmware' },
          authorizer: { jwt: { claims: {} } },
        },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(403);
    });

    it('returns 200 for OPTIONS (CORS preflight)', async () => {
      const event = makeEvent({
        requestContext: {
          http: { method: 'OPTIONS', path: '/v1/firmware' },
          authorizer: { jwt: { claims: {} } },
        },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
    });
  });

  describe('GET /v1/firmware', () => {
    it('lists firmware with version extraction from string', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify([
          {
            filename: 'songbird-v1.2.0.bin',
            version: '1.2.0',
            created: '1700000000',
            type: 'host',
            target: 'stm32',
            md5: 'abc123',
            length: 102400,
          },
        ])),
      });

      const event = makeEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.firmware).toHaveLength(1);
      expect(body.firmware[0]).toMatchObject({
        filename: 'songbird-v1.2.0.bin',
        version: '1.2.0',
        type: 'host',
        target: 'stm32',
        md5: 'abc123',
        size: 102400,
      });
      // Unix timestamp should be converted to ISO string
      expect(body.firmware[0].created).toBeDefined();
    });

    it('extracts version from version object', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify([
          {
            filename: 'songbird-v2.0.0.bin',
            version: {
              version: '2.0.0',
              organization: 'Blues',
              product: 'Songbird',
            },
            created: '1700000000',
            type: 'host',
          },
        ])),
      });

      const event = makeEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.firmware[0].version).toBe('2.0.0');
    });

    it('returns empty array when no firmware exists', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify([])),
      });

      const event = makeEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.firmware).toEqual([]);
    });
  });

  describe('GET /v1/firmware/status', () => {
    it('returns DFU status with device info', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          firmware_type: 'host',
          devices: [
            {
              device_uid: 'dev:1234',
              sn: 'songbird01',
              current: { version: '1.0.0' },
              status: {
                requested_version: '1.2.0',
                initiated: '2025-01-01T00:00:00Z',
                updates: [
                  { phase: 'downloading', datetime: '2025-01-01T00:01:00Z' },
                ],
              },
            },
          ],
        })),
      });

      const event = makeEvent({
        rawPath: '/v1/firmware/status',
        requestContext: makeAdminContext('GET', '/v1/firmware/status'),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.firmware_type).toBe('host');
      expect(body.devices).toHaveLength(1);
      expect(body.devices[0]).toMatchObject({
        device_uid: 'dev:1234',
        serial_number: 'songbird01',
        current_version: '1.0.0',
        requested_version: '1.2.0',
        status: 'downloading',
      });
    });
  });

  describe('POST /v1/firmware/update', () => {
    it('queues firmware update with filename', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(''),
      });

      const event = makeEvent({
        rawPath: '/v1/firmware/update',
        requestContext: makeAdminContext('POST', '/v1/firmware/update'),
        body: JSON.stringify({ filename: 'songbird-v1.2.0.bin' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body as string).message).toBe('Firmware update queued successfully');

      // Verify the fetch call to Notehub
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/dfu/host/update'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('returns 400 when filename is missing', async () => {
      const event = makeEvent({
        rawPath: '/v1/firmware/update',
        requestContext: makeAdminContext('POST', '/v1/firmware/update'),
        body: JSON.stringify({}),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body as string).error).toBe('filename is required');
    });

    it('includes fleetUID and deviceUID query params when provided', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(''),
      });

      const event = makeEvent({
        rawPath: '/v1/firmware/update',
        requestContext: makeAdminContext('POST', '/v1/firmware/update'),
        body: JSON.stringify({
          filename: 'songbird-v1.2.0.bin',
          fleetUID: 'fleet:abc',
          deviceUID: 'dev:123',
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const fetchUrl = fetchMock.mock.calls[0][0];
      expect(fetchUrl).toContain('fleetUID=fleet%3Aabc');
      expect(fetchUrl).toContain('deviceUID=dev%3A123');
    });
  });

  describe('POST /v1/firmware/cancel', () => {
    it('cancels firmware update', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(''),
      });

      const event = makeEvent({
        rawPath: '/v1/firmware/cancel',
        requestContext: makeAdminContext('POST', '/v1/firmware/cancel'),
        body: JSON.stringify({}),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body as string).message).toBe('Firmware update cancelled');

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/dfu/host/cancel'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('passes fleetUID when cancelling', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(''),
      });

      const event = makeEvent({
        rawPath: '/v1/firmware/cancel',
        requestContext: makeAdminContext('POST', '/v1/firmware/cancel'),
        body: JSON.stringify({ fleetUID: 'fleet:abc' }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const fetchUrl = fetchMock.mock.calls[0][0];
      expect(fetchUrl).toContain('fleetUID=fleet%3Aabc');
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      const event = makeEvent({
        rawPath: '/v1/firmware/unknown',
        requestContext: makeAdminContext('GET', '/v1/firmware/unknown'),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(404);
    });
  });

  describe('error handling', () => {
    it('returns 500 with error message when Notehub API fails', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: () => Promise.resolve('upstream error'),
      });

      const event = makeEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body as string);
      expect(body.error).toContain('Notehub API error');
    });

    it('returns 500 when fetch throws', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      const event = makeEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body as string).error).toContain('Network error');
    });
  });
});
