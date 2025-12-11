/**
 * Telemetry API Lambda
 *
 * Queries Timestream for device telemetry data:
 * - GET /devices/{device_uid}/telemetry - Get telemetry history
 * - GET /devices/{device_uid}/location - Get location history
 */

import {
  TimestreamQueryClient,
  QueryCommand,
} from '@aws-sdk/client-timestream-query';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const timestreamClient = new TimestreamQueryClient({});

const TIMESTREAM_DATABASE = process.env.TIMESTREAM_DATABASE!;
const TIMESTREAM_TABLE = process.env.TIMESTREAM_TABLE!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Request:', JSON.stringify(event));

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
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

    const path = event.path;
    const queryParams = event.queryStringParameters || {};

    // Parse time range
    const hours = parseInt(queryParams.hours || '24');
    const limit = parseInt(queryParams.limit || '1000');

    if (path.endsWith('/location')) {
      return await getLocationHistory(deviceUid, hours, limit, corsHeaders);
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
  // Query for all telemetry measures
  const query = `
    SELECT
      device_uid,
      time,
      measure_name,
      measure_value::double as value
    FROM "${TIMESTREAM_DATABASE}"."${TIMESTREAM_TABLE}"
    WHERE device_uid = '${deviceUid}'
      AND time > ago(${hours}h)
      AND measure_name IN ('temperature', 'humidity', 'pressure', 'voltage')
    ORDER BY time DESC
    LIMIT ${limit}
  `;

  const command = new QueryCommand({ QueryString: query });
  const result = await timestreamClient.send(command);

  // Transform results into a more usable format
  const telemetryMap = new Map<string, Record<string, any>>();

  if (result.Rows) {
    for (const row of result.Rows) {
      const data = row.Data;
      if (!data) continue;

      const time = data[1]?.ScalarValue;
      const measureName = data[2]?.ScalarValue;
      const value = parseFloat(data[3]?.ScalarValue || '0');

      if (!time || !measureName) continue;

      if (!telemetryMap.has(time)) {
        telemetryMap.set(time, { time });
      }

      const entry = telemetryMap.get(time)!;
      entry[measureName] = value;
    }
  }

  // Convert to array and sort by time
  const telemetry = Array.from(telemetryMap.values()).sort(
    (a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()
  );

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
  // Query for location data
  const query = `
    WITH lat_data AS (
      SELECT
        time,
        measure_value::double as lat
      FROM "${TIMESTREAM_DATABASE}"."${TIMESTREAM_TABLE}"
      WHERE device_uid = '${deviceUid}'
        AND time > ago(${hours}h)
        AND measure_name = 'latitude'
    ),
    lon_data AS (
      SELECT
        time,
        measure_value::double as lon
      FROM "${TIMESTREAM_DATABASE}"."${TIMESTREAM_TABLE}"
      WHERE device_uid = '${deviceUid}'
        AND time > ago(${hours}h)
        AND measure_name = 'longitude'
    )
    SELECT
      lat_data.time,
      lat_data.lat,
      lon_data.lon
    FROM lat_data
    JOIN lon_data ON lat_data.time = lon_data.time
    ORDER BY lat_data.time DESC
    LIMIT ${limit}
  `;

  const command = new QueryCommand({ QueryString: query });
  const result = await timestreamClient.send(command);

  const locations: Array<{ time: string; lat: number; lon: number }> = [];

  if (result.Rows) {
    for (const row of result.Rows) {
      const data = row.Data;
      if (!data) continue;

      const time = data[0]?.ScalarValue;
      const lat = parseFloat(data[1]?.ScalarValue || '0');
      const lon = parseFloat(data[2]?.ScalarValue || '0');

      if (time && lat && lon) {
        locations.push({ time, lat, lon });
      }
    }
  }

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
