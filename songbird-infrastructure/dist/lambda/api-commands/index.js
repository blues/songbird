"use strict";
/**
 * Commands API Lambda
 *
 * Sends commands to devices via Notehub API:
 * - GET /v1/commands - Get all commands across devices
 * - DELETE /v1/commands/{command_id} - Delete a command
 * - POST /devices/{serial_number}/commands - Send command to device (routes to current Notecard)
 * - GET /devices/{serial_number}/commands - Get command history for a device (merged from all Notecards)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const client_secrets_manager_1 = require("@aws-sdk/client-secrets-manager");
const crypto_1 = require("crypto");
const device_lookup_1 = require("../shared/device-lookup");
const ddbClient = new client_dynamodb_1.DynamoDBClient({});
const docClient = lib_dynamodb_1.DynamoDBDocumentClient.from(ddbClient);
const secretsClient = new client_secrets_manager_1.SecretsManagerClient({});
const COMMANDS_TABLE = process.env.COMMANDS_TABLE;
const NOTEHUB_PROJECT_UID = process.env.NOTEHUB_PROJECT_UID;
const NOTEHUB_SECRET_ARN = process.env.NOTEHUB_SECRET_ARN;
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
// Supported commands
const VALID_COMMANDS = ['ping', 'locate', 'play_melody', 'test_audio', 'set_volume', 'unlock'];
// Commands that require admin or device owner permissions
const RESTRICTED_COMMANDS = ['unlock'];
const DEVICES_TABLE = process.env.DEVICES_TABLE;
/**
 * Check if the user is an admin (in 'Admin' Cognito group)
 */
function isAdmin(event) {
    try {
        const claims = event.requestContext?.authorizer?.jwt?.claims;
        if (!claims)
            return false;
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
 * Get the user's email from the JWT claims
 */
function getUserEmail(event) {
    try {
        const claims = event.requestContext?.authorizer?.jwt?.claims;
        return claims?.email;
    }
    catch {
        return undefined;
    }
}
/**
 * Check if the user owns the device (is assigned to it)
 */
async function isDeviceOwner(deviceUid, userEmail) {
    const command = new lib_dynamodb_1.GetCommand({
        TableName: DEVICES_TABLE,
        Key: { device_uid: deviceUid },
        ProjectionExpression: 'assigned_to',
    });
    const result = await docClient.send(command);
    return result.Item?.assigned_to === userEmail;
}
const handler = async (event) => {
    console.log('Request:', JSON.stringify(event));
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    };
    try {
        // HTTP API v2 uses requestContext.http.method, REST API v1 uses httpMethod
        const method = event.requestContext?.http?.method || event.httpMethod;
        const path = event.requestContext?.http?.path || event.path;
        if (method === 'OPTIONS') {
            return { statusCode: 200, headers: corsHeaders, body: '' };
        }
        // Handle /v1/commands endpoint (all commands across devices)
        if (path === '/v1/commands' && method === 'GET') {
            const deviceUid = event.queryStringParameters?.device_uid;
            return await getAllCommands(deviceUid, corsHeaders);
        }
        // Handle DELETE /v1/commands/{command_id}
        const commandId = event.pathParameters?.command_id;
        if (commandId && method === 'DELETE') {
            const deviceUid = event.queryStringParameters?.device_uid;
            if (!deviceUid) {
                return {
                    statusCode: 400,
                    headers: corsHeaders,
                    body: JSON.stringify({ error: 'device_uid query parameter required' }),
                };
            }
            return await deleteCommand(deviceUid, commandId, corsHeaders);
        }
        // Handle device-specific commands endpoints
        const serialNumber = event.pathParameters?.serial_number;
        if (!serialNumber) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'serial_number required' }),
            };
        }
        // Resolve serial_number to device info
        const resolved = await (0, device_lookup_1.resolveDevice)(serialNumber);
        if (!resolved) {
            return {
                statusCode: 404,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Device not found' }),
            };
        }
        if (method === 'POST') {
            // Send command to the CURRENT device_uid (the active Notecard)
            return await sendCommand(resolved.device_uid, resolved.serial_number, event, corsHeaders);
        }
        if (method === 'GET') {
            // Get command history from ALL device_uids (merged across Notecard swaps)
            return await getCommandHistory(resolved.serial_number, resolved.all_device_uids, corsHeaders);
        }
        return {
            statusCode: 405,
            headers: corsHeaders,
            body: JSON.stringify({ error: 'Method not allowed' }),
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
async function sendCommand(deviceUid, serialNumber, event, headers) {
    if (!event.body) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Request body required' }),
        };
    }
    const request = JSON.parse(event.body);
    const { cmd, params } = request;
    // Validate command
    if (!cmd || !VALID_COMMANDS.includes(cmd)) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
                error: 'Invalid command',
                valid_commands: VALID_COMMANDS,
            }),
        };
    }
    // Check authorization for restricted commands
    if (RESTRICTED_COMMANDS.includes(cmd)) {
        const admin = isAdmin(event);
        const userEmail = getUserEmail(event);
        const owner = userEmail ? await isDeviceOwner(deviceUid, userEmail) : false;
        if (!admin && !owner) {
            return {
                statusCode: 403,
                headers,
                body: JSON.stringify({
                    error: 'Unauthorized: Only admins and device owners can send this command',
                }),
            };
        }
    }
    // Generate command ID
    const commandId = `cmd_${(0, crypto_1.randomUUID)().replace(/-/g, '').substring(0, 12)}`;
    const now = Date.now();
    // Build command note body
    const noteBody = {
        cmd,
        params: params || {},
        command_id: commandId,
        sent_at: now,
    };
    // Send to Notehub API (using the current device_uid for the active Notecard)
    try {
        const notehubToken = await getNotehubToken();
        const notehubResponse = await fetch(`https://api.notefile.net/v1/projects/${NOTEHUB_PROJECT_UID}/devices/${deviceUid}/notes/command.qi`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${notehubToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ body: noteBody }),
        });
        if (!notehubResponse.ok) {
            const errorText = await notehubResponse.text();
            console.error('Notehub API error:', errorText);
            return {
                statusCode: 502,
                headers,
                body: JSON.stringify({
                    error: 'Failed to send command to Notehub',
                    details: errorText,
                }),
            };
        }
        // Store command in history (include serial_number for reference)
        await storeCommand(deviceUid, serialNumber, commandId, cmd, params, now);
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                command_id: commandId,
                serial_number: serialNumber,
                device_uid: deviceUid,
                cmd,
                params: params || {},
                status: 'queued',
                queued_at: new Date(now).toISOString(),
            }),
        };
    }
    catch (error) {
        console.error('Error sending command to Notehub:', error);
        return {
            statusCode: 502,
            headers,
            body: JSON.stringify({
                error: 'Failed to communicate with Notehub',
            }),
        };
    }
}
async function storeCommand(deviceUid, serialNumber, commandId, cmd, params, timestamp) {
    const command = new lib_dynamodb_1.PutCommand({
        TableName: COMMANDS_TABLE,
        Item: {
            device_uid: deviceUid,
            serial_number: serialNumber,
            command_id: commandId,
            cmd,
            params: params || {},
            status: 'queued',
            created_at: timestamp,
            updated_at: timestamp,
            ttl: Math.floor(timestamp / 1000) + 30 * 24 * 60 * 60, // 30 days TTL
        },
    });
    await docClient.send(command);
}
async function getCommandHistory(serialNumber, deviceUids, headers) {
    // Query all device_uids in parallel to get merged command history
    const queryPromises = deviceUids.map(async (deviceUid) => {
        const command = new lib_dynamodb_1.QueryCommand({
            TableName: COMMANDS_TABLE,
            IndexName: 'device-created-index',
            KeyConditionExpression: 'device_uid = :device_uid',
            ExpressionAttributeValues: {
                ':device_uid': deviceUid,
            },
            ScanIndexForward: false,
            Limit: 50,
        });
        const result = await docClient.send(command);
        return result.Items || [];
    });
    const allResults = await Promise.all(queryPromises);
    // Merge and sort by created_at (most recent first)
    const mergedCommands = allResults
        .flat()
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 50); // Limit to 50 total
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            serial_number: serialNumber,
            commands: mergedCommands,
        }),
    };
}
async function getAllCommands(deviceUid, headers) {
    // If device_uid is provided, use the existing query
    if (deviceUid) {
        const command = new lib_dynamodb_1.QueryCommand({
            TableName: COMMANDS_TABLE,
            IndexName: 'device-created-index',
            KeyConditionExpression: 'device_uid = :device_uid',
            ExpressionAttributeValues: {
                ':device_uid': deviceUid,
            },
            ScanIndexForward: false,
            Limit: 100,
        });
        const result = await docClient.send(command);
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                commands: result.Items || [],
                total: result.Items?.length || 0,
            }),
        };
    }
    // Otherwise, scan for all commands (limited to 100 most recent)
    const command = new lib_dynamodb_1.ScanCommand({
        TableName: COMMANDS_TABLE,
        Limit: 200, // Fetch more to allow sorting
    });
    const result = await docClient.send(command);
    // Sort by created_at descending and take the first 100
    const sortedCommands = (result.Items || [])
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
        .slice(0, 100);
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            commands: sortedCommands,
            total: sortedCommands.length,
        }),
    };
}
async function deleteCommand(deviceUid, commandId, headers) {
    // First verify the command exists
    const getCmd = new lib_dynamodb_1.GetCommand({
        TableName: COMMANDS_TABLE,
        Key: {
            device_uid: deviceUid,
            command_id: commandId,
        },
    });
    const existing = await docClient.send(getCmd);
    if (!existing.Item) {
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Command not found' }),
        };
    }
    // Delete the command
    const deleteCmd = new lib_dynamodb_1.DeleteCommand({
        TableName: COMMANDS_TABLE,
        Key: {
            device_uid: deviceUid,
            command_id: commandId,
        },
    });
    await docClient.send(deleteCmd);
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            message: 'Command deleted',
            command_id: commandId,
        }),
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWNvbW1hbmRzL2luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7R0FRRzs7O0FBRUgsOERBQTBEO0FBQzFELHdEQU8rQjtBQUMvQiw0RUFBOEY7QUFFOUYsbUNBQW9DO0FBQ3BDLDJEQUF3RDtBQUV4RCxNQUFNLFNBQVMsR0FBRyxJQUFJLGdDQUFjLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDekMsTUFBTSxTQUFTLEdBQUcscUNBQXNCLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBQ3pELE1BQU0sYUFBYSxHQUFHLElBQUksNkNBQW9CLENBQUMsRUFBRSxDQUFDLENBQUM7QUFFbkQsTUFBTSxjQUFjLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFlLENBQUM7QUFDbkQsTUFBTSxtQkFBbUIsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLG1CQUFvQixDQUFDO0FBQzdELE1BQU0sa0JBQWtCLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxrQkFBbUIsQ0FBQztBQUUzRCxxREFBcUQ7QUFDckQsSUFBSSxXQUFXLEdBQWtCLElBQUksQ0FBQztBQUV0QyxLQUFLLFVBQVUsZUFBZTtJQUM1QixJQUFJLFdBQVcsRUFBRSxDQUFDO1FBQ2hCLE9BQU8sV0FBVyxDQUFDO0lBQ3JCLENBQUM7SUFFRCxNQUFNLE9BQU8sR0FBRyxJQUFJLDhDQUFxQixDQUFDLEVBQUUsUUFBUSxFQUFFLGtCQUFrQixFQUFFLENBQUMsQ0FBQztJQUM1RSxNQUFNLFFBQVEsR0FBRyxNQUFNLGFBQWEsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7SUFFbkQsSUFBSSxDQUFDLFFBQVEsQ0FBQyxZQUFZLEVBQUUsQ0FBQztRQUMzQixNQUFNLElBQUksS0FBSyxDQUFDLHVDQUF1QyxDQUFDLENBQUM7SUFDM0QsQ0FBQztJQUVELE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQyxDQUFDO0lBQ2pELFdBQVcsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDO0lBRTNCLElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQztRQUNqQixNQUFNLElBQUksS0FBSyxDQUFDLGlDQUFpQyxDQUFDLENBQUM7SUFDckQsQ0FBQztJQUVELE9BQU8sV0FBVyxDQUFDO0FBQ3JCLENBQUM7QUFFRCxxQkFBcUI7QUFDckIsTUFBTSxjQUFjLEdBQUcsQ0FBQyxNQUFNLEVBQUUsUUFBUSxFQUFFLGFBQWEsRUFBRSxZQUFZLEVBQUUsWUFBWSxFQUFFLFFBQVEsQ0FBQyxDQUFDO0FBRS9GLDBEQUEwRDtBQUMxRCxNQUFNLG1CQUFtQixHQUFHLENBQUMsUUFBUSxDQUFDLENBQUM7QUFFdkMsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxhQUFjLENBQUM7QUFFakQ7O0dBRUc7QUFDSCxTQUFTLE9BQU8sQ0FBQyxLQUEyQjtJQUMxQyxJQUFJLENBQUM7UUFDSCxNQUFNLE1BQU0sR0FBSSxLQUFLLENBQUMsY0FBc0IsRUFBRSxVQUFVLEVBQUUsR0FBRyxFQUFFLE1BQU0sQ0FBQztRQUN0RSxJQUFJLENBQUMsTUFBTTtZQUFFLE9BQU8sS0FBSyxDQUFDO1FBRTFCLE1BQU0sTUFBTSxHQUFHLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO1FBQ3hDLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1lBQzFCLE9BQU8sTUFBTSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUNsQyxDQUFDO1FBQ0QsSUFBSSxPQUFPLE1BQU0sS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUMvQixPQUFPLE1BQU0sS0FBSyxPQUFPLElBQUksTUFBTSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUN4RCxDQUFDO1FBQ0QsT0FBTyxLQUFLLENBQUM7SUFDZixDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ1AsT0FBTyxLQUFLLENBQUM7SUFDZixDQUFDO0FBQ0gsQ0FBQztBQUVEOztHQUVHO0FBQ0gsU0FBUyxZQUFZLENBQUMsS0FBMkI7SUFDL0MsSUFBSSxDQUFDO1FBQ0gsTUFBTSxNQUFNLEdBQUksS0FBSyxDQUFDLGNBQXNCLEVBQUUsVUFBVSxFQUFFLEdBQUcsRUFBRSxNQUFNLENBQUM7UUFDdEUsT0FBTyxNQUFNLEVBQUUsS0FBSyxDQUFDO0lBQ3ZCLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDUCxPQUFPLFNBQVMsQ0FBQztJQUNuQixDQUFDO0FBQ0gsQ0FBQztBQUVEOztHQUVHO0FBQ0gsS0FBSyxVQUFVLGFBQWEsQ0FBQyxTQUFpQixFQUFFLFNBQWlCO0lBQy9ELE1BQU0sT0FBTyxHQUFHLElBQUkseUJBQVUsQ0FBQztRQUM3QixTQUFTLEVBQUUsYUFBYTtRQUN4QixHQUFHLEVBQUUsRUFBRSxVQUFVLEVBQUUsU0FBUyxFQUFFO1FBQzlCLG9CQUFvQixFQUFFLGFBQWE7S0FDcEMsQ0FBQyxDQUFDO0lBRUgsTUFBTSxNQUFNLEdBQUcsTUFBTSxTQUFTLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQzdDLE9BQU8sTUFBTSxDQUFDLElBQUksRUFBRSxXQUFXLEtBQUssU0FBUyxDQUFDO0FBQ2hELENBQUM7QUFFTSxNQUFNLE9BQU8sR0FBRyxLQUFLLEVBQUUsS0FBMkIsRUFBa0MsRUFBRTtJQUMzRixPQUFPLENBQUMsR0FBRyxDQUFDLFVBQVUsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFFL0MsTUFBTSxXQUFXLEdBQUc7UUFDbEIsNkJBQTZCLEVBQUUsR0FBRztRQUNsQyw4QkFBOEIsRUFBRSw0QkFBNEI7UUFDNUQsOEJBQThCLEVBQUUseUJBQXlCO0tBQzFELENBQUM7SUFFRixJQUFJLENBQUM7UUFDSCwyRUFBMkU7UUFDM0UsTUFBTSxNQUFNLEdBQUksS0FBSyxDQUFDLGNBQXNCLEVBQUUsSUFBSSxFQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsVUFBVSxDQUFDO1FBQy9FLE1BQU0sSUFBSSxHQUFJLEtBQUssQ0FBQyxjQUFzQixFQUFFLElBQUksRUFBRSxJQUFJLElBQUksS0FBSyxDQUFDLElBQUksQ0FBQztRQUVyRSxJQUFJLE1BQU0sS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUN6QixPQUFPLEVBQUUsVUFBVSxFQUFFLEdBQUcsRUFBRSxPQUFPLEVBQUUsV0FBVyxFQUFFLElBQUksRUFBRSxFQUFFLEVBQUUsQ0FBQztRQUM3RCxDQUFDO1FBRUQsNkRBQTZEO1FBQzdELElBQUksSUFBSSxLQUFLLGNBQWMsSUFBSSxNQUFNLEtBQUssS0FBSyxFQUFFLENBQUM7WUFDaEQsTUFBTSxTQUFTLEdBQUcsS0FBSyxDQUFDLHFCQUFxQixFQUFFLFVBQVUsQ0FBQztZQUMxRCxPQUFPLE1BQU0sY0FBYyxDQUFDLFNBQVMsRUFBRSxXQUFXLENBQUMsQ0FBQztRQUN0RCxDQUFDO1FBRUQsMENBQTBDO1FBQzFDLE1BQU0sU0FBUyxHQUFHLEtBQUssQ0FBQyxjQUFjLEVBQUUsVUFBVSxDQUFDO1FBQ25ELElBQUksU0FBUyxJQUFJLE1BQU0sS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUNyQyxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMscUJBQXFCLEVBQUUsVUFBVSxDQUFDO1lBQzFELElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQztnQkFDZixPQUFPO29CQUNMLFVBQVUsRUFBRSxHQUFHO29CQUNmLE9BQU8sRUFBRSxXQUFXO29CQUNwQixJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSxxQ0FBcUMsRUFBRSxDQUFDO2lCQUN2RSxDQUFDO1lBQ0osQ0FBQztZQUNELE9BQU8sTUFBTSxhQUFhLENBQUMsU0FBUyxFQUFFLFNBQVMsRUFBRSxXQUFXLENBQUMsQ0FBQztRQUNoRSxDQUFDO1FBRUQsNENBQTRDO1FBQzVDLE1BQU0sWUFBWSxHQUFHLEtBQUssQ0FBQyxjQUFjLEVBQUUsYUFBYSxDQUFDO1FBQ3pELElBQUksQ0FBQyxZQUFZLEVBQUUsQ0FBQztZQUNsQixPQUFPO2dCQUNMLFVBQVUsRUFBRSxHQUFHO2dCQUNmLE9BQU8sRUFBRSxXQUFXO2dCQUNwQixJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSx3QkFBd0IsRUFBRSxDQUFDO2FBQzFELENBQUM7UUFDSixDQUFDO1FBRUQsdUNBQXVDO1FBQ3ZDLE1BQU0sUUFBUSxHQUFHLE1BQU0sSUFBQSw2QkFBYSxFQUFDLFlBQVksQ0FBQyxDQUFDO1FBQ25ELElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztZQUNkLE9BQU87Z0JBQ0wsVUFBVSxFQUFFLEdBQUc7Z0JBQ2YsT0FBTyxFQUFFLFdBQVc7Z0JBQ3BCLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsS0FBSyxFQUFFLGtCQUFrQixFQUFFLENBQUM7YUFDcEQsQ0FBQztRQUNKLENBQUM7UUFFRCxJQUFJLE1BQU0sS0FBSyxNQUFNLEVBQUUsQ0FBQztZQUN0QiwrREFBK0Q7WUFDL0QsT0FBTyxNQUFNLFdBQVcsQ0FBQyxRQUFRLENBQUMsVUFBVSxFQUFFLFFBQVEsQ0FBQyxhQUFhLEVBQUUsS0FBSyxFQUFFLFdBQVcsQ0FBQyxDQUFDO1FBQzVGLENBQUM7UUFFRCxJQUFJLE1BQU0sS0FBSyxLQUFLLEVBQUUsQ0FBQztZQUNyQiwwRUFBMEU7WUFDMUUsT0FBTyxNQUFNLGlCQUFpQixDQUFDLFFBQVEsQ0FBQyxhQUFhLEVBQUUsUUFBUSxDQUFDLGVBQWUsRUFBRSxXQUFXLENBQUMsQ0FBQztRQUNoRyxDQUFDO1FBRUQsT0FBTztZQUNMLFVBQVUsRUFBRSxHQUFHO1lBQ2YsT0FBTyxFQUFFLFdBQVc7WUFDcEIsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxLQUFLLEVBQUUsb0JBQW9CLEVBQUUsQ0FBQztTQUN0RCxDQUFDO0lBQ0osQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDZixPQUFPLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUMvQixPQUFPO1lBQ0wsVUFBVSxFQUFFLEdBQUc7WUFDZixPQUFPLEVBQUUsV0FBVztZQUNwQixJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSx1QkFBdUIsRUFBRSxDQUFDO1NBQ3pELENBQUM7SUFDSixDQUFDO0FBQ0gsQ0FBQyxDQUFDO0FBakZXLFFBQUEsT0FBTyxXQWlGbEI7QUFFRixLQUFLLFVBQVUsV0FBVyxDQUN4QixTQUFpQixFQUNqQixZQUFvQixFQUNwQixLQUEyQixFQUMzQixPQUErQjtJQUUvQixJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ2hCLE9BQU87WUFDTCxVQUFVLEVBQUUsR0FBRztZQUNmLE9BQU87WUFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSx1QkFBdUIsRUFBRSxDQUFDO1NBQ3pELENBQUM7SUFDSixDQUFDO0lBRUQsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDdkMsTUFBTSxFQUFFLEdBQUcsRUFBRSxNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUM7SUFFaEMsbUJBQW1CO0lBQ25CLElBQUksQ0FBQyxHQUFHLElBQUksQ0FBQyxjQUFjLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDMUMsT0FBTztZQUNMLFVBQVUsRUFBRSxHQUFHO1lBQ2YsT0FBTztZQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDO2dCQUNuQixLQUFLLEVBQUUsaUJBQWlCO2dCQUN4QixjQUFjLEVBQUUsY0FBYzthQUMvQixDQUFDO1NBQ0gsQ0FBQztJQUNKLENBQUM7SUFFRCw4Q0FBOEM7SUFDOUMsSUFBSSxtQkFBbUIsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUN0QyxNQUFNLEtBQUssR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDN0IsTUFBTSxTQUFTLEdBQUcsWUFBWSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ3RDLE1BQU0sS0FBSyxHQUFHLFNBQVMsQ0FBQyxDQUFDLENBQUMsTUFBTSxhQUFhLENBQUMsU0FBUyxFQUFFLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUM7UUFFNUUsSUFBSSxDQUFDLEtBQUssSUFBSSxDQUFDLEtBQUssRUFBRSxDQUFDO1lBQ3JCLE9BQU87Z0JBQ0wsVUFBVSxFQUFFLEdBQUc7Z0JBQ2YsT0FBTztnQkFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQztvQkFDbkIsS0FBSyxFQUFFLG1FQUFtRTtpQkFDM0UsQ0FBQzthQUNILENBQUM7UUFDSixDQUFDO0lBQ0gsQ0FBQztJQUVELHNCQUFzQjtJQUN0QixNQUFNLFNBQVMsR0FBRyxPQUFPLElBQUEsbUJBQVUsR0FBRSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsRUFBRSxDQUFDO0lBQzNFLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUV2QiwwQkFBMEI7SUFDMUIsTUFBTSxRQUFRLEdBQUc7UUFDZixHQUFHO1FBQ0gsTUFBTSxFQUFFLE1BQU0sSUFBSSxFQUFFO1FBQ3BCLFVBQVUsRUFBRSxTQUFTO1FBQ3JCLE9BQU8sRUFBRSxHQUFHO0tBQ2IsQ0FBQztJQUVGLDZFQUE2RTtJQUM3RSxJQUFJLENBQUM7UUFDSCxNQUFNLFlBQVksR0FBRyxNQUFNLGVBQWUsRUFBRSxDQUFDO1FBQzdDLE1BQU0sZUFBZSxHQUFHLE1BQU0sS0FBSyxDQUNqQyx3Q0FBd0MsbUJBQW1CLFlBQVksU0FBUyxtQkFBbUIsRUFDbkc7WUFDRSxNQUFNLEVBQUUsTUFBTTtZQUNkLE9BQU8sRUFBRTtnQkFDUCxlQUFlLEVBQUUsVUFBVSxZQUFZLEVBQUU7Z0JBQ3pDLGNBQWMsRUFBRSxrQkFBa0I7YUFDbkM7WUFDRCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsQ0FBQztTQUN6QyxDQUNGLENBQUM7UUFFRixJQUFJLENBQUMsZUFBZSxDQUFDLEVBQUUsRUFBRSxDQUFDO1lBQ3hCLE1BQU0sU0FBUyxHQUFHLE1BQU0sZUFBZSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQy9DLE9BQU8sQ0FBQyxLQUFLLENBQUMsb0JBQW9CLEVBQUUsU0FBUyxDQUFDLENBQUM7WUFFL0MsT0FBTztnQkFDTCxVQUFVLEVBQUUsR0FBRztnQkFDZixPQUFPO2dCQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDO29CQUNuQixLQUFLLEVBQUUsbUNBQW1DO29CQUMxQyxPQUFPLEVBQUUsU0FBUztpQkFDbkIsQ0FBQzthQUNILENBQUM7UUFDSixDQUFDO1FBRUQsaUVBQWlFO1FBQ2pFLE1BQU0sWUFBWSxDQUFDLFNBQVMsRUFBRSxZQUFZLEVBQUUsU0FBUyxFQUFFLEdBQUcsRUFBRSxNQUFNLEVBQUUsR0FBRyxDQUFDLENBQUM7UUFFekUsT0FBTztZQUNMLFVBQVUsRUFBRSxHQUFHO1lBQ2YsT0FBTztZQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDO2dCQUNuQixVQUFVLEVBQUUsU0FBUztnQkFDckIsYUFBYSxFQUFFLFlBQVk7Z0JBQzNCLFVBQVUsRUFBRSxTQUFTO2dCQUNyQixHQUFHO2dCQUNILE1BQU0sRUFBRSxNQUFNLElBQUksRUFBRTtnQkFDcEIsTUFBTSxFQUFFLFFBQVE7Z0JBQ2hCLFNBQVMsRUFBRSxJQUFJLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxXQUFXLEVBQUU7YUFDdkMsQ0FBQztTQUNILENBQUM7SUFDSixDQUFDO0lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztRQUNmLE9BQU8sQ0FBQyxLQUFLLENBQUMsbUNBQW1DLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFMUQsT0FBTztZQUNMLFVBQVUsRUFBRSxHQUFHO1lBQ2YsT0FBTztZQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDO2dCQUNuQixLQUFLLEVBQUUsb0NBQW9DO2FBQzVDLENBQUM7U0FDSCxDQUFDO0lBQ0osQ0FBQztBQUNILENBQUM7QUFFRCxLQUFLLFVBQVUsWUFBWSxDQUN6QixTQUFpQixFQUNqQixZQUFvQixFQUNwQixTQUFpQixFQUNqQixHQUFXLEVBQ1gsTUFBVyxFQUNYLFNBQWlCO0lBRWpCLE1BQU0sT0FBTyxHQUFHLElBQUkseUJBQVUsQ0FBQztRQUM3QixTQUFTLEVBQUUsY0FBYztRQUN6QixJQUFJLEVBQUU7WUFDSixVQUFVLEVBQUUsU0FBUztZQUNyQixhQUFhLEVBQUUsWUFBWTtZQUMzQixVQUFVLEVBQUUsU0FBUztZQUNyQixHQUFHO1lBQ0gsTUFBTSxFQUFFLE1BQU0sSUFBSSxFQUFFO1lBQ3BCLE1BQU0sRUFBRSxRQUFRO1lBQ2hCLFVBQVUsRUFBRSxTQUFTO1lBQ3JCLFVBQVUsRUFBRSxTQUFTO1lBQ3JCLEdBQUcsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEVBQUUsY0FBYztTQUN0RTtLQUNGLENBQUMsQ0FBQztJQUVILE1BQU0sU0FBUyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUNoQyxDQUFDO0FBRUQsS0FBSyxVQUFVLGlCQUFpQixDQUM5QixZQUFvQixFQUNwQixVQUFvQixFQUNwQixPQUErQjtJQUUvQixrRUFBa0U7SUFDbEUsTUFBTSxhQUFhLEdBQUcsVUFBVSxDQUFDLEdBQUcsQ0FBQyxLQUFLLEVBQUUsU0FBUyxFQUFFLEVBQUU7UUFDdkQsTUFBTSxPQUFPLEdBQUcsSUFBSSwyQkFBWSxDQUFDO1lBQy9CLFNBQVMsRUFBRSxjQUFjO1lBQ3pCLFNBQVMsRUFBRSxzQkFBc0I7WUFDakMsc0JBQXNCLEVBQUUsMEJBQTBCO1lBQ2xELHlCQUF5QixFQUFFO2dCQUN6QixhQUFhLEVBQUUsU0FBUzthQUN6QjtZQUNELGdCQUFnQixFQUFFLEtBQUs7WUFDdkIsS0FBSyxFQUFFLEVBQUU7U0FDVixDQUFDLENBQUM7UUFFSCxNQUFNLE1BQU0sR0FBRyxNQUFNLFNBQVMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7UUFDN0MsT0FBTyxNQUFNLENBQUMsS0FBSyxJQUFJLEVBQUUsQ0FBQztJQUM1QixDQUFDLENBQUMsQ0FBQztJQUVILE1BQU0sVUFBVSxHQUFHLE1BQU0sT0FBTyxDQUFDLEdBQUcsQ0FBQyxhQUFhLENBQUMsQ0FBQztJQUVwRCxtREFBbUQ7SUFDbkQsTUFBTSxjQUFjLEdBQUcsVUFBVTtTQUM5QixJQUFJLEVBQUU7U0FDTixJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsVUFBVSxHQUFHLENBQUMsQ0FBQyxVQUFVLENBQUM7U0FDM0MsS0FBSyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLG9CQUFvQjtJQUVyQyxPQUFPO1FBQ0wsVUFBVSxFQUFFLEdBQUc7UUFDZixPQUFPO1FBQ1AsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUM7WUFDbkIsYUFBYSxFQUFFLFlBQVk7WUFDM0IsUUFBUSxFQUFFLGNBQWM7U0FDekIsQ0FBQztLQUNILENBQUM7QUFDSixDQUFDO0FBRUQsS0FBSyxVQUFVLGNBQWMsQ0FDM0IsU0FBNkIsRUFDN0IsT0FBK0I7SUFFL0Isb0RBQW9EO0lBQ3BELElBQUksU0FBUyxFQUFFLENBQUM7UUFDZCxNQUFNLE9BQU8sR0FBRyxJQUFJLDJCQUFZLENBQUM7WUFDL0IsU0FBUyxFQUFFLGNBQWM7WUFDekIsU0FBUyxFQUFFLHNCQUFzQjtZQUNqQyxzQkFBc0IsRUFBRSwwQkFBMEI7WUFDbEQseUJBQXlCLEVBQUU7Z0JBQ3pCLGFBQWEsRUFBRSxTQUFTO2FBQ3pCO1lBQ0QsZ0JBQWdCLEVBQUUsS0FBSztZQUN2QixLQUFLLEVBQUUsR0FBRztTQUNYLENBQUMsQ0FBQztRQUVILE1BQU0sTUFBTSxHQUFHLE1BQU0sU0FBUyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUU3QyxPQUFPO1lBQ0wsVUFBVSxFQUFFLEdBQUc7WUFDZixPQUFPO1lBQ1AsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUM7Z0JBQ25CLFFBQVEsRUFBRSxNQUFNLENBQUMsS0FBSyxJQUFJLEVBQUU7Z0JBQzVCLEtBQUssRUFBRSxNQUFNLENBQUMsS0FBSyxFQUFFLE1BQU0sSUFBSSxDQUFDO2FBQ2pDLENBQUM7U0FDSCxDQUFDO0lBQ0osQ0FBQztJQUVELGdFQUFnRTtJQUNoRSxNQUFNLE9BQU8sR0FBRyxJQUFJLDBCQUFXLENBQUM7UUFDOUIsU0FBUyxFQUFFLGNBQWM7UUFDekIsS0FBSyxFQUFFLEdBQUcsRUFBRSw4QkFBOEI7S0FDM0MsQ0FBQyxDQUFDO0lBRUgsTUFBTSxNQUFNLEdBQUcsTUFBTSxTQUFTLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBRTdDLHVEQUF1RDtJQUN2RCxNQUFNLGNBQWMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLLElBQUksRUFBRSxDQUFDO1NBQ3hDLElBQUksQ0FBQyxDQUFDLENBQTBCLEVBQUUsQ0FBMEIsRUFBRSxFQUFFLENBQy9ELENBQUUsQ0FBQyxDQUFDLFVBQXFCLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBRSxDQUFDLENBQUMsVUFBcUIsSUFBSSxDQUFDLENBQUMsQ0FBQztTQUNuRSxLQUFLLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxDQUFDO0lBRWpCLE9BQU87UUFDTCxVQUFVLEVBQUUsR0FBRztRQUNmLE9BQU87UUFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQztZQUNuQixRQUFRLEVBQUUsY0FBYztZQUN4QixLQUFLLEVBQUUsY0FBYyxDQUFDLE1BQU07U0FDN0IsQ0FBQztLQUNILENBQUM7QUFDSixDQUFDO0FBRUQsS0FBSyxVQUFVLGFBQWEsQ0FDMUIsU0FBaUIsRUFDakIsU0FBaUIsRUFDakIsT0FBK0I7SUFFL0Isa0NBQWtDO0lBQ2xDLE1BQU0sTUFBTSxHQUFHLElBQUkseUJBQVUsQ0FBQztRQUM1QixTQUFTLEVBQUUsY0FBYztRQUN6QixHQUFHLEVBQUU7WUFDSCxVQUFVLEVBQUUsU0FBUztZQUNyQixVQUFVLEVBQUUsU0FBUztTQUN0QjtLQUNGLENBQUMsQ0FBQztJQUVILE1BQU0sUUFBUSxHQUFHLE1BQU0sU0FBUyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUM5QyxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ25CLE9BQU87WUFDTCxVQUFVLEVBQUUsR0FBRztZQUNmLE9BQU87WUFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSxtQkFBbUIsRUFBRSxDQUFDO1NBQ3JELENBQUM7SUFDSixDQUFDO0lBRUQscUJBQXFCO0lBQ3JCLE1BQU0sU0FBUyxHQUFHLElBQUksNEJBQWEsQ0FBQztRQUNsQyxTQUFTLEVBQUUsY0FBYztRQUN6QixHQUFHLEVBQUU7WUFDSCxVQUFVLEVBQUUsU0FBUztZQUNyQixVQUFVLEVBQUUsU0FBUztTQUN0QjtLQUNGLENBQUMsQ0FBQztJQUVILE1BQU0sU0FBUyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUVoQyxPQUFPO1FBQ0wsVUFBVSxFQUFFLEdBQUc7UUFDZixPQUFPO1FBQ1AsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUM7WUFDbkIsT0FBTyxFQUFFLGlCQUFpQjtZQUMxQixVQUFVLEVBQUUsU0FBUztTQUN0QixDQUFDO0tBQ0gsQ0FBQztBQUNKLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIENvbW1hbmRzIEFQSSBMYW1iZGFcbiAqXG4gKiBTZW5kcyBjb21tYW5kcyB0byBkZXZpY2VzIHZpYSBOb3RlaHViIEFQSTpcbiAqIC0gR0VUIC92MS9jb21tYW5kcyAtIEdldCBhbGwgY29tbWFuZHMgYWNyb3NzIGRldmljZXNcbiAqIC0gREVMRVRFIC92MS9jb21tYW5kcy97Y29tbWFuZF9pZH0gLSBEZWxldGUgYSBjb21tYW5kXG4gKiAtIFBPU1QgL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2NvbW1hbmRzIC0gU2VuZCBjb21tYW5kIHRvIGRldmljZSAocm91dGVzIHRvIGN1cnJlbnQgTm90ZWNhcmQpXG4gKiAtIEdFVCAvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vY29tbWFuZHMgLSBHZXQgY29tbWFuZCBoaXN0b3J5IGZvciBhIGRldmljZSAobWVyZ2VkIGZyb20gYWxsIE5vdGVjYXJkcylcbiAqL1xuXG5pbXBvcnQgeyBEeW5hbW9EQkNsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYic7XG5pbXBvcnQge1xuICBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LFxuICBQdXRDb21tYW5kLFxuICBRdWVyeUNvbW1hbmQsXG4gIFNjYW5Db21tYW5kLFxuICBEZWxldGVDb21tYW5kLFxuICBHZXRDb21tYW5kLFxufSBmcm9tICdAYXdzLXNkay9saWItZHluYW1vZGInO1xuaW1wb3J0IHsgU2VjcmV0c01hbmFnZXJDbGllbnQsIEdldFNlY3JldFZhbHVlQ29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1zZWNyZXRzLW1hbmFnZXInO1xuaW1wb3J0IHsgQVBJR2F0ZXdheVByb3h5RXZlbnQsIEFQSUdhdGV3YXlQcm94eVJlc3VsdCB9IGZyb20gJ2F3cy1sYW1iZGEnO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ2NyeXB0byc7XG5pbXBvcnQgeyByZXNvbHZlRGV2aWNlIH0gZnJvbSAnLi4vc2hhcmVkL2RldmljZS1sb29rdXAnO1xuXG5jb25zdCBkZGJDbGllbnQgPSBuZXcgRHluYW1vREJDbGllbnQoe30pO1xuY29uc3QgZG9jQ2xpZW50ID0gRHluYW1vREJEb2N1bWVudENsaWVudC5mcm9tKGRkYkNsaWVudCk7XG5jb25zdCBzZWNyZXRzQ2xpZW50ID0gbmV3IFNlY3JldHNNYW5hZ2VyQ2xpZW50KHt9KTtcblxuY29uc3QgQ09NTUFORFNfVEFCTEUgPSBwcm9jZXNzLmVudi5DT01NQU5EU19UQUJMRSE7XG5jb25zdCBOT1RFSFVCX1BST0pFQ1RfVUlEID0gcHJvY2Vzcy5lbnYuTk9URUhVQl9QUk9KRUNUX1VJRCE7XG5jb25zdCBOT1RFSFVCX1NFQ1JFVF9BUk4gPSBwcm9jZXNzLmVudi5OT1RFSFVCX1NFQ1JFVF9BUk4hO1xuXG4vLyBDYWNoZSB0aGUgdG9rZW4gdG8gYXZvaWQgZmV0Y2hpbmcgb24gZXZlcnkgcmVxdWVzdFxubGV0IGNhY2hlZFRva2VuOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuYXN5bmMgZnVuY3Rpb24gZ2V0Tm90ZWh1YlRva2VuKCk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGlmIChjYWNoZWRUb2tlbikge1xuICAgIHJldHVybiBjYWNoZWRUb2tlbjtcbiAgfVxuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgR2V0U2VjcmV0VmFsdWVDb21tYW5kKHsgU2VjcmV0SWQ6IE5PVEVIVUJfU0VDUkVUX0FSTiB9KTtcbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBzZWNyZXRzQ2xpZW50LnNlbmQoY29tbWFuZCk7XG5cbiAgaWYgKCFyZXNwb25zZS5TZWNyZXRTdHJpbmcpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ05vdGVodWIgQVBJIHRva2VuIG5vdCBmb3VuZCBpbiBzZWNyZXQnKTtcbiAgfVxuXG4gIGNvbnN0IHNlY3JldCA9IEpTT04ucGFyc2UocmVzcG9uc2UuU2VjcmV0U3RyaW5nKTtcbiAgY2FjaGVkVG9rZW4gPSBzZWNyZXQudG9rZW47XG5cbiAgaWYgKCFjYWNoZWRUb2tlbikge1xuICAgIHRocm93IG5ldyBFcnJvcignVG9rZW4gZmllbGQgbm90IGZvdW5kIGluIHNlY3JldCcpO1xuICB9XG5cbiAgcmV0dXJuIGNhY2hlZFRva2VuO1xufVxuXG4vLyBTdXBwb3J0ZWQgY29tbWFuZHNcbmNvbnN0IFZBTElEX0NPTU1BTkRTID0gWydwaW5nJywgJ2xvY2F0ZScsICdwbGF5X21lbG9keScsICd0ZXN0X2F1ZGlvJywgJ3NldF92b2x1bWUnLCAndW5sb2NrJ107XG5cbi8vIENvbW1hbmRzIHRoYXQgcmVxdWlyZSBhZG1pbiBvciBkZXZpY2Ugb3duZXIgcGVybWlzc2lvbnNcbmNvbnN0IFJFU1RSSUNURURfQ09NTUFORFMgPSBbJ3VubG9jayddO1xuXG5jb25zdCBERVZJQ0VTX1RBQkxFID0gcHJvY2Vzcy5lbnYuREVWSUNFU19UQUJMRSE7XG5cbi8qKlxuICogQ2hlY2sgaWYgdGhlIHVzZXIgaXMgYW4gYWRtaW4gKGluICdBZG1pbicgQ29nbml0byBncm91cClcbiAqL1xuZnVuY3Rpb24gaXNBZG1pbihldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBjbGFpbXMgPSAoZXZlbnQucmVxdWVzdENvbnRleHQgYXMgYW55KT8uYXV0aG9yaXplcj8uand0Py5jbGFpbXM7XG4gICAgaWYgKCFjbGFpbXMpIHJldHVybiBmYWxzZTtcblxuICAgIGNvbnN0IGdyb3VwcyA9IGNsYWltc1snY29nbml0bzpncm91cHMnXTtcbiAgICBpZiAoQXJyYXkuaXNBcnJheShncm91cHMpKSB7XG4gICAgICByZXR1cm4gZ3JvdXBzLmluY2x1ZGVzKCdBZG1pbicpO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGdyb3VwcyA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHJldHVybiBncm91cHMgPT09ICdBZG1pbicgfHwgZ3JvdXBzLmluY2x1ZGVzKCdBZG1pbicpO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKipcbiAqIEdldCB0aGUgdXNlcidzIGVtYWlsIGZyb20gdGhlIEpXVCBjbGFpbXNcbiAqL1xuZnVuY3Rpb24gZ2V0VXNlckVtYWlsKGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIHRyeSB7XG4gICAgY29uc3QgY2xhaW1zID0gKGV2ZW50LnJlcXVlc3RDb250ZXh0IGFzIGFueSk/LmF1dGhvcml6ZXI/Lmp3dD8uY2xhaW1zO1xuICAgIHJldHVybiBjbGFpbXM/LmVtYWlsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgdGhlIHVzZXIgb3ducyB0aGUgZGV2aWNlIChpcyBhc3NpZ25lZCB0byBpdClcbiAqL1xuYXN5bmMgZnVuY3Rpb24gaXNEZXZpY2VPd25lcihkZXZpY2VVaWQ6IHN0cmluZywgdXNlckVtYWlsOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3QgY29tbWFuZCA9IG5ldyBHZXRDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IERFVklDRVNfVEFCTEUsXG4gICAgS2V5OiB7IGRldmljZV91aWQ6IGRldmljZVVpZCB9LFxuICAgIFByb2plY3Rpb25FeHByZXNzaW9uOiAnYXNzaWduZWRfdG8nLFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgcmV0dXJuIHJlc3VsdC5JdGVtPy5hc3NpZ25lZF90byA9PT0gdXNlckVtYWlsO1xufVxuXG5leHBvcnQgY29uc3QgaGFuZGxlciA9IGFzeW5jIChldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQpOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4gPT4ge1xuICBjb25zb2xlLmxvZygnUmVxdWVzdDonLCBKU09OLnN0cmluZ2lmeShldmVudCkpO1xuXG4gIGNvbnN0IGNvcnNIZWFkZXJzID0ge1xuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nOiAnKicsXG4gICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnMnOiAnQ29udGVudC1UeXBlLEF1dGhvcml6YXRpb24nLFxuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzJzogJ0dFVCxQT1NULERFTEVURSxPUFRJT05TJyxcbiAgfTtcblxuICB0cnkge1xuICAgIC8vIEhUVFAgQVBJIHYyIHVzZXMgcmVxdWVzdENvbnRleHQuaHR0cC5tZXRob2QsIFJFU1QgQVBJIHYxIHVzZXMgaHR0cE1ldGhvZFxuICAgIGNvbnN0IG1ldGhvZCA9IChldmVudC5yZXF1ZXN0Q29udGV4dCBhcyBhbnkpPy5odHRwPy5tZXRob2QgfHwgZXZlbnQuaHR0cE1ldGhvZDtcbiAgICBjb25zdCBwYXRoID0gKGV2ZW50LnJlcXVlc3RDb250ZXh0IGFzIGFueSk/Lmh0dHA/LnBhdGggfHwgZXZlbnQucGF0aDtcblxuICAgIGlmIChtZXRob2QgPT09ICdPUFRJT05TJykge1xuICAgICAgcmV0dXJuIHsgc3RhdHVzQ29kZTogMjAwLCBoZWFkZXJzOiBjb3JzSGVhZGVycywgYm9keTogJycgfTtcbiAgICB9XG5cbiAgICAvLyBIYW5kbGUgL3YxL2NvbW1hbmRzIGVuZHBvaW50IChhbGwgY29tbWFuZHMgYWNyb3NzIGRldmljZXMpXG4gICAgaWYgKHBhdGggPT09ICcvdjEvY29tbWFuZHMnICYmIG1ldGhvZCA9PT0gJ0dFVCcpIHtcbiAgICAgIGNvbnN0IGRldmljZVVpZCA9IGV2ZW50LnF1ZXJ5U3RyaW5nUGFyYW1ldGVycz8uZGV2aWNlX3VpZDtcbiAgICAgIHJldHVybiBhd2FpdCBnZXRBbGxDb21tYW5kcyhkZXZpY2VVaWQsIGNvcnNIZWFkZXJzKTtcbiAgICB9XG5cbiAgICAvLyBIYW5kbGUgREVMRVRFIC92MS9jb21tYW5kcy97Y29tbWFuZF9pZH1cbiAgICBjb25zdCBjb21tYW5kSWQgPSBldmVudC5wYXRoUGFyYW1ldGVycz8uY29tbWFuZF9pZDtcbiAgICBpZiAoY29tbWFuZElkICYmIG1ldGhvZCA9PT0gJ0RFTEVURScpIHtcbiAgICAgIGNvbnN0IGRldmljZVVpZCA9IGV2ZW50LnF1ZXJ5U3RyaW5nUGFyYW1ldGVycz8uZGV2aWNlX3VpZDtcbiAgICAgIGlmICghZGV2aWNlVWlkKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICAgIGhlYWRlcnM6IGNvcnNIZWFkZXJzLFxuICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdkZXZpY2VfdWlkIHF1ZXJ5IHBhcmFtZXRlciByZXF1aXJlZCcgfSksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICByZXR1cm4gYXdhaXQgZGVsZXRlQ29tbWFuZChkZXZpY2VVaWQsIGNvbW1hbmRJZCwgY29yc0hlYWRlcnMpO1xuICAgIH1cblxuICAgIC8vIEhhbmRsZSBkZXZpY2Utc3BlY2lmaWMgY29tbWFuZHMgZW5kcG9pbnRzXG4gICAgY29uc3Qgc2VyaWFsTnVtYmVyID0gZXZlbnQucGF0aFBhcmFtZXRlcnM/LnNlcmlhbF9udW1iZXI7XG4gICAgaWYgKCFzZXJpYWxOdW1iZXIpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgaGVhZGVyczogY29yc0hlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdzZXJpYWxfbnVtYmVyIHJlcXVpcmVkJyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gUmVzb2x2ZSBzZXJpYWxfbnVtYmVyIHRvIGRldmljZSBpbmZvXG4gICAgY29uc3QgcmVzb2x2ZWQgPSBhd2FpdCByZXNvbHZlRGV2aWNlKHNlcmlhbE51bWJlcik7XG4gICAgaWYgKCFyZXNvbHZlZCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgICBoZWFkZXJzOiBjb3JzSGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0RldmljZSBub3QgZm91bmQnIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBpZiAobWV0aG9kID09PSAnUE9TVCcpIHtcbiAgICAgIC8vIFNlbmQgY29tbWFuZCB0byB0aGUgQ1VSUkVOVCBkZXZpY2VfdWlkICh0aGUgYWN0aXZlIE5vdGVjYXJkKVxuICAgICAgcmV0dXJuIGF3YWl0IHNlbmRDb21tYW5kKHJlc29sdmVkLmRldmljZV91aWQsIHJlc29sdmVkLnNlcmlhbF9udW1iZXIsIGV2ZW50LCBjb3JzSGVhZGVycyk7XG4gICAgfVxuXG4gICAgaWYgKG1ldGhvZCA9PT0gJ0dFVCcpIHtcbiAgICAgIC8vIEdldCBjb21tYW5kIGhpc3RvcnkgZnJvbSBBTEwgZGV2aWNlX3VpZHMgKG1lcmdlZCBhY3Jvc3MgTm90ZWNhcmQgc3dhcHMpXG4gICAgICByZXR1cm4gYXdhaXQgZ2V0Q29tbWFuZEhpc3RvcnkocmVzb2x2ZWQuc2VyaWFsX251bWJlciwgcmVzb2x2ZWQuYWxsX2RldmljZV91aWRzLCBjb3JzSGVhZGVycyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwNSxcbiAgICAgIGhlYWRlcnM6IGNvcnNIZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ01ldGhvZCBub3QgYWxsb3dlZCcgfSksXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvcjonLCBlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMCxcbiAgICAgIGhlYWRlcnM6IGNvcnNIZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0ludGVybmFsIHNlcnZlciBlcnJvcicgfSksXG4gICAgfTtcbiAgfVxufTtcblxuYXN5bmMgZnVuY3Rpb24gc2VuZENvbW1hbmQoXG4gIGRldmljZVVpZDogc3RyaW5nLFxuICBzZXJpYWxOdW1iZXI6IHN0cmluZyxcbiAgZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50LFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICBpZiAoIWV2ZW50LmJvZHkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdSZXF1ZXN0IGJvZHkgcmVxdWlyZWQnIH0pLFxuICAgIH07XG4gIH1cblxuICBjb25zdCByZXF1ZXN0ID0gSlNPTi5wYXJzZShldmVudC5ib2R5KTtcbiAgY29uc3QgeyBjbWQsIHBhcmFtcyB9ID0gcmVxdWVzdDtcblxuICAvLyBWYWxpZGF0ZSBjb21tYW5kXG4gIGlmICghY21kIHx8ICFWQUxJRF9DT01NQU5EUy5pbmNsdWRlcyhjbWQpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGVycm9yOiAnSW52YWxpZCBjb21tYW5kJyxcbiAgICAgICAgdmFsaWRfY29tbWFuZHM6IFZBTElEX0NPTU1BTkRTLFxuICAgICAgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8vIENoZWNrIGF1dGhvcml6YXRpb24gZm9yIHJlc3RyaWN0ZWQgY29tbWFuZHNcbiAgaWYgKFJFU1RSSUNURURfQ09NTUFORFMuaW5jbHVkZXMoY21kKSkge1xuICAgIGNvbnN0IGFkbWluID0gaXNBZG1pbihldmVudCk7XG4gICAgY29uc3QgdXNlckVtYWlsID0gZ2V0VXNlckVtYWlsKGV2ZW50KTtcbiAgICBjb25zdCBvd25lciA9IHVzZXJFbWFpbCA/IGF3YWl0IGlzRGV2aWNlT3duZXIoZGV2aWNlVWlkLCB1c2VyRW1haWwpIDogZmFsc2U7XG5cbiAgICBpZiAoIWFkbWluICYmICFvd25lcikge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDAzLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgZXJyb3I6ICdVbmF1dGhvcml6ZWQ6IE9ubHkgYWRtaW5zIGFuZCBkZXZpY2Ugb3duZXJzIGNhbiBzZW5kIHRoaXMgY29tbWFuZCcsXG4gICAgICAgIH0pLFxuICAgICAgfTtcbiAgICB9XG4gIH1cblxuICAvLyBHZW5lcmF0ZSBjb21tYW5kIElEXG4gIGNvbnN0IGNvbW1hbmRJZCA9IGBjbWRfJHtyYW5kb21VVUlEKCkucmVwbGFjZSgvLS9nLCAnJykuc3Vic3RyaW5nKDAsIDEyKX1gO1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuXG4gIC8vIEJ1aWxkIGNvbW1hbmQgbm90ZSBib2R5XG4gIGNvbnN0IG5vdGVCb2R5ID0ge1xuICAgIGNtZCxcbiAgICBwYXJhbXM6IHBhcmFtcyB8fCB7fSxcbiAgICBjb21tYW5kX2lkOiBjb21tYW5kSWQsXG4gICAgc2VudF9hdDogbm93LFxuICB9O1xuXG4gIC8vIFNlbmQgdG8gTm90ZWh1YiBBUEkgKHVzaW5nIHRoZSBjdXJyZW50IGRldmljZV91aWQgZm9yIHRoZSBhY3RpdmUgTm90ZWNhcmQpXG4gIHRyeSB7XG4gICAgY29uc3Qgbm90ZWh1YlRva2VuID0gYXdhaXQgZ2V0Tm90ZWh1YlRva2VuKCk7XG4gICAgY29uc3Qgbm90ZWh1YlJlc3BvbnNlID0gYXdhaXQgZmV0Y2goXG4gICAgICBgaHR0cHM6Ly9hcGkubm90ZWZpbGUubmV0L3YxL3Byb2plY3RzLyR7Tk9URUhVQl9QUk9KRUNUX1VJRH0vZGV2aWNlcy8ke2RldmljZVVpZH0vbm90ZXMvY29tbWFuZC5xaWAsXG4gICAgICB7XG4gICAgICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgJ0F1dGhvcml6YXRpb24nOiBgQmVhcmVyICR7bm90ZWh1YlRva2VufWAsXG4gICAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgfSxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBib2R5OiBub3RlQm9keSB9KSxcbiAgICAgIH1cbiAgICApO1xuXG4gICAgaWYgKCFub3RlaHViUmVzcG9uc2Uub2spIHtcbiAgICAgIGNvbnN0IGVycm9yVGV4dCA9IGF3YWl0IG5vdGVodWJSZXNwb25zZS50ZXh0KCk7XG4gICAgICBjb25zb2xlLmVycm9yKCdOb3RlaHViIEFQSSBlcnJvcjonLCBlcnJvclRleHQpO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiA1MDIsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICBlcnJvcjogJ0ZhaWxlZCB0byBzZW5kIGNvbW1hbmQgdG8gTm90ZWh1YicsXG4gICAgICAgICAgZGV0YWlsczogZXJyb3JUZXh0LFxuICAgICAgICB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gU3RvcmUgY29tbWFuZCBpbiBoaXN0b3J5IChpbmNsdWRlIHNlcmlhbF9udW1iZXIgZm9yIHJlZmVyZW5jZSlcbiAgICBhd2FpdCBzdG9yZUNvbW1hbmQoZGV2aWNlVWlkLCBzZXJpYWxOdW1iZXIsIGNvbW1hbmRJZCwgY21kLCBwYXJhbXMsIG5vdyk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgY29tbWFuZF9pZDogY29tbWFuZElkLFxuICAgICAgICBzZXJpYWxfbnVtYmVyOiBzZXJpYWxOdW1iZXIsXG4gICAgICAgIGRldmljZV91aWQ6IGRldmljZVVpZCxcbiAgICAgICAgY21kLFxuICAgICAgICBwYXJhbXM6IHBhcmFtcyB8fCB7fSxcbiAgICAgICAgc3RhdHVzOiAncXVldWVkJyxcbiAgICAgICAgcXVldWVkX2F0OiBuZXcgRGF0ZShub3cpLnRvSVNPU3RyaW5nKCksXG4gICAgICB9KSxcbiAgICB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHNlbmRpbmcgY29tbWFuZCB0byBOb3RlaHViOicsIGVycm9yKTtcblxuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA1MDIsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBlcnJvcjogJ0ZhaWxlZCB0byBjb21tdW5pY2F0ZSB3aXRoIE5vdGVodWInLFxuICAgICAgfSksXG4gICAgfTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBzdG9yZUNvbW1hbmQoXG4gIGRldmljZVVpZDogc3RyaW5nLFxuICBzZXJpYWxOdW1iZXI6IHN0cmluZyxcbiAgY29tbWFuZElkOiBzdHJpbmcsXG4gIGNtZDogc3RyaW5nLFxuICBwYXJhbXM6IGFueSxcbiAgdGltZXN0YW1wOiBudW1iZXJcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBjb21tYW5kID0gbmV3IFB1dENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogQ09NTUFORFNfVEFCTEUsXG4gICAgSXRlbToge1xuICAgICAgZGV2aWNlX3VpZDogZGV2aWNlVWlkLFxuICAgICAgc2VyaWFsX251bWJlcjogc2VyaWFsTnVtYmVyLFxuICAgICAgY29tbWFuZF9pZDogY29tbWFuZElkLFxuICAgICAgY21kLFxuICAgICAgcGFyYW1zOiBwYXJhbXMgfHwge30sXG4gICAgICBzdGF0dXM6ICdxdWV1ZWQnLFxuICAgICAgY3JlYXRlZF9hdDogdGltZXN0YW1wLFxuICAgICAgdXBkYXRlZF9hdDogdGltZXN0YW1wLFxuICAgICAgdHRsOiBNYXRoLmZsb29yKHRpbWVzdGFtcCAvIDEwMDApICsgMzAgKiAyNCAqIDYwICogNjAsIC8vIDMwIGRheXMgVFRMXG4gICAgfSxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldENvbW1hbmRIaXN0b3J5KFxuICBzZXJpYWxOdW1iZXI6IHN0cmluZyxcbiAgZGV2aWNlVWlkczogc3RyaW5nW10sXG4gIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiB7XG4gIC8vIFF1ZXJ5IGFsbCBkZXZpY2VfdWlkcyBpbiBwYXJhbGxlbCB0byBnZXQgbWVyZ2VkIGNvbW1hbmQgaGlzdG9yeVxuICBjb25zdCBxdWVyeVByb21pc2VzID0gZGV2aWNlVWlkcy5tYXAoYXN5bmMgKGRldmljZVVpZCkgPT4ge1xuICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogQ09NTUFORFNfVEFCTEUsXG4gICAgICBJbmRleE5hbWU6ICdkZXZpY2UtY3JlYXRlZC1pbmRleCcsXG4gICAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkJyxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgfSxcbiAgICAgIFNjYW5JbmRleEZvcndhcmQ6IGZhbHNlLFxuICAgICAgTGltaXQ6IDUwLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gICAgcmV0dXJuIHJlc3VsdC5JdGVtcyB8fCBbXTtcbiAgfSk7XG5cbiAgY29uc3QgYWxsUmVzdWx0cyA9IGF3YWl0IFByb21pc2UuYWxsKHF1ZXJ5UHJvbWlzZXMpO1xuXG4gIC8vIE1lcmdlIGFuZCBzb3J0IGJ5IGNyZWF0ZWRfYXQgKG1vc3QgcmVjZW50IGZpcnN0KVxuICBjb25zdCBtZXJnZWRDb21tYW5kcyA9IGFsbFJlc3VsdHNcbiAgICAuZmxhdCgpXG4gICAgLnNvcnQoKGEsIGIpID0+IGIuY3JlYXRlZF9hdCAtIGEuY3JlYXRlZF9hdClcbiAgICAuc2xpY2UoMCwgNTApOyAvLyBMaW1pdCB0byA1MCB0b3RhbFxuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgc2VyaWFsX251bWJlcjogc2VyaWFsTnVtYmVyLFxuICAgICAgY29tbWFuZHM6IG1lcmdlZENvbW1hbmRzLFxuICAgIH0pLFxuICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRBbGxDb21tYW5kcyhcbiAgZGV2aWNlVWlkOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiB7XG4gIC8vIElmIGRldmljZV91aWQgaXMgcHJvdmlkZWQsIHVzZSB0aGUgZXhpc3RpbmcgcXVlcnlcbiAgaWYgKGRldmljZVVpZCkge1xuICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogQ09NTUFORFNfVEFCTEUsXG4gICAgICBJbmRleE5hbWU6ICdkZXZpY2UtY3JlYXRlZC1pbmRleCcsXG4gICAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkJyxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgfSxcbiAgICAgIFNjYW5JbmRleEZvcndhcmQ6IGZhbHNlLFxuICAgICAgTGltaXQ6IDEwMCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGNvbW1hbmRzOiByZXN1bHQuSXRlbXMgfHwgW10sXG4gICAgICAgIHRvdGFsOiByZXN1bHQuSXRlbXM/Lmxlbmd0aCB8fCAwLFxuICAgICAgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8vIE90aGVyd2lzZSwgc2NhbiBmb3IgYWxsIGNvbW1hbmRzIChsaW1pdGVkIHRvIDEwMCBtb3N0IHJlY2VudClcbiAgY29uc3QgY29tbWFuZCA9IG5ldyBTY2FuQ29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBDT01NQU5EU19UQUJMRSxcbiAgICBMaW1pdDogMjAwLCAvLyBGZXRjaCBtb3JlIHRvIGFsbG93IHNvcnRpbmdcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG5cbiAgLy8gU29ydCBieSBjcmVhdGVkX2F0IGRlc2NlbmRpbmcgYW5kIHRha2UgdGhlIGZpcnN0IDEwMFxuICBjb25zdCBzb3J0ZWRDb21tYW5kcyA9IChyZXN1bHQuSXRlbXMgfHwgW10pXG4gICAgLnNvcnQoKGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBiOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT5cbiAgICAgICgoYi5jcmVhdGVkX2F0IGFzIG51bWJlcikgfHwgMCkgLSAoKGEuY3JlYXRlZF9hdCBhcyBudW1iZXIpIHx8IDApKVxuICAgIC5zbGljZSgwLCAxMDApO1xuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgY29tbWFuZHM6IHNvcnRlZENvbW1hbmRzLFxuICAgICAgdG90YWw6IHNvcnRlZENvbW1hbmRzLmxlbmd0aCxcbiAgICB9KSxcbiAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZGVsZXRlQ29tbWFuZChcbiAgZGV2aWNlVWlkOiBzdHJpbmcsXG4gIGNvbW1hbmRJZDogc3RyaW5nLFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICAvLyBGaXJzdCB2ZXJpZnkgdGhlIGNvbW1hbmQgZXhpc3RzXG4gIGNvbnN0IGdldENtZCA9IG5ldyBHZXRDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IENPTU1BTkRTX1RBQkxFLFxuICAgIEtleToge1xuICAgICAgZGV2aWNlX3VpZDogZGV2aWNlVWlkLFxuICAgICAgY29tbWFuZF9pZDogY29tbWFuZElkLFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoZ2V0Q21kKTtcbiAgaWYgKCFleGlzdGluZy5JdGVtKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwNCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnQ29tbWFuZCBub3QgZm91bmQnIH0pLFxuICAgIH07XG4gIH1cblxuICAvLyBEZWxldGUgdGhlIGNvbW1hbmRcbiAgY29uc3QgZGVsZXRlQ21kID0gbmV3IERlbGV0ZUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogQ09NTUFORFNfVEFCTEUsXG4gICAgS2V5OiB7XG4gICAgICBkZXZpY2VfdWlkOiBkZXZpY2VVaWQsXG4gICAgICBjb21tYW5kX2lkOiBjb21tYW5kSWQsXG4gICAgfSxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoZGVsZXRlQ21kKTtcblxuICByZXR1cm4ge1xuICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICBoZWFkZXJzLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIG1lc3NhZ2U6ICdDb21tYW5kIGRlbGV0ZWQnLFxuICAgICAgY29tbWFuZF9pZDogY29tbWFuZElkLFxuICAgIH0pLFxuICB9O1xufVxuIl19