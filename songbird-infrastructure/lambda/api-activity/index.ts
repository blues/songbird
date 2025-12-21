/**
 * Activity Feed API Lambda
 *
 * Returns a unified activity feed combining:
 * - Alerts (from alerts table)
 * - Health events (from telemetry table)
 * - Location updates (from telemetry table)
 * - Device status changes (derived from device last_seen)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const TELEMETRY_TABLE = process.env.TELEMETRY_TABLE!;
const ALERTS_TABLE = process.env.ALERTS_TABLE!;
const DEVICES_TABLE = process.env.DEVICES_TABLE!;

interface ActivityItem {
  id: string;
  type: 'alert' | 'health' | 'location' | 'status';
  device_uid: string;
  device_name?: string;
  message: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

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

    const queryParams = event.queryStringParameters || {};
    const hours = parseInt(queryParams.hours || '24');
    const limit = parseInt(queryParams.limit || '50');

    // Fetch activities from all sources in parallel
    const [alerts, healthEvents, locationEvents, devices] = await Promise.all([
      getRecentAlerts(hours, limit),
      getRecentHealthEvents(hours, limit),
      getRecentLocationEvents(hours, limit),
      getDevices(),
    ]);

    // Filter location events to only show significant changes
    const significantLocationEvents = filterSignificantLocationChanges(locationEvents);


    // Create device name lookup
    const deviceNames: Record<string, string> = {};
    for (const device of devices) {
      deviceNames[device.device_uid] = device.name || device.serial_number || device.device_uid;
    }

    // Transform alerts to activity items
    const alertActivities: ActivityItem[] = alerts.map((alert) => ({
      id: `alert-${alert.alert_id}`,
      type: 'alert',
      device_uid: alert.device_uid,
      device_name: deviceNames[alert.device_uid],
      message: formatAlertMessage(alert),
      timestamp: new Date(alert.created_at).toISOString(),
      data: {
        alert_type: alert.type,
        value: alert.value,
        threshold: alert.threshold,
        acknowledged: alert.acknowledged,
      },
    }));

    // Transform health events to activity items
    const healthActivities: ActivityItem[] = healthEvents.map((event) => ({
      id: `health-${event.device_uid}-${event.timestamp}`,
      type: 'health',
      device_uid: event.device_uid,
      device_name: deviceNames[event.device_uid],
      message: formatHealthMessage(event),
      timestamp: new Date(event.timestamp).toISOString(),
      data: {
        method: event.method,
        voltage: event.voltage,
      },
    }));

    // Transform location events to activity items (only significant changes)
    const locationActivities: ActivityItem[] = significantLocationEvents.map((event) => ({
      id: `location-${event.device_uid}-${event.timestamp}`,
      type: 'location',
      device_uid: event.device_uid,
      device_name: deviceNames[event.device_uid],
      message: formatLocationMessage(event, deviceNames[event.device_uid]),
      timestamp: new Date(event.timestamp).toISOString(),
      data: {
        lat: event.latitude,
        lon: event.longitude,
        source: event.location_source,
      },
    }));

    // Merge all activities and sort by timestamp (newest first)
    const allActivities = [...alertActivities, ...healthActivities, ...locationActivities]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        hours,
        count: allActivities.length,
        activities: allActivities,
      }),
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

async function getRecentAlerts(hours: number, limit: number): Promise<any[]> {
  const cutoffTime = Date.now() - hours * 60 * 60 * 1000;
  const allItems: any[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;

  // Paginate through all results
  do {
    const command = new ScanCommand({
      TableName: ALERTS_TABLE,
      FilterExpression: 'created_at > :cutoff',
      ExpressionAttributeValues: {
        ':cutoff': cutoffTime,
      },
      ExclusiveStartKey: lastEvaluatedKey,
    });

    const result = await docClient.send(command);
    allItems.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;

    // Stop early if we have enough items
    if (allItems.length >= limit * 2) break;
  } while (lastEvaluatedKey);

  return allItems.slice(0, limit * 2);
}

async function getRecentHealthEvents(hours: number, limit: number): Promise<any[]> {
  const cutoffTime = Date.now() - hours * 60 * 60 * 1000;
  const allItems: any[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;

  // Paginate through all results
  do {
    const command = new ScanCommand({
      TableName: TELEMETRY_TABLE,
      FilterExpression: '#ts > :cutoff AND data_type = :data_type',
      ExpressionAttributeNames: {
        '#ts': 'timestamp',
      },
      ExpressionAttributeValues: {
        ':cutoff': cutoffTime,
        ':data_type': 'health',
      },
      ExclusiveStartKey: lastEvaluatedKey,
    });

    const result = await docClient.send(command);
    allItems.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;

    // Stop early if we have enough items
    if (allItems.length >= limit * 2) break;
  } while (lastEvaluatedKey);

  return allItems.slice(0, limit * 2);
}

async function getRecentLocationEvents(hours: number, limit: number): Promise<any[]> {
  const cutoffTime = Date.now() - hours * 60 * 60 * 1000;
  const allItems: any[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;

  // Paginate through ALL results - DynamoDB Scan doesn't return items in order,
  // so we must scan everything to ensure we get the most recent events
  do {
    const command = new ScanCommand({
      TableName: TELEMETRY_TABLE,
      FilterExpression: '#ts > :cutoff AND event_type = :event_type',
      ExpressionAttributeNames: {
        '#ts': 'timestamp',
      },
      ExpressionAttributeValues: {
        ':cutoff': cutoffTime,
        ':event_type': '_geolocate.qo',
      },
      ExclusiveStartKey: lastEvaluatedKey,
    });

    const result = await docClient.send(command);
    allItems.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  // Sort by timestamp descending and return the most recent items
  return allItems
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit * 2);
}

async function getDevices(): Promise<any[]> {
  const command = new ScanCommand({
    TableName: DEVICES_TABLE,
    ProjectionExpression: 'device_uid, #name, serial_number',
    ExpressionAttributeNames: {
      '#name': 'name',
    },
  });

  const result = await docClient.send(command);
  return result.Items || [];
}

function formatAlertMessage(alert: any): string {
  const alertLabels: Record<string, string> = {
    temp_high: 'High temperature alert',
    temp_low: 'Low temperature alert',
    humidity_high: 'High humidity alert',
    humidity_low: 'Low humidity alert',
    pressure_change: 'Pressure change alert',
    low_battery: 'Low battery alert',
    motion: 'Motion detected',
  };

  const label = alertLabels[alert.type] || alert.type;
  if (alert.value !== undefined) {
    return `${label}: ${alert.value.toFixed(1)}`;
  }
  return label;
}

function formatHealthMessage(event: any): string {
  const methodLabels: Record<string, string> = {
    dfu: 'Firmware update',
    boot: 'Device booted',
    reboot: 'Device rebooted',
    reset: 'Device reset',
    usb: 'USB connected',
    battery: 'Battery status update',
    sync: 'Sync completed',
    connected: 'Connected to network',
    disconnected: 'Disconnected from network',
  };

  const label = methodLabels[event.method] || event.method || 'Health event';
  if (event.text) {
    return `${label}: ${event.text}`;
  }
  return label;
}

function formatLocationMessage(event: any, deviceName?: string): string {
  const sourceLabels: Record<string, string> = {
    gps: 'GPS location',
    triangulation: 'Triangulated location',
    cell: 'Cell tower location',
    tower: 'Cell tower location',
    wifi: 'Wi-Fi location',
  };

  const sourceLabel = sourceLabels[event.location_source] || 'Location update';
  return `${sourceLabel} received`;
}

/**
 * Calculate distance between two lat/lon points using Haversine formula
 * Returns distance in meters
 */
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth's radius in meters
  const toRad = (deg: number) => deg * Math.PI / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Filter location events to only include meaningful changes per device.
 * A location is considered "changed" if:
 * - It's the first event for that device
 * - The location source changed
 * - The distance moved is > 100 meters
 *
 * Always includes the most recent event per device so users see current status.
 */
function filterSignificantLocationChanges(events: any[]): any[] {
  // Sort by device_uid, then timestamp ascending (oldest first)
  const sorted = [...events].sort((a, b) => {
    if (a.device_uid !== b.device_uid) {
      return a.device_uid.localeCompare(b.device_uid);
    }
    return a.timestamp - b.timestamp;
  });

  const significantEvents: any[] = [];
  const lastSignificantByDevice: Record<string, any> = {};
  const mostRecentByDevice: Record<string, any> = {};

  for (const event of sorted) {
    const deviceUid = event.device_uid;

    // Track the most recent event for each device
    mostRecentByDevice[deviceUid] = event;

    const lastSignificant = lastSignificantByDevice[deviceUid];

    if (!lastSignificant) {
      // First event for this device
      significantEvents.push(event);
      lastSignificantByDevice[deviceUid] = event;
      continue;
    }

    // Check if location source changed
    if (event.location_source !== lastSignificant.location_source) {
      significantEvents.push(event);
      lastSignificantByDevice[deviceUid] = event;
      continue;
    }

    // Check if moved more than 100 meters
    const distance = haversineDistance(
      lastSignificant.latitude, lastSignificant.longitude,
      event.latitude, event.longitude
    );

    if (distance > 100) {
      significantEvents.push(event);
      lastSignificantByDevice[deviceUid] = event;
    }
  }

  // Ensure the most recent event for each device is included
  for (const deviceUid of Object.keys(mostRecentByDevice)) {
    const mostRecent = mostRecentByDevice[deviceUid];
    const alreadyIncluded = significantEvents.some(
      (e) => e.device_uid === deviceUid && e.timestamp === mostRecent.timestamp
    );
    if (!alreadyIncluded) {
      significantEvents.push(mostRecent);
    }
  }

  return significantEvents;
}
