/**
 * Telemetry API Lambda
 *
 * Queries DynamoDB for device telemetry data:
 * - GET /devices/{serial_number}/telemetry - Get telemetry history
 * - GET /devices/{serial_number}/location - Get location history
 * - GET /devices/{serial_number}/power - Get Mojo power history
 * - GET /devices/{serial_number}/health - Get health event history
 *
 * Note: When a Notecard is swapped, historical data is merged from all device_uids
 * associated with the serial_number.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { resolveDevice } from '../shared/device-lookup';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const TELEMETRY_TABLE = process.env.TELEMETRY_TABLE!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Request:', JSON.stringify(event));

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
  };

  try {
    // HTTP API v2 uses requestContext.http.method, REST API v1 uses httpMethod
    const method = (event.requestContext as any)?.http?.method || event.httpMethod;
    const path = (event.requestContext as any)?.http?.path || event.path;

    if (method === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    const serialNumber = event.pathParameters?.serial_number;
    if (!serialNumber) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'serial_number required' }),
      };
    }

    // Resolve serial_number to all associated device_uids
    const resolved = await resolveDevice(serialNumber);
    if (!resolved) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Device not found' }),
      };
    }

    const queryParams = event.queryStringParameters || {};

    // Parse time range
    const hours = parseInt(queryParams.hours || '24');
    const limit = parseInt(queryParams.limit || '1000');

    // All queries now use all_device_uids to get merged history
    if (path.endsWith('/location')) {
      return await getLocationHistory(resolved.serial_number, resolved.all_device_uids, hours, limit, corsHeaders);
    }

    if (path.endsWith('/power')) {
      return await getPowerHistory(resolved.serial_number, resolved.all_device_uids, hours, limit, corsHeaders);
    }

    if (path.endsWith('/health')) {
      return await getHealthHistory(resolved.serial_number, resolved.all_device_uids, hours, limit, corsHeaders);
    }

    return await getTelemetryHistory(resolved.serial_number, resolved.all_device_uids, hours, limit, corsHeaders);
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};

/**
 * Query telemetry for multiple device_uids and merge results
 */
async function queryForAllDeviceUids(
  deviceUids: string[],
  dataType: string,
  cutoffTime: number,
  limit: number
): Promise<Record<string, any>[]> {
  const cutoffKey = `${dataType}#${cutoffTime}`;
  const endKey = `${dataType}#${Date.now() + 1000}`;
  const fetchAll = limit > 1000;

  // Query all device_uids in parallel
  const queryPromises = deviceUids.map(async (deviceUid) => {
    let items: Record<string, any>[] = [];
    let lastEvaluatedKey: Record<string, any> | undefined;

    do {
      const command = new QueryCommand({
        TableName: TELEMETRY_TABLE,
        IndexName: 'event-type-index',
        KeyConditionExpression: 'device_uid = :device_uid AND event_type_timestamp BETWEEN :start AND :end',
        ExpressionAttributeValues: {
          ':device_uid': deviceUid,
          ':start': cutoffKey,
          ':end': endKey,
        },
        ScanIndexForward: true,
        ...(fetchAll ? {} : { Limit: limit }),
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      });

      const result = await docClient.send(command);
      items = items.concat(result.Items || []);
      lastEvaluatedKey = result.LastEvaluatedKey;

      if (!fetchAll || items.length >= limit) break;
    } while (lastEvaluatedKey);

    return items;
  });

  const allResults = await Promise.all(queryPromises);

  // Merge all results and sort by timestamp
  const merged = allResults.flat().sort((a, b) => a.timestamp - b.timestamp);

  // Apply limit and reverse for newest-first
  return merged.slice(-limit).reverse();
}

async function getTelemetryHistory(
  serialNumber: string,
  deviceUids: string[],
  hours: number,
  limit: number,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);

  const items = await queryForAllDeviceUids(deviceUids, 'telemetry', cutoffTime, limit);

  // Transform to API response format
  // Note: voltage is no longer included in track.qo telemetry; battery info comes from power API
  const telemetry = items.map((item) => ({
    time: new Date(item.timestamp).toISOString(),
    temperature: item.temperature,
    humidity: item.humidity,
    pressure: item.pressure,
    motion: item.motion,
  }));

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      serial_number: serialNumber,
      hours,
      count: telemetry.length,
      telemetry,
    }),
  };
}

async function getLocationHistory(
  serialNumber: string,
  deviceUids: string[],
  hours: number,
  limit: number,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);

  const items = await queryForAllDeviceUids(deviceUids, 'telemetry', cutoffTime, limit);

  // Transform to API response format - filter to only items with location
  const locations = items
    .filter((item) => item.latitude !== undefined && item.longitude !== undefined)
    .map((item) => ({
      time: new Date(item.timestamp).toISOString(),
      lat: item.latitude,
      lon: item.longitude,
      source: item.location_source,
    }));

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      serial_number: serialNumber,
      hours,
      count: locations.length,
      locations,
    }),
  };
}

async function getPowerHistory(
  serialNumber: string,
  deviceUids: string[],
  hours: number,
  limit: number,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);

  const items = await queryForAllDeviceUids(deviceUids, 'power', cutoffTime, limit);

  // Transform to API response format
  const power = items.map((item) => ({
    time: new Date(item.timestamp).toISOString(),
    voltage: item.mojo_voltage,
    milliamp_hours: item.milliamp_hours,
  }));

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      serial_number: serialNumber,
      hours,
      count: power.length,
      power,
    }),
  };
}

async function getHealthHistory(
  serialNumber: string,
  deviceUids: string[],
  hours: number,
  limit: number,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);

  const items = await queryForAllDeviceUids(deviceUids, 'health', cutoffTime, limit);

  // Transform to API response format
  const health = items.map((item) => ({
    time: new Date(item.timestamp).toISOString(),
    method: item.method,
    text: item.text,
    voltage: item.voltage,
    voltage_mode: item.voltage_mode,
    milliamp_hours: item.milliamp_hours,
  }));

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      serial_number: serialNumber,
      hours,
      count: health.length,
      health,
    }),
  };
}
