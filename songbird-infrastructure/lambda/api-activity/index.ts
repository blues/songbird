/**
 * Activity Feed API Lambda
 *
 * Returns a unified activity feed combining:
 * - Alerts (from alerts table)
 * - Health events (from telemetry table)
 * - Commands (from commands table)
 * - Journey start/end events (from journeys table)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const TELEMETRY_TABLE = process.env.TELEMETRY_TABLE!;
const ALERTS_TABLE = process.env.ALERTS_TABLE!;
const DEVICES_TABLE = process.env.DEVICES_TABLE!;
const COMMANDS_TABLE = process.env.COMMANDS_TABLE!;
const JOURNEYS_TABLE = process.env.JOURNEYS_TABLE!;

interface ActivityItem {
  id: string;
  type: 'alert' | 'health' | 'command' | 'journey' | 'mode_change';
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
    const [alerts, healthEvents, commands, journeys, modeChanges, devices] = await Promise.all([
      getRecentAlerts(hours, limit),
      getRecentHealthEvents(hours, limit),
      getRecentCommands(hours, limit),
      getRecentJourneys(hours, limit),
      getRecentModeChanges(hours, limit),
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

    // Transform commands to activity items
    const commandActivities: ActivityItem[] = commands.map((cmd) => ({
      id: `command-${cmd.command_id}`,
      type: 'command',
      device_uid: cmd.device_uid,
      device_name: deviceNames[cmd.device_uid],
      message: formatCommandMessage(cmd),
      timestamp: new Date(cmd.created_at).toISOString(),
      data: {
        cmd: cmd.cmd,
        status: cmd.status,
        ack_status: cmd.ack_status,
      },
    }));

    // Transform journeys to activity items (start and end events)
    const journeyActivities: ActivityItem[] = [];
    for (const journey of journeys) {
      // Journey start event
      journeyActivities.push({
        id: `journey-start-${journey.device_uid}-${journey.journey_id}`,
        type: 'journey',
        device_uid: journey.device_uid,
        device_name: deviceNames[journey.device_uid],
        message: 'Journey started',
        timestamp: new Date(journey.start_time).toISOString(),
        data: {
          journey_id: journey.journey_id,
          event: 'start',
        },
      });

      // Journey end event (only if completed)
      if (journey.status === 'completed' && journey.end_time) {
        journeyActivities.push({
          id: `journey-end-${journey.device_uid}-${journey.journey_id}`,
          type: 'journey',
          device_uid: journey.device_uid,
          device_name: deviceNames[journey.device_uid],
          message: formatJourneyEndMessage(journey),
          timestamp: new Date(journey.end_time).toISOString(),
          data: {
            journey_id: journey.journey_id,
            event: 'end',
            point_count: journey.point_count,
            total_distance: journey.total_distance,
          },
        });
      }
    }

    // Transform mode changes to activity items
    const modeChangeActivities: ActivityItem[] = modeChanges.map((change) => ({
      id: `mode-${change.device_uid}-${change.timestamp}`,
      type: 'mode_change',
      device_uid: change.device_uid,
      device_name: deviceNames[change.device_uid],
      message: formatModeChangeMessage(change),
      timestamp: new Date(change.timestamp).toISOString(),
      data: {
        previous_mode: change.previous_mode,
        new_mode: change.new_mode,
      },
    }));

    // Merge all activities and sort by timestamp (newest first)
    const allActivities = [...alertActivities, ...healthActivities, ...commandActivities, ...journeyActivities, ...modeChangeActivities]
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

async function getRecentCommands(hours: number, limit: number): Promise<any[]> {
  const cutoffTime = Date.now() - hours * 60 * 60 * 1000;
  const allItems: any[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;

  do {
    const command = new ScanCommand({
      TableName: COMMANDS_TABLE,
      FilterExpression: 'created_at > :cutoff',
      ExpressionAttributeValues: {
        ':cutoff': cutoffTime,
      },
      ExclusiveStartKey: lastEvaluatedKey,
    });

    const result = await docClient.send(command);
    allItems.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;

    if (allItems.length >= limit * 2) break;
  } while (lastEvaluatedKey);

  return allItems.slice(0, limit * 2);
}

async function getRecentJourneys(hours: number, limit: number): Promise<any[]> {
  const cutoffTime = Date.now() - hours * 60 * 60 * 1000;
  const allItems: any[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;

  do {
    const command = new ScanCommand({
      TableName: JOURNEYS_TABLE,
      FilterExpression: 'start_time > :cutoff',
      ExpressionAttributeValues: {
        ':cutoff': cutoffTime,
      },
      ExclusiveStartKey: lastEvaluatedKey,
    });

    const result = await docClient.send(command);
    allItems.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;

    if (allItems.length >= limit * 2) break;
  } while (lastEvaluatedKey);

  return allItems.slice(0, limit * 2);
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

function formatCommandMessage(cmd: any): string {
  const cmdLabels: Record<string, string> = {
    ping: 'Ping command',
    locate: 'Locate command',
    play_melody: 'Play melody command',
    test_audio: 'Test audio command',
    set_volume: 'Set volume command',
  };

  const label = cmdLabels[cmd.cmd] || cmd.cmd || 'Command';
  const statusLabels: Record<string, string> = {
    queued: 'queued',
    sent: 'sent',
    ok: 'acknowledged',
    error: 'failed',
    ignored: 'ignored',
  };

  const status = statusLabels[cmd.ack_status || cmd.status] || cmd.status;
  return `${label} ${status}`;
}

function formatJourneyEndMessage(journey: any): string {
  const distance = journey.total_distance || 0;
  const points = journey.point_count || 0;

  // Format distance in km or m
  let distanceStr: string;
  if (distance >= 1000) {
    distanceStr = `${(distance / 1000).toFixed(1)} km`;
  } else {
    distanceStr = `${Math.round(distance)} m`;
  }

  return `Journey ended: ${distanceStr}, ${points} points`;
}

async function getRecentModeChanges(hours: number, limit: number): Promise<any[]> {
  const cutoffTime = Date.now() - hours * 60 * 60 * 1000;
  const allItems: any[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;

  do {
    const command = new ScanCommand({
      TableName: TELEMETRY_TABLE,
      FilterExpression: '#ts > :cutoff AND data_type = :data_type',
      ExpressionAttributeNames: {
        '#ts': 'timestamp',
      },
      ExpressionAttributeValues: {
        ':cutoff': cutoffTime,
        ':data_type': 'mode_change',
      },
      ExclusiveStartKey: lastEvaluatedKey,
    });

    const result = await docClient.send(command);
    allItems.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;

    if (allItems.length >= limit * 2) break;
  } while (lastEvaluatedKey);

  return allItems.slice(0, limit * 2);
}

function formatModeChangeMessage(change: any): string {
  const modeLabels: Record<string, string> = {
    demo: 'Demo',
    transit: 'Transit',
    storage: 'Storage',
    sleep: 'Sleep',
  };

  const prevLabel = modeLabels[change.previous_mode] || change.previous_mode;
  const newLabel = modeLabels[change.new_mode] || change.new_mode;

  return `Mode changed: ${prevLabel} → ${newLabel}`;
}
