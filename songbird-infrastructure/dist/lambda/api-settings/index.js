"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const client_secrets_manager_1 = require("@aws-sdk/client-secrets-manager");
const client = new client_dynamodb_1.DynamoDBClient({});
const docClient = lib_dynamodb_1.DynamoDBDocumentClient.from(client);
const secretsClient = new client_secrets_manager_1.SecretsManagerClient({});
const SETTINGS_TABLE = process.env.SETTINGS_TABLE || 'songbird-settings';
const NOTEHUB_PROJECT_UID = process.env.NOTEHUB_PROJECT_UID;
const NOTEHUB_SECRET_ARN = process.env.NOTEHUB_SECRET_ARN;
// Cache the Notehub token
let cachedNotehubToken = null;
async function getNotehubToken() {
    if (!NOTEHUB_SECRET_ARN) {
        console.warn('NOTEHUB_SECRET_ARN not configured');
        return null;
    }
    if (cachedNotehubToken) {
        return cachedNotehubToken;
    }
    try {
        const command = new client_secrets_manager_1.GetSecretValueCommand({ SecretId: NOTEHUB_SECRET_ARN });
        const response = await secretsClient.send(command);
        if (!response.SecretString) {
            console.error('Notehub API token not found in secret');
            return null;
        }
        const secret = JSON.parse(response.SecretString);
        cachedNotehubToken = secret.token;
        return cachedNotehubToken;
    }
    catch (error) {
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
// Validation schema for fleet defaults
const fleetDefaultsSchema = {
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
function isAdmin(event) {
    try {
        const claims = event.requestContext?.authorizer?.jwt?.claims;
        if (!claims)
            return false;
        // cognito:groups is either a string or array depending on number of groups
        const groups = claims['cognito:groups'];
        if (Array.isArray(groups)) {
            return groups.includes('Admin');
        }
        if (typeof groups === 'string') {
            return groups === 'Admin' || groups.includes('Admin');
        }
        return false;
    }
    catch {
        return false;
    }
}
/**
 * Push fleet defaults to Notehub as fleet environment variables
 * This makes the config available to all devices in the fleet
 */
async function pushToNotehub(fleetUid, config) {
    if (!NOTEHUB_PROJECT_UID) {
        console.warn('NOTEHUB_PROJECT_UID not configured, skipping Notehub push');
        return { success: false, error: 'Notehub not configured' };
    }
    const token = await getNotehubToken();
    if (!token) {
        return { success: false, error: 'Could not get Notehub token' };
    }
    // Convert config values to strings for Notehub environment variables
    const envVars = {};
    for (const [key, value] of Object.entries(config)) {
        if (value !== undefined && value !== null) {
            envVars[key] = String(value);
        }
    }
    try {
        const response = await fetch(`https://api.notefile.net/v1/projects/${NOTEHUB_PROJECT_UID}/fleets/${fleetUid}/environment_variables`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ environment_variables: envVars }),
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Notehub API error:', response.status, errorText);
            return { success: false, error: `Notehub API error: ${response.status}` };
        }
        console.log(`Successfully pushed fleet defaults to Notehub for fleet ${fleetUid}`);
        return { success: true };
    }
    catch (error) {
        console.error('Error pushing to Notehub:', error);
        return { success: false, error: String(error) };
    }
}
function validateFleetDefaults(config) {
    const errors = [];
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
        }
        else if (schema.type === 'string') {
            if (typeof value !== 'string') {
                errors.push(`${key} must be a string`);
                continue;
            }
            if (schema.values && !schema.values.includes(value)) {
                errors.push(`${key} must be one of: ${schema.values.join(', ')}`);
            }
        }
        else if (schema.type === 'boolean') {
            if (typeof value !== 'boolean') {
                errors.push(`${key} must be a boolean`);
            }
        }
    }
    return { valid: errors.length === 0, errors };
}
async function handler(event) {
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
            const result = await docClient.send(new lib_dynamodb_1.QueryCommand({
                TableName: SETTINGS_TABLE,
                KeyConditionExpression: 'setting_type = :type',
                ExpressionAttributeValues: {
                    ':type': 'fleet_defaults',
                },
            }));
            const fleetDefaults = (result.Items || []).map((item) => ({
                fleet_uid: item.setting_id,
                ...(item.config || {}),
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
            const result = await docClient.send(new lib_dynamodb_1.GetCommand({
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
            let config;
            try {
                config = JSON.parse(event.body || '{}');
            }
            catch {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: 'Invalid JSON body' }),
                };
            }
            // Validate config
            const validation = validateFleetDefaults(config);
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
            await docClient.send(new lib_dynamodb_1.PutCommand({
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
    }
    catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Internal server error' }),
        };
    }
}
exports.handler = handler;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLXNldHRpbmdzL2luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7O0dBU0c7OztBQUVILDhEQUEwRDtBQUMxRCx3REFBcUc7QUFDckcsNEVBQThGO0FBRzlGLE1BQU0sTUFBTSxHQUFHLElBQUksZ0NBQWMsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN0QyxNQUFNLFNBQVMsR0FBRyxxQ0FBc0IsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUM7QUFDdEQsTUFBTSxhQUFhLEdBQUcsSUFBSSw2Q0FBb0IsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUVuRCxNQUFNLGNBQWMsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGNBQWMsSUFBSSxtQkFBbUIsQ0FBQztBQUN6RSxNQUFNLG1CQUFtQixHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW1CLENBQUM7QUFDNUQsTUFBTSxrQkFBa0IsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGtCQUFrQixDQUFDO0FBRTFELDBCQUEwQjtBQUMxQixJQUFJLGtCQUFrQixHQUFrQixJQUFJLENBQUM7QUFFN0MsS0FBSyxVQUFVLGVBQWU7SUFDNUIsSUFBSSxDQUFDLGtCQUFrQixFQUFFLENBQUM7UUFDeEIsT0FBTyxDQUFDLElBQUksQ0FBQyxtQ0FBbUMsQ0FBQyxDQUFDO1FBQ2xELE9BQU8sSUFBSSxDQUFDO0lBQ2QsQ0FBQztJQUVELElBQUksa0JBQWtCLEVBQUUsQ0FBQztRQUN2QixPQUFPLGtCQUFrQixDQUFDO0lBQzVCLENBQUM7SUFFRCxJQUFJLENBQUM7UUFDSCxNQUFNLE9BQU8sR0FBRyxJQUFJLDhDQUFxQixDQUFDLEVBQUUsUUFBUSxFQUFFLGtCQUFrQixFQUFFLENBQUMsQ0FBQztRQUM1RSxNQUFNLFFBQVEsR0FBRyxNQUFNLGFBQWEsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7UUFFbkQsSUFBSSxDQUFDLFFBQVEsQ0FBQyxZQUFZLEVBQUUsQ0FBQztZQUMzQixPQUFPLENBQUMsS0FBSyxDQUFDLHVDQUF1QyxDQUFDLENBQUM7WUFDdkQsT0FBTyxJQUFJLENBQUM7UUFDZCxDQUFDO1FBRUQsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsWUFBWSxDQUFDLENBQUM7UUFDakQsa0JBQWtCLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQztRQUNsQyxPQUFPLGtCQUFrQixDQUFDO0lBQzVCLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2YsT0FBTyxDQUFDLEtBQUssQ0FBQywrQkFBK0IsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUN0RCxPQUFPLElBQUksQ0FBQztJQUNkLENBQUM7QUFDSCxDQUFDO0FBRUQsTUFBTSxPQUFPLEdBQUc7SUFDZCxjQUFjLEVBQUUsa0JBQWtCO0lBQ2xDLDZCQUE2QixFQUFFLEdBQUc7SUFDbEMsOEJBQThCLEVBQUUsNEJBQTRCO0lBQzVELDhCQUE4QixFQUFFLGlCQUFpQjtDQUNsRCxDQUFDO0FBcUJGLHVDQUF1QztBQUN2QyxNQUFNLG1CQUFtQixHQUFvRjtJQUMzRyxJQUFJLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLE1BQU0sRUFBRSxDQUFDLE1BQU0sRUFBRSxTQUFTLEVBQUUsU0FBUyxFQUFFLE9BQU8sQ0FBQyxFQUFFO0lBQ3pFLGdCQUFnQixFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxHQUFHLEVBQUUsQ0FBQyxFQUFFLEdBQUcsRUFBRSxJQUFJLEVBQUU7SUFDdkQsaUJBQWlCLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUUsR0FBRyxFQUFFLElBQUksRUFBRTtJQUN4RCxlQUFlLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRTtJQUNyRCxpQkFBaUIsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsR0FBRyxFQUFFLENBQUMsRUFBRSxFQUFFLEdBQUcsRUFBRSxFQUFFLEVBQUU7SUFDeEQsZ0JBQWdCLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUUsRUFBRSxHQUFHLEVBQUUsRUFBRSxFQUFFO0lBQ3ZELG1CQUFtQixFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxHQUFHLEVBQUUsQ0FBQyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUU7SUFDekQsa0JBQWtCLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRTtJQUN4RCxpQkFBaUIsRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFO0lBQ3pELGtCQUFrQixFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxNQUFNLEVBQUUsQ0FBQyxLQUFLLEVBQUUsUUFBUSxFQUFFLE1BQU0sQ0FBQyxFQUFFO0lBQ3pFLGFBQWEsRUFBRSxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUU7SUFDbEMsV0FBVyxFQUFFLEVBQUUsSUFBSSxFQUFFLFNBQVMsRUFBRTtJQUNoQyw4REFBOEQ7SUFDOUQsc0JBQXNCLEVBQUUsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFO0lBQzNDLHNCQUFzQixFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxHQUFHLEVBQUUsRUFBRSxFQUFFLEdBQUcsRUFBRSxFQUFFLEVBQUU7SUFDNUQsc0JBQXNCLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLEdBQUcsRUFBRSxDQUFDLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRTtDQUM3RCxDQUFDO0FBRUYsU0FBUyxPQUFPLENBQUMsS0FBOEM7SUFDN0QsSUFBSSxDQUFDO1FBQ0gsTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLGNBQWMsRUFBRSxVQUFVLEVBQUUsR0FBRyxFQUFFLE1BQU0sQ0FBQztRQUM3RCxJQUFJLENBQUMsTUFBTTtZQUFFLE9BQU8sS0FBSyxDQUFDO1FBRTFCLDJFQUEyRTtRQUMzRSxNQUFNLE1BQU0sR0FBRyxNQUFNLENBQUMsZ0JBQWdCLENBQUMsQ0FBQztRQUN4QyxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztZQUMxQixPQUFPLE1BQU0sQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLENBQUM7UUFDbEMsQ0FBQztRQUNELElBQUksT0FBTyxNQUFNLEtBQUssUUFBUSxFQUFFLENBQUM7WUFDL0IsT0FBTyxNQUFNLEtBQUssT0FBTyxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLENBQUM7UUFDeEQsQ0FBQztRQUNELE9BQU8sS0FBSyxDQUFDO0lBQ2YsQ0FBQztJQUFDLE1BQU0sQ0FBQztRQUNQLE9BQU8sS0FBSyxDQUFDO0lBQ2YsQ0FBQztBQUNILENBQUM7QUFFRDs7O0dBR0c7QUFDSCxLQUFLLFVBQVUsYUFBYSxDQUFDLFFBQWdCLEVBQUUsTUFBcUI7SUFDbEUsSUFBSSxDQUFDLG1CQUFtQixFQUFFLENBQUM7UUFDekIsT0FBTyxDQUFDLElBQUksQ0FBQywyREFBMkQsQ0FBQyxDQUFDO1FBQzFFLE9BQU8sRUFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSx3QkFBd0IsRUFBRSxDQUFDO0lBQzdELENBQUM7SUFFRCxNQUFNLEtBQUssR0FBRyxNQUFNLGVBQWUsRUFBRSxDQUFDO0lBQ3RDLElBQUksQ0FBQyxLQUFLLEVBQUUsQ0FBQztRQUNYLE9BQU8sRUFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSw2QkFBNkIsRUFBRSxDQUFDO0lBQ2xFLENBQUM7SUFFRCxxRUFBcUU7SUFDckUsTUFBTSxPQUFPLEdBQTJCLEVBQUUsQ0FBQztJQUMzQyxLQUFLLE1BQU0sQ0FBQyxHQUFHLEVBQUUsS0FBSyxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1FBQ2xELElBQUksS0FBSyxLQUFLLFNBQVMsSUFBSSxLQUFLLEtBQUssSUFBSSxFQUFFLENBQUM7WUFDMUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUMvQixDQUFDO0lBQ0gsQ0FBQztJQUVELElBQUksQ0FBQztRQUNILE1BQU0sUUFBUSxHQUFHLE1BQU0sS0FBSyxDQUMxQix3Q0FBd0MsbUJBQW1CLFdBQVcsUUFBUSx3QkFBd0IsRUFDdEc7WUFDRSxNQUFNLEVBQUUsS0FBSztZQUNiLE9BQU8sRUFBRTtnQkFDUCxlQUFlLEVBQUUsVUFBVSxLQUFLLEVBQUU7Z0JBQ2xDLGNBQWMsRUFBRSxrQkFBa0I7YUFDbkM7WUFDRCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLHFCQUFxQixFQUFFLE9BQU8sRUFBRSxDQUFDO1NBQ3pELENBQ0YsQ0FBQztRQUVGLElBQUksQ0FBQyxRQUFRLENBQUMsRUFBRSxFQUFFLENBQUM7WUFDakIsTUFBTSxTQUFTLEdBQUcsTUFBTSxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDeEMsT0FBTyxDQUFDLEtBQUssQ0FBQyxvQkFBb0IsRUFBRSxRQUFRLENBQUMsTUFBTSxFQUFFLFNBQVMsQ0FBQyxDQUFDO1lBQ2hFLE9BQU8sRUFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxzQkFBc0IsUUFBUSxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUM7UUFDNUUsQ0FBQztRQUVELE9BQU8sQ0FBQyxHQUFHLENBQUMsMkRBQTJELFFBQVEsRUFBRSxDQUFDLENBQUM7UUFDbkYsT0FBTyxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsQ0FBQztJQUMzQixDQUFDO0lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztRQUNmLE9BQU8sQ0FBQyxLQUFLLENBQUMsMkJBQTJCLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDbEQsT0FBTyxFQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLE1BQU0sQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO0lBQ2xELENBQUM7QUFDSCxDQUFDO0FBRUQsU0FBUyxxQkFBcUIsQ0FBQyxNQUErQjtJQUM1RCxNQUFNLE1BQU0sR0FBYSxFQUFFLENBQUM7SUFFNUIsS0FBSyxNQUFNLENBQUMsR0FBRyxFQUFFLEtBQUssQ0FBQyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztRQUNsRCxNQUFNLE1BQU0sR0FBRyxtQkFBbUIsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUN4QyxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUM7WUFDWixNQUFNLENBQUMsSUFBSSxDQUFDLG9CQUFvQixHQUFHLEVBQUUsQ0FBQyxDQUFDO1lBQ3ZDLFNBQVM7UUFDWCxDQUFDO1FBRUQsSUFBSSxNQUFNLENBQUMsSUFBSSxLQUFLLFFBQVEsRUFBRSxDQUFDO1lBQzdCLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxFQUFFLENBQUM7Z0JBQzlCLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxHQUFHLG1CQUFtQixDQUFDLENBQUM7Z0JBQ3ZDLFNBQVM7WUFDWCxDQUFDO1lBQ0QsSUFBSSxNQUFNLENBQUMsR0FBRyxLQUFLLFNBQVMsSUFBSSxLQUFLLEdBQUcsTUFBTSxDQUFDLEdBQUcsRUFBRSxDQUFDO2dCQUNuRCxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsR0FBRyxxQkFBcUIsTUFBTSxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUM7WUFDdkQsQ0FBQztZQUNELElBQUksTUFBTSxDQUFDLEdBQUcsS0FBSyxTQUFTLElBQUksS0FBSyxHQUFHLE1BQU0sQ0FBQyxHQUFHLEVBQUUsQ0FBQztnQkFDbkQsTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLEdBQUcsb0JBQW9CLE1BQU0sQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDO1lBQ3RELENBQUM7UUFDSCxDQUFDO2FBQU0sSUFBSSxNQUFNLENBQUMsSUFBSSxLQUFLLFFBQVEsRUFBRSxDQUFDO1lBQ3BDLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxFQUFFLENBQUM7Z0JBQzlCLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxHQUFHLG1CQUFtQixDQUFDLENBQUM7Z0JBQ3ZDLFNBQVM7WUFDWCxDQUFDO1lBQ0QsSUFBSSxNQUFNLENBQUMsTUFBTSxJQUFJLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztnQkFDcEQsTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLEdBQUcsb0JBQW9CLE1BQU0sQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztZQUNwRSxDQUFDO1FBQ0gsQ0FBQzthQUFNLElBQUksTUFBTSxDQUFDLElBQUksS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUNyQyxJQUFJLE9BQU8sS0FBSyxLQUFLLFNBQVMsRUFBRSxDQUFDO2dCQUMvQixNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsR0FBRyxvQkFBb0IsQ0FBQyxDQUFDO1lBQzFDLENBQUM7UUFDSCxDQUFDO0lBQ0gsQ0FBQztJQUVELE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUUsTUFBTSxFQUFFLENBQUM7QUFDaEQsQ0FBQztBQUVNLEtBQUssVUFBVSxPQUFPLENBQUMsS0FBOEM7SUFDMUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxRQUFRLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFFdEQsTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLGNBQWMsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDO0lBQ2hELE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxPQUFPLENBQUM7SUFFM0IsMEJBQTBCO0lBQzFCLElBQUksTUFBTSxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQ3pCLE9BQU8sRUFBRSxVQUFVLEVBQUUsR0FBRyxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsRUFBRSxFQUFFLENBQUM7SUFDaEQsQ0FBQztJQUVELElBQUksQ0FBQztRQUNILHlFQUF5RTtRQUN6RSxJQUFJLE1BQU0sS0FBSyxLQUFLLElBQUksSUFBSSxLQUFLLDZCQUE2QixFQUFFLENBQUM7WUFDL0QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO2dCQUNwQixPQUFPO29CQUNMLFVBQVUsRUFBRSxHQUFHO29CQUNmLE9BQU87b0JBQ1AsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxLQUFLLEVBQUUsdUJBQXVCLEVBQUUsQ0FBQztpQkFDekQsQ0FBQztZQUNKLENBQUM7WUFFRCxNQUFNLE1BQU0sR0FBRyxNQUFNLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSwyQkFBWSxDQUFDO2dCQUNuRCxTQUFTLEVBQUUsY0FBYztnQkFDekIsc0JBQXNCLEVBQUUsc0JBQXNCO2dCQUM5Qyx5QkFBeUIsRUFBRTtvQkFDekIsT0FBTyxFQUFFLGdCQUFnQjtpQkFDMUI7YUFDRixDQUFDLENBQUMsQ0FBQztZQUVKLE1BQU0sYUFBYSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUssSUFBSSxFQUFFLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUE2QixFQUFFLEVBQUUsQ0FBQyxDQUFDO2dCQUNqRixTQUFTLEVBQUUsSUFBSSxDQUFDLFVBQVU7Z0JBQzFCLEdBQUcsQ0FBQyxJQUFJLENBQUMsTUFBaUMsSUFBSSxFQUFFLENBQUM7Z0JBQ2pELFVBQVUsRUFBRSxJQUFJLENBQUMsVUFBVTtnQkFDM0IsVUFBVSxFQUFFLElBQUksQ0FBQyxVQUFVO2FBQzVCLENBQUMsQ0FBQyxDQUFDO1lBRUosT0FBTztnQkFDTCxVQUFVLEVBQUUsR0FBRztnQkFDZixPQUFPO2dCQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsY0FBYyxFQUFFLGFBQWEsRUFBRSxDQUFDO2FBQ3hELENBQUM7UUFDSixDQUFDO1FBRUQsd0VBQXdFO1FBQ3hFLElBQUksTUFBTSxLQUFLLEtBQUssSUFBSSxJQUFJLENBQUMsVUFBVSxDQUFDLDhCQUE4QixDQUFDLEVBQUUsQ0FBQztZQUN4RSxNQUFNLFFBQVEsR0FBRyxLQUFLLENBQUMsY0FBYyxFQUFFLEtBQUssQ0FBQztZQUM3QyxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7Z0JBQ2QsT0FBTztvQkFDTCxVQUFVLEVBQUUsR0FBRztvQkFDZixPQUFPO29CQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsS0FBSyxFQUFFLG9CQUFvQixFQUFFLENBQUM7aUJBQ3RELENBQUM7WUFDSixDQUFDO1lBRUQsTUFBTSxNQUFNLEdBQUcsTUFBTSxTQUFTLENBQUMsSUFBSSxDQUFDLElBQUkseUJBQVUsQ0FBQztnQkFDakQsU0FBUyxFQUFFLGNBQWM7Z0JBQ3pCLEdBQUcsRUFBRTtvQkFDSCxZQUFZLEVBQUUsZ0JBQWdCO29CQUM5QixVQUFVLEVBQUUsUUFBUTtpQkFDckI7YUFDRixDQUFDLENBQUMsQ0FBQztZQUVKLElBQUksQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLENBQUM7Z0JBQ2pCLG9DQUFvQztnQkFDcEMsT0FBTztvQkFDTCxVQUFVLEVBQUUsR0FBRztvQkFDZixPQUFPO29CQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDO3dCQUNuQixTQUFTLEVBQUUsUUFBUTt3QkFDbkIsTUFBTSxFQUFFLEVBQUU7d0JBQ1YsTUFBTSxFQUFFLG1CQUFtQjtxQkFDNUIsQ0FBQztpQkFDSCxDQUFDO1lBQ0osQ0FBQztZQUVELE9BQU87Z0JBQ0wsVUFBVSxFQUFFLEdBQUc7Z0JBQ2YsT0FBTztnQkFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQztvQkFDbkIsU0FBUyxFQUFFLFFBQVE7b0JBQ25CLE1BQU0sRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLE1BQU0sSUFBSSxFQUFFO29CQUNoQyxNQUFNLEVBQUUsbUJBQW1CO29CQUMzQixVQUFVLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxVQUFVO29CQUNsQyxVQUFVLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxVQUFVO2lCQUNuQyxDQUFDO2FBQ0gsQ0FBQztRQUNKLENBQUM7UUFFRCwrRUFBK0U7UUFDL0UsSUFBSSxNQUFNLEtBQUssS0FBSyxJQUFJLElBQUksQ0FBQyxVQUFVLENBQUMsOEJBQThCLENBQUMsRUFBRSxDQUFDO1lBQ3hFLElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztnQkFDcEIsT0FBTztvQkFDTCxVQUFVLEVBQUUsR0FBRztvQkFDZixPQUFPO29CQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsS0FBSyxFQUFFLHVCQUF1QixFQUFFLENBQUM7aUJBQ3pELENBQUM7WUFDSixDQUFDO1lBRUQsTUFBTSxRQUFRLEdBQUcsS0FBSyxDQUFDLGNBQWMsRUFBRSxLQUFLLENBQUM7WUFDN0MsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO2dCQUNkLE9BQU87b0JBQ0wsVUFBVSxFQUFFLEdBQUc7b0JBQ2YsT0FBTztvQkFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSxvQkFBb0IsRUFBRSxDQUFDO2lCQUN0RCxDQUFDO1lBQ0osQ0FBQztZQUVELElBQUksTUFBcUIsQ0FBQztZQUMxQixJQUFJLENBQUM7Z0JBQ0gsTUFBTSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLElBQUksSUFBSSxJQUFJLENBQUMsQ0FBQztZQUMxQyxDQUFDO1lBQUMsTUFBTSxDQUFDO2dCQUNQLE9BQU87b0JBQ0wsVUFBVSxFQUFFLEdBQUc7b0JBQ2YsT0FBTztvQkFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSxtQkFBbUIsRUFBRSxDQUFDO2lCQUNyRCxDQUFDO1lBQ0osQ0FBQztZQUVELGtCQUFrQjtZQUNsQixNQUFNLFVBQVUsR0FBRyxxQkFBcUIsQ0FBQyxNQUFpQyxDQUFDLENBQUM7WUFDNUUsSUFBSSxDQUFDLFVBQVUsQ0FBQyxLQUFLLEVBQUUsQ0FBQztnQkFDdEIsT0FBTztvQkFDTCxVQUFVLEVBQUUsR0FBRztvQkFDZixPQUFPO29CQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsS0FBSyxFQUFFLG1CQUFtQixFQUFFLE9BQU8sRUFBRSxVQUFVLENBQUMsTUFBTSxFQUFFLENBQUM7aUJBQ2pGLENBQUM7WUFDSixDQUFDO1lBRUQsZ0NBQWdDO1lBQ2hDLE1BQU0sTUFBTSxHQUFHLEtBQUssQ0FBQyxjQUFjLEVBQUUsVUFBVSxFQUFFLEdBQUcsRUFBRSxNQUFNLENBQUM7WUFDN0QsTUFBTSxTQUFTLEdBQUcsTUFBTSxFQUFFLEtBQUssSUFBSSxNQUFNLEVBQUUsR0FBRyxJQUFJLFNBQVMsQ0FBQztZQUU1RCxnREFBZ0Q7WUFDaEQsTUFBTSxTQUFTLENBQUMsSUFBSSxDQUFDLElBQUkseUJBQVUsQ0FBQztnQkFDbEMsU0FBUyxFQUFFLGNBQWM7Z0JBQ3pCLElBQUksRUFBRTtvQkFDSixZQUFZLEVBQUUsZ0JBQWdCO29CQUM5QixVQUFVLEVBQUUsUUFBUTtvQkFDcEIsTUFBTTtvQkFDTixVQUFVLEVBQUUsSUFBSSxDQUFDLEdBQUcsRUFBRTtvQkFDdEIsVUFBVSxFQUFFLFNBQVM7aUJBQ3RCO2FBQ0YsQ0FBQyxDQUFDLENBQUM7WUFFSixpRkFBaUY7WUFDakYsTUFBTSxhQUFhLEdBQUcsTUFBTSxhQUFhLENBQUMsUUFBUSxFQUFFLE1BQU0sQ0FBQyxDQUFDO1lBRTVELE9BQU87Z0JBQ0wsVUFBVSxFQUFFLEdBQUc7Z0JBQ2YsT0FBTztnQkFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQztvQkFDbkIsU0FBUyxFQUFFLFFBQVE7b0JBQ25CLE1BQU07b0JBQ04sVUFBVSxFQUFFLElBQUksQ0FBQyxHQUFHLEVBQUU7b0JBQ3RCLFVBQVUsRUFBRSxTQUFTO29CQUNyQixZQUFZLEVBQUUsYUFBYSxDQUFDLE9BQU87b0JBQ25DLGFBQWEsRUFBRSxhQUFhLENBQUMsS0FBSztpQkFDbkMsQ0FBQzthQUNILENBQUM7UUFDSixDQUFDO1FBRUQsT0FBTztZQUNMLFVBQVUsRUFBRSxHQUFHO1lBQ2YsT0FBTztZQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsS0FBSyxFQUFFLFdBQVcsRUFBRSxDQUFDO1NBQzdDLENBQUM7SUFDSixDQUFDO0lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztRQUNmLE9BQU8sQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQy9CLE9BQU87WUFDTCxVQUFVLEVBQUUsR0FBRztZQUNmLE9BQU87WUFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSx1QkFBdUIsRUFBRSxDQUFDO1NBQ3pELENBQUM7SUFDSixDQUFDO0FBQ0gsQ0FBQztBQS9LRCwwQkErS0MiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEFQSSBTZXR0aW5ncyBMYW1iZGFcbiAqXG4gKiBIYW5kbGVzIGZsZWV0IGRlZmF1bHRzIHNldHRpbmdzIENSVUQgb3BlcmF0aW9ucy5cbiAqIEFkbWluLW9ubHkgZW5kcG9pbnRzIGFyZSBwcm90ZWN0ZWQgYnkgY2hlY2tpbmcgSldUIGNvZ25pdG86Z3JvdXBzIGNsYWltLlxuICpcbiAqIEZsZWV0IGRlZmF1bHRzIGFyZSBzYXZlZCB0bzpcbiAqIDEuIER5bmFtb0RCIChmb3IgZGFzaGJvYXJkIFVJKVxuICogMi4gTm90ZWh1YiBmbGVldCBlbnZpcm9ubWVudCB2YXJpYWJsZXMgKHNvIGRldmljZXMgcmVjZWl2ZSB0aGUgY29uZmlnKVxuICovXG5cbmltcG9ydCB7IER5bmFtb0RCQ2xpZW50IH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LWR5bmFtb2RiJztcbmltcG9ydCB7IER5bmFtb0RCRG9jdW1lbnRDbGllbnQsIEdldENvbW1hbmQsIFB1dENvbW1hbmQsIFF1ZXJ5Q29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2xpYi1keW5hbW9kYic7XG5pbXBvcnQgeyBTZWNyZXRzTWFuYWdlckNsaWVudCwgR2V0U2VjcmV0VmFsdWVDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LXNlY3JldHMtbWFuYWdlcic7XG5pbXBvcnQgdHlwZSB7IEFQSUdhdGV3YXlQcm94eUV2ZW50VjJXaXRoSldUQXV0aG9yaXplciwgQVBJR2F0ZXdheVByb3h5UmVzdWx0VjIgfSBmcm9tICdhd3MtbGFtYmRhJztcblxuY29uc3QgY2xpZW50ID0gbmV3IER5bmFtb0RCQ2xpZW50KHt9KTtcbmNvbnN0IGRvY0NsaWVudCA9IER5bmFtb0RCRG9jdW1lbnRDbGllbnQuZnJvbShjbGllbnQpO1xuY29uc3Qgc2VjcmV0c0NsaWVudCA9IG5ldyBTZWNyZXRzTWFuYWdlckNsaWVudCh7fSk7XG5cbmNvbnN0IFNFVFRJTkdTX1RBQkxFID0gcHJvY2Vzcy5lbnYuU0VUVElOR1NfVEFCTEUgfHwgJ3NvbmdiaXJkLXNldHRpbmdzJztcbmNvbnN0IE5PVEVIVUJfUFJPSkVDVF9VSUQgPSBwcm9jZXNzLmVudi5OT1RFSFVCX1BST0pFQ1RfVUlEO1xuY29uc3QgTk9URUhVQl9TRUNSRVRfQVJOID0gcHJvY2Vzcy5lbnYuTk9URUhVQl9TRUNSRVRfQVJOO1xuXG4vLyBDYWNoZSB0aGUgTm90ZWh1YiB0b2tlblxubGV0IGNhY2hlZE5vdGVodWJUb2tlbjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbmFzeW5jIGZ1bmN0aW9uIGdldE5vdGVodWJUb2tlbigpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgaWYgKCFOT1RFSFVCX1NFQ1JFVF9BUk4pIHtcbiAgICBjb25zb2xlLndhcm4oJ05PVEVIVUJfU0VDUkVUX0FSTiBub3QgY29uZmlndXJlZCcpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgaWYgKGNhY2hlZE5vdGVodWJUb2tlbikge1xuICAgIHJldHVybiBjYWNoZWROb3RlaHViVG9rZW47XG4gIH1cblxuICB0cnkge1xuICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgR2V0U2VjcmV0VmFsdWVDb21tYW5kKHsgU2VjcmV0SWQ6IE5PVEVIVUJfU0VDUkVUX0FSTiB9KTtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHNlY3JldHNDbGllbnQuc2VuZChjb21tYW5kKTtcblxuICAgIGlmICghcmVzcG9uc2UuU2VjcmV0U3RyaW5nKSB7XG4gICAgICBjb25zb2xlLmVycm9yKCdOb3RlaHViIEFQSSB0b2tlbiBub3QgZm91bmQgaW4gc2VjcmV0Jyk7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICBjb25zdCBzZWNyZXQgPSBKU09OLnBhcnNlKHJlc3BvbnNlLlNlY3JldFN0cmluZyk7XG4gICAgY2FjaGVkTm90ZWh1YlRva2VuID0gc2VjcmV0LnRva2VuO1xuICAgIHJldHVybiBjYWNoZWROb3RlaHViVG9rZW47XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3IgZmV0Y2hpbmcgTm90ZWh1YiB0b2tlbjonLCBlcnJvcik7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuY29uc3QgaGVhZGVycyA9IHtcbiAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbic6ICcqJyxcbiAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnMnOiAnQ29udGVudC1UeXBlLEF1dGhvcml6YXRpb24nLFxuICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kcyc6ICdHRVQsUFVULE9QVElPTlMnLFxufTtcblxuaW50ZXJmYWNlIEZsZWV0RGVmYXVsdHMge1xuICBtb2RlPzogc3RyaW5nO1xuICBncHNfaW50ZXJ2YWxfbWluPzogbnVtYmVyO1xuICBzeW5jX2ludGVydmFsX21pbj86IG51bWJlcjtcbiAgaGVhcnRiZWF0X2hvdXJzPzogbnVtYmVyO1xuICB0ZW1wX2FsZXJ0X2hpZ2hfYz86IG51bWJlcjtcbiAgdGVtcF9hbGVydF9sb3dfYz86IG51bWJlcjtcbiAgaHVtaWRpdHlfYWxlcnRfaGlnaD86IG51bWJlcjtcbiAgaHVtaWRpdHlfYWxlcnRfbG93PzogbnVtYmVyO1xuICB2b2x0YWdlX2FsZXJ0X2xvdz86IG51bWJlcjtcbiAgbW90aW9uX3NlbnNpdGl2aXR5Pzogc3RyaW5nO1xuICBhdWRpb19lbmFibGVkPzogYm9vbGVhbjtcbiAgbGVkX2VuYWJsZWQ/OiBib29sZWFuO1xuICAvLyBHUFMgUG93ZXIgTWFuYWdlbWVudCAoYWN0aXZlbHkgbWFuYWdlcyBHUFMgYmFzZWQgb24gc2lnbmFsKVxuICBncHNfcG93ZXJfc2F2ZV9lbmFibGVkPzogYm9vbGVhbjtcbiAgZ3BzX3NpZ25hbF90aW1lb3V0X21pbj86IG51bWJlcjtcbiAgZ3BzX3JldHJ5X2ludGVydmFsX21pbj86IG51bWJlcjtcbn1cblxuLy8gVmFsaWRhdGlvbiBzY2hlbWEgZm9yIGZsZWV0IGRlZmF1bHRzXG5jb25zdCBmbGVldERlZmF1bHRzU2NoZW1hOiBSZWNvcmQ8c3RyaW5nLCB7IHR5cGU6IHN0cmluZzsgbWluPzogbnVtYmVyOyBtYXg/OiBudW1iZXI7IHZhbHVlcz86IHN0cmluZ1tdIH0+ID0ge1xuICBtb2RlOiB7IHR5cGU6ICdzdHJpbmcnLCB2YWx1ZXM6IFsnZGVtbycsICd0cmFuc2l0JywgJ3N0b3JhZ2UnLCAnc2xlZXAnXSB9LFxuICBncHNfaW50ZXJ2YWxfbWluOiB7IHR5cGU6ICdudW1iZXInLCBtaW46IDEsIG1heDogMTQ0MCB9LFxuICBzeW5jX2ludGVydmFsX21pbjogeyB0eXBlOiAnbnVtYmVyJywgbWluOiAxLCBtYXg6IDE0NDAgfSxcbiAgaGVhcnRiZWF0X2hvdXJzOiB7IHR5cGU6ICdudW1iZXInLCBtaW46IDEsIG1heDogMTY4IH0sXG4gIHRlbXBfYWxlcnRfaGlnaF9jOiB7IHR5cGU6ICdudW1iZXInLCBtaW46IC00MCwgbWF4OiA4NSB9LFxuICB0ZW1wX2FsZXJ0X2xvd19jOiB7IHR5cGU6ICdudW1iZXInLCBtaW46IC00MCwgbWF4OiA4NSB9LFxuICBodW1pZGl0eV9hbGVydF9oaWdoOiB7IHR5cGU6ICdudW1iZXInLCBtaW46IDAsIG1heDogMTAwIH0sXG4gIGh1bWlkaXR5X2FsZXJ0X2xvdzogeyB0eXBlOiAnbnVtYmVyJywgbWluOiAwLCBtYXg6IDEwMCB9LFxuICB2b2x0YWdlX2FsZXJ0X2xvdzogeyB0eXBlOiAnbnVtYmVyJywgbWluOiAzLjAsIG1heDogNC4yIH0sXG4gIG1vdGlvbl9zZW5zaXRpdml0eTogeyB0eXBlOiAnc3RyaW5nJywgdmFsdWVzOiBbJ2xvdycsICdtZWRpdW0nLCAnaGlnaCddIH0sXG4gIGF1ZGlvX2VuYWJsZWQ6IHsgdHlwZTogJ2Jvb2xlYW4nIH0sXG4gIGxlZF9lbmFibGVkOiB7IHR5cGU6ICdib29sZWFuJyB9LFxuICAvLyBHUFMgUG93ZXIgTWFuYWdlbWVudCAoYWN0aXZlbHkgbWFuYWdlcyBHUFMgYmFzZWQgb24gc2lnbmFsKVxuICBncHNfcG93ZXJfc2F2ZV9lbmFibGVkOiB7IHR5cGU6ICdib29sZWFuJyB9LFxuICBncHNfc2lnbmFsX3RpbWVvdXRfbWluOiB7IHR5cGU6ICdudW1iZXInLCBtaW46IDEwLCBtYXg6IDMwIH0sXG4gIGdwc19yZXRyeV9pbnRlcnZhbF9taW46IHsgdHlwZTogJ251bWJlcicsIG1pbjogNSwgbWF4OiAxMjAgfSxcbn07XG5cbmZ1bmN0aW9uIGlzQWRtaW4oZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50VjJXaXRoSldUQXV0aG9yaXplcik6IGJvb2xlYW4ge1xuICB0cnkge1xuICAgIGNvbnN0IGNsYWltcyA9IGV2ZW50LnJlcXVlc3RDb250ZXh0Py5hdXRob3JpemVyPy5qd3Q/LmNsYWltcztcbiAgICBpZiAoIWNsYWltcykgcmV0dXJuIGZhbHNlO1xuXG4gICAgLy8gY29nbml0bzpncm91cHMgaXMgZWl0aGVyIGEgc3RyaW5nIG9yIGFycmF5IGRlcGVuZGluZyBvbiBudW1iZXIgb2YgZ3JvdXBzXG4gICAgY29uc3QgZ3JvdXBzID0gY2xhaW1zWydjb2duaXRvOmdyb3VwcyddO1xuICAgIGlmIChBcnJheS5pc0FycmF5KGdyb3VwcykpIHtcbiAgICAgIHJldHVybiBncm91cHMuaW5jbHVkZXMoJ0FkbWluJyk7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgZ3JvdXBzID09PSAnc3RyaW5nJykge1xuICAgICAgcmV0dXJuIGdyb3VwcyA9PT0gJ0FkbWluJyB8fCBncm91cHMuaW5jbHVkZXMoJ0FkbWluJyk7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKlxuICogUHVzaCBmbGVldCBkZWZhdWx0cyB0byBOb3RlaHViIGFzIGZsZWV0IGVudmlyb25tZW50IHZhcmlhYmxlc1xuICogVGhpcyBtYWtlcyB0aGUgY29uZmlnIGF2YWlsYWJsZSB0byBhbGwgZGV2aWNlcyBpbiB0aGUgZmxlZXRcbiAqL1xuYXN5bmMgZnVuY3Rpb24gcHVzaFRvTm90ZWh1YihmbGVldFVpZDogc3RyaW5nLCBjb25maWc6IEZsZWV0RGVmYXVsdHMpOiBQcm9taXNlPHsgc3VjY2VzczogYm9vbGVhbjsgZXJyb3I/OiBzdHJpbmcgfT4ge1xuICBpZiAoIU5PVEVIVUJfUFJPSkVDVF9VSUQpIHtcbiAgICBjb25zb2xlLndhcm4oJ05PVEVIVUJfUFJPSkVDVF9VSUQgbm90IGNvbmZpZ3VyZWQsIHNraXBwaW5nIE5vdGVodWIgcHVzaCcpO1xuICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogJ05vdGVodWIgbm90IGNvbmZpZ3VyZWQnIH07XG4gIH1cblxuICBjb25zdCB0b2tlbiA9IGF3YWl0IGdldE5vdGVodWJUb2tlbigpO1xuICBpZiAoIXRva2VuKSB7XG4gICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiAnQ291bGQgbm90IGdldCBOb3RlaHViIHRva2VuJyB9O1xuICB9XG5cbiAgLy8gQ29udmVydCBjb25maWcgdmFsdWVzIHRvIHN0cmluZ3MgZm9yIE5vdGVodWIgZW52aXJvbm1lbnQgdmFyaWFibGVzXG4gIGNvbnN0IGVudlZhcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoY29uZmlnKSkge1xuICAgIGlmICh2YWx1ZSAhPT0gdW5kZWZpbmVkICYmIHZhbHVlICE9PSBudWxsKSB7XG4gICAgICBlbnZWYXJzW2tleV0gPSBTdHJpbmcodmFsdWUpO1xuICAgIH1cbiAgfVxuXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcbiAgICAgIGBodHRwczovL2FwaS5ub3RlZmlsZS5uZXQvdjEvcHJvamVjdHMvJHtOT1RFSFVCX1BST0pFQ1RfVUlEfS9mbGVldHMvJHtmbGVldFVpZH0vZW52aXJvbm1lbnRfdmFyaWFibGVzYCxcbiAgICAgIHtcbiAgICAgICAgbWV0aG9kOiAnUFVUJyxcbiAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke3Rva2VufWAsXG4gICAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgfSxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlbnZpcm9ubWVudF92YXJpYWJsZXM6IGVudlZhcnMgfSksXG4gICAgICB9XG4gICAgKTtcblxuICAgIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICAgIGNvbnN0IGVycm9yVGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ05vdGVodWIgQVBJIGVycm9yOicsIHJlc3BvbnNlLnN0YXR1cywgZXJyb3JUZXh0KTtcbiAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogYE5vdGVodWIgQVBJIGVycm9yOiAke3Jlc3BvbnNlLnN0YXR1c31gIH07XG4gICAgfVxuXG4gICAgY29uc29sZS5sb2coYFN1Y2Nlc3NmdWxseSBwdXNoZWQgZmxlZXQgZGVmYXVsdHMgdG8gTm90ZWh1YiBmb3IgZmxlZXQgJHtmbGVldFVpZH1gKTtcbiAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3IgcHVzaGluZyB0byBOb3RlaHViOicsIGVycm9yKTtcbiAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IFN0cmluZyhlcnJvcikgfTtcbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUZsZWV0RGVmYXVsdHMoY29uZmlnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHsgdmFsaWQ6IGJvb2xlYW47IGVycm9yczogc3RyaW5nW10gfSB7XG4gIGNvbnN0IGVycm9yczogc3RyaW5nW10gPSBbXTtcblxuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhjb25maWcpKSB7XG4gICAgY29uc3Qgc2NoZW1hID0gZmxlZXREZWZhdWx0c1NjaGVtYVtrZXldO1xuICAgIGlmICghc2NoZW1hKSB7XG4gICAgICBlcnJvcnMucHVzaChgVW5rbm93biBzZXR0aW5nOiAke2tleX1gKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGlmIChzY2hlbWEudHlwZSA9PT0gJ251bWJlcicpIHtcbiAgICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdudW1iZXInKSB7XG4gICAgICAgIGVycm9ycy5wdXNoKGAke2tleX0gbXVzdCBiZSBhIG51bWJlcmApO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChzY2hlbWEubWluICE9PSB1bmRlZmluZWQgJiYgdmFsdWUgPCBzY2hlbWEubWluKSB7XG4gICAgICAgIGVycm9ycy5wdXNoKGAke2tleX0gbXVzdCBiZSBhdCBsZWFzdCAke3NjaGVtYS5taW59YCk7XG4gICAgICB9XG4gICAgICBpZiAoc2NoZW1hLm1heCAhPT0gdW5kZWZpbmVkICYmIHZhbHVlID4gc2NoZW1hLm1heCkge1xuICAgICAgICBlcnJvcnMucHVzaChgJHtrZXl9IG11c3QgYmUgYXQgbW9zdCAke3NjaGVtYS5tYXh9YCk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChzY2hlbWEudHlwZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgIGVycm9ycy5wdXNoKGAke2tleX0gbXVzdCBiZSBhIHN0cmluZ2ApO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChzY2hlbWEudmFsdWVzICYmICFzY2hlbWEudmFsdWVzLmluY2x1ZGVzKHZhbHVlKSkge1xuICAgICAgICBlcnJvcnMucHVzaChgJHtrZXl9IG11c3QgYmUgb25lIG9mOiAke3NjaGVtYS52YWx1ZXMuam9pbignLCAnKX1gKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHNjaGVtYS50eXBlID09PSAnYm9vbGVhbicpIHtcbiAgICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdib29sZWFuJykge1xuICAgICAgICBlcnJvcnMucHVzaChgJHtrZXl9IG11c3QgYmUgYSBib29sZWFuYCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgdmFsaWQ6IGVycm9ycy5sZW5ndGggPT09IDAsIGVycm9ycyB9O1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlcihldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnRWMldpdGhKV1RBdXRob3JpemVyKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHRWMj4ge1xuICBjb25zb2xlLmxvZygnRXZlbnQ6JywgSlNPTi5zdHJpbmdpZnkoZXZlbnQsIG51bGwsIDIpKTtcblxuICBjb25zdCBtZXRob2QgPSBldmVudC5yZXF1ZXN0Q29udGV4dC5odHRwLm1ldGhvZDtcbiAgY29uc3QgcGF0aCA9IGV2ZW50LnJhd1BhdGg7XG5cbiAgLy8gSGFuZGxlIE9QVElPTlMgZm9yIENPUlNcbiAgaWYgKG1ldGhvZCA9PT0gJ09QVElPTlMnKSB7XG4gICAgcmV0dXJuIHsgc3RhdHVzQ29kZTogMjAwLCBoZWFkZXJzLCBib2R5OiAnJyB9O1xuICB9XG5cbiAgdHJ5IHtcbiAgICAvLyBHRVQgL3YxL3NldHRpbmdzL2ZsZWV0LWRlZmF1bHRzIC0gTGlzdCBhbGwgZmxlZXQgZGVmYXVsdHMgKGFkbWluIG9ubHkpXG4gICAgaWYgKG1ldGhvZCA9PT0gJ0dFVCcgJiYgcGF0aCA9PT0gJy92MS9zZXR0aW5ncy9mbGVldC1kZWZhdWx0cycpIHtcbiAgICAgIGlmICghaXNBZG1pbihldmVudCkpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiA0MDMsXG4gICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnQWRtaW4gYWNjZXNzIHJlcXVpcmVkJyB9KSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgICAgIFRhYmxlTmFtZTogU0VUVElOR1NfVEFCTEUsXG4gICAgICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdzZXR0aW5nX3R5cGUgPSA6dHlwZScsXG4gICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgICAnOnR5cGUnOiAnZmxlZXRfZGVmYXVsdHMnLFxuICAgICAgICB9LFxuICAgICAgfSkpO1xuXG4gICAgICBjb25zdCBmbGVldERlZmF1bHRzID0gKHJlc3VsdC5JdGVtcyB8fCBbXSkubWFwKChpdGVtOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gKHtcbiAgICAgICAgZmxlZXRfdWlkOiBpdGVtLnNldHRpbmdfaWQsXG4gICAgICAgIC4uLihpdGVtLmNvbmZpZyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8fCB7fSksXG4gICAgICAgIHVwZGF0ZWRfYXQ6IGl0ZW0udXBkYXRlZF9hdCxcbiAgICAgICAgdXBkYXRlZF9ieTogaXRlbS51cGRhdGVkX2J5LFxuICAgICAgfSkpO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZmxlZXRfZGVmYXVsdHM6IGZsZWV0RGVmYXVsdHMgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIEdFVCAvdjEvc2V0dGluZ3MvZmxlZXQtZGVmYXVsdHMve2ZsZWV0fSAtIEdldCBzcGVjaWZpYyBmbGVldCBkZWZhdWx0c1xuICAgIGlmIChtZXRob2QgPT09ICdHRVQnICYmIHBhdGguc3RhcnRzV2l0aCgnL3YxL3NldHRpbmdzL2ZsZWV0LWRlZmF1bHRzLycpKSB7XG4gICAgICBjb25zdCBmbGVldFVpZCA9IGV2ZW50LnBhdGhQYXJhbWV0ZXJzPy5mbGVldDtcbiAgICAgIGlmICghZmxlZXRVaWQpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRmxlZXQgVUlEIHJlcXVpcmVkJyB9KSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IEdldENvbW1hbmQoe1xuICAgICAgICBUYWJsZU5hbWU6IFNFVFRJTkdTX1RBQkxFLFxuICAgICAgICBLZXk6IHtcbiAgICAgICAgICBzZXR0aW5nX3R5cGU6ICdmbGVldF9kZWZhdWx0cycsXG4gICAgICAgICAgc2V0dGluZ19pZDogZmxlZXRVaWQsXG4gICAgICAgIH0sXG4gICAgICB9KSk7XG5cbiAgICAgIGlmICghcmVzdWx0Lkl0ZW0pIHtcbiAgICAgICAgLy8gUmV0dXJuIGVtcHR5IGRlZmF1bHRzIGlmIG5vbmUgc2V0XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgICAgIGhlYWRlcnMsXG4gICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgZmxlZXRfdWlkOiBmbGVldFVpZCxcbiAgICAgICAgICAgIGNvbmZpZzoge30sXG4gICAgICAgICAgICBzY2hlbWE6IGZsZWV0RGVmYXVsdHNTY2hlbWEsXG4gICAgICAgICAgfSksXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIGZsZWV0X3VpZDogZmxlZXRVaWQsXG4gICAgICAgICAgY29uZmlnOiByZXN1bHQuSXRlbS5jb25maWcgfHwge30sXG4gICAgICAgICAgc2NoZW1hOiBmbGVldERlZmF1bHRzU2NoZW1hLFxuICAgICAgICAgIHVwZGF0ZWRfYXQ6IHJlc3VsdC5JdGVtLnVwZGF0ZWRfYXQsXG4gICAgICAgICAgdXBkYXRlZF9ieTogcmVzdWx0Lkl0ZW0udXBkYXRlZF9ieSxcbiAgICAgICAgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIFBVVCAvdjEvc2V0dGluZ3MvZmxlZXQtZGVmYXVsdHMve2ZsZWV0fSAtIFVwZGF0ZSBmbGVldCBkZWZhdWx0cyAoYWRtaW4gb25seSlcbiAgICBpZiAobWV0aG9kID09PSAnUFVUJyAmJiBwYXRoLnN0YXJ0c1dpdGgoJy92MS9zZXR0aW5ncy9mbGVldC1kZWZhdWx0cy8nKSkge1xuICAgICAgaWYgKCFpc0FkbWluKGV2ZW50KSkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN0YXR1c0NvZGU6IDQwMyxcbiAgICAgICAgICBoZWFkZXJzLFxuICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdBZG1pbiBhY2Nlc3MgcmVxdWlyZWQnIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICBjb25zdCBmbGVldFVpZCA9IGV2ZW50LnBhdGhQYXJhbWV0ZXJzPy5mbGVldDtcbiAgICAgIGlmICghZmxlZXRVaWQpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRmxlZXQgVUlEIHJlcXVpcmVkJyB9KSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgbGV0IGNvbmZpZzogRmxlZXREZWZhdWx0cztcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbmZpZyA9IEpTT04ucGFyc2UoZXZlbnQuYm9keSB8fCAne30nKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgICBoZWFkZXJzLFxuICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnZhbGlkIEpTT04gYm9keScgfSksXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIC8vIFZhbGlkYXRlIGNvbmZpZ1xuICAgICAgY29uc3QgdmFsaWRhdGlvbiA9IHZhbGlkYXRlRmxlZXREZWZhdWx0cyhjb25maWcgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pO1xuICAgICAgaWYgKCF2YWxpZGF0aW9uLnZhbGlkKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICAgIGhlYWRlcnMsXG4gICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1ZhbGlkYXRpb24gZmFpbGVkJywgZGV0YWlsczogdmFsaWRhdGlvbi5lcnJvcnMgfSksXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIC8vIEdldCB1c2VyIGluZm8gZnJvbSBKV1QgY2xhaW1zXG4gICAgICBjb25zdCBjbGFpbXMgPSBldmVudC5yZXF1ZXN0Q29udGV4dD8uYXV0aG9yaXplcj8uand0Py5jbGFpbXM7XG4gICAgICBjb25zdCB1c2VyRW1haWwgPSBjbGFpbXM/LmVtYWlsIHx8IGNsYWltcz8uc3ViIHx8ICd1bmtub3duJztcblxuICAgICAgLy8gU3RvcmUgc2V0dGluZ3MgaW4gRHluYW1vREIgKGZvciBkYXNoYm9hcmQgVUkpXG4gICAgICBhd2FpdCBkb2NDbGllbnQuc2VuZChuZXcgUHV0Q29tbWFuZCh7XG4gICAgICAgIFRhYmxlTmFtZTogU0VUVElOR1NfVEFCTEUsXG4gICAgICAgIEl0ZW06IHtcbiAgICAgICAgICBzZXR0aW5nX3R5cGU6ICdmbGVldF9kZWZhdWx0cycsXG4gICAgICAgICAgc2V0dGluZ19pZDogZmxlZXRVaWQsXG4gICAgICAgICAgY29uZmlnLFxuICAgICAgICAgIHVwZGF0ZWRfYXQ6IERhdGUubm93KCksXG4gICAgICAgICAgdXBkYXRlZF9ieTogdXNlckVtYWlsLFxuICAgICAgICB9LFxuICAgICAgfSkpO1xuXG4gICAgICAvLyBQdXNoIHRvIE5vdGVodWIgYXMgZmxlZXQgZW52aXJvbm1lbnQgdmFyaWFibGVzIChzbyBkZXZpY2VzIHJlY2VpdmUgdGhlIGNvbmZpZylcbiAgICAgIGNvbnN0IG5vdGVodWJSZXN1bHQgPSBhd2FpdCBwdXNoVG9Ob3RlaHViKGZsZWV0VWlkLCBjb25maWcpO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICBmbGVldF91aWQ6IGZsZWV0VWlkLFxuICAgICAgICAgIGNvbmZpZyxcbiAgICAgICAgICB1cGRhdGVkX2F0OiBEYXRlLm5vdygpLFxuICAgICAgICAgIHVwZGF0ZWRfYnk6IHVzZXJFbWFpbCxcbiAgICAgICAgICBub3RlaHViX3N5bmM6IG5vdGVodWJSZXN1bHQuc3VjY2VzcyxcbiAgICAgICAgICBub3RlaHViX2Vycm9yOiBub3RlaHViUmVzdWx0LmVycm9yLFxuICAgICAgICB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwNCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnTm90IGZvdW5kJyB9KSxcbiAgICB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yOicsIGVycm9yKTtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNTAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnRlcm5hbCBzZXJ2ZXIgZXJyb3InIH0pLFxuICAgIH07XG4gIH1cbn1cbiJdfQ==