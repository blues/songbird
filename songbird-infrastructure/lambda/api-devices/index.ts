/**
 * Devices API Lambda
 *
 * Handles device CRUD operations:
 * - GET /devices - List all devices
 * - GET /devices/{serial_number} - Get device details
 * - PATCH /devices/{serial_number} - Update device metadata
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  QueryCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { resolveDevice, getAliasBySerial } from '../shared/device-lookup';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const DEVICES_TABLE = process.env.DEVICES_TABLE!;
const DEVICE_ALIASES_TABLE = process.env.DEVICE_ALIASES_TABLE || 'songbird-device-aliases';
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE || 'songbird-activity';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Request:', JSON.stringify(event));

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  };

  try {
    // HTTP API v2 uses requestContext.http.method, REST API v1 uses httpMethod
    const method = (event.requestContext as any)?.http?.method || event.httpMethod;
    const serialNumber = event.pathParameters?.serial_number;
    const path = (event as any).rawPath || event.path || '';

    if (method === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    // POST /devices/merge - Merge two devices (Admin only)
    if (method === 'POST' && path.endsWith('/merge')) {
      return await mergeDevices(event, corsHeaders);
    }

    if (method === 'GET' && !serialNumber) {
      // List devices
      return await listDevices(event, corsHeaders);
    }

    if (method === 'GET' && serialNumber) {
      // Get single device by serial number
      return await getDeviceBySerial(serialNumber, corsHeaders);
    }

    if (method === 'PATCH' && serialNumber) {
      // Update device by serial number
      return await updateDeviceBySerial(serialNumber, event.body, corsHeaders);
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

async function getDeviceBySerial(
  serialNumber: string,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  // Resolve serial_number to device info
  const resolved = await resolveDevice(serialNumber);

  if (!resolved) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Device not found' }),
    };
  }

  // Get the device using the current device_uid
  const command = new GetCommand({
    TableName: DEVICES_TABLE,
    Key: { device_uid: resolved.device_uid },
  });

  const result = await docClient.send(command);

  if (!result.Item) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Device not found' }),
    };
  }

  // Transform and add device_uid history
  const device = transformDevice(result.Item);
  device.device_uid_history = resolved.all_device_uids.length > 1
    ? resolved.all_device_uids.slice(1) // Exclude current device_uid
    : undefined;

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(device),
  };
}

async function updateDeviceBySerial(
  serialNumber: string,
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

  // Resolve serial_number to device_uid
  const resolved = await resolveDevice(serialNumber);

  if (!resolved) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Device not found' }),
    };
  }

  const updates = JSON.parse(body);

  // Only allow certain fields to be updated (removed serial_number - it's now immutable)
  const allowedFields = ['name', 'assigned_to', 'assigned_to_name', 'fleet', 'notes'];
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
    Key: { device_uid: resolved.device_uid },
    UpdateExpression: 'SET ' + updateExpressions.join(', '),
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'ALL_NEW',
  });

  const result = await docClient.send(command);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(transformDevice(result.Attributes)),
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
    demo_locked: item.demo_locked || false,
    usb_powered: item.usb_powered || false,
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
    // Note: voltage no longer comes from last_telemetry; it's set from _log.qo/_health.qo
    device.motion = item.last_telemetry.motion;
  }

  // Voltage comes from device.voltage field (set from _log.qo or _health.qo events)
  if (item.voltage !== undefined) {
    device.voltage = item.voltage;
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

    // Low battery check (voltage comes from _log.qo/_health.qo, stored in device.voltage)
    if (device.voltage && device.voltage < 3.4) {
      stats.low_battery++;
    }

    // Fleet counts
    const fleet = device.fleet || 'default';
    stats.fleets[fleet] = (stats.fleets[fleet] || 0) + 1;
  }

  return stats;
}

/**
 * Merge two devices into one (Admin only)
 * The source device's device_uid is added to the target's alias history,
 * and the source device record is deleted.
 */
async function mergeDevices(
  event: APIGatewayProxyEvent,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  // Check for admin authorization
  const claims = (event.requestContext as any)?.authorizer?.jwt?.claims || {};
  const groups = claims['cognito:groups'] || '';
  const isAdmin = groups.includes('Admin');

  if (!isAdmin) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({ error: 'Admin access required to merge devices' }),
    };
  }

  if (!event.body) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Request body required' }),
    };
  }

  const { source_serial_number, target_serial_number } = JSON.parse(event.body);

  if (!source_serial_number || !target_serial_number) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Both source_serial_number and target_serial_number are required' }),
    };
  }

  if (source_serial_number === target_serial_number) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Source and target cannot be the same device' }),
    };
  }

  // Get both devices
  const sourceAlias = await getAliasBySerial(source_serial_number);
  const targetAlias = await getAliasBySerial(target_serial_number);

  if (!sourceAlias) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: `Source device not found: ${source_serial_number}` }),
    };
  }

  if (!targetAlias) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: `Target device not found: ${target_serial_number}` }),
    };
  }

  const sourceDeviceUid = sourceAlias.device_uid;
  const targetDeviceUid = targetAlias.device_uid;
  const sourcePreviousUids = sourceAlias.previous_device_uids || [];
  const targetPreviousUids = targetAlias.previous_device_uids || [];

  // Merge all device_uids: target's previous + source's current + source's previous
  const allPreviousUids = [
    ...new Set([
      ...targetPreviousUids,
      sourceDeviceUid,
      ...sourcePreviousUids,
    ]),
  ];

  // Update target alias to include source device_uids
  await docClient.send(new PutCommand({
    TableName: DEVICE_ALIASES_TABLE,
    Item: {
      serial_number: target_serial_number,
      device_uid: targetDeviceUid,
      previous_device_uids: allPreviousUids,
      created_at: targetAlias.created_at,
      updated_at: Date.now(),
    },
  }));

  // Delete source alias
  await docClient.send(new DeleteCommand({
    TableName: DEVICE_ALIASES_TABLE,
    Key: { serial_number: source_serial_number },
  }));

  // Delete source device record
  await docClient.send(new DeleteCommand({
    TableName: DEVICES_TABLE,
    Key: { device_uid: sourceDeviceUid },
  }));

  // Create activity feed event
  const activityEvent = {
    event_id: `merge-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    device_uid: targetDeviceUid,
    serial_number: target_serial_number,
    event_type: 'device_merged',
    timestamp: Date.now(),
    data: {
      source_serial_number,
      source_device_uid: sourceDeviceUid,
      target_serial_number,
      target_device_uid: targetDeviceUid,
      merged_device_uids: allPreviousUids,
    },
  };

  try {
    await docClient.send(new PutCommand({
      TableName: ACTIVITY_TABLE,
      Item: activityEvent,
    }));
  } catch (err) {
    // Activity logging is non-critical, log but don't fail
    console.error('Failed to log merge activity:', err);
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      message: 'Devices merged successfully',
      target_serial_number,
      target_device_uid: targetDeviceUid,
      merged_device_uids: [targetDeviceUid, ...allPreviousUids],
      deleted_serial_number: source_serial_number,
      deleted_device_uid: sourceDeviceUid,
    }),
  };
}
