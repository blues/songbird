/**
 * Journeys API Lambda
 *
 * Handles journey and location history queries:
 * - GET /devices/{serial_number}/journeys - List all journeys for a device
 * - GET /devices/{serial_number}/journeys/{journey_id} - Get journey details with points
 * - DELETE /devices/{serial_number}/journeys/{journey_id} - Delete a journey (admin/owner only)
 * - GET /devices/{serial_number}/locations - Get location history
 * - POST /devices/{serial_number}/journeys/{journey_id}/match - Trigger map matching
 *
 * Note: When a Notecard is swapped, journeys from all device_uids are merged.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand, DeleteCommand, GetCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyEventV2, APIGatewayProxyResult } from 'aws-lambda';
import { resolveDevice } from '../shared/device-lookup';

// Type for location point items from DynamoDB
interface LocationPoint {
  device_uid: string;
  timestamp: number;
  latitude: number;
  longitude: number;
  velocity?: number;
  bearing?: number;
  distance?: number;
  dop?: number;
  jcount?: number;
  journey_id?: number;
  source?: string;
  location_name?: string;
  event_type?: string;
}

// Type for telemetry items with power readings
interface TelemetryItem {
  milliamp_hours?: number;
  [key: string]: unknown;
}

// GeoJSON LineString type
interface GeoJSONLineString {
  type: 'LineString';
  coordinates: number[][];
}

// Type for Mapbox Map Matching API response
interface MapboxMatchResponse {
  code: string;
  message?: string;
  matchings?: Array<{
    geometry: GeoJSONLineString;
    confidence: number;
  }>;
}

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const JOURNEYS_TABLE = process.env.JOURNEYS_TABLE!;
const LOCATIONS_TABLE = process.env.LOCATIONS_TABLE!;
const DEVICES_TABLE = process.env.DEVICES_TABLE!;
const TELEMETRY_TABLE = process.env.TELEMETRY_TABLE!;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Request:', JSON.stringify(event));

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  };

  try {
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

    const journeyId = event.pathParameters?.journey_id;
    const queryParams = event.queryStringParameters || {};

    // GET /devices/{serial_number}/locations - Location history (merged from all Notecards)
    if (path.endsWith('/locations')) {
      return await getLocationHistory(resolved.serial_number, resolved.all_device_uids, queryParams, corsHeaders);
    }

    // POST /devices/{serial_number}/journeys/{journey_id}/match - Map matching
    // Note: For now, we need to find which device_uid owns this journey
    if (path.endsWith('/match') && method === 'POST' && journeyId) {
      return await matchJourney(resolved.all_device_uids, parseInt(journeyId), corsHeaders);
    }

    // DELETE /devices/{serial_number}/journeys/{journey_id} - Delete journey (admin/owner only)
    if (method === 'DELETE' && journeyId) {
      return await deleteJourney(resolved.serial_number, resolved.all_device_uids, parseInt(journeyId), event, corsHeaders);
    }

    // GET /devices/{serial_number}/journeys/{journey_id} - Single journey with points
    if (journeyId) {
      return await getJourneyDetail(resolved.all_device_uids, parseInt(journeyId), corsHeaders);
    }

    // GET /devices/{serial_number}/journeys - List journeys (merged from all Notecards)
    return await listJourneys(resolved.serial_number, resolved.all_device_uids, queryParams, corsHeaders);
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
 * List all journeys for a device (merged from all Notecards)
 */
async function listJourneys(
  serialNumber: string,
  deviceUids: string[],
  queryParams: Record<string, string | undefined>,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const status = queryParams.status; // 'active' | 'completed' | undefined (all)
  const limit = parseInt(queryParams.limit || '50');

  // Query all device_uids in parallel
  const queryPromises = deviceUids.map(async (deviceUid) => {
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
      ScanIndexForward: false,
      Limit: limit,
    });

    const result = await docClient.send(command);
    return result.Items || [];
  });

  const allResults = await Promise.all(queryPromises);

  // Merge and sort by journey_id (which is the start timestamp, descending)
  const mergedJourneys = allResults
    .flat()
    .sort((a, b) => b.journey_id - a.journey_id)
    .slice(0, limit)
    .map((item) => ({
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
      serial_number: serialNumber,
      journeys: mergedJourneys,
      count: mergedJourneys.length,
    }),
  };
}

/**
 * Get a single journey with all its location points
 * Searches across all device_uids to find the journey
 */
async function getJourneyDetail(
  deviceUids: string[],
  journeyId: number,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  // Search for the journey across all device_uids
  let journeyItem: any = null;
  let ownerDeviceUid: string | null = null;

  for (const deviceUid of deviceUids) {
    const journeyCommand = new QueryCommand({
      TableName: JOURNEYS_TABLE,
      KeyConditionExpression: 'device_uid = :device_uid AND journey_id = :journey_id',
      ExpressionAttributeValues: {
        ':device_uid': deviceUid,
        ':journey_id': journeyId,
      },
    });

    const journeyResult = await docClient.send(journeyCommand);

    if (journeyResult.Items && journeyResult.Items.length > 0) {
      journeyItem = journeyResult.Items[0];
      ownerDeviceUid = deviceUid;
      break;
    }
  }

  if (!journeyItem || !ownerDeviceUid) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Journey not found' }),
    };
  }

  // Get all location points for this journey using the journey-index GSI
  const pointsCommand = new QueryCommand({
    TableName: LOCATIONS_TABLE,
    IndexName: 'journey-index',
    KeyConditionExpression: 'device_uid = :device_uid AND journey_id = :journey_id',
    ExpressionAttributeValues: {
      ':device_uid': ownerDeviceUid,
      ':journey_id': journeyId,
    },
    ScanIndexForward: true, // Chronological order
  });

  const pointsResult = await docClient.send(pointsCommand);

  const startTime = journeyItem.start_time;
  const endTime = journeyItem.end_time || Date.now();

  const journey = {
    journey_id: journeyItem.journey_id,
    device_uid: journeyItem.device_uid,
    start_time: new Date(startTime).toISOString(),
    end_time: journeyItem.end_time ? new Date(journeyItem.end_time).toISOString() : undefined,
    point_count: journeyItem.point_count || 0,
    total_distance: journeyItem.total_distance || 0,
    status: journeyItem.status,
    matched_route: journeyItem.matched_route, // GeoJSON LineString if map-matched
  };

  // Sort points by timestamp (GSI doesn't guarantee order within same journey_id)
  const sortedItems = ((pointsResult.Items || []) as LocationPoint[]).sort((a, b) => a.timestamp - b.timestamp);

  const points = sortedItems.map((item) => ({
    time: new Date(item.timestamp).toISOString(),
    lat: item.latitude,
    lon: item.longitude,
    velocity: item.velocity,
    bearing: item.bearing,
    distance: item.distance,
    dop: item.dop,
    jcount: item.jcount,
  }));

  // Get power consumption for this journey
  const power = await getJourneyPowerConsumption(ownerDeviceUid, startTime, endTime);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      journey,
      points,
      power,
    }),
  };
}

/**
 * Call Mapbox Map Matching API and cache the result
 * Searches across all device_uids to find the journey
 */
async function matchJourney(
  deviceUids: string[],
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

  // Find which device_uid owns this journey
  let ownerDeviceUid: string | null = null;

  for (const deviceUid of deviceUids) {
    const journeyCommand = new QueryCommand({
      TableName: JOURNEYS_TABLE,
      KeyConditionExpression: 'device_uid = :device_uid AND journey_id = :journey_id',
      ExpressionAttributeValues: {
        ':device_uid': deviceUid,
        ':journey_id': journeyId,
      },
    });

    const journeyResult = await docClient.send(journeyCommand);

    if (journeyResult.Items && journeyResult.Items.length > 0) {
      ownerDeviceUid = deviceUid;
      break;
    }
  }

  if (!ownerDeviceUid) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Journey not found' }),
    };
  }

  // Get the journey points
  const pointsCommand = new QueryCommand({
    TableName: LOCATIONS_TABLE,
    IndexName: 'journey-index',
    KeyConditionExpression: 'device_uid = :device_uid AND journey_id = :journey_id',
    ExpressionAttributeValues: {
      ':device_uid': ownerDeviceUid,
      ':journey_id': journeyId,
    },
    ScanIndexForward: true,
  });

  const pointsResult = await docClient.send(pointsCommand);

  // Sort points by timestamp (GSI doesn't guarantee order within same journey_id)
  const points = ((pointsResult.Items || []) as LocationPoint[]).sort((a, b) => a.timestamp - b.timestamp);

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
  let sampledPoints: LocationPoint[] = points;
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
    const data = await response.json() as MapboxMatchResponse;

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

    // Store the matched route in DynamoDB (include point count for cache invalidation)
    const updateCommand = new UpdateCommand({
      TableName: JOURNEYS_TABLE,
      Key: {
        device_uid: ownerDeviceUid,
        journey_id: journeyId,
      },
      UpdateExpression: 'SET matched_route = :route, match_confidence = :confidence, matched_at = :time, matched_points_count = :count',
      ExpressionAttributeValues: {
        ':route': matchedRoute,
        ':confidence': confidence,
        ':time': Date.now(),
        ':count': points.length,
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
 * Get location history for a device (merged from all Notecards)
 */
async function getLocationHistory(
  serialNumber: string,
  deviceUids: string[],
  queryParams: Record<string, string | undefined>,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const hours = parseInt(queryParams.hours || '24');
  const source = queryParams.source; // 'gps' | 'cell' | 'triangulation' | undefined (all)
  const limit = parseInt(queryParams.limit || '1000');

  const cutoffTime = Date.now() - hours * 60 * 60 * 1000;

  // Query all device_uids in parallel
  const queryPromises = deviceUids.map(async (deviceUid) => {
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
      ScanIndexForward: false,
      Limit: limit,
    });

    const result = await docClient.send(command);
    return result.Items || [];
  });

  const allResults = await Promise.all(queryPromises);

  // Merge and sort by timestamp (most recent first), then apply limit
  const mergedLocations = allResults
    .flat()
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
    .map((item) => ({
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
      serial_number: serialNumber,
      hours,
      count: mergedLocations.length,
      locations: mergedLocations,
    }),
  };
}

/**
 * Check if the user is an admin (in 'Admin' Cognito group)
 */
function isAdmin(event: APIGatewayProxyEvent): boolean {
  try {
    const claims = (event.requestContext as any)?.authorizer?.jwt?.claims;
    if (!claims) return false;

    const groups = claims['cognito:groups'];
    if (Array.isArray(groups)) {
      return groups.includes('Admin');
    }
    if (typeof groups === 'string') {
      return groups === 'Admin' || groups.includes('Admin');
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Get the user's email from the JWT claims
 */
function getUserEmail(event: APIGatewayProxyEvent): string | undefined {
  try {
    const claims = (event.requestContext as any)?.authorizer?.jwt?.claims;
    return claims?.email;
  } catch {
    return undefined;
  }
}

/**
 * Check if the user owns the device (is assigned to it)
 */
async function isDeviceOwner(deviceUid: string, userEmail: string): Promise<boolean> {
  const command = new GetCommand({
    TableName: DEVICES_TABLE,
    Key: { device_uid: deviceUid },
    ProjectionExpression: 'assigned_to',
  });

  const result = await docClient.send(command);
  return result.Item?.assigned_to === userEmail;
}

/**
 * Delete a journey and all its location points (admin/owner only)
 * Searches across all device_uids to find and delete the journey
 */
async function deleteJourney(
  serialNumber: string,
  deviceUids: string[],
  journeyId: number,
  event: APIGatewayProxyEvent,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  // Authorization check: must be admin or device owner
  const userEmail = getUserEmail(event);
  const admin = isAdmin(event);

  // Find which device_uid owns this journey
  let ownerDeviceUid: string | null = null;

  for (const deviceUid of deviceUids) {
    const journeyCommand = new QueryCommand({
      TableName: JOURNEYS_TABLE,
      KeyConditionExpression: 'device_uid = :device_uid AND journey_id = :journey_id',
      ExpressionAttributeValues: {
        ':device_uid': deviceUid,
        ':journey_id': journeyId,
      },
    });

    const journeyResult = await docClient.send(journeyCommand);

    if (journeyResult.Items && journeyResult.Items.length > 0) {
      ownerDeviceUid = deviceUid;
      break;
    }
  }

  if (!ownerDeviceUid) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Journey not found' }),
    };
  }

  if (!admin) {
    if (!userEmail) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    const owner = await isDeviceOwner(ownerDeviceUid, userEmail);
    if (!owner) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: 'Admin or device owner access required' }),
      };
    }
  }

  // Get all location points for this journey to delete them
  const pointsCommand = new QueryCommand({
    TableName: LOCATIONS_TABLE,
    IndexName: 'journey-index',
    KeyConditionExpression: 'device_uid = :device_uid AND journey_id = :journey_id',
    ExpressionAttributeValues: {
      ':device_uid': ownerDeviceUid,
      ':journey_id': journeyId,
    },
    ProjectionExpression: 'device_uid, #ts',
    ExpressionAttributeNames: {
      '#ts': 'timestamp',
    },
  });

  const pointsResult = await docClient.send(pointsCommand);
  const locationPoints = (pointsResult.Items || []) as LocationPoint[];

  // Delete location points in batches of 25 (DynamoDB BatchWrite limit)
  if (locationPoints.length > 0) {
    const batches: LocationPoint[][] = [];
    for (let i = 0; i < locationPoints.length; i += 25) {
      const batch = locationPoints.slice(i, i + 25);
      batches.push(batch);
    }

    for (const batch of batches) {
      const deleteRequests = batch.map((point: LocationPoint) => ({
        DeleteRequest: {
          Key: {
            device_uid: point.device_uid,
            timestamp: point.timestamp,
          },
        },
      }));

      const batchCommand = new BatchWriteCommand({
        RequestItems: {
          [LOCATIONS_TABLE]: deleteRequests,
        },
      });

      await docClient.send(batchCommand);
    }

    console.log(`Deleted ${locationPoints.length} location points for journey ${journeyId}`);
  }

  // Delete the journey record
  const deleteCommand = new DeleteCommand({
    TableName: JOURNEYS_TABLE,
    Key: {
      device_uid: ownerDeviceUid,
      journey_id: journeyId,
    },
  });

  await docClient.send(deleteCommand);
  console.log(`Deleted journey ${journeyId} for device ${ownerDeviceUid} (serial: ${serialNumber})`);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      message: 'Journey deleted',
      journey_id: journeyId,
      points_deleted: locationPoints.length,
    }),
  };
}

/**
 * Get power consumption during a journey timeframe
 * Queries power telemetry data and calculates mAh consumed
 */
async function getJourneyPowerConsumption(
  deviceUid: string,
  startTime: number,
  endTime: number
): Promise<{
  start_mah: number;
  end_mah: number;
  consumed_mah: number;
  reading_count: number;
} | null> {
  // Query power telemetry using the event-type-index GSI
  const startKey = `power#${startTime}`;
  const endKey = `power#${endTime}`;

  const command = new QueryCommand({
    TableName: TELEMETRY_TABLE,
    IndexName: 'event-type-index',
    KeyConditionExpression: 'device_uid = :device_uid AND event_type_timestamp BETWEEN :start AND :end',
    ExpressionAttributeValues: {
      ':device_uid': deviceUid,
      ':start': startKey,
      ':end': endKey,
    },
    ScanIndexForward: true, // Chronological order
  });

  const result = await docClient.send(command);
  const powerReadings = (result.Items || []) as TelemetryItem[];

  // Need at least 2 readings to calculate consumption
  if (powerReadings.length < 2) {
    return null;
  }

  // Filter for readings that have milliamp_hours
  const validReadings = powerReadings.filter((r) => typeof r.milliamp_hours === 'number');

  if (validReadings.length < 2) {
    return null;
  }

  const firstReading = validReadings[0];
  const lastReading = validReadings[validReadings.length - 1];

  // We know these are numbers since we filtered for them above
  const startMah = firstReading.milliamp_hours!;
  const endMah = lastReading.milliamp_hours!;

  // Calculate consumption (handle counter reset edge case)
  let consumedMah = endMah - startMah;
  if (consumedMah < 0) {
    // Counter was reset during journey - can't calculate accurately
    return null;
  }

  return {
    start_mah: Math.round(startMah * 100) / 100,
    end_mah: Math.round(endMah * 100) / 100,
    consumed_mah: Math.round(consumedMah * 100) / 100,
    reading_count: validReadings.length,
  };
}
