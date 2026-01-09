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
 * Transform DynamoDB device record to frontend format
 * Flattens nested objects like last_location and last_telemetry
 */
function transformDevice(item) {
    const device = {
        device_uid: item.device_uid,
        serial_number: item.serial_number,
        name: item.name,
        fleet: item.fleet,
        status: item.status,
        // Convert millisecond timestamp to ISO string for frontend
        last_seen: item.last_seen ? new Date(item.last_seen).toISOString() : undefined,
        mode: item.current_mode,
        transit_locked: item.transit_locked || false,
        demo_locked: item.demo_locked || false,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWRldmljZXMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7O0dBT0c7OztBQUVILDhEQUEwRDtBQUMxRCx3REFRK0I7QUFFL0IsMkRBQTBFO0FBRTFFLE1BQU0sU0FBUyxHQUFHLElBQUksZ0NBQWMsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN6QyxNQUFNLFNBQVMsR0FBRyxxQ0FBc0IsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7QUFFekQsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxhQUFjLENBQUM7QUFDakQsTUFBTSxvQkFBb0IsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLG9CQUFvQixJQUFJLHlCQUF5QixDQUFDO0FBQzNGLE1BQU0sY0FBYyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsY0FBYyxJQUFJLG1CQUFtQixDQUFDO0FBRWxFLE1BQU0sT0FBTyxHQUFHLEtBQUssRUFBRSxLQUEyQixFQUFrQyxFQUFFO0lBQzNGLE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUUvQyxNQUFNLFdBQVcsR0FBRztRQUNsQiw2QkFBNkIsRUFBRSxHQUFHO1FBQ2xDLDhCQUE4QixFQUFFLDRCQUE0QjtRQUM1RCw4QkFBOEIsRUFBRSwrQkFBK0I7S0FDaEUsQ0FBQztJQUVGLElBQUksQ0FBQztRQUNILDJFQUEyRTtRQUMzRSxNQUFNLE1BQU0sR0FBSSxLQUFLLENBQUMsY0FBc0IsRUFBRSxJQUFJLEVBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUM7UUFDL0UsTUFBTSxZQUFZLEdBQUcsS0FBSyxDQUFDLGNBQWMsRUFBRSxhQUFhLENBQUM7UUFDekQsTUFBTSxJQUFJLEdBQUksS0FBYSxDQUFDLE9BQU8sSUFBSSxL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RUFBRSxHQUFHLENBQUMsQ0FBQztJQUN0RCxDQUFDO0lBRUQsT0FBTztRQUNMLFVBQVUsRUFBRSxHQUFHO1FBQ2YsT0FBTztRQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDO1lBQ25CLE9BQU8sRUFBRSw2QkFBNkI7WUFDdEMsb0JBQW9CO1lBQ3BCLGlCQUFpQixFQUFFLGVBQWU7WUFDbEMsa0JBQWtCLEVBQUUsQ0FBQyxlQUFlLEVBQUUsR0FBRyxlQUFlLENBQUM7WUFDekQscUJBQXFCLEVBQUUsb0JBQW9CO1lBQzNDLGtCQUFrQixFQUFFLGVBQWU7U0FDcEMsQ0FBQztLQUNILENBQUM7QUFDSixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBEZXZpY2VzIEFQSSBMYW1iZGFcbiAqXG4gKiBIYW5kbGVzIGRldmljZSBDUlVEIG9wZXJhdGlvbnM6XG4gKiAtIEdFVCAvZGV2aWNlcyAtIExpc3QgYWxsIGRldmljZXNcbiAqIC0gR0VUIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfSAtIEdldCBkZXZpY2UgZGV0YWlsc1xuICogLSBQQVRDSCAvZGV2aWNlcy97c2VyaWFsX251bWJlcn0gLSBVcGRhdGUgZGV2aWNlIG1ldGFkYXRhXG4gKi9cblxuaW1wb3J0IHsgRHluYW1vREJDbGllbnQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtZHluYW1vZGInO1xuaW1wb3J0IHtcbiAgRHluYW1vREJEb2N1bWVudENsaWVudCxcbiAgU2NhbkNvbW1hbmQsXG4gIFF1ZXJ5Q29tbWFuZCxcbiAgR2V0Q29tbWFuZCxcbiAgVXBkYXRlQ29tbWFuZCxcbiAgRGVsZXRlQ29tbWFuZCxcbiAgUHV0Q29tbWFuZCxcbn0gZnJvbSAnQGF3cy1zZGsvbGliLWR5bmFtb2RiJztcbmltcG9ydCB7IEFQSUdhdGV3YXlQcm94eUV2ZW50LCBBUElHYXRld2F5UHJveHlSZXN1bHQgfSBmcm9tICdhd3MtbGFtYmRhJztcbmltcG9ydCB7IHJlc29sdmVEZXZpY2UsIGdldEFsaWFzQnlTZXJpYWwgfSBmcm9tICcuLi9zaGFyZWQvZGV2aWNlLWxvb2t1cCc7XG5cbmNvbnN0IGRkYkNsaWVudCA9IG5ldyBEeW5hbW9EQkNsaWVudCh7fSk7XG5jb25zdCBkb2NDbGllbnQgPSBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LmZyb20oZGRiQ2xpZW50KTtcblxuY29uc3QgREVWSUNFU19UQUJMRSA9IHByb2Nlc3MuZW52LkRFVklDRVNfVEFCTEUhO1xuY29uc3QgREVWSUNFX0FMSUFTRVNfVEFCTEUgPSBwcm9jZXNzLmVudi5ERVZJQ0VfQUxJQVNFU19UQUJMRSB8fCAnc29uZ2JpcmQtZGV2aWNlLWFsaWFzZXMnO1xuY29uc3QgQUNUSVZJVFlfVEFCTEUgPSBwcm9jZXNzLmVudi5BQ1RJVklUWV9UQUJMRSB8fCAnc29uZ2JpcmQtYWN0aXZpdHknO1xuXG5leHBvcnQgY29uc3QgaGFuZGxlciA9IGFzeW5jIChldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQpOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4gPT4ge1xuICBjb25zb2xlLmxvZygnUmVxdWVzdDonLCBKU09OLnN0cmluZ2lmeShldmVudCkpO1xuXG4gIGNvbnN0IGNvcnNIZWFkZXJzID0ge1xuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nOiAnKicsXG4gICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnMnOiAnQ29udGVudC1UeXBlLEF1dGhvcml6YXRpb24nLFxuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzJzogJ0dFVCxQT1NULFBBVENILERFTEVURSxPUFRJT05TJyxcbiAgfTtcblxuICB0cnkge1xuICAgIC8vIEhUVFAgQVBJIHYyIHVzZXMgcmVxdWVzdENvbnRleHQuaHR0cC5tZXRob2QsIFJFU1QgQVBJIHYxIHVzZXMgaHR0cE1ldGhvZFxuICAgIGNvbnN0IG1ldGhvZCA9IChldmVudC5yZXF1ZXN0Q29udGV4dCBhcyBhbnkpPy5odHRwPy5tZXRob2QgfHwgZXZlbnQuaHR0cE1ldGhvZDtcbiAgICBjb25zdCBzZXJpYWxOdW1iZXIgPSBldmVudC5wYXRoUGFyYW1ldGVycz8uc2VyaWFsX251bWJlcjtcbiAgICBjb25zdCBwYXRoID0gKGV2ZW50IGFzIGFueSkucmF3UGF0aCB8fCBldmVudC5wYXRoIHx8ICcnO1xuXG4gICAgaWYgKG1ldGhvZCA9PT0gJ09QVElPTlMnKSB7XG4gICAgICByZXR1cm4geyBzdGF0dXNDb2RlOiAyMDAsIGhlYWRlcnM6IGNvcnNIZWFkZXJzLCBib2R5OiAnJyB9O1xuICAgIH1cblxuICAgIC8vIFBPU1QgL2RldmljZXMvbWVyZ2UgLSBNZXJnZSB0d28gZGV2aWNlcyAoQWRtaW4gb25seSlcbiAgICBpZiAobWV0aG9kID09PSAnUE9TVCcgJiYgcGF0aC5lbmRzV2l0aCgnL21lcmdlJykpIHtcbiAgICAgIHJldHVybiBhd2FpdCBtZXJnZURldmljZXMoZXZlbnQsIGNvcnNIZWFkZXJzKTtcbiAgICB9XG5cbiAgICBpZiAobWV0aG9kID09PSAnR0VUJyAmJiAhc2VyaWFsTnVtYmVyKSB7XG4gICAgICAvLyBMaXN0IGRldmljZXNcbiAgICAgIHJldHVybiBhd2FpdCBsaXN0RGV2aWNlcyhldmVudCwgY29yc0hlYWRlcnMpO1xuICAgIH1cblxuICAgIGlmIChtZXRob2QgPT09ICdHRVQnICYmIHNlcmlhbE51bWJlcikge1xuICAgICAgLy8gR2V0IHNpbmdsZSBkZXZpY2UgYnkgc2VyaWFsIG51bWJlclxuICAgICAgcmV0dXJuIGF3YWl0IGdldERldmljZUJ5U2VyaWFsKHNlcmlhbE51bWJlciwgY29yc0hlYWRlcnMpO1xuICAgIH1cblxuICAgIGlmIChtZXRob2QgPT09ICdQQVRDSCcgJiYgc2VyaWFsTnVtYmVyKSB7XG4gICAgICAvLyBVcGRhdGUgZGV2aWNlIGJ5IHNlcmlhbCBudW1iZXJcbiAgICAgIHJldHVybiBhd2FpdCB1cGRhdGVEZXZpY2VCeVNlcmlhbChzZXJpYWxOdW1iZXIsIGV2ZW50LmJvZHksIGNvcnNIZWFkZXJzKTtcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA1LFxuICAgICAgaGVhZGVyczogY29yc0hlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnTWV0aG9kIG5vdCBhbGxvd2VkJyB9KSxcbiAgICB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yOicsIGVycm9yKTtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNTAwLFxuICAgICAgaGVhZGVyczogY29yc0hlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnSW50ZXJuYWwgc2VydmVyIGVycm9yJyB9KSxcbiAgICB9O1xuICB9XG59O1xuXG5hc3luYyBmdW5jdGlvbiBsaXN0RGV2aWNlcyhcbiAgZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50LFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICBjb25zdCBxdWVyeVBhcmFtcyA9IGV2ZW50LnF1ZXJ5U3RyaW5nUGFyYW1ldGVycyB8fCB7fTtcbiAgY29uc3QgZmxlZXQgPSBxdWVyeVBhcmFtcy5mbGVldDtcbiAgY29uc3Qgc3RhdHVzID0gcXVlcnlQYXJhbXMuc3RhdHVzO1xuICBjb25zdCBsaW1pdCA9IHBhcnNlSW50KHF1ZXJ5UGFyYW1zLmxpbWl0IHx8ICcxMDAnKTtcblxuICBsZXQgaXRlbXM6IGFueVtdID0gW107XG5cbiAgaWYgKGZsZWV0KSB7XG4gICAgLy8gUXVlcnkgYnkgZmxlZXQgdXNpbmcgR1NJXG4gICAgY29uc3QgY29tbWFuZCA9IG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgICAgSW5kZXhOYW1lOiAnZmxlZXQtaW5kZXgnLFxuICAgICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJyNmbGVldCA9IDpmbGVldCcsXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHsgJyNmbGVldCc6ICdmbGVldCcgfSxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHsgJzpmbGVldCc6IGZsZWV0IH0sXG4gICAgICBMaW1pdDogbGltaXQsXG4gICAgICBTY2FuSW5kZXhGb3J3YXJkOiBmYWxzZSwgLy8gTW9zdCByZWNlbnQgZmlyc3RcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICAgIGl0ZW1zID0gcmVzdWx0Lkl0ZW1zIHx8IFtdO1xuICB9IGVsc2UgaWYgKHN0YXR1cykge1xuICAgIC8vIFF1ZXJ5IGJ5IHN0YXR1cyB1c2luZyBHU0lcbiAgICBjb25zdCBjb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IERFVklDRVNfVEFCTEUsXG4gICAgICBJbmRleE5hbWU6ICdzdGF0dXMtaW5kZXgnLFxuICAgICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJyNzdGF0dXMgPSA6c3RhdHVzJyxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczogeyAnI3N0YXR1cyc6ICdzdGF0dXMnIH0sXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7ICc6c3RhdHVzJzogc3RhdHVzIH0sXG4gICAgICBMaW1pdDogbGltaXQsXG4gICAgICBTY2FuSW5kZXhGb3J3YXJkOiBmYWxzZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICAgIGl0ZW1zID0gcmVzdWx0Lkl0ZW1zIHx8IFtdO1xuICB9IGVsc2Uge1xuICAgIC8vIFNjYW4gYWxsIGRldmljZXMgKGZvciBzbWFsbCBmbGVldHMpXG4gICAgY29uc3QgY29tbWFuZCA9IG5ldyBTY2FuQ29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IERFVklDRVNfVEFCTEUsXG4gICAgICBMaW1pdDogbGltaXQsXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgICBpdGVtcyA9IHJlc3VsdC5JdGVtcyB8fCBbXTtcbiAgfVxuXG4gIC8vIFRyYW5zZm9ybSBhbmQgY2FsY3VsYXRlIGZsZWV0IHN0YXRzXG4gIGNvbnN0IHRyYW5zZm9ybWVkRGV2aWNlcyA9IGl0ZW1zLm1hcCh0cmFuc2Zvcm1EZXZpY2UpO1xuICBjb25zdCBzdGF0cyA9IGNhbGN1bGF0ZVN0YXRzKGl0ZW1zKTtcblxuICByZXR1cm4ge1xuICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICBoZWFkZXJzLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIGRldmljZXM6IHRyYW5zZm9ybWVkRGV2aWNlcyxcbiAgICAgIGNvdW50OiB0cmFuc2Zvcm1lZERldmljZXMubGVuZ3RoLFxuICAgICAgc3RhdHMsXG4gICAgfSksXG4gIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldERldmljZUJ5U2VyaWFsKFxuICBzZXJpYWxOdW1iZXI6IHN0cmluZyxcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgLy8gUmVzb2x2ZSBzZXJpYWxfbnVtYmVyIHRvIGRldmljZSBpbmZvXG4gIGNvbnN0IHJlc29sdmVkID0gYXdhaXQgcmVzb2x2ZURldmljZShzZXJpYWxOdW1iZXIpO1xuXG4gIGlmICghcmVzb2x2ZWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdEZXZpY2Ugbm90IGZvdW5kJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gR2V0IHRoZSBkZXZpY2UgdXNpbmcgdGhlIGN1cnJlbnQgZGV2aWNlX3VpZFxuICBjb25zdCBjb21tYW5kID0gbmV3IEdldENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICBLZXk6IHsgZGV2aWNlX3VpZDogcmVzb2x2ZWQuZGV2aWNlX3VpZCB9LFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcblxuICBpZiAoIXJlc3VsdC5JdGVtKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwNCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRGV2aWNlIG5vdCBmb3VuZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8vIFRyYW5zZm9ybSBhbmQgYWRkIGRldmljZV91aWQgaGlzdG9yeVxuICBjb25zdCBkZXZpY2UgPSB0cmFuc2Zvcm1EZXZpY2UocmVzdWx0Lkl0ZW0pO1xuICBkZXZpY2UuZGV2aWNlX3VpZF9oaXN0b3J5ID0gcmVzb2x2ZWQuYWxsX2RldmljZV91aWRzLmxlbmd0aCA+IDFcbiAgICA/IHJlc29sdmVkLmFsbF9kZXZpY2VfdWlkcy5zbGljZSgxKSAvLyBFeGNsdWRlIGN1cnJlbnQgZGV2aWNlX3VpZFxuICAgIDogdW5kZWZpbmVkO1xuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoZGV2aWNlKSxcbiAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gdXBkYXRlRGV2aWNlQnlTZXJpYWwoXG4gIHNlcmlhbE51bWJlcjogc3RyaW5nLFxuICBib2R5OiBzdHJpbmcgfCBudWxsLFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICBpZiAoIWJvZHkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdSZXF1ZXN0IGJvZHkgcmVxdWlyZWQnIH0pLFxuICAgIH07XG4gIH1cblxuICAvLyBSZXNvbHZlIHNlcmlhbF9udW1iZXIgdG8gZGV2aWNlX3VpZFxuICBjb25zdCByZXNvbHZlZCA9IGF3YWl0IHJlc29sdmVEZXZpY2Uoc2VyaWFsTnVtYmVyKTtcblxuICBpZiAoIXJlc29sdmVkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwNCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRGV2aWNlIG5vdCBmb3VuZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHVwZGF0ZXMgPSBKU09OLnBhcnNlKGJvZHkpO1xuXG4gIC8vIE9ubHkgYWxsb3cgY2VydGFpbiBmaWVsZHMgdG8gYmUgdXBkYXRlZCAocmVtb3ZlZCBzZXJpYWxfbnVtYmVyIC0gaXQncyBub3cgaW1tdXRhYmxlKVxuICBjb25zdCBhbGxvd2VkRmllbGRzID0gWyduYW1lJywgJ2Fzc2lnbmVkX3RvJywgJ2Fzc2lnbmVkX3RvX25hbWUnLCAnZmxlZXQnLCAnbm90ZXMnXTtcbiAgY29uc3QgdXBkYXRlRXhwcmVzc2lvbnM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICBjb25zdCBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge307XG5cbiAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXModXBkYXRlcykpIHtcbiAgICBpZiAoYWxsb3dlZEZpZWxkcy5pbmNsdWRlcyhrZXkpKSB7XG4gICAgICBjb25zdCBhdHRyTmFtZSA9IGAjJHtrZXl9YDtcbiAgICAgIGNvbnN0IGF0dHJWYWx1ZSA9IGA6JHtrZXl9YDtcbiAgICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goYCR7YXR0ck5hbWV9ID0gJHthdHRyVmFsdWV9YCk7XG4gICAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbYXR0ck5hbWVdID0ga2V5O1xuICAgICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1thdHRyVmFsdWVdID0gdmFsdWU7XG4gICAgfVxuICB9XG5cbiAgaWYgKHVwZGF0ZUV4cHJlc3Npb25zLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ05vIHZhbGlkIGZpZWxkcyB0byB1cGRhdGUnIH0pLFxuICAgIH07XG4gIH1cblxuICAvLyBBbHdheXMgdXBkYXRlIHVwZGF0ZWRfYXRcbiAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3VwZGF0ZWRfYXQgPSA6dXBkYXRlZF9hdCcpO1xuICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyN1cGRhdGVkX2F0J10gPSAndXBkYXRlZF9hdCc7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzp1cGRhdGVkX2F0J10gPSBEYXRlLm5vdygpO1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgVXBkYXRlQ29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgIEtleTogeyBkZXZpY2VfdWlkOiByZXNvbHZlZC5kZXZpY2VfdWlkIH0sXG4gICAgVXBkYXRlRXhwcmVzc2lvbjogJ1NFVCAnICsgdXBkYXRlRXhwcmVzc2lvbnMuam9pbignLCAnKSxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lcyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzLFxuICAgIFJldHVyblZhbHVlczogJ0FMTF9ORVcnLFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcblxuICByZXR1cm4ge1xuICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICBoZWFkZXJzLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHRyYW5zZm9ybURldmljZShyZXN1bHQuQXR0cmlidXRlcykpLFxuICB9O1xufVxuXG4vKipcbiAqIFRyYW5zZm9ybSBEeW5hbW9EQiBkZXZpY2UgcmVjb3JkIHRvIGZyb250ZW5kIGZvcm1hdFxuICogRmxhdHRlbnMgbmVzdGVkIG9iamVjdHMgbGlrZSBsYXN0X2xvY2F0aW9uIGFuZCBsYXN0X3RlbGVtZXRyeVxuICovXG5mdW5jdGlvbiB0cmFuc2Zvcm1EZXZpY2UoaXRlbTogYW55KTogYW55IHtcbiAgY29uc3QgZGV2aWNlOiBhbnkgPSB7XG4gICAgZGV2aWNlX3VpZDogaXRlbS5kZXZpY2VfdWlkLFxuICAgIHNlcmlhbF9udW1iZXI6IGl0ZW0uc2VyaWFsX251bWJlcixcbiAgICBuYW1lOiBpdGVtLm5hbWUsXG4gICAgZmxlZXQ6IGl0ZW0uZmxlZXQsXG4gICAgc3RhdHVzOiBpdGVtLnN0YXR1cyxcbiAgICAvLyBDb252ZXJ0IG1pbGxpc2Vjb25kIHRpbWVzdGFtcCB0byBJU08gc3RyaW5nIGZvciBmcm9udGVuZFxuICAgIGxhc3Rfc2VlbjogaXRlbS5sYXN0X3NlZW4gPyBuZXcgRGF0ZShpdGVtLmxhc3Rfc2VlbikudG9JU09TdHJpbmcoKSA6IHVuZGVmaW5lZCxcbiAgICBtb2RlOiBpdGVtLmN1cnJlbnRfbW9kZSxcbiAgICB0cmFuc2l0X2xvY2tlZDogaXRlbS50cmFuc2l0X2xvY2tlZCB8fCBmYWxzZSxcbiAgICBkZW1vX2xvY2tlZDogaXRlbS5kZW1vX2xvY2tlZCB8fCBmYWxzZSxcbiAgICB1c2JfcG93ZXJlZDogaXRlbS51c2JfcG93ZXJlZCB8fCBmYWxzZSxcbiAgICBjcmVhdGVkX2F0OiBpdGVtLmNyZWF0ZWRfYXQgPyBuZXcgRGF0ZShpdGVtLmNyZWF0ZWRfYXQpLnRvSVNPU3RyaW5nKCkgOiB1bmRlZmluZWQsXG4gICAgdXBkYXRlZF9hdDogaXRlbS51cGRhdGVkX2F0ID8gbmV3IERhdGUoaXRlbS51cGRhdGVkX2F0KS50b0lTT1N0cmluZygpIDogdW5kZWZpbmVkLFxuICAgIGFzc2lnbmVkX3RvOiBpdGVtLmFzc2lnbmVkX3RvLFxuICAgIGFzc2lnbmVkX3RvX25hbWU6IGl0ZW0uYXNzaWduZWRfdG9fbmFtZSxcbiAgfTtcblxuICAvLyBGbGF0dGVuIGxhc3RfbG9jYXRpb25cbiAgaWYgKGl0ZW0ubGFzdF9sb2NhdGlvbikge1xuICAgIGRldmljZS5sYXRpdHVkZSA9IGl0ZW0ubGFzdF9sb2NhdGlvbi5sYXQ7XG4gICAgZGV2aWNlLmxvbmdpdHVkZSA9IGl0ZW0ubGFzdF9sb2NhdGlvbi5sb247XG4gICAgLy8gQ29udmVydCBVbml4IHRpbWVzdGFtcCAoc2Vjb25kcykgdG8gSVNPIHN0cmluZyBmb3IgZnJvbnRlbmRcbiAgICBpZiAoaXRlbS5sYXN0X2xvY2F0aW9uLnRpbWUpIHtcbiAgICAgIC8vIE5vdGVodWIgdGltZXN0YW1wcyBhcmUgaW4gc2Vjb25kcywgY29udmVydCB0byBtaWxsaXNlY29uZHMgZm9yIERhdGVcbiAgICAgIGNvbnN0IHRpbWVNcyA9IGl0ZW0ubGFzdF9sb2NhdGlvbi50aW1lICogMTAwMDtcbiAgICAgIGRldmljZS5sb2NhdGlvbl90aW1lID0gbmV3IERhdGUodGltZU1zKS50b0lTT1N0cmluZygpO1xuICAgIH1cbiAgICBkZXZpY2UubG9jYXRpb25fc291cmNlID0gaXRlbS5sYXN0X2xvY2F0aW9uLnNvdXJjZTtcbiAgICBkZXZpY2UubG9jYXRpb25fbmFtZSA9IGl0ZW0ubGFzdF9sb2NhdGlvbi5uYW1lO1xuICB9XG5cbiAgLy8gRmxhdHRlbiBsYXN0X3RlbGVtZXRyeVxuICBpZiAoaXRlbS5sYXN0X3RlbGVtZXRyeSkge1xuICAgIGRldmljZS50ZW1wZXJhdHVyZSA9IGl0ZW0ubGFzdF90ZWxlbWV0cnkudGVtcDtcbiAgICBkZXZpY2UuaHVtaWRpdHkgPSBpdGVtLmxhc3RfdGVsZW1ldHJ5Lmh1bWlkaXR5O1xuICAgIGRldmljZS5wcmVzc3VyZSA9IGl0ZW0ubGFzdF90ZWxlbWV0cnkucHJlc3N1cmU7XG4gICAgLy8gTm90ZTogdm9sdGFnZSBubyBsb25nZXIgY29tZXMgZnJvbSBsYXN0X3RlbGVtZXRyeTsgaXQncyBzZXQgZnJvbSBfbG9nLnFvL19oZWFsdGgucW9cbiAgICBkZXZpY2UubW90aW9uID0gaXRlbS5sYXN0X3RlbGVtZXRyeS5tb3Rpb247XG4gIH1cblxuICAvLyBWb2x0YWdlIGNvbWVzIGZyb20gZGV2aWNlLnZvbHRhZ2UgZmllbGQgKHNldCBmcm9tIF9sb2cucW8gb3IgX2hlYWx0aC5xbyBldmVudHMpXG4gIGlmIChpdGVtLnZvbHRhZ2UgIT09IHVuZGVmaW5lZCkge1xuICAgIGRldmljZS52b2x0YWdlID0gaXRlbS52b2x0YWdlO1xuICB9XG5cbiAgLy8gRmxhdHRlbiBsYXN0X3Bvd2VyIChNb2pvIGRhdGEpXG4gIGlmIChpdGVtLmxhc3RfcG93ZXIpIHtcbiAgICBkZXZpY2UubW9qb192b2x0YWdlID0gaXRlbS5sYXN0X3Bvd2VyLnZvbHRhZ2U7XG4gICAgZGV2aWNlLm1vam9fdGVtcGVyYXR1cmUgPSBpdGVtLmxhc3RfcG93ZXIudGVtcGVyYXR1cmU7XG4gICAgZGV2aWNlLm1pbGxpYW1wX2hvdXJzID0gaXRlbS5sYXN0X3Bvd2VyLm1pbGxpYW1wX2hvdXJzO1xuICB9XG5cbiAgLy8gRmlybXdhcmUgdmVyc2lvbnMgKGZyb20gX3Nlc3Npb24ucW8gZXZlbnRzKVxuICBpZiAoaXRlbS5maXJtd2FyZV92ZXJzaW9uKSB7XG4gICAgZGV2aWNlLmZpcm13YXJlX3ZlcnNpb24gPSBpdGVtLmZpcm13YXJlX3ZlcnNpb247XG4gIH1cbiAgaWYgKGl0ZW0ubm90ZWNhcmRfdmVyc2lvbikge1xuICAgIGRldmljZS5ub3RlY2FyZF92ZXJzaW9uID0gaXRlbS5ub3RlY2FyZF92ZXJzaW9uO1xuICB9XG4gIGlmIChpdGVtLm5vdGVjYXJkX3NrdSkge1xuICAgIGRldmljZS5ub3RlY2FyZF9za3UgPSBpdGVtLm5vdGVjYXJkX3NrdTtcbiAgfVxuXG4gIHJldHVybiBkZXZpY2U7XG59XG5cbmZ1bmN0aW9uIGNhbGN1bGF0ZVN0YXRzKGRldmljZXM6IGFueVtdKTogUmVjb3JkPHN0cmluZywgYW55PiB7XG4gIGNvbnN0IHN0YXRzID0ge1xuICAgIHRvdGFsOiBkZXZpY2VzLmxlbmd0aCxcbiAgICBvbmxpbmU6IDAsXG4gICAgb2ZmbGluZTogMCxcbiAgICBhbGVydDogMCxcbiAgICBsb3dfYmF0dGVyeTogMCxcbiAgICBmbGVldHM6IHt9IGFzIFJlY29yZDxzdHJpbmcsIG51bWJlcj4sXG4gIH07XG5cbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgY29uc3Qgb2ZmbGluZVRocmVzaG9sZCA9IDE1ICogNjAgKiAxMDAwOyAvLyAxNSBtaW51dGVzXG5cbiAgZm9yIChjb25zdCBkZXZpY2Ugb2YgZGV2aWNlcykge1xuICAgIC8vIFN0YXR1cyBjb3VudHNcbiAgICBpZiAoZGV2aWNlLnN0YXR1cyA9PT0gJ2FsZXJ0Jykge1xuICAgICAgc3RhdHMuYWxlcnQrKztcbiAgICB9IGVsc2UgaWYgKGRldmljZS5sYXN0X3NlZW4gJiYgbm93IC0gZGV2aWNlLmxhc3Rfc2VlbiA8IG9mZmxpbmVUaHJlc2hvbGQpIHtcbiAgICAgIHN0YXRzLm9ubGluZSsrO1xuICAgIH0gZWxzZSB7XG4gICAgICBzdGF0cy5vZmZsaW5lKys7XG4gICAgfVxuXG4gICAgLy8gTG93IGJhdHRlcnkgY2hlY2sgKHZvbHRhZ2UgY29tZXMgZnJvbSBfbG9nLnFvL19oZWFsdGgucW8sIHN0b3JlZCBpbiBkZXZpY2Uudm9sdGFnZSlcbiAgICBpZiAoZGV2aWNlLnZvbHRhZ2UgJiYgZGV2aWNlLnZvbHRhZ2UgPCAzLjQpIHtcbiAgICAgIHN0YXRzLmxvd19iYXR0ZXJ5Kys7XG4gICAgfVxuXG4gICAgLy8gRmxlZXQgY291bnRzXG4gICAgY29uc3QgZmxlZXQgPSBkZXZpY2UuZmxlZXQgfHwgJ2RlZmF1bHQnO1xuICAgIHN0YXRzLmZsZWV0c1tmbGVldF0gPSAoc3RhdHMuZmxlZXRzW2ZsZWV0XSB8fCAwKSArIDE7XG4gIH1cblxuICByZXR1cm4gc3RhdHM7XG59XG5cbi8qKlxuICogTWVyZ2UgdHdvIGRldmljZXMgaW50byBvbmUgKEFkbWluIG9ubHkpXG4gKiBUaGUgc291cmNlIGRldmljZSdzIGRldmljZV91aWQgaXMgYWRkZWQgdG8gdGhlIHRhcmdldCdzIGFsaWFzIGhpc3RvcnksXG4gKiBhbmQgdGhlIHNvdXJjZSBkZXZpY2UgcmVjb3JkIGlzIGRlbGV0ZWQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIG1lcmdlRGV2aWNlcyhcbiAgZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50LFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICAvLyBDaGVjayBmb3IgYWRtaW4gYXV0aG9yaXphdGlvblxuICBjb25zdCBjbGFpbXMgPSAoZXZlbnQucmVxdWVzdENvbnRleHQgYXMgYW55KT8uYXV0aG9yaXplcj8uand0Py5jbGFpbXMgfHwge307XG4gIGNvbnN0IGdyb3VwcyA9IGNsYWltc1snY29nbml0bzpncm91cHMnXSB8fCAnJztcbiAgY29uc3QgaXNBZG1pbiA9IGdyb3Vwcy5pbmNsdWRlcygnQWRtaW4nKTtcblxuICBpZiAoIWlzQWRtaW4pIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDAzLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdBZG1pbiBhY2Nlc3MgcmVxdWlyZWQgdG8gbWVyZ2UgZGV2aWNlcycgfSksXG4gICAgfTtcbiAgfVxuXG4gIGlmICghZXZlbnQuYm9keSkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1JlcXVlc3QgYm9keSByZXF1aXJlZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHsgc291cmNlX3NlcmlhbF9udW1iZXIsIHRhcmdldF9zZXJpYWxfbnVtYmVyIH0gPSBKU09OLnBhcnNlKGV2ZW50LmJvZHkpO1xuXG4gIGlmICghc291cmNlX3NlcmlhbF9udW1iZXIgfHwgIXRhcmdldF9zZXJpYWxfbnVtYmVyKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnQm90aCBzb3VyY2Vfc2VyaWFsX251bWJlciBhbmQgdGFyZ2V0X3NlcmlhbF9udW1iZXIgYXJlIHJlcXVpcmVkJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgaWYgKHNvdXJjZV9zZXJpYWxfbnVtYmVyID09PSB0YXJnZXRfc2VyaWFsX251bWJlcikge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1NvdXJjZSBhbmQgdGFyZ2V0IGNhbm5vdCBiZSB0aGUgc2FtZSBkZXZpY2UnIH0pLFxuICAgIH07XG4gIH1cblxuICAvLyBHZXQgYm90aCBkZXZpY2VzXG4gIGNvbnN0IHNvdXJjZUFsaWFzID0gYXdhaXQgZ2V0QWxpYXNCeVNlcmlhbChzb3VyY2Vfc2VyaWFsX251bWJlcik7XG4gIGNvbnN0IHRhcmdldEFsaWFzID0gYXdhaXQgZ2V0QWxpYXNCeVNlcmlhbCh0YXJnZXRfc2VyaWFsX251bWJlcik7XG5cbiAgaWYgKCFzb3VyY2VBbGlhcykge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDQsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogYFNvdXJjZSBkZXZpY2Ugbm90IGZvdW5kOiAke3NvdXJjZV9zZXJpYWxfbnVtYmVyfWAgfSksXG4gICAgfTtcbiAgfVxuXG4gIGlmICghdGFyZ2V0QWxpYXMpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6IGBUYXJnZXQgZGV2aWNlIG5vdCBmb3VuZDogJHt0YXJnZXRfc2VyaWFsX251bWJlcn1gIH0pLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBzb3VyY2VEZXZpY2VVaWQgPSBzb3VyY2VBbGlhcy5kZXZpY2VfdWlkO1xuICBjb25zdCB0YXJnZXREZXZpY2VVaWQgPSB0YXJnZXRBbGlhcy5kZXZpY2VfdWlkO1xuICBjb25zdCBzb3VyY2VQcmV2aW91c1VpZHMgPSBzb3VyY2VBbGlhcy5wcmV2aW91c19kZXZpY2VfdWlkcyB8fCBbXTtcbiAgY29uc3QgdGFyZ2V0UHJldmlvdXNVaWRzID0gdGFyZ2V0QWxpYXMucHJldmlvdXNfZGV2aWNlX3VpZHMgfHwgW107XG5cbiAgLy8gTWVyZ2UgYWxsIGRldmljZV91aWRzOiB0YXJnZXQncyBwcmV2aW91cyArIHNvdXJjZSdzIGN1cnJlbnQgKyBzb3VyY2UncyBwcmV2aW91c1xuICBjb25zdCBhbGxQcmV2aW91c1VpZHMgPSBbXG4gICAgLi4ubmV3IFNldChbXG4gICAgICAuLi50YXJnZXRQcmV2aW91c1VpZHMsXG4gICAgICBzb3VyY2VEZXZpY2VVaWQsXG4gICAgICAuLi5zb3VyY2VQcmV2aW91c1VpZHMsXG4gICAgXSksXG4gIF07XG5cbiAgLy8gVXBkYXRlIHRhcmdldCBhbGlhcyB0byBpbmNsdWRlIHNvdXJjZSBkZXZpY2VfdWlkc1xuICBhd2FpdCBkb2NDbGllbnQuc2VuZChuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBERVZJQ0VfQUxJQVNFU19UQUJMRSxcbiAgICBJdGVtOiB7XG4gICAgICBzZXJpYWxfbnVtYmVyOiB0YXJnZXRfc2VyaWFsX251bWJlcixcbiAgICAgIGRldmljZV91aWQ6IHRhcmdldERldmljZVVpZCxcbiAgICAgIHByZXZpb3VzX2RldmljZV91aWRzOiBhbGxQcmV2aW91c1VpZHMsXG4gICAgICBjcmVhdGVkX2F0OiB0YXJnZXRBbGlhcy5jcmVhdGVkX2F0LFxuICAgICAgdXBkYXRlZF9hdDogRGF0ZS5ub3coKSxcbiAgICB9LFxuICB9KSk7XG5cbiAgLy8gRGVsZXRlIHNvdXJjZSBhbGlhc1xuICBhd2FpdCBkb2NDbGllbnQuc2VuZChuZXcgRGVsZXRlQ29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBERVZJQ0VfQUxJQVNFU19UQUJMRSxcbiAgICBLZXk6IHsgc2VyaWFsX251bWJlcjogc291cmNlX3NlcmlhbF9udW1iZXIgfSxcbiAgfSkpO1xuXG4gIC8vIERlbGV0ZSBzb3VyY2UgZGV2aWNlIHJlY29yZFxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChuZXcgRGVsZXRlQ29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgIEtleTogeyBkZXZpY2VfdWlkOiBzb3VyY2VEZXZpY2VVaWQgfSxcbiAgfSkpO1xuXG4gIC8vIENyZWF0ZSBhY3Rpdml0eSBmZWVkIGV2ZW50XG4gIGNvbnN0IGFjdGl2aXR5RXZlbnQgPSB7XG4gICAgZXZlbnRfaWQ6IGBtZXJnZS0ke0RhdGUubm93KCl9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc3Vic3RyaW5nKDcpfWAsXG4gICAgZGV2aWNlX3VpZDogdGFyZ2V0RGV2aWNlVWlkLFxuICAgIHNlcmlhbF9udW1iZXI6IHRhcmdldF9zZXJpYWxfbnVtYmVyLFxuICAgIGV2ZW50X3R5cGU6ICdkZXZpY2VfbWVyZ2VkJyxcbiAgICB0aW1lc3RhbXA6IERhdGUubm93KCksXG4gICAgZGF0YToge1xuICAgICAgc291cmNlX3NlcmlhbF9udW1iZXIsXG4gICAgICBzb3VyY2VfZGV2aWNlX3VpZDogc291cmNlRGV2aWNlVWlkLFxuICAgICAgdGFyZ2V0X3NlcmlhbF9udW1iZXIsXG4gICAgICB0YXJnZXRfZGV2aWNlX3VpZDogdGFyZ2V0RGV2aWNlVWlkLFxuICAgICAgbWVyZ2VkX2RldmljZV91aWRzOiBhbGxQcmV2aW91c1VpZHMsXG4gICAgfSxcbiAgfTtcblxuICB0cnkge1xuICAgIGF3YWl0IGRvY0NsaWVudC5zZW5kKG5ldyBQdXRDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogQUNUSVZJVFlfVEFCTEUsXG4gICAgICBJdGVtOiBhY3Rpdml0eUV2ZW50LFxuICAgIH0pKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgLy8gQWN0aXZpdHkgbG9nZ2luZyBpcyBub24tY3JpdGljYWwsIGxvZyBidXQgZG9uJ3QgZmFpbFxuICAgIGNvbnNvbGUuZXJyb3IoJ0ZhaWxlZCB0byBsb2cgbWVyZ2UgYWN0aXZpdHk6JywgZXJyKTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgbWVzc2FnZTogJ0RldmljZXMgbWVyZ2VkIHN1Y2Nlc3NmdWxseScsXG4gICAgICB0YXJnZXRfc2VyaWFsX251bWJlcixcbiAgICAgIHRhcmdldF9kZXZpY2VfdWlkOiB0YXJnZXREZXZpY2VVaWQsXG4gICAgICBtZXJnZWRfZGV2aWNlX3VpZHM6IFt0YXJnZXREZXZpY2VVaWQsIC4uLmFsbFByZXZpb3VzVWlkc10sXG4gICAgICBkZWxldGVkX3NlcmlhbF9udW1iZXI6IHNvdXJjZV9zZXJpYWxfbnVtYmVyLFxuICAgICAgZGVsZXRlZF9kZXZpY2VfdWlkOiBzb3VyY2VEZXZpY2VVaWQsXG4gICAgfSksXG4gIH07XG59XG4iXX0=