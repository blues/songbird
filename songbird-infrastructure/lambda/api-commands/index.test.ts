/**
 * Tests for the Commands API Lambda
 *
 * Tests command sending (with Notehub integration), authorization,
 * command history (merged across Notecard swaps), and deletion.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// Mock device-lookup
vi.mock('../shared/device-lookup', () => ({
  resolveDevice: vi.fn(),
}));

// Mock fetch for Notehub API calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { handler } from './index';
import { resolveDevice } from '../shared/device-lookup';

const ddbMock = mockClient(DynamoDBDocumentClient);
const secretsMock = mockClient(SecretsManagerClient);

beforeEach(() => {
  ddbMock.reset();
  secretsMock.reset();
  mockFetch.mockReset();
  vi.mocked(resolveDevice).mockReset();

  // Default: secrets returns a valid token
  secretsMock.on(GetSecretValueCommand).resolves({
    SecretString: JSON.stringify({ token: 'test-notehub-token' }),
  });

  // Default: Notehub API returns success
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
  });

  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(GetCommand).resolves({ Item: undefined });
});

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/devices/sb01/commands',
    pathParameters: { serial_number: 'sb01' },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {
      http: { method: 'GET', path: '/devices/sb01/commands' },
      authorizer: {
        jwt: {
          claims: {
            'cognito:groups': 'Admin',
            email: 'admin@example.com',
          },
        },
      },
    } as any,
    resource: '',
    ...overrides,
  };
}

describe('handler routing', () => {
  it('returns 200 for OPTIONS', async () => {
    const event = makeEvent({
      requestContext: { http: { method: 'OPTIONS', path: '/devices/sb01/commands' } } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });

  it('returns 400 when serial_number is missing for device commands', async () => {
    const event = makeEvent({
      pathParameters: null,
      requestContext: {
        http: { method: 'POST', path: '/devices//commands' },
        authorizer: { jwt: { claims: {} } },
      } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  it('returns 404 when device not found', async () => {
    vi.mocked(resolveDevice).mockResolvedValue(null);

    const event = makeEvent({
      requestContext: {
        http: { method: 'POST', path: '/devices/sb01/commands' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Admin' } } },
      } as any,
      body: JSON.stringify({ cmd: 'ping' }),
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });
});

describe('POST /devices/{serial_number}/commands - send command', () => {
  beforeEach(() => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });
  });

  it('sends valid command to Notehub and stores it', async () => {
    const event = makeEvent({
      httpMethod: 'POST',
      requestContext: {
        http: { method: 'POST', path: '/devices/sb01/commands' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' } } },
      } as any,
      body: JSON.stringify({ cmd: 'ping' }),
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.cmd).toBe('ping');
    expect(body.serial_number).toBe('sb01');
    expect(body.device_uid).toBe('dev:1234');
    expect(body.status).toBe('queued');
    expect(body.command_id).toMatch(/^cmd_/);

    // Should have called Notehub API
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchUrl = mockFetch.mock.calls[0][0];
    expect(fetchUrl).toContain('dev:1234');
    expect(fetchUrl).toContain('command.qi');

    // Should have stored command in DynamoDB
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.Item?.cmd).toBe('ping');
    expect(putCalls[0].args[0].input.Item?.status).toBe('queued');
  });

  it('sends command with params', async () => {
    const event = makeEvent({
      httpMethod: 'POST',
      requestContext: {
        http: { method: 'POST', path: '/devices/sb01/commands' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Admin' } } },
      } as any,
      body: JSON.stringify({ cmd: 'play_melody', params: { melody: 'happy_birthday' } }),
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.params).toEqual({ melody: 'happy_birthday' });
  });

  it('rejects invalid command', async () => {
    const event = makeEvent({
      httpMethod: 'POST',
      requestContext: {
        http: { method: 'POST', path: '/devices/sb01/commands' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Admin' } } },
      } as any,
      body: JSON.stringify({ cmd: 'self_destruct' }),
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).valid_commands).toContain('ping');
  });

  it('returns 400 when body is missing', async () => {
    const event = makeEvent({
      httpMethod: 'POST',
      requestContext: {
        http: { method: 'POST', path: '/devices/sb01/commands' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Admin' } } },
      } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  it('returns 502 when Notehub API fails', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      text: () => Promise.resolve('Notehub error'),
    });

    const event = makeEvent({
      httpMethod: 'POST',
      requestContext: {
        http: { method: 'POST', path: '/devices/sb01/commands' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Admin' } } },
      } as any,
      body: JSON.stringify({ cmd: 'ping' }),
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(502);
  });
});

describe('command authorization', () => {
  beforeEach(() => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:1234',
      all_device_uids: ['dev:1234'],
    });
  });

  it('allows non-restricted commands for any authenticated user', async () => {
    const event = makeEvent({
      httpMethod: 'POST',
      requestContext: {
        http: { method: 'POST', path: '/devices/sb01/commands' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Viewer', email: 'viewer@test.com' } } },
      } as any,
      body: JSON.stringify({ cmd: 'ping' }),
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });

  it('allows unlock command for admin', async () => {
    const event = makeEvent({
      httpMethod: 'POST',
      requestContext: {
        http: { method: 'POST', path: '/devices/sb01/commands' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' } } },
      } as any,
      body: JSON.stringify({ cmd: 'unlock' }),
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });

  it('allows unlock command for device owner', async () => {
    // Device is assigned to this user
    ddbMock.on(GetCommand).resolves({
      Item: { device_uid: 'dev:1234', assigned_to: 'owner@test.com' },
    });

    const event = makeEvent({
      httpMethod: 'POST',
      requestContext: {
        http: { method: 'POST', path: '/devices/sb01/commands' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Sales', email: 'owner@test.com' } } },
      } as any,
      body: JSON.stringify({ cmd: 'unlock' }),
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });

  it('rejects unlock command for non-admin non-owner', async () => {
    // Device is assigned to someone else
    ddbMock.on(GetCommand).resolves({
      Item: { device_uid: 'dev:1234', assigned_to: 'other@test.com' },
    });

    const event = makeEvent({
      httpMethod: 'POST',
      requestContext: {
        http: { method: 'POST', path: '/devices/sb01/commands' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Sales', email: 'notowner@test.com' } } },
      } as any,
      body: JSON.stringify({ cmd: 'unlock' }),
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(403);
  });
});

describe('GET /devices/{serial_number}/commands - command history', () => {
  it('returns merged command history across Notecard swaps', async () => {
    vi.mocked(resolveDevice).mockResolvedValue({
      serial_number: 'sb01',
      device_uid: 'dev:current',
      all_device_uids: ['dev:current', 'dev:old'],
    });

    // Commands from current device_uid
    ddbMock.on(QueryCommand, {
      ExpressionAttributeValues: { ':device_uid': 'dev:current' },
    }).resolves({
      Items: [
        { command_id: 'cmd_1', cmd: 'ping', created_at: 3000, device_uid: 'dev:current' },
      ],
    });

    // Commands from old device_uid
    ddbMock.on(QueryCommand, {
      ExpressionAttributeValues: { ':device_uid': 'dev:old' },
    }).resolves({
      Items: [
        { command_id: 'cmd_2', cmd: 'locate', created_at: 1000, device_uid: 'dev:old' },
      ],
    });

    const event = makeEvent({
      requestContext: {
        http: { method: 'GET', path: '/devices/sb01/commands' },
      } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.commands).toHaveLength(2);
    // Should be sorted by created_at descending
    expect(body.commands[0].command_id).toBe('cmd_1');
    expect(body.commands[1].command_id).toBe('cmd_2');
    expect(body.serial_number).toBe('sb01');
  });
});

describe('GET /v1/commands - all commands', () => {
  it('returns all commands when no device_uid filter', async () => {
    const commands = [
      { command_id: 'cmd_1', cmd: 'ping', created_at: 2000 },
      { command_id: 'cmd_2', cmd: 'locate', created_at: 1000 },
    ];
    ddbMock.on(ScanCommand).resolves({ Items: commands });

    const event = makeEvent({
      pathParameters: null,
      queryStringParameters: null,
      requestContext: {
        http: { method: 'GET', path: '/v1/commands' },
      } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.commands).toHaveLength(2);
    // Should be sorted most recent first
    expect(body.commands[0].command_id).toBe('cmd_1');
  });

  it('filters by device_uid when provided', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ command_id: 'cmd_1', cmd: 'ping', created_at: 1000 }],
    });

    const event = makeEvent({
      pathParameters: null,
      queryStringParameters: { device_uid: 'dev:1234' },
      requestContext: {
        http: { method: 'GET', path: '/v1/commands' },
      } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls[0].args[0].input.IndexName).toBe('device-created-index');
  });
});

describe('DELETE /v1/commands/{command_id}', () => {
  it('deletes existing command', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { device_uid: 'dev:1234', command_id: 'cmd_123', cmd: 'ping' },
    });
    ddbMock.on(DeleteCommand).resolves({});

    const event = makeEvent({
      httpMethod: 'DELETE',
      pathParameters: { command_id: 'cmd_123' },
      queryStringParameters: { device_uid: 'dev:1234' },
      requestContext: {
        http: { method: 'DELETE', path: '/v1/commands/cmd_123' },
      } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).command_id).toBe('cmd_123');
  });

  it('returns 404 when command does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const event = makeEvent({
      httpMethod: 'DELETE',
      pathParameters: { command_id: 'nonexistent' },
      queryStringParameters: { device_uid: 'dev:1234' },
      requestContext: {
        http: { method: 'DELETE', path: '/v1/commands/nonexistent' },
      } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });

  it('requires device_uid query parameter', async () => {
    const event = makeEvent({
      httpMethod: 'DELETE',
      pathParameters: { command_id: 'cmd_123' },
      queryStringParameters: null,
      requestContext: {
        http: { method: 'DELETE', path: '/v1/commands/cmd_123' },
      } as any,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('device_uid');
  });
});
