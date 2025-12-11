/**
 * Devices API Lambda
 *
 * Handles device CRUD operations:
 * - GET /devices - List all devices
 * - GET /devices/{device_uid} - Get device details
 * - PATCH /devices/{device_uid} - Update device metadata
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  QueryCommand,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const DEVICES_TABLE = process.env.DEVICES_TABLE!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Request:', JSON.stringify(event));

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,PATCH,OPTIONS',
  };

  try {
    const method = event.httpMethod;
    const deviceUid = event.pathParameters?.device_uid;

    if (method === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    if (method === 'GET' && !deviceUid) {
      // List devices
      return await listDevices(event, corsHeaders);
    }

    if (method === 'GET' && deviceUid) {
      // Get single device
      return await getDevice(deviceUid, corsHeaders);
    }

    if (method === 'PATCH' && deviceUid) {
      // Update device
      return await updateDevice(deviceUid, event.body, corsHeaders);
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

async function listDevices(
  event: APIGatewayProxyEvent,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const queryParams = event.queryStringParameters || {};
  const fleet = queryParams.fleet;
  const status = queryParams.status;
  const limit = parseInt(queryParams.limit || '100');

  let items: any[] = [];

  if (fleet) {
    // Query by fleet using GSI
    const command = new QueryCommand({
      TableName: DEVICES_TABLE,
      IndexName: 'fleet-index',
      KeyConditionExpression: '#fleet = :fleet',
      ExpressionAttributeNames: { '#fleet': 'fleet' },
      ExpressionAttributeValues: { ':fleet': fleet },
      Limit: limit,
      ScanIndexForward: false, // Most recent first
    });

    const result = await docClient.send(command);
    items = result.Items || [];
  } else if (status) {
    // Query by status using GSI
    const command = new QueryCommand({
      TableName: DEVICES_TABLE,
      IndexName: 'status-index',
      KeyConditionExpression: '#status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status },
      Limit: limit,
      ScanIndexForward: false,
    });

    const result = await docClient.send(command);
    items = result.Items || [];
  } else {
    // Scan all devices (for small fleets)
    const command = new ScanCommand({
      TableName: DEVICES_TABLE,
      Limit: limit,
    });

    const result = await docClient.send(command);
    items = result.Items || [];
  }

  // Calculate fleet stats
  const stats = calculateStats(items);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      devices: items,
      count: items.length,
      stats,
    }),
  };
}

async function getDevice(
  deviceUid: string,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const command = new GetCommand({
    TableName: DEVICES_TABLE,
    Key: { device_uid: deviceUid },
  });

  const result = await docClient.send(command);

  if (!result.Item) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Device not found' }),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(result.Item),
  };
}

async function updateDevice(
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

  const updates = JSON.parse(body);

  // Only allow certain fields to be updated
  const allowedFields = ['serial_number', 'assigned_to', 'fleet', 'notes'];
  const updateExpressions: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, any> = {};

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      const attrName = `#${key}`;
      const attrValue = `:${key}`;
      updateExpressions.push(`${attrName} = ${attrValue}`);
      expressionAttributeNames[attrName] = key;
      expressionAttributeValues[attrValue] = value;
    }
  }

  if (updateExpressions.length === 0) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'No valid fields to update' }),
    };
  }

  // Always update updated_at
  updateExpressions.push('#updated_at = :updated_at');
  expressionAttributeNames['#updated_at'] = 'updated_at';
  expressionAttributeValues[':updated_at'] = Date.now();

  const command = new UpdateCommand({
    TableName: DEVICES_TABLE,
    Key: { device_uid: deviceUid },
    UpdateExpression: 'SET ' + updateExpressions.join(', '),
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'ALL_NEW',
  });

  const result = await docClient.send(command);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(result.Attributes),
  };
}

function calculateStats(devices: any[]): Record<string, any> {
  const stats = {
    total: devices.length,
    online: 0,
    offline: 0,
    alert: 0,
    low_battery: 0,
    fleets: {} as Record<string, number>,
  };

  const now = Date.now();
  const offlineThreshold = 15 * 60 * 1000; // 15 minutes

  for (const device of devices) {
    // Status counts
    if (device.status === 'alert') {
      stats.alert++;
    } else if (device.last_seen && now - device.last_seen < offlineThreshold) {
      stats.online++;
    } else {
      stats.offline++;
    }

    // Low battery check
    if (device.last_telemetry?.voltage && device.last_telemetry.voltage < 3.4) {
      stats.low_battery++;
    }

    // Fleet counts
    const fleet = device.fleet || 'default';
    stats.fleets[fleet] = (stats.fleets[fleet] || 0) + 1;
  }

  return stats;
}
