/**
 * Commands API Lambda
 *
 * Sends commands to devices via Notehub API:
 * - GET /v1/commands - Get all commands across devices
 * - DELETE /v1/commands/{command_id} - Delete a command
 * - POST /devices/{serial_number}/commands - Send command to device (routes to current Notecard)
 * - GET /devices/{serial_number}/commands - Get command history for a device (merged from all Notecards)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
  DeleteCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { resolveDevice } from '../shared/device-lookup';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const secretsClient = new SecretsManagerClient({});

const COMMANDS_TABLE = process.env.COMMANDS_TABLE!;
const NOTEHUB_PROJECT_UID = process.env.NOTEHUB_PROJECT_UID!;
const NOTEHUB_SECRET_ARN = process.env.NOTEHUB_SECRET_ARN!;

// Cache the token to avoid fetching on every request
let cachedToken: string | null = null;

async function getNotehubToken(): Promise<string> {
  if (cachedToken) {
    return cachedToken;
  }

  const command = new GetSecretValueCommand({ SecretId: NOTEHUB_SECRET_ARN });
  const response = await secretsClient.send(command);

  if (!response.SecretString) {
    throw new Error('Notehub API token not found in secret');
  }

  const secret = JSON.parse(response.SecretString);
  cachedToken = secret.token;

  if (!cachedToken) {
    throw new Error('Token field not found in secret');
  }

  return cachedToken;
}

// Supported commands
const VALID_COMMANDS = ['ping', 'locate', 'play_melody', 'test_audio', 'set_volume', 'unlock'];

// Commands that require admin or device owner permissions
const RESTRICTED_COMMANDS = ['unlock'];

const DEVICES_TABLE = process.env.DEVICES_TABLE!;

/**
 * Check if the user is an admin (in 'Admin' Cognito group)
 */
function isAdmin(event: APIGatewayProxyEvent): boolean {
  try {
    const claims = (event.requestContext as any)?.authorizer?.jwt?.claims;
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

/**
 * Get the user's email from the JWT claims
 */
function getUserEmail(event: APIGatewayProxyEvent): string | undefined {
  try {
    const claims = (event.requestContext as any)?.authorizer?.jwt?.claims;
    return claims?.email;
  } catch {
    return undefined;
  }
}

/**
 * Check if the user owns the device (is assigned to it)
 */
async function isDeviceOwner(deviceUid: string, userEmail: string): Promise<boolean> {
  const command = new GetCommand({
    TableName: DEVICES_TABLE,
    Key: { device_uid: deviceUid },
    ProjectionExpression: 'assigned_to',
  });

  const result = await docClient.send(command);
  return result.Item?.assigned_to === userEmail;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Request:', JSON.stringify(event));

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  };

  try {
    // HTTP API v2 uses requestContext.http.method, REST API v1 uses httpMethod
    const method = (event.requestContext as any)?.http?.method || event.httpMethod;
    const path = (event.requestContext as any)?.http?.path || event.path;

    if (method === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    // Handle /v1/commands endpoint (all commands across devices)
    if (path === '/v1/commands' && method === 'GET') {
      const deviceUid = event.queryStringParameters?.device_uid;
      return await getAllCommands(deviceUid, corsHeaders);
    }

    // Handle DELETE /v1/commands/{command_id}
    const commandId = event.pathParameters?.command_id;
    if (commandId && method === 'DELETE') {
      const deviceUid = event.queryStringParameters?.device_uid;
      if (!deviceUid) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'device_uid query parameter required' }),
        };
      }
      return await deleteCommand(deviceUid, commandId, corsHeaders);
    }

    // Handle device-specific commands endpoints
    const serialNumber = event.pathParameters?.serial_number;
    if (!serialNumber) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'serial_number required' }),
      };
    }

    // Resolve serial_number to device info
    const resolved = await resolveDevice(serialNumber);
    if (!resolved) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Device not found' }),
      };
    }

    if (method === 'POST') {
      // Send command to the CURRENT device_uid (the active Notecard)
      return await sendCommand(resolved.device_uid, resolved.serial_number, event, corsHeaders);
    }

    if (method === 'GET') {
      // Get command history from ALL device_uids (merged across Notecard swaps)
      return await getCommandHistory(resolved.serial_number, resolved.all_device_uids, corsHeaders);
    }

    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};

async function sendCommand(
  deviceUid: string,
  serialNumber: string,
  event: APIGatewayProxyEvent,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  if (!event.body) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Request body required' }),
    };
  }

  const request = JSON.parse(event.body);
  const { cmd, params } = request;

  // Validate command
  if (!cmd || !VALID_COMMANDS.includes(cmd)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: 'Invalid command',
        valid_commands: VALID_COMMANDS,
      }),
    };
  }

  // Check authorization for restricted commands
  if (RESTRICTED_COMMANDS.includes(cmd)) {
    const admin = isAdmin(event);
    const userEmail = getUserEmail(event);
    const owner = userEmail ? await isDeviceOwner(deviceUid, userEmail) : false;

    if (!admin && !owner) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: 'Unauthorized: Only admins and device owners can send this command',
        }),
      };
    }
  }

  // Generate command ID
  const commandId = `cmd_${randomUUID().replace(/-/g, '').substring(0, 12)}`;
  const now = Date.now();

  // Build command note body
  const noteBody = {
    cmd,
    params: params || {},
    command_id: commandId,
    sent_at: now,
  };

  // Send to Notehub API (using the current device_uid for the active Notecard)
  try {
    const notehubToken = await getNotehubToken();
    const notehubResponse = await fetch(
      `https://api.notefile.net/v1/projects/${NOTEHUB_PROJECT_UID}/devices/${deviceUid}/notes/command.qi`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${notehubToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: noteBody }),
      }
    );

    if (!notehubResponse.ok) {
      const errorText = await notehubResponse.text();
      console.error('Notehub API error:', errorText);

      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: 'Failed to send command to Notehub',
          details: errorText,
        }),
      };
    }

    // Store command in history (include serial_number for reference)
    await storeCommand(deviceUid, serialNumber, commandId, cmd, params, now);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        command_id: commandId,
        serial_number: serialNumber,
        device_uid: deviceUid,
        cmd,
        params: params || {},
        status: 'queued',
        queued_at: new Date(now).toISOString(),
      }),
    };
  } catch (error) {
    console.error('Error sending command to Notehub:', error);

    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: 'Failed to communicate with Notehub',
      }),
    };
  }
}

async function storeCommand(
  deviceUid: string,
  serialNumber: string,
  commandId: string,
  cmd: string,
  params: any,
  timestamp: number
): Promise<void> {
  const command = new PutCommand({
    TableName: COMMANDS_TABLE,
    Item: {
      device_uid: deviceUid,
      serial_number: serialNumber,
      command_id: commandId,
      cmd,
      params: params || {},
      status: 'queued',
      created_at: timestamp,
      updated_at: timestamp,
      ttl: Math.floor(timestamp / 1000) + 30 * 24 * 60 * 60, // 30 days TTL
    },
  });

  await docClient.send(command);
}

async function getCommandHistory(
  serialNumber: string,
  deviceUids: string[],
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  // Query all device_uids in parallel to get merged command history
  const queryPromises = deviceUids.map(async (deviceUid) => {
    const command = new QueryCommand({
      TableName: COMMANDS_TABLE,
      IndexName: 'device-created-index',
      KeyConditionExpression: 'device_uid = :device_uid',
      ExpressionAttributeValues: {
        ':device_uid': deviceUid,
      },
      ScanIndexForward: false,
      Limit: 50,
    });

    const result = await docClient.send(command);
    return result.Items || [];
  });

  const allResults = await Promise.all(queryPromises);

  // Merge and sort by created_at (most recent first)
  const mergedCommands = allResults
    .flat()
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 50); // Limit to 50 total

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      serial_number: serialNumber,
      commands: mergedCommands,
    }),
  };
}

async function getAllCommands(
  deviceUid: string | undefined,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  // If device_uid is provided, use the existing query
  if (deviceUid) {
    const command = new QueryCommand({
      TableName: COMMANDS_TABLE,
      IndexName: 'device-created-index',
      KeyConditionExpression: 'device_uid = :device_uid',
      ExpressionAttributeValues: {
        ':device_uid': deviceUid,
      },
      ScanIndexForward: false,
      Limit: 100,
    });

    const result = await docClient.send(command);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        commands: result.Items || [],
        total: result.Items?.length || 0,
      }),
    };
  }

  // Otherwise, scan for all commands (limited to 100 most recent)
  const command = new ScanCommand({
    TableName: COMMANDS_TABLE,
    Limit: 200, // Fetch more to allow sorting
  });

  const result = await docClient.send(command);

  // Sort by created_at descending and take the first 100
  const sortedCommands = (result.Items || [])
    .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
      ((b.created_at as number) || 0) - ((a.created_at as number) || 0))
    .slice(0, 100);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      commands: sortedCommands,
      total: sortedCommands.length,
    }),
  };
}

async function deleteCommand(
  deviceUid: string,
  commandId: string,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  // First verify the command exists
  const getCmd = new GetCommand({
    TableName: COMMANDS_TABLE,
    Key: {
      device_uid: deviceUid,
      command_id: commandId,
    },
  });

  const existing = await docClient.send(getCmd);
  if (!existing.Item) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Command not found' }),
    };
  }

  // Delete the command
  const deleteCmd = new DeleteCommand({
    TableName: COMMANDS_TABLE,
    Key: {
      device_uid: deviceUid,
      command_id: commandId,
    },
  });

  await docClient.send(deleteCmd);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      message: 'Command deleted',
      command_id: commandId,
    }),
  };
}
