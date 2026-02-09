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
        pending_mode: item.pending_mode || null,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWRldmljZXMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7O0dBT0c7OztBQUVILDhEQUEwRDtBQUMxRCx3REFRK0I7QUFFL0IsMkRBQTBFO0FBRTFFLE1BQU0sU0FBUyxHQUFHLElBQUksZ0NBQWMsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN6QyxNQUFNLFNBQVMsR0FBRyxxQ0FBc0IsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7QUFFekQsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxhQUFjLENBQUM7QUFDakQsTUFBTSxvQkFBb0IsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLG9CQUFvQixJQUFJLHlCQUF5QixDQUFDO0FBQzNGLE1BQU0sY0FBYyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsY0FBYyxJQUFJLG1CQUFtQixDQUFDO0FBRWxFLE1BQU0sT0FBTyxHQUFHLEtBQUssRUFBRSxLQUEyQixFQUFrQyxFQUFFO0lBQzNGLE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUUvQyxNQUFNLFdBQVcsR0FBRztRQUNsQiw2QkFBNkIsRUFBRSxHQUFHO1FBQ2xDLDhCQUE4QixFQUFFLDRCQUE0QjtRQUM1RCw4QkFBOEIsRUFBRSwrQkFBK0I7S0FDaEUsQ0FBQztJQUVGLElBQUksQ0FBQztRQUNILDJFQUEyRTtRQUMzRSxNQUFNLE1BQU0sR0FBSSxLQUFLLENBQUMsY0FBc0IsRUFBRSxJQUFJLEVBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUM7UUFDL0UsTUFBTSxZQUFZLEdBQUcsS0FBSyxDQUFDLGNBQWMsRUFBRSxhQUFhLENBQUM7UUFDekQsTUFBTSxJQUFJLEdBQUksS0FBYSxDQUFDLE9BQU8sSUFBSSxL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QUFDLE1BQU0sRUFBRSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUU7UUFDMUUsVUFBVSxFQUFFLGVBQWU7UUFDM0IsYUFBYSxFQUFFLG9CQUFvQjtRQUNuQyxVQUFVLEVBQUUsZUFBZTtRQUMzQixTQUFTLEVBQUUsSUFBSSxDQUFDLEdBQUcsRUFBRTtRQUNyQixJQUFJLEVBQUU7WUFDSixvQkFBb0I7WUFDcEIsaUJBQWlCLEVBQUUsZUFBZTtZQUNsQyxvQkFBb0I7WUFDcEIsaUJBQWlCLEVBQUUsZUFBZTtZQUNsQyxrQkFBa0IsRUFBRSxlQUFlO1NBQ3BDO0tBQ0YsQ0FBQztJQUVGLElBQUksQ0FBQztRQUNILE1BQU0sU0FBUyxDQUFDLElBQUksQ0FBQyxJQUFJLHlCQUFVLENBQUM7WUFDbEMsU0FBUyxFQUFFLGNBQWM7WUFDekIsSUFBSSxFQUFFLGFBQWE7U0FDcEIsQ0FBQyxDQUFDLENBQUM7SUFDTixDQUFDO0lBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztRQUNiLHVEQUF1RDtRQUN2RCxPQUFPLENBQUMsS0FBSyxDQUFDLCtCQUErQixFQUFFLEdBQUcsQ0FBQyxDQUFDO0lBQ3RELENBQUM7SUFFRCxPQUFPO1FBQ0wsVUFBVSxFQUFFLEdBQUc7UUFDZixPQUFPO1FBQ1AsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUM7WUFDbkIsT0FBTyxFQUFFLDZCQUE2QjtZQUN0QyxvQkFBb0I7WUFDcEIsaUJBQWlCLEVBQUUsZUFBZTtZQUNsQyxrQkFBa0IsRUFBRSxDQUFDLGVBQWUsRUFBRSxHQUFHLGVBQWUsQ0FBQztZQUN6RCxxQkFBcUIsRUFBRSxvQkFBb0I7WUFDM0Msa0JBQWtCLEVBQUUsZUFBZTtTQUNwQyxDQUFDO0tBQ0gsQ0FBQztBQUNKLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIERldmljZXMgQVBJIExhbWJkYVxuICpcbiAqIEhhbmRsZXMgZGV2aWNlIENSVUQgb3BlcmF0aW9uczpcbiAqIC0gR0VUIC9kZXZpY2VzIC0gTGlzdCBhbGwgZGV2aWNlc1xuICogLSBHRVQgL2RldmljZXMve3NlcmlhbF9udW1iZXJ9IC0gR2V0IGRldmljZSBkZXRhaWxzXG4gKiAtIFBBVENIIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfSAtIFVwZGF0ZSBkZXZpY2UgbWV0YWRhdGFcbiAqL1xuXG5pbXBvcnQgeyBEeW5hbW9EQkNsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYic7XG5pbXBvcnQge1xuICBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LFxuICBTY2FuQ29tbWFuZCxcbiAgUXVlcnlDb21tYW5kLFxuICBHZXRDb21tYW5kLFxuICBVcGRhdGVDb21tYW5kLFxuICBEZWxldGVDb21tYW5kLFxuICBQdXRDb21tYW5kLFxufSBmcm9tICdAYXdzLXNkay9saWItZHluYW1vZGInO1xuaW1wb3J0IHsgQVBJR2F0ZXdheVByb3h5RXZlbnQsIEFQSUdhdGV3YXlQcm94eVJlc3VsdCB9IGZyb20gJ2F3cy1sYW1iZGEnO1xuaW1wb3J0IHsgcmVzb2x2ZURldmljZSwgZ2V0QWxpYXNCeVNlcmlhbCB9IGZyb20gJy4uL3NoYXJlZC9kZXZpY2UtbG9va3VwJztcblxuY29uc3QgZGRiQ2xpZW50ID0gbmV3IER5bmFtb0RCQ2xpZW50KHt9KTtcbmNvbnN0IGRvY0NsaWVudCA9IER5bmFtb0RCRG9jdW1lbnRDbGllbnQuZnJvbShkZGJDbGllbnQpO1xuXG5jb25zdCBERVZJQ0VTX1RBQkxFID0gcHJvY2Vzcy5lbnYuREVWSUNFU19UQUJMRSE7XG5jb25zdCBERVZJQ0VfQUxJQVNFU19UQUJMRSA9IHByb2Nlc3MuZW52LkRFVklDRV9BTElBU0VTX1RBQkxFIHx8ICdzb25nYmlyZC1kZXZpY2UtYWxpYXNlcyc7XG5jb25zdCBBQ1RJVklUWV9UQUJMRSA9IHByb2Nlc3MuZW52LkFDVElWSVRZX1RBQkxFIHx8ICdzb25nYmlyZC1hY3Rpdml0eSc7XG5cbmV4cG9ydCBjb25zdCBoYW5kbGVyID0gYXN5bmMgKGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudCk6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiA9PiB7XG4gIGNvbnNvbGUubG9nKCdSZXF1ZXN0OicsIEpTT04uc3RyaW5naWZ5KGV2ZW50KSk7XG5cbiAgY29uc3QgY29yc0hlYWRlcnMgPSB7XG4gICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbic6ICcqJyxcbiAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctSGVhZGVycyc6ICdDb250ZW50LVR5cGUsQXV0aG9yaXphdGlvbicsXG4gICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHMnOiAnR0VULFBPU1QsUEFUQ0gsREVMRVRFLE9QVElPTlMnLFxuICB9O1xuXG4gIHRyeSB7XG4gICAgLy8gSFRUUCBBUEkgdjIgdXNlcyByZXF1ZXN0Q29udGV4dC5odHRwLm1ldGhvZCwgUkVTVCBBUEkgdjEgdXNlcyBodHRwTWV0aG9kXG4gICAgY29uc3QgbWV0aG9kID0gKGV2ZW50LnJlcXVlc3RDb250ZXh0IGFzIGFueSk/Lmh0dHA/Lm1ldGhvZCB8fCBldmVudC5odHRwTWV0aG9kO1xuICAgIGNvbnN0IHNlcmlhbE51bWJlciA9IGV2ZW50LnBhdGhQYXJhbWV0ZXJzPy5zZXJpYWxfbnVtYmVyO1xuICAgIGNvbnN0IHBhdGggPSAoZXZlbnQgYXMgYW55KS5yYXdQYXRoIHx8IGV2ZW50LnBhdGggfHwgJyc7XG5cbiAgICBpZiAobWV0aG9kID09PSAnT1BUSU9OUycpIHtcbiAgICAgIHJldHVybiB7IHN0YXR1c0NvZGU6IDIwMCwgaGVhZGVyczogY29yc0hlYWRlcnMsIGJvZHk6ICcnIH07XG4gICAgfVxuXG4gICAgLy8gUE9TVCAvZGV2aWNlcy9tZXJnZSAtIE1lcmdlIHR3byBkZXZpY2VzIChBZG1pbiBvbmx5KVxuICAgIGlmIChtZXRob2QgPT09ICdQT1NUJyAmJiBwYXRoLmVuZHNXaXRoKCcvbWVyZ2UnKSkge1xuICAgICAgcmV0dXJuIGF3YWl0IG1lcmdlRGV2aWNlcyhldmVudCwgY29yc0hlYWRlcnMpO1xuICAgIH1cblxuICAgIGlmIChtZXRob2QgPT09ICdHRVQnICYmICFzZXJpYWxOdW1iZXIpIHtcbiAgICAgIC8vIExpc3QgZGV2aWNlc1xuICAgICAgcmV0dXJuIGF3YWl0IGxpc3REZXZpY2VzKGV2ZW50LCBjb3JzSGVhZGVycyk7XG4gICAgfVxuXG4gICAgaWYgKG1ldGhvZCA9PT0gJ0dFVCcgJiYgc2VyaWFsTnVtYmVyKSB7XG4gICAgICAvLyBHZXQgc2luZ2xlIGRldmljZSBieSBzZXJpYWwgbnVtYmVyXG4gICAgICByZXR1cm4gYXdhaXQgZ2V0RGV2aWNlQnlTZXJpYWwoc2VyaWFsTnVtYmVyLCBjb3JzSGVhZGVycyk7XG4gICAgfVxuXG4gICAgaWYgKG1ldGhvZCA9PT0gJ1BBVENIJyAmJiBzZXJpYWxOdW1iZXIpIHtcbiAgICAgIC8vIFVwZGF0ZSBkZXZpY2UgYnkgc2VyaWFsIG51bWJlclxuICAgICAgcmV0dXJuIGF3YWl0IHVwZGF0ZURldmljZUJ5U2VyaWFsKHNlcmlhbE51bWJlciwgZXZlbnQuYm9keSwgY29yc0hlYWRlcnMpO1xuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDUsXG4gICAgICBoZWFkZXJzOiBjb3JzSGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdNZXRob2Qgbm90IGFsbG93ZWQnIH0pLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3I6JywgZXJyb3IpO1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA1MDAsXG4gICAgICBoZWFkZXJzOiBjb3JzSGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnRlcm5hbCBzZXJ2ZXIgZXJyb3InIH0pLFxuICAgIH07XG4gIH1cbn07XG5cbmFzeW5jIGZ1bmN0aW9uIGxpc3REZXZpY2VzKFxuICBldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQsXG4gIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiB7XG4gIGNvbnN0IHF1ZXJ5UGFyYW1zID0gZXZlbnQucXVlcnlTdHJpbmdQYXJhbWV0ZXJzIHx8IHt9O1xuICBjb25zdCBmbGVldCA9IHF1ZXJ5UGFyYW1zLmZsZWV0O1xuICBjb25zdCBzdGF0dXMgPSBxdWVyeVBhcmFtcy5zdGF0dXM7XG4gIGNvbnN0IGxpbWl0ID0gcGFyc2VJbnQocXVlcnlQYXJhbXMubGltaXQgfHwgJzEwMCcpO1xuXG4gIGxldCBpdGVtczogYW55W10gPSBbXTtcblxuICBpZiAoZmxlZXQpIHtcbiAgICAvLyBRdWVyeSBieSBmbGVldCB1c2luZyBHU0lcbiAgICBjb25zdCBjb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IERFVklDRVNfVEFCTEUsXG4gICAgICBJbmRleE5hbWU6ICdmbGVldC1pbmRleCcsXG4gICAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnI2ZsZWV0ID0gOmZsZWV0JyxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczogeyAnI2ZsZWV0JzogJ2ZsZWV0JyB9LFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczogeyAnOmZsZWV0JzogZmxlZXQgfSxcbiAgICAgIExpbWl0OiBsaW1pdCxcbiAgICAgIFNjYW5JbmRleEZvcndhcmQ6IGZhbHNlLCAvLyBNb3N0IHJlY2VudCBmaXJzdFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gICAgaXRlbXMgPSByZXN1bHQuSXRlbXMgfHwgW107XG4gIH0gZWxzZSBpZiAoc3RhdHVzKSB7XG4gICAgLy8gUXVlcnkgYnkgc3RhdHVzIHVzaW5nIEdTSVxuICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICAgIEluZGV4TmFtZTogJ3N0YXR1cy1pbmRleCcsXG4gICAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnI3N0YXR1cyA9IDpzdGF0dXMnLFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7ICcjc3RhdHVzJzogJ3N0YXR1cycgfSxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHsgJzpzdGF0dXMnOiBzdGF0dXMgfSxcbiAgICAgIExpbWl0OiBsaW1pdCxcbiAgICAgIFNjYW5JbmRleEZvcndhcmQ6IGZhbHNlLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gICAgaXRlbXMgPSByZXN1bHQuSXRlbXMgfHwgW107XG4gIH0gZWxzZSB7XG4gICAgLy8gU2NhbiBhbGwgZGV2aWNlcyAoZm9yIHNtYWxsIGZsZWV0cylcbiAgICBjb25zdCBjb21tYW5kID0gbmV3IFNjYW5Db21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICAgIExpbWl0OiBsaW1pdCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICAgIGl0ZW1zID0gcmVzdWx0Lkl0ZW1zIHx8IFtdO1xuICB9XG5cbiAgLy8gVHJhbnNmb3JtIGFuZCBjYWxjdWxhdGUgZmxlZXQgc3RhdHNcbiAgY29uc3QgdHJhbnNmb3JtZWREZXZpY2VzID0gaXRlbXMubWFwKHRyYW5zZm9ybURldmljZSk7XG4gIGNvbnN0IHN0YXRzID0gY2FsY3VsYXRlU3RhdHMoaXRlbXMpO1xuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgZGV2aWNlczogdHJhbnNmb3JtZWREZXZpY2VzLFxuICAgICAgY291bnQ6IHRyYW5zZm9ybWVkRGV2aWNlcy5sZW5ndGgsXG4gICAgICBzdGF0cyxcbiAgICB9KSxcbiAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0RGV2aWNlQnlTZXJpYWwoXG4gIHNlcmlhbE51bWJlcjogc3RyaW5nLFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICAvLyBSZXNvbHZlIHNlcmlhbF9udW1iZXIgdG8gZGV2aWNlIGluZm9cbiAgY29uc3QgcmVzb2x2ZWQgPSBhd2FpdCByZXNvbHZlRGV2aWNlKHNlcmlhbE51bWJlcik7XG5cbiAgaWYgKCFyZXNvbHZlZCkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDQsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0RldmljZSBub3QgZm91bmQnIH0pLFxuICAgIH07XG4gIH1cblxuICAvLyBHZXQgdGhlIGRldmljZSB1c2luZyB0aGUgY3VycmVudCBkZXZpY2VfdWlkXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgR2V0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgIEtleTogeyBkZXZpY2VfdWlkOiByZXNvbHZlZC5kZXZpY2VfdWlkIH0sXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuXG4gIGlmICghcmVzdWx0Lkl0ZW0pIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdEZXZpY2Ugbm90IGZvdW5kJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gVHJhbnNmb3JtIGFuZCBhZGQgZGV2aWNlX3VpZCBoaXN0b3J5XG4gIGNvbnN0IGRldmljZSA9IHRyYW5zZm9ybURldmljZShyZXN1bHQuSXRlbSk7XG4gIGRldmljZS5kZXZpY2VfdWlkX2hpc3RvcnkgPSByZXNvbHZlZC5hbGxfZGV2aWNlX3VpZHMubGVuZ3RoID4gMVxuICAgID8gcmVzb2x2ZWQuYWxsX2RldmljZV91aWRzLnNsaWNlKDEpIC8vIEV4Y2x1ZGUgY3VycmVudCBkZXZpY2VfdWlkXG4gICAgOiB1bmRlZmluZWQ7XG5cbiAgcmV0dXJuIHtcbiAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgaGVhZGVycyxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeShkZXZpY2UpLFxuICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiB1cGRhdGVEZXZpY2VCeVNlcmlhbChcbiAgc2VyaWFsTnVtYmVyOiBzdHJpbmcsXG4gIGJvZHk6IHN0cmluZyB8IG51bGwsXG4gIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiB7XG4gIGlmICghYm9keSkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1JlcXVlc3QgYm9keSByZXF1aXJlZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8vIFJlc29sdmUgc2VyaWFsX251bWJlciB0byBkZXZpY2VfdWlkXG4gIGNvbnN0IHJlc29sdmVkID0gYXdhaXQgcmVzb2x2ZURldmljZShzZXJpYWxOdW1iZXIpO1xuXG4gIGlmICghcmVzb2x2ZWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdEZXZpY2Ugbm90IGZvdW5kJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgdXBkYXRlcyA9IEpTT04ucGFyc2UoYm9keSk7XG5cbiAgLy8gT25seSBhbGxvdyBjZXJ0YWluIGZpZWxkcyB0byBiZSB1cGRhdGVkIChyZW1vdmVkIHNlcmlhbF9udW1iZXIgLSBpdCdzIG5vdyBpbW11dGFibGUpXG4gIGNvbnN0IGFsbG93ZWRGaWVsZHMgPSBbJ25hbWUnLCAnYXNzaWduZWRfdG8nLCAnYXNzaWduZWRfdG9fbmFtZScsICdmbGVldCcsICdub3RlcyddO1xuICBjb25zdCB1cGRhdGVFeHByZXNzaW9uczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gIGNvbnN0IGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7fTtcblxuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyh1cGRhdGVzKSkge1xuICAgIGlmIChhbGxvd2VkRmllbGRzLmluY2x1ZGVzKGtleSkpIHtcbiAgICAgIGNvbnN0IGF0dHJOYW1lID0gYCMke2tleX1gO1xuICAgICAgY29uc3QgYXR0clZhbHVlID0gYDoke2tleX1gO1xuICAgICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaChgJHthdHRyTmFtZX0gPSAke2F0dHJWYWx1ZX1gKTtcbiAgICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1thdHRyTmFtZV0gPSBrZXk7XG4gICAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzW2F0dHJWYWx1ZV0gPSB2YWx1ZTtcbiAgICB9XG4gIH1cblxuICBpZiAodXBkYXRlRXhwcmVzc2lvbnMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnTm8gdmFsaWQgZmllbGRzIHRvIHVwZGF0ZScgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8vIEFsd2F5cyB1cGRhdGUgdXBkYXRlZF9hdFxuICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjdXBkYXRlZF9hdCA9IDp1cGRhdGVkX2F0Jyk7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3VwZGF0ZWRfYXQnXSA9ICd1cGRhdGVkX2F0JztcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnVwZGF0ZWRfYXQnXSA9IERhdGUubm93KCk7XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBVcGRhdGVDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IERFVklDRVNfVEFCTEUsXG4gICAgS2V5OiB7IGRldmljZV91aWQ6IHJlc29sdmVkLmRldmljZV91aWQgfSxcbiAgICBVcGRhdGVFeHByZXNzaW9uOiAnU0VUICcgKyB1cGRhdGVFeHByZXNzaW9ucy5qb2luKCcsICcpLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczogZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXMsXG4gICAgUmV0dXJuVmFsdWVzOiAnQUxMX05FVycsXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkodHJhbnNmb3JtRGV2aWNlKHJlc3VsdC5BdHRyaWJ1dGVzKSksXG4gIH07XG59XG5cbi8qKlxuICogQ2FsY3VsYXRlIGRldmljZSBzdGF0dXMgYmFzZWQgb24gbGFzdF9zZWVuIHRpbWVzdGFtcFxuICogT25saW5lIGlmIHNlZW4gd2l0aGluIDE1IG1pbnV0ZXMsIG9mZmxpbmUgb3RoZXJ3aXNlXG4gKi9cbmZ1bmN0aW9uIGNhbGN1bGF0ZURldmljZVN0YXR1cyhpdGVtOiBhbnkpOiBzdHJpbmcge1xuICBpZiAoaXRlbS5zdGF0dXMgPT09ICdhbGVydCcpIHtcbiAgICByZXR1cm4gJ2FsZXJ0JztcbiAgfVxuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBjb25zdCBvZmZsaW5lVGhyZXNob2xkID0gMTUgKiA2MCAqIDEwMDA7IC8vIDE1IG1pbnV0ZXNcbiAgaWYgKGl0ZW0ubGFzdF9zZWVuICYmIG5vdyAtIGl0ZW0ubGFzdF9zZWVuIDwgb2ZmbGluZVRocmVzaG9sZCkge1xuICAgIHJldHVybiAnb25saW5lJztcbiAgfVxuICByZXR1cm4gJ29mZmxpbmUnO1xufVxuXG4vKipcbiAqIFRyYW5zZm9ybSBEeW5hbW9EQiBkZXZpY2UgcmVjb3JkIHRvIGZyb250ZW5kIGZvcm1hdFxuICogRmxhdHRlbnMgbmVzdGVkIG9iamVjdHMgbGlrZSBsYXN0X2xvY2F0aW9uIGFuZCBsYXN0X3RlbGVtZXRyeVxuICovXG5mdW5jdGlvbiB0cmFuc2Zvcm1EZXZpY2UoaXRlbTogYW55KTogYW55IHtcbiAgY29uc3QgZGV2aWNlOiBhbnkgPSB7XG4gICAgZGV2aWNlX3VpZDogaXRlbS5kZXZpY2VfdWlkLFxuICAgIHNlcmlhbF9udW1iZXI6IGl0ZW0uc2VyaWFsX251bWJlcixcbiAgICBuYW1lOiBpdGVtLm5hbWUsXG4gICAgZmxlZXQ6IGl0ZW0uZmxlZXQsXG4gICAgc3RhdHVzOiBjYWxjdWxhdGVEZXZpY2VTdGF0dXMoaXRlbSksXG4gICAgLy8gQ29udmVydCBtaWxsaXNlY29uZCB0aW1lc3RhbXAgdG8gSVNPIHN0cmluZyBmb3IgZnJvbnRlbmRcbiAgICBsYXN0X3NlZW46IGl0ZW0ubGFzdF9zZWVuID8gbmV3IERhdGUoaXRlbS5sYXN0X3NlZW4pLnRvSVNPU3RyaW5nKCkgOiB1bmRlZmluZWQsXG4gICAgbW9kZTogaXRlbS5jdXJyZW50X21vZGUsXG4gICAgcGVuZGluZ19tb2RlOiBpdGVtLnBlbmRpbmdfbW9kZSB8fCBudWxsLFxuICAgIHRyYW5zaXRfbG9ja2VkOiBpdGVtLnRyYW5zaXRfbG9ja2VkIHx8IGZhbHNlLFxuICAgIGRlbW9fbG9ja2VkOiBpdGVtLmRlbW9fbG9ja2VkIHx8IGZhbHNlLFxuICAgIGdwc19wb3dlcl9zYXZpbmc6IGl0ZW0uZ3BzX3Bvd2VyX3NhdmluZyB8fCBmYWxzZSxcbiAgICBncHNfbm9fc2F0OiBpdGVtLmdwc19ub19zYXQgfHwgZmFsc2UsXG4gICAgdXNiX3Bvd2VyZWQ6IGl0ZW0udXNiX3Bvd2VyZWQgfHwgZmFsc2UsXG4gICAgY3JlYXRlZF9hdDogaXRlbS5jcmVhdGVkX2F0ID8gbmV3IERhdGUoaXRlbS5jcmVhdGVkX2F0KS50b0lTT1N0cmluZygpIDogdW5kZWZpbmVkLFxuICAgIHVwZGF0ZWRfYXQ6IGl0ZW0udXBkYXRlZF9hdCA/IG5ldyBEYXRlKGl0ZW0udXBkYXRlZF9hdCkudG9JU09TdHJpbmcoKSA6IHVuZGVmaW5lZCxcbiAgICBhc3NpZ25lZF90bzogaXRlbS5hc3NpZ25lZF90byxcbiAgICBhc3NpZ25lZF90b19uYW1lOiBpdGVtLmFzc2lnbmVkX3RvX25hbWUsXG4gIH07XG5cbiAgLy8gRmxhdHRlbiBsYXN0X2xvY2F0aW9uXG4gIGlmIChpdGVtLmxhc3RfbG9jYXRpb24pIHtcbiAgICBkZXZpY2UubGF0aXR1ZGUgPSBpdGVtLmxhc3RfbG9jYXRpb24ubGF0O1xuICAgIGRldmljZS5sb25naXR1ZGUgPSBpdGVtLmxhc3RfbG9jYXRpb24ubG9uO1xuICAgIC8vIENvbnZlcnQgVW5peCB0aW1lc3RhbXAgKHNlY29uZHMpIHRvIElTTyBzdHJpbmcgZm9yIGZyb250ZW5kXG4gICAgaWYgKGl0ZW0ubGFzdF9sb2NhdGlvbi50aW1lKSB7XG4gICAgICAvLyBOb3RlaHViIHRpbWVzdGFtcHMgYXJlIGluIHNlY29uZHMsIGNvbnZlcnQgdG8gbWlsbGlzZWNvbmRzIGZvciBEYXRlXG4gICAgICBjb25zdCB0aW1lTXMgPSBpdGVtLmxhc3RfbG9jYXRpb24udGltZSAqIDEwMDA7XG4gICAgICBkZXZpY2UubG9jYXRpb25fdGltZSA9IG5ldyBEYXRlKHRpbWVNcykudG9JU09TdHJpbmcoKTtcbiAgICB9XG4gICAgZGV2aWNlLmxvY2F0aW9uX3NvdXJjZSA9IGl0ZW0ubGFzdF9sb2NhdGlvbi5zb3VyY2U7XG4gICAgZGV2aWNlLmxvY2F0aW9uX25hbWUgPSBpdGVtLmxhc3RfbG9jYXRpb24ubmFtZTtcbiAgfVxuXG4gIC8vIEZsYXR0ZW4gbGFzdF90ZWxlbWV0cnlcbiAgaWYgKGl0ZW0ubGFzdF90ZWxlbWV0cnkpIHtcbiAgICBkZXZpY2UudGVtcGVyYXR1cmUgPSBpdGVtLmxhc3RfdGVsZW1ldHJ5LnRlbXA7XG4gICAgZGV2aWNlLmh1bWlkaXR5ID0gaXRlbS5sYXN0X3RlbGVtZXRyeS5odW1pZGl0eTtcbiAgICBkZXZpY2UucHJlc3N1cmUgPSBpdGVtLmxhc3RfdGVsZW1ldHJ5LnByZXNzdXJlO1xuICAgIC8vIE5vdGU6IHZvbHRhZ2Ugbm8gbG9uZ2VyIGNvbWVzIGZyb20gbGFzdF90ZWxlbWV0cnk7IGl0J3Mgc2V0IGZyb20gX2xvZy5xby9faGVhbHRoLnFvXG4gICAgZGV2aWNlLm1vdGlvbiA9IGl0ZW0ubGFzdF90ZWxlbWV0cnkubW90aW9uO1xuICB9XG5cbiAgLy8gVm9sdGFnZSBjb21lcyBmcm9tIGRldmljZS52b2x0YWdlIGZpZWxkIChzZXQgZnJvbSBfbG9nLnFvIG9yIF9oZWFsdGgucW8gZXZlbnRzKVxuICBpZiAoaXRlbS52b2x0YWdlICE9PSB1bmRlZmluZWQpIHtcbiAgICBkZXZpY2Uudm9sdGFnZSA9IGl0ZW0udm9sdGFnZTtcbiAgfVxuXG4gIC8vIEZsYXR0ZW4gbGFzdF9wb3dlciAoTW9qbyBkYXRhKVxuICBpZiAoaXRlbS5sYXN0X3Bvd2VyKSB7XG4gICAgZGV2aWNlLm1vam9fdm9sdGFnZSA9IGl0ZW0ubGFzdF9wb3dlci52b2x0YWdlO1xuICAgIGRldmljZS5tb2pvX3RlbXBlcmF0dXJlID0gaXRlbS5sYXN0X3Bvd2VyLnRlbXBlcmF0dXJlO1xuICAgIGRldmljZS5taWxsaWFtcF9ob3VycyA9IGl0ZW0ubGFzdF9wb3dlci5taWxsaWFtcF9ob3VycztcbiAgfVxuXG4gIC8vIEZpcm13YXJlIHZlcnNpb25zIChmcm9tIF9zZXNzaW9uLnFvIGV2ZW50cylcbiAgaWYgKGl0ZW0uZmlybXdhcmVfdmVyc2lvbikge1xuICAgIGRldmljZS5maXJtd2FyZV92ZXJzaW9uID0gaXRlbS5maXJtd2FyZV92ZXJzaW9uO1xuICB9XG4gIGlmIChpdGVtLm5vdGVjYXJkX3ZlcnNpb24pIHtcbiAgICBkZXZpY2Uubm90ZWNhcmRfdmVyc2lvbiA9IGl0ZW0ubm90ZWNhcmRfdmVyc2lvbjtcbiAgfVxuICBpZiAoaXRlbS5ub3RlY2FyZF9za3UpIHtcbiAgICBkZXZpY2Uubm90ZWNhcmRfc2t1ID0gaXRlbS5ub3RlY2FyZF9za3U7XG4gIH1cblxuICByZXR1cm4gZGV2aWNlO1xufVxuXG5mdW5jdGlvbiBjYWxjdWxhdGVTdGF0cyhkZXZpY2VzOiBhbnlbXSk6IFJlY29yZDxzdHJpbmcsIGFueT4ge1xuICBjb25zdCBzdGF0cyA9IHtcbiAgICB0b3RhbDogZGV2aWNlcy5sZW5ndGgsXG4gICAgb25saW5lOiAwLFxuICAgIG9mZmxpbmU6IDAsXG4gICAgYWxlcnQ6IDAsXG4gICAgbG93X2JhdHRlcnk6IDAsXG4gICAgZmxlZXRzOiB7fSBhcyBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+LFxuICB9O1xuXG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGNvbnN0IG9mZmxpbmVUaHJlc2hvbGQgPSAxNSAqIDYwICogMTAwMDsgLy8gMTUgbWludXRlc1xuXG4gIGZvciAoY29uc3QgZGV2aWNlIG9mIGRldmljZXMpIHtcbiAgICAvLyBTdGF0dXMgY291bnRzXG4gICAgaWYgKGRldmljZS5zdGF0dXMgPT09ICdhbGVydCcpIHtcbiAgICAgIHN0YXRzLmFsZXJ0Kys7XG4gICAgfSBlbHNlIGlmIChkZXZpY2UubGFzdF9zZWVuICYmIG5vdyAtIGRldmljZS5sYXN0X3NlZW4gPCBvZmZsaW5lVGhyZXNob2xkKSB7XG4gICAgICBzdGF0cy5vbmxpbmUrKztcbiAgICB9IGVsc2Uge1xuICAgICAgc3RhdHMub2ZmbGluZSsrO1xuICAgIH1cblxuICAgIC8vIExvdyBiYXR0ZXJ5IGNoZWNrICh2b2x0YWdlIGNvbWVzIGZyb20gX2xvZy5xby9faGVhbHRoLnFvLCBzdG9yZWQgaW4gZGV2aWNlLnZvbHRhZ2UpXG4gICAgaWYgKGRldmljZS52b2x0YWdlICYmIGRldmljZS52b2x0YWdlIDwgMy40KSB7XG4gICAgICBzdGF0cy5sb3dfYmF0dGVyeSsrO1xuICAgIH1cblxuICAgIC8vIEZsZWV0IGNvdW50c1xuICAgIGNvbnN0IGZsZWV0ID0gZGV2aWNlLmZsZWV0IHx8ICdkZWZhdWx0JztcbiAgICBzdGF0cy5mbGVldHNbZmxlZXRdID0gKHN0YXRzLmZsZWV0c1tmbGVldF0gfHwgMCkgKyAxO1xuICB9XG5cbiAgcmV0dXJuIHN0YXRzO1xufVxuXG4vKipcbiAqIE1lcmdlIHR3byBkZXZpY2VzIGludG8gb25lIChBZG1pbiBvbmx5KVxuICogVGhlIHNvdXJjZSBkZXZpY2UncyBkZXZpY2VfdWlkIGlzIGFkZGVkIHRvIHRoZSB0YXJnZXQncyBhbGlhcyBoaXN0b3J5LFxuICogYW5kIHRoZSBzb3VyY2UgZGV2aWNlIHJlY29yZCBpcyBkZWxldGVkLlxuICovXG5hc3luYyBmdW5jdGlvbiBtZXJnZURldmljZXMoXG4gIGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudCxcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgLy8gQ2hlY2sgZm9yIGFkbWluIGF1dGhvcml6YXRpb25cbiAgY29uc3QgY2xhaW1zID0gKGV2ZW50LnJlcXVlc3RDb250ZXh0IGFzIGFueSk/LmF1dGhvcml6ZXI/Lmp3dD8uY2xhaW1zIHx8IHt9O1xuICBjb25zdCBncm91cHMgPSBjbGFpbXNbJ2NvZ25pdG86Z3JvdXBzJ10gfHwgJyc7XG4gIGNvbnN0IGlzQWRtaW4gPSBncm91cHMuaW5jbHVkZXMoJ0FkbWluJyk7XG5cbiAgaWYgKCFpc0FkbWluKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwMyxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnQWRtaW4gYWNjZXNzIHJlcXVpcmVkIHRvIG1lcmdlIGRldmljZXMnIH0pLFxuICAgIH07XG4gIH1cblxuICBpZiAoIWV2ZW50LmJvZHkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdSZXF1ZXN0IGJvZHkgcmVxdWlyZWQnIH0pLFxuICAgIH07XG4gIH1cblxuICBjb25zdCB7IHNvdXJjZV9zZXJpYWxfbnVtYmVyLCB0YXJnZXRfc2VyaWFsX251bWJlciB9ID0gSlNPTi5wYXJzZShldmVudC5ib2R5KTtcblxuICBpZiAoIXNvdXJjZV9zZXJpYWxfbnVtYmVyIHx8ICF0YXJnZXRfc2VyaWFsX251bWJlcikge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0JvdGggc291cmNlX3NlcmlhbF9udW1iZXIgYW5kIHRhcmdldF9zZXJpYWxfbnVtYmVyIGFyZSByZXF1aXJlZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIGlmIChzb3VyY2Vfc2VyaWFsX251bWJlciA9PT0gdGFyZ2V0X3NlcmlhbF9udW1iZXIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdTb3VyY2UgYW5kIHRhcmdldCBjYW5ub3QgYmUgdGhlIHNhbWUgZGV2aWNlJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gR2V0IGJvdGggZGV2aWNlc1xuICBjb25zdCBzb3VyY2VBbGlhcyA9IGF3YWl0IGdldEFsaWFzQnlTZXJpYWwoc291cmNlX3NlcmlhbF9udW1iZXIpO1xuICBjb25zdCB0YXJnZXRBbGlhcyA9IGF3YWl0IGdldEFsaWFzQnlTZXJpYWwodGFyZ2V0X3NlcmlhbF9udW1iZXIpO1xuXG4gIGlmICghc291cmNlQWxpYXMpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6IGBTb3VyY2UgZGV2aWNlIG5vdCBmb3VuZDogJHtzb3VyY2Vfc2VyaWFsX251bWJlcn1gIH0pLFxuICAgIH07XG4gIH1cblxuICBpZiAoIXRhcmdldEFsaWFzKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwNCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBgVGFyZ2V0IGRldmljZSBub3QgZm91bmQ6ICR7dGFyZ2V0X3NlcmlhbF9udW1iZXJ9YCB9KSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3Qgc291cmNlRGV2aWNlVWlkID0gc291cmNlQWxpYXMuZGV2aWNlX3VpZDtcbiAgY29uc3QgdGFyZ2V0RGV2aWNlVWlkID0gdGFyZ2V0QWxpYXMuZGV2aWNlX3VpZDtcbiAgY29uc3Qgc291cmNlUHJldmlvdXNVaWRzID0gc291cmNlQWxpYXMucHJldmlvdXNfZGV2aWNlX3VpZHMgfHwgW107XG4gIGNvbnN0IHRhcmdldFByZXZpb3VzVWlkcyA9IHRhcmdldEFsaWFzLnByZXZpb3VzX2RldmljZV91aWRzIHx8IFtdO1xuXG4gIC8vIE1lcmdlIGFsbCBkZXZpY2VfdWlkczogdGFyZ2V0J3MgcHJldmlvdXMgKyBzb3VyY2UncyBjdXJyZW50ICsgc291cmNlJ3MgcHJldmlvdXNcbiAgY29uc3QgYWxsUHJldmlvdXNVaWRzID0gW1xuICAgIC4uLm5ldyBTZXQoW1xuICAgICAgLi4udGFyZ2V0UHJldmlvdXNVaWRzLFxuICAgICAgc291cmNlRGV2aWNlVWlkLFxuICAgICAgLi4uc291cmNlUHJldmlvdXNVaWRzLFxuICAgIF0pLFxuICBdO1xuXG4gIC8vIFVwZGF0ZSB0YXJnZXQgYWxpYXMgdG8gaW5jbHVkZSBzb3VyY2UgZGV2aWNlX3VpZHNcbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IFB1dENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogREVWSUNFX0FMSUFTRVNfVEFCTEUsXG4gICAgSXRlbToge1xuICAgICAgc2VyaWFsX251bWJlcjogdGFyZ2V0X3NlcmlhbF9udW1iZXIsXG4gICAgICBkZXZpY2VfdWlkOiB0YXJnZXREZXZpY2VVaWQsXG4gICAgICBwcmV2aW91c19kZXZpY2VfdWlkczogYWxsUHJldmlvdXNVaWRzLFxuICAgICAgY3JlYXRlZF9hdDogdGFyZ2V0QWxpYXMuY3JlYXRlZF9hdCxcbiAgICAgIHVwZGF0ZWRfYXQ6IERhdGUubm93KCksXG4gICAgfSxcbiAgfSkpO1xuXG4gIC8vIERlbGV0ZSBzb3VyY2UgYWxpYXNcbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IERlbGV0ZUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogREVWSUNFX0FMSUFTRVNfVEFCTEUsXG4gICAgS2V5OiB7IHNlcmlhbF9udW1iZXI6IHNvdXJjZV9zZXJpYWxfbnVtYmVyIH0sXG4gIH0pKTtcblxuICAvLyBEZWxldGUgc291cmNlIGRldmljZSByZWNvcmRcbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IERlbGV0ZUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICBLZXk6IHsgZGV2aWNlX3VpZDogc291cmNlRGV2aWNlVWlkIH0sXG4gIH0pKTtcblxuICAvLyBDcmVhdGUgYWN0aXZpdHkgZmVlZCBldmVudFxuICBjb25zdCBhY3Rpdml0eUV2ZW50ID0ge1xuICAgIGV2ZW50X2lkOiBgbWVyZ2UtJHtEYXRlLm5vdygpfS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnN1YnN0cmluZyg3KX1gLFxuICAgIGRldmljZV91aWQ6IHRhcmdldERldmljZVVpZCxcbiAgICBzZXJpYWxfbnVtYmVyOiB0YXJnZXRfc2VyaWFsX251bWJlcixcbiAgICBldmVudF90eXBlOiAnZGV2aWNlX21lcmdlZCcsXG4gICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgIGRhdGE6IHtcbiAgICAgIHNvdXJjZV9zZXJpYWxfbnVtYmVyLFxuICAgICAgc291cmNlX2RldmljZV91aWQ6IHNvdXJjZURldmljZVVpZCxcbiAgICAgIHRhcmdldF9zZXJpYWxfbnVtYmVyLFxuICAgICAgdGFyZ2V0X2RldmljZV91aWQ6IHRhcmdldERldmljZVVpZCxcbiAgICAgIG1lcmdlZF9kZXZpY2VfdWlkczogYWxsUHJldmlvdXNVaWRzLFxuICAgIH0sXG4gIH07XG5cbiAgdHJ5IHtcbiAgICBhd2FpdCBkb2NDbGllbnQuc2VuZChuZXcgUHV0Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IEFDVElWSVRZX1RBQkxFLFxuICAgICAgSXRlbTogYWN0aXZpdHlFdmVudCxcbiAgICB9KSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIEFjdGl2aXR5IGxvZ2dpbmcgaXMgbm9uLWNyaXRpY2FsLCBsb2cgYnV0IGRvbid0IGZhaWxcbiAgICBjb25zb2xlLmVycm9yKCdGYWlsZWQgdG8gbG9nIG1lcmdlIGFjdGl2aXR5OicsIGVycik7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICBoZWFkZXJzLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIG1lc3NhZ2U6ICdEZXZpY2VzIG1lcmdlZCBzdWNjZXNzZnVsbHknLFxuICAgICAgdGFyZ2V0X3NlcmlhbF9udW1iZXIsXG4gICAgICB0YXJnZXRfZGV2aWNlX3VpZDogdGFyZ2V0RGV2aWNlVWlkLFxuICAgICAgbWVyZ2VkX2RldmljZV91aWRzOiBbdGFyZ2V0RGV2aWNlVWlkLCAuLi5hbGxQcmV2aW91c1VpZHNdLFxuICAgICAgZGVsZXRlZF9zZXJpYWxfbnVtYmVyOiBzb3VyY2Vfc2VyaWFsX251bWJlcixcbiAgICAgIGRlbGV0ZWRfZGV2aWNlX3VpZDogc291cmNlRGV2aWNlVWlkLFxuICAgIH0pLFxuICB9O1xufVxuIl19