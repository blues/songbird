/**
 * Config API Lambda
 *
 * Manages device configuration via Notehub environment variables:
 * - GET /devices/{device_uid}/config - Get current config
 * - PUT /devices/{device_uid}/config - Update config
 * - PUT /fleets/{fleet_uid}/config - Update fleet-wide config
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const NOTEHUB_PROJECT_UID = process.env.NOTEHUB_PROJECT_UID!;
const NOTEHUB_API_TOKEN = process.env.NOTEHUB_API_TOKEN!;

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

    const deviceUid = event.pathParameters?.device_uid;
    const fleetUid = event.pathParameters?.fleet_uid;

    if (method === 'GET' && deviceUid) {
      return await getDeviceConfig(deviceUid, corsHeaders);
    }

    if (method === 'PUT' && deviceUid) {
      return await updateDeviceConfig(deviceUid, event.body, corsHeaders);
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
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  try {
    // Get environment variables from Notehub
    const response = await fetch(
      `https://api.notefile.net/v1/projects/${NOTEHUB_PROJECT_UID}/devices/${deviceUid}/environment_variables`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${NOTEHUB_API_TOKEN}`,
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

    const data = await response.json();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        device_uid: deviceUid,
        config: data.environment_variables || {},
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
    const response = await fetch(
      `https://api.notefile.net/v1/projects/${NOTEHUB_PROJECT_UID}/devices/${deviceUid}/environment_variables`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${NOTEHUB_API_TOKEN}`,
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
    const response = await fetch(
      `https://api.notefile.net/v1/projects/${NOTEHUB_PROJECT_UID}/fleets/${fleetUid}/environment_variables`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${NOTEHUB_API_TOKEN}`,
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

function validateConfig(config: Record<string, any>): string[] {
  const errors: string[] = [];

  for (const [key, value] of Object.entries(config)) {
    const schema = CONFIG_SCHEMA[key];

    if (!schema) {
      errors.push(`Unknown configuration key: ${key}`);
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
    result[key] = String(value);
  }

  return result;
}
