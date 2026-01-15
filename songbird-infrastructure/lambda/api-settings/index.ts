/**
 * API Settings Lambda
 *
 * Handles fleet defaults settings CRUD operations.
 * Admin-only endpoints are protected by checking JWT cognito:groups claim.
 *
 * Fleet defaults are saved to:
 * 1. DynamoDB (for dashboard UI)
 * 2. Notehub fleet environment variables (so devices receive the config)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const secretsClient = new SecretsManagerClient({});

const SETTINGS_TABLE = process.env.SETTINGS_TABLE || 'songbird-settings';
const NOTEHUB_PROJECT_UID = process.env.NOTEHUB_PROJECT_UID;
const NOTEHUB_SECRET_ARN = process.env.NOTEHUB_SECRET_ARN;

// Cache the Notehub token
let cachedNotehubToken: string | null = null;

async function getNotehubToken(): Promise<string | null> {
  if (!NOTEHUB_SECRET_ARN) {
    console.warn('NOTEHUB_SECRET_ARN not configured');
    return null;
  }

  if (cachedNotehubToken) {
    return cachedNotehubToken;
  }

  try {
    const command = new GetSecretValueCommand({ SecretId: NOTEHUB_SECRET_ARN });
    const response = await secretsClient.send(command);

    if (!response.SecretString) {
      console.error('Notehub API token not found in secret');
      return null;
    }

    const secret = JSON.parse(response.SecretString);
    cachedNotehubToken = secret.token;
    return cachedNotehubToken;
  } catch (error) {
    console.error('Error fetching Notehub token:', error);
    return null;
  }
}

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
};

interface FleetDefaults {
  mode?: string;
  gps_interval_min?: number;
  sync_interval_min?: number;
  heartbeat_hours?: number;
  temp_alert_high_c?: number;
  temp_alert_low_c?: number;
  humidity_alert_high?: number;
  humidity_alert_low?: number;
  voltage_alert_low?: number;
  motion_sensitivity?: string;
  audio_enabled?: boolean;
  led_enabled?: boolean;
  // GPS Power Management (actively manages GPS based on signal)
  gps_power_save_enabled?: boolean;
  gps_signal_timeout_min?: number;
  gps_retry_interval_min?: number;
}

// Validation schema for fleet defaults
const fleetDefaultsSchema: Record<string, { type: string; min?: number; max?: number; values?: string[] }> = {
  mode: { type: 'string', values: ['demo', 'transit', 'storage', 'sleep'] },
  gps_interval_min: { type: 'number', min: 1, max: 1440 },
  sync_interval_min: { type: 'number', min: 1, max: 1440 },
  heartbeat_hours: { type: 'number', min: 1, max: 168 },
  temp_alert_high_c: { type: 'number', min: -40, max: 85 },
  temp_alert_low_c: { type: 'number', min: -40, max: 85 },
  humidity_alert_high: { type: 'number', min: 0, max: 100 },
  humidity_alert_low: { type: 'number', min: 0, max: 100 },
  voltage_alert_low: { type: 'number', min: 3.0, max: 4.2 },
  motion_sensitivity: { type: 'string', values: ['low', 'medium', 'high'] },
  audio_enabled: { type: 'boolean' },
  led_enabled: { type: 'boolean' },
  // GPS Power Management (actively manages GPS based on signal)
  gps_power_save_enabled: { type: 'boolean' },
  gps_signal_timeout_min: { type: 'number', min: 10, max: 30 },
  gps_retry_interval_min: { type: 'number', min: 5, max: 120 },
};

function isAdmin(event: APIGatewayProxyEventV2WithJWTAuthorizer): boolean {
  try {
    const claims = event.requestContext?.authorizer?.jwt?.claims;
    if (!claims) return false;

    // cognito:groups is either a string or array depending on number of groups
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
 * Push fleet defaults to Notehub as fleet environment variables
 * This makes the config available to all devices in the fleet
 */
async function pushToNotehub(fleetUid: string, config: FleetDefaults): Promise<{ success: boolean; error?: string }> {
  if (!NOTEHUB_PROJECT_UID) {
    console.warn('NOTEHUB_PROJECT_UID not configured, skipping Notehub push');
    return { success: false, error: 'Notehub not configured' };
  }

  const token = await getNotehubToken();
  if (!token) {
    return { success: false, error: 'Could not get Notehub token' };
  }

  // Convert config values to strings for Notehub environment variables
  const envVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined && value !== null) {
      envVars[key] = String(value);
    }
  }

  try {
    const response = await fetch(
      `https://api.notefile.net/v1/projects/${NOTEHUB_PROJECT_UID}/fleets/${fleetUid}/environment_variables`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ environment_variables: envVars }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Notehub API error:', response.status, errorText);
      return { success: false, error: `Notehub API error: ${response.status}` };
    }

    console.log(`Successfully pushed fleet defaults to Notehub for fleet ${fleetUid}`);
    return { success: true };
  } catch (error) {
    console.error('Error pushing to Notehub:', error);
    return { success: false, error: String(error) };
  }
}

function validateFleetDefaults(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const [key, value] of Object.entries(config)) {
    const schema = fleetDefaultsSchema[key];
    if (!schema) {
      errors.push(`Unknown setting: ${key}`);
      continue;
    }

    if (schema.type === 'number') {
      if (typeof value !== 'number') {
        errors.push(`${key} must be a number`);
        continue;
      }
      if (schema.min !== undefined && value < schema.min) {
        errors.push(`${key} must be at least ${schema.min}`);
      }
      if (schema.max !== undefined && value > schema.max) {
        errors.push(`${key} must be at most ${schema.max}`);
      }
    } else if (schema.type === 'string') {
      if (typeof value !== 'string') {
        errors.push(`${key} must be a string`);
        continue;
      }
      if (schema.values && !schema.values.includes(value)) {
        errors.push(`${key} must be one of: ${schema.values.join(', ')}`);
      }
    } else if (schema.type === 'boolean') {
      if (typeof value !== 'boolean') {
        errors.push(`${key} must be a boolean`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  console.log('Event:', JSON.stringify(event, null, 2));

  const method = event.requestContext.http.method;
  const path = event.rawPath;

  // Handle OPTIONS for CORS
  if (method === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    // GET /v1/settings/fleet-defaults - List all fleet defaults (admin only)
    if (method === 'GET' && path === '/v1/settings/fleet-defaults') {
      if (!isAdmin(event)) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Admin access required' }),
        };
      }

      const result = await docClient.send(new QueryCommand({
        TableName: SETTINGS_TABLE,
        KeyConditionExpression: 'setting_type = :type',
        ExpressionAttributeValues: {
          ':type': 'fleet_defaults',
        },
      }));

      const fleetDefaults = (result.Items || []).map((item: Record<string, unknown>) => ({
        fleet_uid: item.setting_id,
        ...(item.config as Record<string, unknown> || {}),
        updated_at: item.updated_at,
        updated_by: item.updated_by,
      }));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ fleet_defaults: fleetDefaults }),
      };
    }

    // GET /v1/settings/fleet-defaults/{fleet} - Get specific fleet defaults
    if (method === 'GET' && path.startsWith('/v1/settings/fleet-defaults/')) {
      const fleetUid = event.pathParameters?.fleet;
      if (!fleetUid) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Fleet UID required' }),
        };
      }

      const result = await docClient.send(new GetCommand({
        TableName: SETTINGS_TABLE,
        Key: {
          setting_type: 'fleet_defaults',
          setting_id: fleetUid,
        },
      }));

      if (!result.Item) {
        // Return empty defaults if none set
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            fleet_uid: fleetUid,
            config: {},
            schema: fleetDefaultsSchema,
          }),
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          fleet_uid: fleetUid,
          config: result.Item.config || {},
          schema: fleetDefaultsSchema,
          updated_at: result.Item.updated_at,
          updated_by: result.Item.updated_by,
        }),
      };
    }

    // PUT /v1/settings/fleet-defaults/{fleet} - Update fleet defaults (admin only)
    if (method === 'PUT' && path.startsWith('/v1/settings/fleet-defaults/')) {
      if (!isAdmin(event)) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Admin access required' }),
        };
      }

      const fleetUid = event.pathParameters?.fleet;
      if (!fleetUid) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Fleet UID required' }),
        };
      }

      let config: FleetDefaults;
      try {
        config = JSON.parse(event.body || '{}');
      } catch {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Invalid JSON body' }),
        };
      }

      // Validate config
      const validation = validateFleetDefaults(config as Record<string, unknown>);
      if (!validation.valid) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Validation failed', details: validation.errors }),
        };
      }

      // Get user info from JWT claims
      const claims = event.requestContext?.authorizer?.jwt?.claims;
      const userEmail = claims?.email || claims?.sub || 'unknown';

      // Store settings in DynamoDB (for dashboard UI)
      await docClient.send(new PutCommand({
        TableName: SETTINGS_TABLE,
        Item: {
          setting_type: 'fleet_defaults',
          setting_id: fleetUid,
          config,
          updated_at: Date.now(),
          updated_by: userEmail,
        },
      }));

      // Push to Notehub as fleet environment variables (so devices receive the config)
      const notehubResult = await pushToNotehub(fleetUid, config);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          fleet_uid: fleetUid,
          config,
          updated_at: Date.now(),
          updated_by: userEmail,
          notehub_sync: notehubResult.success,
          notehub_error: notehubResult.error,
        }),
      };
    }

    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Not found' }),
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}
