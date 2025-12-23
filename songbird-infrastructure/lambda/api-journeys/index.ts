/**
 * Journeys API Lambda
 *
 * Handles journey and location history queries:
 * - GET /devices/{device_uid}/journeys - List all journeys for a device
 * - GET /devices/{device_uid}/journeys/{journey_id} - Get journey details with points
 * - GET /devices/{device_uid}/locations - Get location history
 * - POST /devices/{device_uid}/journeys/{journey_id}/match - Trigger map matching
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const JOURNEYS_TABLE = process.env.JOURNEYS_TABLE!;
const LOCATIONS_TABLE = process.env.LOCATIONS_TABLE!;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Request:', JSON.stringify(event));

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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

    // POST /devices/{device_uid}/journeys/{journey_id}/match - Map matching
    if (path.endsWith('/match') && method === 'POST' && journeyId) {
      return await matchJourney(deviceUid, parseInt(journeyId), corsHeaders);
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
    matched_route: journeyItem.matched_route, // GeoJSON LineString if map-matched
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
 * Call Mapbox Map Matching API and cache the result
 */
async function matchJourney(
  deviceUid: string,
  journeyId: number,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  if (!MAPBOX_TOKEN) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Map matching not configured' }),
    };
  }

  // Get the journey points
  const pointsCommand = new QueryCommand({
    TableName: LOCATIONS_TABLE,
    IndexName: 'journey-index',
    KeyConditionExpression: 'device_uid = :device_uid AND journey_id = :journey_id',
    ExpressionAttributeValues: {
      ':device_uid': deviceUid,
      ':journey_id': journeyId,
    },
    ScanIndexForward: true,
  });

  const pointsResult = await docClient.send(pointsCommand);
  const points = pointsResult.Items || [];

  if (points.length < 2) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Journey has fewer than 2 points' }),
    };
  }

  // Mapbox Map Matching API has a limit of 100 coordinates per request
  // If we have more, we need to sample or batch
  const maxPoints = 100;
  let sampledPoints = points;
  if (points.length > maxPoints) {
    // Sample points evenly
    const step = (points.length - 1) / (maxPoints - 1);
    sampledPoints = [];
    for (let i = 0; i < maxPoints; i++) {
      const idx = Math.round(i * step);
      sampledPoints.push(points[idx]);
    }
  }

  // Format coordinates for Mapbox API: lon,lat;lon,lat;...
  const coordinates = sampledPoints
    .map((p) => `${p.longitude},${p.latitude}`)
    .join(';');

  // Build the timestamps parameter (Unix timestamps in seconds)
  const timestamps = sampledPoints
    .map((p) => Math.floor(p.timestamp / 1000))
    .join(';');

  // Build the radiuses parameter (GPS accuracy in meters, default 25m)
  const radiuses = sampledPoints
    .map((p) => (p.dop ? Math.max(5, p.dop * 10) : 25))
    .join(';');

  // Call Mapbox Map Matching API
  const mapMatchUrl = `https://api.mapbox.com/matching/v5/mapbox/driving/${coordinates}?access_token=${MAPBOX_TOKEN}&geometries=geojson&radiuses=${radiuses}&timestamps=${timestamps}&overview=full&steps=false`;

  console.log(`Calling Mapbox Map Matching API for journey ${journeyId} with ${sampledPoints.length} points`);

  try {
    const response = await fetch(mapMatchUrl);
    const data = await response.json();

    if (data.code !== 'Ok' || !data.matchings || data.matchings.length === 0) {
      console.error('Map matching failed:', data);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Map matching failed',
          code: data.code,
          message: data.message,
        }),
      };
    }

    // Get the matched geometry (GeoJSON LineString)
    const matchedRoute = data.matchings[0].geometry;
    const confidence = data.matchings[0].confidence;

    // Store the matched route in DynamoDB
    const updateCommand = new UpdateCommand({
      TableName: JOURNEYS_TABLE,
      Key: {
        device_uid: deviceUid,
        journey_id: journeyId,
      },
      UpdateExpression: 'SET matched_route = :route, match_confidence = :confidence, matched_at = :time',
      ExpressionAttributeValues: {
        ':route': matchedRoute,
        ':confidence': confidence,
        ':time': Date.now(),
      },
    });

    await docClient.send(updateCommand);
    console.log(`Stored matched route for journey ${journeyId} with confidence ${confidence}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        matched_route: matchedRoute,
        confidence,
        original_points: points.length,
        matched_points: sampledPoints.length,
      }),
    };
  } catch (error) {
    console.error('Error calling Mapbox API:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to call map matching API' }),
    };
  }
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
