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
    const method = event.requestContext?.http?.method || event.httpMethod;
    const path = event.rawPath || event.path || '';
    console.log('Request:', JSON.stringify(event));
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    };
    try {
        // HTTP API v2 uses requestContext.http.method, REST API v1 uses httpMethod
        const serialNumber = event.pathParameters?.serial_number;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWRldmljZXMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7O0dBT0c7OztBQUVILDhEQUEwRDtBQUMxRCx3REFRK0I7QUFFL0IsMkRBQTBFO0FBRTFFLE1BQU0sU0FBUyxHQUFHLElBQUksZ0NBQWMsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN6QyxNQUFNLFNBQVMsR0FBRyxxQ0FBc0IsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7QUFFekQsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxhQUFjLENBQUM7QUFDakQsTUFBTSxvQkFBb0IsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLG9CQUFvQixJQUFJLHlCQUF5QixDQUFDO0FBQzNGLE1BQU0sY0FBYyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsY0FBYyxJQUFJLG1CQUFtQixDQUFDO0FBRWxFLE1BQU0sT0FBTyxHQUFHLEtBQUssRUFBRSxLQUEyQixFQUFrQyxFQUFFO0lBQzNGLE1BQU0sTUFBTSxHQUFJLEtBQUssQ0FBQyxjQUFzQixFQUFFLElBQUksRUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLFVBQVUsQ0FBQztJQUMvRSxNQUFNLElBQUksR0FBSSxLQUFhLENBQUMsT0FBTyxJQUFJLEtBQUssQ0FBQyxJQUFJLElBQUksRUFBRSxDQUFDO0lBRXhELE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUUvQyxNQUFNLFdBQVcsR0FBRztRQUNsQiw2QkFBNkIsRUFBRSxHQUFHO1FBQ2xDLDhCQUE4QixFQUFFLDRCQUE0QjtRQUM1RCw4QkFBOEIsRUFBRSwrQkFBK0I7S0FDaEUsQ0FBQztJQUVGLElBQUksQ0FBQztRQUNILDJFQUEyRTtRQUMzRSxNQUFNLFlBQVksR0FBRyxL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QUFDLE1BQU0sRUFBRSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUU7UUFDMUUsVUFBVSxFQUFFLGVBQWU7UUFDM0IsYUFBYSxFQUFFLG9CQUFvQjtRQUNuQyxVQUFVLEVBQUUsZUFBZTtRQUMzQixTQUFTLEVBQUUsSUFBSSxDQUFDLEdBQUcsRUFBRTtRQUNyQixJQUFJLEVBQUU7WUFDSixvQkFBb0I7WUFDcEIsaUJBQWlCLEVBQUUsZUFBZTtZQUNsQyxvQkFBb0I7WUFDcEIsaUJBQWlCLEVBQUUsZUFBZTtZQUNsQyxrQkFBa0IsRUFBRSxlQUFlO1NBQ3BDO0tBQ0YsQ0FBQztJQUVGLElBQUksQ0FBQztRQUNILE1BQU0sU0FBUyxDQUFDLElBQUksQ0FBQyxJQUFJLHlCQUFVLENBQUM7WUFDbEMsU0FBUyxFQUFFLGNBQWM7WUFDekIsSUFBSSxFQUFFLGFBQWE7U0FDcEIsQ0FBQyxDQUFDLENBQUM7SUFDTixDQUFDO0lBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztRQUNiLHVEQUF1RDtRQUN2RCxPQUFPLENBQUMsS0FBSyxDQUFDLCtCQUErQixFQUFFLEdBQUcsQ0FBQyxDQUFDO0lBQ3RELENBQUM7SUFFRCxPQUFPO1FBQ0wsVUFBVSxFQUFFLEdBQUc7UUFDZixPQUFPO1FBQ1AsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUM7WUFDbkIsT0FBTyxFQUFFLDZCQUE2QjtZQUN0QyxvQkFBb0I7WUFDcEIsaUJBQWlCLEVBQUUsZUFBZTtZQUNsQyxrQkFBa0IsRUFBRSxDQUFDLGVBQWUsRUFBRSxHQUFHLGVBQWUsQ0FBQztZQUN6RCxxQkFBcUIsRUFBRSxvQkFBb0I7WUFDM0Msa0JBQWtCLEVBQUUsZUFBZTtTQUNwQyxDQUFDO0tBQ0gsQ0FBQztBQUNKLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIERldmljZXMgQVBJIExhbWJkYVxuICpcbiAqIEhhbmRsZXMgZGV2aWNlIENSVUQgb3BlcmF0aW9uczpcbiAqIC0gR0VUIC9kZXZpY2VzIC0gTGlzdCBhbGwgZGV2aWNlc1xuICogLSBHRVQgL2RldmljZXMve3NlcmlhbF9udW1iZXJ9IC0gR2V0IGRldmljZSBkZXRhaWxzXG4gKiAtIFBBVENIIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfSAtIFVwZGF0ZSBkZXZpY2UgbWV0YWRhdGFcbiAqL1xuXG5pbXBvcnQgeyBEeW5hbW9EQkNsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYic7XG5pbXBvcnQge1xuICBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LFxuICBTY2FuQ29tbWFuZCxcbiAgUXVlcnlDb21tYW5kLFxuICBHZXRDb21tYW5kLFxuICBVcGRhdGVDb21tYW5kLFxuICBEZWxldGVDb21tYW5kLFxuICBQdXRDb21tYW5kLFxufSBmcm9tICdAYXdzLXNkay9saWItZHluYW1vZGInO1xuaW1wb3J0IHsgQVBJR2F0ZXdheVByb3h5RXZlbnQsIEFQSUdhdGV3YXlQcm94eVJlc3VsdCB9IGZyb20gJ2F3cy1sYW1iZGEnO1xuaW1wb3J0IHsgcmVzb2x2ZURldmljZSwgZ2V0QWxpYXNCeVNlcmlhbCB9IGZyb20gJy4uL3NoYXJlZC9kZXZpY2UtbG9va3VwJztcblxuY29uc3QgZGRiQ2xpZW50ID0gbmV3IER5bmFtb0RCQ2xpZW50KHt9KTtcbmNvbnN0IGRvY0NsaWVudCA9IER5bmFtb0RCRG9jdW1lbnRDbGllbnQuZnJvbShkZGJDbGllbnQpO1xuXG5jb25zdCBERVZJQ0VTX1RBQkxFID0gcHJvY2Vzcy5lbnYuREVWSUNFU19UQUJMRSE7XG5jb25zdCBERVZJQ0VfQUxJQVNFU19UQUJMRSA9IHByb2Nlc3MuZW52LkRFVklDRV9BTElBU0VTX1RBQkxFIHx8ICdzb25nYmlyZC1kZXZpY2UtYWxpYXNlcyc7XG5jb25zdCBBQ1RJVklUWV9UQUJMRSA9IHByb2Nlc3MuZW52LkFDVElWSVRZX1RBQkxFIHx8ICdzb25nYmlyZC1hY3Rpdml0eSc7XG5cbmV4cG9ydCBjb25zdCBoYW5kbGVyID0gYXN5bmMgKGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudCk6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiA9PiB7XG4gIGNvbnN0IG1ldGhvZCA9IChldmVudC5yZXF1ZXN0Q29udGV4dCBhcyBhbnkpPy5odHRwPy5tZXRob2QgfHwgZXZlbnQuaHR0cE1ldGhvZDtcbiAgY29uc3QgcGF0aCA9IChldmVudCBhcyBhbnkpLnJhd1BhdGggfHwgZXZlbnQucGF0aCB8fCAnJztcblxuICBjb25zb2xlLmxvZygnUmVxdWVzdDonLCBKU09OLnN0cmluZ2lmeShldmVudCkpO1xuXG4gIGNvbnN0IGNvcnNIZWFkZXJzID0ge1xuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nOiAnKicsXG4gICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnMnOiAnQ29udGVudC1UeXBlLEF1dGhvcml6YXRpb24nLFxuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzJzogJ0dFVCxQT1NULFBBVENILERFTEVURSxPUFRJT05TJyxcbiAgfTtcblxuICB0cnkge1xuICAgIC8vIEhUVFAgQVBJIHYyIHVzZXMgcmVxdWVzdENvbnRleHQuaHR0cC5tZXRob2QsIFJFU1QgQVBJIHYxIHVzZXMgaHR0cE1ldGhvZFxuICAgIGNvbnN0IHNlcmlhbE51bWJlciA9IGV2ZW50LnBhdGhQYXJhbWV0ZXJzPy5zZXJpYWxfbnVtYmVyO1xuXG4gICAgaWYgKG1ldGhvZCA9PT0gJ09QVElPTlMnKSB7XG4gICAgICByZXR1cm4geyBzdGF0dXNDb2RlOiAyMDAsIGhlYWRlcnM6IGNvcnNIZWFkZXJzLCBib2R5OiAnJyB9O1xuICAgIH1cblxuICAgIC8vIFBPU1QgL2RldmljZXMvbWVyZ2UgLSBNZXJnZSB0d28gZGV2aWNlcyAoQWRtaW4gb25seSlcbiAgICBpZiAobWV0aG9kID09PSAnUE9TVCcgJiYgcGF0aC5lbmRzV2l0aCgnL21lcmdlJykpIHtcbiAgICAgIHJldHVybiBhd2FpdCBtZXJnZURldmljZXMoZXZlbnQsIGNvcnNIZWFkZXJzKTtcbiAgICB9XG5cbiAgICBpZiAobWV0aG9kID09PSAnR0VUJyAmJiAhc2VyaWFsTnVtYmVyKSB7XG4gICAgICAvLyBMaXN0IGRldmljZXNcbiAgICAgIHJldHVybiBhd2FpdCBsaXN0RGV2aWNlcyhldmVudCwgY29yc0hlYWRlcnMpO1xuICAgIH1cblxuICAgIGlmIChtZXRob2QgPT09ICdHRVQnICYmIHNlcmlhbE51bWJlcikge1xuICAgICAgLy8gR2V0IHNpbmdsZSBkZXZpY2UgYnkgc2VyaWFsIG51bWJlclxuICAgICAgcmV0dXJuIGF3YWl0IGdldERldmljZUJ5U2VyaWFsKHNlcmlhbE51bWJlciwgY29yc0hlYWRlcnMpO1xuICAgIH1cblxuICAgIGlmIChtZXRob2QgPT09ICdQQVRDSCcgJiYgc2VyaWFsTnVtYmVyKSB7XG4gICAgICAvLyBVcGRhdGUgZGV2aWNlIGJ5IHNlcmlhbCBudW1iZXJcbiAgICAgIHJldHVybiBhd2FpdCB1cGRhdGVEZXZpY2VCeVNlcmlhbChzZXJpYWxOdW1iZXIsIGV2ZW50LmJvZHksIGNvcnNIZWFkZXJzKTtcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA1LFxuICAgICAgaGVhZGVyczogY29yc0hlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnTWV0aG9kIG5vdCBhbGxvd2VkJyB9KSxcbiAgICB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yOicsIGVycm9yKTtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNTAwLFxuICAgICAgaGVhZGVyczogY29yc0hlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnSW50ZXJuYWwgc2VydmVyIGVycm9yJyB9KSxcbiAgICB9O1xuICB9XG59O1xuXG5hc3luYyBmdW5jdGlvbiBsaXN0RGV2aWNlcyhcbiAgZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50LFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICBjb25zdCBxdWVyeVBhcmFtcyA9IGV2ZW50LnF1ZXJ5U3RyaW5nUGFyYW1ldGVycyB8fCB7fTtcbiAgY29uc3QgZmxlZXQgPSBxdWVyeVBhcmFtcy5mbGVldDtcbiAgY29uc3Qgc3RhdHVzID0gcXVlcnlQYXJhbXMuc3RhdHVzO1xuICBjb25zdCBsaW1pdCA9IHBhcnNlSW50KHF1ZXJ5UGFyYW1zLmxpbWl0IHx8ICcxMDAnKTtcblxuICBsZXQgaXRlbXM6IGFueVtdID0gW107XG5cbiAgaWYgKGZsZWV0KSB7XG4gICAgLy8gUXVlcnkgYnkgZmxlZXQgdXNpbmcgR1NJXG4gICAgY29uc3QgY29tbWFuZCA9IG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgICAgSW5kZXhOYW1lOiAnZmxlZXQtaW5kZXgnLFxuICAgICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJyNmbGVldCA9IDpmbGVldCcsXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHsgJyNmbGVldCc6ICdmbGVldCcgfSxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHsgJzpmbGVldCc6IGZsZWV0IH0sXG4gICAgICBMaW1pdDogbGltaXQsXG4gICAgICBTY2FuSW5kZXhGb3J3YXJkOiBmYWxzZSwgLy8gTW9zdCByZWNlbnQgZmlyc3RcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICAgIGl0ZW1zID0gcmVzdWx0Lkl0ZW1zIHx8IFtdO1xuICB9IGVsc2UgaWYgKHN0YXR1cykge1xuICAgIC8vIFF1ZXJ5IGJ5IHN0YXR1cyB1c2luZyBHU0lcbiAgICBjb25zdCBjb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IERFVklDRVNfVEFCTEUsXG4gICAgICBJbmRleE5hbWU6ICdzdGF0dXMtaW5kZXgnLFxuICAgICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJyNzdGF0dXMgPSA6c3RhdHVzJyxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczogeyAnI3N0YXR1cyc6ICdzdGF0dXMnIH0sXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7ICc6c3RhdHVzJzogc3RhdHVzIH0sXG4gICAgICBMaW1pdDogbGltaXQsXG4gICAgICBTY2FuSW5kZXhGb3J3YXJkOiBmYWxzZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICAgIGl0ZW1zID0gcmVzdWx0Lkl0ZW1zIHx8IFtdO1xuICB9IGVsc2Uge1xuICAgIC8vIFNjYW4gYWxsIGRldmljZXMgKGZvciBzbWFsbCBmbGVldHMpXG4gICAgY29uc3QgY29tbWFuZCA9IG5ldyBTY2FuQ29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IERFVklDRVNfVEFCTEUsXG4gICAgICBMaW1pdDogbGltaXQsXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgICBpdGVtcyA9IHJlc3VsdC5JdGVtcyB8fCBbXTtcbiAgfVxuXG4gIC8vIFRyYW5zZm9ybSBhbmQgY2FsY3VsYXRlIGZsZWV0IHN0YXRzXG4gIGNvbnN0IHRyYW5zZm9ybWVkRGV2aWNlcyA9IGl0ZW1zLm1hcCh0cmFuc2Zvcm1EZXZpY2UpO1xuICBjb25zdCBzdGF0cyA9IGNhbGN1bGF0ZVN0YXRzKGl0ZW1zKTtcblxuICByZXR1cm4ge1xuICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICBoZWFkZXJzLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIGRldmljZXM6IHRyYW5zZm9ybWVkRGV2aWNlcyxcbiAgICAgIGNvdW50OiB0cmFuc2Zvcm1lZERldmljZXMubGVuZ3RoLFxuICAgICAgc3RhdHMsXG4gICAgfSksXG4gIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldERldmljZUJ5U2VyaWFsKFxuICBzZXJpYWxOdW1iZXI6IHN0cmluZyxcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgLy8gUmVzb2x2ZSBzZXJpYWxfbnVtYmVyIHRvIGRldmljZSBpbmZvXG4gIGNvbnN0IHJlc29sdmVkID0gYXdhaXQgcmVzb2x2ZURldmljZShzZXJpYWxOdW1iZXIpO1xuXG4gIGlmICghcmVzb2x2ZWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdEZXZpY2Ugbm90IGZvdW5kJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gR2V0IHRoZSBkZXZpY2UgdXNpbmcgdGhlIGN1cnJlbnQgZGV2aWNlX3VpZFxuICBjb25zdCBjb21tYW5kID0gbmV3IEdldENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICBLZXk6IHsgZGV2aWNlX3VpZDogcmVzb2x2ZWQuZGV2aWNlX3VpZCB9LFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcblxuICBpZiAoIXJlc3VsdC5JdGVtKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwNCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRGV2aWNlIG5vdCBmb3VuZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8vIFRyYW5zZm9ybSBhbmQgYWRkIGRldmljZV91aWQgaGlzdG9yeVxuICBjb25zdCBkZXZpY2UgPSB0cmFuc2Zvcm1EZXZpY2UocmVzdWx0Lkl0ZW0pO1xuICBkZXZpY2UuZGV2aWNlX3VpZF9oaXN0b3J5ID0gcmVzb2x2ZWQuYWxsX2RldmljZV91aWRzLmxlbmd0aCA+IDFcbiAgICA/IHJlc29sdmVkLmFsbF9kZXZpY2VfdWlkcy5zbGljZSgxKSAvLyBFeGNsdWRlIGN1cnJlbnQgZGV2aWNlX3VpZFxuICAgIDogdW5kZWZpbmVkO1xuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoZGV2aWNlKSxcbiAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gdXBkYXRlRGV2aWNlQnlTZXJpYWwoXG4gIHNlcmlhbE51bWJlcjogc3RyaW5nLFxuICBib2R5OiBzdHJpbmcgfCBudWxsLFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICBpZiAoIWJvZHkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdSZXF1ZXN0IGJvZHkgcmVxdWlyZWQnIH0pLFxuICAgIH07XG4gIH1cblxuICAvLyBSZXNvbHZlIHNlcmlhbF9udW1iZXIgdG8gZGV2aWNlX3VpZFxuICBjb25zdCByZXNvbHZlZCA9IGF3YWl0IHJlc29sdmVEZXZpY2Uoc2VyaWFsTnVtYmVyKTtcblxuICBpZiAoIXJlc29sdmVkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwNCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRGV2aWNlIG5vdCBmb3VuZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHVwZGF0ZXMgPSBKU09OLnBhcnNlKGJvZHkpO1xuXG4gIC8vIE9ubHkgYWxsb3cgY2VydGFpbiBmaWVsZHMgdG8gYmUgdXBkYXRlZCAocmVtb3ZlZCBzZXJpYWxfbnVtYmVyIC0gaXQncyBub3cgaW1tdXRhYmxlKVxuICBjb25zdCBhbGxvd2VkRmllbGRzID0gWyduYW1lJywgJ2Fzc2lnbmVkX3RvJywgJ2Fzc2lnbmVkX3RvX25hbWUnLCAnZmxlZXQnLCAnbm90ZXMnXTtcbiAgY29uc3QgdXBkYXRlRXhwcmVzc2lvbnM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICBjb25zdCBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge307XG5cbiAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXModXBkYXRlcykpIHtcbiAgICBpZiAoYWxsb3dlZEZpZWxkcy5pbmNsdWRlcyhrZXkpKSB7XG4gICAgICBjb25zdCBhdHRyTmFtZSA9IGAjJHtrZXl9YDtcbiAgICAgIGNvbnN0IGF0dHJWYWx1ZSA9IGA6JHtrZXl9YDtcbiAgICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goYCR7YXR0ck5hbWV9ID0gJHthdHRyVmFsdWV9YCk7XG4gICAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbYXR0ck5hbWVdID0ga2V5O1xuICAgICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1thdHRyVmFsdWVdID0gdmFsdWU7XG4gICAgfVxuICB9XG5cbiAgaWYgKHVwZGF0ZUV4cHJlc3Npb25zLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ05vIHZhbGlkIGZpZWxkcyB0byB1cGRhdGUnIH0pLFxuICAgIH07XG4gIH1cblxuICAvLyBBbHdheXMgdXBkYXRlIHVwZGF0ZWRfYXRcbiAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3VwZGF0ZWRfYXQgPSA6dXBkYXRlZF9hdCcpO1xuICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyN1cGRhdGVkX2F0J10gPSAndXBkYXRlZF9hdCc7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzp1cGRhdGVkX2F0J10gPSBEYXRlLm5vdygpO1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgVXBkYXRlQ29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgIEtleTogeyBkZXZpY2VfdWlkOiByZXNvbHZlZC5kZXZpY2VfdWlkIH0sXG4gICAgVXBkYXRlRXhwcmVzc2lvbjogJ1NFVCAnICsgdXBkYXRlRXhwcmVzc2lvbnMuam9pbignLCAnKSxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lcyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzLFxuICAgIFJldHVyblZhbHVlczogJ0FMTF9ORVcnLFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcblxuICByZXR1cm4ge1xuICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICBoZWFkZXJzLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHRyYW5zZm9ybURldmljZShyZXN1bHQuQXR0cmlidXRlcykpLFxuICB9O1xufVxuXG4vKipcbiAqIENhbGN1bGF0ZSBkZXZpY2Ugc3RhdHVzIGJhc2VkIG9uIGxhc3Rfc2VlbiB0aW1lc3RhbXBcbiAqIE9ubGluZSBpZiBzZWVuIHdpdGhpbiAxNSBtaW51dGVzLCBvZmZsaW5lIG90aGVyd2lzZVxuICovXG5mdW5jdGlvbiBjYWxjdWxhdGVEZXZpY2VTdGF0dXMoaXRlbTogYW55KTogc3RyaW5nIHtcbiAgaWYgKGl0ZW0uc3RhdHVzID09PSAnYWxlcnQnKSB7XG4gICAgcmV0dXJuICdhbGVydCc7XG4gIH1cbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgY29uc3Qgb2ZmbGluZVRocmVzaG9sZCA9IDE1ICogNjAgKiAxMDAwOyAvLyAxNSBtaW51dGVzXG4gIGlmIChpdGVtLmxhc3Rfc2VlbiAmJiBub3cgLSBpdGVtLmxhc3Rfc2VlbiA8IG9mZmxpbmVUaHJlc2hvbGQpIHtcbiAgICByZXR1cm4gJ29ubGluZSc7XG4gIH1cbiAgcmV0dXJuICdvZmZsaW5lJztcbn1cblxuLyoqXG4gKiBUcmFuc2Zvcm0gRHluYW1vREIgZGV2aWNlIHJlY29yZCB0byBmcm9udGVuZCBmb3JtYXRcbiAqIEZsYXR0ZW5zIG5lc3RlZCBvYmplY3RzIGxpa2UgbGFzdF9sb2NhdGlvbiBhbmQgbGFzdF90ZWxlbWV0cnlcbiAqL1xuZnVuY3Rpb24gdHJhbnNmb3JtRGV2aWNlKGl0ZW06IGFueSk6IGFueSB7XG4gIGNvbnN0IGRldmljZTogYW55ID0ge1xuICAgIGRldmljZV91aWQ6IGl0ZW0uZGV2aWNlX3VpZCxcbiAgICBzZXJpYWxfbnVtYmVyOiBpdGVtLnNlcmlhbF9udW1iZXIsXG4gICAgbmFtZTogaXRlbS5uYW1lLFxuICAgIGZsZWV0OiBpdGVtLmZsZWV0LFxuICAgIHN0YXR1czogY2FsY3VsYXRlRGV2aWNlU3RhdHVzKGl0ZW0pLFxuICAgIC8vIENvbnZlcnQgbWlsbGlzZWNvbmQgdGltZXN0YW1wIHRvIElTTyBzdHJpbmcgZm9yIGZyb250ZW5kXG4gICAgbGFzdF9zZWVuOiBpdGVtLmxhc3Rfc2VlbiA/IG5ldyBEYXRlKGl0ZW0ubGFzdF9zZWVuKS50b0lTT1N0cmluZygpIDogdW5kZWZpbmVkLFxuICAgIG1vZGU6IGl0ZW0uY3VycmVudF9tb2RlLFxuICAgIHBlbmRpbmdfbW9kZTogaXRlbS5wZW5kaW5nX21vZGUgfHwgbnVsbCxcbiAgICB0cmFuc2l0X2xvY2tlZDogaXRlbS50cmFuc2l0X2xvY2tlZCB8fCBmYWxzZSxcbiAgICBkZW1vX2xvY2tlZDogaXRlbS5kZW1vX2xvY2tlZCB8fCBmYWxzZSxcbiAgICBncHNfcG93ZXJfc2F2aW5nOiBpdGVtLmdwc19wb3dlcl9zYXZpbmcgfHwgZmFsc2UsXG4gICAgZ3BzX25vX3NhdDogaXRlbS5ncHNfbm9fc2F0IHx8IGZhbHNlLFxuICAgIHVzYl9wb3dlcmVkOiBpdGVtLnVzYl9wb3dlcmVkIHx8IGZhbHNlLFxuICAgIGNyZWF0ZWRfYXQ6IGl0ZW0uY3JlYXRlZF9hdCA/IG5ldyBEYXRlKGl0ZW0uY3JlYXRlZF9hdCkudG9JU09TdHJpbmcoKSA6IHVuZGVmaW5lZCxcbiAgICB1cGRhdGVkX2F0OiBpdGVtLnVwZGF0ZWRfYXQgPyBuZXcgRGF0ZShpdGVtLnVwZGF0ZWRfYXQpLnRvSVNPU3RyaW5nKCkgOiB1bmRlZmluZWQsXG4gICAgYXNzaWduZWRfdG86IGl0ZW0uYXNzaWduZWRfdG8sXG4gICAgYXNzaWduZWRfdG9fbmFtZTogaXRlbS5hc3NpZ25lZF90b19uYW1lLFxuICB9O1xuXG4gIC8vIEZsYXR0ZW4gbGFzdF9sb2NhdGlvblxuICBpZiAoaXRlbS5sYXN0X2xvY2F0aW9uKSB7XG4gICAgZGV2aWNlLmxhdGl0dWRlID0gaXRlbS5sYXN0X2xvY2F0aW9uLmxhdDtcbiAgICBkZXZpY2UubG9uZ2l0dWRlID0gaXRlbS5sYXN0X2xvY2F0aW9uLmxvbjtcbiAgICAvLyBDb252ZXJ0IFVuaXggdGltZXN0YW1wIChzZWNvbmRzKSB0byBJU08gc3RyaW5nIGZvciBmcm9udGVuZFxuICAgIGlmIChpdGVtLmxhc3RfbG9jYXRpb24udGltZSkge1xuICAgICAgLy8gTm90ZWh1YiB0aW1lc3RhbXBzIGFyZSBpbiBzZWNvbmRzLCBjb252ZXJ0IHRvIG1pbGxpc2Vjb25kcyBmb3IgRGF0ZVxuICAgICAgY29uc3QgdGltZU1zID0gaXRlbS5sYXN0X2xvY2F0aW9uLnRpbWUgKiAxMDAwO1xuICAgICAgZGV2aWNlLmxvY2F0aW9uX3RpbWUgPSBuZXcgRGF0ZSh0aW1lTXMpLnRvSVNPU3RyaW5nKCk7XG4gICAgfVxuICAgIGRldmljZS5sb2NhdGlvbl9zb3VyY2UgPSBpdGVtLmxhc3RfbG9jYXRpb24uc291cmNlO1xuICAgIGRldmljZS5sb2NhdGlvbl9uYW1lID0gaXRlbS5sYXN0X2xvY2F0aW9uLm5hbWU7XG4gIH1cblxuICAvLyBGbGF0dGVuIGxhc3RfdGVsZW1ldHJ5XG4gIGlmIChpdGVtLmxhc3RfdGVsZW1ldHJ5KSB7XG4gICAgZGV2aWNlLnRlbXBlcmF0dXJlID0gaXRlbS5sYXN0X3RlbGVtZXRyeS50ZW1wO1xuICAgIGRldmljZS5odW1pZGl0eSA9IGl0ZW0ubGFzdF90ZWxlbWV0cnkuaHVtaWRpdHk7XG4gICAgZGV2aWNlLnByZXNzdXJlID0gaXRlbS5sYXN0X3RlbGVtZXRyeS5wcmVzc3VyZTtcbiAgICAvLyBOb3RlOiB2b2x0YWdlIG5vIGxvbmdlciBjb21lcyBmcm9tIGxhc3RfdGVsZW1ldHJ5OyBpdCdzIHNldCBmcm9tIF9sb2cucW8vX2hlYWx0aC5xb1xuICAgIGRldmljZS5tb3Rpb24gPSBpdGVtLmxhc3RfdGVsZW1ldHJ5Lm1vdGlvbjtcbiAgfVxuXG4gIC8vIFZvbHRhZ2UgY29tZXMgZnJvbSBkZXZpY2Uudm9sdGFnZSBmaWVsZCAoc2V0IGZyb20gX2xvZy5xbyBvciBfaGVhbHRoLnFvIGV2ZW50cylcbiAgaWYgKGl0ZW0udm9sdGFnZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgZGV2aWNlLnZvbHRhZ2UgPSBpdGVtLnZvbHRhZ2U7XG4gIH1cblxuICAvLyBGbGF0dGVuIGxhc3RfcG93ZXIgKE1vam8gZGF0YSlcbiAgaWYgKGl0ZW0ubGFzdF9wb3dlcikge1xuICAgIGRldmljZS5tb2pvX3ZvbHRhZ2UgPSBpdGVtLmxhc3RfcG93ZXIudm9sdGFnZTtcbiAgICBkZXZpY2UubW9qb190ZW1wZXJhdHVyZSA9IGl0ZW0ubGFzdF9wb3dlci50ZW1wZXJhdHVyZTtcbiAgICBkZXZpY2UubWlsbGlhbXBfaG91cnMgPSBpdGVtLmxhc3RfcG93ZXIubWlsbGlhbXBfaG91cnM7XG4gIH1cblxuICAvLyBGaXJtd2FyZSB2ZXJzaW9ucyAoZnJvbSBfc2Vzc2lvbi5xbyBldmVudHMpXG4gIGlmIChpdGVtLmZpcm13YXJlX3ZlcnNpb24pIHtcbiAgICBkZXZpY2UuZmlybXdhcmVfdmVyc2lvbiA9IGl0ZW0uZmlybXdhcmVfdmVyc2lvbjtcbiAgfVxuICBpZiAoaXRlbS5ub3RlY2FyZF92ZXJzaW9uKSB7XG4gICAgZGV2aWNlLm5vdGVjYXJkX3ZlcnNpb24gPSBpdGVtLm5vdGVjYXJkX3ZlcnNpb247XG4gIH1cbiAgaWYgKGl0ZW0ubm90ZWNhcmRfc2t1KSB7XG4gICAgZGV2aWNlLm5vdGVjYXJkX3NrdSA9IGl0ZW0ubm90ZWNhcmRfc2t1O1xuICB9XG5cbiAgcmV0dXJuIGRldmljZTtcbn1cblxuZnVuY3Rpb24gY2FsY3VsYXRlU3RhdHMoZGV2aWNlczogYW55W10pOiBSZWNvcmQ8c3RyaW5nLCBhbnk+IHtcbiAgY29uc3Qgc3RhdHMgPSB7XG4gICAgdG90YWw6IGRldmljZXMubGVuZ3RoLFxuICAgIG9ubGluZTogMCxcbiAgICBvZmZsaW5lOiAwLFxuICAgIGFsZXJ0OiAwLFxuICAgIGxvd19iYXR0ZXJ5OiAwLFxuICAgIGZsZWV0czoge30gYXMgUmVjb3JkPHN0cmluZywgbnVtYmVyPixcbiAgfTtcblxuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBjb25zdCBvZmZsaW5lVGhyZXNob2xkID0gMTUgKiA2MCAqIDEwMDA7IC8vIDE1IG1pbnV0ZXNcblxuICBmb3IgKGNvbnN0IGRldmljZSBvZiBkZXZpY2VzKSB7XG4gICAgLy8gU3RhdHVzIGNvdW50c1xuICAgIGlmIChkZXZpY2Uuc3RhdHVzID09PSAnYWxlcnQnKSB7XG4gICAgICBzdGF0cy5hbGVydCsrO1xuICAgIH0gZWxzZSBpZiAoZGV2aWNlLmxhc3Rfc2VlbiAmJiBub3cgLSBkZXZpY2UubGFzdF9zZWVuIDwgb2ZmbGluZVRocmVzaG9sZCkge1xuICAgICAgc3RhdHMub25saW5lKys7XG4gICAgfSBlbHNlIHtcbiAgICAgIHN0YXRzLm9mZmxpbmUrKztcbiAgICB9XG5cbiAgICAvLyBMb3cgYmF0dGVyeSBjaGVjayAodm9sdGFnZSBjb21lcyBmcm9tIF9sb2cucW8vX2hlYWx0aC5xbywgc3RvcmVkIGluIGRldmljZS52b2x0YWdlKVxuICAgIGlmIChkZXZpY2Uudm9sdGFnZSAmJiBkZXZpY2Uudm9sdGFnZSA8IDMuNCkge1xuICAgICAgc3RhdHMubG93X2JhdHRlcnkrKztcbiAgICB9XG5cbiAgICAvLyBGbGVldCBjb3VudHNcbiAgICBjb25zdCBmbGVldCA9IGRldmljZS5mbGVldCB8fCAnZGVmYXVsdCc7XG4gICAgc3RhdHMuZmxlZXRzW2ZsZWV0XSA9IChzdGF0cy5mbGVldHNbZmxlZXRdIHx8IDApICsgMTtcbiAgfVxuXG4gIHJldHVybiBzdGF0cztcbn1cblxuLyoqXG4gKiBNZXJnZSB0d28gZGV2aWNlcyBpbnRvIG9uZSAoQWRtaW4gb25seSlcbiAqIFRoZSBzb3VyY2UgZGV2aWNlJ3MgZGV2aWNlX3VpZCBpcyBhZGRlZCB0byB0aGUgdGFyZ2V0J3MgYWxpYXMgaGlzdG9yeSxcbiAqIGFuZCB0aGUgc291cmNlIGRldmljZSByZWNvcmQgaXMgZGVsZXRlZC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gbWVyZ2VEZXZpY2VzKFxuICBldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQsXG4gIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiB7XG4gIC8vIENoZWNrIGZvciBhZG1pbiBhdXRob3JpemF0aW9uXG4gIGNvbnN0IGNsYWltcyA9IChldmVudC5yZXF1ZXN0Q29udGV4dCBhcyBhbnkpPy5hdXRob3JpemVyPy5qd3Q/LmNsYWltcyB8fCB7fTtcbiAgY29uc3QgZ3JvdXBzID0gY2xhaW1zWydjb2duaXRvOmdyb3VwcyddIHx8ICcnO1xuICBjb25zdCBpc0FkbWluID0gZ3JvdXBzLmluY2x1ZGVzKCdBZG1pbicpO1xuXG4gIGlmICghaXNBZG1pbikge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDMsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0FkbWluIGFjY2VzcyByZXF1aXJlZCB0byBtZXJnZSBkZXZpY2VzJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgaWYgKCFldmVudC5ib2R5KSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnUmVxdWVzdCBib2R5IHJlcXVpcmVkJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgeyBzb3VyY2Vfc2VyaWFsX251bWJlciwgdGFyZ2V0X3NlcmlhbF9udW1iZXIgfSA9IEpTT04ucGFyc2UoZXZlbnQuYm9keSk7XG5cbiAgaWYgKCFzb3VyY2Vfc2VyaWFsX251bWJlciB8fCAhdGFyZ2V0X3NlcmlhbF9udW1iZXIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdCb3RoIHNvdXJjZV9zZXJpYWxfbnVtYmVyIGFuZCB0YXJnZXRfc2VyaWFsX251bWJlciBhcmUgcmVxdWlyZWQnIH0pLFxuICAgIH07XG4gIH1cblxuICBpZiAoc291cmNlX3NlcmlhbF9udW1iZXIgPT09IHRhcmdldF9zZXJpYWxfbnVtYmVyKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnU291cmNlIGFuZCB0YXJnZXQgY2Fubm90IGJlIHRoZSBzYW1lIGRldmljZScgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8vIEdldCBib3RoIGRldmljZXNcbiAgY29uc3Qgc291cmNlQWxpYXMgPSBhd2FpdCBnZXRBbGlhc0J5U2VyaWFsKHNvdXJjZV9zZXJpYWxfbnVtYmVyKTtcbiAgY29uc3QgdGFyZ2V0QWxpYXMgPSBhd2FpdCBnZXRBbGlhc0J5U2VyaWFsKHRhcmdldF9zZXJpYWxfbnVtYmVyKTtcblxuICBpZiAoIXNvdXJjZUFsaWFzKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwNCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBgU291cmNlIGRldmljZSBub3QgZm91bmQ6ICR7c291cmNlX3NlcmlhbF9udW1iZXJ9YCB9KSxcbiAgICB9O1xuICB9XG5cbiAgaWYgKCF0YXJnZXRBbGlhcykge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDQsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogYFRhcmdldCBkZXZpY2Ugbm90IGZvdW5kOiAke3RhcmdldF9zZXJpYWxfbnVtYmVyfWAgfSksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHNvdXJjZURldmljZVVpZCA9IHNvdXJjZUFsaWFzLmRldmljZV91aWQ7XG4gIGNvbnN0IHRhcmdldERldmljZVVpZCA9IHRhcmdldEFsaWFzLmRldmljZV91aWQ7XG4gIGNvbnN0IHNvdXJjZVByZXZpb3VzVWlkcyA9IHNvdXJjZUFsaWFzLnByZXZpb3VzX2RldmljZV91aWRzIHx8IFtdO1xuICBjb25zdCB0YXJnZXRQcmV2aW91c1VpZHMgPSB0YXJnZXRBbGlhcy5wcmV2aW91c19kZXZpY2VfdWlkcyB8fCBbXTtcblxuICAvLyBNZXJnZSBhbGwgZGV2aWNlX3VpZHM6IHRhcmdldCdzIHByZXZpb3VzICsgc291cmNlJ3MgY3VycmVudCArIHNvdXJjZSdzIHByZXZpb3VzXG4gIGNvbnN0IGFsbFByZXZpb3VzVWlkcyA9IFtcbiAgICAuLi5uZXcgU2V0KFtcbiAgICAgIC4uLnRhcmdldFByZXZpb3VzVWlkcyxcbiAgICAgIHNvdXJjZURldmljZVVpZCxcbiAgICAgIC4uLnNvdXJjZVByZXZpb3VzVWlkcyxcbiAgICBdKSxcbiAgXTtcblxuICAvLyBVcGRhdGUgdGFyZ2V0IGFsaWFzIHRvIGluY2x1ZGUgc291cmNlIGRldmljZV91aWRzXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKG5ldyBQdXRDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IERFVklDRV9BTElBU0VTX1RBQkxFLFxuICAgIEl0ZW06IHtcbiAgICAgIHNlcmlhbF9udW1iZXI6IHRhcmdldF9zZXJpYWxfbnVtYmVyLFxuICAgICAgZGV2aWNlX3VpZDogdGFyZ2V0RGV2aWNlVWlkLFxuICAgICAgcHJldmlvdXNfZGV2aWNlX3VpZHM6IGFsbFByZXZpb3VzVWlkcyxcbiAgICAgIGNyZWF0ZWRfYXQ6IHRhcmdldEFsaWFzLmNyZWF0ZWRfYXQsXG4gICAgICB1cGRhdGVkX2F0OiBEYXRlLm5vdygpLFxuICAgIH0sXG4gIH0pKTtcblxuICAvLyBEZWxldGUgc291cmNlIGFsaWFzXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKG5ldyBEZWxldGVDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IERFVklDRV9BTElBU0VTX1RBQkxFLFxuICAgIEtleTogeyBzZXJpYWxfbnVtYmVyOiBzb3VyY2Vfc2VyaWFsX251bWJlciB9LFxuICB9KSk7XG5cbiAgLy8gRGVsZXRlIHNvdXJjZSBkZXZpY2UgcmVjb3JkXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKG5ldyBEZWxldGVDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IERFVklDRVNfVEFCTEUsXG4gICAgS2V5OiB7IGRldmljZV91aWQ6IHNvdXJjZURldmljZVVpZCB9LFxuICB9KSk7XG5cbiAgLy8gQ3JlYXRlIGFjdGl2aXR5IGZlZWQgZXZlbnRcbiAgY29uc3QgYWN0aXZpdHlFdmVudCA9IHtcbiAgICBldmVudF9pZDogYG1lcmdlLSR7RGF0ZS5ub3coKX0tJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zdWJzdHJpbmcoNyl9YCxcbiAgICBkZXZpY2VfdWlkOiB0YXJnZXREZXZpY2VVaWQsXG4gICAgc2VyaWFsX251bWJlcjogdGFyZ2V0X3NlcmlhbF9udW1iZXIsXG4gICAgZXZlbnRfdHlwZTogJ2RldmljZV9tZXJnZWQnLFxuICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICBkYXRhOiB7XG4gICAgICBzb3VyY2Vfc2VyaWFsX251bWJlcixcbiAgICAgIHNvdXJjZV9kZXZpY2VfdWlkOiBzb3VyY2VEZXZpY2VVaWQsXG4gICAgICB0YXJnZXRfc2VyaWFsX251bWJlcixcbiAgICAgIHRhcmdldF9kZXZpY2VfdWlkOiB0YXJnZXREZXZpY2VVaWQsXG4gICAgICBtZXJnZWRfZGV2aWNlX3VpZHM6IGFsbFByZXZpb3VzVWlkcyxcbiAgICB9LFxuICB9O1xuXG4gIHRyeSB7XG4gICAgYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IFB1dENvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBBQ1RJVklUWV9UQUJMRSxcbiAgICAgIEl0ZW06IGFjdGl2aXR5RXZlbnQsXG4gICAgfSkpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICAvLyBBY3Rpdml0eSBsb2dnaW5nIGlzIG5vbi1jcml0aWNhbCwgbG9nIGJ1dCBkb24ndCBmYWlsXG4gICAgY29uc29sZS5lcnJvcignRmFpbGVkIHRvIGxvZyBtZXJnZSBhY3Rpdml0eTonLCBlcnIpO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgaGVhZGVycyxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBtZXNzYWdlOiAnRGV2aWNlcyBtZXJnZWQgc3VjY2Vzc2Z1bGx5JyxcbiAgICAgIHRhcmdldF9zZXJpYWxfbnVtYmVyLFxuICAgICAgdGFyZ2V0X2RldmljZV91aWQ6IHRhcmdldERldmljZVVpZCxcbiAgICAgIG1lcmdlZF9kZXZpY2VfdWlkczogW3RhcmdldERldmljZVVpZCwgLi4uYWxsUHJldmlvdXNVaWRzXSxcbiAgICAgIGRlbGV0ZWRfc2VyaWFsX251bWJlcjogc291cmNlX3NlcmlhbF9udW1iZXIsXG4gICAgICBkZWxldGVkX2RldmljZV91aWQ6IHNvdXJjZURldmljZVVpZCxcbiAgICB9KSxcbiAgfTtcbn1cbiJdfQ==