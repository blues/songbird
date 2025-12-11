/**
 * Commands API Lambda
 *
 * Sends commands to devices via Notehub API:
 * - POST /devices/{device_uid}/commands - Send command to device
 * - GET /devices/{device_uid}/commands - Get command history
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomUUID } from 'crypto';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const COMMANDS_TABLE = process.env.COMMANDS_TABLE!;
const NOTEHUB_PROJECT_UID = process.env.NOTEHUB_PROJECT_UID!;
const NOTEHUB_API_TOKEN = process.env.NOTEHUB_API_TOKEN!;

// Supported commands
const VALID_COMMANDS = ['ping', 'locate', 'play_melody', 'test_audio', 'set_volume'];

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Request:', JSON.stringify(event));

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };

  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    const deviceUid = event.pathParameters?.device_uid;
    if (!deviceUid) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'device_uid required' }),
      };
    }

    if (event.httpMethod === 'POST') {
      return await sendCommand(deviceUid, event.body, corsHeaders);
    }

    if (event.httpMethod === 'GET') {
      return await getCommandHistory(deviceUid, corsHeaders);
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
  body: string | null,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  if (!body) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Request body required' }),
    };
  }

  const request = JSON.parse(body);
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

  // Send to Notehub API
  try {
    const notehubResponse = await fetch(
      `https://api.notefile.net/v1/projects/${NOTEHUB_PROJECT_UID}/devices/${deviceUid}/notes/command.qi`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTEHUB_API_TOKEN}`,
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

    // Store command in history
    await storeCommand(deviceUid, commandId, cmd, params, now);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        command_id: commandId,
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
  commandId: string,
  cmd: string,
  params: any,
  timestamp: number
): Promise<void> {
  const command = new PutCommand({
    TableName: COMMANDS_TABLE,
    Item: {
      device_uid: deviceUid,
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
  deviceUid: string,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const command = new QueryCommand({
    TableName: COMMANDS_TABLE,
    KeyConditionExpression: 'device_uid = :device_uid',
    ExpressionAttributeValues: {
      ':device_uid': deviceUid,
    },
    ScanIndexForward: false, // Most recent first
    Limit: 50,
  });

  const result = await docClient.send(command);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      device_uid: deviceUid,
      commands: result.Items || [],
    }),
  };
}
