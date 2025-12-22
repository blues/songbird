"use strict";
/**
 * Event Ingest API Lambda
 *
 * HTTP endpoint for receiving events from Notehub HTTP routes.
 * Processes incoming Songbird events and writes to DynamoDB.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const client_sns_1 = require("@aws-sdk/client-sns");
// Initialize clients
const ddbClient = new client_dynamodb_1.DynamoDBClient({});
const docClient = lib_dynamodb_1.DynamoDBDocumentClient.from(ddbClient, {
    marshallOptions: {
        removeUndefinedValues: true,
    },
});
const snsClient = new client_sns_1.SNSClient({});
// Environment variables
const TELEMETRY_TABLE = process.env.TELEMETRY_TABLE;
const DEVICES_TABLE = process.env.DEVICES_TABLE;
const COMMANDS_TABLE = process.env.COMMANDS_TABLE;
const ALERTS_TABLE = process.env.ALERTS_TABLE;
const ALERT_TOPIC_ARN = process.env.ALERT_TOPIC_ARN;
// TTL: 90 days in seconds
const TTL_DAYS = 90;
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;
const handler = async (event) => {
    console.log('Ingest request:', JSON.stringify(event));
    const headers = {
        'Content-Type': 'application/json',
    };
    try {
        if (!event.body) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Request body required' }),
            };
        }
        const notehubEvent = JSON.parse(event.body);
        console.log('Processing Notehub event:', JSON.stringify(notehubEvent));
        // Transform to internal format
        // Use 'when' if available, otherwise fall back to 'received' (as integer seconds)
        const eventTimestamp = notehubEvent.when || Math.floor(notehubEvent.received);
        // Extract location - prefer GPS (best_lat/best_lon), fall back to triangulation
        const location = extractLocation(notehubEvent);
        // Extract session info (firmware versions, SKU) from _session.qo events
        const sessionInfo = extractSessionInfo(notehubEvent);
        const songbirdEvent = {
            device_uid: notehubEvent.device,
            serial_number: notehubEvent.sn,
            fleet: notehubEvent.fleets?.[0] || 'default',
            event_type: notehubEvent.file,
            timestamp: eventTimestamp,
            received: notehubEvent.received,
            body: notehubEvent.body || {},
            location,
            session: sessionInfo,
        };
        // Write telemetry to DynamoDB (for track.qo events)
        if (songbirdEvent.event_type === 'track.qo') {
            await writeTelemetry(songbirdEvent, 'telemetry');
        }
        // Write Mojo power data to DynamoDB (_log.qo contains power telemetry)
        if (songbirdEvent.event_type === '_log.qo') {
            await writePowerTelemetry(songbirdEvent);
        }
        // Write health events to DynamoDB (_health.qo)
        if (songbirdEvent.event_type === '_health.qo') {
            await writeHealthEvent(songbirdEvent);
        }
        // Handle triangulation results (_geolocate.qo)
        // Write location to telemetry table for location history trail
        if (songbirdEvent.event_type === '_geolocate.qo' && songbirdEvent.location) {
            await writeLocationEvent(songbirdEvent);
        }
        // Update device metadata in DynamoDB
        await updateDeviceMetadata(songbirdEvent);
        // Store and publish alert if this is an alert event
        if (songbirdEvent.event_type === 'alert.qo') {
            await storeAlert(songbirdEvent);
            await publishAlert(songbirdEvent);
        }
        // Process command acknowledgment
        if (songbirdEvent.event_type === 'command_ack.qo') {
            await processCommandAck(songbirdEvent);
        }
        console.log('Event processed successfully');
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ status: 'ok', device: songbirdEvent.device_uid }),
        };
    }
    catch (error) {
        console.error('Error processing event:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Internal server error' }),
        };
    }
};
exports.handler = handler;
/**
 * Extract session info (firmware versions, SKU) from Notehub event
 * This info is available in _session.qo events
 */
function extractSessionInfo(event) {
    if (!event.firmware_host && !event.firmware_notecard && !event.sku) {
        return undefined;
    }
    const sessionInfo = {};
    // Parse host firmware version
    if (event.firmware_host) {
        try {
            const hostFirmware = JSON.parse(event.firmware_host);
            sessionInfo.firmware_version = hostFirmware.version;
        }
        catch (e) {
            console.error('Failed to parse firmware_host:', e);
        }
    }
    // Parse Notecard firmware version
    if (event.firmware_notecard) {
        try {
            const notecardFirmware = JSON.parse(event.firmware_notecard);
            sessionInfo.notecard_version = notecardFirmware.version;
        }
        catch (e) {
            console.error('Failed to parse firmware_notecard:', e);
        }
    }
    // SKU
    if (event.sku) {
        sessionInfo.notecard_sku = event.sku;
    }
    return Object.keys(sessionInfo).length > 0 ? sessionInfo : undefined;
}
/**
 * Normalize location source type from Notehub to our standard values
 */
function normalizeLocationSource(source) {
    if (!source)
        return 'gps';
    const normalized = source.toLowerCase();
    // Notehub uses 'triangulated' but we use 'triangulation' for consistency
    if (normalized === 'triangulated')
        return 'triangulation';
    return normalized;
}
/**
 * Extract location from Notehub event, preferring GPS but falling back to triangulation
 */
function extractLocation(event) {
    // Prefer GPS location (best_lat/best_lon with type 'gps')
    if (event.best_lat !== undefined && event.best_lon !== undefined) {
        return {
            lat: event.best_lat,
            lon: event.best_lon,
            time: event.best_location_when,
            source: normalizeLocationSource(event.best_location_type),
            name: event.best_location,
        };
    }
    // Fall back to triangulation data
    if (event.tri_lat !== undefined && event.tri_lon !== undefined) {
        return {
            lat: event.tri_lat,
            lon: event.tri_lon,
            time: event.tri_when,
            source: 'triangulation',
            name: event.tower_location,
        };
    }
    // Fall back to tower location
    if (event.tower_lat !== undefined && event.tower_lon !== undefined) {
        return {
            lat: event.tower_lat,
            lon: event.tower_lon,
            time: event.tower_when,
            source: 'tower',
            name: event.tower_location,
        };
    }
    return undefined;
}
async function writeTelemetry(event, dataType) {
    const timestamp = event.timestamp * 1000; // Convert to milliseconds
    const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    const record = {
        device_uid: event.device_uid,
        timestamp,
        ttl,
        data_type: dataType,
        event_type: event.event_type,
        event_type_timestamp: `${dataType}#${timestamp}`,
        serial_number: event.serial_number || 'unknown',
        fleet: event.fleet || 'default',
    };
    if (event.body.temp !== undefined) {
        record.temperature = event.body.temp;
    }
    if (event.body.humidity !== undefined) {
        record.humidity = event.body.humidity;
    }
    if (event.body.pressure !== undefined) {
        record.pressure = event.body.pressure;
    }
    if (event.body.voltage !== undefined) {
        record.voltage = event.body.voltage;
    }
    if (event.body.motion !== undefined) {
        record.motion = event.body.motion;
    }
    if (event.location?.lat !== undefined && event.location?.lon !== undefined) {
        record.latitude = event.location.lat;
        record.longitude = event.location.lon;
        record.location_source = event.location.source || 'gps';
    }
    const command = new lib_dynamodb_1.PutCommand({
        TableName: TELEMETRY_TABLE,
        Item: record,
    });
    await docClient.send(command);
    console.log(`Wrote telemetry record for ${event.device_uid}`);
}
async function writePowerTelemetry(event) {
    const timestamp = event.timestamp * 1000;
    const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    const record = {
        device_uid: event.device_uid,
        timestamp,
        ttl,
        data_type: 'power',
        event_type: event.event_type,
        event_type_timestamp: `power#${timestamp}`,
        serial_number: event.serial_number || 'unknown',
        fleet: event.fleet || 'default',
    };
    if (event.body.voltage !== undefined) {
        record.mojo_voltage = event.body.voltage;
    }
    if (event.body.milliamp_hours !== undefined) {
        record.milliamp_hours = event.body.milliamp_hours;
    }
    if (record.mojo_voltage !== undefined ||
        record.mojo_temperature !== undefined ||
        record.milliamp_hours !== undefined) {
        const command = new lib_dynamodb_1.PutCommand({
            TableName: TELEMETRY_TABLE,
            Item: record,
        });
        await docClient.send(command);
        console.log(`Wrote power telemetry record for ${event.device_uid}`);
    }
    else {
        console.log('No power metrics in _log.qo event, skipping');
    }
}
async function writeHealthEvent(event) {
    const timestamp = event.timestamp * 1000; // Convert to milliseconds
    const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    const record = {
        device_uid: event.device_uid,
        timestamp,
        ttl,
        data_type: 'health',
        event_type: event.event_type,
        event_type_timestamp: `health#${timestamp}`,
        serial_number: event.serial_number || 'unknown',
        fleet: event.fleet || 'default',
    };
    // Add health event fields
    if (event.body.method !== undefined) {
        record.method = event.body.method;
    }
    if (event.body.text !== undefined) {
        record.text = event.body.text;
    }
    if (event.body.voltage !== undefined) {
        record.voltage = event.body.voltage;
    }
    if (event.body.voltage_mode !== undefined) {
        record.voltage_mode = event.body.voltage_mode;
    }
    if (event.body.milliamp_hours !== undefined) {
        record.milliamp_hours = event.body.milliamp_hours;
    }
    // Add location if available
    if (event.location?.lat !== undefined && event.location?.lon !== undefined) {
        record.latitude = event.location.lat;
        record.longitude = event.location.lon;
        record.location_source = event.location.source || 'tower';
    }
    const command = new lib_dynamodb_1.PutCommand({
        TableName: TELEMETRY_TABLE,
        Item: record,
    });
    await docClient.send(command);
    console.log(`Wrote health event record for ${event.device_uid}: ${event.body.method}`);
}
async function writeLocationEvent(event) {
    if (!event.location?.lat || !event.location?.lon) {
        console.log('No location data in event, skipping');
        return;
    }
    const timestamp = event.timestamp * 1000; // Convert to milliseconds
    const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    const record = {
        device_uid: event.device_uid,
        timestamp,
        ttl,
        data_type: 'telemetry', // Use telemetry so it's picked up by location query
        event_type: event.event_type,
        event_type_timestamp: `telemetry#${timestamp}`,
        serial_number: event.serial_number || 'unknown',
        fleet: event.fleet || 'default',
        latitude: event.location.lat,
        longitude: event.location.lon,
        location_source: event.location.source || 'triangulation',
    };
    const command = new lib_dynamodb_1.PutCommand({
        TableName: TELEMETRY_TABLE,
        Item: record,
    });
    await docClient.send(command);
    console.log(`Wrote location event for ${event.device_uid}: ${event.location.source} (${event.location.lat}, ${event.location.lon})`);
}
async function updateDeviceMetadata(event) {
    const now = Date.now();
    const updateExpressions = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};
    updateExpressions.push('#last_seen = :last_seen');
    expressionAttributeNames['#last_seen'] = 'last_seen';
    expressionAttributeValues[':last_seen'] = now;
    updateExpressions.push('#updated_at = :updated_at');
    expressionAttributeNames['#updated_at'] = 'updated_at';
    expressionAttributeValues[':updated_at'] = now;
    updateExpressions.push('#status = :status');
    expressionAttributeNames['#status'] = 'status';
    expressionAttributeValues[':status'] = 'online';
    if (event.serial_number) {
        updateExpressions.push('#sn = :sn');
        expressionAttributeNames['#sn'] = 'serial_number';
        expressionAttributeValues[':sn'] = event.serial_number;
    }
    if (event.fleet) {
        updateExpressions.push('#fleet = :fleet');
        expressionAttributeNames['#fleet'] = 'fleet';
        expressionAttributeValues[':fleet'] = event.fleet;
    }
    if (event.body.mode) {
        updateExpressions.push('#mode = :mode');
        expressionAttributeNames['#mode'] = 'current_mode';
        expressionAttributeValues[':mode'] = event.body.mode;
    }
    if (event.body.transit_locked !== undefined) {
        updateExpressions.push('#transit_locked = :transit_locked');
        expressionAttributeNames['#transit_locked'] = 'transit_locked';
        expressionAttributeValues[':transit_locked'] = event.body.transit_locked;
    }
    if (event.location?.lat !== undefined && event.location?.lon !== undefined) {
        updateExpressions.push('#loc = :loc');
        expressionAttributeNames['#loc'] = 'last_location';
        expressionAttributeValues[':loc'] = {
            lat: event.location.lat,
            lon: event.location.lon,
            time: event.location.time || event.timestamp,
            source: event.location.source || 'gps',
            name: event.location.name,
        };
    }
    if (event.event_type === 'track.qo') {
        updateExpressions.push('#telemetry = :telemetry');
        expressionAttributeNames['#telemetry'] = 'last_telemetry';
        expressionAttributeValues[':telemetry'] = {
            temp: event.body.temp,
            humidity: event.body.humidity,
            pressure: event.body.pressure,
            voltage: event.body.voltage,
            motion: event.body.motion,
            timestamp: event.timestamp,
        };
    }
    if (event.event_type === '_log.qo') {
        updateExpressions.push('#power = :power');
        expressionAttributeNames['#power'] = 'last_power';
        expressionAttributeValues[':power'] = {
            voltage: event.body.voltage,
            temperature: event.body.temperature,
            milliamp_hours: event.body.milliamp_hours,
            timestamp: event.timestamp,
        };
    }
    // Update firmware versions from _session.qo events
    if (event.session?.firmware_version) {
        updateExpressions.push('#fw_version = :fw_version');
        expressionAttributeNames['#fw_version'] = 'firmware_version';
        expressionAttributeValues[':fw_version'] = event.session.firmware_version;
    }
    if (event.session?.notecard_version) {
        updateExpressions.push('#nc_version = :nc_version');
        expressionAttributeNames['#nc_version'] = 'notecard_version';
        expressionAttributeValues[':nc_version'] = event.session.notecard_version;
    }
    if (event.session?.notecard_sku) {
        updateExpressions.push('#nc_sku = :nc_sku');
        expressionAttributeNames['#nc_sku'] = 'notecard_sku';
        expressionAttributeValues[':nc_sku'] = event.session.notecard_sku;
    }
    updateExpressions.push('#created_at = if_not_exists(#created_at, :created_at)');
    expressionAttributeNames['#created_at'] = 'created_at';
    expressionAttributeValues[':created_at'] = now;
    const command = new lib_dynamodb_1.UpdateCommand({
        TableName: DEVICES_TABLE,
        Key: { device_uid: event.device_uid },
        UpdateExpression: 'SET ' + updateExpressions.join(', '),
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
    });
    await docClient.send(command);
    console.log(`Updated device metadata for ${event.device_uid}`);
}
async function processCommandAck(event) {
    const cmdId = event.body.cmd_id;
    if (!cmdId) {
        console.log('Command ack missing cmd_id, skipping');
        return;
    }
    const now = Date.now();
    const command = new lib_dynamodb_1.UpdateCommand({
        TableName: COMMANDS_TABLE,
        Key: {
            device_uid: event.device_uid,
            command_id: cmdId,
        },
        UpdateExpression: 'SET #status = :status, #message = :message, #executed_at = :executed_at, #updated_at = :updated_at',
        ExpressionAttributeNames: {
            '#status': 'status',
            '#message': 'message',
            '#executed_at': 'executed_at',
            '#updated_at': 'updated_at',
        },
        ExpressionAttributeValues: {
            ':status': event.body.status || 'unknown',
            ':message': event.body.message || '',
            ':executed_at': event.body.executed_at ? event.body.executed_at * 1000 : now,
            ':updated_at': now,
        },
    });
    await docClient.send(command);
    console.log(`Updated command ${cmdId} with status: ${event.body.status}`);
}
async function storeAlert(event) {
    const now = Date.now();
    const ttl = Math.floor(now / 1000) + TTL_SECONDS;
    // Generate a unique alert ID
    const alertId = `alert_${event.device_uid}_${now}_${Math.random().toString(36).substring(7)}`;
    const alertRecord = {
        alert_id: alertId,
        device_uid: event.device_uid,
        serial_number: event.serial_number || 'unknown',
        fleet: event.fleet || 'default',
        type: event.body.type || 'unknown',
        value: event.body.value,
        threshold: event.body.threshold,
        message: event.body.message || '',
        created_at: now,
        event_timestamp: event.timestamp * 1000,
        acknowledged: 'false', // String for GSI partition key
        ttl,
        location: event.location ? {
            lat: event.location.lat,
            lon: event.location.lon,
        } : undefined,
    };
    const command = new lib_dynamodb_1.PutCommand({
        TableName: ALERTS_TABLE,
        Item: alertRecord,
    });
    await docClient.send(command);
    console.log(`Stored alert ${alertId} for ${event.device_uid}`);
}
async function publishAlert(event) {
    const alertMessage = {
        device_uid: event.device_uid,
        serial_number: event.serial_number,
        fleet: event.fleet,
        alert_type: event.body.type,
        value: event.body.value,
        threshold: event.body.threshold,
        message: event.body.message,
        timestamp: event.timestamp,
        location: event.location,
    };
    const command = new client_sns_1.PublishCommand({
        TopicArn: ALERT_TOPIC_ARN,
        Subject: `Songbird Alert: ${event.body.type} - ${event.serial_number || event.device_uid}`,
        Message: JSON.stringify(alertMessage, null, 2),
        MessageAttributes: {
            alert_type: {
                DataType: 'String',
                StringValue: event.body.type || 'unknown',
            },
            device_uid: {
                DataType: 'String',
                StringValue: event.device_uid,
            },
            fleet: {
                DataType: 'String',
                StringValue: event.fleet || 'default',
            },
        },
    });
    await snsClient.send(command);
    console.log(`Published alert to SNS: ${event.body.type}`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWluZ2VzdC9pbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7O0dBS0c7OztBQUVILDhEQUEwRDtBQUMxRCx3REFBMEY7QUFDMUYsb0RBQWdFO0FBR2hFLHFCQUFxQjtBQUNyQixNQUFNLFNBQVMsR0FBRyxJQUFJLGdDQUFjLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDekMsTUFBTSxTQUFTLEdBQUcscUNBQXNCLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRTtJQUN2RCxlQUFlLEVBQUU7UUFDZixxQkFBcUIsRUFBRSxJQUFJO0tBQzVCO0NBQ0YsQ0FBQyxDQUFDO0FBQ0gsTUFBTSxTQUFTLEdBQUcsSUFBSSxzQkFBUyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBRXBDLHdCQUF3QjtBQUN4QixNQUFNLGVBQWUsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGVBQWdCLENBQUM7QUFDckQsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxhQUFjLENBQUM7QUFDakQsTUFBTSxjQUFjLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFlLENBQUM7QUFDbkQsTUFBTSxZQUFZLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxZQUFhLENBQUM7QUFDL0MsTUFBTSxlQUFlLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxlQUFnQixDQUFDO0FBRXJELDBCQUEwQjtBQUMxQixNQUFNLFFBQVEsR0FBRyxFQUFFLENBQUM7QUFDcEIsTUFBTSxXQUFXLEdBQUcsUUFBUSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxDQUFDO0FBZ0VyQyxNQUFNLE9BQU8sR0FBRyxLQUFLLEVBQUUsS0FBMkIsRUFBa0MsRUFBRTtJQUMzRixPQUFPLENBQUMsR0FBRyxDQUFDLGlCQUFpQixFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMs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QUFPLENBQUMsQ0FBQztJQUM5QixPQUFPLENBQUMsR0FBRyxDQUFDLDJCQUEyQixLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUM7QUFDNUQsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRXZlbnQgSW5nZXN0IEFQSSBMYW1iZGFcbiAqXG4gKiBIVFRQIGVuZHBvaW50IGZvciByZWNlaXZpbmcgZXZlbnRzIGZyb20gTm90ZWh1YiBIVFRQIHJvdXRlcy5cbiAqIFByb2Nlc3NlcyBpbmNvbWluZyBTb25nYmlyZCBldmVudHMgYW5kIHdyaXRlcyB0byBEeW5hbW9EQi5cbiAqL1xuXG5pbXBvcnQgeyBEeW5hbW9EQkNsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYic7XG5pbXBvcnQgeyBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LCBQdXRDb21tYW5kLCBVcGRhdGVDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvbGliLWR5bmFtb2RiJztcbmltcG9ydCB7IFNOU0NsaWVudCwgUHVibGlzaENvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtc25zJztcbmltcG9ydCB7IEFQSUdhdGV3YXlQcm94eUV2ZW50LCBBUElHYXRld2F5UHJveHlSZXN1bHQgfSBmcm9tICdhd3MtbGFtYmRhJztcblxuLy8gSW5pdGlhbGl6ZSBjbGllbnRzXG5jb25zdCBkZGJDbGllbnQgPSBuZXcgRHluYW1vREJDbGllbnQoe30pO1xuY29uc3QgZG9jQ2xpZW50ID0gRHluYW1vREJEb2N1bWVudENsaWVudC5mcm9tKGRkYkNsaWVudCwge1xuICBtYXJzaGFsbE9wdGlvbnM6IHtcbiAgICByZW1vdmVVbmRlZmluZWRWYWx1ZXM6IHRydWUsXG4gIH0sXG59KTtcbmNvbnN0IHNuc0NsaWVudCA9IG5ldyBTTlNDbGllbnQoe30pO1xuXG4vLyBFbnZpcm9ubWVudCB2YXJpYWJsZXNcbmNvbnN0IFRFTEVNRVRSWV9UQUJMRSA9IHByb2Nlc3MuZW52LlRFTEVNRVRSWV9UQUJMRSE7XG5jb25zdCBERVZJQ0VTX1RBQkxFID0gcHJvY2Vzcy5lbnYuREVWSUNFU19UQUJMRSE7XG5jb25zdCBDT01NQU5EU19UQUJMRSA9IHByb2Nlc3MuZW52LkNPTU1BTkRTX1RBQkxFITtcbmNvbnN0IEFMRVJUU19UQUJMRSA9IHByb2Nlc3MuZW52LkFMRVJUU19UQUJMRSE7XG5jb25zdCBBTEVSVF9UT1BJQ19BUk4gPSBwcm9jZXNzLmVudi5BTEVSVF9UT1BJQ19BUk4hO1xuXG4vLyBUVEw6IDkwIGRheXMgaW4gc2Vjb25kc1xuY29uc3QgVFRMX0RBWVMgPSA5MDtcbmNvbnN0IFRUTF9TRUNPTkRTID0gVFRMX0RBWVMgKiAyNCAqIDYwICogNjA7XG5cbi8vIE5vdGVodWIgZXZlbnQgc3RydWN0dXJlIChmcm9tIEhUVFAgcm91dGUpXG5pbnRlcmZhY2UgTm90ZWh1YkV2ZW50IHtcbiAgZXZlbnQ6IHN0cmluZzsgICAgICAgICAgIC8vIGUuZy4sIFwiZGV2Onh4eHh4I3RyYWNrLnFvIzFcIlxuICBzZXNzaW9uOiBzdHJpbmc7XG4gIGJlc3RfaWQ6IHN0cmluZztcbiAgZGV2aWNlOiBzdHJpbmc7ICAgICAgICAgIC8vIERldmljZSBVSURcbiAgc246IHN0cmluZzsgICAgICAgICAgICAgIC8vIFNlcmlhbCBudW1iZXJcbiAgcHJvZHVjdDogc3RyaW5nO1xuICBhcHA6IHN0cmluZztcbiAgcmVjZWl2ZWQ6IG51bWJlcjtcbiAgcmVxOiBzdHJpbmc7ICAgICAgICAgICAgIC8vIGUuZy4sIFwibm90ZS5hZGRcIlxuICB3aGVuOiBudW1iZXI7ICAgICAgICAgICAgLy8gVW5peCB0aW1lc3RhbXBcbiAgZmlsZTogc3RyaW5nOyAgICAgICAgICAgIC8vIGUuZy4sIFwidHJhY2sucW9cIlxuICBib2R5OiB7XG4gICAgdGVtcD86IG51bWJlcjtcbiAgICBodW1pZGl0eT86IG51bWJlcjtcbiAgICBwcmVzc3VyZT86IG51bWJlcjtcbiAgICB2b2x0YWdlPzogbnVtYmVyO1xuICAgIG1vdGlvbj86IGJvb2xlYW47XG4gICAgbW9kZT86IHN0cmluZztcbiAgICB0cmFuc2l0X2xvY2tlZD86IGJvb2xlYW47XG4gICAgLy8gQWxlcnQtc3BlY2lmaWMgZmllbGRzXG4gICAgdHlwZT86IHN0cmluZztcbiAgICB2YWx1ZT86IG51bWJlcjtcbiAgICB0aHJlc2hvbGQ/OiBudW1iZXI7XG4gICAgbWVzc2FnZT86IHN0cmluZztcbiAgICAvLyBDb21tYW5kIGFjayBmaWVsZHNcbiAgICBjbWQ/OiBzdHJpbmc7XG4gICAgc3RhdHVzPzogc3RyaW5nO1xuICAgIGV4ZWN1dGVkX2F0PzogbnVtYmVyO1xuICAgIC8vIE1vam8gcG93ZXIgbW9uaXRvcmluZyBmaWVsZHMgKF9sb2cucW8pXG4gICAgbWlsbGlhbXBfaG91cnM/OiBudW1iZXI7XG4gICAgdGVtcGVyYXR1cmU/OiBudW1iZXI7XG4gICAgLy8gSGVhbHRoIGV2ZW50IGZpZWxkcyAoX2hlYWx0aC5xbylcbiAgICBtZXRob2Q/OiBzdHJpbmc7XG4gICAgdGV4dD86IHN0cmluZztcbiAgICB2b2x0YWdlX21vZGU/OiBzdHJpbmc7XG4gIH07XG4gIGJlc3RfbG9jYXRpb25fdHlwZT86IHN0cmluZztcbiAgYmVzdF9sb2NhdGlvbl93aGVuPzogbnVtYmVyO1xuICBiZXN0X2xhdD86IG51bWJlcjtcbiAgYmVzdF9sb24/OiBudW1iZXI7XG4gIGJlc3RfbG9jYXRpb24/OiBzdHJpbmc7XG4gIHRvd2VyX2xvY2F0aW9uPzogc3RyaW5nO1xuICB0b3dlcl9sYXQ/OiBudW1iZXI7XG4gIHRvd2VyX2xvbj86IG51bWJlcjtcbiAgdG93ZXJfd2hlbj86IG51bWJlcjtcbiAgLy8gVHJpYW5ndWxhdGlvbiBmaWVsZHMgKGZyb20gX2dlb2xvY2F0ZS5xbyBvciBlbnJpY2hlZCBldmVudHMpXG4gIHRyaV93aGVuPzogbnVtYmVyO1xuICB0cmlfbGF0PzogbnVtYmVyO1xuICB0cmlfbG9uPzogbnVtYmVyO1xuICB0cmlfbG9jYXRpb24/OiBzdHJpbmc7XG4gIHRyaV9jb3VudHJ5Pzogc3RyaW5nO1xuICB0cmlfdGltZXpvbmU/OiBzdHJpbmc7XG4gIHRyaV9wb2ludHM/OiBudW1iZXI7ICAvLyBOdW1iZXIgb2YgcmVmZXJlbmNlIHBvaW50cyB1c2VkIGZvciB0cmlhbmd1bGF0aW9uXG4gIGZsZWV0cz86IHN0cmluZ1tdO1xuICAvLyBTZXNzaW9uIGZpZWxkcyAoX3Nlc3Npb24ucW8pXG4gIGZpcm13YXJlX2hvc3Q/OiBzdHJpbmc7ICAgICAvLyBKU09OIHN0cmluZyB3aXRoIGhvc3QgZmlybXdhcmUgaW5mb1xuICBmaXJtd2FyZV9ub3RlY2FyZD86IHN0cmluZzsgLy8gSlNPTiBzdHJpbmcgd2l0aCBOb3RlY2FyZCBmaXJtd2FyZSBpbmZvXG4gIHNrdT86IHN0cmluZzsgICAgICAgICAgICAgICAvLyBOb3RlY2FyZCBTS1UgKGUuZy4sIFwiTk9URS1XQkdMV1wiKVxufVxuXG5leHBvcnQgY29uc3QgaGFuZGxlciA9IGFzeW5jIChldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQpOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4gPT4ge1xuICBjb25zb2xlLmxvZygnSW5nZXN0IHJlcXVlc3Q6JywgSlNPTi5zdHJpbmdpZnkoZXZlbnQpKTtcblxuICBjb25zdCBoZWFkZXJzID0ge1xuICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gIH07XG5cbiAgdHJ5IHtcbiAgICBpZiAoIWV2ZW50LmJvZHkpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1JlcXVlc3QgYm9keSByZXF1aXJlZCcgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIGNvbnN0IG5vdGVodWJFdmVudDogTm90ZWh1YkV2ZW50ID0gSlNPTi5wYXJzZShldmVudC5ib2R5KTtcbiAgICBjb25zb2xlLmxvZygnUHJvY2Vzc2luZyBOb3RlaHViIGV2ZW50OicsIEpTT04uc3RyaW5naWZ5KG5vdGVodWJFdmVudCkpO1xuXG4gICAgLy8gVHJhbnNmb3JtIHRvIGludGVybmFsIGZvcm1hdFxuICAgIC8vIFVzZSAnd2hlbicgaWYgYXZhaWxhYmxlLCBvdGhlcndpc2UgZmFsbCBiYWNrIHRvICdyZWNlaXZlZCcgKGFzIGludGVnZXIgc2Vjb25kcylcbiAgICBjb25zdCBldmVudFRpbWVzdGFtcCA9IG5vdGVodWJFdmVudC53aGVuIHx8IE1hdGguZmxvb3Iobm90ZWh1YkV2ZW50LnJlY2VpdmVkKTtcblxuICAgIC8vIEV4dHJhY3QgbG9jYXRpb24gLSBwcmVmZXIgR1BTIChiZXN0X2xhdC9iZXN0X2xvbiksIGZhbGwgYmFjayB0byB0cmlhbmd1bGF0aW9uXG4gICAgY29uc3QgbG9jYXRpb24gPSBleHRyYWN0TG9jYXRpb24obm90ZWh1YkV2ZW50KTtcblxuICAgIC8vIEV4dHJhY3Qgc2Vzc2lvbiBpbmZvIChmaXJtd2FyZSB2ZXJzaW9ucywgU0tVKSBmcm9tIF9zZXNzaW9uLnFvIGV2ZW50c1xuICAgIGNvbnN0IHNlc3Npb25JbmZvID0gZXh0cmFjdFNlc3Npb25JbmZvKG5vdGVodWJFdmVudCk7XG5cbiAgICBjb25zdCBzb25nYmlyZEV2ZW50ID0ge1xuICAgICAgZGV2aWNlX3VpZDogbm90ZWh1YkV2ZW50LmRldmljZSxcbiAgICAgIHNlcmlhbF9udW1iZXI6IG5vdGVodWJFdmVudC5zbixcbiAgICAgIGZsZWV0OiBub3RlaHViRXZlbnQuZmxlZXRzPy5bMF0gfHwgJ2RlZmF1bHQnLFxuICAgICAgZXZlbnRfdHlwZTogbm90ZWh1YkV2ZW50LmZpbGUsXG4gICAgICB0aW1lc3RhbXA6IGV2ZW50VGltZXN0YW1wLFxuICAgICAgcmVjZWl2ZWQ6IG5vdGVodWJFdmVudC5yZWNlaXZlZCxcbiAgICAgIGJvZHk6IG5vdGVodWJFdmVudC5ib2R5IHx8IHt9LFxuICAgICAgbG9jYXRpb24sXG4gICAgICBzZXNzaW9uOiBzZXNzaW9uSW5mbyxcbiAgICB9O1xuXG4gICAgLy8gV3JpdGUgdGVsZW1ldHJ5IHRvIER5bmFtb0RCIChmb3IgdHJhY2sucW8gZXZlbnRzKVxuICAgIGlmIChzb25nYmlyZEV2ZW50LmV2ZW50X3R5cGUgPT09ICd0cmFjay5xbycpIHtcbiAgICAgIGF3YWl0IHdyaXRlVGVsZW1ldHJ5KHNvbmdiaXJkRXZlbnQsICd0ZWxlbWV0cnknKTtcbiAgICB9XG5cbiAgICAvLyBXcml0ZSBNb2pvIHBvd2VyIGRhdGEgdG8gRHluYW1vREIgKF9sb2cucW8gY29udGFpbnMgcG93ZXIgdGVsZW1ldHJ5KVxuICAgIGlmIChzb25nYmlyZEV2ZW50LmV2ZW50X3R5cGUgPT09ICdfbG9nLnFvJykge1xuICAgICAgYXdhaXQgd3JpdGVQb3dlclRlbGVtZXRyeShzb25nYmlyZEV2ZW50KTtcbiAgICB9XG5cbiAgICAvLyBXcml0ZSBoZWFsdGggZXZlbnRzIHRvIER5bmFtb0RCIChfaGVhbHRoLnFvKVxuICAgIGlmIChzb25nYmlyZEV2ZW50LmV2ZW50X3R5cGUgPT09ICdfaGVhbHRoLnFvJykge1xuICAgICAgYXdhaXQgd3JpdGVIZWFsdGhFdmVudChzb25nYmlyZEV2ZW50KTtcbiAgICB9XG5cbiAgICAvLyBIYW5kbGUgdHJpYW5ndWxhdGlvbiByZXN1bHRzIChfZ2VvbG9jYXRlLnFvKVxuICAgIC8vIFdyaXRlIGxvY2F0aW9uIHRvIHRlbGVtZXRyeSB0YWJsZSBmb3IgbG9jYXRpb24gaGlzdG9yeSB0cmFpbFxuICAgIGlmIChzb25nYmlyZEV2ZW50LmV2ZW50X3R5cGUgPT09ICdfZ2VvbG9jYXRlLnFvJyAmJiBzb25nYmlyZEV2ZW50LmxvY2F0aW9uKSB7XG4gICAgICBhd2FpdCB3cml0ZUxvY2F0aW9uRXZlbnQoc29uZ2JpcmRFdmVudCk7XG4gICAgfVxuXG4gICAgLy8gVXBkYXRlIGRldmljZSBtZXRhZGF0YSBpbiBEeW5hbW9EQlxuICAgIGF3YWl0IHVwZGF0ZURldmljZU1ldGFkYXRhKHNvbmdiaXJkRXZlbnQpO1xuXG4gICAgLy8gU3RvcmUgYW5kIHB1Ymxpc2ggYWxlcnQgaWYgdGhpcyBpcyBhbiBhbGVydCBldmVudFxuICAgIGlmIChzb25nYmlyZEV2ZW50LmV2ZW50X3R5cGUgPT09ICdhbGVydC5xbycpIHtcbiAgICAgIGF3YWl0IHN0b3JlQWxlcnQoc29uZ2JpcmRFdmVudCk7XG4gICAgICBhd2FpdCBwdWJsaXNoQWxlcnQoc29uZ2JpcmRFdmVudCk7XG4gICAgfVxuXG4gICAgLy8gUHJvY2VzcyBjb21tYW5kIGFja25vd2xlZGdtZW50XG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuZXZlbnRfdHlwZSA9PT0gJ2NvbW1hbmRfYWNrLnFvJykge1xuICAgICAgYXdhaXQgcHJvY2Vzc0NvbW1hbmRBY2soc29uZ2JpcmRFdmVudCk7XG4gICAgfVxuXG4gICAgY29uc29sZS5sb2coJ0V2ZW50IHByb2Nlc3NlZCBzdWNjZXNzZnVsbHknKTtcblxuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBzdGF0dXM6ICdvaycsIGRldmljZTogc29uZ2JpcmRFdmVudC5kZXZpY2VfdWlkIH0pLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3IgcHJvY2Vzc2luZyBldmVudDonLCBlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnSW50ZXJuYWwgc2VydmVyIGVycm9yJyB9KSxcbiAgICB9O1xuICB9XG59O1xuXG5pbnRlcmZhY2UgU2Vzc2lvbkluZm8ge1xuICBmaXJtd2FyZV92ZXJzaW9uPzogc3RyaW5nO1xuICBub3RlY2FyZF92ZXJzaW9uPzogc3RyaW5nO1xuICBub3RlY2FyZF9za3U/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogRXh0cmFjdCBzZXNzaW9uIGluZm8gKGZpcm13YXJlIHZlcnNpb25zLCBTS1UpIGZyb20gTm90ZWh1YiBldmVudFxuICogVGhpcyBpbmZvIGlzIGF2YWlsYWJsZSBpbiBfc2Vzc2lvbi5xbyBldmVudHNcbiAqL1xuZnVuY3Rpb24gZXh0cmFjdFNlc3Npb25JbmZvKGV2ZW50OiBOb3RlaHViRXZlbnQpOiBTZXNzaW9uSW5mbyB8IHVuZGVmaW5lZCB7XG4gIGlmICghZXZlbnQuZmlybXdhcmVfaG9zdCAmJiAhZXZlbnQuZmlybXdhcmVfbm90ZWNhcmQgJiYgIWV2ZW50LnNrdSkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cblxuICBjb25zdCBzZXNzaW9uSW5mbzogU2Vzc2lvbkluZm8gPSB7fTtcblxuICAvLyBQYXJzZSBob3N0IGZpcm13YXJlIHZlcnNpb25cbiAgaWYgKGV2ZW50LmZpcm13YXJlX2hvc3QpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgaG9zdEZpcm13YXJlID0gSlNPTi5wYXJzZShldmVudC5maXJtd2FyZV9ob3N0KTtcbiAgICAgIHNlc3Npb25JbmZvLmZpcm13YXJlX3ZlcnNpb24gPSBob3N0RmlybXdhcmUudmVyc2lvbjtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLmVycm9yKCdGYWlsZWQgdG8gcGFyc2UgZmlybXdhcmVfaG9zdDonLCBlKTtcbiAgICB9XG4gIH1cblxuICAvLyBQYXJzZSBOb3RlY2FyZCBmaXJtd2FyZSB2ZXJzaW9uXG4gIGlmIChldmVudC5maXJtd2FyZV9ub3RlY2FyZCkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBub3RlY2FyZEZpcm13YXJlID0gSlNPTi5wYXJzZShldmVudC5maXJtd2FyZV9ub3RlY2FyZCk7XG4gICAgICBzZXNzaW9uSW5mby5ub3RlY2FyZF92ZXJzaW9uID0gbm90ZWNhcmRGaXJtd2FyZS52ZXJzaW9uO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ0ZhaWxlZCB0byBwYXJzZSBmaXJtd2FyZV9ub3RlY2FyZDonLCBlKTtcbiAgICB9XG4gIH1cblxuICAvLyBTS1VcbiAgaWYgKGV2ZW50LnNrdSkge1xuICAgIHNlc3Npb25JbmZvLm5vdGVjYXJkX3NrdSA9IGV2ZW50LnNrdTtcbiAgfVxuXG4gIHJldHVybiBPYmplY3Qua2V5cyhzZXNzaW9uSW5mbykubGVuZ3RoID4gMCA/IHNlc3Npb25JbmZvIDogdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIE5vcm1hbGl6ZSBsb2NhdGlvbiBzb3VyY2UgdHlwZSBmcm9tIE5vdGVodWIgdG8gb3VyIHN0YW5kYXJkIHZhbHVlc1xuICovXG5mdW5jdGlvbiBub3JtYWxpemVMb2NhdGlvblNvdXJjZShzb3VyY2U/OiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoIXNvdXJjZSkgcmV0dXJuICdncHMnO1xuICBjb25zdCBub3JtYWxpemVkID0gc291cmNlLnRvTG93ZXJDYXNlKCk7XG4gIC8vIE5vdGVodWIgdXNlcyAndHJpYW5ndWxhdGVkJyBidXQgd2UgdXNlICd0cmlhbmd1bGF0aW9uJyBmb3IgY29uc2lzdGVuY3lcbiAgaWYgKG5vcm1hbGl6ZWQgPT09ICd0cmlhbmd1bGF0ZWQnKSByZXR1cm4gJ3RyaWFuZ3VsYXRpb24nO1xuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuLyoqXG4gKiBFeHRyYWN0IGxvY2F0aW9uIGZyb20gTm90ZWh1YiBldmVudCwgcHJlZmVycmluZyBHUFMgYnV0IGZhbGxpbmcgYmFjayB0byB0cmlhbmd1bGF0aW9uXG4gKi9cbmZ1bmN0aW9uIGV4dHJhY3RMb2NhdGlvbihldmVudDogTm90ZWh1YkV2ZW50KTogeyBsYXQ6IG51bWJlcjsgbG9uOiBudW1iZXI7IHRpbWU/OiBudW1iZXI7IHNvdXJjZTogc3RyaW5nOyBuYW1lPzogc3RyaW5nIH0gfCB1bmRlZmluZWQge1xuICAvLyBQcmVmZXIgR1BTIGxvY2F0aW9uIChiZXN0X2xhdC9iZXN0X2xvbiB3aXRoIHR5cGUgJ2dwcycpXG4gIGlmIChldmVudC5iZXN0X2xhdCAhPT0gdW5kZWZpbmVkICYmIGV2ZW50LmJlc3RfbG9uICE9PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgbGF0OiBldmVudC5iZXN0X2xhdCxcbiAgICAgIGxvbjogZXZlbnQuYmVzdF9sb24sXG4gICAgICB0aW1lOiBldmVudC5iZXN0X2xvY2F0aW9uX3doZW4sXG4gICAgICBzb3VyY2U6IG5vcm1hbGl6ZUxvY2F0aW9uU291cmNlKGV2ZW50LmJlc3RfbG9jYXRpb25fdHlwZSksXG4gICAgICBuYW1lOiBldmVudC5iZXN0X2xvY2F0aW9uLFxuICAgIH07XG4gIH1cblxuICAvLyBGYWxsIGJhY2sgdG8gdHJpYW5ndWxhdGlvbiBkYXRhXG4gIGlmIChldmVudC50cmlfbGF0ICE9PSB1bmRlZmluZWQgJiYgZXZlbnQudHJpX2xvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGxhdDogZXZlbnQudHJpX2xhdCxcbiAgICAgIGxvbjogZXZlbnQudHJpX2xvbixcbiAgICAgIHRpbWU6IGV2ZW50LnRyaV93aGVuLFxuICAgICAgc291cmNlOiAndHJpYW5ndWxhdGlvbicsXG4gICAgICBuYW1lOiBldmVudC50b3dlcl9sb2NhdGlvbixcbiAgICB9O1xuICB9XG5cbiAgLy8gRmFsbCBiYWNrIHRvIHRvd2VyIGxvY2F0aW9uXG4gIGlmIChldmVudC50b3dlcl9sYXQgIT09IHVuZGVmaW5lZCAmJiBldmVudC50b3dlcl9sb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB7XG4gICAgICBsYXQ6IGV2ZW50LnRvd2VyX2xhdCxcbiAgICAgIGxvbjogZXZlbnQudG93ZXJfbG9uLFxuICAgICAgdGltZTogZXZlbnQudG93ZXJfd2hlbixcbiAgICAgIHNvdXJjZTogJ3Rvd2VyJyxcbiAgICAgIG5hbWU6IGV2ZW50LnRvd2VyX2xvY2F0aW9uLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5pbnRlcmZhY2UgU29uZ2JpcmRFdmVudCB7XG4gIGRldmljZV91aWQ6IHN0cmluZztcbiAgc2VyaWFsX251bWJlcj86IHN0cmluZztcbiAgZmxlZXQ/OiBzdHJpbmc7XG4gIGV2ZW50X3R5cGU6IHN0cmluZztcbiAgdGltZXN0YW1wOiBudW1iZXI7XG4gIHJlY2VpdmVkOiBudW1iZXI7XG4gIHNlc3Npb24/OiBTZXNzaW9uSW5mbztcbiAgYm9keToge1xuICAgIHRlbXA/OiBudW1iZXI7XG4gICAgaHVtaWRpdHk/OiBudW1iZXI7XG4gICAgcHJlc3N1cmU/OiBudW1iZXI7XG4gICAgdm9sdGFnZT86IG51bWJlcjtcbiAgICBtb3Rpb24/OiBib29sZWFuO1xuICAgIG1vZGU/OiBzdHJpbmc7XG4gICAgdHJhbnNpdF9sb2NrZWQ/OiBib29sZWFuO1xuICAgIHR5cGU/OiBzdHJpbmc7XG4gICAgdmFsdWU/OiBudW1iZXI7XG4gICAgdGhyZXNob2xkPzogbnVtYmVyO1xuICAgIG1lc3NhZ2U/OiBzdHJpbmc7XG4gICAgY21kPzogc3RyaW5nO1xuICAgIGNtZF9pZD86IHN0cmluZztcbiAgICBzdGF0dXM/OiBzdHJpbmc7XG4gICAgZXhlY3V0ZWRfYXQ/OiBudW1iZXI7XG4gICAgbWlsbGlhbXBfaG91cnM/OiBudW1iZXI7XG4gICAgdGVtcGVyYXR1cmU/OiBudW1iZXI7XG4gICAgLy8gSGVhbHRoIGV2ZW50IGZpZWxkc1xuICAgIG1ldGhvZD86IHN0cmluZztcbiAgICB0ZXh0Pzogc3RyaW5nO1xuICAgIHZvbHRhZ2VfbW9kZT86IHN0cmluZztcbiAgfTtcbiAgbG9jYXRpb24/OiB7XG4gICAgbGF0PzogbnVtYmVyO1xuICAgIGxvbj86IG51bWJlcjtcbiAgICB0aW1lPzogbnVtYmVyO1xuICAgIHNvdXJjZT86IHN0cmluZztcbiAgICBuYW1lPzogc3RyaW5nO1xuICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiB3cml0ZVRlbGVtZXRyeShldmVudDogU29uZ2JpcmRFdmVudCwgZGF0YVR5cGU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0aW1lc3RhbXAgPSBldmVudC50aW1lc3RhbXAgKiAxMDAwOyAvLyBDb252ZXJ0IHRvIG1pbGxpc2Vjb25kc1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSArIFRUTF9TRUNPTkRTO1xuXG4gIGNvbnN0IHJlY29yZDogUmVjb3JkPHN0cmluZywgYW55PiA9IHtcbiAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgIHRpbWVzdGFtcCxcbiAgICB0dGwsXG4gICAgZGF0YV90eXBlOiBkYXRhVHlwZSxcbiAgICBldmVudF90eXBlOiBldmVudC5ldmVudF90eXBlLFxuICAgIGV2ZW50X3R5cGVfdGltZXN0YW1wOiBgJHtkYXRhVHlwZX0jJHt0aW1lc3RhbXB9YCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyIHx8ICd1bmtub3duJyxcbiAgICBmbGVldDogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICB9O1xuXG4gIGlmIChldmVudC5ib2R5LnRlbXAgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC50ZW1wZXJhdHVyZSA9IGV2ZW50LmJvZHkudGVtcDtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS5odW1pZGl0eSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLmh1bWlkaXR5ID0gZXZlbnQuYm9keS5odW1pZGl0eTtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS5wcmVzc3VyZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnByZXNzdXJlID0gZXZlbnQuYm9keS5wcmVzc3VyZTtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS52b2x0YWdlICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQudm9sdGFnZSA9IGV2ZW50LmJvZHkudm9sdGFnZTtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS5tb3Rpb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5tb3Rpb24gPSBldmVudC5ib2R5Lm1vdGlvbjtcbiAgfVxuXG4gIGlmIChldmVudC5sb2NhdGlvbj8ubGF0ICE9PSB1bmRlZmluZWQgJiYgZXZlbnQubG9jYXRpb24/LmxvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLmxhdGl0dWRlID0gZXZlbnQubG9jYXRpb24ubGF0O1xuICAgIHJlY29yZC5sb25naXR1ZGUgPSBldmVudC5sb2NhdGlvbi5sb247XG4gICAgcmVjb3JkLmxvY2F0aW9uX3NvdXJjZSA9IGV2ZW50LmxvY2F0aW9uLnNvdXJjZSB8fCAnZ3BzJztcbiAgfVxuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBURUxFTUVUUllfVEFCTEUsXG4gICAgSXRlbTogcmVjb3JkLFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFdyb3RlIHRlbGVtZXRyeSByZWNvcmQgZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH1gKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gd3JpdGVQb3dlclRlbGVtZXRyeShldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0aW1lc3RhbXAgPSBldmVudC50aW1lc3RhbXAgKiAxMDAwO1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSArIFRUTF9TRUNPTkRTO1xuXG4gIGNvbnN0IHJlY29yZDogUmVjb3JkPHN0cmluZywgYW55PiA9IHtcbiAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgIHRpbWVzdGFtcCxcbiAgICB0dGwsXG4gICAgZGF0YV90eXBlOiAncG93ZXInLFxuICAgIGV2ZW50X3R5cGU6IGV2ZW50LmV2ZW50X3R5cGUsXG4gICAgZXZlbnRfdHlwZV90aW1lc3RhbXA6IGBwb3dlciMke3RpbWVzdGFtcH1gLFxuICAgIHNlcmlhbF9udW1iZXI6IGV2ZW50LnNlcmlhbF9udW1iZXIgfHwgJ3Vua25vd24nLFxuICAgIGZsZWV0OiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gIH07XG5cbiAgaWYgKGV2ZW50LmJvZHkudm9sdGFnZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLm1vam9fdm9sdGFnZSA9IGV2ZW50LmJvZHkudm9sdGFnZTtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS5taWxsaWFtcF9ob3VycyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLm1pbGxpYW1wX2hvdXJzID0gZXZlbnQuYm9keS5taWxsaWFtcF9ob3VycztcbiAgfVxuXG4gIGlmIChyZWNvcmQubW9qb192b2x0YWdlICE9PSB1bmRlZmluZWQgfHxcbiAgICAgIHJlY29yZC5tb2pvX3RlbXBlcmF0dXJlICE9PSB1bmRlZmluZWQgfHxcbiAgICAgIHJlY29yZC5taWxsaWFtcF9ob3VycyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgY29tbWFuZCA9IG5ldyBQdXRDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogVEVMRU1FVFJZX1RBQkxFLFxuICAgICAgSXRlbTogcmVjb3JkLFxuICAgIH0pO1xuXG4gICAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gICAgY29uc29sZS5sb2coYFdyb3RlIHBvd2VyIHRlbGVtZXRyeSByZWNvcmQgZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH1gKTtcbiAgfSBlbHNlIHtcbiAgICBjb25zb2xlLmxvZygnTm8gcG93ZXIgbWV0cmljcyBpbiBfbG9nLnFvIGV2ZW50LCBza2lwcGluZycpO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlSGVhbHRoRXZlbnQoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGltZXN0YW1wID0gZXZlbnQudGltZXN0YW1wICogMTAwMDsgLy8gQ29udmVydCB0byBtaWxsaXNlY29uZHNcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCkgKyBUVExfU0VDT05EUztcblxuICBjb25zdCByZWNvcmQ6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICB0aW1lc3RhbXAsXG4gICAgdHRsLFxuICAgIGRhdGFfdHlwZTogJ2hlYWx0aCcsXG4gICAgZXZlbnRfdHlwZTogZXZlbnQuZXZlbnRfdHlwZSxcbiAgICBldmVudF90eXBlX3RpbWVzdGFtcDogYGhlYWx0aCMke3RpbWVzdGFtcH1gLFxuICAgIHNlcmlhbF9udW1iZXI6IGV2ZW50LnNlcmlhbF9udW1iZXIgfHwgJ3Vua25vd24nLFxuICAgIGZsZWV0OiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gIH07XG5cbiAgLy8gQWRkIGhlYWx0aCBldmVudCBmaWVsZHNcbiAgaWYgKGV2ZW50LmJvZHkubWV0aG9kICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQubWV0aG9kID0gZXZlbnQuYm9keS5tZXRob2Q7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkudGV4dCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnRleHQgPSBldmVudC5ib2R5LnRleHQ7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkudm9sdGFnZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnZvbHRhZ2UgPSBldmVudC5ib2R5LnZvbHRhZ2U7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkudm9sdGFnZV9tb2RlICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQudm9sdGFnZV9tb2RlID0gZXZlbnQuYm9keS52b2x0YWdlX21vZGU7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkubWlsbGlhbXBfaG91cnMgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5taWxsaWFtcF9ob3VycyA9IGV2ZW50LmJvZHkubWlsbGlhbXBfaG91cnM7XG4gIH1cblxuICAvLyBBZGQgbG9jYXRpb24gaWYgYXZhaWxhYmxlXG4gIGlmIChldmVudC5sb2NhdGlvbj8ubGF0ICE9PSB1bmRlZmluZWQgJiYgZXZlbnQubG9jYXRpb24/LmxvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLmxhdGl0dWRlID0gZXZlbnQubG9jYXRpb24ubGF0O1xuICAgIHJlY29yZC5sb25naXR1ZGUgPSBldmVudC5sb2NhdGlvbi5sb247XG4gICAgcmVjb3JkLmxvY2F0aW9uX3NvdXJjZSA9IGV2ZW50LmxvY2F0aW9uLnNvdXJjZSB8fCAndG93ZXInO1xuICB9XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBQdXRDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IFRFTEVNRVRSWV9UQUJMRSxcbiAgICBJdGVtOiByZWNvcmQsXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgV3JvdGUgaGVhbHRoIGV2ZW50IHJlY29yZCBmb3IgJHtldmVudC5kZXZpY2VfdWlkfTogJHtldmVudC5ib2R5Lm1ldGhvZH1gKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gd3JpdGVMb2NhdGlvbkV2ZW50KGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmICghZXZlbnQubG9jYXRpb24/LmxhdCB8fCAhZXZlbnQubG9jYXRpb24/Lmxvbikge1xuICAgIGNvbnNvbGUubG9nKCdObyBsb2NhdGlvbiBkYXRhIGluIGV2ZW50LCBza2lwcGluZycpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHRpbWVzdGFtcCA9IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDA7IC8vIENvbnZlcnQgdG8gbWlsbGlzZWNvbmRzXG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgY29uc3QgcmVjb3JkOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge1xuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgdGltZXN0YW1wLFxuICAgIHR0bCxcbiAgICBkYXRhX3R5cGU6ICd0ZWxlbWV0cnknLCAvLyBVc2UgdGVsZW1ldHJ5IHNvIGl0J3MgcGlja2VkIHVwIGJ5IGxvY2F0aW9uIHF1ZXJ5XG4gICAgZXZlbnRfdHlwZTogZXZlbnQuZXZlbnRfdHlwZSxcbiAgICBldmVudF90eXBlX3RpbWVzdGFtcDogYHRlbGVtZXRyeSMke3RpbWVzdGFtcH1gLFxuICAgIHNlcmlhbF9udW1iZXI6IGV2ZW50LnNlcmlhbF9udW1iZXIgfHwgJ3Vua25vd24nLFxuICAgIGZsZWV0OiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gICAgbGF0aXR1ZGU6IGV2ZW50LmxvY2F0aW9uLmxhdCxcbiAgICBsb25naXR1ZGU6IGV2ZW50LmxvY2F0aW9uLmxvbixcbiAgICBsb2NhdGlvbl9zb3VyY2U6IGV2ZW50LmxvY2F0aW9uLnNvdXJjZSB8fCAndHJpYW5ndWxhdGlvbicsXG4gIH07XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBQdXRDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IFRFTEVNRVRSWV9UQUJMRSxcbiAgICBJdGVtOiByZWNvcmQsXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgV3JvdGUgbG9jYXRpb24gZXZlbnQgZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH06ICR7ZXZlbnQubG9jYXRpb24uc291cmNlfSAoJHtldmVudC5sb2NhdGlvbi5sYXR9LCAke2V2ZW50LmxvY2F0aW9uLmxvbn0pYCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHVwZGF0ZURldmljZU1ldGFkYXRhKGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG5cbiAgY29uc3QgdXBkYXRlRXhwcmVzc2lvbnM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICBjb25zdCBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge307XG5cbiAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI2xhc3Rfc2VlbiA9IDpsYXN0X3NlZW4nKTtcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjbGFzdF9zZWVuJ10gPSAnbGFzdF9zZWVuJztcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOmxhc3Rfc2VlbiddID0gbm93O1xuXG4gIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyN1cGRhdGVkX2F0ID0gOnVwZGF0ZWRfYXQnKTtcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjdXBkYXRlZF9hdCddID0gJ3VwZGF0ZWRfYXQnO1xuICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6dXBkYXRlZF9hdCddID0gbm93O1xuXG4gIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNzdGF0dXMgPSA6c3RhdHVzJyk7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3N0YXR1cyddID0gJ3N0YXR1cyc7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpzdGF0dXMnXSA9ICdvbmxpbmUnO1xuXG4gIGlmIChldmVudC5zZXJpYWxfbnVtYmVyKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3NuID0gOnNuJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjc24nXSA9ICdzZXJpYWxfbnVtYmVyJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6c24nXSA9IGV2ZW50LnNlcmlhbF9udW1iZXI7XG4gIH1cblxuICBpZiAoZXZlbnQuZmxlZXQpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjZmxlZXQgPSA6ZmxlZXQnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNmbGVldCddID0gJ2ZsZWV0JztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6ZmxlZXQnXSA9IGV2ZW50LmZsZWV0O1xuICB9XG5cbiAgaWYgKGV2ZW50LmJvZHkubW9kZSkge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNtb2RlID0gOm1vZGUnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNtb2RlJ10gPSAnY3VycmVudF9tb2RlJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6bW9kZSddID0gZXZlbnQuYm9keS5tb2RlO1xuICB9XG5cbiAgaWYgKGV2ZW50LmJvZHkudHJhbnNpdF9sb2NrZWQgIT09IHVuZGVmaW5lZCkge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyN0cmFuc2l0X2xvY2tlZCA9IDp0cmFuc2l0X2xvY2tlZCcpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3RyYW5zaXRfbG9ja2VkJ10gPSAndHJhbnNpdF9sb2NrZWQnO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzp0cmFuc2l0X2xvY2tlZCddID0gZXZlbnQuYm9keS50cmFuc2l0X2xvY2tlZDtcbiAgfVxuXG4gIGlmIChldmVudC5sb2NhdGlvbj8ubGF0ICE9PSB1bmRlZmluZWQgJiYgZXZlbnQubG9jYXRpb24/LmxvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI2xvYyA9IDpsb2MnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNsb2MnXSA9ICdsYXN0X2xvY2F0aW9uJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6bG9jJ10gPSB7XG4gICAgICBsYXQ6IGV2ZW50LmxvY2F0aW9uLmxhdCxcbiAgICAgIGxvbjogZXZlbnQubG9jYXRpb24ubG9uLFxuICAgICAgdGltZTogZXZlbnQubG9jYXRpb24udGltZSB8fCBldmVudC50aW1lc3RhbXAsXG4gICAgICBzb3VyY2U6IGV2ZW50LmxvY2F0aW9uLnNvdXJjZSB8fCAnZ3BzJyxcbiAgICAgIG5hbWU6IGV2ZW50LmxvY2F0aW9uLm5hbWUsXG4gICAgfTtcbiAgfVxuXG4gIGlmIChldmVudC5ldmVudF90eXBlID09PSAndHJhY2sucW8nKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3RlbGVtZXRyeSA9IDp0ZWxlbWV0cnknKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyN0ZWxlbWV0cnknXSA9ICdsYXN0X3RlbGVtZXRyeSc7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnRlbGVtZXRyeSddID0ge1xuICAgICAgdGVtcDogZXZlbnQuYm9keS50ZW1wLFxuICAgICAgaHVtaWRpdHk6IGV2ZW50LmJvZHkuaHVtaWRpdHksXG4gICAgICBwcmVzc3VyZTogZXZlbnQuYm9keS5wcmVzc3VyZSxcbiAgICAgIHZvbHRhZ2U6IGV2ZW50LmJvZHkudm9sdGFnZSxcbiAgICAgIG1vdGlvbjogZXZlbnQuYm9keS5tb3Rpb24sXG4gICAgICB0aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCxcbiAgICB9O1xuICB9XG5cbiAgaWYgKGV2ZW50LmV2ZW50X3R5cGUgPT09ICdfbG9nLnFvJykge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNwb3dlciA9IDpwb3dlcicpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3Bvd2VyJ10gPSAnbGFzdF9wb3dlcic7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnBvd2VyJ10gPSB7XG4gICAgICB2b2x0YWdlOiBldmVudC5ib2R5LnZvbHRhZ2UsXG4gICAgICB0ZW1wZXJhdHVyZTogZXZlbnQuYm9keS50ZW1wZXJhdHVyZSxcbiAgICAgIG1pbGxpYW1wX2hvdXJzOiBldmVudC5ib2R5Lm1pbGxpYW1wX2hvdXJzLFxuICAgICAgdGltZXN0YW1wOiBldmVudC50aW1lc3RhbXAsXG4gICAgfTtcbiAgfVxuXG4gIC8vIFVwZGF0ZSBmaXJtd2FyZSB2ZXJzaW9ucyBmcm9tIF9zZXNzaW9uLnFvIGV2ZW50c1xuICBpZiAoZXZlbnQuc2Vzc2lvbj8uZmlybXdhcmVfdmVyc2lvbikge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNmd192ZXJzaW9uID0gOmZ3X3ZlcnNpb24nKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNmd192ZXJzaW9uJ10gPSAnZmlybXdhcmVfdmVyc2lvbic7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOmZ3X3ZlcnNpb24nXSA9IGV2ZW50LnNlc3Npb24uZmlybXdhcmVfdmVyc2lvbjtcbiAgfVxuXG4gIGlmIChldmVudC5zZXNzaW9uPy5ub3RlY2FyZF92ZXJzaW9uKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI25jX3ZlcnNpb24gPSA6bmNfdmVyc2lvbicpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI25jX3ZlcnNpb24nXSA9ICdub3RlY2FyZF92ZXJzaW9uJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6bmNfdmVyc2lvbiddID0gZXZlbnQuc2Vzc2lvbi5ub3RlY2FyZF92ZXJzaW9uO1xuICB9XG5cbiAgaWYgKGV2ZW50LnNlc3Npb24/Lm5vdGVjYXJkX3NrdSkge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNuY19za3UgPSA6bmNfc2t1Jyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjbmNfc2t1J10gPSAnbm90ZWNhcmRfc2t1JztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6bmNfc2t1J10gPSBldmVudC5zZXNzaW9uLm5vdGVjYXJkX3NrdTtcbiAgfVxuXG4gIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNjcmVhdGVkX2F0ID0gaWZfbm90X2V4aXN0cygjY3JlYXRlZF9hdCwgOmNyZWF0ZWRfYXQpJyk7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI2NyZWF0ZWRfYXQnXSA9ICdjcmVhdGVkX2F0JztcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOmNyZWF0ZWRfYXQnXSA9IG5vdztcblxuICBjb25zdCBjb21tYW5kID0gbmV3IFVwZGF0ZUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICBLZXk6IHsgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCB9LFxuICAgIFVwZGF0ZUV4cHJlc3Npb246ICdTRVQgJyArIHVwZGF0ZUV4cHJlc3Npb25zLmpvaW4oJywgJyksXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiBleHByZXNzaW9uQXR0cmlidXRlTmFtZXMsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczogZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlcyxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBVcGRhdGVkIGRldmljZSBtZXRhZGF0YSBmb3IgJHtldmVudC5kZXZpY2VfdWlkfWApO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwcm9jZXNzQ29tbWFuZEFjayhldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBjbWRJZCA9IGV2ZW50LmJvZHkuY21kX2lkO1xuICBpZiAoIWNtZElkKSB7XG4gICAgY29uc29sZS5sb2coJ0NvbW1hbmQgYWNrIG1pc3NpbmcgY21kX2lkLCBza2lwcGluZycpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBVcGRhdGVDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IENPTU1BTkRTX1RBQkxFLFxuICAgIEtleToge1xuICAgICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICAgIGNvbW1hbmRfaWQ6IGNtZElkLFxuICAgIH0sXG4gICAgVXBkYXRlRXhwcmVzc2lvbjogJ1NFVCAjc3RhdHVzID0gOnN0YXR1cywgI21lc3NhZ2UgPSA6bWVzc2FnZSwgI2V4ZWN1dGVkX2F0ID0gOmV4ZWN1dGVkX2F0LCAjdXBkYXRlZF9hdCA9IDp1cGRhdGVkX2F0JyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICcjc3RhdHVzJzogJ3N0YXR1cycsXG4gICAgICAnI21lc3NhZ2UnOiAnbWVzc2FnZScsXG4gICAgICAnI2V4ZWN1dGVkX2F0JzogJ2V4ZWN1dGVkX2F0JyxcbiAgICAgICcjdXBkYXRlZF9hdCc6ICd1cGRhdGVkX2F0JyxcbiAgICB9LFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6c3RhdHVzJzogZXZlbnQuYm9keS5zdGF0dXMgfHwgJ3Vua25vd24nLFxuICAgICAgJzptZXNzYWdlJzogZXZlbnQuYm9keS5tZXNzYWdlIHx8ICcnLFxuICAgICAgJzpleGVjdXRlZF9hdCc6IGV2ZW50LmJvZHkuZXhlY3V0ZWRfYXQgPyBldmVudC5ib2R5LmV4ZWN1dGVkX2F0ICogMTAwMCA6IG5vdyxcbiAgICAgICc6dXBkYXRlZF9hdCc6IG5vdyxcbiAgICB9LFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFVwZGF0ZWQgY29tbWFuZCAke2NtZElkfSB3aXRoIHN0YXR1czogJHtldmVudC5ib2R5LnN0YXR1c31gKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc3RvcmVBbGVydChldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKG5vdyAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgLy8gR2VuZXJhdGUgYSB1bmlxdWUgYWxlcnQgSURcbiAgY29uc3QgYWxlcnRJZCA9IGBhbGVydF8ke2V2ZW50LmRldmljZV91aWR9XyR7bm93fV8ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnN1YnN0cmluZyg3KX1gO1xuXG4gIGNvbnN0IGFsZXJ0UmVjb3JkID0ge1xuICAgIGFsZXJ0X2lkOiBhbGVydElkLFxuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgICB0eXBlOiBldmVudC5ib2R5LnR5cGUgfHwgJ3Vua25vd24nLFxuICAgIHZhbHVlOiBldmVudC5ib2R5LnZhbHVlLFxuICAgIHRocmVzaG9sZDogZXZlbnQuYm9keS50aHJlc2hvbGQsXG4gICAgbWVzc2FnZTogZXZlbnQuYm9keS5tZXNzYWdlIHx8ICcnLFxuICAgIGNyZWF0ZWRfYXQ6IG5vdyxcbiAgICBldmVudF90aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDAsXG4gICAgYWNrbm93bGVkZ2VkOiAnZmFsc2UnLCAvLyBTdHJpbmcgZm9yIEdTSSBwYXJ0aXRpb24ga2V5XG4gICAgdHRsLFxuICAgIGxvY2F0aW9uOiBldmVudC5sb2NhdGlvbiA/IHtcbiAgICAgIGxhdDogZXZlbnQubG9jYXRpb24ubGF0LFxuICAgICAgbG9uOiBldmVudC5sb2NhdGlvbi5sb24sXG4gICAgfSA6IHVuZGVmaW5lZCxcbiAgfTtcblxuICBjb25zdCBjb21tYW5kID0gbmV3IFB1dENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogQUxFUlRTX1RBQkxFLFxuICAgIEl0ZW06IGFsZXJ0UmVjb3JkLFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFN0b3JlZCBhbGVydCAke2FsZXJ0SWR9IGZvciAke2V2ZW50LmRldmljZV91aWR9YCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHB1Ymxpc2hBbGVydChldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBhbGVydE1lc3NhZ2UgPSB7XG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyLFxuICAgIGZsZWV0OiBldmVudC5mbGVldCxcbiAgICBhbGVydF90eXBlOiBldmVudC5ib2R5LnR5cGUsXG4gICAgdmFsdWU6IGV2ZW50LmJvZHkudmFsdWUsXG4gICAgdGhyZXNob2xkOiBldmVudC5ib2R5LnRocmVzaG9sZCxcbiAgICBtZXNzYWdlOiBldmVudC5ib2R5Lm1lc3NhZ2UsXG4gICAgdGltZXN0YW1wOiBldmVudC50aW1lc3RhbXAsXG4gICAgbG9jYXRpb246IGV2ZW50LmxvY2F0aW9uLFxuICB9O1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHVibGlzaENvbW1hbmQoe1xuICAgIFRvcGljQXJuOiBBTEVSVF9UT1BJQ19BUk4sXG4gICAgU3ViamVjdDogYFNvbmdiaXJkIEFsZXJ0OiAke2V2ZW50LmJvZHkudHlwZX0gLSAke2V2ZW50LnNlcmlhbF9udW1iZXIgfHwgZXZlbnQuZGV2aWNlX3VpZH1gLFxuICAgIE1lc3NhZ2U6IEpTT04uc3RyaW5naWZ5KGFsZXJ0TWVzc2FnZSwgbnVsbCwgMiksXG4gICAgTWVzc2FnZUF0dHJpYnV0ZXM6IHtcbiAgICAgIGFsZXJ0X3R5cGU6IHtcbiAgICAgICAgRGF0YVR5cGU6ICdTdHJpbmcnLFxuICAgICAgICBTdHJpbmdWYWx1ZTogZXZlbnQuYm9keS50eXBlIHx8ICd1bmtub3duJyxcbiAgICAgIH0sXG4gICAgICBkZXZpY2VfdWlkOiB7XG4gICAgICAgIERhdGFUeXBlOiAnU3RyaW5nJyxcbiAgICAgICAgU3RyaW5nVmFsdWU6IGV2ZW50LmRldmljZV91aWQsXG4gICAgICB9LFxuICAgICAgZmxlZXQ6IHtcbiAgICAgICAgRGF0YVR5cGU6ICdTdHJpbmcnLFxuICAgICAgICBTdHJpbmdWYWx1ZTogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICAgICAgfSxcbiAgICB9LFxuICB9KTtcblxuICBhd2FpdCBzbnNDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFB1Ymxpc2hlZCBhbGVydCB0byBTTlM6ICR7ZXZlbnQuYm9keS50eXBlfWApO1xufVxuIl19