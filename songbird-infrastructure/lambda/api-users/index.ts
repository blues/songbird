/**
 * API Users Lambda
 *
 * Handles user management operations using Cognito Admin APIs.
 * All endpoints are admin-only.
 */

import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand,
  AdminGetUserCommand,
  AdminUpdateUserAttributesCommand,
  ListGroupsCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const cognitoClient = new CognitoIdentityProviderClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const USER_POOL_ID = process.env.USER_POOL_ID || '';
const DEVICES_TABLE = process.env.DEVICES_TABLE || 'songbird-devices';

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

const VALID_GROUPS = ['Admin', 'Sales', 'FieldEngineering', 'Viewer'];

function isAdmin(event: APIGatewayProxyEventV2): boolean {
  try {
    const claims = event.requestContext?.authorizer?.jwt?.claims;
    if (!claims) return false;

    const groups = claims['cognito:groups'];
    if (Array.isArray(groups)) {
      return groups.includes('Admin');
    }
    if (typeof groups === 'string') {
      return groups === 'Admin' || groups.includes('Admin');
    }
    return false;
  } catch {
    return false;
  }
}

interface UserInfo {
  username: string;
  email: string;
  name: string;
  status: string;
  created_at: string;
  groups: string[];
  assigned_devices?: string[];
}

async function listUsers(): Promise<UserInfo[]> {
  const result = await cognitoClient.send(new ListUsersCommand({
    UserPoolId: USER_POOL_ID,
    Limit: 60,
  }));

  const users: UserInfo[] = [];

  for (const user of result.Users || []) {
    const emailAttr = user.Attributes?.find(a => a.Name === 'email');
    const nameAttr = user.Attributes?.find(a => a.Name === 'name');

    // Get groups for this user
    const groupsResult = await cognitoClient.send(new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: user.Username!,
    }));

    const groups = (groupsResult.Groups || []).map(g => g.GroupName!);

    users.push({
      username: user.Username!,
      email: emailAttr?.Value || '',
      name: nameAttr?.Value || '',
      status: user.UserStatus || 'UNKNOWN',
      created_at: user.UserCreateDate?.toISOString() || '',
      groups,
    });
  }

  return users;
}

async function getDevicesAssignedToUser(userEmail: string): Promise<string[]> {
  const result = await docClient.send(new ScanCommand({
    TableName: DEVICES_TABLE,
    FilterExpression: 'assigned_to = :email',
    ExpressionAttributeValues: {
      ':email': userEmail,
    },
    ProjectionExpression: 'device_uid',
  }));

  return (result.Items || []).map(item => item.device_uid);
}

async function assignDeviceToUser(deviceUid: string, userEmail: string): Promise<void> {
  // First, unassign any device currently assigned to this user (single device per user)
  const currentDevices = await getDevicesAssignedToUser(userEmail);
  if (currentDevices.length > 0) {
    await unassignDevicesFromUser(currentDevices);
  }

  // Now assign the new device
  await docClient.send(new UpdateCommand({
    TableName: DEVICES_TABLE,
    Key: { device_uid: deviceUid },
    UpdateExpression: 'SET assigned_to = :email, updated_at = :now',
    ExpressionAttributeValues: {
      ':email': userEmail,
      ':now': Date.now(),
    },
  }));
}

async function getUnassignedDevices(): Promise<{ device_uid: string; serial_number: string; name?: string }[]> {
  const result = await docClient.send(new ScanCommand({
    TableName: DEVICES_TABLE,
    FilterExpression: 'attribute_not_exists(assigned_to) OR assigned_to = :empty',
    ExpressionAttributeValues: {
      ':empty': '',
    },
    ProjectionExpression: 'device_uid, serial_number, #n',
    ExpressionAttributeNames: {
      '#n': 'name',
    },
  }));

  return (result.Items || []).map(item => ({
    device_uid: item.device_uid,
    serial_number: item.serial_number,
    name: item.name,
  }));
}

async function unassignDevicesFromUser(deviceUids: string[]): Promise<void> {
  for (const deviceUid of deviceUids) {
    await docClient.send(new UpdateCommand({
      TableName: DEVICES_TABLE,
      Key: { device_uid: deviceUid },
      UpdateExpression: 'REMOVE assigned_to SET updated_at = :now',
      ExpressionAttributeValues: {
        ':now': Date.now(),
      },
    }));
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  console.log('Event:', JSON.stringify(event, null, 2));

  const method = event.requestContext.http.method;
  const path = event.rawPath;

  // Handle OPTIONS for CORS
  if (method === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // All user management endpoints require admin
  if (!isAdmin(event)) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({ error: 'Admin access required' }),
    };
  }

  try {
    // GET /v1/users - List all users
    if (method === 'GET' && path === '/v1/users') {
      const users = await listUsers();

      // Optionally include assigned devices for each user
      const includeDevices = event.queryStringParameters?.include_devices === 'true';
      if (includeDevices) {
        for (const user of users) {
          user.assigned_devices = await getDevicesAssignedToUser(user.email);
        }
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ users }),
      };
    }

    // GET /v1/users/groups - List available groups
    if (method === 'GET' && path === '/v1/users/groups') {
      const result = await cognitoClient.send(new ListGroupsCommand({
        UserPoolId: USER_POOL_ID,
      }));

      const groups = (result.Groups || []).map(g => ({
        name: g.GroupName,
        description: g.Description,
      }));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ groups }),
      };
    }

    // GET /v1/users/{userId} - Get specific user
    if (method === 'GET' && path.match(/^\/v1\/users\/[^/]+$/)) {
      const userId = event.pathParameters?.userId;
      if (!userId) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'User ID required' }),
        };
      }

      const userResult = await cognitoClient.send(new AdminGetUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: userId,
      }));

      const groupsResult = await cognitoClient.send(new AdminListGroupsForUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: userId,
      }));

      const emailAttr = userResult.UserAttributes?.find(a => a.Name === 'email');
      const nameAttr = userResult.UserAttributes?.find(a => a.Name === 'name');
      const groups = (groupsResult.Groups || []).map(g => g.GroupName!);

      const assignedDevices = await getDevicesAssignedToUser(emailAttr?.Value || '');

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          username: userResult.Username,
          email: emailAttr?.Value || '',
          name: nameAttr?.Value || '',
          status: userResult.UserStatus,
          created_at: userResult.UserCreateDate?.toISOString(),
          groups,
          assigned_devices: assignedDevices,
        }),
      };
    }

    // POST /v1/users - Invite new user
    if (method === 'POST' && path === '/v1/users') {
      let body: {
        email: string;
        name: string;
        group: string;
        device_uids?: string[];
      };

      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Invalid JSON body' }),
        };
      }

      // Validate required fields
      if (!body.email || !body.name || !body.group) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'email, name, and group are required' }),
        };
      }

      // Validate group
      if (!VALID_GROUPS.includes(body.group)) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: `group must be one of: ${VALID_GROUPS.join(', ')}` }),
        };
      }

      // Create user in Cognito
      const createResult = await cognitoClient.send(new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: body.email,
        UserAttributes: [
          { Name: 'email', Value: body.email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'name', Value: body.name },
        ],
        DesiredDeliveryMediums: ['EMAIL'],
      }));

      // Add user to group
      await cognitoClient.send(new AdminAddUserToGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: body.email,
        GroupName: body.group,
      }));

      // Assign device if provided (only one device per user)
      if (body.device_uids && body.device_uids.length > 0) {
        // Only assign the first device (single device per user)
        await assignDeviceToUser(body.device_uids[0], body.email);
      }

      return {
        statusCode: 201,
        headers,
        body: JSON.stringify({
          username: createResult.User?.Username,
          email: body.email,
          name: body.name,
          groups: [body.group],
          assigned_devices: body.device_uids || [],
          status: createResult.User?.UserStatus,
        }),
      };
    }

    // PUT /v1/users/{userId}/groups - Update user groups
    if (method === 'PUT' && path.match(/^\/v1\/users\/[^/]+\/groups$/)) {
      const userId = event.pathParameters?.userId;
      if (!userId) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'User ID required' }),
        };
      }

      let body: { groups: string[] };
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Invalid JSON body' }),
        };
      }

      if (!body.groups || !Array.isArray(body.groups)) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'groups array required' }),
        };
      }

      // Validate all groups
      for (const group of body.groups) {
        if (!VALID_GROUPS.includes(group)) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: `Invalid group: ${group}. Must be one of: ${VALID_GROUPS.join(', ')}` }),
          };
        }
      }

      // Get current groups
      const currentGroupsResult = await cognitoClient.send(new AdminListGroupsForUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: userId,
      }));
      const currentGroups = (currentGroupsResult.Groups || []).map(g => g.GroupName!);

      // Remove from groups no longer in list
      for (const group of currentGroups) {
        if (!body.groups.includes(group)) {
          await cognitoClient.send(new AdminRemoveUserFromGroupCommand({
            UserPoolId: USER_POOL_ID,
            Username: userId,
            GroupName: group,
          }));
        }
      }

      // Add to new groups
      for (const group of body.groups) {
        if (!currentGroups.includes(group)) {
          await cognitoClient.send(new AdminAddUserToGroupCommand({
            UserPoolId: USER_POOL_ID,
            Username: userId,
            GroupName: group,
          }));
        }
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          username: userId,
          groups: body.groups,
        }),
      };
    }

    // PUT /v1/users/{userId}/device - Update user's assigned device (single device per user)
    if (method === 'PUT' && path.match(/^\/v1\/users\/[^/]+\/device$/)) {
      const userId = event.pathParameters?.userId;
      if (!userId) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'User ID required' }),
        };
      }

      let body: { device_uid: string | null };
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Invalid JSON body' }),
        };
      }

      // Get user's email
      const userResult = await cognitoClient.send(new AdminGetUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: userId,
      }));
      const emailAttr = userResult.UserAttributes?.find(a => a.Name === 'email');
      const userEmail = emailAttr?.Value || '';

      if (!userEmail) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'User email not found' }),
        };
      }

      // Get currently assigned device
      const currentDevices = await getDevicesAssignedToUser(userEmail);

      // Unassign current device if any
      if (currentDevices.length > 0) {
        await unassignDevicesFromUser(currentDevices);
      }

      // Assign new device if provided
      if (body.device_uid) {
        await assignDeviceToUser(body.device_uid, userEmail);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          username: userId,
          email: userEmail,
          assigned_device: body.device_uid || null,
        }),
      };
    }

    // GET /v1/devices/unassigned - Get devices not assigned to any user
    if (method === 'GET' && path === '/v1/devices/unassigned') {
      const devices = await getUnassignedDevices();

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ devices }),
      };
    }

    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Not found' }),
    };
  } catch (error) {
    console.error('Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: errorMessage }),
    };
  }
}
