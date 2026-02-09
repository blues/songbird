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
const DEVICES_TABLE = process.env.DEVICES_TABLE;
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
        // If mode was changed, write pending_mode to Devices table
        if (updates.mode) {
            try {
                await docClient.send(new lib_dynamodb_1.UpdateCommand({
                    TableName: DEVICES_TABLE,
                    Key: { device_uid: deviceUid },
                    UpdateExpression: 'SET pending_mode = :pm',
                    ExpressionAttributeValues: { ':pm': updates.mode },
                }));
                console.log(`Set pending_mode=${updates.mode} for device ${deviceUid}`);
            }
            catch (err) {
                console.error('Failed to set pending_mode (non-fatal):', err);
            }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWNvbmZpZy9pbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7O0dBUUc7OztBQUdILDRFQUE4RjtBQUM5Riw4REFBMEQ7QUFDMUQsd0RBQTBGO0FBRTFGLE1BQU0sYUFBYSxHQUFHLElBQUksNkNBQW9CLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDbkQsTUFBTSxZQUFZLEdBQUcsSUFBSSxnQ0FBYyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQzVDLE1BQU0sU0FBUyxHQUFHLHFDQUFzQixDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQztBQUU1RCxNQUFNLG1CQUFtQixHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW9CLENBQUM7QUFDN0QsTUFBTSxrQkFBa0IsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGtCQUFtQixDQUFDO0FBQzNELE1BQU0sb0JBQW9CLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxvQkFBb0IsSUFBSSx5QkFBeUIsQ0FBQztBQUMzRixNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGFBQWMsQ0FBQztBQUVqRDs7R0FFRztBQUNILEtBQUssVUFBVSxnQkFBZ0IsQ0FBQyxZQUFvQjtJQUNsRCxNQUFNLE1BQU0sR0FBRyxNQUFNLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSx5QkFBVSxDQUFDO1FBQ2pELFNBQVMsRUFBRSxvQkFBb0I7UUFDL0IsR0FBRyxFQUFFLEVBQUUsYUFBYSxFQUFFLFlBQVksRUFBRTtLQUNyQyxDQUFDLENBQUMsQ0FBQztJQUVKLE9BQU8sTUFBTSxDQUFDLElBQUksRUFBRSxVQUFVLElBQUksSUFBSSxDQUFDO0FBQ3pDLENBQUM7QUFFRCxxREFBcUQ7QUFDckQsSUFBSSxXQUFXLEdBQWtCLElBQUksQ0FBQztBQUV0QyxLQUFLLFVBQVUsZUFBZTtJQUM1QixJQUFJLFdB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Q0FBQztRQUVsQyxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUM7WUFDWiwwQkFBMEI7WUFDMUIsTUFBTSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEtBQUssQ0FBQztZQUNwQixTQUFTO1FBQ1gsQ0FBQztRQUVELCtCQUErQjtRQUMvQixJQUFJLE1BQU0sQ0FBQyxJQUFJLEtBQUssU0FBUyxFQUFFLENBQUM7WUFDOUIsTUFBTSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEtBQUssS0FBSyxNQUFNLENBQUM7UUFDakMsQ0FBQzthQUFNLElBQUksTUFBTSxDQUFDLElBQUksS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUNwQyxNQUFNLFFBQVEsR0FBRyxVQUFVLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDbkMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEtBQUssQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUM7UUFDbkQsQ0FBQzthQUFNLENBQUM7WUFDTixNQUFNLENBQUMsR0FBRyxDQUFDLEdBQUcsS0FBSyxDQUFDO1FBQ3RCLENBQUM7SUFDSCxDQUFDO0lBRUQsT0FBTyxNQUFNLENBQUM7QUFDaEIsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQ29uZmlnIEFQSSBMYW1iZGFcbiAqXG4gKiBNYW5hZ2VzIGRldmljZSBjb25maWd1cmF0aW9uIHZpYSBOb3RlaHViIGVudmlyb25tZW50IHZhcmlhYmxlczpcbiAqIC0gR0VUIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9jb25maWcgLSBHZXQgY3VycmVudCBjb25maWdcbiAqIC0gUFVUIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9jb25maWcgLSBVcGRhdGUgY29uZmlnXG4gKiAtIFBVVCAvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vd2lmaSAtIFNldCBkZXZpY2UgV2ktRmkgY3JlZGVudGlhbHNcbiAqIC0gUFVUIC9mbGVldHMve2ZsZWV0X3VpZH0vY29uZmlnIC0gVXBkYXRlIGZsZWV0LXdpZGUgY29uZmlnXG4gKi9cblxuaW1wb3J0IHsgQVBJR2F0ZXdheVByb3h5RXZlbnQsIEFQSUdhdGV3YXlQcm94eVJlc3VsdCB9IGZyb20gJ2F3cy1sYW1iZGEnO1xuaW1wb3J0IHsgU2VjcmV0c01hbmFnZXJDbGllbnQsIEdldFNlY3JldFZhbHVlQ29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1zZWNyZXRzLW1hbmFnZXInO1xuaW1wb3J0IHsgRHluYW1vREJDbGllbnQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtZHluYW1vZGInO1xuaW1wb3J0IHsgRHluYW1vREJEb2N1bWVudENsaWVudCwgR2V0Q29tbWFuZCwgVXBkYXRlQ29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2xpYi1keW5hbW9kYic7XG5cbmNvbnN0IHNlY3JldHNDbGllbnQgPSBuZXcgU2VjcmV0c01hbmFnZXJDbGllbnQoe30pO1xuY29uc3QgZHluYW1vQ2xpZW50ID0gbmV3IER5bmFtb0RCQ2xpZW50KHt9KTtcbmNvbnN0IGRvY0NsaWVudCA9IER5bmFtb0RCRG9jdW1lbnRDbGllbnQuZnJvbShkeW5hbW9DbGllbnQpO1xuXG5jb25zdCBOT1RFSFVCX1BST0pFQ1RfVUlEID0gcHJvY2Vzcy5lbnYuTk9URUhVQl9QUk9KRUNUX1VJRCE7XG5jb25zdCBOT1RFSFVCX1NFQ1JFVF9BUk4gPSBwcm9jZXNzLmVudi5OT1RFSFVCX1NFQ1JFVF9BUk4hO1xuY29uc3QgREVWSUNFX0FMSUFTRVNfVEFCTEUgPSBwcm9jZXNzLmVudi5ERVZJQ0VfQUxJQVNFU19UQUJMRSB8fCAnc29uZ2JpcmQtZGV2aWNlLWFsaWFzZXMnO1xuY29uc3QgREVWSUNFU19UQUJMRSA9IHByb2Nlc3MuZW52LkRFVklDRVNfVEFCTEUhO1xuXG4vKipcbiAqIFJlc29sdmUgc2VyaWFsIG51bWJlciB0byBkZXZpY2VfdWlkIHVzaW5nIHRoZSBhbGlhc2VzIHRhYmxlXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVEZXZpY2VVaWQoc2VyaWFsTnVtYmVyOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IEdldENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogREVWSUNFX0FMSUFTRVNfVEFCTEUsXG4gICAgS2V5OiB7IHNlcmlhbF9udW1iZXI6IHNlcmlhbE51bWJlciB9LFxuICB9KSk7XG5cbiAgcmV0dXJuIHJlc3VsdC5JdGVtPy5kZXZpY2VfdWlkIHx8IG51bGw7XG59XG5cbi8vIENhY2hlIHRoZSB0b2tlbiB0byBhdm9pZCBmZXRjaGluZyBvbiBldmVyeSByZXF1ZXN0XG5sZXQgY2FjaGVkVG9rZW46IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5hc3luYyBmdW5jdGlvbiBnZXROb3RlaHViVG9rZW4oKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgaWYgKGNhY2hlZFRva2VuKSB7XG4gICAgcmV0dXJuIGNhY2hlZFRva2VuO1xuICB9XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBHZXRTZWNyZXRWYWx1ZUNvbW1hbmQoeyBTZWNyZXRJZDogTk9URUhVQl9TRUNSRVRfQVJOIH0pO1xuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHNlY3JldHNDbGllbnQuc2VuZChjb21tYW5kKTtcblxuICBpZiAoIXJlc3BvbnNlLlNlY3JldFN0cmluZykge1xuICAgIHRocm93IG5ldyBFcnJvcignTm90ZWh1YiBBUEkgdG9rZW4gbm90IGZvdW5kIGluIHNlY3JldCcpO1xuICB9XG5cbiAgY29uc3Qgc2VjcmV0ID0gSlNPTi5wYXJzZShyZXNwb25zZS5TZWNyZXRTdHJpbmcpO1xuICBjYWNoZWRUb2tlbiA9IHNlY3JldC50b2tlbjtcblxuICBpZiAoIWNhY2hlZFRva2VuKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdUb2tlbiBmaWVsZCBub3QgZm91bmQgaW4gc2VjcmV0Jyk7XG4gIH1cblxuICByZXR1cm4gY2FjaGVkVG9rZW47XG59XG5cbi8vIFZhbGlkIGNvbmZpZ3VyYXRpb24ga2V5cyBhbmQgdGhlaXIgdHlwZXNcbmNvbnN0IENPTkZJR19TQ0hFTUE6IFJlY29yZDxzdHJpbmcsIHsgdHlwZTogc3RyaW5nOyBtaW4/OiBudW1iZXI7IG1heD86IG51bWJlcjsgdmFsdWVzPzogc3RyaW5nW10gfT4gPSB7XG4gIG1vZGU6IHsgdHlwZTogJ3N0cmluZycsIHZhbHVlczogWydkZW1vJywgJ3RyYW5zaXQnLCAnc3RvcmFnZScsICdzbGVlcCddIH0sXG4gIGdwc19pbnRlcnZhbF9taW46IHsgdHlwZTogJ251bWJlcicsIG1pbjogMSwgbWF4OiAxNDQwIH0sXG4gIHN5bmNfaW50ZXJ2YWxfbWluOiB7IHR5cGU6ICdudW1iZXInLCBtaW46IDEsIG1heDogMTQ0MCB9LFxuICBoZWFydGJlYXRfaG91cnM6IHsgdHlwZTogJ251bWJlcicsIG1pbjogMSwgbWF4OiAxNjggfSxcbiAgdGVtcF9hbGVydF9oaWdoX2M6IHsgdHlwZTogJ251bWJlcicsIG1pbjogLTQwLCBtYXg6IDg1IH0sXG4gIHRlbXBfYWxlcnRfbG93X2M6IHsgdHlwZTogJ251bWJlcicsIG1pbjogLTQwLCBtYXg6IDg1IH0sXG4gIGh1bWlkaXR5X2FsZXJ0X2hpZ2g6IHsgdHlwZTogJ251bWJlcicsIG1pbjogMCwgbWF4OiAxMDAgfSxcbiAgaHVtaWRpdHlfYWxlcnRfbG93OiB7IHR5cGU6ICdudW1iZXInLCBtaW46IDAsIG1heDogMTAwIH0sXG4gIHByZXNzdXJlX2FsZXJ0X2RlbHRhOiB7IHR5cGU6ICdudW1iZXInLCBtaW46IDEsIG1heDogMTAwIH0sXG4gIHZvbHRhZ2VfYWxlcnRfbG93OiB7IHR5cGU6ICdudW1iZXInLCBtaW46IDMuMCwgbWF4OiA0LjIgfSxcbiAgbW90aW9uX3NlbnNpdGl2aXR5OiB7IHR5cGU6ICdzdHJpbmcnLCB2YWx1ZXM6IFsnbG93JywgJ21lZGl1bScsICdoaWdoJ10gfSxcbiAgbW90aW9uX3dha2VfZW5hYmxlZDogeyB0eXBlOiAnYm9vbGVhbicgfSxcbiAgYXVkaW9fZW5hYmxlZDogeyB0eXBlOiAnYm9vbGVhbicgfSxcbiAgYXVkaW9fdm9sdW1lOiB7IHR5cGU6ICdudW1iZXInLCBtaW46IDAsIG1heDogMTAwIH0sXG4gIGF1ZGlvX2FsZXJ0c19vbmx5OiB7IHR5cGU6ICdib29sZWFuJyB9LFxuICBjbWRfd2FrZV9lbmFibGVkOiB7IHR5cGU6ICdib29sZWFuJyB9LFxuICBjbWRfYWNrX2VuYWJsZWQ6IHsgdHlwZTogJ2Jvb2xlYW4nIH0sXG4gIGxvY2F0ZV9kdXJhdGlvbl9zZWM6IHsgdHlwZTogJ251bWJlcicsIG1pbjogNSwgbWF4OiAzMDAgfSxcbiAgbGVkX2VuYWJsZWQ6IHsgdHlwZTogJ2Jvb2xlYW4nIH0sXG4gIGRlYnVnX21vZGU6IHsgdHlwZTogJ2Jvb2xlYW4nIH0sXG4gIC8vIEdQUyBQb3dlciBNYW5hZ2VtZW50IChUcmFuc2l0IE1vZGUpXG4gIC8vIEFjdGl2ZWx5IG1hbmFnZXMgR1BTIHBvd2VyIGJhc2VkIG9uIHNpZ25hbCBhY3F1aXNpdGlvblxuICBncHNfcG93ZXJfc2F2ZV9lbmFibGVkOiB7IHR5cGU6ICdib29sZWFuJyB9LFxuICBncHNfc2lnbmFsX3RpbWVvdXRfbWluOiB7IHR5cGU6ICdudW1iZXInLCBtaW46IDEwLCBtYXg6IDMwIH0sXG4gIGdwc19yZXRyeV9pbnRlcnZhbF9taW46IHsgdHlwZTogJ251bWJlcicsIG1pbjogNSwgbWF4OiAxMjAgfSxcbn07XG5cbmV4cG9ydCBjb25zdCBoYW5kbGVyID0gYXN5bmMgKGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudCk6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiA9PiB7XG4gIGNvbnNvbGUubG9nKCdSZXF1ZXN0OicsIEpTT04uc3RyaW5naWZ5KGV2ZW50KSk7XG5cbiAgY29uc3QgY29yc0hlYWRlcnMgPSB7XG4gICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbic6ICcqJyxcbiAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctSGVhZGVycyc6ICdDb250ZW50LVR5cGUsQXV0aG9yaXphdGlvbicsXG4gICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHMnOiAnR0VULFBVVCxPUFRJT05TJyxcbiAgfTtcblxuICB0cnkge1xuICAgIC8vIEhUVFAgQVBJIHYyIHVzZXMgcmVxdWVzdENvbnRleHQuaHR0cC5tZXRob2QsIFJFU1QgQVBJIHYxIHVzZXMgaHR0cE1ldGhvZFxuICAgIGNvbnN0IG1ldGhvZCA9IChldmVudC5yZXF1ZXN0Q29udGV4dCBhcyBhbnkpPy5odHRwPy5tZXRob2QgfHwgZXZlbnQuaHR0cE1ldGhvZDtcblxuICAgIGlmIChtZXRob2QgPT09ICdPUFRJT05TJykge1xuICAgICAgcmV0dXJuIHsgc3RhdHVzQ29kZTogMjAwLCBoZWFkZXJzOiBjb3JzSGVhZGVycywgYm9keTogJycgfTtcbiAgICB9XG5cbiAgICBjb25zdCBzZXJpYWxOdW1iZXIgPSBldmVudC5wYXRoUGFyYW1ldGVycz8uc2VyaWFsX251bWJlcjtcbiAgICBjb25zdCBmbGVldFVpZCA9IGV2ZW50LnBhdGhQYXJhbWV0ZXJzPy5mbGVldF91aWQ7XG4gICAgY29uc3QgcGF0aCA9IGV2ZW50LnBhdGggfHwgKGV2ZW50LnJlcXVlc3RDb250ZXh0IGFzIGFueSk/Lmh0dHA/LnBhdGggfHwgJyc7XG4gICAgY29uc3QgaXNXaWZpRW5kcG9pbnQgPSBwYXRoLmVuZHNXaXRoKCcvd2lmaScpO1xuXG4gICAgaWYgKChtZXRob2QgPT09ICdHRVQnIHx8IG1ldGhvZCA9PT0gJ1BVVCcpICYmIHNlcmlhbE51bWJlcikge1xuICAgICAgLy8gUmVzb2x2ZSBzZXJpYWwgbnVtYmVyIHRvIGRldmljZV91aWRcbiAgICAgIGNvbnN0IGRldmljZVVpZCA9IGF3YWl0IHJlc29sdmVEZXZpY2VVaWQoc2VyaWFsTnVtYmVyKTtcbiAgICAgIGlmICghZGV2aWNlVWlkKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgICAgIGhlYWRlcnM6IGNvcnNIZWFkZXJzLFxuICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdEZXZpY2Ugbm90IGZvdW5kIGZvciBzZXJpYWwgbnVtYmVyJyB9KSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgaWYgKG1ldGhvZCA9PT0gJ0dFVCcpIHtcbiAgICAgICAgcmV0dXJuIGF3YWl0IGdldERldmljZUNvbmZpZyhkZXZpY2VVaWQsIHNlcmlhbE51bWJlciwgY29yc0hlYWRlcnMpO1xuICAgICAgfSBlbHNlIGlmIChtZXRob2QgPT09ICdQVVQnICYmIGlzV2lmaUVuZHBvaW50KSB7XG4gICAgICAgIHJldHVybiBhd2FpdCBzZXREZXZpY2VXaWZpKGRldmljZVVpZCwgc2VyaWFsTnVtYmVyLCBldmVudC5ib2R5LCBjb3JzSGVhZGVycyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4gYXdhaXQgdXBkYXRlRGV2aWNlQ29uZmlnKGRldmljZVVpZCwgc2VyaWFsTnVtYmVyLCBldmVudC5ib2R5LCBjb3JzSGVhZGVycyk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKG1ldGhvZCA9PT0gJ1BVVCcgJiYgZmxlZXRVaWQpIHtcbiAgICAgIHJldHVybiBhd2FpdCB1cGRhdGVGbGVldENvbmZpZyhmbGVldFVpZCwgZXZlbnQuYm9keSwgY29yc0hlYWRlcnMpO1xuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICBoZWFkZXJzOiBjb3JzSGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnZhbGlkIHJlcXVlc3QnIH0pLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3I6JywgZXJyb3IpO1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA1MDAsXG4gICAgICBoZWFkZXJzOiBjb3JzSGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnRlcm5hbCBzZXJ2ZXIgZXJyb3InIH0pLFxuICAgIH07XG4gIH1cbn07XG5cbmFzeW5jIGZ1bmN0aW9uIGdldERldmljZUNvbmZpZyhcbiAgZGV2aWNlVWlkOiBzdHJpbmcsXG4gIHNlcmlhbE51bWJlcjogc3RyaW5nLFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICB0cnkge1xuICAgIC8vIEdldCBlbnZpcm9ubWVudCB2YXJpYWJsZXMgZnJvbSBOb3RlaHViXG4gICAgY29uc3Qgbm90ZWh1YlRva2VuID0gYXdhaXQgZ2V0Tm90ZWh1YlRva2VuKCk7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcbiAgICAgIGBodHRwczovL2FwaS5ub3RlZmlsZS5uZXQvdjEvcHJvamVjdHMvJHtOT1RFSFVCX1BST0pFQ1RfVUlEfS9kZXZpY2VzLyR7ZGV2aWNlVWlkfS9lbnZpcm9ubWVudF92YXJpYWJsZXNgLFxuICAgICAge1xuICAgICAgICBtZXRob2Q6ICdHRVQnLFxuICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgJ0F1dGhvcml6YXRpb24nOiBgQmVhcmVyICR7bm90ZWh1YlRva2VufWAsXG4gICAgICAgIH0sXG4gICAgICB9XG4gICAgKTtcblxuICAgIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICAgIGNvbnN0IGVycm9yVGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ05vdGVodWIgQVBJIGVycm9yOicsIGVycm9yVGV4dCk7XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IHJlc3BvbnNlLnN0YXR1cyA9PT0gNDA0ID8gNDA0IDogNTAyLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRmFpbGVkIHRvIGZldGNoIGNvbmZpZyBmcm9tIE5vdGVodWInIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVzcG9uc2UuanNvbigpIGFzIHsgZW52aXJvbm1lbnRfdmFyaWFibGVzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB9O1xuICAgIGNvbnN0IHJhd0NvbmZpZyA9IGRhdGEuZW52aXJvbm1lbnRfdmFyaWFibGVzIHx8IHt9O1xuICAgIGNvbnN0IHBhcnNlZENvbmZpZyA9IHBhcnNlQ29uZmlnVmFsdWVzKHJhd0NvbmZpZyk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgc2VyaWFsX251bWJlcjogc2VyaWFsTnVtYmVyLFxuICAgICAgICBkZXZpY2VfdWlkOiBkZXZpY2VVaWQsXG4gICAgICAgIGNvbmZpZzogcGFyc2VkQ29uZmlnLFxuICAgICAgICBzY2hlbWE6IENPTkZJR19TQ0hFTUEsXG4gICAgICB9KSxcbiAgICB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIGZldGNoaW5nIGNvbmZpZzonLCBlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMixcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRmFpbGVkIHRvIGNvbW11bmljYXRlIHdpdGggTm90ZWh1YicgfSksXG4gICAgfTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiB1cGRhdGVEZXZpY2VDb25maWcoXG4gIGRldmljZVVpZDogc3RyaW5nLFxuICBzZXJpYWxOdW1iZXI6IHN0cmluZyxcbiAgYm9keTogc3RyaW5nIHwgbnVsbCxcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgaWYgKCFib2R5KSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnUmVxdWVzdCBib2R5IHJlcXVpcmVkJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgdXBkYXRlcyA9IEpTT04ucGFyc2UoYm9keSk7XG5cbiAgLy8gVmFsaWRhdGUgY29uZmlndXJhdGlvbiB2YWx1ZXNcbiAgY29uc3QgdmFsaWRhdGlvbkVycm9ycyA9IHZhbGlkYXRlQ29uZmlnKHVwZGF0ZXMpO1xuICBpZiAodmFsaWRhdGlvbkVycm9ycy5sZW5ndGggPiAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnSW52YWxpZCBjb25maWd1cmF0aW9uJywgZXJyb3JzOiB2YWxpZGF0aW9uRXJyb3JzIH0pLFxuICAgIH07XG4gIH1cblxuICB0cnkge1xuICAgIC8vIFVwZGF0ZSBlbnZpcm9ubWVudCB2YXJpYWJsZXMgaW4gTm90ZWh1YlxuICAgIGNvbnN0IG5vdGVodWJUb2tlbiA9IGF3YWl0IGdldE5vdGVodWJUb2tlbigpO1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goXG4gICAgICBgaHR0cHM6Ly9hcGkubm90ZWZpbGUubmV0L3YxL3Byb2plY3RzLyR7Tk9URUhVQl9QUk9KRUNUX1VJRH0vZGV2aWNlcy8ke2RldmljZVVpZH0vZW52aXJvbm1lbnRfdmFyaWFibGVzYCxcbiAgICAgIHtcbiAgICAgICAgbWV0aG9kOiAnUFVUJyxcbiAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke25vdGVodWJUb2tlbn1gLFxuICAgICAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICAgIH0sXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZW52aXJvbm1lbnRfdmFyaWFibGVzOiBzdHJpbmdpZnlWYWx1ZXModXBkYXRlcykgfSksXG4gICAgICB9XG4gICAgKTtcblxuICAgIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICAgIGNvbnN0IGVycm9yVGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ05vdGVodWIgQVBJIGVycm9yOicsIGVycm9yVGV4dCk7XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDUwMixcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0ZhaWxlZCB0byB1cGRhdGUgY29uZmlnIGluIE5vdGVodWInIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBJZiBtb2RlIHdhcyBjaGFuZ2VkLCB3cml0ZSBwZW5kaW5nX21vZGUgdG8gRGV2aWNlcyB0YWJsZVxuICAgIGlmICh1cGRhdGVzLm1vZGUpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGRvY0NsaWVudC5zZW5kKG5ldyBVcGRhdGVDb21tYW5kKHtcbiAgICAgICAgICBUYWJsZU5hbWU6IERFVklDRVNfVEFCTEUsXG4gICAgICAgICAgS2V5OiB7IGRldmljZV91aWQ6IGRldmljZVVpZCB9LFxuICAgICAgICAgIFVwZGF0ZUV4cHJlc3Npb246ICdTRVQgcGVuZGluZ19tb2RlID0gOnBtJyxcbiAgICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7ICc6cG0nOiB1cGRhdGVzLm1vZGUgfSxcbiAgICAgICAgfSkpO1xuICAgICAgICBjb25zb2xlLmxvZyhgU2V0IHBlbmRpbmdfbW9kZT0ke3VwZGF0ZXMubW9kZX0gZm9yIGRldmljZSAke2RldmljZVVpZH1gKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zb2xlLmVycm9yKCdGYWlsZWQgdG8gc2V0IHBlbmRpbmdfbW9kZSAobm9uLWZhdGFsKTonLCBlcnIpO1xuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBzZXJpYWxfbnVtYmVyOiBzZXJpYWxOdW1iZXIsXG4gICAgICAgIGRldmljZV91aWQ6IGRldmljZVVpZCxcbiAgICAgICAgY29uZmlnOiB1cGRhdGVzLFxuICAgICAgICBtZXNzYWdlOiAnQ29uZmlndXJhdGlvbiB1cGRhdGVkLiBDaGFuZ2VzIHdpbGwgdGFrZSBlZmZlY3Qgb24gbmV4dCBkZXZpY2Ugc3luYy4nLFxuICAgICAgfSksXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvciB1cGRhdGluZyBjb25maWc6JywgZXJyb3IpO1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA1MDIsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0ZhaWxlZCB0byBjb21tdW5pY2F0ZSB3aXRoIE5vdGVodWInIH0pLFxuICAgIH07XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gdXBkYXRlRmxlZXRDb25maWcoXG4gIGZsZWV0VWlkOiBzdHJpbmcsXG4gIGJvZHk6IHN0cmluZyB8IG51bGwsXG4gIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiB7XG4gIGlmICghYm9keSkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1JlcXVlc3QgYm9keSByZXF1aXJlZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHVwZGF0ZXMgPSBKU09OLnBhcnNlKGJvZHkpO1xuXG4gIC8vIFZhbGlkYXRlIGNvbmZpZ3VyYXRpb24gdmFsdWVzXG4gIGNvbnN0IHZhbGlkYXRpb25FcnJvcnMgPSB2YWxpZGF0ZUNvbmZpZyh1cGRhdGVzKTtcbiAgaWYgKHZhbGlkYXRpb25FcnJvcnMubGVuZ3RoID4gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0ludmFsaWQgY29uZmlndXJhdGlvbicsIGVycm9yczogdmFsaWRhdGlvbkVycm9ycyB9KSxcbiAgICB9O1xuICB9XG5cbiAgdHJ5IHtcbiAgICAvLyBVcGRhdGUgZmxlZXQgZW52aXJvbm1lbnQgdmFyaWFibGVzIGluIE5vdGVodWJcbiAgICBjb25zdCBub3RlaHViVG9rZW4gPSBhd2FpdCBnZXROb3RlaHViVG9rZW4oKTtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFxuICAgICAgYGh0dHBzOi8vYXBpLm5vdGVmaWxlLm5ldC92MS9wcm9qZWN0cy8ke05PVEVIVUJfUFJPSkVDVF9VSUR9L2ZsZWV0cy8ke2ZsZWV0VWlkfS9lbnZpcm9ubWVudF92YXJpYWJsZXNgLFxuICAgICAge1xuICAgICAgICBtZXRob2Q6ICdQVVQnLFxuICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgJ0F1dGhvcml6YXRpb24nOiBgQmVhcmVyICR7bm90ZWh1YlRva2VufWAsXG4gICAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgfSxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlbnZpcm9ubWVudF92YXJpYWJsZXM6IHN0cmluZ2lmeVZhbHVlcyh1cGRhdGVzKSB9KSxcbiAgICAgIH1cbiAgICApO1xuXG4gICAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgICAgY29uc3QgZXJyb3JUZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgICAgY29uc29sZS5lcnJvcignTm90ZWh1YiBBUEkgZXJyb3I6JywgZXJyb3JUZXh0KTtcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNTAyLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRmFpbGVkIHRvIHVwZGF0ZSBmbGVldCBjb25maWcgaW4gTm90ZWh1YicgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBmbGVldF91aWQ6IGZsZWV0VWlkLFxuICAgICAgICBjb25maWc6IHVwZGF0ZXMsXG4gICAgICAgIG1lc3NhZ2U6ICdGbGVldCBjb25maWd1cmF0aW9uIHVwZGF0ZWQuIENoYW5nZXMgd2lsbCB0YWtlIGVmZmVjdCBvbiBuZXh0IGRldmljZSBzeW5jLicsXG4gICAgICB9KSxcbiAgICB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHVwZGF0aW5nIGZsZWV0IGNvbmZpZzonLCBlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMixcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRmFpbGVkIHRvIGNvbW11bmljYXRlIHdpdGggTm90ZWh1YicgfSksXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIFNldCBkZXZpY2UgV2ktRmkgY3JlZGVudGlhbHMgdmlhIHRoZSBfd2lmaSBlbnZpcm9ubWVudCB2YXJpYWJsZVxuICogRm9ybWF0OiBbXCJTU0lEXCIsXCJQQVNTV09SRFwiXVxuICovXG5hc3luYyBmdW5jdGlvbiBzZXREZXZpY2VXaWZpKFxuICBkZXZpY2VVaWQ6IHN0cmluZyxcbiAgc2VyaWFsTnVtYmVyOiBzdHJpbmcsXG4gIGJvZHk6IHN0cmluZyB8IG51bGwsXG4gIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiB7XG4gIGlmICghYm9keSkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1JlcXVlc3QgYm9keSByZXF1aXJlZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHsgc3NpZCwgcGFzc3dvcmQgfSA9IEpTT04ucGFyc2UoYm9keSk7XG5cbiAgLy8gVmFsaWRhdGUgaW5wdXRzXG4gIGlmICghc3NpZCB8fCB0eXBlb2Ygc3NpZCAhPT0gJ3N0cmluZycgfHwgc3NpZC50cmltKCkgPT09ICcnKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnU1NJRCBpcyByZXF1aXJlZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIGlmIChwYXNzd29yZCA9PT0gdW5kZWZpbmVkIHx8IHBhc3N3b3JkID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnUGFzc3dvcmQgaXMgcmVxdWlyZWQgKGNhbiBiZSBlbXB0eSBzdHJpbmcgZm9yIG9wZW4gbmV0d29ya3MpJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gRm9ybWF0IHRoZSBfd2lmaSB2YWx1ZSBhcyBwZXIgTm90ZWh1YiBkb2N1bWVudGF0aW9uOiBbXCJTU0lEXCIsXCJQQVNTV09SRFwiXVxuICBjb25zdCB3aWZpVmFsdWUgPSBgW1wiJHtzc2lkfVwiLFwiJHtwYXNzd29yZH1cIl1gO1xuXG4gIHRyeSB7XG4gICAgY29uc3Qgbm90ZWh1YlRva2VuID0gYXdhaXQgZ2V0Tm90ZWh1YlRva2VuKCk7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcbiAgICAgIGBodHRwczovL2FwaS5ub3RlZmlsZS5uZXQvdjEvcHJvamVjdHMvJHtOT1RFSFVCX1BST0pFQ1RfVUlEfS9kZXZpY2VzLyR7ZGV2aWNlVWlkfS9lbnZpcm9ubWVudF92YXJpYWJsZXNgLFxuICAgICAge1xuICAgICAgICBtZXRob2Q6ICdQVVQnLFxuICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgJ0F1dGhvcml6YXRpb24nOiBgQmVhcmVyICR7bm90ZWh1YlRva2VufWAsXG4gICAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgfSxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlbnZpcm9ubWVudF92YXJpYWJsZXM6IHsgX3dpZmk6IHdpZmlWYWx1ZSB9IH0pLFxuICAgICAgfVxuICAgICk7XG5cbiAgICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgICBjb25zdCBlcnJvclRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG4gICAgICBjb25zb2xlLmVycm9yKCdOb3RlaHViIEFQSSBlcnJvcjonLCBlcnJvclRleHQpO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiA1MDIsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdGYWlsZWQgdG8gc2V0IFdpLUZpIGNyZWRlbnRpYWxzIGluIE5vdGVodWInIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBEb24ndCBsb2cgcGFzc3dvcmRcbiAgICBjb25zb2xlLmxvZyhgV2ktRmkgY3JlZGVudGlhbHMgc2V0IGZvciBkZXZpY2UgJHtzZXJpYWxOdW1iZXJ9IChTU0lEOiAke3NzaWR9KWApO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHN1Y2Nlc3M6IHRydWUsXG4gICAgICAgIHNlcmlhbF9udW1iZXI6IHNlcmlhbE51bWJlcixcbiAgICAgICAgbWVzc2FnZTogJ1dpLUZpIGNyZWRlbnRpYWxzIHNldC4gQ2hhbmdlcyB3aWxsIHRha2UgZWZmZWN0IG9uIG5leHQgZGV2aWNlIHN5bmMuJyxcbiAgICAgIH0pLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3Igc2V0dGluZyBXaS1GaSBjcmVkZW50aWFsczonLCBlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMixcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRmFpbGVkIHRvIGNvbW11bmljYXRlIHdpdGggTm90ZWh1YicgfSksXG4gICAgfTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUNvbmZpZyhjb25maWc6IFJlY29yZDxzdHJpbmcsIGFueT4pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGVycm9yczogc3RyaW5nW10gPSBbXTtcblxuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhjb25maWcpKSB7XG4gICAgY29uc3Qgc2NoZW1hID0gQ09ORklHX1NDSEVNQVtrZXldO1xuXG4gICAgLy8gU2tpcCB1bmtub3duIGtleXMgLSB0aGV5IHdpbGwgYmUgZmlsdGVyZWQgb3V0IGluIHN0cmluZ2lmeVZhbHVlc1xuICAgIGlmICghc2NoZW1hKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBpZiAoc2NoZW1hLnR5cGUgPT09ICdudW1iZXInKSB7XG4gICAgICBjb25zdCBudW1WYWx1ZSA9IHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgPyBwYXJzZUZsb2F0KHZhbHVlKSA6IHZhbHVlO1xuICAgICAgaWYgKGlzTmFOKG51bVZhbHVlKSkge1xuICAgICAgICBlcnJvcnMucHVzaChgJHtrZXl9IG11c3QgYmUgYSBudW1iZXJgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChzY2hlbWEubWluICE9PSB1bmRlZmluZWQgJiYgbnVtVmFsdWUgPCBzY2hlbWEubWluKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goYCR7a2V5fSBtdXN0IGJlID49ICR7c2NoZW1hLm1pbn1gKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc2NoZW1hLm1heCAhPT0gdW5kZWZpbmVkICYmIG51bVZhbHVlID4gc2NoZW1hLm1heCkge1xuICAgICAgICAgIGVycm9ycy5wdXNoKGAke2tleX0gbXVzdCBiZSA8PSAke3NjaGVtYS5tYXh9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoc2NoZW1hLnR5cGUgPT09ICdzdHJpbmcnICYmIHNjaGVtYS52YWx1ZXMpIHtcbiAgICAgIGlmICghc2NoZW1hLnZhbHVlcy5pbmNsdWRlcyh2YWx1ZSkpIHtcbiAgICAgICAgZXJyb3JzLnB1c2goYCR7a2V5fSBtdXN0IGJlIG9uZSBvZjogJHtzY2hlbWEudmFsdWVzLmpvaW4oJywgJyl9YCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHNjaGVtYS50eXBlID09PSAnYm9vbGVhbicpIHtcbiAgICAgIGNvbnN0IGJvb2xWYWx1ZSA9IHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgPyB2YWx1ZSA9PT0gJ3RydWUnIDogdmFsdWU7XG4gICAgICBpZiAodHlwZW9mIGJvb2xWYWx1ZSAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgIGVycm9ycy5wdXNoKGAke2tleX0gbXVzdCBiZSBhIGJvb2xlYW5gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gZXJyb3JzO1xufVxuXG5mdW5jdGlvbiBzdHJpbmdpZnlWYWx1ZXMoY29uZmlnOiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG4gIGNvbnN0IHJlc3VsdDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuXG4gIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKGNvbmZpZykpIHtcbiAgICAvLyBPbmx5IGluY2x1ZGUga2V5cyB0aGF0IGFyZSBpbiBvdXIgc2NoZW1hXG4gICAgaWYgKENPTkZJR19TQ0hFTUFba2V5XSkge1xuICAgICAgcmVzdWx0W2tleV0gPSBTdHJpbmcodmFsdWUpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiByZXN1bHQ7XG59XG5cbmZ1bmN0aW9uIHBhcnNlQ29uZmlnVmFsdWVzKGNvbmZpZzogUmVjb3JkPHN0cmluZywgc3RyaW5nPik6IFJlY29yZDxzdHJpbmcsIGFueT4ge1xuICBjb25zdCByZXN1bHQ6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7fTtcblxuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhjb25maWcpKSB7XG4gICAgY29uc3Qgc2NoZW1hID0gQ09ORklHX1NDSEVNQVtrZXldO1xuXG4gICAgaWYgKCFzY2hlbWEpIHtcbiAgICAgIC8vIEtlZXAgdW5rbm93biBrZXlzIGFzLWlzXG4gICAgICByZXN1bHRba2V5XSA9IHZhbHVlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgLy8gUGFyc2UgYmFzZWQgb24gZXhwZWN0ZWQgdHlwZVxuICAgIGlmIChzY2hlbWEudHlwZSA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgICByZXN1bHRba2V5XSA9IHZhbHVlID09PSAndHJ1ZSc7XG4gICAgfSBlbHNlIGlmIChzY2hlbWEudHlwZSA9PT0gJ251bWJlcicpIHtcbiAgICAgIGNvbnN0IG51bVZhbHVlID0gcGFyc2VGbG9hdCh2YWx1ZSk7XG4gICAgICByZXN1bHRba2V5XSA9IGlzTmFOKG51bVZhbHVlKSA/IHZhbHVlIDogbnVtVmFsdWU7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlc3VsdFtrZXldID0gdmFsdWU7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJlc3VsdDtcbn1cbiJdfQ==