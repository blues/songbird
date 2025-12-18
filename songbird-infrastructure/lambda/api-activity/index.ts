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

    // Transform location events to activity items
    const locationActivities: ActivityItem[] = locationEvents.map((event) => ({
      id: `location-${event.device_uid}-${event.timestamp}`,
      type: 'location',
      device_uid: event.device_uid,
      device_name: deviceNames[event.device_uid],
      message: `${deviceNames[event.device_uid] || event.device_uid} reported location`,
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

  // Scan alerts table for recent alerts
  const command = new ScanCommand({
    TableName: ALERTS_TABLE,
    FilterExpression: 'created_at > :cutoff',
    ExpressionAttributeValues: {
      ':cutoff': cutoffTime,
    },
    Limit: limit * 2, // Fetch extra since we'll merge with other sources
  });

  const result = await docClient.send(command);
  return result.Items || [];
}

async function getRecentHealthEvents(hours: number, limit: number): Promise<any[]> {
  const cutoffTime = Date.now() - hours * 60 * 60 * 1000;

  // We need to scan across all devices for health events
  // This is a simplified approach - for production, consider a GSI on timestamp
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
    Limit: limit * 2,
  });

  const result = await docClient.send(command);
  return result.Items || [];
}

async function getRecentLocationEvents(hours: number, limit: number): Promise<any[]> {
  const cutoffTime = Date.now() - hours * 60 * 60 * 1000;

  // Scan for telemetry records with location data
  const command = new ScanCommand({
    TableName: TELEMETRY_TABLE,
    FilterExpression: '#ts > :cutoff AND data_type = :data_type AND attribute_exists(latitude)',
    ExpressionAttributeNames: {
      '#ts': 'timestamp',
    },
    ExpressionAttributeValues: {
      ':cutoff': cutoffTime,
      ':data_type': 'telemetry',
    },
    Limit: limit * 2,
  });

  const result = await docClient.send(command);
  return result.Items || [];
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
