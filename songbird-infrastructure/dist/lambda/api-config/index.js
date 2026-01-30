"use strict";
/**
 * Config API Lambda
 *
 * Manages device configuration via Notehub environment variables:
 * - GET /devices/{serial_number}/config - Get current config
 * - PUT /devices/{serial_number}/config - Update config
 * - PUT /devices/{serial_number}/wifi - Set device Wi-Fi credentials
 * - PUT /fleets/{fleet_uid}/config - Update fleet-wide config
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_secrets_manager_1 = require("@aws-sdk/client-secrets-manager");
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const secretsClient = new client_secrets_manager_1.SecretsManagerClient({});
const dynamoClient = new client_dynamodb_1.DynamoDBClient({});
const docClient = lib_dynamodb_1.DynamoDBDocumentClient.from(dynamoClient);
const NOTEHUB_PROJECT_UID = process.env.NOTEHUB_PROJECT_UID;
const NOTEHUB_SECRET_ARN = process.env.NOTEHUB_SECRET_ARN;
const DEVICE_ALIASES_TABLE = process.env.DEVICE_ALIASES_TABLE || 'songbird-device-aliases';
/**
 * Resolve serial number to device_uid using the aliases table
 */
async function resolveDeviceUid(serialNumber) {
    const result = await docClient.send(new lib_dynamodb_1.GetCommand({
        TableName: DEVICE_ALIASES_TABLE,
        Key: { serial_number: serialNumber },
    }));
    return result.Item?.device_uid || null;
}
// Cache the token to avoid fetching on every request
let cachedToken = null;
async function getNotehubToken() {
    if (cachedToken) {
        return cachedToken;
    }
    const command = new client_secrets_manager_1.GetSecretValueCommand({ SecretId: NOTEHUB_SECRET_ARN });
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
const CONFIG_SCHEMA = {
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
const handler = async (event) => {
    console.log('Request:', JSON.stringify(event));
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
    };
    try {
        // HTTP API v2 uses requestContext.http.method, REST API v1 uses httpMethod
        const method = event.requestContext?.http?.method || event.httpMethod;
        if (method === 'OPTIONS') {
            return { statusCode: 200, headers: corsHeaders, body: '' };
        }
        const serialNumber = event.pathParameters?.serial_number;
        const fleetUid = event.pathParameters?.fleet_uid;
        const path = event.path || event.requestContext?.http?.path || '';
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
            }
            else if (method === 'PUT' && isWifiEndpoint) {
                return await setDeviceWifi(deviceUid, serialNumber, event.body, corsHeaders);
            }
            else {
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
    }
    catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: 'Internal server error' }),
        };
    }
};
exports.handler = handler;
async function getDeviceConfig(deviceUid, serialNumber, headers) {
    try {
        // Get environment variables from Notehub
        const notehubToken = await getNotehubToken();
        const response = await fetch(`https://api.notefile.net/v1/projects/${NOTEHUB_PROJECT_UID}/devices/${deviceUid}/environment_variables`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${notehubToken}`,
            },
        });
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
    }
    catch (error) {
        console.error('Error fetching config:', error);
        return {
            statusCode: 502,
            headers,
            body: JSON.stringify({ error: 'Failed to communicate with Notehub' }),
        };
    }
}
async function updateDeviceConfig(deviceUid, serialNumber, body, headers) {
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
        const response = await fetch(`https://api.notefile.net/v1/projects/${NOTEHUB_PROJECT_UID}/devices/${deviceUid}/environment_variables`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${notehubToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ environment_variables: stringifyValues(updates) }),
        });
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
    }
    catch (error) {
        console.error('Error updating config:', error);
        return {
            statusCode: 502,
            headers,
            body: JSON.stringify({ error: 'Failed to communicate with Notehub' }),
        };
    }
}
async function updateFleetConfig(fleetUid, body, headers) {
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
        const response = await fetch(`https://api.notefile.net/v1/projects/${NOTEHUB_PROJECT_UID}/fleets/${fleetUid}/environment_variables`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${notehubToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ environment_variables: stringifyValues(updates) }),
        });
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
    }
    catch (error) {
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
async function setDeviceWifi(deviceUid, serialNumber, body, headers) {
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
        const response = await fetch(`https://api.notefile.net/v1/projects/${NOTEHUB_PROJECT_UID}/devices/${deviceUid}/environment_variables`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${notehubToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ environment_variables: { _wifi: wifiValue } }),
        });
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
    }
    catch (error) {
        console.error('Error setting Wi-Fi credentials:', error);
        return {
            statusCode: 502,
            headers,
            body: JSON.stringify({ error: 'Failed to communicate with Notehub' }),
        };
    }
}
function validateConfig(config) {
    const errors = [];
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
            }
            else {
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
function stringifyValues(config) {
    const result = {};
    for (const [key, value] of Object.entries(config)) {
        // Only include keys that are in our schema
        if (CONFIG_SCHEMA[key]) {
            result[key] = String(value);
        }
    }
    return result;
}
function parseConfigValues(config) {
    const result = {};
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
        }
        else if (schema.type === 'number') {
            const numValue = parseFloat(value);
            result[key] = isNaN(numValue) ? value : numValue;
        }
        else {
            result[key] = value;
        }
    }
    return result;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWNvbmZpZy9pbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7O0dBUUc7OztBQUdILDRFQUE4RjtBQUM5Riw4REFBMEQ7QUFDMUQsd0RBQTJFO0FBRTNFLE1BQU0sYUFBYSxHQUFHLElBQUksNkNBQW9CLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDbkQsTUFBTSxZQUFZLEdBQUcsSUFBSSxnQ0FBYyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQzVDLE1BQU0sU0FBUyxHQUFHLHFDQUFzQixDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQztBQUU1RCxNQUFNLG1CQUFtQixHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW9CLENBQUM7QUFDN0QsTUFBTSxrQkFBa0IsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGtCQUFtQixDQUFDO0FBQzNELE1BQU0sb0JBQW9CLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxvQkFBb0IsSUFBSSx5QkFBeUIsQ0FBQztBQUUzRjs7R0FFRztBQUNILEtBQUssVUFBVSxnQkFBZ0IsQ0FBQyxZQUFvQjtJQUNsRCxNQUFNLE1BQU0sR0FBRyxNQUFNLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSx5QkFBVSxDQUFDO1FBQ2pELFNBQVMsRUFBRSxvQkFBb0I7UUFDL0IsR0FBRyxFQUFFLEVBQUUsYUFBYSxFQUFFLFlBQVksRUFBRTtLQUNyQyxDQUFDLENBQUMsQ0FBQztJQUVKLE9BQU8sTUFBTSxDQUFDLElBQUksRUFBRSxVQUFVLElBQUksSUFBSSxDQUFDO0FBQ3pDLENBQUM7QUFFRCxxREFBcUQ7QUFDckQsSUFBSSxXQUFXLEdBQWtCLElBQUksQ0FBQztBQUV0QyxLQUFLLFVBQVUsZUFBZTtJQUM1QixJQUFJLFdBQVcsRUFBRSxDQUFDO1FBQ2hCLE9BQU8sV0FBVyxDQUFDO0lBQ3JCLENBQUM7SUFFRCxNQUFNLE9BQU8sR0FBRyxJQUFJLDhDQUFxQixDQUFDLEVBQUUsUUFBUSxFQUFFLGtCQUFrQixFQUFFLENBQUMsQ0FBQztJQUM1RSxNQUFNLFFBQVEsR0FBRyxNQUFNLGFBQWEsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7SUFFbkQsSUFBSSxDQUFDLFFBQVEsQ0FBQyxZQUFZLEVBQUUsQ0FBQztRQUMzQixNQUFNLElBQUksS0FBSyxDQUFDLHVDQUF1QyxDQUFDLENBQUM7SUFDM0QsQ0FBQztJQUVELE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQyxDQUFDO0lBQ2pELFdBQVcsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDO0lBRTNCLElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQztRQUNqQixNQUFNLElBQUksS0FBSyxDQUFDLGlDQUFpQyxDQUFDLENBQUM7SUFDckQsQ0FBQztJQUVELE9BQU8sV0FBVyxDQUFDO0FBQ3JCLENBQUM7QUFFRCwyQ0FBMkM7QUFDM0MsTUFBTSxhQUFhLEdBQW9GO0lBQ3JHLElBQUksRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsTUFBTSxFQUFFLENBQUMsTUFBTSxFQUFFLFNBQVMsRUFBRSxTQUFTLEVBQUUsT0FBTyxDQUFDLEVBQUU7SUFDekUsZ0JBQWdCLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUUsR0FBRyxFQUFFLElBQUksRUFBRTtJQUN2RCxpQkFBaUIsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsR0FBRyxFQUFFLENBQUMsRUFBRSxHQUFHLEVBQUUsSUFBSSxFQUFFO0lBQ3hELGVBQWUsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsR0FBRyxFQUFFLENBQUMsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFO0lBQ3JELGlCQUFpQixFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxHQUFHLEVBQUUsQ0FBQyxFQUFFLEVBQUUsR0FBRyxFQUFFLEVBQUUsRUFBRTtJQUN4RCxnQkFBZ0IsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsR0FBRyxFQUFFLENBQUMsRUFBRSxFQUFFLEdBQUcsRUFBRSxFQUFFLEVBQUU7SUFDdkQsbUJBQW1CLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRTtJQUN6RCxrQkFBa0IsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsR0FBRyxFQUFFLENBQUMsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFO0lBQ3hELG9CQUFvQixFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxHQUFHLEVBQUUsQ0FBQyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUU7SUFDMUQsaUJBQWlCLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRTtJQUN6RCxrQkFBa0IsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsTUFBTSxFQUFFLENBQUMsS0FBSyxFQUFFLFFBQVEsRUFBRSxNQUFNLENBQUMsRUFBRTtJQUN6RSxtQkFBbUIsRUFBRSxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUU7SUFDeEMsYUFBYSxFQUFFLEVBQUUsSUFBSSxFQUFFLFNBQVMsRUFBRTtJQUNsQyxZQUFZLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRTtJQUNsRCxpQkFBaUIsRUFBRSxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUU7SUFDdEMsZ0JBQWdCLEVBQUUsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFO0lBQ3JDLGVBQWUsRUFBRSxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUU7SUFDcEMsbUJBQW1CLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRTtJQUN6RCxXQUFXLEVBQUUsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFO0lBQ2hDLFVBQVUsRUFBRSxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUU7SUFDL0Isc0NBQXNDO0lBQ3RDLHlEQUF5RDtJQUN6RCxzQkFBc0IsRUFBRSxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUU7SUFDM0Msc0JBQXNCLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLEdBQUcsRUFBRSxFQUFFLEVBQUUsR0FBRyxFQUFFLEVBQUUsRUFBRTtJQUM1RCxzQkFBc0IsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsR0FBRyxFQUFFLENBQUMsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFO0NBQzdELENBQUM7QUFFSyxNQUFNLE9BQU8sR0FBRyxLQUFLLEVBQUUsS0FBMkIsRUFBa0MsRUFBRTtJQUMzRixPQUFPLENBQUMsR0FBRyxDQUFDLFVBQVUsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFFL0MsTUFBTSxXQUFXLEdBQUc7UUFDbEIsNkJBQTZCLEVBQUUsR0FBRztRQUNsQyw4QkFBOEIsRUFBRSw0QkFBNEI7UUFDNUQsOEJBQThCLEVBQUUsaUJBQWlCO0tBQ2xELENBQUM7SUFFRixJQUFJLENBQUM7UUFDSCwyRUFBMkU7UUFDM0UsTUFBTSxNQUFNLEdBQUksS0FBSyxDQUFDLGNBQXNCLEVBQUUsSUFBSSxFQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsVUFBVSxDQUFDO1FBRS9FLElBQUksTUFBTSxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQ3pCLE9BQU8sRUFBRSxVQUFVLEVBQUUsR0FBRyxFQUFFLE9BQU8sRUFBRSxXQUFXLEVBQUUsSUFBSSxFQUFFLEVBQUUsRUFBRSxDQUFDO1FBQzdELENBQUM7UUFFRCxNQUFNLFlBQVksR0FBRyxLQUFLLENBQUMsY0FBYyxFQUFFLGFBQWEsQ0FBQztRQUN6RCxNQUFNLFFBQVEsR0FBRyxLQUFLLENBQUMsY0FBYyxFQUFFLFNBQVMsQ0FBQztRQUNqRCxNQUFNLElBQUksR0FBRyxLQUFLLENBQUMsSUFBSSxJQUFLLEtBQUssQ0FBQyxjQUFzQixFQUFFLElBQUksRUFBRSxJQUFJLElBQUksRUFBRSxDQUFDO1FBQzNFLE1BQU0sY0FBYyxHQUFHLElBQUksQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLENBQUM7UUFFOUMsSUFBSSxDQUFDLE1BQU0sS0FBSyxLQUFLLElBQUksTUFBTSxLQUFLLEtBQUssQ0FBQyxJQUFJLFlBQVksRUFBRSxDQUFDO1lBQzNELHNDQUFzQztZQUN0QyxNQUFNLFNBQVMsR0FBRyxNQUFNLGdCQUFnQixDQUFDLFlBQVksQ0FBQyxDQUFDO1lBQ3ZELElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQztnQkFDZixPQUFPO29CQUNMLFVBQVUsRUFBRSxHQUFHO29CQUNmLE9BQU8sRUFBRSxXQUFXO29CQUNwQixJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSxvQ0FBb0MsRUFBRSxDQUFDO2lCQUN0RSxDQUFDO1lBQ0osQ0FBQztZQUVELElBQUksTUFBTSxLQUFLLEtBQUssRUFBRSxDQUFDO2dCQUNyQixPQUFPLE1BQU0sZUFBZSxDQUFDLFNBQVMsRUFBRSxZQUFZLEVBQUUsV0FBVyxDQUFDLENBQUM7WUFDckUsQ0FBQztpQkFBTSxJQUFJLE1BQU0sS0FBSyxLQUFLLElBQUksY0FBYyxFQUFFLENBQUM7Z0JBQzlDLE9BQU8sTUFBTSxhQUFhLENBQUMsU0FBUyxFQUFFLFlBQVksRUFBRSxLQUFLLENBQUMsSUFBSSxFQUFFLFdBQVcsQ0FBQyxDQUFDO1lBQy9FLENBQUM7aUJBQU0sQ0FBQztnQkFDTixPQUFPLE1BQU0sa0JBQWtCLENBQUMsU0FBUyxFQUFFLFlBQVksRUFBRSxLQUFLLENBQUMsSUFBSSxFQUFFLFdBQVcsQ0FBQyxDQUFDO1lBQ3BGLENBQUM7UUFDSCxDQUFDO1FBRUQsSUFBSSxNQUFNLEtBQUssS0FBSyxJQUFJLFFBQVEsRUFBRSxDQUFDO1lBQ2pDLE9BQU8sTUFBTSxpQkFBaUIsQ0FBQyxRQUFRLEVBQUUsS0FBSyxDQUFDLElBQUksRUFBRSxXQUFXLENBQUMsQ0FBQztRQUNwRSxDQUFDO1FBRUQsT0FBTztZQUNMLFVBQVUsRUFBRSxHQUFHO1lBQ2YsT0FBTyxFQUFFLFdBQVc7WUFDcEIsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxLQUFLLEVBQUUsaUJBQWlCLEVBQUUsQ0FBQztTQUNuRCxDQUFDO0lBQ0osQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDZixPQUFPLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUMvQixPQUFPO1lBQ0wsVUFBVSxFQUFFLEdBQUc7WUFDZixPQUFPLEVBQUUsV0FBVztZQUNwQixJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSx1QkFBdUIsRUFBRSxDQUFDO1NBQ3pELENBQUM7SUFDSixDQUFDO0FBQ0gsQ0FBQyxDQUFDO0FBM0RXLFFBQUEsT0FBTyxXQTJEbEI7QUFFRixLQUFLLFVBQVUsZUFBZSxDQUM1QixTQUFpQixFQUNqQixZQUFvQixFQUNwQixPQUErQjtJQUUvQixJQUFJLENBQUM7UUFDSCx5Q0FBeUM7UUFDekMsTUFBTSxZQUFZLEdBQUcsTUFBTSxlQUFlLEVBQUUsQ0FBQztRQUM3QyxNQUFNLFFBQVEsR0FBRyxNQUFNLEtBQUssQ0FDMUIsd0NBQXdDLG1CQUFtQixZQUFZLFNBQVMsd0JBQXdCLEVBQ3hHO1lBQ0UsTUFBTSxFQUFFLEtBQUs7WUFDYixPQUFPLEVBQUU7Z0JBQ1AsZUFBZSxFQUFFLFVBQVUsWUFBWSxFQUFFO2FBQzFDO1NBQ0YsQ0FDRixDQUFDO1FBRUYsSUFBSSxDQUFDLFFBQVEsQ0FBQyxFQUFFLEVBQUUsQ0FBQztZQUNqQixNQUFNLFNBQVMsR0FBRyxNQUFNLFFBQVEsQ0FBQyxJQUFJLEVBQUUsQ0FBQztZQUN4QyxPQUFPLENBQUMsS0FBSyxDQUFDLG9CQUFvQixFQUFFLFNBQVMsQ0FBQyxDQUFDO1lBRS9DLE9BQU87Z0JBQ0wsVUFBVSxFQUFFLFFBQVEsQ0FBQyxNQUFNLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUc7Z0JBQy9DLE9BQU87Z0JBQ1AsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxLQUFLLEVBQUUscUNBQXFDLEVBQUUsQ0FBQzthQUN2RSxDQUFDO1FBQ0osQ0FBQztRQUVELE1BQU0sSUFBSSxHQUFHLE1BQU0sUUFBUSxDQUFDLElBQUksRUFBd0QsQ0FBQztRQUN6RixNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMscUJBQXFCLElBQUksRUFBRSxDQUFDO1FBQ25ELE1BQU0sWUFBWSxHQUFHLGlCQUFpQixDQUFDLFNBQVMsQ0FBQyxDQUFDO1FBRWxELE9BQU87WUFDTCxVQUFVLEVBQUUsR0FBRztZQUNmLE9BQU87WUFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQztnQkFDbkIsYUFBYSxFQUFFLFlBQVk7Z0JBQzNCLFVBQVUsRUFBRSxTQUFTO2dCQUNyQixNQUFNLEVBQUUsWUFBWTtnQkFDcEIsTUFBTSxFQUFFLGFBQWE7YUFDdEIsQ0FBQztTQUNILENBQUM7SUFDSixDQUFDO0lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztRQUNmLE9BQU8sQ0FBQyxLQUFLLENBQUMsd0JBQXdCLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDL0MsT0FBTztZQUNMLFVBQVUsRUFBRSxHQUFHO1lBQ2YsT0FBTztZQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsS0FBSyxFQUFFLG9DQUFvQyxFQUFFLENBQUM7U0FDdEUsQ0FBQztJQUNKLENBQUM7QUFDSCxDQUFDO0FBRUQsS0FBSyxVQUFVLGtCQUFrQixDQUMvQixTQUFpQixFQUNqQixZQUFvQixFQUNwQixJQUFtQixFQUNuQixPQUErQjtJQUUvQixJQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDVixPQUFPO1lBQ0wsVUFBVSxFQUFFLEdBQUc7WUFDZixPQUFPO1lBQ1AsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxLQUFLLEVBQUUsdUJBQXVCLEVBQUUsQ0FBQztTQUN6RCxDQUFDO0lBQ0osQ0FBQztJQUVELE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUM7SUFFakMsZ0NBQWdDO0lBQ2hDLE1BQU0sZ0JBQWdCLEdBQUcsY0FBYyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQ2pELElBQUksZ0JBQWdCLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ2hDLE9BQU87WUFDTCxVQUFVLEVBQUUsR0FBRztZQUNmLE9BQU87WUFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSx1QkFBdUIsRUFBRSxNQUFNLEVBQUUsZ0JBQWdCLEVBQUUsQ0FBQztTQUNuRixDQUFDO0lBQ0osQ0FBQztJQUVELElBQUksQ0FBQztRQUNILDBDQUEwQztRQUMxQyxNQUFNLFlBQVksR0FBRyxNQUFNLGVBQWUsRUFBRSxDQUFDO1FBQzdDLE1BQU0sUUFBUSxHQUFHLE1BQU0sS0FBSyxDQUMxQix3Q0FBd0MsbUJBQW1CLFlBQVksU0FBUyx3QkFBd0IsRUFDeEc7WUFDRSxNQUFNLEVBQUUsS0FBSztZQUNiLE9BQU8sRUFBRTtnQkFDUCxlQUFlLEVBQUUsVUFBVSxZQUFZLEVBQUU7Z0JBQ3pDLGNBQWMsRUFBRSxrQkFBa0I7YUFDbkM7WUFDRCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLHFCQUFxQixFQUFFLGVBQWUsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1NBQzFFLENBQ0YsQ0FBQztRQUVGLElBQUksQ0FBQyxRQUFRLENBQUMsRUFBRSxFQUFFLENBQUM7WUFDakIsTUFBTSxTQUFTLEdBQUcsTUFBTSxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDeEMsT0FBTyxDQUFDLEtBQUssQ0FBQyxvQkFBb0IsRUFBRSxTQUFTLENBQUMsQ0FBQztZQUUvQyxPQUFPO2dCQUNMLFVBQVUsRUFBRSxHQUFHO2dCQUNmLE9BQU87Z0JBQ1AsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxLQUFLLEVBQUUsb0NBQW9DLEVBQUUsQ0FBQzthQUN0RSxDQUFDO1FBQ0osQ0FBQztRQUVELE9BQU87WUFDTCxVQUFVLEVBQUUsR0FBRztZQUNmLE9BQU87WUFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQztnQkFDbkIsYUFBYSxFQUFFLFlBQVk7Z0JBQzNCLFVBQVUsRUFBRSxTQUFTO2dCQUNyQixNQUFNLEVBQUUsT0FBTztnQkFDZixPQUFPLEVBQUUsc0VBQXNFO2FBQ2hGLENBQUM7U0FDSCxDQUFDO0lBQ0osQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDZixPQUFPLENBQUMsS0FBSyxDQUFDLHdCQUF3QixFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQy9DLE9BQU87WUFDTCxVQUFVLEVBQUUsR0FBRztZQUNmLE9BQU87WUFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSxvQ0FBb0MsRUFBRSxDQUFDO1NBQ3RFLENBQUM7SUFDSixDQUFDO0FBQ0gsQ0FBQztBQUVELEtBQUssVUFBVSxpQkFBaUIsQ0FDOUIsUUFBZ0IsRUFDaEIsSUFBbUIsRUFDbkIsT0FBK0I7SUFFL0IsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ1YsT0FBTztZQUNMLFVBQVUsRUFBRSxHQUFHO1lBQ2YsT0FBTztZQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsS0FBSyxFQUFFLHVCQUF1QixFQUFFLENBQUM7U0FDekQsQ0FBQztJQUNKLENBQUM7SUFFRCxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDO0lBRWpDLGdDQUFnQztJQUNoQyxNQUFNLGdCQUFnQixHQUFHLGNBQWMsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUNqRCxJQUFJLGdCQUFnQixDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUNoQyxPQUFPO1lBQ0wsVUFBVSxFQUFFLEdBQUc7WUFDZixPQUFPO1lBQ1AsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxLQUFLLEVBQUUsdUJBQXVCLEVBQUUsTUFBTSxFQUFFLGdCQUFnQixFQUFFLENBQUM7U0FDbkYsQ0FBQztJQUNKLENBQUM7SUFFRCxJQUFJLENBQUM7UUFDSCxnREFBZ0Q7UUFDaEQsTUFBTSxZQUFZLEdBQUcsTUFBTSxlQUFlLEVBQUUsQ0FBQztRQUM3QyxNQUFNLFFBQVEsR0FBRyxNQUFNLEtBQUssQ0FDMUIsd0NBQXdDLG1CQUFtQixXQUFXLFFBQVEsd0JBQXdCLEVBQ3RHO1lBQ0UsTUFBTSxFQUFFLEtBQUs7WUFDYixPQUFPLEVBQUU7Z0JBQ1AsZUFBZSxFQUFFLFVBQVUsWUFBWSxFQUFFO2dCQUN6QyxjQUFjLEVBQUUsa0JBQWtCO2FBQ25DO1lBQ0QsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxxQkFBcUIsRUFBRSxlQUFlLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztTQUMxRSxDQUNGLENBQUM7UUFFRixJQUFJLENBQUMsUUFBUSxDQUFDLEVBQUUsRUFBRSxDQUFDO1lBQ2pCLE1BQU0sU0FBUyxHQUFHLE1BQU0sUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ3hDLE9BQU8sQ0FBQyxLQUFLLENBQUMsb0JBQW9CLEVBQUUsU0FBUyxDQUFDLENBQUM7WUFFL0MsT0FBTztnQkFDTCxVQUFVLEVBQUUsR0FBRztnQkFDZixPQUFPO2dCQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsS0FBSyxFQUFFLDBDQUEwQyxFQUFFLENBQUM7YUFDNUUsQ0FBQztRQUNKLENBQUM7UUFFRCxPQUFPO1lBQ0wsVUFBVSxFQUFFLEdBQUc7WUFDZixPQUFPO1lBQ1AsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUM7Z0JBQ25CLFNBQVMsRUFBRSxRQUFRO2dCQUNuQixNQUFNLEVBQUUsT0FBTztnQkFDZixPQUFPLEVBQUUsNEVBQTRFO2FBQ3RGLENBQUM7U0FDSCxDQUFDO0lBQ0osQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDZixPQUFPLENBQUMsS0FBSyxDQUFDLDhCQUE4QixFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQ3JELE9BQU87WUFDTCxVQUFVLEVBQUUsR0FBRztZQUNmLE9BQU87WUFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSxvQ0FBb0MsRUFBRSxDQUFDO1NBQ3RFLENBQUM7SUFDSixDQUFDO0FBQ0gsQ0FBQztBQUVEOzs7R0FHRztBQUNILEtBQUssVUFBVSxhQUFhLENBQzFCLFNBQWlCLEVBQ2pCLFlBQW9CLEVBQ3BCLElBQW1CLEVBQ25CLE9BQStCO0lBRS9CLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUNWLE9BQU87WUFDTCxVQUFVLEVBQUUsR0FBRztZQUNmLE9BQU87WUFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSx1QkFBdUIsRUFBRSxDQUFDO1NBQ3pELENBQUM7SUFDSixDQUFDO0lBRUQsTUFBTSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDO0lBRTVDLGtCQUFrQjtJQUNsQixJQUFJLENBQUMsSUFBSSxJQUFJLE9BQU8sSUFBSSxLQUFLLFFBQVEsSUFBSSxJQUFJLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRSxFQUFFLENBQUM7UUFDNUQsT0FBTztZQUNMLFVBQVUsRUFBRSxHQUFHO1lBQ2YsT0FBTztZQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsS0FBSyxFQUFFLGtCQUFrQixFQUFFLENBQUM7U0FDcEQsQ0FBQztJQUNKLENBQUM7SUFFRCxJQUFJLFFBQVEsS0FBSyxTQUFTLElBQUksUUFBUSxLQUFLLElBQUksRUFBRSxDQUFDO1FBQ2hELE9BQU87WUFDTCxVQUFVLEVBQUUsR0FBRztZQUNmLE9BQU87WUFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSw4REFBOEQsRUFBRSxDQUFDO1NBQ2hHLENBQUM7SUFDSixDQUFDO0lBRUQsMkVBQTJFO0lBQzNFLE1BQU0sU0FBUyxHQUFHLEtBQUssSUFBSSxNQUFNLFFBQVEsSUFBSSxDQUFDO0lBRTlDLElBQUksQ0FBQztRQUNILE1BQU0sWUFBWSxHQUFHLE1BQU0sZUFBZSxFQUFFLENBQUM7UUFDN0MsTUFBTSxRQUFRLEdBQUcsTUFBTSxLQUFLLENBQzFCLHdDQUF3QyxtQkFBbUIsWUFBWSxTQUFTLHdCQUF3QixFQUN4RztZQUNFLE1BQU0sRUFBRSxLQUFLO1lBQ2IsT0FBTyxFQUFFO2dCQUNQLGVBQWUsRUFBRSxVQUFVLFlBQVksRUFBRTtnQkFDekMsY0FBYyxFQUFFLGtCQUFrQjthQUNuQztZQUNELElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUscUJBQXFCLEVBQUUsRUFBRSxLQUFLLEVBQUUsU0FBUyxFQUFFLEVBQUUsQ0FBQztTQUN0RSxDQUNGLENBQUM7UUFFRixJQUFJLENBQUMsUUFBUSxDQUFDLEVBQUUsRUFBRSxDQUFDO1lBQ2pCLE1BQU0sU0FBUyxHQUFHLE1BQU0sUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ3hDLE9BQU8sQ0FBQyxLQUFLLENBQUMsb0JBQW9CLEVBQUUsU0FBUyxDQUFDLENBQUM7WUFFL0MsT0FBTztnQkFDTCxVQUFVLEVBQUUsR0FBRztnQkFDZixPQUFPO2dCQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsS0FBSyxFQUFFLDRDQUE0QyxFQUFFLENBQUM7YUFDOUUsQ0FBQztRQUNKLENBQUM7UUFFRCxxQkFBcUI7UUFDckIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxvQ0FBb0MsWUFBWSxXQUFXLElBQUksR0FBRyxDQUFDLENBQUM7UUFFaEYsT0FBTztZQUNMLFVBQVUsRUFBRSxHQUFHO1lBQ2YsT0FBTztZQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDO2dCQUNuQixPQUFPLEVBQUUsSUFBSTtnQkFDYixhQUFhLEVBQUUsWUFBWTtnQkFDM0IsT0FBTyxFQUFFLHNFQUFzRTthQUNoRixDQUFDO1NBQ0gsQ0FBQztJQUNKLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2YsT0FBTyxDQUFDLEtBQUssQ0FBQyxrQ0FBa0MsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUN6RCxPQUFPO1lBQ0wsVUFBVSxFQUFFLEdBQUc7WUFDZixPQUFPO1lBQ1AsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxLQUFLLEVBQUUsb0NBQW9DLEVBQUUsQ0FBQztTQUN0RSxDQUFDO0lBQ0osQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLGNBQWMsQ0FBQyxNQUEyQjtJQUNqRCxNQUFNLE1BQU0sR0FBYSxFQUFFLENBQUM7SUFFNUIsS0FBSyxNQUFNLENBQUMsR0FBRyxFQUFFLEtBQUssQ0FBQyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztRQUNsRCxNQUFNLE1BQU0sR0FBRyxhQUFhLENBQUMsR0FBRyxDQUFDLENBQUM7UUFFbEMsbUVBQW1FO1FBQ25FLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUNaLFNBQVM7UUFDWCxDQUFDO1FBRUQsSUFBSSxNQUFNLENBQUMsSUFBSSxLQUFLLFFBQVEsRUFBRSxDQUFDO1lBQzdCLE1BQU0sUUFBUSxHQUFHLE9BQU8sS0FBSyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUM7WUFDdkUsSUFBSSxLQUFLLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQztnQkFDcEIsTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLEdBQUcsbUJBQW1CLENBQUMsQ0FBQztZQUN6QyxDQUFDO2lCQUFNLENBQUM7Z0JBQ04sSUFBSSxNQUFNLENBQUMsR0FBRyxLQUFLLFNBQVMsSUFBSSxRQUFRLEdBQUcsTUFBTSxDQUFDLEdBQUcsRUFBRSxDQUFDO29CQUN0RCxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsR0FBRyxlQUFlLE1BQU0sQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDO2dCQUNqRCxDQUFDO2dCQUNELElBQUksTUFBTSxDQUFDLEdBQUcsS0FBSyxTQUFTLElBQUksUUFBUSxHQUFHLE1BQU0sQ0FBQyxHQUFHLEVBQUUsQ0FBQztvQkFDdEQsTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLEdBQUcsZUFBZSxNQUFNLENBQUMsR0FBRyxFQUFFLENBQUMsQ0FBQztnQkFDakQsQ0FBQztZQUNILENBQUM7UUFDSCxDQUFDO1FBRUQsSUFBSSxNQUFNLENBQUMsSUFBSSxLQUFLLFFBQVEsSUFBSSxNQUFNLENBQUMsTUFBTSxFQUFFLENBQUM7WUFDOUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7Z0JBQ25DLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxHQUFHLG9CQUFvQixNQUFNLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7WUFDcEUsQ0FBQztRQUNILENBQUM7UUFFRCxJQUFJLE1BQU0sQ0FBQyxJQUFJLEtBQUssU0FBUyxFQUFFLENBQUM7WUFDOUIsTUFBTSxTQUFTLEdBQUcsT0FBTyxLQUFLLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxLQUFLLEtBQUssTUFBTSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUM7WUFDdkUsSUFBSSxPQUFPLFNBQVMsS0FBSyxTQUFTLEVBQUUsQ0FBQztnQkFDbkMsTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLEdBQUcsb0JBQW9CLENBQUMsQ0FBQztZQUMxQyxDQUFDO1FBQ0gsQ0FBQztJQUNILENBQUM7SUFFRCxPQUFPLE1BQU0sQ0FBQztBQUNoQixDQUFDO0FBRUQsU0FBUyxlQUFlLENBQUMsTUFBMkI7SUFDbEQsTUFBTSxNQUFNLEdBQTJCLEVBQUUsQ0FBQztJQUUxQyxLQUFLLE1BQU0sQ0FBQyxHQUFHLEVBQUUsS0FBSyxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1FBQ2xELDJDQUEyQztRQUMzQyxJQUFJLGFBQWEsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQ3ZCLE1BQU0sQ0FBQyxHQUFHLENBQUMsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDOUIsQ0FBQztJQUNILENBQUM7SUFFRCxPQUFPLE1BQU0sQ0FBQztBQUNoQixDQUFDO0FBRUQsU0FBUyxpQkFBaUIsQ0FBQyxNQUE4QjtJQUN2RCxNQUFNLE1BQU0sR0FBd0IsRUFBRSxDQUFDO0lBRXZDLEtBQUssTUFBTSxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUM7UUFDbEQsTUFBTSxNQUFNLEdBQUcsYUFBYSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBRWxDLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUNaLDBCQUEwQjtZQUMxQixNQUFNLENBQUMsR0FBRyxDQUFDLEdBQUcsS0FBSyxDQUFDO1lBQ3BCLFNBQVM7UUFDWCxDQUFDO1FBRUQsK0JBQStCO1FBQy9CLElBQUksTUFBTSxDQUFDLElBQUksS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUM5QixNQUFNLENBQUMsR0FBRyxDQUFDLEdBQUcsS0FBSyxLQUFLLE1BQU0sQ0FBQztRQUNqQyxDQUFDO2FBQU0sSUFBSSxNQUFNLENBQUMsSUFBSSxLQUFLLFFBQVEsRUFBRSxDQUFDO1lBQ3BDLE1BQU0sUUFBUSxHQUFHLFVBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUNuQyxNQUFNLENBQUMsR0FBRyxDQUFDLEdBQUcsS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQztRQUNuRCxDQUFDO2FBQU0sQ0FBQztZQUNOLE1BQU0sQ0FBQyxHQUFHLENBQUMsR0FBRyxLQUFLLENBQUM7UUFDdEIsQ0FBQztJQUNILENBQUM7SUFFRCxPQUFPLE1BQU0sQ0FBQztBQUNoQixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBDb25maWcgQVBJIExhbWJkYVxuICpcbiAqIE1hbmFnZXMgZGV2aWNlIGNvbmZpZ3VyYXRpb24gdmlhIE5vdGVodWIgZW52aXJvbm1lbnQgdmFyaWFibGVzOlxuICogLSBHRVQgL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2NvbmZpZyAtIEdldCBjdXJyZW50IGNvbmZpZ1xuICogLSBQVVQgL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2NvbmZpZyAtIFVwZGF0ZSBjb25maWdcbiAqIC0gUFVUIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS93aWZpIC0gU2V0IGRldmljZSBXaS1GaSBjcmVkZW50aWFsc1xuICogLSBQVVQgL2ZsZWV0cy97ZmxlZXRfdWlkfS9jb25maWcgLSBVcGRhdGUgZmxlZXQtd2lkZSBjb25maWdcbiAqL1xuXG5pbXBvcnQgeyBBUElHYXRld2F5UHJveHlFdmVudCwgQVBJR2F0ZXdheVByb3h5UmVzdWx0IH0gZnJvbSAnYXdzLWxhbWJkYSc7XG5pbXBvcnQgeyBTZWNyZXRzTWFuYWdlckNsaWVudCwgR2V0U2VjcmV0VmFsdWVDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LXNlY3JldHMtbWFuYWdlcic7XG5pbXBvcnQgeyBEeW5hbW9EQkNsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYic7XG5pbXBvcnQgeyBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LCBHZXRDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvbGliLWR5bmFtb2RiJztcblxuY29uc3Qgc2VjcmV0c0NsaWVudCA9IG5ldyBTZWNyZXRzTWFuYWdlckNsaWVudCh7fSk7XG5jb25zdCBkeW5hbW9DbGllbnQgPSBuZXcgRHluYW1vREJDbGllbnQoe30pO1xuY29uc3QgZG9jQ2xpZW50ID0gRHluYW1vREJEb2N1bWVudENsaWVudC5mcm9tKGR5bmFtb0NsaWVudCk7XG5cbmNvbnN0IE5PVEVIVUJfUFJPSkVDVF9VSUQgPSBwcm9jZXNzLmVudi5OT1RFSFVCX1BST0pFQ1RfVUlEITtcbmNvbnN0IE5PVEVIVUJfU0VDUkVUX0FSTiA9IHByb2Nlc3MuZW52Lk5PVEVIVUJfU0VDUkVUX0FSTiE7XG5jb25zdCBERVZJQ0VfQUxJQVNFU19UQUJMRSA9IHByb2Nlc3MuZW52LkRFVklDRV9BTElBU0VTX1RBQkxFIHx8ICdzb25nYmlyZC1kZXZpY2UtYWxpYXNlcyc7XG5cbi8qKlxuICogUmVzb2x2ZSBzZXJpYWwgbnVtYmVyIHRvIGRldmljZV91aWQgdXNpbmcgdGhlIGFsaWFzZXMgdGFibGVcbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZURldmljZVVpZChzZXJpYWxOdW1iZXI6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChuZXcgR2V0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBERVZJQ0VfQUxJQVNFU19UQUJMRSxcbiAgICBLZXk6IHsgc2VyaWFsX251bWJlcjogc2VyaWFsTnVtYmVyIH0sXG4gIH0pKTtcblxuICByZXR1cm4gcmVzdWx0Lkl0ZW0/LmRldmljZV91aWQgfHwgbnVsbDtcbn1cblxuLy8gQ2FjaGUgdGhlIHRva2VuIHRvIGF2b2lkIGZldGNoaW5nIG9uIGV2ZXJ5IHJlcXVlc3RcbmxldCBjYWNoZWRUb2tlbjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbmFzeW5jIGZ1bmN0aW9uIGdldE5vdGVodWJUb2tlbigpOiBQcm9taXNlPHN0cmluZz4ge1xuICBpZiAoY2FjaGVkVG9rZW4pIHtcbiAgICByZXR1cm4gY2FjaGVkVG9rZW47XG4gIH1cblxuICBjb25zdCBjb21tYW5kID0gbmV3IEdldFNlY3JldFZhbHVlQ29tbWFuZCh7IFNlY3JldElkOiBOT1RFSFVCX1NFQ1JFVF9BUk4gfSk7XG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgc2VjcmV0c0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuXG4gIGlmICghcmVzcG9uc2UuU2VjcmV0U3RyaW5nKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdOb3RlaHViIEFQSSB0b2tlbiBub3QgZm91bmQgaW4gc2VjcmV0Jyk7XG4gIH1cblxuICBjb25zdCBzZWNyZXQgPSBKU09OLnBhcnNlKHJlc3BvbnNlLlNlY3JldFN0cmluZyk7XG4gIGNhY2hlZFRva2VuID0gc2VjcmV0LnRva2VuO1xuXG4gIGlmICghY2FjaGVkVG9rZW4pIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ1Rva2VuIGZpZWxkIG5vdCBmb3VuZCBpbiBzZWNyZXQnKTtcbiAgfVxuXG4gIHJldHVybiBjYWNoZWRUb2tlbjtcbn1cblxuLy8gVmFsaWQgY29uZmlndXJhdGlvbiBrZXlzIGFuZCB0aGVpciB0eXBlc1xuY29uc3QgQ09ORklHX1NDSEVNQTogUmVjb3JkPHN0cmluZywgeyB0eXBlOiBzdHJpbmc7IG1pbj86IG51bWJlcjsgbWF4PzogbnVtYmVyOyB2YWx1ZXM/OiBzdHJpbmdbXSB9PiA9IHtcbiAgbW9kZTogeyB0eXBlOiAnc3RyaW5nJywgdmFsdWVzOiBbJ2RlbW8nLCAndHJhbnNpdCcsICdzdG9yYWdlJywgJ3NsZWVwJ10gfSxcbiAgZ3BzX2ludGVydmFsX21pbjogeyB0eXBlOiAnbnVtYmVyJywgbWluOiAxLCBtYXg6IDE0NDAgfSxcbiAgc3luY19pbnRlcnZhbF9taW46IHsgdHlwZTogJ251bWJlcicsIG1pbjogMSwgbWF4OiAxNDQwIH0sXG4gIGhlYXJ0YmVhdF9ob3VyczogeyB0eXBlOiAnbnVtYmVyJywgbWluOiAxLCBtYXg6IDE2OCB9LFxuICB0ZW1wX2FsZXJ0X2hpZ2hfYzogeyB0eXBlOiAnbnVtYmVyJywgbWluOiAtNDAsIG1heDogODUgfSxcbiAgdGVtcF9hbGVydF9sb3dfYzogeyB0eXBlOiAnbnVtYmVyJywgbWluOiAtNDAsIG1heDogODUgfSxcbiAgaHVtaWRpdHlfYWxlcnRfaGlnaDogeyB0eXBlOiAnbnVtYmVyJywgbWluOiAwLCBtYXg6IDEwMCB9LFxuICBodW1pZGl0eV9hbGVydF9sb3c6IHsgdHlwZTogJ251bWJlcicsIG1pbjogMCwgbWF4OiAxMDAgfSxcbiAgcHJlc3N1cmVfYWxlcnRfZGVsdGE6IHsgdHlwZTogJ251bWJlcicsIG1pbjogMSwgbWF4OiAxMDAgfSxcbiAgdm9sdGFnZV9hbGVydF9sb3c6IHsgdHlwZTogJ251bWJlcicsIG1pbjogMy4wLCBtYXg6IDQuMiB9LFxuICBtb3Rpb25fc2Vuc2l0aXZpdHk6IHsgdHlwZTogJ3N0cmluZycsIHZhbHVlczogWydsb3cnLCAnbWVkaXVtJywgJ2hpZ2gnXSB9LFxuICBtb3Rpb25fd2FrZV9lbmFibGVkOiB7IHR5cGU6ICdib29sZWFuJyB9LFxuICBhdWRpb19lbmFibGVkOiB7IHR5cGU6ICdib29sZWFuJyB9LFxuICBhdWRpb192b2x1bWU6IHsgdHlwZTogJ251bWJlcicsIG1pbjogMCwgbWF4OiAxMDAgfSxcbiAgYXVkaW9fYWxlcnRzX29ubHk6IHsgdHlwZTogJ2Jvb2xlYW4nIH0sXG4gIGNtZF93YWtlX2VuYWJsZWQ6IHsgdHlwZTogJ2Jvb2xlYW4nIH0sXG4gIGNtZF9hY2tfZW5hYmxlZDogeyB0eXBlOiAnYm9vbGVhbicgfSxcbiAgbG9jYXRlX2R1cmF0aW9uX3NlYzogeyB0eXBlOiAnbnVtYmVyJywgbWluOiA1LCBtYXg6IDMwMCB9LFxuICBsZWRfZW5hYmxlZDogeyB0eXBlOiAnYm9vbGVhbicgfSxcbiAgZGVidWdfbW9kZTogeyB0eXBlOiAnYm9vbGVhbicgfSxcbiAgLy8gR1BTIFBvd2VyIE1hbmFnZW1lbnQgKFRyYW5zaXQgTW9kZSlcbiAgLy8gQWN0aXZlbHkgbWFuYWdlcyBHUFMgcG93ZXIgYmFzZWQgb24gc2lnbmFsIGFjcXVpc2l0aW9uXG4gIGdwc19wb3dlcl9zYXZlX2VuYWJsZWQ6IHsgdHlwZTogJ2Jvb2xlYW4nIH0sXG4gIGdwc19zaWduYWxfdGltZW91dF9taW46IHsgdHlwZTogJ251bWJlcicsIG1pbjogMTAsIG1heDogMzAgfSxcbiAgZ3BzX3JldHJ5X2ludGVydmFsX21pbjogeyB0eXBlOiAnbnVtYmVyJywgbWluOiA1LCBtYXg6IDEyMCB9LFxufTtcblxuZXhwb3J0IGNvbnN0IGhhbmRsZXIgPSBhc3luYyAoZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50KTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+ID0+IHtcbiAgY29uc29sZS5sb2coJ1JlcXVlc3Q6JywgSlNPTi5zdHJpbmdpZnkoZXZlbnQpKTtcblxuICBjb25zdCBjb3JzSGVhZGVycyA9IHtcbiAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJzogJyonLFxuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzJzogJ0NvbnRlbnQtVHlwZSxBdXRob3JpemF0aW9uJyxcbiAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kcyc6ICdHRVQsUFVULE9QVElPTlMnLFxuICB9O1xuXG4gIHRyeSB7XG4gICAgLy8gSFRUUCBBUEkgdjIgdXNlcyByZXF1ZXN0Q29udGV4dC5odHRwLm1ldGhvZCwgUkVTVCBBUEkgdjEgdXNlcyBodHRwTWV0aG9kXG4gICAgY29uc3QgbWV0aG9kID0gKGV2ZW50LnJlcXVlc3RDb250ZXh0IGFzIGFueSk/Lmh0dHA/Lm1ldGhvZCB8fCBldmVudC5odHRwTWV0aG9kO1xuXG4gICAgaWYgKG1ldGhvZCA9PT0gJ09QVElPTlMnKSB7XG4gICAgICByZXR1cm4geyBzdGF0dXNDb2RlOiAyMDAsIGhlYWRlcnM6IGNvcnNIZWFkZXJzLCBib2R5OiAnJyB9O1xuICAgIH1cblxuICAgIGNvbnN0IHNlcmlhbE51bWJlciA9IGV2ZW50LnBhdGhQYXJhbWV0ZXJzPy5zZXJpYWxfbnVtYmVyO1xuICAgIGNvbnN0IGZsZWV0VWlkID0gZXZlbnQucGF0aFBhcmFtZXRlcnM/LmZsZWV0X3VpZDtcbiAgICBjb25zdCBwYXRoID0gZXZlbnQucGF0aCB8fCAoZXZlbnQucmVxdWVzdENvbnRleHQgYXMgYW55KT8uaHR0cD8ucGF0aCB8fCAnJztcbiAgICBjb25zdCBpc1dpZmlFbmRwb2ludCA9IHBhdGguZW5kc1dpdGgoJy93aWZpJyk7XG5cbiAgICBpZiAoKG1ldGhvZCA9PT0gJ0dFVCcgfHwgbWV0aG9kID09PSAnUFVUJykgJiYgc2VyaWFsTnVtYmVyKSB7XG4gICAgICAvLyBSZXNvbHZlIHNlcmlhbCBudW1iZXIgdG8gZGV2aWNlX3VpZFxuICAgICAgY29uc3QgZGV2aWNlVWlkID0gYXdhaXQgcmVzb2x2ZURldmljZVVpZChzZXJpYWxOdW1iZXIpO1xuICAgICAgaWYgKCFkZXZpY2VVaWQpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiA0MDQsXG4gICAgICAgICAgaGVhZGVyczogY29yc0hlYWRlcnMsXG4gICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0RldmljZSBub3QgZm91bmQgZm9yIHNlcmlhbCBudW1iZXInIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICBpZiAobWV0aG9kID09PSAnR0VUJykge1xuICAgICAgICByZXR1cm4gYXdhaXQgZ2V0RGV2aWNlQ29uZmlnKGRldmljZVVpZCwgc2VyaWFsTnVtYmVyLCBjb3JzSGVhZGVycyk7XG4gICAgICB9IGVsc2UgaWYgKG1ldGhvZCA9PT0gJ1BVVCcgJiYgaXNXaWZpRW5kcG9pbnQpIHtcbiAgICAgICAgcmV0dXJuIGF3YWl0IHNldERldmljZVdpZmkoZGV2aWNlVWlkLCBzZXJpYWxOdW1iZXIsIGV2ZW50LmJvZHksIGNvcnNIZWFkZXJzKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiBhd2FpdCB1cGRhdGVEZXZpY2VDb25maWcoZGV2aWNlVWlkLCBzZXJpYWxOdW1iZXIsIGV2ZW50LmJvZHksIGNvcnNIZWFkZXJzKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAobWV0aG9kID09PSAnUFVUJyAmJiBmbGVldFVpZCkge1xuICAgICAgcmV0dXJuIGF3YWl0IHVwZGF0ZUZsZWV0Q29uZmlnKGZsZWV0VWlkLCBldmVudC5ib2R5LCBjb3JzSGVhZGVycyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgIGhlYWRlcnM6IGNvcnNIZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0ludmFsaWQgcmVxdWVzdCcgfSksXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvcjonLCBlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMCxcbiAgICAgIGhlYWRlcnM6IGNvcnNIZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0ludGVybmFsIHNlcnZlciBlcnJvcicgfSksXG4gICAgfTtcbiAgfVxufTtcblxuYXN5bmMgZnVuY3Rpb24gZ2V0RGV2aWNlQ29uZmlnKFxuICBkZXZpY2VVaWQ6IHN0cmluZyxcbiAgc2VyaWFsTnVtYmVyOiBzdHJpbmcsXG4gIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiB7XG4gIHRyeSB7XG4gICAgLy8gR2V0IGVudmlyb25tZW50IHZhcmlhYmxlcyBmcm9tIE5vdGVodWJcbiAgICBjb25zdCBub3RlaHViVG9rZW4gPSBhd2FpdCBnZXROb3RlaHViVG9rZW4oKTtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFxuICAgICAgYGh0dHBzOi8vYXBpLm5vdGVmaWxlLm5ldC92MS9wcm9qZWN0cy8ke05PVEVIVUJfUFJPSkVDVF9VSUR9L2RldmljZXMvJHtkZXZpY2VVaWR9L2Vudmlyb25tZW50X3ZhcmlhYmxlc2AsXG4gICAgICB7XG4gICAgICAgIG1ldGhvZDogJ0dFVCcsXG4gICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAnQXV0aG9yaXphdGlvbic6IGBCZWFyZXIgJHtub3RlaHViVG9rZW59YCxcbiAgICAgICAgfSxcbiAgICAgIH1cbiAgICApO1xuXG4gICAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgICAgY29uc3QgZXJyb3JUZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgICAgY29uc29sZS5lcnJvcignTm90ZWh1YiBBUEkgZXJyb3I6JywgZXJyb3JUZXh0KTtcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogcmVzcG9uc2Uuc3RhdHVzID09PSA0MDQgPyA0MDQgOiA1MDIsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdGYWlsZWQgdG8gZmV0Y2ggY29uZmlnIGZyb20gTm90ZWh1YicgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZXNwb25zZS5qc29uKCkgYXMgeyBlbnZpcm9ubWVudF92YXJpYWJsZXM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IH07XG4gICAgY29uc3QgcmF3Q29uZmlnID0gZGF0YS5lbnZpcm9ubWVudF92YXJpYWJsZXMgfHwge307XG4gICAgY29uc3QgcGFyc2VkQ29uZmlnID0gcGFyc2VDb25maWdWYWx1ZXMocmF3Q29uZmlnKTtcblxuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBzZXJpYWxfbnVtYmVyOiBzZXJpYWxOdW1iZXIsXG4gICAgICAgIGRldmljZV91aWQ6IGRldmljZVVpZCxcbiAgICAgICAgY29uZmlnOiBwYXJzZWRDb25maWcsXG4gICAgICAgIHNjaGVtYTogQ09ORklHX1NDSEVNQSxcbiAgICAgIH0pLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3IgZmV0Y2hpbmcgY29uZmlnOicsIGVycm9yKTtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNTAyLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdGYWlsZWQgdG8gY29tbXVuaWNhdGUgd2l0aCBOb3RlaHViJyB9KSxcbiAgICB9O1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHVwZGF0ZURldmljZUNvbmZpZyhcbiAgZGV2aWNlVWlkOiBzdHJpbmcsXG4gIHNlcmlhbE51bWJlcjogc3RyaW5nLFxuICBib2R5OiBzdHJpbmcgfCBudWxsLFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICBpZiAoIWJvZHkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdSZXF1ZXN0IGJvZHkgcmVxdWlyZWQnIH0pLFxuICAgIH07XG4gIH1cblxuICBjb25zdCB1cGRhdGVzID0gSlNPTi5wYXJzZShib2R5KTtcblxuICAvLyBWYWxpZGF0ZSBjb25maWd1cmF0aW9uIHZhbHVlc1xuICBjb25zdCB2YWxpZGF0aW9uRXJyb3JzID0gdmFsaWRhdGVDb25maWcodXBkYXRlcyk7XG4gIGlmICh2YWxpZGF0aW9uRXJyb3JzLmxlbmd0aCA+IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnZhbGlkIGNvbmZpZ3VyYXRpb24nLCBlcnJvcnM6IHZhbGlkYXRpb25FcnJvcnMgfSksXG4gICAgfTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgLy8gVXBkYXRlIGVudmlyb25tZW50IHZhcmlhYmxlcyBpbiBOb3RlaHViXG4gICAgY29uc3Qgbm90ZWh1YlRva2VuID0gYXdhaXQgZ2V0Tm90ZWh1YlRva2VuKCk7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcbiAgICAgIGBodHRwczovL2FwaS5ub3RlZmlsZS5uZXQvdjEvcHJvamVjdHMvJHtOT1RFSFVCX1BST0pFQ1RfVUlEfS9kZXZpY2VzLyR7ZGV2aWNlVWlkfS9lbnZpcm9ubWVudF92YXJpYWJsZXNgLFxuICAgICAge1xuICAgICAgICBtZXRob2Q6ICdQVVQnLFxuICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgJ0F1dGhvcml6YXRpb24nOiBgQmVhcmVyICR7bm90ZWh1YlRva2VufWAsXG4gICAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgfSxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlbnZpcm9ubWVudF92YXJpYWJsZXM6IHN0cmluZ2lmeVZhbHVlcyh1cGRhdGVzKSB9KSxcbiAgICAgIH1cbiAgICApO1xuXG4gICAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgICAgY29uc3QgZXJyb3JUZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgICAgY29uc29sZS5lcnJvcignTm90ZWh1YiBBUEkgZXJyb3I6JywgZXJyb3JUZXh0KTtcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNTAyLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRmFpbGVkIHRvIHVwZGF0ZSBjb25maWcgaW4gTm90ZWh1YicgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBzZXJpYWxfbnVtYmVyOiBzZXJpYWxOdW1iZXIsXG4gICAgICAgIGRldmljZV91aWQ6IGRldmljZVVpZCxcbiAgICAgICAgY29uZmlnOiB1cGRhdGVzLFxuICAgICAgICBtZXNzYWdlOiAnQ29uZmlndXJhdGlvbiB1cGRhdGVkLiBDaGFuZ2VzIHdpbGwgdGFrZSBlZmZlY3Qgb24gbmV4dCBkZXZpY2Ugc3luYy4nLFxuICAgICAgfSksXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvciB1cGRhdGluZyBjb25maWc6JywgZXJyb3IpO1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA1MDIsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0ZhaWxlZCB0byBjb21tdW5pY2F0ZSB3aXRoIE5vdGVodWInIH0pLFxuICAgIH07XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gdXBkYXRlRmxlZXRDb25maWcoXG4gIGZsZWV0VWlkOiBzdHJpbmcsXG4gIGJvZHk6IHN0cmluZyB8IG51bGwsXG4gIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiB7XG4gIGlmICghYm9keSkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1JlcXVlc3QgYm9keSByZXF1aXJlZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHVwZGF0ZXMgPSBKU09OLnBhcnNlKGJvZHkpO1xuXG4gIC8vIFZhbGlkYXRlIGNvbmZpZ3VyYXRpb24gdmFsdWVzXG4gIGNvbnN0IHZhbGlkYXRpb25FcnJvcnMgPSB2YWxpZGF0ZUNvbmZpZyh1cGRhdGVzKTtcbiAgaWYgKHZhbGlkYXRpb25FcnJvcnMubGVuZ3RoID4gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0ludmFsaWQgY29uZmlndXJhdGlvbicsIGVycm9yczogdmFsaWRhdGlvbkVycm9ycyB9KSxcbiAgICB9O1xuICB9XG5cbiAgdHJ5IHtcbiAgICAvLyBVcGRhdGUgZmxlZXQgZW52aXJvbm1lbnQgdmFyaWFibGVzIGluIE5vdGVodWJcbiAgICBjb25zdCBub3RlaHViVG9rZW4gPSBhd2FpdCBnZXROb3RlaHViVG9rZW4oKTtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFxuICAgICAgYGh0dHBzOi8vYXBpLm5vdGVmaWxlLm5ldC92MS9wcm9qZWN0cy8ke05PVEVIVUJfUFJPSkVDVF9VSUR9L2ZsZWV0cy8ke2ZsZWV0VWlkfS9lbnZpcm9ubWVudF92YXJpYWJsZXNgLFxuICAgICAge1xuICAgICAgICBtZXRob2Q6ICdQVVQnLFxuICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgJ0F1dGhvcml6YXRpb24nOiBgQmVhcmVyICR7bm90ZWh1YlRva2VufWAsXG4gICAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgfSxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlbnZpcm9ubWVudF92YXJpYWJsZXM6IHN0cmluZ2lmeVZhbHVlcyh1cGRhdGVzKSB9KSxcbiAgICAgIH1cbiAgICApO1xuXG4gICAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgICAgY29uc3QgZXJyb3JUZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgICAgY29uc29sZS5lcnJvcignTm90ZWh1YiBBUEkgZXJyb3I6JywgZXJyb3JUZXh0KTtcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNTAyLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRmFpbGVkIHRvIHVwZGF0ZSBmbGVldCBjb25maWcgaW4gTm90ZWh1YicgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBmbGVldF91aWQ6IGZsZWV0VWlkLFxuICAgICAgICBjb25maWc6IHVwZGF0ZXMsXG4gICAgICAgIG1lc3NhZ2U6ICdGbGVldCBjb25maWd1cmF0aW9uIHVwZGF0ZWQuIENoYW5nZXMgd2lsbCB0YWtlIGVmZmVjdCBvbiBuZXh0IGRldmljZSBzeW5jLicsXG4gICAgICB9KSxcbiAgICB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHVwZGF0aW5nIGZsZWV0IGNvbmZpZzonLCBlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMixcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRmFpbGVkIHRvIGNvbW11bmljYXRlIHdpdGggTm90ZWh1YicgfSksXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIFNldCBkZXZpY2UgV2ktRmkgY3JlZGVudGlhbHMgdmlhIHRoZSBfd2lmaSBlbnZpcm9ubWVudCB2YXJpYWJsZVxuICogRm9ybWF0OiBbXCJTU0lEXCIsXCJQQVNTV09SRFwiXVxuICovXG5hc3luYyBmdW5jdGlvbiBzZXREZXZpY2VXaWZpKFxuICBkZXZpY2VVaWQ6IHN0cmluZyxcbiAgc2VyaWFsTnVtYmVyOiBzdHJpbmcsXG4gIGJvZHk6IHN0cmluZyB8IG51bGwsXG4gIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiB7XG4gIGlmICghYm9keSkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1JlcXVlc3QgYm9keSByZXF1aXJlZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHsgc3NpZCwgcGFzc3dvcmQgfSA9IEpTT04ucGFyc2UoYm9keSk7XG5cbiAgLy8gVmFsaWRhdGUgaW5wdXRzXG4gIGlmICghc3NpZCB8fCB0eXBlb2Ygc3NpZCAhPT0gJ3N0cmluZycgfHwgc3NpZC50cmltKCkgPT09ICcnKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnU1NJRCBpcyByZXF1aXJlZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIGlmIChwYXNzd29yZCA9PT0gdW5kZWZpbmVkIHx8IHBhc3N3b3JkID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnUGFzc3dvcmQgaXMgcmVxdWlyZWQgKGNhbiBiZSBlbXB0eSBzdHJpbmcgZm9yIG9wZW4gbmV0d29ya3MpJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gRm9ybWF0IHRoZSBfd2lmaSB2YWx1ZSBhcyBwZXIgTm90ZWh1YiBkb2N1bWVudGF0aW9uOiBbXCJTU0lEXCIsXCJQQVNTV09SRFwiXVxuICBjb25zdCB3aWZpVmFsdWUgPSBgW1wiJHtzc2lkfVwiLFwiJHtwYXNzd29yZH1cIl1gO1xuXG4gIHRyeSB7XG4gICAgY29uc3Qgbm90ZWh1YlRva2VuID0gYXdhaXQgZ2V0Tm90ZWh1YlRva2VuKCk7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcbiAgICAgIGBodHRwczovL2FwaS5ub3RlZmlsZS5uZXQvdjEvcHJvamVjdHMvJHtOT1RFSFVCX1BST0pFQ1RfVUlEfS9kZXZpY2VzLyR7ZGV2aWNlVWlkfS9lbnZpcm9ubWVudF92YXJpYWJsZXNgLFxuICAgICAge1xuICAgICAgICBtZXRob2Q6ICdQVVQnLFxuICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgJ0F1dGhvcml6YXRpb24nOiBgQmVhcmVyICR7bm90ZWh1YlRva2VufWAsXG4gICAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgfSxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlbnZpcm9ubWVudF92YXJpYWJsZXM6IHsgX3dpZmk6IHdpZmlWYWx1ZSB9IH0pLFxuICAgICAgfVxuICAgICk7XG5cbiAgICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgICBjb25zdCBlcnJvclRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG4gICAgICBjb25zb2xlLmVycm9yKCdOb3RlaHViIEFQSSBlcnJvcjonLCBlcnJvclRleHQpO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiA1MDIsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdGYWlsZWQgdG8gc2V0IFdpLUZpIGNyZWRlbnRpYWxzIGluIE5vdGVodWInIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBEb24ndCBsb2cgcGFzc3dvcmRcbiAgICBjb25zb2xlLmxvZyhgV2ktRmkgY3JlZGVudGlhbHMgc2V0IGZvciBkZXZpY2UgJHtzZXJpYWxOdW1iZXJ9IChTU0lEOiAke3NzaWR9KWApO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHN1Y2Nlc3M6IHRydWUsXG4gICAgICAgIHNlcmlhbF9udW1iZXI6IHNlcmlhbE51bWJlcixcbiAgICAgICAgbWVzc2FnZTogJ1dpLUZpIGNyZWRlbnRpYWxzIHNldC4gQ2hhbmdlcyB3aWxsIHRha2UgZWZmZWN0IG9uIG5leHQgZGV2aWNlIHN5bmMuJyxcbiAgICAgIH0pLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3Igc2V0dGluZyBXaS1GaSBjcmVkZW50aWFsczonLCBlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMixcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRmFpbGVkIHRvIGNvbW11bmljYXRlIHdpdGggTm90ZWh1YicgfSksXG4gICAgfTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUNvbmZpZyhjb25maWc6IFJlY29yZDxzdHJpbmcsIGFueT4pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGVycm9yczogc3RyaW5nW10gPSBbXTtcblxuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhjb25maWcpKSB7XG4gICAgY29uc3Qgc2NoZW1hID0gQ09ORklHX1NDSEVNQVtrZXldO1xuXG4gICAgLy8gU2tpcCB1bmtub3duIGtleXMgLSB0aGV5IHdpbGwgYmUgZmlsdGVyZWQgb3V0IGluIHN0cmluZ2lmeVZhbHVlc1xuICAgIGlmICghc2NoZW1hKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBpZiAoc2NoZW1hLnR5cGUgPT09ICdudW1iZXInKSB7XG4gICAgICBjb25zdCBudW1WYWx1ZSA9IHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgPyBwYXJzZUZsb2F0KHZhbHVlKSA6IHZhbHVlO1xuICAgICAgaWYgKGlzTmFOKG51bVZhbHVlKSkge1xuICAgICAgICBlcnJvcnMucHVzaChgJHtrZXl9IG11c3QgYmUgYSBudW1iZXJgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChzY2hlbWEubWluICE9PSB1bmRlZmluZWQgJiYgbnVtVmFsdWUgPCBzY2hlbWEubWluKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goYCR7a2V5fSBtdXN0IGJlID49ICR7c2NoZW1hLm1pbn1gKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc2NoZW1hLm1heCAhPT0gdW5kZWZpbmVkICYmIG51bVZhbHVlID4gc2NoZW1hLm1heCkge1xuICAgICAgICAgIGVycm9ycy5wdXNoKGAke2tleX0gbXVzdCBiZSA8PSAke3NjaGVtYS5tYXh9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoc2NoZW1hLnR5cGUgPT09ICdzdHJpbmcnICYmIHNjaGVtYS52YWx1ZXMpIHtcbiAgICAgIGlmICghc2NoZW1hLnZhbHVlcy5pbmNsdWRlcyh2YWx1ZSkpIHtcbiAgICAgICAgZXJyb3JzLnB1c2goYCR7a2V5fSBtdXN0IGJlIG9uZSBvZjogJHtzY2hlbWEudmFsdWVzLmpvaW4oJywgJyl9YCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHNjaGVtYS50eXBlID09PSAnYm9vbGVhbicpIHtcbiAgICAgIGNvbnN0IGJvb2xWYWx1ZSA9IHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgPyB2YWx1ZSA9PT0gJ3RydWUnIDogdmFsdWU7XG4gICAgICBpZiAodHlwZW9mIGJvb2xWYWx1ZSAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgIGVycm9ycy5wdXNoKGAke2tleX0gbXVzdCBiZSBhIGJvb2xlYW5gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gZXJyb3JzO1xufVxuXG5mdW5jdGlvbiBzdHJpbmdpZnlWYWx1ZXMoY29uZmlnOiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG4gIGNvbnN0IHJlc3VsdDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuXG4gIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKGNvbmZpZykpIHtcbiAgICAvLyBPbmx5IGluY2x1ZGUga2V5cyB0aGF0IGFyZSBpbiBvdXIgc2NoZW1hXG4gICAgaWYgKENPTkZJR19TQ0hFTUFba2V5XSkge1xuICAgICAgcmVzdWx0W2tleV0gPSBTdHJpbmcodmFsdWUpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiByZXN1bHQ7XG59XG5cbmZ1bmN0aW9uIHBhcnNlQ29uZmlnVmFsdWVzKGNvbmZpZzogUmVjb3JkPHN0cmluZywgc3RyaW5nPik6IFJlY29yZDxzdHJpbmcsIGFueT4ge1xuICBjb25zdCByZXN1bHQ6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7fTtcblxuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhjb25maWcpKSB7XG4gICAgY29uc3Qgc2NoZW1hID0gQ09ORklHX1NDSEVNQVtrZXldO1xuXG4gICAgaWYgKCFzY2hlbWEpIHtcbiAgICAgIC8vIEtlZXAgdW5rbm93biBrZXlzIGFzLWlzXG4gICAgICByZXN1bHRba2V5XSA9IHZhbHVlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgLy8gUGFyc2UgYmFzZWQgb24gZXhwZWN0ZWQgdHlwZVxuICAgIGlmIChzY2hlbWEudHlwZSA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgICByZXN1bHRba2V5XSA9IHZhbHVlID09PSAndHJ1ZSc7XG4gICAgfSBlbHNlIGlmIChzY2hlbWEudHlwZSA9PT0gJ251bWJlcicpIHtcbiAgICAgIGNvbnN0IG51bVZhbHVlID0gcGFyc2VGbG9hdCh2YWx1ZSk7XG4gICAgICByZXN1bHRba2V5XSA9IGlzTmFOKG51bVZhbHVlKSA/IHZhbHVlIDogbnVtVmFsdWU7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlc3VsdFtrZXldID0gdmFsdWU7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJlc3VsdDtcbn1cbiJdfQ==