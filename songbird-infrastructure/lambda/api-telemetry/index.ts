/**
 * Telemetry API Lambda
 *
 * Queries DynamoDB for device telemetry data:
 * - GET /devices/{device_uid}/telemetry - Get telemetry history
 * - GET /devices/{device_uid}/location - Get location history
 * - GET /devices/{device_uid}/power - Get Mojo power history
 * - GET /devices/{device_uid}/health - Get health event history
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

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

    const deviceUid = event.pathParameters?.device_uid;
    if (!deviceUid) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'device_uid required' }),
      };
    }

    const queryParams = event.queryStringParameters || {};

    // Parse time range
    const hours = parseInt(queryParams.hours || '24');
    const limit = parseInt(queryParams.limit || '1000');

    if (path.endsWith('/location')) {
      return await getLocationHistory(deviceUid, hours, limit, corsHeaders);
    }

    if (path.endsWith('/power')) {
      return await getPowerHistory(deviceUid, hours, limit, corsHeaders);
    }

    if (path.endsWith('/health')) {
      return await getHealthHistory(deviceUid, hours, limit, corsHeaders);
    }

    return await getTelemetryHistory(deviceUid, hours, limit, corsHeaders);
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};

async function getTelemetryHistory(
  deviceUid: string,
  hours: number,
  limit: number,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);

  // Use the event-type-index GSI to efficiently query by data_type
  // The sort key is formatted as {data_type}#{timestamp}
  const cutoffKey = `telemetry#${cutoffTime}`;
  const endKey = `telemetry#${Date.now() + 1000}`; // Slightly in future to include latest

  // For higher limits, fetch all data in range then apply limit at the end
  // This ensures we get the complete time range, not just the N most recent
  const fetchAll = limit > 1000;

  let allItems: Record<string, any>[] = [];
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
      ScanIndexForward: true, // Chronological order (oldest first)
      ...(fetchAll ? {} : { Limit: limit }),
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
    });

    const result = await docClient.send(command);
    allItems = allItems.concat(result.Items || []);
    lastEvaluatedKey = result.LastEvaluatedKey;

    // Stop if we have enough items or if fetchAll is false
    if (!fetchAll || allItems.length >= limit) break;
  } while (lastEvaluatedKey);

  // Apply limit and reverse to get newest-first order for frontend
  const items = allItems.slice(-limit).reverse();

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
      device_uid: deviceUid,
      hours,
      count: telemetry.length,
      telemetry,
    }),
  };
}

async function getLocationHistory(
  deviceUid: string,
  hours: number,
  limit: number,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);

  // Use the event-type-index GSI to efficiently query telemetry records
  const cutoffKey = `telemetry#${cutoffTime}`;
  const endKey = `telemetry#${Date.now() + 1000}`;

  const command = new QueryCommand({
    TableName: TELEMETRY_TABLE,
    IndexName: 'event-type-index',
    KeyConditionExpression: 'device_uid = :device_uid AND event_type_timestamp BETWEEN :start AND :end',
    FilterExpression: 'attribute_exists(latitude)',
    ExpressionAttributeValues: {
      ':device_uid': deviceUid,
      ':start': cutoffKey,
      ':end': endKey,
    },
    ScanIndexForward: false, // Newest first
    Limit: limit,
  });

  const result = await docClient.send(command);

  // Transform to API response format
  const locations = (result.Items || [])
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
      device_uid: deviceUid,
      hours,
      count: locations.length,
      locations,
    }),
  };
}

async function getPowerHistory(
  deviceUid: string,
  hours: number,
  limit: number,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);

  // Use the event-type-index GSI to efficiently query power records
  const cutoffKey = `power#${cutoffTime}`;
  const endKey = `power#${Date.now() + 1000}`;

  const command = new QueryCommand({
    TableName: TELEMETRY_TABLE,
    IndexName: 'event-type-index',
    KeyConditionExpression: 'device_uid = :device_uid AND event_type_timestamp BETWEEN :start AND :end',
    ExpressionAttributeValues: {
      ':device_uid': deviceUid,
      ':start': cutoffKey,
      ':end': endKey,
    },
    ScanIndexForward: false, // Newest first
    Limit: limit,
  });

  const result = await docClient.send(command);

  // Transform to API response format
  const power = (result.Items || []).map((item) => ({
    time: new Date(item.timestamp).toISOString(),
    voltage: item.mojo_voltage,
    milliamp_hours: item.milliamp_hours,
  }));

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      device_uid: deviceUid,
      hours,
      count: power.length,
      power,
    }),
  };
}

async function getHealthHistory(
  deviceUid: string,
  hours: number,
  limit: number,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);

  // Use the event-type-index GSI to efficiently query health records
  const cutoffKey = `health#${cutoffTime}`;
  const endKey = `health#${Date.now() + 1000}`;

  const command = new QueryCommand({
    TableName: TELEMETRY_TABLE,
    IndexName: 'event-type-index',
    KeyConditionExpression: 'device_uid = :device_uid AND event_type_timestamp BETWEEN :start AND :end',
    ExpressionAttributeValues: {
      ':device_uid': deviceUid,
      ':start': cutoffKey,
      ':end': endKey,
    },
    ScanIndexForward: false, // Newest first
    Limit: limit,
  });

  const result = await docClient.send(command);

  // Transform to API response format
  const health = (result.Items || []).map((item) => ({
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
      device_uid: deviceUid,
      hours,
      count: health.length,
      health,
    }),
  };
}
