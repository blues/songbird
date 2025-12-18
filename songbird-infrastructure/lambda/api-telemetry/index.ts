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

  const command = new QueryCommand({
    TableName: TELEMETRY_TABLE,
    KeyConditionExpression: 'device_uid = :device_uid AND #ts > :cutoff',
    FilterExpression: 'data_type = :data_type',
    ExpressionAttributeNames: {
      '#ts': 'timestamp',
    },
    ExpressionAttributeValues: {
      ':device_uid': deviceUid,
      ':cutoff': cutoffTime,
      ':data_type': 'telemetry',
    },
    ScanIndexForward: false, // Newest first
    Limit: limit,
  });

  const result = await docClient.send(command);

  // Transform to API response format
  const telemetry = (result.Items || []).map((item) => ({
    time: new Date(item.timestamp).toISOString(),
    temperature: item.temperature,
    humidity: item.humidity,
    pressure: item.pressure,
    voltage: item.voltage,
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

  const command = new QueryCommand({
    TableName: TELEMETRY_TABLE,
    KeyConditionExpression: 'device_uid = :device_uid AND #ts > :cutoff',
    FilterExpression: 'data_type = :data_type AND attribute_exists(latitude)',
    ExpressionAttributeNames: {
      '#ts': 'timestamp',
    },
    ExpressionAttributeValues: {
      ':device_uid': deviceUid,
      ':cutoff': cutoffTime,
      ':data_type': 'telemetry',
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

  const command = new QueryCommand({
    TableName: TELEMETRY_TABLE,
    KeyConditionExpression: 'device_uid = :device_uid AND #ts > :cutoff',
    FilterExpression: 'data_type = :data_type',
    ExpressionAttributeNames: {
      '#ts': 'timestamp',
    },
    ExpressionAttributeValues: {
      ':device_uid': deviceUid,
      ':cutoff': cutoffTime,
      ':data_type': 'power',
    },
    ScanIndexForward: false, // Newest first
    Limit: limit,
  });

  const result = await docClient.send(command);

  // Transform to API response format
  const power = (result.Items || []).map((item) => ({
    time: new Date(item.timestamp).toISOString(),
    voltage: item.mojo_voltage,
    temperature: item.mojo_temperature,
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

  const command = new QueryCommand({
    TableName: TELEMETRY_TABLE,
    KeyConditionExpression: 'device_uid = :device_uid AND #ts > :cutoff',
    FilterExpression: 'data_type = :data_type',
    ExpressionAttributeNames: {
      '#ts': 'timestamp',
    },
    ExpressionAttributeValues: {
      ':device_uid': deviceUid,
      ':cutoff': cutoffTime,
      ':data_type': 'health',
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
