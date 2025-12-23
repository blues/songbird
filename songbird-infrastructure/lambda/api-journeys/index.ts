/**
 * Journeys API Lambda
 *
 * Handles journey and location history queries:
 * - GET /devices/{device_uid}/journeys - List all journeys for a device
 * - GET /devices/{device_uid}/journeys/{journey_id} - Get journey details with points
 * - GET /devices/{device_uid}/locations - Get location history
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const JOURNEYS_TABLE = process.env.JOURNEYS_TABLE!;
const LOCATIONS_TABLE = process.env.LOCATIONS_TABLE!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Request:', JSON.stringify(event));

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
  };

  try {
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

    const journeyId = event.pathParameters?.journey_id;
    const queryParams = event.queryStringParameters || {};

    // GET /devices/{device_uid}/locations - Location history
    if (path.endsWith('/locations')) {
      return await getLocationHistory(deviceUid, queryParams, corsHeaders);
    }

    // GET /devices/{device_uid}/journeys/{journey_id} - Single journey with points
    if (journeyId) {
      return await getJourneyDetail(deviceUid, parseInt(journeyId), corsHeaders);
    }

    // GET /devices/{device_uid}/journeys - List journeys
    return await listJourneys(deviceUid, queryParams, corsHeaders);
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
 * List all journeys for a device
 */
async function listJourneys(
  deviceUid: string,
  queryParams: Record<string, string | undefined>,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const status = queryParams.status; // 'active' | 'completed' | undefined (all)
  const limit = parseInt(queryParams.limit || '50');

  const command = new QueryCommand({
    TableName: JOURNEYS_TABLE,
    KeyConditionExpression: 'device_uid = :device_uid',
    ...(status && {
      FilterExpression: '#status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':device_uid': deviceUid,
        ':status': status,
      },
    }),
    ...(!status && {
      ExpressionAttributeValues: {
        ':device_uid': deviceUid,
      },
    }),
    ScanIndexForward: false, // Most recent first
    Limit: limit,
  });

  const result = await docClient.send(command);

  const journeys = (result.Items || []).map((item) => ({
    journey_id: item.journey_id,
    device_uid: item.device_uid,
    start_time: new Date(item.start_time).toISOString(),
    end_time: item.end_time ? new Date(item.end_time).toISOString() : undefined,
    point_count: item.point_count || 0,
    total_distance: item.total_distance || 0,
    status: item.status,
  }));

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      device_uid: deviceUid,
      journeys,
      count: journeys.length,
    }),
  };
}

/**
 * Get a single journey with all its location points
 */
async function getJourneyDetail(
  deviceUid: string,
  journeyId: number,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  // Get the journey metadata
  const journeyCommand = new QueryCommand({
    TableName: JOURNEYS_TABLE,
    KeyConditionExpression: 'device_uid = :device_uid AND journey_id = :journey_id',
    ExpressionAttributeValues: {
      ':device_uid': deviceUid,
      ':journey_id': journeyId,
    },
  });

  const journeyResult = await docClient.send(journeyCommand);

  if (!journeyResult.Items || journeyResult.Items.length === 0) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Journey not found' }),
    };
  }

  const journeyItem = journeyResult.Items[0];

  // Get all location points for this journey using the journey-index GSI
  const pointsCommand = new QueryCommand({
    TableName: LOCATIONS_TABLE,
    IndexName: 'journey-index',
    KeyConditionExpression: 'device_uid = :device_uid AND journey_id = :journey_id',
    ExpressionAttributeValues: {
      ':device_uid': deviceUid,
      ':journey_id': journeyId,
    },
    ScanIndexForward: true, // Chronological order
  });

  const pointsResult = await docClient.send(pointsCommand);

  const journey = {
    journey_id: journeyItem.journey_id,
    device_uid: journeyItem.device_uid,
    start_time: new Date(journeyItem.start_time).toISOString(),
    end_time: journeyItem.end_time ? new Date(journeyItem.end_time).toISOString() : undefined,
    point_count: journeyItem.point_count || 0,
    total_distance: journeyItem.total_distance || 0,
    status: journeyItem.status,
  };

  const points = (pointsResult.Items || []).map((item) => ({
    time: new Date(item.timestamp).toISOString(),
    lat: item.latitude,
    lon: item.longitude,
    velocity: item.velocity,
    bearing: item.bearing,
    distance: item.distance,
    dop: item.dop,
    jcount: item.jcount,
  }));

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      journey,
      points,
    }),
  };
}

/**
 * Get location history for a device
 */
async function getLocationHistory(
  deviceUid: string,
  queryParams: Record<string, string | undefined>,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const hours = parseInt(queryParams.hours || '24');
  const source = queryParams.source; // 'gps' | 'cell' | 'triangulation' | undefined (all)
  const limit = parseInt(queryParams.limit || '1000');

  const cutoffTime = Date.now() - hours * 60 * 60 * 1000;

  const command = new QueryCommand({
    TableName: LOCATIONS_TABLE,
    KeyConditionExpression: 'device_uid = :device_uid AND #timestamp >= :cutoff',
    ...(source && {
      FilterExpression: '#source = :source',
      ExpressionAttributeNames: {
        '#timestamp': 'timestamp',
        '#source': 'source',
      },
      ExpressionAttributeValues: {
        ':device_uid': deviceUid,
        ':cutoff': cutoffTime,
        ':source': source,
      },
    }),
    ...(!source && {
      ExpressionAttributeNames: {
        '#timestamp': 'timestamp',
      },
      ExpressionAttributeValues: {
        ':device_uid': deviceUid,
        ':cutoff': cutoffTime,
      },
    }),
    ScanIndexForward: false, // Most recent first
    Limit: limit,
  });

  const result = await docClient.send(command);

  const locations = (result.Items || []).map((item) => ({
    time: new Date(item.timestamp).toISOString(),
    lat: item.latitude,
    lon: item.longitude,
    source: item.source,
    location_name: item.location_name,
    event_type: item.event_type,
    journey_id: item.journey_id,
    jcount: item.jcount,
    velocity: item.velocity,
    bearing: item.bearing,
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
