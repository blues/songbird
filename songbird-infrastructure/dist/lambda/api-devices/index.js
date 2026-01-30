"use strict";
/**
 * Devices API Lambda
 *
 * Handles device CRUD operations:
 * - GET /devices - List all devices
 * - GET /devices/{serial_number} - Get device details
 * - PATCH /devices/{serial_number} - Update device metadata
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const device_lookup_1 = require("../shared/device-lookup");
const ddbClient = new client_dynamodb_1.DynamoDBClient({});
const docClient = lib_dynamodb_1.DynamoDBDocumentClient.from(ddbClient);
const DEVICES_TABLE = process.env.DEVICES_TABLE;
const DEVICE_ALIASES_TABLE = process.env.DEVICE_ALIASES_TABLE || 'songbird-device-aliases';
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE || 'songbird-activity';
const handler = async (event) => {
    console.log('Request:', JSON.stringify(event));
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    };
    try {
        // HTTP API v2 uses requestContext.http.method, REST API v1 uses httpMethod
        const method = event.requestContext?.http?.method || event.httpMethod;
        const serialNumber = event.pathParameters?.serial_number;
        const path = event.rawPath || event.path || '';
        if (method === 'OPTIONS') {
            return { statusCode: 200, headers: corsHeaders, body: '' };
        }
        // POST /devices/merge - Merge two devices (Admin only)
        if (method === 'POST' && path.endsWith('/merge')) {
            return await mergeDevices(event, corsHeaders);
        }
        if (method === 'GET' && !serialNumber) {
            // List devices
            return await listDevices(event, corsHeaders);
        }
        if (method === 'GET' && serialNumber) {
            // Get single device by serial number
            return await getDeviceBySerial(serialNumber, corsHeaders);
        }
        if (method === 'PATCH' && serialNumber) {
            // Update device by serial number
            return await updateDeviceBySerial(serialNumber, event.body, corsHeaders);
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
async function listDevices(event, headers) {
    const queryParams = event.queryStringParameters || {};
    const fleet = queryParams.fleet;
    const status = queryParams.status;
    const limit = parseInt(queryParams.limit || '100');
    let items = [];
    if (fleet) {
        // Query by fleet using GSI
        const command = new lib_dynamodb_1.QueryCommand({
            TableName: DEVICES_TABLE,
            IndexName: 'fleet-index',
            KeyConditionExpression: '#fleet = :fleet',
            ExpressionAttributeNames: { '#fleet': 'fleet' },
            ExpressionAttributeValues: { ':fleet': fleet },
            Limit: limit,
            ScanIndexForward: false, // Most recent first
        });
        const result = await docClient.send(command);
        items = result.Items || [];
    }
    else if (status) {
        // Query by status using GSI
        const command = new lib_dynamodb_1.QueryCommand({
            TableName: DEVICES_TABLE,
            IndexName: 'status-index',
            KeyConditionExpression: '#status = :status',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':status': status },
            Limit: limit,
            ScanIndexForward: false,
        });
        const result = await docClient.send(command);
        items = result.Items || [];
    }
    else {
        // Scan all devices (for small fleets)
        const command = new lib_dynamodb_1.ScanCommand({
            TableName: DEVICES_TABLE,
            Limit: limit,
        });
        const result = await docClient.send(command);
        items = result.Items || [];
    }
    // Transform and calculate fleet stats
    const transformedDevices = items.map(transformDevice);
    const stats = calculateStats(items);
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            devices: transformedDevices,
            count: transformedDevices.length,
            stats,
        }),
    };
}
async function getDeviceBySerial(serialNumber, headers) {
    // Resolve serial_number to device info
    const resolved = await (0, device_lookup_1.resolveDevice)(serialNumber);
    if (!resolved) {
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Device not found' }),
        };
    }
    // Get the device using the current device_uid
    const command = new lib_dynamodb_1.GetCommand({
        TableName: DEVICES_TABLE,
        Key: { device_uid: resolved.device_uid },
    });
    const result = await docClient.send(command);
    if (!result.Item) {
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Device not found' }),
        };
    }
    // Transform and add device_uid history
    const device = transformDevice(result.Item);
    device.device_uid_history = resolved.all_device_uids.length > 1
        ? resolved.all_device_uids.slice(1) // Exclude current device_uid
        : undefined;
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify(device),
    };
}
async function updateDeviceBySerial(serialNumber, body, headers) {
    if (!body) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Request body required' }),
        };
    }
    // Resolve serial_number to device_uid
    const resolved = await (0, device_lookup_1.resolveDevice)(serialNumber);
    if (!resolved) {
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Device not found' }),
        };
    }
    const updates = JSON.parse(body);
    // Only allow certain fields to be updated (removed serial_number - it's now immutable)
    const allowedFields = ['name', 'assigned_to', 'assigned_to_name', 'fleet', 'notes'];
    const updateExpressions = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};
    for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key)) {
            const attrName = `#${key}`;
            const attrValue = `:${key}`;
            updateExpressions.push(`${attrName} = ${attrValue}`);
            expressionAttributeNames[attrName] = key;
            expressionAttributeValues[attrValue] = value;
        }
    }
    if (updateExpressions.length === 0) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'No valid fields to update' }),
        };
    }
    // Always update updated_at
    updateExpressions.push('#updated_at = :updated_at');
    expressionAttributeNames['#updated_at'] = 'updated_at';
    expressionAttributeValues[':updated_at'] = Date.now();
    const command = new lib_dynamodb_1.UpdateCommand({
        TableName: DEVICES_TABLE,
        Key: { device_uid: resolved.device_uid },
        UpdateExpression: 'SET ' + updateExpressions.join(', '),
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW',
    });
    const result = await docClient.send(command);
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify(transformDevice(result.Attributes)),
    };
}
/**
 * Calculate device status based on last_seen timestamp
 * Online if seen within 15 minutes, offline otherwise
 */
function calculateDeviceStatus(item) {
    if (item.status === 'alert') {
        return 'alert';
    }
    const now = Date.now();
    const offlineThreshold = 15 * 60 * 1000; // 15 minutes
    if (item.last_seen && now - item.last_seen < offlineThreshold) {
        return 'online';
    }
    return 'offline';
}
/**
 * Transform DynamoDB device record to frontend format
 * Flattens nested objects like last_location and last_telemetry
 */
function transformDevice(item) {
    const device = {
        device_uid: item.device_uid,
        serial_number: item.serial_number,
        name: item.name,
        fleet: item.fleet,
        status: calculateDeviceStatus(item),
        // Convert millisecond timestamp to ISO string for frontend
        last_seen: item.last_seen ? new Date(item.last_seen).toISOString() : undefined,
        mode: item.current_mode,
        transit_locked: item.transit_locked || false,
        demo_locked: item.demo_locked || false,
        gps_power_saving: item.gps_power_saving || false,
        gps_no_sat: item.gps_no_sat || false,
        usb_powered: item.usb_powered || false,
        created_at: item.created_at ? new Date(item.created_at).toISOString() : undefined,
        updated_at: item.updated_at ? new Date(item.updated_at).toISOString() : undefined,
        assigned_to: item.assigned_to,
        assigned_to_name: item.assigned_to_name,
    };
    // Flatten last_location
    if (item.last_location) {
        device.latitude = item.last_location.lat;
        device.longitude = item.last_location.lon;
        // Convert Unix timestamp (seconds) to ISO string for frontend
        if (item.last_location.time) {
            // Notehub timestamps are in seconds, convert to milliseconds for Date
            const timeMs = item.last_location.time * 1000;
            device.location_time = new Date(timeMs).toISOString();
        }
        device.location_source = item.last_location.source;
        device.location_name = item.last_location.name;
    }
    // Flatten last_telemetry
    if (item.last_telemetry) {
        device.temperature = item.last_telemetry.temp;
        device.humidity = item.last_telemetry.humidity;
        device.pressure = item.last_telemetry.pressure;
        // Note: voltage no longer comes from last_telemetry; it's set from _log.qo/_health.qo
        device.motion = item.last_telemetry.motion;
    }
    // Voltage comes from device.voltage field (set from _log.qo or _health.qo events)
    if (item.voltage !== undefined) {
        device.voltage = item.voltage;
    }
    // Flatten last_power (Mojo data)
    if (item.last_power) {
        device.mojo_voltage = item.last_power.voltage;
        device.mojo_temperature = item.last_power.temperature;
        device.milliamp_hours = item.last_power.milliamp_hours;
    }
    // Firmware versions (from _session.qo events)
    if (item.firmware_version) {
        device.firmware_version = item.firmware_version;
    }
    if (item.notecard_version) {
        device.notecard_version = item.notecard_version;
    }
    if (item.notecard_sku) {
        device.notecard_sku = item.notecard_sku;
    }
    return device;
}
function calculateStats(devices) {
    const stats = {
        total: devices.length,
        online: 0,
        offline: 0,
        alert: 0,
        low_battery: 0,
        fleets: {},
    };
    const now = Date.now();
    const offlineThreshold = 15 * 60 * 1000; // 15 minutes
    for (const device of devices) {
        // Status counts
        if (device.status === 'alert') {
            stats.alert++;
        }
        else if (device.last_seen && now - device.last_seen < offlineThreshold) {
            stats.online++;
        }
        else {
            stats.offline++;
        }
        // Low battery check (voltage comes from _log.qo/_health.qo, stored in device.voltage)
        if (device.voltage && device.voltage < 3.4) {
            stats.low_battery++;
        }
        // Fleet counts
        const fleet = device.fleet || 'default';
        stats.fleets[fleet] = (stats.fleets[fleet] || 0) + 1;
    }
    return stats;
}
/**
 * Merge two devices into one (Admin only)
 * The source device's device_uid is added to the target's alias history,
 * and the source device record is deleted.
 */
async function mergeDevices(event, headers) {
    // Check for admin authorization
    const claims = event.requestContext?.authorizer?.jwt?.claims || {};
    const groups = claims['cognito:groups'] || '';
    const isAdmin = groups.includes('Admin');
    if (!isAdmin) {
        return {
            statusCode: 403,
            headers,
            body: JSON.stringify({ error: 'Admin access required to merge devices' }),
        };
    }
    if (!event.body) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Request body required' }),
        };
    }
    const { source_serial_number, target_serial_number } = JSON.parse(event.body);
    if (!source_serial_number || !target_serial_number) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Both source_serial_number and target_serial_number are required' }),
        };
    }
    if (source_serial_number === target_serial_number) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Source and target cannot be the same device' }),
        };
    }
    // Get both devices
    const sourceAlias = await (0, device_lookup_1.getAliasBySerial)(source_serial_number);
    const targetAlias = await (0, device_lookup_1.getAliasBySerial)(target_serial_number);
    if (!sourceAlias) {
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: `Source device not found: ${source_serial_number}` }),
        };
    }
    if (!targetAlias) {
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: `Target device not found: ${target_serial_number}` }),
        };
    }
    const sourceDeviceUid = sourceAlias.device_uid;
    const targetDeviceUid = targetAlias.device_uid;
    const sourcePreviousUids = sourceAlias.previous_device_uids || [];
    const targetPreviousUids = targetAlias.previous_device_uids || [];
    // Merge all device_uids: target's previous + source's current + source's previous
    const allPreviousUids = [
        ...new Set([
            ...targetPreviousUids,
            sourceDeviceUid,
            ...sourcePreviousUids,
        ]),
    ];
    // Update target alias to include source device_uids
    await docClient.send(new lib_dynamodb_1.PutCommand({
        TableName: DEVICE_ALIASES_TABLE,
        Item: {
            serial_number: target_serial_number,
            device_uid: targetDeviceUid,
            previous_device_uids: allPreviousUids,
            created_at: targetAlias.created_at,
            updated_at: Date.now(),
        },
    }));
    // Delete source alias
    await docClient.send(new lib_dynamodb_1.DeleteCommand({
        TableName: DEVICE_ALIASES_TABLE,
        Key: { serial_number: source_serial_number },
    }));
    // Delete source device record
    await docClient.send(new lib_dynamodb_1.DeleteCommand({
        TableName: DEVICES_TABLE,
        Key: { device_uid: sourceDeviceUid },
    }));
    // Create activity feed event
    const activityEvent = {
        event_id: `merge-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        device_uid: targetDeviceUid,
        serial_number: target_serial_number,
        event_type: 'device_merged',
        timestamp: Date.now(),
        data: {
            source_serial_number,
            source_device_uid: sourceDeviceUid,
            target_serial_number,
            target_device_uid: targetDeviceUid,
            merged_device_uids: allPreviousUids,
        },
    };
    try {
        await docClient.send(new lib_dynamodb_1.PutCommand({
            TableName: ACTIVITY_TABLE,
            Item: activityEvent,
        }));
    }
    catch (err) {
        // Activity logging is non-critical, log but don't fail
        console.error('Failed to log merge activity:', err);
    }
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            message: 'Devices merged successfully',
            target_serial_number,
            target_device_uid: targetDeviceUid,
            merged_device_uids: [targetDeviceUid, ...allPreviousUids],
            deleted_serial_number: source_serial_number,
            deleted_device_uid: sourceDeviceUid,
        }),
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWRldmljZXMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7O0dBT0c7OztBQUVILDhEQUEwRDtBQUMxRCx3REFRK0I7QUFFL0IsMkRBQTBFO0FBRTFFLE1BQU0sU0FBUyxHQUFHLElBQUksZ0NBQWMsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN6QyxNQUFNLFNBQVMsR0FBRyxxQ0FBc0IsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7QUFFekQsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxhQUFjLENBQUM7QUFDakQsTUFBTSxvQkFBb0IsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLG9CQUFvQixJQUFJLHlCQUF5QixDQUFDO0FBQzNGLE1BQU0sY0FBYyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsY0FBYyxJQUFJLG1CQUFtQixDQUFDO0FBRWxFLE1BQU0sT0FBTyxHQUFHLEtBQUssRUFBRSxLQUEyQixFQUFrQyxFQUFFO0lBQzNGLE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUUvQyxNQUFNLFdBQVcsR0FBRztRQUNsQiw2QkFBNkIsRUFBRSxHQUFHO1FBQ2xDLDhCQUE4QixFQUFFLDRCQUE0QjtRQUM1RCw4QkFBOEIsRUFBRSwrQkFBK0I7S0FDaEUsQ0FBQztJQUVGLElBQUksQ0FBQztRQUNILDJFQUEyRTtRQUMzRSxNQUFNLE1BQU0sR0FBSSxLQUFLLENBQUMsY0FBc0IsRUFBRSxJQUFJLEVBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUM7UUFDL0UsTUFBTSxZQUFZLEdBQUcsS0FBSyxDQUFDLGNBQWMsRUFBRSxhQUFhLENBQUM7UUFDekQsTUFBTSxJQUFJLEdBQUksS0FBYSxDQUFDLE9BQU8sSUFBSSxL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QUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFO1FBQzFFLFVBQVUsRUFBRSxlQUFlO1FBQzNCLGFBQWEsRUFBRSxvQkFBb0I7UUFDbkMsVUFBVSxFQUFFLGVBQWU7UUFDM0IsU0FBUyxFQUFFLElBQUksQ0FBQyxHQUFHLEVBQUU7UUFDckIsSUFBSSxFQUFFO1lBQ0osb0JBQW9CO1lBQ3BCLGlCQUFpQixFQUFFLGVBQWU7WUFDbEMsb0JBQW9CO1lBQ3BCLGlCQUFpQixFQUFFLGVBQWU7WUFDbEMsa0JBQWtCLEVBQUUsZUFBZTtTQUNwQztLQUNGLENBQUM7SUFFRixJQUFJLENBQUM7UUFDSCxNQUFNLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSx5QkFBVSxDQUFDO1lBQ2xDLFNBQVMsRUFBRSxjQUFjO1lBQ3pCLElBQUksRUFBRSxhQUFhO1NBQ3BCLENBQUMsQ0FBQyxDQUFDO0lBQ04sQ0FBQztJQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7UUFDYix1REFBdUQ7UUFDdkQsT0FBTyxDQUFDLEtBQUssQ0FBQywrQkFBK0IsRUFBRSxHQUFHLENBQUMsQ0FBQztJQUN0RCxDQUFDO0lBRUQsT0FBTztRQUNMLFVBQVUsRUFBRSxHQUFHO1FBQ2YsT0FBTztRQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDO1lBQ25CLE9BQU8sRUFBRSw2QkFBNkI7WUFDdEMsb0JBQW9CO1lBQ3BCLGlCQUFpQixFQUFFLGVBQWU7WUFDbEMsa0JBQWtCLEVBQUUsQ0FBQyxlQUFlLEVBQUUsR0FBRyxlQUFlLENBQUM7WUFDekQscUJBQXFCLEVBQUUsb0JBQW9CO1lBQzNDLGtCQUFrQixFQUFFLGVBQWU7U0FDcEMsQ0FBQztLQUNILENBQUM7QUFDSixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBEZXZpY2VzIEFQSSBMYW1iZGFcbiAqXG4gKiBIYW5kbGVzIGRldmljZSBDUlVEIG9wZXJhdGlvbnM6XG4gKiAtIEdFVCAvZGV2aWNlcyAtIExpc3QgYWxsIGRldmljZXNcbiAqIC0gR0VUIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfSAtIEdldCBkZXZpY2UgZGV0YWlsc1xuICogLSBQQVRDSCAvZGV2aWNlcy97c2VyaWFsX251bWJlcn0gLSBVcGRhdGUgZGV2aWNlIG1ldGFkYXRhXG4gKi9cblxuaW1wb3J0IHsgRHluYW1vREJDbGllbnQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtZHluYW1vZGInO1xuaW1wb3J0IHtcbiAgRHluYW1vREJEb2N1bWVudENsaWVudCxcbiAgU2NhbkNvbW1hbmQsXG4gIFF1ZXJ5Q29tbWFuZCxcbiAgR2V0Q29tbWFuZCxcbiAgVXBkYXRlQ29tbWFuZCxcbiAgRGVsZXRlQ29tbWFuZCxcbiAgUHV0Q29tbWFuZCxcbn0gZnJvbSAnQGF3cy1zZGsvbGliLWR5bmFtb2RiJztcbmltcG9ydCB7IEFQSUdhdGV3YXlQcm94eUV2ZW50LCBBUElHYXRld2F5UHJveHlSZXN1bHQgfSBmcm9tICdhd3MtbGFtYmRhJztcbmltcG9ydCB7IHJlc29sdmVEZXZpY2UsIGdldEFsaWFzQnlTZXJpYWwgfSBmcm9tICcuLi9zaGFyZWQvZGV2aWNlLWxvb2t1cCc7XG5cbmNvbnN0IGRkYkNsaWVudCA9IG5ldyBEeW5hbW9EQkNsaWVudCh7fSk7XG5jb25zdCBkb2NDbGllbnQgPSBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LmZyb20oZGRiQ2xpZW50KTtcblxuY29uc3QgREVWSUNFU19UQUJMRSA9IHByb2Nlc3MuZW52LkRFVklDRVNfVEFCTEUhO1xuY29uc3QgREVWSUNFX0FMSUFTRVNfVEFCTEUgPSBwcm9jZXNzLmVudi5ERVZJQ0VfQUxJQVNFU19UQUJMRSB8fCAnc29uZ2JpcmQtZGV2aWNlLWFsaWFzZXMnO1xuY29uc3QgQUNUSVZJVFlfVEFCTEUgPSBwcm9jZXNzLmVudi5BQ1RJVklUWV9UQUJMRSB8fCAnc29uZ2JpcmQtYWN0aXZpdHknO1xuXG5leHBvcnQgY29uc3QgaGFuZGxlciA9IGFzeW5jIChldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQpOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4gPT4ge1xuICBjb25zb2xlLmxvZygnUmVxdWVzdDonLCBKU09OLnN0cmluZ2lmeShldmVudCkpO1xuXG4gIGNvbnN0IGNvcnNIZWFkZXJzID0ge1xuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nOiAnKicsXG4gICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnMnOiAnQ29udGVudC1UeXBlLEF1dGhvcml6YXRpb24nLFxuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzJzogJ0dFVCxQT1NULFBBVENILERFTEVURSxPUFRJT05TJyxcbiAgfTtcblxuICB0cnkge1xuICAgIC8vIEhUVFAgQVBJIHYyIHVzZXMgcmVxdWVzdENvbnRleHQuaHR0cC5tZXRob2QsIFJFU1QgQVBJIHYxIHVzZXMgaHR0cE1ldGhvZFxuICAgIGNvbnN0IG1ldGhvZCA9IChldmVudC5yZXF1ZXN0Q29udGV4dCBhcyBhbnkpPy5odHRwPy5tZXRob2QgfHwgZXZlbnQuaHR0cE1ldGhvZDtcbiAgICBjb25zdCBzZXJpYWxOdW1iZXIgPSBldmVudC5wYXRoUGFyYW1ldGVycz8uc2VyaWFsX251bWJlcjtcbiAgICBjb25zdCBwYXRoID0gKGV2ZW50IGFzIGFueSkucmF3UGF0aCB8fCBldmVudC5wYXRoIHx8ICcnO1xuXG4gICAgaWYgKG1ldGhvZCA9PT0gJ09QVElPTlMnKSB7XG4gICAgICByZXR1cm4geyBzdGF0dXNDb2RlOiAyMDAsIGhlYWRlcnM6IGNvcnNIZWFkZXJzLCBib2R5OiAnJyB9O1xuICAgIH1cblxuICAgIC8vIFBPU1QgL2RldmljZXMvbWVyZ2UgLSBNZXJnZSB0d28gZGV2aWNlcyAoQWRtaW4gb25seSlcbiAgICBpZiAobWV0aG9kID09PSAnUE9TVCcgJiYgcGF0aC5lbmRzV2l0aCgnL21lcmdlJykpIHtcbiAgICAgIHJldHVybiBhd2FpdCBtZXJnZURldmljZXMoZXZlbnQsIGNvcnNIZWFkZXJzKTtcbiAgICB9XG5cbiAgICBpZiAobWV0aG9kID09PSAnR0VUJyAmJiAhc2VyaWFsTnVtYmVyKSB7XG4gICAgICAvLyBMaXN0IGRldmljZXNcbiAgICAgIHJldHVybiBhd2FpdCBsaXN0RGV2aWNlcyhldmVudCwgY29yc0hlYWRlcnMpO1xuICAgIH1cblxuICAgIGlmIChtZXRob2QgPT09ICdHRVQnICYmIHNlcmlhbE51bWJlcikge1xuICAgICAgLy8gR2V0IHNpbmdsZSBkZXZpY2UgYnkgc2VyaWFsIG51bWJlclxuICAgICAgcmV0dXJuIGF3YWl0IGdldERldmljZUJ5U2VyaWFsKHNlcmlhbE51bWJlciwgY29yc0hlYWRlcnMpO1xuICAgIH1cblxuICAgIGlmIChtZXRob2QgPT09ICdQQVRDSCcgJiYgc2VyaWFsTnVtYmVyKSB7XG4gICAgICAvLyBVcGRhdGUgZGV2aWNlIGJ5IHNlcmlhbCBudW1iZXJcbiAgICAgIHJldHVybiBhd2FpdCB1cGRhdGVEZXZpY2VCeVNlcmlhbChzZXJpYWxOdW1iZXIsIGV2ZW50LmJvZHksIGNvcnNIZWFkZXJzKTtcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA1LFxuICAgICAgaGVhZGVyczogY29yc0hlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnTWV0aG9kIG5vdCBhbGxvd2VkJyB9KSxcbiAgICB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yOicsIGVycm9yKTtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNTAwLFxuICAgICAgaGVhZGVyczogY29yc0hlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnSW50ZXJuYWwgc2VydmVyIGVycm9yJyB9KSxcbiAgICB9O1xuICB9XG59O1xuXG5hc3luYyBmdW5jdGlvbiBsaXN0RGV2aWNlcyhcbiAgZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50LFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICBjb25zdCBxdWVyeVBhcmFtcyA9IGV2ZW50LnF1ZXJ5U3RyaW5nUGFyYW1ldGVycyB8fCB7fTtcbiAgY29uc3QgZmxlZXQgPSBxdWVyeVBhcmFtcy5mbGVldDtcbiAgY29uc3Qgc3RhdHVzID0gcXVlcnlQYXJhbXMuc3RhdHVzO1xuICBjb25zdCBsaW1pdCA9IHBhcnNlSW50KHF1ZXJ5UGFyYW1zLmxpbWl0IHx8ICcxMDAnKTtcblxuICBsZXQgaXRlbXM6IGFueVtdID0gW107XG5cbiAgaWYgKGZsZWV0KSB7XG4gICAgLy8gUXVlcnkgYnkgZmxlZXQgdXNpbmcgR1NJXG4gICAgY29uc3QgY29tbWFuZCA9IG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgICAgSW5kZXhOYW1lOiAnZmxlZXQtaW5kZXgnLFxuICAgICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJyNmbGVldCA9IDpmbGVldCcsXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHsgJyNmbGVldCc6ICdmbGVldCcgfSxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHsgJzpmbGVldCc6IGZsZWV0IH0sXG4gICAgICBMaW1pdDogbGltaXQsXG4gICAgICBTY2FuSW5kZXhGb3J3YXJkOiBmYWxzZSwgLy8gTW9zdCByZWNlbnQgZmlyc3RcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICAgIGl0ZW1zID0gcmVzdWx0Lkl0ZW1zIHx8IFtdO1xuICB9IGVsc2UgaWYgKHN0YXR1cykge1xuICAgIC8vIFF1ZXJ5IGJ5IHN0YXR1cyB1c2luZyBHU0lcbiAgICBjb25zdCBjb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IERFVklDRVNfVEFCTEUsXG4gICAgICBJbmRleE5hbWU6ICdzdGF0dXMtaW5kZXgnLFxuICAgICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJyNzdGF0dXMgPSA6c3RhdHVzJyxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczogeyAnI3N0YXR1cyc6ICdzdGF0dXMnIH0sXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7ICc6c3RhdHVzJzogc3RhdHVzIH0sXG4gICAgICBMaW1pdDogbGltaXQsXG4gICAgICBTY2FuSW5kZXhGb3J3YXJkOiBmYWxzZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICAgIGl0ZW1zID0gcmVzdWx0Lkl0ZW1zIHx8IFtdO1xuICB9IGVsc2Uge1xuICAgIC8vIFNjYW4gYWxsIGRldmljZXMgKGZvciBzbWFsbCBmbGVldHMpXG4gICAgY29uc3QgY29tbWFuZCA9IG5ldyBTY2FuQ29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IERFVklDRVNfVEFCTEUsXG4gICAgICBMaW1pdDogbGltaXQsXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgICBpdGVtcyA9IHJlc3VsdC5JdGVtcyB8fCBbXTtcbiAgfVxuXG4gIC8vIFRyYW5zZm9ybSBhbmQgY2FsY3VsYXRlIGZsZWV0IHN0YXRzXG4gIGNvbnN0IHRyYW5zZm9ybWVkRGV2aWNlcyA9IGl0ZW1zLm1hcCh0cmFuc2Zvcm1EZXZpY2UpO1xuICBjb25zdCBzdGF0cyA9IGNhbGN1bGF0ZVN0YXRzKGl0ZW1zKTtcblxuICByZXR1cm4ge1xuICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICBoZWFkZXJzLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIGRldmljZXM6IHRyYW5zZm9ybWVkRGV2aWNlcyxcbiAgICAgIGNvdW50OiB0cmFuc2Zvcm1lZERldmljZXMubGVuZ3RoLFxuICAgICAgc3RhdHMsXG4gICAgfSksXG4gIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldERldmljZUJ5U2VyaWFsKFxuICBzZXJpYWxOdW1iZXI6IHN0cmluZyxcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgLy8gUmVzb2x2ZSBzZXJpYWxfbnVtYmVyIHRvIGRldmljZSBpbmZvXG4gIGNvbnN0IHJlc29sdmVkID0gYXdhaXQgcmVzb2x2ZURldmljZShzZXJpYWxOdW1iZXIpO1xuXG4gIGlmICghcmVzb2x2ZWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdEZXZpY2Ugbm90IGZvdW5kJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gR2V0IHRoZSBkZXZpY2UgdXNpbmcgdGhlIGN1cnJlbnQgZGV2aWNlX3VpZFxuICBjb25zdCBjb21tYW5kID0gbmV3IEdldENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICBLZXk6IHsgZGV2aWNlX3VpZDogcmVzb2x2ZWQuZGV2aWNlX3VpZCB9LFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcblxuICBpZiAoIXJlc3VsdC5JdGVtKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwNCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRGV2aWNlIG5vdCBmb3VuZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8vIFRyYW5zZm9ybSBhbmQgYWRkIGRldmljZV91aWQgaGlzdG9yeVxuICBjb25zdCBkZXZpY2UgPSB0cmFuc2Zvcm1EZXZpY2UocmVzdWx0Lkl0ZW0pO1xuICBkZXZpY2UuZGV2aWNlX3VpZF9oaXN0b3J5ID0gcmVzb2x2ZWQuYWxsX2RldmljZV91aWRzLmxlbmd0aCA+IDFcbiAgICA/IHJlc29sdmVkLmFsbF9kZXZpY2VfdWlkcy5zbGljZSgxKSAvLyBFeGNsdWRlIGN1cnJlbnQgZGV2aWNlX3VpZFxuICAgIDogdW5kZWZpbmVkO1xuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoZGV2aWNlKSxcbiAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gdXBkYXRlRGV2aWNlQnlTZXJpYWwoXG4gIHNlcmlhbE51bWJlcjogc3RyaW5nLFxuICBib2R5OiBzdHJpbmcgfCBudWxsLFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICBpZiAoIWJvZHkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdSZXF1ZXN0IGJvZHkgcmVxdWlyZWQnIH0pLFxuICAgIH07XG4gIH1cblxuICAvLyBSZXNvbHZlIHNlcmlhbF9udW1iZXIgdG8gZGV2aWNlX3VpZFxuICBjb25zdCByZXNvbHZlZCA9IGF3YWl0IHJlc29sdmVEZXZpY2Uoc2VyaWFsTnVtYmVyKTtcblxuICBpZiAoIXJlc29sdmVkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwNCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRGV2aWNlIG5vdCBmb3VuZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHVwZGF0ZXMgPSBKU09OLnBhcnNlKGJvZHkpO1xuXG4gIC8vIE9ubHkgYWxsb3cgY2VydGFpbiBmaWVsZHMgdG8gYmUgdXBkYXRlZCAocmVtb3ZlZCBzZXJpYWxfbnVtYmVyIC0gaXQncyBub3cgaW1tdXRhYmxlKVxuICBjb25zdCBhbGxvd2VkRmllbGRzID0gWyduYW1lJywgJ2Fzc2lnbmVkX3RvJywgJ2Fzc2lnbmVkX3RvX25hbWUnLCAnZmxlZXQnLCAnbm90ZXMnXTtcbiAgY29uc3QgdXBkYXRlRXhwcmVzc2lvbnM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICBjb25zdCBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge307XG5cbiAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXModXBkYXRlcykpIHtcbiAgICBpZiAoYWxsb3dlZEZpZWxkcy5pbmNsdWRlcyhrZXkpKSB7XG4gICAgICBjb25zdCBhdHRyTmFtZSA9IGAjJHtrZXl9YDtcbiAgICAgIGNvbnN0IGF0dHJWYWx1ZSA9IGA6JHtrZXl9YDtcbiAgICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goYCR7YXR0ck5hbWV9ID0gJHthdHRyVmFsdWV9YCk7XG4gICAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbYXR0ck5hbWVdID0ga2V5O1xuICAgICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1thdHRyVmFsdWVdID0gdmFsdWU7XG4gICAgfVxuICB9XG5cbiAgaWYgKHVwZGF0ZUV4cHJlc3Npb25zLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ05vIHZhbGlkIGZpZWxkcyB0byB1cGRhdGUnIH0pLFxuICAgIH07XG4gIH1cblxuICAvLyBBbHdheXMgdXBkYXRlIHVwZGF0ZWRfYXRcbiAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3VwZGF0ZWRfYXQgPSA6dXBkYXRlZF9hdCcpO1xuICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyN1cGRhdGVkX2F0J10gPSAndXBkYXRlZF9hdCc7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzp1cGRhdGVkX2F0J10gPSBEYXRlLm5vdygpO1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgVXBkYXRlQ29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgIEtleTogeyBkZXZpY2VfdWlkOiByZXNvbHZlZC5kZXZpY2VfdWlkIH0sXG4gICAgVXBkYXRlRXhwcmVzc2lvbjogJ1NFVCAnICsgdXBkYXRlRXhwcmVzc2lvbnMuam9pbignLCAnKSxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lcyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzLFxuICAgIFJldHVyblZhbHVlczogJ0FMTF9ORVcnLFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcblxuICByZXR1cm4ge1xuICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICBoZWFkZXJzLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHRyYW5zZm9ybURldmljZShyZXN1bHQuQXR0cmlidXRlcykpLFxuICB9O1xufVxuXG4vKipcbiAqIENhbGN1bGF0ZSBkZXZpY2Ugc3RhdHVzIGJhc2VkIG9uIGxhc3Rfc2VlbiB0aW1lc3RhbXBcbiAqIE9ubGluZSBpZiBzZWVuIHdpdGhpbiAxNSBtaW51dGVzLCBvZmZsaW5lIG90aGVyd2lzZVxuICovXG5mdW5jdGlvbiBjYWxjdWxhdGVEZXZpY2VTdGF0dXMoaXRlbTogYW55KTogc3RyaW5nIHtcbiAgaWYgKGl0ZW0uc3RhdHVzID09PSAnYWxlcnQnKSB7XG4gICAgcmV0dXJuICdhbGVydCc7XG4gIH1cbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgY29uc3Qgb2ZmbGluZVRocmVzaG9sZCA9IDE1ICogNjAgKiAxMDAwOyAvLyAxNSBtaW51dGVzXG4gIGlmIChpdGVtLmxhc3Rfc2VlbiAmJiBub3cgLSBpdGVtLmxhc3Rfc2VlbiA8IG9mZmxpbmVUaHJlc2hvbGQpIHtcbiAgICByZXR1cm4gJ29ubGluZSc7XG4gIH1cbiAgcmV0dXJuICdvZmZsaW5lJztcbn1cblxuLyoqXG4gKiBUcmFuc2Zvcm0gRHluYW1vREIgZGV2aWNlIHJlY29yZCB0byBmcm9udGVuZCBmb3JtYXRcbiAqIEZsYXR0ZW5zIG5lc3RlZCBvYmplY3RzIGxpa2UgbGFzdF9sb2NhdGlvbiBhbmQgbGFzdF90ZWxlbWV0cnlcbiAqL1xuZnVuY3Rpb24gdHJhbnNmb3JtRGV2aWNlKGl0ZW06IGFueSk6IGFueSB7XG4gIGNvbnN0IGRldmljZTogYW55ID0ge1xuICAgIGRldmljZV91aWQ6IGl0ZW0uZGV2aWNlX3VpZCxcbiAgICBzZXJpYWxfbnVtYmVyOiBpdGVtLnNlcmlhbF9udW1iZXIsXG4gICAgbmFtZTogaXRlbS5uYW1lLFxuICAgIGZsZWV0OiBpdGVtLmZsZWV0LFxuICAgIHN0YXR1czogY2FsY3VsYXRlRGV2aWNlU3RhdHVzKGl0ZW0pLFxuICAgIC8vIENvbnZlcnQgbWlsbGlzZWNvbmQgdGltZXN0YW1wIHRvIElTTyBzdHJpbmcgZm9yIGZyb250ZW5kXG4gICAgbGFzdF9zZWVuOiBpdGVtLmxhc3Rfc2VlbiA/IG5ldyBEYXRlKGl0ZW0ubGFzdF9zZWVuKS50b0lTT1N0cmluZygpIDogdW5kZWZpbmVkLFxuICAgIG1vZGU6IGl0ZW0uY3VycmVudF9tb2RlLFxuICAgIHRyYW5zaXRfbG9ja2VkOiBpdGVtLnRyYW5zaXRfbG9ja2VkIHx8IGZhbHNlLFxuICAgIGRlbW9fbG9ja2VkOiBpdGVtLmRlbW9fbG9ja2VkIHx8IGZhbHNlLFxuICAgIGdwc19wb3dlcl9zYXZpbmc6IGl0ZW0uZ3BzX3Bvd2VyX3NhdmluZyB8fCBmYWxzZSxcbiAgICBncHNfbm9fc2F0OiBpdGVtLmdwc19ub19zYXQgfHwgZmFsc2UsXG4gICAgdXNiX3Bvd2VyZWQ6IGl0ZW0udXNiX3Bvd2VyZWQgfHwgZmFsc2UsXG4gICAgY3JlYXRlZF9hdDogaXRlbS5jcmVhdGVkX2F0ID8gbmV3IERhdGUoaXRlbS5jcmVhdGVkX2F0KS50b0lTT1N0cmluZygpIDogdW5kZWZpbmVkLFxuICAgIHVwZGF0ZWRfYXQ6IGl0ZW0udXBkYXRlZF9hdCA/IG5ldyBEYXRlKGl0ZW0udXBkYXRlZF9hdCkudG9JU09TdHJpbmcoKSA6IHVuZGVmaW5lZCxcbiAgICBhc3NpZ25lZF90bzogaXRlbS5hc3NpZ25lZF90byxcbiAgICBhc3NpZ25lZF90b19uYW1lOiBpdGVtLmFzc2lnbmVkX3RvX25hbWUsXG4gIH07XG5cbiAgLy8gRmxhdHRlbiBsYXN0X2xvY2F0aW9uXG4gIGlmIChpdGVtLmxhc3RfbG9jYXRpb24pIHtcbiAgICBkZXZpY2UubGF0aXR1ZGUgPSBpdGVtLmxhc3RfbG9jYXRpb24ubGF0O1xuICAgIGRldmljZS5sb25naXR1ZGUgPSBpdGVtLmxhc3RfbG9jYXRpb24ubG9uO1xuICAgIC8vIENvbnZlcnQgVW5peCB0aW1lc3RhbXAgKHNlY29uZHMpIHRvIElTTyBzdHJpbmcgZm9yIGZyb250ZW5kXG4gICAgaWYgKGl0ZW0ubGFzdF9sb2NhdGlvbi50aW1lKSB7XG4gICAgICAvLyBOb3RlaHViIHRpbWVzdGFtcHMgYXJlIGluIHNlY29uZHMsIGNvbnZlcnQgdG8gbWlsbGlzZWNvbmRzIGZvciBEYXRlXG4gICAgICBjb25zdCB0aW1lTXMgPSBpdGVtLmxhc3RfbG9jYXRpb24udGltZSAqIDEwMDA7XG4gICAgICBkZXZpY2UubG9jYXRpb25fdGltZSA9IG5ldyBEYXRlKHRpbWVNcykudG9JU09TdHJpbmcoKTtcbiAgICB9XG4gICAgZGV2aWNlLmxvY2F0aW9uX3NvdXJjZSA9IGl0ZW0ubGFzdF9sb2NhdGlvbi5zb3VyY2U7XG4gICAgZGV2aWNlLmxvY2F0aW9uX25hbWUgPSBpdGVtLmxhc3RfbG9jYXRpb24ubmFtZTtcbiAgfVxuXG4gIC8vIEZsYXR0ZW4gbGFzdF90ZWxlbWV0cnlcbiAgaWYgKGl0ZW0ubGFzdF90ZWxlbWV0cnkpIHtcbiAgICBkZXZpY2UudGVtcGVyYXR1cmUgPSBpdGVtLmxhc3RfdGVsZW1ldHJ5LnRlbXA7XG4gICAgZGV2aWNlLmh1bWlkaXR5ID0gaXRlbS5sYXN0X3RlbGVtZXRyeS5odW1pZGl0eTtcbiAgICBkZXZpY2UucHJlc3N1cmUgPSBpdGVtLmxhc3RfdGVsZW1ldHJ5LnByZXNzdXJlO1xuICAgIC8vIE5vdGU6IHZvbHRhZ2Ugbm8gbG9uZ2VyIGNvbWVzIGZyb20gbGFzdF90ZWxlbWV0cnk7IGl0J3Mgc2V0IGZyb20gX2xvZy5xby9faGVhbHRoLnFvXG4gICAgZGV2aWNlLm1vdGlvbiA9IGl0ZW0ubGFzdF90ZWxlbWV0cnkubW90aW9uO1xuICB9XG5cbiAgLy8gVm9sdGFnZSBjb21lcyBmcm9tIGRldmljZS52b2x0YWdlIGZpZWxkIChzZXQgZnJvbSBfbG9nLnFvIG9yIF9oZWFsdGgucW8gZXZlbnRzKVxuICBpZiAoaXRlbS52b2x0YWdlICE9PSB1bmRlZmluZWQpIHtcbiAgICBkZXZpY2Uudm9sdGFnZSA9IGl0ZW0udm9sdGFnZTtcbiAgfVxuXG4gIC8vIEZsYXR0ZW4gbGFzdF9wb3dlciAoTW9qbyBkYXRhKVxuICBpZiAoaXRlbS5sYXN0X3Bvd2VyKSB7XG4gICAgZGV2aWNlLm1vam9fdm9sdGFnZSA9IGl0ZW0ubGFzdF9wb3dlci52b2x0YWdlO1xuICAgIGRldmljZS5tb2pvX3RlbXBlcmF0dXJlID0gaXRlbS5sYXN0X3Bvd2VyLnRlbXBlcmF0dXJlO1xuICAgIGRldmljZS5taWxsaWFtcF9ob3VycyA9IGl0ZW0ubGFzdF9wb3dlci5taWxsaWFtcF9ob3VycztcbiAgfVxuXG4gIC8vIEZpcm13YXJlIHZlcnNpb25zIChmcm9tIF9zZXNzaW9uLnFvIGV2ZW50cylcbiAgaWYgKGl0ZW0uZmlybXdhcmVfdmVyc2lvbikge1xuICAgIGRldmljZS5maXJtd2FyZV92ZXJzaW9uID0gaXRlbS5maXJtd2FyZV92ZXJzaW9uO1xuICB9XG4gIGlmIChpdGVtLm5vdGVjYXJkX3ZlcnNpb24pIHtcbiAgICBkZXZpY2Uubm90ZWNhcmRfdmVyc2lvbiA9IGl0ZW0ubm90ZWNhcmRfdmVyc2lvbjtcbiAgfVxuICBpZiAoaXRlbS5ub3RlY2FyZF9za3UpIHtcbiAgICBkZXZpY2Uubm90ZWNhcmRfc2t1ID0gaXRlbS5ub3RlY2FyZF9za3U7XG4gIH1cblxuICByZXR1cm4gZGV2aWNlO1xufVxuXG5mdW5jdGlvbiBjYWxjdWxhdGVTdGF0cyhkZXZpY2VzOiBhbnlbXSk6IFJlY29yZDxzdHJpbmcsIGFueT4ge1xuICBjb25zdCBzdGF0cyA9IHtcbiAgICB0b3RhbDogZGV2aWNlcy5sZW5ndGgsXG4gICAgb25saW5lOiAwLFxuICAgIG9mZmxpbmU6IDAsXG4gICAgYWxlcnQ6IDAsXG4gICAgbG93X2JhdHRlcnk6IDAsXG4gICAgZmxlZXRzOiB7fSBhcyBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+LFxuICB9O1xuXG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGNvbnN0IG9mZmxpbmVUaHJlc2hvbGQgPSAxNSAqIDYwICogMTAwMDsgLy8gMTUgbWludXRlc1xuXG4gIGZvciAoY29uc3QgZGV2aWNlIG9mIGRldmljZXMpIHtcbiAgICAvLyBTdGF0dXMgY291bnRzXG4gICAgaWYgKGRldmljZS5zdGF0dXMgPT09ICdhbGVydCcpIHtcbiAgICAgIHN0YXRzLmFsZXJ0Kys7XG4gICAgfSBlbHNlIGlmIChkZXZpY2UubGFzdF9zZWVuICYmIG5vdyAtIGRldmljZS5sYXN0X3NlZW4gPCBvZmZsaW5lVGhyZXNob2xkKSB7XG4gICAgICBzdGF0cy5vbmxpbmUrKztcbiAgICB9IGVsc2Uge1xuICAgICAgc3RhdHMub2ZmbGluZSsrO1xuICAgIH1cblxuICAgIC8vIExvdyBiYXR0ZXJ5IGNoZWNrICh2b2x0YWdlIGNvbWVzIGZyb20gX2xvZy5xby9faGVhbHRoLnFvLCBzdG9yZWQgaW4gZGV2aWNlLnZvbHRhZ2UpXG4gICAgaWYgKGRldmljZS52b2x0YWdlICYmIGRldmljZS52b2x0YWdlIDwgMy40KSB7XG4gICAgICBzdGF0cy5sb3dfYmF0dGVyeSsrO1xuICAgIH1cblxuICAgIC8vIEZsZWV0IGNvdW50c1xuICAgIGNvbnN0IGZsZWV0ID0gZGV2aWNlLmZsZWV0IHx8ICdkZWZhdWx0JztcbiAgICBzdGF0cy5mbGVldHNbZmxlZXRdID0gKHN0YXRzLmZsZWV0c1tmbGVldF0gfHwgMCkgKyAxO1xuICB9XG5cbiAgcmV0dXJuIHN0YXRzO1xufVxuXG4vKipcbiAqIE1lcmdlIHR3byBkZXZpY2VzIGludG8gb25lIChBZG1pbiBvbmx5KVxuICogVGhlIHNvdXJjZSBkZXZpY2UncyBkZXZpY2VfdWlkIGlzIGFkZGVkIHRvIHRoZSB0YXJnZXQncyBhbGlhcyBoaXN0b3J5LFxuICogYW5kIHRoZSBzb3VyY2UgZGV2aWNlIHJlY29yZCBpcyBkZWxldGVkLlxuICovXG5hc3luYyBmdW5jdGlvbiBtZXJnZURldmljZXMoXG4gIGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudCxcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgLy8gQ2hlY2sgZm9yIGFkbWluIGF1dGhvcml6YXRpb25cbiAgY29uc3QgY2xhaW1zID0gKGV2ZW50LnJlcXVlc3RDb250ZXh0IGFzIGFueSk/LmF1dGhvcml6ZXI/Lmp3dD8uY2xhaW1zIHx8IHt9O1xuICBjb25zdCBncm91cHMgPSBjbGFpbXNbJ2NvZ25pdG86Z3JvdXBzJ10gfHwgJyc7XG4gIGNvbnN0IGlzQWRtaW4gPSBncm91cHMuaW5jbHVkZXMoJ0FkbWluJyk7XG5cbiAgaWYgKCFpc0FkbWluKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwMyxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnQWRtaW4gYWNjZXNzIHJlcXVpcmVkIHRvIG1lcmdlIGRldmljZXMnIH0pLFxuICAgIH07XG4gIH1cblxuICBpZiAoIWV2ZW50LmJvZHkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdSZXF1ZXN0IGJvZHkgcmVxdWlyZWQnIH0pLFxuICAgIH07XG4gIH1cblxuICBjb25zdCB7IHNvdXJjZV9zZXJpYWxfbnVtYmVyLCB0YXJnZXRfc2VyaWFsX251bWJlciB9ID0gSlNPTi5wYXJzZShldmVudC5ib2R5KTtcblxuICBpZiAoIXNvdXJjZV9zZXJpYWxfbnVtYmVyIHx8ICF0YXJnZXRfc2VyaWFsX251bWJlcikge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0JvdGggc291cmNlX3NlcmlhbF9udW1iZXIgYW5kIHRhcmdldF9zZXJpYWxfbnVtYmVyIGFyZSByZXF1aXJlZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIGlmIChzb3VyY2Vfc2VyaWFsX251bWJlciA9PT0gdGFyZ2V0X3NlcmlhbF9udW1iZXIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdTb3VyY2UgYW5kIHRhcmdldCBjYW5ub3QgYmUgdGhlIHNhbWUgZGV2aWNlJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gR2V0IGJvdGggZGV2aWNlc1xuICBjb25zdCBzb3VyY2VBbGlhcyA9IGF3YWl0IGdldEFsaWFzQnlTZXJpYWwoc291cmNlX3NlcmlhbF9udW1iZXIpO1xuICBjb25zdCB0YXJnZXRBbGlhcyA9IGF3YWl0IGdldEFsaWFzQnlTZXJpYWwodGFyZ2V0X3NlcmlhbF9udW1iZXIpO1xuXG4gIGlmICghc291cmNlQWxpYXMpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6IGBTb3VyY2UgZGV2aWNlIG5vdCBmb3VuZDogJHtzb3VyY2Vfc2VyaWFsX251bWJlcn1gIH0pLFxuICAgIH07XG4gIH1cblxuICBpZiAoIXRhcmdldEFsaWFzKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwNCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBgVGFyZ2V0IGRldmljZSBub3QgZm91bmQ6ICR7dGFyZ2V0X3NlcmlhbF9udW1iZXJ9YCB9KSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3Qgc291cmNlRGV2aWNlVWlkID0gc291cmNlQWxpYXMuZGV2aWNlX3VpZDtcbiAgY29uc3QgdGFyZ2V0RGV2aWNlVWlkID0gdGFyZ2V0QWxpYXMuZGV2aWNlX3VpZDtcbiAgY29uc3Qgc291cmNlUHJldmlvdXNVaWRzID0gc291cmNlQWxpYXMucHJldmlvdXNfZGV2aWNlX3VpZHMgfHwgW107XG4gIGNvbnN0IHRhcmdldFByZXZpb3VzVWlkcyA9IHRhcmdldEFsaWFzLnByZXZpb3VzX2RldmljZV91aWRzIHx8IFtdO1xuXG4gIC8vIE1lcmdlIGFsbCBkZXZpY2VfdWlkczogdGFyZ2V0J3MgcHJldmlvdXMgKyBzb3VyY2UncyBjdXJyZW50ICsgc291cmNlJ3MgcHJldmlvdXNcbiAgY29uc3QgYWxsUHJldmlvdXNVaWRzID0gW1xuICAgIC4uLm5ldyBTZXQoW1xuICAgICAgLi4udGFyZ2V0UHJldmlvdXNVaWRzLFxuICAgICAgc291cmNlRGV2aWNlVWlkLFxuICAgICAgLi4uc291cmNlUHJldmlvdXNVaWRzLFxuICAgIF0pLFxuICBdO1xuXG4gIC8vIFVwZGF0ZSB0YXJnZXQgYWxpYXMgdG8gaW5jbHVkZSBzb3VyY2UgZGV2aWNlX3VpZHNcbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IFB1dENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogREVWSUNFX0FMSUFTRVNfVEFCTEUsXG4gICAgSXRlbToge1xuICAgICAgc2VyaWFsX251bWJlcjogdGFyZ2V0X3NlcmlhbF9udW1iZXIsXG4gICAgICBkZXZpY2VfdWlkOiB0YXJnZXREZXZpY2VVaWQsXG4gICAgICBwcmV2aW91c19kZXZpY2VfdWlkczogYWxsUHJldmlvdXNVaWRzLFxuICAgICAgY3JlYXRlZF9hdDogdGFyZ2V0QWxpYXMuY3JlYXRlZF9hdCxcbiAgICAgIHVwZGF0ZWRfYXQ6IERhdGUubm93KCksXG4gICAgfSxcbiAgfSkpO1xuXG4gIC8vIERlbGV0ZSBzb3VyY2UgYWxpYXNcbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IERlbGV0ZUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogREVWSUNFX0FMSUFTRVNfVEFCTEUsXG4gICAgS2V5OiB7IHNlcmlhbF9udW1iZXI6IHNvdXJjZV9zZXJpYWxfbnVtYmVyIH0sXG4gIH0pKTtcblxuICAvLyBEZWxldGUgc291cmNlIGRldmljZSByZWNvcmRcbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IERlbGV0ZUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICBLZXk6IHsgZGV2aWNlX3VpZDogc291cmNlRGV2aWNlVWlkIH0sXG4gIH0pKTtcblxuICAvLyBDcmVhdGUgYWN0aXZpdHkgZmVlZCBldmVudFxuICBjb25zdCBhY3Rpdml0eUV2ZW50ID0ge1xuICAgIGV2ZW50X2lkOiBgbWVyZ2UtJHtEYXRlLm5vdygpfS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnN1YnN0cmluZyg3KX1gLFxuICAgIGRldmljZV91aWQ6IHRhcmdldERldmljZVVpZCxcbiAgICBzZXJpYWxfbnVtYmVyOiB0YXJnZXRfc2VyaWFsX251bWJlcixcbiAgICBldmVudF90eXBlOiAnZGV2aWNlX21lcmdlZCcsXG4gICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgIGRhdGE6IHtcbiAgICAgIHNvdXJjZV9zZXJpYWxfbnVtYmVyLFxuICAgICAgc291cmNlX2RldmljZV91aWQ6IHNvdXJjZURldmljZVVpZCxcbiAgICAgIHRhcmdldF9zZXJpYWxfbnVtYmVyLFxuICAgICAgdGFyZ2V0X2RldmljZV91aWQ6IHRhcmdldERldmljZVVpZCxcbiAgICAgIG1lcmdlZF9kZXZpY2VfdWlkczogYWxsUHJldmlvdXNVaWRzLFxuICAgIH0sXG4gIH07XG5cbiAgdHJ5IHtcbiAgICBhd2FpdCBkb2NDbGllbnQuc2VuZChuZXcgUHV0Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IEFDVElWSVRZX1RBQkxFLFxuICAgICAgSXRlbTogYWN0aXZpdHlFdmVudCxcbiAgICB9KSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIEFjdGl2aXR5IGxvZ2dpbmcgaXMgbm9uLWNyaXRpY2FsLCBsb2cgYnV0IGRvbid0IGZhaWxcbiAgICBjb25zb2xlLmVycm9yKCdGYWlsZWQgdG8gbG9nIG1lcmdlIGFjdGl2aXR5OicsIGVycik7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICBoZWFkZXJzLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIG1lc3NhZ2U6ICdEZXZpY2VzIG1lcmdlZCBzdWNjZXNzZnVsbHknLFxuICAgICAgdGFyZ2V0X3NlcmlhbF9udW1iZXIsXG4gICAgICB0YXJnZXRfZGV2aWNlX3VpZDogdGFyZ2V0RGV2aWNlVWlkLFxuICAgICAgbWVyZ2VkX2RldmljZV91aWRzOiBbdGFyZ2V0RGV2aWNlVWlkLCAuLi5hbGxQcmV2aW91c1VpZHNdLFxuICAgICAgZGVsZXRlZF9zZXJpYWxfbnVtYmVyOiBzb3VyY2Vfc2VyaWFsX251bWJlcixcbiAgICAgIGRlbGV0ZWRfZGV2aWNlX3VpZDogc291cmNlRGV2aWNlVWlkLFxuICAgIH0pLFxuICB9O1xufVxuIl19