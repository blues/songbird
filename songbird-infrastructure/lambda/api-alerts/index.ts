/**
 * Alerts API Lambda
 *
 * Handles alert operations:
 * - GET /alerts - List all alerts (with optional filters)
 * - GET /alerts/{alert_id} - Get single alert
 * - POST /alerts/{alert_id}/acknowledge - Acknowledge an alert
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  QueryCommand,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const ALERTS_TABLE = process.env.ALERTS_TABLE!;
const DEVICE_ALIASES_TABLE = process.env.DEVICE_ALIASES_TABLE || 'songbird-device-aliases';

/**
 * Get all device_uids associated with a serial number
 */
async function getAllDeviceUidsForSerial(serialNumber: string): Promise<string[]> {
  const result = await docClient.send(new GetCommand({
    TableName: DEVICE_ALIASES_TABLE,
    Key: { serial_number: serialNumber },
  }));

  if (!result.Item) {
    return [];
  }

  // Return current device_uid plus any historical ones
  const deviceUids = [result.Item.device_uid];
  if (result.Item.previous_device_uids && Array.isArray(result.Item.previous_device_uids)) {
    deviceUids.push(...result.Item.previous_device_uids);
  }
  return deviceUids;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Request:', JSON.stringify(event));

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };

  try {
    const method = (event.requestContext as any)?.http?.method || event.httpMethod;
    const alertId = event.pathParameters?.alert_id;
    const path = event.rawPath || event.path || '';

    if (method === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    // POST /alerts/{alert_id}/acknowledge
    if (method === 'POST' && alertId && path.endsWith('/acknowledge')) {
      return await acknowledgeAlert(alertId, event, corsHeaders);
    }

    // GET /alerts/{alert_id}
    if (method === 'GET' && alertId) {
      return await getAlert(alertId, corsHeaders);
    }

    // GET /alerts
    if (method === 'GET' && !alertId) {
      return await listAlerts(event, corsHeaders);
    }

    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Method not allowed' }),
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

async function listAlerts(
  event: APIGatewayProxyEvent,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const queryParams = event.queryStringParameters || {};
  const serialNumber = queryParams.serial_number || queryParams.device_uid; // Support both for backwards compat
  const acknowledged = queryParams.acknowledged;
  const limit = parseInt(queryParams.limit || '100');

  let items: any[] = [];

  if (serialNumber) {
    // Resolve serial number to device_uid(s)
    const deviceUids = await getAllDeviceUidsForSerial(serialNumber);

    if (deviceUids.length === 0) {
      // No device found for this serial number
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          alerts: [],
          count: 0,
          active_count: 0,
        }),
      };
    }

    // Query alerts for all device_uids and merge
    const allResults = await Promise.all(
      deviceUids.map(async (deviceUid) => {
        const command = new QueryCommand({
          TableName: ALERTS_TABLE,
          IndexName: 'device-index',
          KeyConditionExpression: 'device_uid = :device_uid',
          ExpressionAttributeValues: { ':device_uid': deviceUid },
          ScanIndexForward: false,
          Limit: limit,
        });
        const result = await docClient.send(command);
        return result.Items || [];
      })
    );

    // Merge and sort by created_at descending
    items = allResults.flat().sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    items = items.slice(0, limit);
  } else if (acknowledged === 'false') {
    // Query only unacknowledged alerts
    const command = new QueryCommand({
      TableName: ALERTS_TABLE,
      IndexName: 'status-index',
      KeyConditionExpression: 'acknowledged = :ack',
      ExpressionAttributeValues: { ':ack': 'false' },
      ScanIndexForward: false,
      Limit: limit,
    });

    const result = await docClient.send(command);
    items = result.Items || [];
  } else {
    // Scan all alerts
    const command = new ScanCommand({
      TableName: ALERTS_TABLE,
      Limit: limit,
    });

    const result = await docClient.send(command);
    items = result.Items || [];

    // Sort by created_at descending
    items.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  }

  // Calculate stats
  const activeCount = items.filter(a => a.acknowledged === 'false').length;

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      alerts: items,
      count: items.length,
      active_count: activeCount,
    }),
  };
}

async function getAlert(
  alertId: string,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const command = new GetCommand({
    TableName: ALERTS_TABLE,
    Key: { alert_id: alertId },
  });

  const result = await docClient.send(command);

  if (!result.Item) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Alert not found' }),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(result.Item),
  };
}

async function acknowledgeAlert(
  alertId: string,
  event: APIGatewayProxyEvent,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const now = Date.now();

  // Parse body for optional acknowledgment details
  let acknowledgedBy = 'system';
  if (event.body) {
    try {
      const body = JSON.parse(event.body);
      acknowledgedBy = body.acknowledged_by || 'system';
    } catch {
      // Ignore parse errors
    }
  }

  const command = new UpdateCommand({
    TableName: ALERTS_TABLE,
    Key: { alert_id: alertId },
    UpdateExpression: 'SET acknowledged = :ack, acknowledged_at = :ack_at, acknowledged_by = :ack_by',
    ExpressionAttributeValues: {
      ':ack': 'true',
      ':ack_at': now,
      ':ack_by': acknowledgedBy,
    },
    ReturnValues: 'ALL_NEW',
  });

  const result = await docClient.send(command);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(result.Attributes),
  };
}
