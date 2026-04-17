/**
 * Tests for the Users API Lambda
 *
 * Tests user management operations including listing, creating,
 * updating groups, assigning devices, and deleting users.
 * All endpoints require admin access.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand,
  AdminGetUserCommand,
  AdminDeleteUserCommand,
  AdminConfirmSignUpCommand,
  ListGroupsCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { handler } from './index';

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  cognitoMock.reset();
  ddbMock.reset();
});

function makeEvent(overrides: Record<string, any> = {}) {
  return {
    version: '2.0',
    routeKey: 'GET /v1/users',
    rawPath: '/v1/users',
    body: null,
    headers: {},
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      http: { method: 'GET', path: '/v1/users' },
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

describe('API Users Lambda', () => {
  describe('authorization', () => {
    it('returns 403 for non-admin users', async () => {
      const event = makeEvent({
        requestContext: {
          http: { method: 'GET', path: '/v1/users' },
          authorizer: {
            jwt: {
              claims: { 'cognito:groups': 'Viewer', email: 'viewer@test.com' },
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
          http: { method: 'GET', path: '/v1/users' },
          authorizer: { jwt: { claims: { email: 'nobody@test.com' } } },
        },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(403);
    });

    it('returns 200 for OPTIONS (CORS preflight) without auth', async () => {
      const event = makeEvent({
        requestContext: {
          http: { method: 'OPTIONS', path: '/v1/users' },
          authorizer: { jwt: { claims: {} } },
        },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
    });
  });

  describe('GET /v1/users', () => {
    it('lists users from Cognito with their groups', async () => {
      cognitoMock.on(ListUsersCommand).resolves({
        Users: [
          {
            Username: 'user-1',
            Attributes: [
              { Name: 'email', Value: 'alice@test.com' },
              { Name: 'name', Value: 'Alice' },
            ],
            UserStatus: 'CONFIRMED',
            UserCreateDate: new Date('2025-01-01T00:00:00Z'),
          },
        ],
      });

      cognitoMock.on(AdminListGroupsForUserCommand).resolves({
        Groups: [{ GroupName: 'Sales' }],
      });

      const event = makeEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.users).toHaveLength(1);
      expect(body.users[0]).toMatchObject({
        username: 'user-1',
        email: 'alice@test.com',
        name: 'Alice',
        status: 'CONFIRMED',
        groups: ['Sales'],
      });
    });

    it('returns empty list when no users exist', async () => {
      cognitoMock.on(ListUsersCommand).resolves({ Users: [] });

      const result = await handler(makeEvent());

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body as string).users).toEqual([]);
    });

    it('includes assigned devices when include_devices=true', async () => {
      cognitoMock.on(ListUsersCommand).resolves({
        Users: [
          {
            Username: 'user-1',
            Attributes: [
              { Name: 'email', Value: 'alice@test.com' },
              { Name: 'name', Value: 'Alice' },
            ],
            UserStatus: 'CONFIRMED',
            UserCreateDate: new Date('2025-01-01T00:00:00Z'),
          },
        ],
      });

      cognitoMock.on(AdminListGroupsForUserCommand).resolves({
        Groups: [{ GroupName: 'Sales' }],
      });

      ddbMock.on(ScanCommand).resolves({
        Items: [{ device_uid: 'dev:abc123' }],
      });

      const event = makeEvent({
        queryStringParameters: { include_devices: 'true' },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.users[0].assigned_devices).toEqual(['dev:abc123']);
    });
  });

  describe('GET /v1/users/groups', () => {
    it('lists available Cognito groups', async () => {
      cognitoMock.on(ListGroupsCommand).resolves({
        Groups: [
          { GroupName: 'Admin', Description: 'Administrator' },
          { GroupName: 'Sales', Description: 'Sales team' },
        ],
      });

      const event = makeEvent({
        rawPath: '/v1/users/groups',
        requestContext: {
          http: { method: 'GET', path: '/v1/users/groups' },
          authorizer: {
            jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' } },
          },
        },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.groups).toHaveLength(2);
      expect(body.groups[0].name).toBe('Admin');
    });
  });

  describe('POST /v1/users', () => {
    it('creates a user with email, name, and group', async () => {
      cognitoMock.on(AdminCreateUserCommand).resolves({
        User: { Username: 'alice@test.com', UserStatus: 'FORCE_CHANGE_PASSWORD' },
      });
      cognitoMock.on(AdminAddUserToGroupCommand).resolves({});

      const event = makeEvent({
        rawPath: '/v1/users',
        requestContext: {
          http: { method: 'POST', path: '/v1/users' },
          authorizer: {
            jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' } },
          },
        },
        body: JSON.stringify({ email: 'alice@test.com', name: 'Alice', group: 'Sales' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body as string);
      expect(body.email).toBe('alice@test.com');
      expect(body.name).toBe('Alice');
      expect(body.groups).toEqual(['Sales']);
    });

    it('returns 400 when email is missing', async () => {
      const event = makeEvent({
        rawPath: '/v1/users',
        requestContext: {
          http: { method: 'POST', path: '/v1/users' },
          authorizer: {
            jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' } },
          },
        },
        body: JSON.stringify({ name: 'Alice', group: 'Sales' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body as string).error).toContain('email, name, and group are required');
    });

    it('returns 400 when name is missing', async () => {
      const event = makeEvent({
        rawPath: '/v1/users',
        requestContext: {
          http: { method: 'POST', path: '/v1/users' },
          authorizer: {
            jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' } },
          },
        },
        body: JSON.stringify({ email: 'alice@test.com', group: 'Sales' }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
    });

    it('returns 400 when group is missing', async () => {
      const event = makeEvent({
        rawPath: '/v1/users',
        requestContext: {
          http: { method: 'POST', path: '/v1/users' },
          authorizer: {
            jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' } },
          },
        },
        body: JSON.stringify({ email: 'alice@test.com', name: 'Alice' }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
    });

    it('rejects invalid groups', async () => {
      const event = makeEvent({
        rawPath: '/v1/users',
        requestContext: {
          http: { method: 'POST', path: '/v1/users' },
          authorizer: {
            jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' } },
          },
        },
        body: JSON.stringify({ email: 'alice@test.com', name: 'Alice', group: 'SuperAdmin' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body as string).error).toContain('group must be one of');
    });

    it('accepts all valid group names', async () => {
      for (const group of ['Admin', 'Sales', 'FieldEngineering', 'Viewer']) {
        cognitoMock.reset();
        cognitoMock.on(AdminCreateUserCommand).resolves({
          User: { Username: 'test@test.com', UserStatus: 'FORCE_CHANGE_PASSWORD' },
        });
        cognitoMock.on(AdminAddUserToGroupCommand).resolves({});

        const event = makeEvent({
          rawPath: '/v1/users',
          requestContext: {
            http: { method: 'POST', path: '/v1/users' },
            authorizer: {
              jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' } },
            },
          },
          body: JSON.stringify({ email: 'test@test.com', name: 'Test', group }),
        });

        const result = await handler(event);
        expect(result.statusCode).toBe(201);
      }
    });

    it('assigns a device when device_uids is provided', async () => {
      cognitoMock.on(AdminCreateUserCommand).resolves({
        User: { Username: 'alice@test.com', UserStatus: 'FORCE_CHANGE_PASSWORD' },
      });
      cognitoMock.on(AdminAddUserToGroupCommand).resolves({});
      // ScanCommand for getDevicesAssignedToUser (no existing devices)
      ddbMock.on(ScanCommand).resolves({ Items: [] });
      ddbMock.on(UpdateCommand).resolves({});

      const event = makeEvent({
        rawPath: '/v1/users',
        requestContext: {
          http: { method: 'POST', path: '/v1/users' },
          authorizer: {
            jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' } },
          },
        },
        body: JSON.stringify({
          email: 'alice@test.com',
          name: 'Alice',
          group: 'Sales',
          device_uids: ['dev:abc123'],
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body as string);
      expect(body.assigned_devices).toEqual(['dev:abc123']);
    });
  });

  describe('PUT /v1/users/{userId}/groups', () => {
    it('updates user group membership', async () => {
      cognitoMock.on(AdminListGroupsForUserCommand).resolves({
        Groups: [{ GroupName: 'Viewer' }],
      });
      cognitoMock.on(AdminRemoveUserFromGroupCommand).resolves({});
      cognitoMock.on(AdminAddUserToGroupCommand).resolves({});

      const event = makeEvent({
        rawPath: '/v1/users/user-1/groups',
        pathParameters: { userId: 'user-1' },
        requestContext: {
          http: { method: 'PUT', path: '/v1/users/user-1/groups' },
          authorizer: {
            jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' } },
          },
        },
        body: JSON.stringify({ groups: ['Sales'] }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.groups).toEqual(['Sales']);
    });

    it('rejects invalid group names', async () => {
      const event = makeEvent({
        rawPath: '/v1/users/user-1/groups',
        pathParameters: { userId: 'user-1' },
        requestContext: {
          http: { method: 'PUT', path: '/v1/users/user-1/groups' },
          authorizer: {
            jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' } },
          },
        },
        body: JSON.stringify({ groups: ['InvalidGroup'] }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body as string).error).toContain('Invalid group');
    });

    it('returns 400 when groups array is missing', async () => {
      const event = makeEvent({
        rawPath: '/v1/users/user-1/groups',
        pathParameters: { userId: 'user-1' },
        requestContext: {
          http: { method: 'PUT', path: '/v1/users/user-1/groups' },
          authorizer: {
            jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' } },
          },
        },
        body: JSON.stringify({}),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body as string).error).toContain('groups array required');
    });
  });

  describe('PUT /v1/users/{userId}/device', () => {
    it('assigns a device to a user', async () => {
      cognitoMock.on(AdminGetUserCommand).resolves({
        Username: 'user-1',
        UserAttributes: [
          { Name: 'email', Value: 'alice@test.com' },
          { Name: 'name', Value: 'Alice' },
        ],
      });
      // ScanCommand for existing assigned devices (none)
      ddbMock.on(ScanCommand).resolves({ Items: [] });
      ddbMock.on(UpdateCommand).resolves({});

      const event = makeEvent({
        rawPath: '/v1/users/user-1/device',
        pathParameters: { userId: 'user-1' },
        requestContext: {
          http: { method: 'PUT', path: '/v1/users/user-1/device' },
          authorizer: {
            jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' } },
          },
        },
        body: JSON.stringify({ device_uid: 'dev:abc123' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.assigned_device).toBe('dev:abc123');
      expect(body.email).toBe('alice@test.com');
    });

    it('unassigns device when device_uid is null', async () => {
      cognitoMock.on(AdminGetUserCommand).resolves({
        Username: 'user-1',
        UserAttributes: [
          { Name: 'email', Value: 'alice@test.com' },
          { Name: 'name', Value: 'Alice' },
        ],
      });
      ddbMock.on(ScanCommand).resolves({
        Items: [{ device_uid: 'dev:old-device' }],
      });
      ddbMock.on(UpdateCommand).resolves({});

      const event = makeEvent({
        rawPath: '/v1/users/user-1/device',
        pathParameters: { userId: 'user-1' },
        requestContext: {
          http: { method: 'PUT', path: '/v1/users/user-1/device' },
          authorizer: {
            jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' } },
          },
        },
        body: JSON.stringify({ device_uid: null }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.assigned_device).toBeNull();
    });
  });

  describe('POST /v1/users/{userId}/confirm', () => {
    it('confirms an unconfirmed user', async () => {
      cognitoMock.on(AdminConfirmSignUpCommand).resolves({});

      const event = makeEvent({
        rawPath: '/v1/users/user-1/confirm',
        pathParameters: { userId: 'user-1' },
        requestContext: {
          http: { method: 'POST', path: '/v1/users/user-1/confirm' },
          authorizer: {
            jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' } },
          },
        },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body as string).message).toBe('User confirmed successfully');
    });
  });

  describe('DELETE /v1/users/{userId}', () => {
    it('deletes user and unassigns their devices', async () => {
      cognitoMock.on(AdminGetUserCommand).resolves({
        Username: 'user-1',
        UserAttributes: [
          { Name: 'email', Value: 'alice@test.com' },
        ],
      });
      cognitoMock.on(AdminDeleteUserCommand).resolves({});

      // User has two assigned devices
      ddbMock.on(ScanCommand).resolves({
        Items: [
          { device_uid: 'dev:device1' },
          { device_uid: 'dev:device2' },
        ],
      });
      ddbMock.on(UpdateCommand).resolves({});

      const event = makeEvent({
        rawPath: '/v1/users/user-1',
        pathParameters: { userId: 'user-1' },
        requestContext: {
          http: { method: 'DELETE', path: '/v1/users/user-1' },
          authorizer: {
            jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' } },
          },
        },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body as string).message).toBe('User deleted successfully');

      // Verify UpdateCommand was called for each device to unassign
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(2);
    });

    it('deletes user with no assigned devices', async () => {
      cognitoMock.on(AdminGetUserCommand).resolves({
        Username: 'user-1',
        UserAttributes: [
          { Name: 'email', Value: 'alice@test.com' },
        ],
      });
      cognitoMock.on(AdminDeleteUserCommand).resolves({});
      ddbMock.on(ScanCommand).resolves({ Items: [] });

      const event = makeEvent({
        rawPath: '/v1/users/user-1',
        pathParameters: { userId: 'user-1' },
        requestContext: {
          http: { method: 'DELETE', path: '/v1/users/user-1' },
          authorizer: {
            jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' } },
          },
        },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      // No UpdateCommand calls for device unassignment
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(0);
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      const event = makeEvent({
        rawPath: '/v1/unknown',
        requestContext: {
          http: { method: 'GET', path: '/v1/unknown' },
          authorizer: {
            jwt: { claims: { 'cognito:groups': 'Admin', email: 'admin@test.com' } },
          },
        },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(404);
    });
  });
});
