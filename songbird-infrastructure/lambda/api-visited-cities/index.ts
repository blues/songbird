/**
 * Visited Cities API Lambda
 *
 * Aggregates location history to show unique cities a device has visited.
 * - GET /devices/{serial_number}/visited-cities - Get all unique cities visited
 *
 * Note: When a Notecard is swapped, locations from all device_uids are merged.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { resolveDevice } from '../shared/device-lookup';

interface LocationItem {
  device_uid: string;
  timestamp: number;
  latitude: number;
  longitude: number;
  location_name?: string;
  source?: string;
}

interface CityAggregation {
  cityName: string;
  state?: string;
  country?: string;
  latitude: number;
  longitude: number;
  visitCount: number;
  firstVisit: number;
  lastVisit: number;
}

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

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

    return await getVisitedCities(resolved.serial_number, resolved.all_device_uids, queryParams, corsHeaders);
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
 * Get all unique cities visited by a device
 */
async function getVisitedCities(
  serialNumber: string,
  deviceUids: string[],
  queryParams: Record<string, string | undefined>,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  // Optional date range filtering
  const from = queryParams.from ? new Date(queryParams.from).getTime() : undefined;
  const to = queryParams.to ? new Date(queryParams.to).getTime() : undefined;

  // Query all device_uids in parallel (no time limit by default to get all historical data)
  const queryPromises = deviceUids.map(async (deviceUid) => {
    let allItems: LocationItem[] = [];
    let lastEvaluatedKey: Record<string, any> | undefined;

    // Paginate through all results
    do {
      const command = new QueryCommand({
        TableName: LOCATIONS_TABLE,
        KeyConditionExpression: from && to
          ? 'device_uid = :device_uid AND #timestamp BETWEEN :from AND :to'
          : from
            ? 'device_uid = :device_uid AND #timestamp >= :from'
            : to
              ? 'device_uid = :device_uid AND #timestamp <= :to'
              : 'device_uid = :device_uid',
        ExpressionAttributeNames: {
          '#timestamp': 'timestamp',
        },
        ExpressionAttributeValues: {
          ':device_uid': deviceUid,
          ...(from && { ':from': from }),
          ...(to && { ':to': to }),
        },
        // Only fetch fields we need
        ProjectionExpression: '#timestamp, latitude, longitude, location_name',
        ExclusiveStartKey: lastEvaluatedKey,
      });

      const result = await docClient.send(command);
      allItems = allItems.concat((result.Items || []) as LocationItem[]);
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return allItems;
  });

  const allResults = await Promise.all(queryPromises);
  const allLocations = allResults.flat();

  // Aggregate by city
  const cityMap = new Map<string, CityAggregation>();

  for (const loc of allLocations) {
    if (!loc.location_name) continue;

    const parsed = parseCityFromLocationName(loc.location_name);
    if (!parsed) continue;

    const key = normalizeCity(parsed.city, parsed.state);

    const existing = cityMap.get(key);
    if (existing) {
      existing.visitCount++;
      if (loc.timestamp < existing.firstVisit) {
        existing.firstVisit = loc.timestamp;
      }
      if (loc.timestamp > existing.lastVisit) {
        existing.lastVisit = loc.timestamp;
      }
    } else {
      cityMap.set(key, {
        cityName: parsed.city,
        state: parsed.state,
        country: parsed.country,
        latitude: loc.latitude,
        longitude: loc.longitude,
        visitCount: 1,
        firstVisit: loc.timestamp,
        lastVisit: loc.timestamp,
      });
    }
  }

  // Convert to array and sort by visit count (descending)
  const cities = Array.from(cityMap.values())
    .sort((a, b) => b.visitCount - a.visitCount)
    .map((city) => ({
      cityName: city.cityName,
      state: city.state,
      country: city.country,
      latitude: city.latitude,
      longitude: city.longitude,
      visitCount: city.visitCount,
      firstVisit: new Date(city.firstVisit).toISOString(),
      lastVisit: new Date(city.lastVisit).toISOString(),
    }));

  // Calculate date range from actual data
  let minTime: number | undefined;
  let maxTime: number | undefined;
  for (const loc of allLocations) {
    if (minTime === undefined || loc.timestamp < minTime) minTime = loc.timestamp;
    if (maxTime === undefined || loc.timestamp > maxTime) maxTime = loc.timestamp;
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      serial_number: serialNumber,
      cities,
      totalLocations: allLocations.length,
      dateRange: {
        from: minTime ? new Date(minTime).toISOString() : null,
        to: maxTime ? new Date(maxTime).toISOString() : null,
      },
    }),
  };
}

/**
 * Parse city, state, country from location_name
 * Handles formats like:
 * - "Austin, TX"
 * - "Austin, Texas, USA"
 * - "Austin, TX, United States"
 */
function parseCityFromLocationName(
  locationName: string
): { city: string; state?: string; country?: string } | null {
  const parts = locationName.split(',').map((p) => p.trim());
  if (parts.length === 0 || !parts[0]) return null;

  const city = parts[0];
  const state = parts.length > 1 ? parts[1] : undefined;
  const country = parts.length > 2 ? parts[2] : undefined;

  return { city, state, country };
}

/**
 * Normalize city name for grouping (lowercase, trimmed)
 * Combines city and state to handle same city name in different states
 */
function normalizeCity(city: string, state?: string): string {
  const normalized = city.toLowerCase().trim();
  if (state) {
    return `${normalized}|${state.toLowerCase().trim()}`;
  }
  return normalized;
}
