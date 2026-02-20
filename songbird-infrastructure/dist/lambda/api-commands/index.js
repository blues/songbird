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
    const method = event.requestContext?.http?.method || event.httpMethod;
    const path = event.requestContext?.http?.path || event.path;
    console.log('Request:', JSON.stringify(event));
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    };
    try {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWNvbW1hbmRzL2luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7R0FRRzs7O0FBRUgsOERBQTBEO0FBQzFELHdEQU8rQjtBQUMvQiw0RUFBOEY7QUFFOUYsbUNBQW9DO0FBQ3BDLDJEQUF3RDtBQUV4RCxNQUFNLFNBQVMsR0FBRyxJQUFJLGdDQUFjLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDekMsTUFBTSxTQUFTLEdBQUcscUNBQXNCLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBQ3pELE1BQU0sYUFBYSxHQUFHLElBQUksNkNBQW9CLENBQUMsRUFBRSxDQUFDLENBQUM7QUFFbkQsTUFBTSxjQUFjLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFlLENBQUM7QUFDbkQsTUFBTSxtQkFBbUIsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLG1CQUFvQixDQUFDO0FBQzdELE1BQU0sa0JBQWtCLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxrQkFBbUIsQ0FBQztBQUUzRCxxREFBcUQ7QUFDckQsSUFBSSxXQUFXLEdBQWtCLElBQUksQ0FBQztBQUV0QyxLQUFLLFVBQVUsZUFBZTtJQUM1QixJQUFJLFdBQVcsRUFBRSxDQUFDO1FBQ2hCLE9BQU8sV0FBVyxDQUFDO0lBQ3JCLENBQUM7SUFFRCxNQUFNLE9BQU8sR0FBRyxJQUFJLDhDQUFxQixDQUFDLEVBQUUsUUFBUSxFQUFFLGtCQUFrQixFQUFFLENBQUMsQ0FBQztJQUM1RSxNQUFNLFFBQVEsR0FBRyxNQUFNLGFBQWEsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7SUFFbkQsSUFBSSxDQUFDLFFBQVEsQ0FBQyxZQUFZLEVBQUUsQ0FBQztRQUMzQixNQUFNLElBQUksS0FBSyxDQUFDLHVDQUF1QyxDQUFDLENBQUM7SUFDM0QsQ0FBQztJQUVELE1BQU0sTUFBTSxH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RTtZQUNILFVBQVUsRUFBRSxTQUFTO1lBQ3JCLFVBQVUsRUFBRSxTQUFTO1NBQ3RCO0tBQ0YsQ0FBQyxDQUFDO0lBRUgsTUFBTSxRQUFRLEdBQUcsTUFBTSxTQUFTLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQzlDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDbkIsT0FBTztZQUNMLFVBQVUsRUFBRSxHQUFHO1lBQ2YsT0FBTztZQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsS0FBSyxFQUFFLG1CQUFtQixFQUFFLENBQUM7U0FDckQsQ0FBQztJQUNKLENBQUM7SUFFRCxxQkFBcUI7SUFDckIsTUFBTSxTQUFTLEdBQUcsSUFBSSw0QkFBYSxDQUFDO1FBQ2xDLFNBQVMsRUFBRSxjQUFjO1FBQ3pCLEdBQUcsRUFBRTtZQUNILFVBQVUsRUFBRSxTQUFTO1lBQ3JCLFVBQVUsRUFBRSxTQUFTO1NBQ3RCO0tBQ0YsQ0FBQyxDQUFDO0lBRUgsTUFBTSxTQUFTLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBRWhDLE9BQU87UUFDTCxVQUFVLEVBQUUsR0FBRztRQUNmLE9BQU87UUFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQztZQUNuQixPQUFPLEVBQUUsaUJBQWlCO1lBQzFCLFVBQVUsRUFBRSxTQUFTO1NBQ3RCLENBQUM7S0FDSCxDQUFDO0FBQ0osQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQ29tbWFuZHMgQVBJIExhbWJkYVxuICpcbiAqIFNlbmRzIGNvbW1hbmRzIHRvIGRldmljZXMgdmlhIE5vdGVodWIgQVBJOlxuICogLSBHRVQgL3YxL2NvbW1hbmRzIC0gR2V0IGFsbCBjb21tYW5kcyBhY3Jvc3MgZGV2aWNlc1xuICogLSBERUxFVEUgL3YxL2NvbW1hbmRzL3tjb21tYW5kX2lkfSAtIERlbGV0ZSBhIGNvbW1hbmRcbiAqIC0gUE9TVCAvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vY29tbWFuZHMgLSBTZW5kIGNvbW1hbmQgdG8gZGV2aWNlIChyb3V0ZXMgdG8gY3VycmVudCBOb3RlY2FyZClcbiAqIC0gR0VUIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9jb21tYW5kcyAtIEdldCBjb21tYW5kIGhpc3RvcnkgZm9yIGEgZGV2aWNlIChtZXJnZWQgZnJvbSBhbGwgTm90ZWNhcmRzKVxuICovXG5cbmltcG9ydCB7IER5bmFtb0RCQ2xpZW50IH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LWR5bmFtb2RiJztcbmltcG9ydCB7XG4gIER5bmFtb0RCRG9jdW1lbnRDbGllbnQsXG4gIFB1dENvbW1hbmQsXG4gIFF1ZXJ5Q29tbWFuZCxcbiAgU2NhbkNvbW1hbmQsXG4gIERlbGV0ZUNvbW1hbmQsXG4gIEdldENvbW1hbmQsXG59IGZyb20gJ0Bhd3Mtc2RrL2xpYi1keW5hbW9kYic7XG5pbXBvcnQgeyBTZWNyZXRzTWFuYWdlckNsaWVudCwgR2V0U2VjcmV0VmFsdWVDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LXNlY3JldHMtbWFuYWdlcic7XG5pbXBvcnQgeyBBUElHYXRld2F5UHJveHlFdmVudCwgQVBJR2F0ZXdheVByb3h5UmVzdWx0IH0gZnJvbSAnYXdzLWxhbWJkYSc7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnY3J5cHRvJztcbmltcG9ydCB7IHJlc29sdmVEZXZpY2UgfSBmcm9tICcuLi9zaGFyZWQvZGV2aWNlLWxvb2t1cCc7XG5cbmNvbnN0IGRkYkNsaWVudCA9IG5ldyBEeW5hbW9EQkNsaWVudCh7fSk7XG5jb25zdCBkb2NDbGllbnQgPSBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LmZyb20oZGRiQ2xpZW50KTtcbmNvbnN0IHNlY3JldHNDbGllbnQgPSBuZXcgU2VjcmV0c01hbmFnZXJDbGllbnQoe30pO1xuXG5jb25zdCBDT01NQU5EU19UQUJMRSA9IHByb2Nlc3MuZW52LkNPTU1BTkRTX1RBQkxFITtcbmNvbnN0IE5PVEVIVUJfUFJPSkVDVF9VSUQgPSBwcm9jZXNzLmVudi5OT1RFSFVCX1BST0pFQ1RfVUlEITtcbmNvbnN0IE5PVEVIVUJfU0VDUkVUX0FSTiA9IHByb2Nlc3MuZW52Lk5PVEVIVUJfU0VDUkVUX0FSTiE7XG5cbi8vIENhY2hlIHRoZSB0b2tlbiB0byBhdm9pZCBmZXRjaGluZyBvbiBldmVyeSByZXF1ZXN0XG5sZXQgY2FjaGVkVG9rZW46IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5hc3luYyBmdW5jdGlvbiBnZXROb3RlaHViVG9rZW4oKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgaWYgKGNhY2hlZFRva2VuKSB7XG4gICAgcmV0dXJuIGNhY2hlZFRva2VuO1xuICB9XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBHZXRTZWNyZXRWYWx1ZUNvbW1hbmQoeyBTZWNyZXRJZDogTk9URUhVQl9TRUNSRVRfQVJOIH0pO1xuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHNlY3JldHNDbGllbnQuc2VuZChjb21tYW5kKTtcblxuICBpZiAoIXJlc3BvbnNlLlNlY3JldFN0cmluZykge1xuICAgIHRocm93IG5ldyBFcnJvcignTm90ZWh1YiBBUEkgdG9rZW4gbm90IGZvdW5kIGluIHNlY3JldCcpO1xuICB9XG5cbiAgY29uc3Qgc2VjcmV0ID0gSlNPTi5wYXJzZShyZXNwb25zZS5TZWNyZXRTdHJpbmcpO1xuICBjYWNoZWRUb2tlbiA9IHNlY3JldC50b2tlbjtcblxuICBpZiAoIWNhY2hlZFRva2VuKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdUb2tlbiBmaWVsZCBub3QgZm91bmQgaW4gc2VjcmV0Jyk7XG4gIH1cblxuICByZXR1cm4gY2FjaGVkVG9rZW47XG59XG5cbi8vIFN1cHBvcnRlZCBjb21tYW5kc1xuY29uc3QgVkFMSURfQ09NTUFORFMgPSBbJ3BpbmcnLCAnbG9jYXRlJywgJ3BsYXlfbWVsb2R5JywgJ3Rlc3RfYXVkaW8nLCAnc2V0X3ZvbHVtZScsICd1bmxvY2snXTtcblxuLy8gQ29tbWFuZHMgdGhhdCByZXF1aXJlIGFkbWluIG9yIGRldmljZSBvd25lciBwZXJtaXNzaW9uc1xuY29uc3QgUkVTVFJJQ1RFRF9DT01NQU5EUyA9IFsndW5sb2NrJ107XG5cbmNvbnN0IERFVklDRVNfVEFCTEUgPSBwcm9jZXNzLmVudi5ERVZJQ0VTX1RBQkxFITtcblxuLyoqXG4gKiBDaGVjayBpZiB0aGUgdXNlciBpcyBhbiBhZG1pbiAoaW4gJ0FkbWluJyBDb2duaXRvIGdyb3VwKVxuICovXG5mdW5jdGlvbiBpc0FkbWluKGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudCk6IGJvb2xlYW4ge1xuICB0cnkge1xuICAgIGNvbnN0IGNsYWltcyA9IChldmVudC5yZXF1ZXN0Q29udGV4dCBhcyBhbnkpPy5hdXRob3JpemVyPy5qd3Q/LmNsYWltcztcbiAgICBpZiAoIWNsYWltcykgcmV0dXJuIGZhbHNlO1xuXG4gICAgY29uc3QgZ3JvdXBzID0gY2xhaW1zWydjb2duaXRvOmdyb3VwcyddO1xuICAgIGlmIChBcnJheS5pc0FycmF5KGdyb3VwcykpIHtcbiAgICAgIHJldHVybiBncm91cHMuaW5jbHVkZXMoJ0FkbWluJyk7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgZ3JvdXBzID09PSAnc3RyaW5nJykge1xuICAgICAgcmV0dXJuIGdyb3VwcyA9PT0gJ0FkbWluJyB8fCBncm91cHMuaW5jbHVkZXMoJ0FkbWluJyk7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKlxuICogR2V0IHRoZSB1c2VyJ3MgZW1haWwgZnJvbSB0aGUgSldUIGNsYWltc1xuICovXG5mdW5jdGlvbiBnZXRVc2VyRW1haWwoZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50KTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBjbGFpbXMgPSAoZXZlbnQucmVxdWVzdENvbnRleHQgYXMgYW55KT8uYXV0aG9yaXplcj8uand0Py5jbGFpbXM7XG4gICAgcmV0dXJuIGNsYWltcz8uZW1haWw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbn1cblxuLyoqXG4gKiBDaGVjayBpZiB0aGUgdXNlciBvd25zIHRoZSBkZXZpY2UgKGlzIGFzc2lnbmVkIHRvIGl0KVxuICovXG5hc3luYyBmdW5jdGlvbiBpc0RldmljZU93bmVyKGRldmljZVVpZDogc3RyaW5nLCB1c2VyRW1haWw6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCBjb21tYW5kID0gbmV3IEdldENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICBLZXk6IHsgZGV2aWNlX3VpZDogZGV2aWNlVWlkIH0sXG4gICAgUHJvamVjdGlvbkV4cHJlc3Npb246ICdhc3NpZ25lZF90bycsXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICByZXR1cm4gcmVzdWx0Lkl0ZW0/LmFzc2lnbmVkX3RvID09PSB1c2VyRW1haWw7XG59XG5cbmV4cG9ydCBjb25zdCBoYW5kbGVyID0gYXN5bmMgKGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudCk6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiA9PiB7XG4gIGNvbnN0IG1ldGhvZCA9IChldmVudC5yZXF1ZXN0Q29udGV4dCBhcyBhbnkpPy5odHRwPy5tZXRob2QgfHwgZXZlbnQuaHR0cE1ldGhvZDtcbiAgY29uc3QgcGF0aCA9IChldmVudC5yZXF1ZXN0Q29udGV4dCBhcyBhbnkpPy5odHRwPy5wYXRoIHx8IGV2ZW50LnBhdGg7XG5cbiAgY29uc29sZS5sb2coJ1JlcXVlc3Q6JywgSlNPTi5zdHJpbmdpZnkoZXZlbnQpKTtcblxuICBjb25zdCBjb3JzSGVhZGVycyA9IHtcbiAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJzogJyonLFxuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzJzogJ0NvbnRlbnQtVHlwZSxBdXRob3JpemF0aW9uJyxcbiAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kcyc6ICdHRVQsUE9TVCxERUxFVEUsT1BUSU9OUycsXG4gIH07XG5cbiAgdHJ5IHtcblxuICAgIGlmIChtZXRob2QgPT09ICdPUFRJT05TJykge1xuICAgICAgcmV0dXJuIHsgc3RhdHVzQ29kZTogMjAwLCBoZWFkZXJzOiBjb3JzSGVhZGVycywgYm9keTogJycgfTtcbiAgICB9XG5cbiAgICAvLyBIYW5kbGUgL3YxL2NvbW1hbmRzIGVuZHBvaW50IChhbGwgY29tbWFuZHMgYWNyb3NzIGRldmljZXMpXG4gICAgaWYgKHBhdGggPT09ICcvdjEvY29tbWFuZHMnICYmIG1ldGhvZCA9PT0gJ0dFVCcpIHtcbiAgICAgIGNvbnN0IGRldmljZVVpZCA9IGV2ZW50LnF1ZXJ5U3RyaW5nUGFyYW1ldGVycz8uZGV2aWNlX3VpZDtcbiAgICAgIHJldHVybiBhd2FpdCBnZXRBbGxDb21tYW5kcyhkZXZpY2VVaWQsIGNvcnNIZWFkZXJzKTtcbiAgICB9XG5cbiAgICAvLyBIYW5kbGUgREVMRVRFIC92MS9jb21tYW5kcy97Y29tbWFuZF9pZH1cbiAgICBjb25zdCBjb21tYW5kSWQgPSBldmVudC5wYXRoUGFyYW1ldGVycz8uY29tbWFuZF9pZDtcbiAgICBpZiAoY29tbWFuZElkICYmIG1ldGhvZCA9PT0gJ0RFTEVURScpIHtcbiAgICAgIGNvbnN0IGRldmljZVVpZCA9IGV2ZW50LnF1ZXJ5U3RyaW5nUGFyYW1ldGVycz8uZGV2aWNlX3VpZDtcbiAgICAgIGlmICghZGV2aWNlVWlkKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICAgIGhlYWRlcnM6IGNvcnNIZWFkZXJzLFxuICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdkZXZpY2VfdWlkIHF1ZXJ5IHBhcmFtZXRlciByZXF1aXJlZCcgfSksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICByZXR1cm4gYXdhaXQgZGVsZXRlQ29tbWFuZChkZXZpY2VVaWQsIGNvbW1hbmRJZCwgY29yc0hlYWRlcnMpO1xuICAgIH1cblxuICAgIC8vIEhhbmRsZSBkZXZpY2Utc3BlY2lmaWMgY29tbWFuZHMgZW5kcG9pbnRzXG4gICAgY29uc3Qgc2VyaWFsTnVtYmVyID0gZXZlbnQucGF0aFBhcmFtZXRlcnM/LnNlcmlhbF9udW1iZXI7XG4gICAgaWYgKCFzZXJpYWxOdW1iZXIpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgaGVhZGVyczogY29yc0hlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdzZXJpYWxfbnVtYmVyIHJlcXVpcmVkJyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gUmVzb2x2ZSBzZXJpYWxfbnVtYmVyIHRvIGRldmljZSBpbmZvXG4gICAgY29uc3QgcmVzb2x2ZWQgPSBhd2FpdCByZXNvbHZlRGV2aWNlKHNlcmlhbE51bWJlcik7XG4gICAgaWYgKCFyZXNvbHZlZCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgICBoZWFkZXJzOiBjb3JzSGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0RldmljZSBub3QgZm91bmQnIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBpZiAobWV0aG9kID09PSAnUE9TVCcpIHtcbiAgICAgIC8vIFNlbmQgY29tbWFuZCB0byB0aGUgQ1VSUkVOVCBkZXZpY2VfdWlkICh0aGUgYWN0aXZlIE5vdGVjYXJkKVxuICAgICAgcmV0dXJuIGF3YWl0IHNlbmRDb21tYW5kKHJlc29sdmVkLmRldmljZV91aWQsIHJlc29sdmVkLnNlcmlhbF9udW1iZXIsIGV2ZW50LCBjb3JzSGVhZGVycyk7XG4gICAgfVxuXG4gICAgaWYgKG1ldGhvZCA9PT0gJ0dFVCcpIHtcbiAgICAgIC8vIEdldCBjb21tYW5kIGhpc3RvcnkgZnJvbSBBTEwgZGV2aWNlX3VpZHMgKG1lcmdlZCBhY3Jvc3MgTm90ZWNhcmQgc3dhcHMpXG4gICAgICByZXR1cm4gYXdhaXQgZ2V0Q29tbWFuZEhpc3RvcnkocmVzb2x2ZWQuc2VyaWFsX251bWJlciwgcmVzb2x2ZWQuYWxsX2RldmljZV91aWRzLCBjb3JzSGVhZGVycyk7XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDUsXG4gICAgICBoZWFkZXJzOiBjb3JzSGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdNZXRob2Qgbm90IGFsbG93ZWQnIH0pLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3I6JywgZXJyb3IpO1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA1MDAsXG4gICAgICBoZWFkZXJzOiBjb3JzSGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnRlcm5hbCBzZXJ2ZXIgZXJyb3InIH0pLFxuICAgIH07XG4gIH1cbn07XG5cbmFzeW5jIGZ1bmN0aW9uIHNlbmRDb21tYW5kKFxuICBkZXZpY2VVaWQ6IHN0cmluZyxcbiAgc2VyaWFsTnVtYmVyOiBzdHJpbmcsXG4gIGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudCxcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgaWYgKCFldmVudC5ib2R5KSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnUmVxdWVzdCBib2R5IHJlcXVpcmVkJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgcmVxdWVzdCA9IEpTT04ucGFyc2UoZXZlbnQuYm9keSk7XG4gIGNvbnN0IHsgY21kLCBwYXJhbXMgfSA9IHJlcXVlc3Q7XG5cbiAgLy8gVmFsaWRhdGUgY29tbWFuZFxuICBpZiAoIWNtZCB8fCAhVkFMSURfQ09NTUFORFMuaW5jbHVkZXMoY21kKSkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBlcnJvcjogJ0ludmFsaWQgY29tbWFuZCcsXG4gICAgICAgIHZhbGlkX2NvbW1hbmRzOiBWQUxJRF9DT01NQU5EUyxcbiAgICAgIH0pLFxuICAgIH07XG4gIH1cblxuICAvLyBDaGVjayBhdXRob3JpemF0aW9uIGZvciByZXN0cmljdGVkIGNvbW1hbmRzXG4gIGlmIChSRVNUUklDVEVEX0NPTU1BTkRTLmluY2x1ZGVzKGNtZCkpIHtcbiAgICBjb25zdCBhZG1pbiA9IGlzQWRtaW4oZXZlbnQpO1xuICAgIGNvbnN0IHVzZXJFbWFpbCA9IGdldFVzZXJFbWFpbChldmVudCk7XG4gICAgY29uc3Qgb3duZXIgPSB1c2VyRW1haWwgPyBhd2FpdCBpc0RldmljZU93bmVyKGRldmljZVVpZCwgdXNlckVtYWlsKSA6IGZhbHNlO1xuXG4gICAgaWYgKCFhZG1pbiAmJiAhb3duZXIpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwMyxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIGVycm9yOiAnVW5hdXRob3JpemVkOiBPbmx5IGFkbWlucyBhbmQgZGV2aWNlIG93bmVycyBjYW4gc2VuZCB0aGlzIGNvbW1hbmQnLFxuICAgICAgICB9KSxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgLy8gR2VuZXJhdGUgY29tbWFuZCBJRFxuICBjb25zdCBjb21tYW5kSWQgPSBgY21kXyR7cmFuZG9tVVVJRCgpLnJlcGxhY2UoLy0vZywgJycpLnN1YnN0cmluZygwLCAxMil9YDtcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcblxuICAvLyBCdWlsZCBjb21tYW5kIG5vdGUgYm9keVxuICBjb25zdCBub3RlQm9keSA9IHtcbiAgICBjbWQsXG4gICAgcGFyYW1zOiBwYXJhbXMgfHwge30sXG4gICAgY29tbWFuZF9pZDogY29tbWFuZElkLFxuICAgIHNlbnRfYXQ6IG5vdyxcbiAgfTtcblxuICAvLyBTZW5kIHRvIE5vdGVodWIgQVBJICh1c2luZyB0aGUgY3VycmVudCBkZXZpY2VfdWlkIGZvciB0aGUgYWN0aXZlIE5vdGVjYXJkKVxuICB0cnkge1xuICAgIGNvbnN0IG5vdGVodWJUb2tlbiA9IGF3YWl0IGdldE5vdGVodWJUb2tlbigpO1xuICAgIGNvbnN0IG5vdGVodWJSZXNwb25zZSA9IGF3YWl0IGZldGNoKFxuICAgICAgYGh0dHBzOi8vYXBpLm5vdGVmaWxlLm5ldC92MS9wcm9qZWN0cy8ke05PVEVIVUJfUFJPSkVDVF9VSUR9L2RldmljZXMvJHtkZXZpY2VVaWR9L25vdGVzL2NvbW1hbmQucWlgLFxuICAgICAge1xuICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke25vdGVodWJUb2tlbn1gLFxuICAgICAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICAgIH0sXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgYm9keTogbm90ZUJvZHkgfSksXG4gICAgICB9XG4gICAgKTtcblxuICAgIGlmICghbm90ZWh1YlJlc3BvbnNlLm9rKSB7XG4gICAgICBjb25zdCBlcnJvclRleHQgPSBhd2FpdCBub3RlaHViUmVzcG9uc2UudGV4dCgpO1xuICAgICAgY29uc29sZS5lcnJvcignTm90ZWh1YiBBUEkgZXJyb3I6JywgZXJyb3JUZXh0KTtcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNTAyLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgZXJyb3I6ICdGYWlsZWQgdG8gc2VuZCBjb21tYW5kIHRvIE5vdGVodWInLFxuICAgICAgICAgIGRldGFpbHM6IGVycm9yVGV4dCxcbiAgICAgICAgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIFN0b3JlIGNvbW1hbmQgaW4gaGlzdG9yeSAoaW5jbHVkZSBzZXJpYWxfbnVtYmVyIGZvciByZWZlcmVuY2UpXG4gICAgYXdhaXQgc3RvcmVDb21tYW5kKGRldmljZVVpZCwgc2VyaWFsTnVtYmVyLCBjb21tYW5kSWQsIGNtZCwgcGFyYW1zLCBub3cpO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGNvbW1hbmRfaWQ6IGNvbW1hbmRJZCxcbiAgICAgICAgc2VyaWFsX251bWJlcjogc2VyaWFsTnVtYmVyLFxuICAgICAgICBkZXZpY2VfdWlkOiBkZXZpY2VVaWQsXG4gICAgICAgIGNtZCxcbiAgICAgICAgcGFyYW1zOiBwYXJhbXMgfHwge30sXG4gICAgICAgIHN0YXR1czogJ3F1ZXVlZCcsXG4gICAgICAgIHF1ZXVlZF9hdDogbmV3IERhdGUobm93KS50b0lTT1N0cmluZygpLFxuICAgICAgfSksXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvciBzZW5kaW5nIGNvbW1hbmQgdG8gTm90ZWh1YjonLCBlcnJvcik7XG5cbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNTAyLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgZXJyb3I6ICdGYWlsZWQgdG8gY29tbXVuaWNhdGUgd2l0aCBOb3RlaHViJyxcbiAgICAgIH0pLFxuICAgIH07XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gc3RvcmVDb21tYW5kKFxuICBkZXZpY2VVaWQ6IHN0cmluZyxcbiAgc2VyaWFsTnVtYmVyOiBzdHJpbmcsXG4gIGNvbW1hbmRJZDogc3RyaW5nLFxuICBjbWQ6IHN0cmluZyxcbiAgcGFyYW1zOiBhbnksXG4gIHRpbWVzdGFtcDogbnVtYmVyXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgY29tbWFuZCA9IG5ldyBQdXRDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IENPTU1BTkRTX1RBQkxFLFxuICAgIEl0ZW06IHtcbiAgICAgIGRldmljZV91aWQ6IGRldmljZVVpZCxcbiAgICAgIHNlcmlhbF9udW1iZXI6IHNlcmlhbE51bWJlcixcbiAgICAgIGNvbW1hbmRfaWQ6IGNvbW1hbmRJZCxcbiAgICAgIGNtZCxcbiAgICAgIHBhcmFtczogcGFyYW1zIHx8IHt9LFxuICAgICAgc3RhdHVzOiAncXVldWVkJyxcbiAgICAgIGNyZWF0ZWRfYXQ6IHRpbWVzdGFtcCxcbiAgICAgIHVwZGF0ZWRfYXQ6IHRpbWVzdGFtcCxcbiAgICAgIHR0bDogTWF0aC5mbG9vcih0aW1lc3RhbXAgLyAxMDAwKSArIDMwICogMjQgKiA2MCAqIDYwLCAvLyAzMCBkYXlzIFRUTFxuICAgIH0sXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRDb21tYW5kSGlzdG9yeShcbiAgc2VyaWFsTnVtYmVyOiBzdHJpbmcsXG4gIGRldmljZVVpZHM6IHN0cmluZ1tdLFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICAvLyBRdWVyeSBhbGwgZGV2aWNlX3VpZHMgaW4gcGFyYWxsZWwgdG8gZ2V0IG1lcmdlZCBjb21tYW5kIGhpc3RvcnlcbiAgY29uc3QgcXVlcnlQcm9taXNlcyA9IGRldmljZVVpZHMubWFwKGFzeW5jIChkZXZpY2VVaWQpID0+IHtcbiAgICBjb25zdCBjb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IENPTU1BTkRTX1RBQkxFLFxuICAgICAgSW5kZXhOYW1lOiAnZGV2aWNlLWNyZWF0ZWQtaW5kZXgnLFxuICAgICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQgPSA6ZGV2aWNlX3VpZCcsXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICAgIH0sXG4gICAgICBTY2FuSW5kZXhGb3J3YXJkOiBmYWxzZSxcbiAgICAgIExpbWl0OiA1MCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICAgIHJldHVybiByZXN1bHQuSXRlbXMgfHwgW107XG4gIH0pO1xuXG4gIGNvbnN0IGFsbFJlc3VsdHMgPSBhd2FpdCBQcm9taXNlLmFsbChxdWVyeVByb21pc2VzKTtcblxuICAvLyBNZXJnZSBhbmQgc29ydCBieSBjcmVhdGVkX2F0IChtb3N0IHJlY2VudCBmaXJzdClcbiAgY29uc3QgbWVyZ2VkQ29tbWFuZHMgPSBhbGxSZXN1bHRzXG4gICAgLmZsYXQoKVxuICAgIC5zb3J0KChhLCBiKSA9PiBiLmNyZWF0ZWRfYXQgLSBhLmNyZWF0ZWRfYXQpXG4gICAgLnNsaWNlKDAsIDUwKTsgLy8gTGltaXQgdG8gNTAgdG90YWxcblxuICByZXR1cm4ge1xuICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICBoZWFkZXJzLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIHNlcmlhbF9udW1iZXI6IHNlcmlhbE51bWJlcixcbiAgICAgIGNvbW1hbmRzOiBtZXJnZWRDb21tYW5kcyxcbiAgICB9KSxcbiAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0QWxsQ29tbWFuZHMoXG4gIGRldmljZVVpZDogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICAvLyBJZiBkZXZpY2VfdWlkIGlzIHByb3ZpZGVkLCB1c2UgdGhlIGV4aXN0aW5nIHF1ZXJ5XG4gIGlmIChkZXZpY2VVaWQpIHtcbiAgICBjb25zdCBjb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IENPTU1BTkRTX1RBQkxFLFxuICAgICAgSW5kZXhOYW1lOiAnZGV2aWNlLWNyZWF0ZWQtaW5kZXgnLFxuICAgICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQgPSA6ZGV2aWNlX3VpZCcsXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICAgIH0sXG4gICAgICBTY2FuSW5kZXhGb3J3YXJkOiBmYWxzZSxcbiAgICAgIExpbWl0OiAxMDAsXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcblxuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBjb21tYW5kczogcmVzdWx0Lkl0ZW1zIHx8IFtdLFxuICAgICAgICB0b3RhbDogcmVzdWx0Lkl0ZW1zPy5sZW5ndGggfHwgMCxcbiAgICAgIH0pLFxuICAgIH07XG4gIH1cblxuICAvLyBPdGhlcndpc2UsIHNjYW4gZm9yIGFsbCBjb21tYW5kcyAobGltaXRlZCB0byAxMDAgbW9zdCByZWNlbnQpXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgU2NhbkNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogQ09NTUFORFNfVEFCTEUsXG4gICAgTGltaXQ6IDIwMCwgLy8gRmV0Y2ggbW9yZSB0byBhbGxvdyBzb3J0aW5nXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuXG4gIC8vIFNvcnQgYnkgY3JlYXRlZF9hdCBkZXNjZW5kaW5nIGFuZCB0YWtlIHRoZSBmaXJzdCAxMDBcbiAgY29uc3Qgc29ydGVkQ29tbWFuZHMgPSAocmVzdWx0Lkl0ZW1zIHx8IFtdKVxuICAgIC5zb3J0KChhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgYjogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+XG4gICAgICAoKGIuY3JlYXRlZF9hdCBhcyBudW1iZXIpIHx8IDApIC0gKChhLmNyZWF0ZWRfYXQgYXMgbnVtYmVyKSB8fCAwKSlcbiAgICAuc2xpY2UoMCwgMTAwKTtcblxuICByZXR1cm4ge1xuICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICBoZWFkZXJzLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIGNvbW1hbmRzOiBzb3J0ZWRDb21tYW5kcyxcbiAgICAgIHRvdGFsOiBzb3J0ZWRDb21tYW5kcy5sZW5ndGgsXG4gICAgfSksXG4gIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGRlbGV0ZUNvbW1hbmQoXG4gIGRldmljZVVpZDogc3RyaW5nLFxuICBjb21tYW5kSWQ6IHN0cmluZyxcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgLy8gRmlyc3QgdmVyaWZ5IHRoZSBjb21tYW5kIGV4aXN0c1xuICBjb25zdCBnZXRDbWQgPSBuZXcgR2V0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBDT01NQU5EU19UQUJMRSxcbiAgICBLZXk6IHtcbiAgICAgIGRldmljZV91aWQ6IGRldmljZVVpZCxcbiAgICAgIGNvbW1hbmRfaWQ6IGNvbW1hbmRJZCxcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCBleGlzdGluZyA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGdldENtZCk7XG4gIGlmICghZXhpc3RpbmcuSXRlbSkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDQsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0NvbW1hbmQgbm90IGZvdW5kJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gRGVsZXRlIHRoZSBjb21tYW5kXG4gIGNvbnN0IGRlbGV0ZUNtZCA9IG5ldyBEZWxldGVDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IENPTU1BTkRTX1RBQkxFLFxuICAgIEtleToge1xuICAgICAgZGV2aWNlX3VpZDogZGV2aWNlVWlkLFxuICAgICAgY29tbWFuZF9pZDogY29tbWFuZElkLFxuICAgIH0sXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGRlbGV0ZUNtZCk7XG5cbiAgcmV0dXJuIHtcbiAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgaGVhZGVycyxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBtZXNzYWdlOiAnQ29tbWFuZCBkZWxldGVkJyxcbiAgICAgIGNvbW1hbmRfaWQ6IGNvbW1hbmRJZCxcbiAgICB9KSxcbiAgfTtcbn1cbiJdfQ==