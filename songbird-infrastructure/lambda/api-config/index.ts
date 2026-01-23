/**
 * Config API Lambda
 *
 * Manages device configuration via Notehub environment variables:
 * - GET /devices/{serial_number}/config - Get current config
 * - PUT /devices/{serial_number}/config - Update config
 * - PUT /devices/{serial_number}/wifi - Set device Wi-Fi credentials
 * - PUT /fleets/{fleet_uid}/config - Update fleet-wide config
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const secretsClient = new SecretsManagerClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const NOTEHUB_PROJECT_UID = process.env.NOTEHUB_PROJECT_UID!;
const NOTEHUB_SECRET_ARN = process.env.NOTEHUB_SECRET_ARN!;
const DEVICE_ALIASES_TABLE = process.env.DEVICE_ALIASES_TABLE || 'songbird-device-aliases';

/**
 * Resolve serial number to device_uid using the aliases table
 */
async function resolveDeviceUid(serialNumber: string): Promise<string | null> {
  const result = await docClient.send(new GetCommand({
    TableName: DEVICE_ALIASES_TABLE,
    Key: { serial_number: serialNumber },
  }));

  return result.Item?.device_uid || null;
}

// Cache the token to avoid fetching on every request
let cachedToken: string | null = null;

async function getNotehubToken(): Promise<string> {
  if (cachedToken) {
    return cachedToken;
  }

  const command = new GetSecretValueCommand({ SecretId: NOTEHUB_SECRET_ARN });
  const response = await secretsClient.send(command);

  if (!response.SecretString) {
    throw new Error('Notehub API token not found in secret');
  }

  const secret = JSON.parse(response.SecretString);
  cachedToken = secret.token;

  if (!cachedToken) {
    throw new Error('Token field not found in secret');
  }

  return cachedToken;
}

// Valid configuration keys and their types
const CONFIG_SCHEMA: Record<string, { type: string; min?: number; max?: number; values?: string[] }> = {
  mode: { type: 'string', values: ['demo', 'transit', 'storage', 'sleep'] },
  gps_interval_min: { type: 'number', min: 1, max: 1440 },
  sync_interval_min: { type: 'number', min: 1, max: 1440 },
  heartbeat_hours: { type: 'number', min: 1, max: 168 },
  temp_alert_high_c: { type: 'number', min: -40, max: 85 },
  temp_alert_low_c: { type: 'number', min: -40, max: 85 },
  humidity_alert_high: { type: 'number', min: 0, max: 100 },
  humidity_alert_low: { type: 'number', min: 0, max: 100 },
  pressure_alert_delta: { type: 'number', min: 1, max: 100 },
  voltage_alert_low: { type: 'number', min: 3.0, max: 4.2 },
  motion_sensitivity: { type: 'string', values: ['low', 'medium', 'high'] },
  motion_wake_enabled: { type: 'boolean' },
  audio_enabled: { type: 'boolean' },
  audio_volume: { type: 'number', min: 0, max: 100 },
  audio_alerts_only: { type: 'boolean' },
  cmd_wake_enabled: { type: 'boolean' },
  cmd_ack_enabled: { type: 'boolean' },
  locate_duration_sec: { type: 'number', min: 5, max: 300 },
  led_enabled: { type: 'boolean' },
  debug_mode: { type: 'boolean' },
  // GPS Power Management (Transit Mode)
  // Actively manages GPS power based on signal acquisition
  gps_power_save_enabled: { type: 'boolean' },
  gps_signal_timeout_min: { type: 'number', min: 10, max: 30 },
  gps_retry_interval_min: { type: 'number', min: 5, max: 120 },
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Request:', JSON.stringify(event));

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
  };

  try {
    // HTTP API v2 uses requestContext.http.method, REST API v1 uses httpMethod
    const method = (event.requestContext as any)?.http?.method || event.httpMethod;

    if (method === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    const serialNumber = event.pathParameters?.serial_number;
    const fleetUid = event.pathParameters?.fleet_uid;
    const path = event.path || (event.requestContext as any)?.http?.path || '';
    const isWifiEndpoint = path.endsWith('/wifi');

    if ((method === 'GET' || method === 'PUT') && serialNumber) {
      // Resolve serial number to device_uid
      const deviceUid = await resolveDeviceUid(serialNumber);
      if (!deviceUid) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'Device not found for serial number' }),
        };
      }

      if (method === 'GET') {
        return await getDeviceConfig(deviceUid, serialNumber, corsHeaders);
      } else if (method === 'PUT' && isWifiEndpoint) {
        return await setDeviceWifi(deviceUid, serialNumber, event.body, corsHeaders);
      } else {
        return await updateDeviceConfig(deviceUid, serialNumber, event.body, corsHeaders);
      }
    }

    if (method === 'PUT' && fleetUid) {
      return await updateFleetConfig(fleetUid, event.body, corsHeaders);
    }

    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Invalid request' }),
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

async function getDeviceConfig(
  deviceUid: string,
  serialNumber: string,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  try {
    // Get environment variables from Notehub
    const notehubToken = await getNotehubToken();
    const response = await fetch(
      `https://api.notefile.net/v1/projects/${NOTEHUB_PROJECT_UID}/devices/${deviceUid}/environment_variables`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${notehubToken}`,
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Notehub API error:', errorText);

      return {
        statusCode: response.status === 404 ? 404 : 502,
        headers,
        body: JSON.stringify({ error: 'Failed to fetch config from Notehub' }),
      };
    }

    const data = await response.json() as { environment_variables?: Record<string, string> };
    const rawConfig = data.environment_variables || {};
    const parsedConfig = parseConfigValues(rawConfig);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        serial_number: serialNumber,
        device_uid: deviceUid,
        config: parsedConfig,
        schema: CONFIG_SCHEMA,
      }),
    };
  } catch (error) {
    console.error('Error fetching config:', error);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'Failed to communicate with Notehub' }),
    };
  }
}

async function updateDeviceConfig(
  deviceUid: string,
  serialNumber: string,
  body: string | null,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  if (!body) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Request body required' }),
    };
  }

  const updates = JSON.parse(body);

  // Validate configuration values
  const validationErrors = validateConfig(updates);
  if (validationErrors.length > 0) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid configuration', errors: validationErrors }),
    };
  }

  try {
    // Update environment variables in Notehub
    const notehubToken = await getNotehubToken();
    const response = await fetch(
      `https://api.notefile.net/v1/projects/${NOTEHUB_PROJECT_UID}/devices/${deviceUid}/environment_variables`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${notehubToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ environment_variables: stringifyValues(updates) }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Notehub API error:', errorText);

      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'Failed to update config in Notehub' }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        serial_number: serialNumber,
        device_uid: deviceUid,
        config: updates,
        message: 'Configuration updated. Changes will take effect on next device sync.',
      }),
    };
  } catch (error) {
    console.error('Error updating config:', error);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'Failed to communicate with Notehub' }),
    };
  }
}

async function updateFleetConfig(
  fleetUid: string,
  body: string | null,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  if (!body) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Request body required' }),
    };
  }

  const updates = JSON.parse(body);

  // Validate configuration values
  const validationErrors = validateConfig(updates);
  if (validationErrors.length > 0) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid configuration', errors: validationErrors }),
    };
  }

  try {
    // Update fleet environment variables in Notehub
    const notehubToken = await getNotehubToken();
    const response = await fetch(
      `https://api.notefile.net/v1/projects/${NOTEHUB_PROJECT_UID}/fleets/${fleetUid}/environment_variables`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${notehubToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ environment_variables: stringifyValues(updates) }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Notehub API error:', errorText);

      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'Failed to update fleet config in Notehub' }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        fleet_uid: fleetUid,
        config: updates,
        message: 'Fleet configuration updated. Changes will take effect on next device sync.',
      }),
    };
  } catch (error) {
    console.error('Error updating fleet config:', error);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'Failed to communicate with Notehub' }),
    };
  }
}

/**
 * Set device Wi-Fi credentials via the _wifi environment variable
 * Format: ["SSID","PASSWORD"]
 */
async function setDeviceWifi(
  deviceUid: string,
  serialNumber: string,
  body: string | null,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  if (!body) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Request body required' }),
    };
  }

  const { ssid, password } = JSON.parse(body);

  // Validate inputs
  if (!ssid || typeof ssid !== 'string' || ssid.trim() === '') {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'SSID is required' }),
    };
  }

  if (password === undefined || password === null) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Password is required (can be empty string for open networks)' }),
    };
  }

  // Format the _wifi value as per Notehub documentation: ["SSID","PASSWORD"]
  const wifiValue = `["${ssid}","${password}"]`;

  try {
    const notehubToken = await getNotehubToken();
    const response = await fetch(
      `https://api.notefile.net/v1/projects/${NOTEHUB_PROJECT_UID}/devices/${deviceUid}/environment_variables`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${notehubToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ environment_variables: { _wifi: wifiValue } }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Notehub API error:', errorText);

      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'Failed to set Wi-Fi credentials in Notehub' }),
      };
    }

    // Don't log password
    console.log(`Wi-Fi credentials set for device ${serialNumber} (SSID: ${ssid})`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        serial_number: serialNumber,
        message: 'Wi-Fi credentials set. Changes will take effect on next device sync.',
      }),
    };
  } catch (error) {
    console.error('Error setting Wi-Fi credentials:', error);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'Failed to communicate with Notehub' }),
    };
  }
}

function validateConfig(config: Record<string, any>): string[] {
  const errors: string[] = [];

  for (const [key, value] of Object.entries(config)) {
    const schema = CONFIG_SCHEMA[key];

    // Skip unknown keys - they will be filtered out in stringifyValues
    if (!schema) {
      continue;
    }

    if (schema.type === 'number') {
      const numValue = typeof value === 'string' ? parseFloat(value) : value;
      if (isNaN(numValue)) {
        errors.push(`${key} must be a number`);
      } else {
        if (schema.min !== undefined && numValue < schema.min) {
          errors.push(`${key} must be >= ${schema.min}`);
        }
        if (schema.max !== undefined && numValue > schema.max) {
          errors.push(`${key} must be <= ${schema.max}`);
        }
      }
    }

    if (schema.type === 'string' && schema.values) {
      if (!schema.values.includes(value)) {
        errors.push(`${key} must be one of: ${schema.values.join(', ')}`);
      }
    }

    if (schema.type === 'boolean') {
      const boolValue = typeof value === 'string' ? value === 'true' : value;
      if (typeof boolValue !== 'boolean') {
        errors.push(`${key} must be a boolean`);
      }
    }
  }

  return errors;
}

function stringifyValues(config: Record<string, any>): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(config)) {
    // Only include keys that are in our schema
    if (CONFIG_SCHEMA[key]) {
      result[key] = String(value);
    }
  }

  return result;
}

function parseConfigValues(config: Record<string, string>): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(config)) {
    const schema = CONFIG_SCHEMA[key];

    if (!schema) {
      // Keep unknown keys as-is
      result[key] = value;
      continue;
    }

    // Parse based on expected type
    if (schema.type === 'boolean') {
      result[key] = value === 'true';
    } else if (schema.type === 'number') {
      const numValue = parseFloat(value);
      result[key] = isNaN(numValue) ? value : numValue;
    } else {
      result[key] = value;
    }
  }

  return result;
}
