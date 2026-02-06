/**
 * Public Device API Lambda
 *
 * Provides unauthenticated read-only access to device information.
 * All requests are audit logged.
 *
 * Endpoints:
 * - GET /public/devices/{serial_number} - Get device details (no auth required)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { resolveDevice } from '../shared/device-lookup';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const DEVICES_TABLE = process.env.DEVICES_TABLE!;
const TELEMETRY_TABLE = process.env.TELEMETRY_TABLE!;
const AUDIT_TABLE = process.env.AUDIT_TABLE!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Public device request:', JSON.stringify(event));

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
  };

  try {
    const method = (event.requestContext as any)?.http?.method || event.httpMethod;
    const serialNumber = event.pathParameters?.serial_number;

    if (method === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    if (method !== 'GET') {
      return {
        statusCode: 405,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    if (!serialNumber) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Serial number required' }),
      };
    }

    // Get device data
    const result = await getPublicDevice(serialNumber, corsHeaders);

    // Audit log the access (fire and forget - don't block response)
    await logPublicAccess(event, serialNumber, result.statusCode === 200);

    return result;
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};

async function getPublicDevice(
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

  // Get recent telemetry for the device
  const telemetry = await getRecentTelemetry(resolved.device_uid);

  // Transform device data
  const device = transformDevice(result.Item);
  device.recent_telemetry = telemetry;

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(device),
  };
}

async function getRecentTelemetry(deviceUid: string): Promise<any[]> {
  try {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

    const command = new QueryCommand({
      TableName: TELEMETRY_TABLE,
      KeyConditionExpression: 'device_uid = :uid AND #ts >= :start',
      ExpressionAttributeNames: { '#ts': 'timestamp' },
      ExpressionAttributeValues: {
        ':uid': deviceUid,
        ':start': oneDayAgo,
      },
      ScanIndexForward: false, // Most recent first
      Limit: 100,
    });

    const result = await docClient.send(command);
    return (result.Items || []).map((item: any) => ({
      timestamp: new Date(item.timestamp).toISOString(),
      temperature: item.temp,
      humidity: item.humidity,
      pressure: item.pressure,
      voltage: item.voltage,
    }));
  } catch (error) {
    console.error('Error fetching telemetry:', error);
    return [];
  }
}

/**
 * Transform DynamoDB device record to public frontend format
 */
function transformDevice(item: any): any {
  const device: any = {
    device_uid: item.device_uid,
    serial_number: item.serial_number,
    name: item.name,
    fleet: item.fleet,
    status: item.status,
    last_seen: item.last_seen ? new Date(item.last_seen).toISOString() : undefined,
    mode: item.current_mode,
    pending_mode: item.pending_mode || null,
    transit_locked: item.transit_locked || false,
    demo_locked: item.demo_locked || false,
    usb_powered: item.usb_powered || false,
  };

  // Flatten last_location
  if (item.last_location) {
    device.latitude = item.last_location.lat;
    device.longitude = item.last_location.lon;
    if (item.last_location.time) {
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
    device.motion = item.last_telemetry.motion;
  }

  // Voltage from device record
  if (item.voltage !== undefined) {
    device.voltage = item.voltage;
  }

  // Firmware versions
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

/**
 * Log public device access for audit purposes
 */
async function logPublicAccess(
  event: APIGatewayProxyEvent,
  serialNumber: string,
  success: boolean
): Promise<void> {
  try {
    const sourceIp = event.requestContext?.identity?.sourceIp ||
      (event.requestContext as any)?.http?.sourceIp ||
      'unknown';
    const userAgent = event.headers?.['User-Agent'] ||
      event.headers?.['user-agent'] ||
      'unknown';

    const auditRecord = {
      audit_id: `public-device-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      action: 'public_device_view',
      serial_number: serialNumber,
      timestamp: Date.now(),
      result: success ? 'success' : 'not_found',
      source_ip: sourceIp,
      user_agent: userAgent,
      ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60, // 90 day TTL
    };

    await docClient.send(new PutCommand({
      TableName: AUDIT_TABLE,
      Item: auditRecord,
    }));

    console.log(`Audit: public_device_view - ${success ? 'success' : 'not_found'} for ${serialNumber} from ${sourceIp}`);
  } catch (error) {
    // Audit logging is non-critical, log but don't fail the request
    console.error('Failed to write audit log:', error);
  }
}
