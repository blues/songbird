/**
 * Tests for the Notehub API Lambda
 *
 * Tests Notehub project status fetching, fleet listing,
 * and degraded status handling on errors.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { handler } from './index';

const smMock = mockClient(SecretsManagerClient);

beforeEach(() => {
  smMock.reset();
  mockFetch.mockReset();

  // Default: Secrets Manager returns a valid token
  smMock.on(GetSecretValueCommand).resolves({
    SecretString: JSON.stringify({ token: 'test-notehub-token' }),
  });
});

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /v1/notehub/status',
    rawPath: '/v1/notehub/status',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123456789',
      apiId: 'test',
      domainName: 'test.execute-api.us-east-1.amazonaws.com',
      domainPrefix: 'test',
      http: {
        method: 'GET',
        path: '/v1/notehub/status',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'test-id',
      routeKey: 'GET /v1/notehub/status',
      stage: '$default',
      time: '01/Jan/2025:00:00:00 +0000',
      timeEpoch: 1735689600000,
    },
    isBase64Encoded: false,
    ...overrides,
  } as APIGatewayProxyEventV2;
}

/**
 * Helper to set up fetch mock for all Notehub API calls used by the status endpoint.
 */
function mockNotehubApis(overrides: {
  project?: any;
  routes?: any;
  fleets?: any;
  devicesPage1?: any;
  devicesPage2?: any;
} = {}) {
  const project = overrides.project ?? {
    uid: 'app:test-project',
    label: 'Songbird',
    created: '2024-01-01T00:00:00Z',
    role: 'owner',
  };

  const routes = overrides.routes ?? [
    { uid: 'route:1', label: 'Ingest', type: 'http', disabled: false, modified: '2024-06-01' },
  ];

  const fleets = overrides.fleets ?? {
    fleets: [{ uid: 'fleet:1', label: 'Default', created: '2024-01-01' }],
  };

  const devicesPage1 = overrides.devicesPage1 ?? { devices: [{}], has_more: false };
  const devicesPage2 = overrides.devicesPage2 ?? { devices: [{}] };

  mockFetch.mockImplementation((url: string) => {
    if (url.includes(`/v1/projects/`) && url.includes('/routes')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(routes) });
    }
    if (url.includes(`/v1/projects/`) && url.includes('/fleets')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(fleets) });
    }
    if (url.includes(`/v1/projects/`) && url.includes('/devices') && url.includes('pageSize=1')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(devicesPage1) });
    }
    if (url.includes(`/v1/projects/`) && url.includes('/devices') && url.includes('pageSize=500')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(devicesPage2) });
    }
    if (url.includes(`/v1/projects/`)) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(project) });
    }
    return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' });
  });
}

describe('OPTIONS', () => {
  it('returns 200 for OPTIONS', async () => {
    const event = makeEvent({
      requestContext: {
        ...makeEvent().requestContext,
        http: { ...makeEvent().requestContext.http, method: 'OPTIONS' },
      },
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });
});

describe('GET /v1/notehub/status - healthy', () => {
  it('returns healthy status when active routes exist', async () => {
    mockNotehubApis();

    const event = makeEvent();
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.health).toBe('healthy');
    expect(body.project.uid).toBe('app:test-project');
    expect(body.project.name).toBe('Songbird');
    expect(body.routes).toHaveLength(1);
    expect(body.routes[0].enabled).toBe(true);
    expect(body.fleets).toHaveLength(1);
    expect(body.last_checked).toBeDefined();
  });

  it('returns warning status when all routes are disabled', async () => {
    mockNotehubApis({
      routes: [
        { uid: 'route:1', label: 'Ingest', type: 'http', disabled: true, modified: '2024-06-01' },
      ],
    });

    const event = makeEvent();
    const result = await handler(event);

    const body = JSON.parse(result.body as string);
    expect(body.health).toBe('warning');
  });

  it('returns correct device count', async () => {
    mockNotehubApis({
      devicesPage2: { devices: [{}, {}, {}] },
    });

    const event = makeEvent();
    const result = await handler(event);

    const body = JSON.parse(result.body as string);
    expect(body.device_count).toBe(3);
  });
});

describe('GET /v1/notehub/status - error/degraded', () => {
  it('returns degraded status with health error on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const event = makeEvent();
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.health).toBe('error');
    expect(body.error).toContain('Network error');
    expect(body.project.uid).toBe('app:test-project');
    expect(body.routes).toEqual([]);
    expect(body.fleets).toEqual([]);
  });

  it('returns degraded status when Notehub API returns non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    const event = makeEvent();
    const result = await handler(event);

    const body = JSON.parse(result.body as string);
    expect(body.health).toBe('error');
  });
});

describe('GET /v1/notehub/fleets', () => {
  it('returns fleet list', async () => {
    mockNotehubApis();

    const event = makeEvent({
      rawPath: '/v1/notehub/fleets',
      requestContext: {
        ...makeEvent().requestContext,
        http: { ...makeEvent().requestContext.http, path: '/v1/notehub/fleets' },
      },
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body as string);
    expect(body.fleets).toHaveLength(1);
    expect(body.fleets[0].name).toBe('Default');
  });
});

describe('unknown paths', () => {
  it('returns 404 for unknown paths', async () => {
    const event = makeEvent({
      rawPath: '/v1/notehub/unknown',
      requestContext: {
        ...makeEvent().requestContext,
        http: { ...makeEvent().requestContext.http, path: '/v1/notehub/unknown' },
      },
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });
});
