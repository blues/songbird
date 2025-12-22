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
    // HTTP API v2 uses requestContext.http.method, REST API v1 uses httpMethod
    const method = (event.requestContext as any)?.http?.method || event.httpMethod;
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

  // Transform and calculate fleet stats
  const transformedDevices = items.map(transformDevice);
  const stats = calculateStats(items);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      devices: transformedDevices,
      count: transformedDevices.length,
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
    body: JSON.stringify(transformDevice(result.Item)),
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

/**
 * Transform DynamoDB device record to frontend format
 * Flattens nested objects like last_location and last_telemetry
 */
function transformDevice(item: any): any {
  const device: any = {
    device_uid: item.device_uid,
    serial_number: item.serial_number,
    name: item.name,
    fleet: item.fleet,
    status: item.status,
    // Convert millisecond timestamp to ISO string for frontend
    last_seen: item.last_seen ? new Date(item.last_seen).toISOString() : undefined,
    mode: item.current_mode,
    transit_locked: item.transit_locked || false,
    created_at: item.created_at ? new Date(item.created_at).toISOString() : undefined,
    updated_at: item.updated_at ? new Date(item.updated_at).toISOString() : undefined,
    assigned_to: item.assigned_to,
    assigned_to_name: item.assigned_to_name,
  };

  // Flatten last_location
  if (item.last_location) {
    device.latitude = item.last_location.lat;
    device.longitude = item.last_location.lon;
    // Convert Unix timestamp (seconds) to ISO string for frontend
    if (item.last_location.time) {
      // Notehub timestamps are in seconds, convert to milliseconds for Date
      const timeMs = item.last_location.time * 1000;
      device.location_time = new Date(timeMs).toISOString();
    }
    device.location_source = item.last_location.source;
    device.location_name = item.last_location.name;
  }

  // Flatten last_telemetry
  if (item.last_telemetry) {
    device.temperature = item.last_telemetry.temp;
    device.humidity = item.last_telemetry.humidity;
    device.pressure = item.last_telemetry.pressure;
    device.voltage = item.last_telemetry.voltage;
    device.motion = item.last_telemetry.motion;
  }

  // Flatten last_power (Mojo data)
  if (item.last_power) {
    device.mojo_voltage = item.last_power.voltage;
    device.mojo_temperature = item.last_power.temperature;
    device.milliamp_hours = item.last_power.milliamp_hours;
  }

  // Firmware versions (from _session.qo events)
  if (item.firmware_version) {
    device.firmware_version = item.firmware_version;
  }
  if (item.notecard_version) {
    device.notecard_version = item.notecard_version;
  }
  if (item.notecard_sku) {
    device.notecard_sku = item.notecard_sku;
  }

  return device;
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
