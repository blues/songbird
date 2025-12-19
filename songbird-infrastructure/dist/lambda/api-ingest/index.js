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
 * Extract location from Notehub event, preferring GPS but falling back to triangulation
 */
function extractLocation(event) {
    // Prefer GPS location (best_lat/best_lon with type 'gps')
    if (event.best_lat !== undefined && event.best_lon !== undefined) {
        return {
            lat: event.best_lat,
            lon: event.best_lon,
            time: event.best_location_when,
            source: event.best_location_type || 'gps',
        };
    }
    // Fall back to triangulation data
    if (event.tri_lat !== undefined && event.tri_lon !== undefined) {
        return {
            lat: event.tri_lat,
            lon: event.tri_lon,
            time: event.tri_when,
            source: 'triangulation',
        };
    }
    // Fall back to tower location
    if (event.tower_lat !== undefined && event.tower_lon !== undefined) {
        return {
            lat: event.tower_lat,
            lon: event.tower_lon,
            time: event.tower_when,
            source: 'tower',
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
    if (event.location?.lat !== undefined && event.location?.lon !== undefined) {
        updateExpressions.push('#loc = :loc');
        expressionAttributeNames['#loc'] = 'last_location';
        expressionAttributeValues[':loc'] = {
            lat: event.location.lat,
            lon: event.location.lon,
            time: event.location.time || event.timestamp,
            source: event.location.source || 'gps',
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWluZ2VzdC9pbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7O0dBS0c7OztBQUVILDhEQUEwRDtBQUMxRCx3REFBMEY7QUFDMUYsb0RBQWdFO0FBR2hFLHFCQUFxQjtBQUNyQixNQUFNLFNBQVMsR0FBRyxJQUFJLGdDQUFjLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDekMsTUFBTSxTQUFTLEdBQUcscUNBQXNCLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRTtJQUN2RCxlQUFlLEVBQUU7UUFDZixxQkFBcUIsRUFBRSxJQUFJO0tBQzVCO0NBQ0YsQ0FBQyxDQUFDO0FBQ0gsTUFBTSxTQUFTLEdBQUcsSUFBSSxzQkFBUyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBRXBDLHdCQUF3QjtBQUN4QixNQUFNLGVBQWUsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGVBQWdCLENBQUM7QUFDckQsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxhQUFjLENBQUM7QUFDakQsTUFBTSxjQUFjLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFlLENBQUM7QUFDbkQsTUFBTSxZQUFZLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxZQUFhLENBQUM7QUFDL0MsTUFBTSxlQUFlLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxlQUFnQixDQUFDO0FBRXJELDBCQUEwQjtBQUMxQixNQUFNLFFBQVEsR0FBRyxFQUFFLENBQUM7QUFDcEIsTUFBTSxXQUFXLEdBQUcsUUFBUSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxDQUFDO0FBK0RyQyxNQUFNLE9BQU8sR0FBRyxLQUFLLEVBQUUsS0FBMkIsRUFBa0MsRUFBRTtJQUMzRixPQUFPLENBQUMsR0FBRyxDQUFDLGlCQUFpQixFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMs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QUM5QyxpQkFBaUIsRUFBRTtZQUNqQixVQUFVLEVBQUU7Z0JBQ1YsUUFBUSxFQUFFLFFBQVE7Z0JBQ2xCLFdBQVcsRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksSUFBSSxTQUFTO2FBQzFDO1lBQ0QsVUFBVSxFQUFFO2dCQUNWLFFBQVEsRUFBRSxRQUFRO2dCQUNsQixXQUFXLEVBQUUsS0FBSyxDQUFDLFVBQVU7YUFDOUI7WUFDRCxLQUFLLEVBQUU7Z0JBQ0wsUUFBUSxFQUFFLFFBQVE7Z0JBQ2xCLFdBQVcsRUFBRSxLQUFLLENBQUMsS0FBSyxJQUFJLFNBQVM7YUFDdEM7U0FDRjtLQUNGLENBQUMsQ0FBQztJQUVILE1BQU0sU0FBUyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUM5QixPQUFPLENBQUMsR0FBRyxDQUFDLDJCQUEyQixLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUM7QUFDNUQsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRXZlbnQgSW5nZXN0IEFQSSBMYW1iZGFcbiAqXG4gKiBIVFRQIGVuZHBvaW50IGZvciByZWNlaXZpbmcgZXZlbnRzIGZyb20gTm90ZWh1YiBIVFRQIHJvdXRlcy5cbiAqIFByb2Nlc3NlcyBpbmNvbWluZyBTb25nYmlyZCBldmVudHMgYW5kIHdyaXRlcyB0byBEeW5hbW9EQi5cbiAqL1xuXG5pbXBvcnQgeyBEeW5hbW9EQkNsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYic7XG5pbXBvcnQgeyBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LCBQdXRDb21tYW5kLCBVcGRhdGVDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvbGliLWR5bmFtb2RiJztcbmltcG9ydCB7IFNOU0NsaWVudCwgUHVibGlzaENvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtc25zJztcbmltcG9ydCB7IEFQSUdhdGV3YXlQcm94eUV2ZW50LCBBUElHYXRld2F5UHJveHlSZXN1bHQgfSBmcm9tICdhd3MtbGFtYmRhJztcblxuLy8gSW5pdGlhbGl6ZSBjbGllbnRzXG5jb25zdCBkZGJDbGllbnQgPSBuZXcgRHluYW1vREJDbGllbnQoe30pO1xuY29uc3QgZG9jQ2xpZW50ID0gRHluYW1vREJEb2N1bWVudENsaWVudC5mcm9tKGRkYkNsaWVudCwge1xuICBtYXJzaGFsbE9wdGlvbnM6IHtcbiAgICByZW1vdmVVbmRlZmluZWRWYWx1ZXM6IHRydWUsXG4gIH0sXG59KTtcbmNvbnN0IHNuc0NsaWVudCA9IG5ldyBTTlNDbGllbnQoe30pO1xuXG4vLyBFbnZpcm9ubWVudCB2YXJpYWJsZXNcbmNvbnN0IFRFTEVNRVRSWV9UQUJMRSA9IHByb2Nlc3MuZW52LlRFTEVNRVRSWV9UQUJMRSE7XG5jb25zdCBERVZJQ0VTX1RBQkxFID0gcHJvY2Vzcy5lbnYuREVWSUNFU19UQUJMRSE7XG5jb25zdCBDT01NQU5EU19UQUJMRSA9IHByb2Nlc3MuZW52LkNPTU1BTkRTX1RBQkxFITtcbmNvbnN0IEFMRVJUU19UQUJMRSA9IHByb2Nlc3MuZW52LkFMRVJUU19UQUJMRSE7XG5jb25zdCBBTEVSVF9UT1BJQ19BUk4gPSBwcm9jZXNzLmVudi5BTEVSVF9UT1BJQ19BUk4hO1xuXG4vLyBUVEw6IDkwIGRheXMgaW4gc2Vjb25kc1xuY29uc3QgVFRMX0RBWVMgPSA5MDtcbmNvbnN0IFRUTF9TRUNPTkRTID0gVFRMX0RBWVMgKiAyNCAqIDYwICogNjA7XG5cbi8vIE5vdGVodWIgZXZlbnQgc3RydWN0dXJlIChmcm9tIEhUVFAgcm91dGUpXG5pbnRlcmZhY2UgTm90ZWh1YkV2ZW50IHtcbiAgZXZlbnQ6IHN0cmluZzsgICAgICAgICAgIC8vIGUuZy4sIFwiZGV2Onh4eHh4I3RyYWNrLnFvIzFcIlxuICBzZXNzaW9uOiBzdHJpbmc7XG4gIGJlc3RfaWQ6IHN0cmluZztcbiAgZGV2aWNlOiBzdHJpbmc7ICAgICAgICAgIC8vIERldmljZSBVSURcbiAgc246IHN0cmluZzsgICAgICAgICAgICAgIC8vIFNlcmlhbCBudW1iZXJcbiAgcHJvZHVjdDogc3RyaW5nO1xuICBhcHA6IHN0cmluZztcbiAgcmVjZWl2ZWQ6IG51bWJlcjtcbiAgcmVxOiBzdHJpbmc7ICAgICAgICAgICAgIC8vIGUuZy4sIFwibm90ZS5hZGRcIlxuICB3aGVuOiBudW1iZXI7ICAgICAgICAgICAgLy8gVW5peCB0aW1lc3RhbXBcbiAgZmlsZTogc3RyaW5nOyAgICAgICAgICAgIC8vIGUuZy4sIFwidHJhY2sucW9cIlxuICBib2R5OiB7XG4gICAgdGVtcD86IG51bWJlcjtcbiAgICBodW1pZGl0eT86IG51bWJlcjtcbiAgICBwcmVzc3VyZT86IG51bWJlcjtcbiAgICB2b2x0YWdlPzogbnVtYmVyO1xuICAgIG1vdGlvbj86IGJvb2xlYW47XG4gICAgbW9kZT86IHN0cmluZztcbiAgICAvLyBBbGVydC1zcGVjaWZpYyBmaWVsZHNcbiAgICB0eXBlPzogc3RyaW5nO1xuICAgIHZhbHVlPzogbnVtYmVyO1xuICAgIHRocmVzaG9sZD86IG51bWJlcjtcbiAgICBtZXNzYWdlPzogc3RyaW5nO1xuICAgIC8vIENvbW1hbmQgYWNrIGZpZWxkc1xuICAgIGNtZD86IHN0cmluZztcbiAgICBzdGF0dXM/OiBzdHJpbmc7XG4gICAgZXhlY3V0ZWRfYXQ/OiBudW1iZXI7XG4gICAgLy8gTW9qbyBwb3dlciBtb25pdG9yaW5nIGZpZWxkcyAoX2xvZy5xbylcbiAgICBtaWxsaWFtcF9ob3Vycz86IG51bWJlcjtcbiAgICB0ZW1wZXJhdHVyZT86IG51bWJlcjtcbiAgICAvLyBIZWFsdGggZXZlbnQgZmllbGRzIChfaGVhbHRoLnFvKVxuICAgIG1ldGhvZD86IHN0cmluZztcbiAgICB0ZXh0Pzogc3RyaW5nO1xuICAgIHZvbHRhZ2VfbW9kZT86IHN0cmluZztcbiAgfTtcbiAgYmVzdF9sb2NhdGlvbl90eXBlPzogc3RyaW5nO1xuICBiZXN0X2xvY2F0aW9uX3doZW4/OiBudW1iZXI7XG4gIGJlc3RfbGF0PzogbnVtYmVyO1xuICBiZXN0X2xvbj86IG51bWJlcjtcbiAgYmVzdF9sb2NhdGlvbj86IHN0cmluZztcbiAgdG93ZXJfbG9jYXRpb24/OiBzdHJpbmc7XG4gIHRvd2VyX2xhdD86IG51bWJlcjtcbiAgdG93ZXJfbG9uPzogbnVtYmVyO1xuICB0b3dlcl93aGVuPzogbnVtYmVyO1xuICAvLyBUcmlhbmd1bGF0aW9uIGZpZWxkcyAoZnJvbSBfZ2VvbG9jYXRlLnFvIG9yIGVucmljaGVkIGV2ZW50cylcbiAgdHJpX3doZW4/OiBudW1iZXI7XG4gIHRyaV9sYXQ/OiBudW1iZXI7XG4gIHRyaV9sb24/OiBudW1iZXI7XG4gIHRyaV9sb2NhdGlvbj86IHN0cmluZztcbiAgdHJpX2NvdW50cnk/OiBzdHJpbmc7XG4gIHRyaV90aW1lem9uZT86IHN0cmluZztcbiAgdHJpX3BvaW50cz86IG51bWJlcjsgIC8vIE51bWJlciBvZiByZWZlcmVuY2UgcG9pbnRzIHVzZWQgZm9yIHRyaWFuZ3VsYXRpb25cbiAgZmxlZXRzPzogc3RyaW5nW107XG4gIC8vIFNlc3Npb24gZmllbGRzIChfc2Vzc2lvbi5xbylcbiAgZmlybXdhcmVfaG9zdD86IHN0cmluZzsgICAgIC8vIEpTT04gc3RyaW5nIHdpdGggaG9zdCBmaXJtd2FyZSBpbmZvXG4gIGZpcm13YXJlX25vdGVjYXJkPzogc3RyaW5nOyAvLyBKU09OIHN0cmluZyB3aXRoIE5vdGVjYXJkIGZpcm13YXJlIGluZm9cbiAgc2t1Pzogc3RyaW5nOyAgICAgICAgICAgICAgIC8vIE5vdGVjYXJkIFNLVSAoZS5nLiwgXCJOT1RFLVdCR0xXXCIpXG59XG5cbmV4cG9ydCBjb25zdCBoYW5kbGVyID0gYXN5bmMgKGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudCk6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiA9PiB7XG4gIGNvbnNvbGUubG9nKCdJbmdlc3QgcmVxdWVzdDonLCBKU09OLnN0cmluZ2lmeShldmVudCkpO1xuXG4gIGNvbnN0IGhlYWRlcnMgPSB7XG4gICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgfTtcblxuICB0cnkge1xuICAgIGlmICghZXZlbnQuYm9keSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnUmVxdWVzdCBib2R5IHJlcXVpcmVkJyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgY29uc3Qgbm90ZWh1YkV2ZW50OiBOb3RlaHViRXZlbnQgPSBKU09OLnBhcnNlKGV2ZW50LmJvZHkpO1xuICAgIGNvbnNvbGUubG9nKCdQcm9jZXNzaW5nIE5vdGVodWIgZXZlbnQ6JywgSlNPTi5zdHJpbmdpZnkobm90ZWh1YkV2ZW50KSk7XG5cbiAgICAvLyBUcmFuc2Zvcm0gdG8gaW50ZXJuYWwgZm9ybWF0XG4gICAgLy8gVXNlICd3aGVuJyBpZiBhdmFpbGFibGUsIG90aGVyd2lzZSBmYWxsIGJhY2sgdG8gJ3JlY2VpdmVkJyAoYXMgaW50ZWdlciBzZWNvbmRzKVxuICAgIGNvbnN0IGV2ZW50VGltZXN0YW1wID0gbm90ZWh1YkV2ZW50LndoZW4gfHwgTWF0aC5mbG9vcihub3RlaHViRXZlbnQucmVjZWl2ZWQpO1xuXG4gICAgLy8gRXh0cmFjdCBsb2NhdGlvbiAtIHByZWZlciBHUFMgKGJlc3RfbGF0L2Jlc3RfbG9uKSwgZmFsbCBiYWNrIHRvIHRyaWFuZ3VsYXRpb25cbiAgICBjb25zdCBsb2NhdGlvbiA9IGV4dHJhY3RMb2NhdGlvbihub3RlaHViRXZlbnQpO1xuXG4gICAgLy8gRXh0cmFjdCBzZXNzaW9uIGluZm8gKGZpcm13YXJlIHZlcnNpb25zLCBTS1UpIGZyb20gX3Nlc3Npb24ucW8gZXZlbnRzXG4gICAgY29uc3Qgc2Vzc2lvbkluZm8gPSBleHRyYWN0U2Vzc2lvbkluZm8obm90ZWh1YkV2ZW50KTtcblxuICAgIGNvbnN0IHNvbmdiaXJkRXZlbnQgPSB7XG4gICAgICBkZXZpY2VfdWlkOiBub3RlaHViRXZlbnQuZGV2aWNlLFxuICAgICAgc2VyaWFsX251bWJlcjogbm90ZWh1YkV2ZW50LnNuLFxuICAgICAgZmxlZXQ6IG5vdGVodWJFdmVudC5mbGVldHM/LlswXSB8fCAnZGVmYXVsdCcsXG4gICAgICBldmVudF90eXBlOiBub3RlaHViRXZlbnQuZmlsZSxcbiAgICAgIHRpbWVzdGFtcDogZXZlbnRUaW1lc3RhbXAsXG4gICAgICByZWNlaXZlZDogbm90ZWh1YkV2ZW50LnJlY2VpdmVkLFxuICAgICAgYm9keTogbm90ZWh1YkV2ZW50LmJvZHkgfHwge30sXG4gICAgICBsb2NhdGlvbixcbiAgICAgIHNlc3Npb246IHNlc3Npb25JbmZvLFxuICAgIH07XG5cbiAgICAvLyBXcml0ZSB0ZWxlbWV0cnkgdG8gRHluYW1vREIgKGZvciB0cmFjay5xbyBldmVudHMpXG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuZXZlbnRfdHlwZSA9PT0gJ3RyYWNrLnFvJykge1xuICAgICAgYXdhaXQgd3JpdGVUZWxlbWV0cnkoc29uZ2JpcmRFdmVudCwgJ3RlbGVtZXRyeScpO1xuICAgIH1cblxuICAgIC8vIFdyaXRlIE1vam8gcG93ZXIgZGF0YSB0byBEeW5hbW9EQiAoX2xvZy5xbyBjb250YWlucyBwb3dlciB0ZWxlbWV0cnkpXG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuZXZlbnRfdHlwZSA9PT0gJ19sb2cucW8nKSB7XG4gICAgICBhd2FpdCB3cml0ZVBvd2VyVGVsZW1ldHJ5KHNvbmdiaXJkRXZlbnQpO1xuICAgIH1cblxuICAgIC8vIFdyaXRlIGhlYWx0aCBldmVudHMgdG8gRHluYW1vREIgKF9oZWFsdGgucW8pXG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuZXZlbnRfdHlwZSA9PT0gJ19oZWFsdGgucW8nKSB7XG4gICAgICBhd2FpdCB3cml0ZUhlYWx0aEV2ZW50KHNvbmdiaXJkRXZlbnQpO1xuICAgIH1cblxuICAgIC8vIEhhbmRsZSB0cmlhbmd1bGF0aW9uIHJlc3VsdHMgKF9nZW9sb2NhdGUucW8pXG4gICAgLy8gV3JpdGUgbG9jYXRpb24gdG8gdGVsZW1ldHJ5IHRhYmxlIGZvciBsb2NhdGlvbiBoaXN0b3J5IHRyYWlsXG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuZXZlbnRfdHlwZSA9PT0gJ19nZW9sb2NhdGUucW8nICYmIHNvbmdiaXJkRXZlbnQubG9jYXRpb24pIHtcbiAgICAgIGF3YWl0IHdyaXRlTG9jYXRpb25FdmVudChzb25nYmlyZEV2ZW50KTtcbiAgICB9XG5cbiAgICAvLyBVcGRhdGUgZGV2aWNlIG1ldGFkYXRhIGluIER5bmFtb0RCXG4gICAgYXdhaXQgdXBkYXRlRGV2aWNlTWV0YWRhdGEoc29uZ2JpcmRFdmVudCk7XG5cbiAgICAvLyBTdG9yZSBhbmQgcHVibGlzaCBhbGVydCBpZiB0aGlzIGlzIGFuIGFsZXJ0IGV2ZW50XG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuZXZlbnRfdHlwZSA9PT0gJ2FsZXJ0LnFvJykge1xuICAgICAgYXdhaXQgc3RvcmVBbGVydChzb25nYmlyZEV2ZW50KTtcbiAgICAgIGF3YWl0IHB1Ymxpc2hBbGVydChzb25nYmlyZEV2ZW50KTtcbiAgICB9XG5cbiAgICAvLyBQcm9jZXNzIGNvbW1hbmQgYWNrbm93bGVkZ21lbnRcbiAgICBpZiAoc29uZ2JpcmRFdmVudC5ldmVudF90eXBlID09PSAnY29tbWFuZF9hY2sucW8nKSB7XG4gICAgICBhd2FpdCBwcm9jZXNzQ29tbWFuZEFjayhzb25nYmlyZEV2ZW50KTtcbiAgICB9XG5cbiAgICBjb25zb2xlLmxvZygnRXZlbnQgcHJvY2Vzc2VkIHN1Y2Nlc3NmdWxseScpO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHN0YXR1czogJ29rJywgZGV2aWNlOiBzb25nYmlyZEV2ZW50LmRldmljZV91aWQgfSksXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvciBwcm9jZXNzaW5nIGV2ZW50OicsIGVycm9yKTtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNTAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnRlcm5hbCBzZXJ2ZXIgZXJyb3InIH0pLFxuICAgIH07XG4gIH1cbn07XG5cbmludGVyZmFjZSBTZXNzaW9uSW5mbyB7XG4gIGZpcm13YXJlX3ZlcnNpb24/OiBzdHJpbmc7XG4gIG5vdGVjYXJkX3ZlcnNpb24/OiBzdHJpbmc7XG4gIG5vdGVjYXJkX3NrdT86IHN0cmluZztcbn1cblxuLyoqXG4gKiBFeHRyYWN0IHNlc3Npb24gaW5mbyAoZmlybXdhcmUgdmVyc2lvbnMsIFNLVSkgZnJvbSBOb3RlaHViIGV2ZW50XG4gKiBUaGlzIGluZm8gaXMgYXZhaWxhYmxlIGluIF9zZXNzaW9uLnFvIGV2ZW50c1xuICovXG5mdW5jdGlvbiBleHRyYWN0U2Vzc2lvbkluZm8oZXZlbnQ6IE5vdGVodWJFdmVudCk6IFNlc3Npb25JbmZvIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFldmVudC5maXJtd2FyZV9ob3N0ICYmICFldmVudC5maXJtd2FyZV9ub3RlY2FyZCAmJiAhZXZlbnQuc2t1KSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuXG4gIGNvbnN0IHNlc3Npb25JbmZvOiBTZXNzaW9uSW5mbyA9IHt9O1xuXG4gIC8vIFBhcnNlIGhvc3QgZmlybXdhcmUgdmVyc2lvblxuICBpZiAoZXZlbnQuZmlybXdhcmVfaG9zdCkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBob3N0RmlybXdhcmUgPSBKU09OLnBhcnNlKGV2ZW50LmZpcm13YXJlX2hvc3QpO1xuICAgICAgc2Vzc2lvbkluZm8uZmlybXdhcmVfdmVyc2lvbiA9IGhvc3RGaXJtd2FyZS52ZXJzaW9uO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ0ZhaWxlZCB0byBwYXJzZSBmaXJtd2FyZV9ob3N0OicsIGUpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFBhcnNlIE5vdGVjYXJkIGZpcm13YXJlIHZlcnNpb25cbiAgaWYgKGV2ZW50LmZpcm13YXJlX25vdGVjYXJkKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IG5vdGVjYXJkRmlybXdhcmUgPSBKU09OLnBhcnNlKGV2ZW50LmZpcm13YXJlX25vdGVjYXJkKTtcbiAgICAgIHNlc3Npb25JbmZvLm5vdGVjYXJkX3ZlcnNpb24gPSBub3RlY2FyZEZpcm13YXJlLnZlcnNpb247XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS5lcnJvcignRmFpbGVkIHRvIHBhcnNlIGZpcm13YXJlX25vdGVjYXJkOicsIGUpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFNLVVxuICBpZiAoZXZlbnQuc2t1KSB7XG4gICAgc2Vzc2lvbkluZm8ubm90ZWNhcmRfc2t1ID0gZXZlbnQuc2t1O1xuICB9XG5cbiAgcmV0dXJuIE9iamVjdC5rZXlzKHNlc3Npb25JbmZvKS5sZW5ndGggPiAwID8gc2Vzc2lvbkluZm8gOiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogRXh0cmFjdCBsb2NhdGlvbiBmcm9tIE5vdGVodWIgZXZlbnQsIHByZWZlcnJpbmcgR1BTIGJ1dCBmYWxsaW5nIGJhY2sgdG8gdHJpYW5ndWxhdGlvblxuICovXG5mdW5jdGlvbiBleHRyYWN0TG9jYXRpb24oZXZlbnQ6IE5vdGVodWJFdmVudCk6IHsgbGF0OiBudW1iZXI7IGxvbjogbnVtYmVyOyB0aW1lPzogbnVtYmVyOyBzb3VyY2U6IHN0cmluZyB9IHwgdW5kZWZpbmVkIHtcbiAgLy8gUHJlZmVyIEdQUyBsb2NhdGlvbiAoYmVzdF9sYXQvYmVzdF9sb24gd2l0aCB0eXBlICdncHMnKVxuICBpZiAoZXZlbnQuYmVzdF9sYXQgIT09IHVuZGVmaW5lZCAmJiBldmVudC5iZXN0X2xvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGxhdDogZXZlbnQuYmVzdF9sYXQsXG4gICAgICBsb246IGV2ZW50LmJlc3RfbG9uLFxuICAgICAgdGltZTogZXZlbnQuYmVzdF9sb2NhdGlvbl93aGVuLFxuICAgICAgc291cmNlOiBldmVudC5iZXN0X2xvY2F0aW9uX3R5cGUgfHwgJ2dwcycsXG4gICAgfTtcbiAgfVxuXG4gIC8vIEZhbGwgYmFjayB0byB0cmlhbmd1bGF0aW9uIGRhdGFcbiAgaWYgKGV2ZW50LnRyaV9sYXQgIT09IHVuZGVmaW5lZCAmJiBldmVudC50cmlfbG9uICE9PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgbGF0OiBldmVudC50cmlfbGF0LFxuICAgICAgbG9uOiBldmVudC50cmlfbG9uLFxuICAgICAgdGltZTogZXZlbnQudHJpX3doZW4sXG4gICAgICBzb3VyY2U6ICd0cmlhbmd1bGF0aW9uJyxcbiAgICB9O1xuICB9XG5cbiAgLy8gRmFsbCBiYWNrIHRvIHRvd2VyIGxvY2F0aW9uXG4gIGlmIChldmVudC50b3dlcl9sYXQgIT09IHVuZGVmaW5lZCAmJiBldmVudC50b3dlcl9sb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB7XG4gICAgICBsYXQ6IGV2ZW50LnRvd2VyX2xhdCxcbiAgICAgIGxvbjogZXZlbnQudG93ZXJfbG9uLFxuICAgICAgdGltZTogZXZlbnQudG93ZXJfd2hlbixcbiAgICAgIHNvdXJjZTogJ3Rvd2VyJyxcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuaW50ZXJmYWNlIFNvbmdiaXJkRXZlbnQge1xuICBkZXZpY2VfdWlkOiBzdHJpbmc7XG4gIHNlcmlhbF9udW1iZXI/OiBzdHJpbmc7XG4gIGZsZWV0Pzogc3RyaW5nO1xuICBldmVudF90eXBlOiBzdHJpbmc7XG4gIHRpbWVzdGFtcDogbnVtYmVyO1xuICByZWNlaXZlZDogbnVtYmVyO1xuICBzZXNzaW9uPzogU2Vzc2lvbkluZm87XG4gIGJvZHk6IHtcbiAgICB0ZW1wPzogbnVtYmVyO1xuICAgIGh1bWlkaXR5PzogbnVtYmVyO1xuICAgIHByZXNzdXJlPzogbnVtYmVyO1xuICAgIHZvbHRhZ2U/OiBudW1iZXI7XG4gICAgbW90aW9uPzogYm9vbGVhbjtcbiAgICBtb2RlPzogc3RyaW5nO1xuICAgIHR5cGU/OiBzdHJpbmc7XG4gICAgdmFsdWU/OiBudW1iZXI7XG4gICAgdGhyZXNob2xkPzogbnVtYmVyO1xuICAgIG1lc3NhZ2U/OiBzdHJpbmc7XG4gICAgY21kPzogc3RyaW5nO1xuICAgIGNtZF9pZD86IHN0cmluZztcbiAgICBzdGF0dXM/OiBzdHJpbmc7XG4gICAgZXhlY3V0ZWRfYXQ/OiBudW1iZXI7XG4gICAgbWlsbGlhbXBfaG91cnM/OiBudW1iZXI7XG4gICAgdGVtcGVyYXR1cmU/OiBudW1iZXI7XG4gICAgLy8gSGVhbHRoIGV2ZW50IGZpZWxkc1xuICAgIG1ldGhvZD86IHN0cmluZztcbiAgICB0ZXh0Pzogc3RyaW5nO1xuICAgIHZvbHRhZ2VfbW9kZT86IHN0cmluZztcbiAgfTtcbiAgbG9jYXRpb24/OiB7XG4gICAgbGF0PzogbnVtYmVyO1xuICAgIGxvbj86IG51bWJlcjtcbiAgICB0aW1lPzogbnVtYmVyO1xuICAgIHNvdXJjZT86IHN0cmluZztcbiAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gd3JpdGVUZWxlbWV0cnkoZXZlbnQ6IFNvbmdiaXJkRXZlbnQsIGRhdGFUeXBlOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGltZXN0YW1wID0gZXZlbnQudGltZXN0YW1wICogMTAwMDsgLy8gQ29udmVydCB0byBtaWxsaXNlY29uZHNcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCkgKyBUVExfU0VDT05EUztcblxuICBjb25zdCByZWNvcmQ6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICB0aW1lc3RhbXAsXG4gICAgdHRsLFxuICAgIGRhdGFfdHlwZTogZGF0YVR5cGUsXG4gICAgZXZlbnRfdHlwZTogZXZlbnQuZXZlbnRfdHlwZSxcbiAgICBldmVudF90eXBlX3RpbWVzdGFtcDogYCR7ZGF0YVR5cGV9IyR7dGltZXN0YW1wfWAsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgfTtcblxuICBpZiAoZXZlbnQuYm9keS50ZW1wICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQudGVtcGVyYXR1cmUgPSBldmVudC5ib2R5LnRlbXA7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuaHVtaWRpdHkgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5odW1pZGl0eSA9IGV2ZW50LmJvZHkuaHVtaWRpdHk7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkucHJlc3N1cmUgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5wcmVzc3VyZSA9IGV2ZW50LmJvZHkucHJlc3N1cmU7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkudm9sdGFnZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnZvbHRhZ2UgPSBldmVudC5ib2R5LnZvbHRhZ2U7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkubW90aW9uICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQubW90aW9uID0gZXZlbnQuYm9keS5tb3Rpb247XG4gIH1cblxuICBpZiAoZXZlbnQubG9jYXRpb24/LmxhdCAhPT0gdW5kZWZpbmVkICYmIGV2ZW50LmxvY2F0aW9uPy5sb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5sYXRpdHVkZSA9IGV2ZW50LmxvY2F0aW9uLmxhdDtcbiAgICByZWNvcmQubG9uZ2l0dWRlID0gZXZlbnQubG9jYXRpb24ubG9uO1xuICAgIHJlY29yZC5sb2NhdGlvbl9zb3VyY2UgPSBldmVudC5sb2NhdGlvbi5zb3VyY2UgfHwgJ2dwcyc7XG4gIH1cblxuICBjb25zdCBjb21tYW5kID0gbmV3IFB1dENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogVEVMRU1FVFJZX1RBQkxFLFxuICAgIEl0ZW06IHJlY29yZCxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBXcm90ZSB0ZWxlbWV0cnkgcmVjb3JkIGZvciAke2V2ZW50LmRldmljZV91aWR9YCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlUG93ZXJUZWxlbWV0cnkoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGltZXN0YW1wID0gZXZlbnQudGltZXN0YW1wICogMTAwMDtcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCkgKyBUVExfU0VDT05EUztcblxuICBjb25zdCByZWNvcmQ6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICB0aW1lc3RhbXAsXG4gICAgdHRsLFxuICAgIGRhdGFfdHlwZTogJ3Bvd2VyJyxcbiAgICBldmVudF90eXBlOiBldmVudC5ldmVudF90eXBlLFxuICAgIGV2ZW50X3R5cGVfdGltZXN0YW1wOiBgcG93ZXIjJHt0aW1lc3RhbXB9YCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyIHx8ICd1bmtub3duJyxcbiAgICBmbGVldDogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICB9O1xuXG4gIGlmIChldmVudC5ib2R5LnZvbHRhZ2UgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5tb2pvX3ZvbHRhZ2UgPSBldmVudC5ib2R5LnZvbHRhZ2U7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkubWlsbGlhbXBfaG91cnMgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5taWxsaWFtcF9ob3VycyA9IGV2ZW50LmJvZHkubWlsbGlhbXBfaG91cnM7XG4gIH1cblxuICBpZiAocmVjb3JkLm1vam9fdm9sdGFnZSAhPT0gdW5kZWZpbmVkIHx8XG4gICAgICByZWNvcmQubW9qb190ZW1wZXJhdHVyZSAhPT0gdW5kZWZpbmVkIHx8XG4gICAgICByZWNvcmQubWlsbGlhbXBfaG91cnMgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IFRFTEVNRVRSWV9UQUJMRSxcbiAgICAgIEl0ZW06IHJlY29yZCxcbiAgICB9KTtcblxuICAgIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICAgIGNvbnNvbGUubG9nKGBXcm90ZSBwb3dlciB0ZWxlbWV0cnkgcmVjb3JkIGZvciAke2V2ZW50LmRldmljZV91aWR9YCk7XG4gIH0gZWxzZSB7XG4gICAgY29uc29sZS5sb2coJ05vIHBvd2VyIG1ldHJpY3MgaW4gX2xvZy5xbyBldmVudCwgc2tpcHBpbmcnKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiB3cml0ZUhlYWx0aEV2ZW50KGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRpbWVzdGFtcCA9IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDA7IC8vIENvbnZlcnQgdG8gbWlsbGlzZWNvbmRzXG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgY29uc3QgcmVjb3JkOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge1xuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgdGltZXN0YW1wLFxuICAgIHR0bCxcbiAgICBkYXRhX3R5cGU6ICdoZWFsdGgnLFxuICAgIGV2ZW50X3R5cGU6IGV2ZW50LmV2ZW50X3R5cGUsXG4gICAgZXZlbnRfdHlwZV90aW1lc3RhbXA6IGBoZWFsdGgjJHt0aW1lc3RhbXB9YCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyIHx8ICd1bmtub3duJyxcbiAgICBmbGVldDogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICB9O1xuXG4gIC8vIEFkZCBoZWFsdGggZXZlbnQgZmllbGRzXG4gIGlmIChldmVudC5ib2R5Lm1ldGhvZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLm1ldGhvZCA9IGV2ZW50LmJvZHkubWV0aG9kO1xuICB9XG4gIGlmIChldmVudC5ib2R5LnRleHQgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC50ZXh0ID0gZXZlbnQuYm9keS50ZXh0O1xuICB9XG4gIGlmIChldmVudC5ib2R5LnZvbHRhZ2UgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC52b2x0YWdlID0gZXZlbnQuYm9keS52b2x0YWdlO1xuICB9XG4gIGlmIChldmVudC5ib2R5LnZvbHRhZ2VfbW9kZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnZvbHRhZ2VfbW9kZSA9IGV2ZW50LmJvZHkudm9sdGFnZV9tb2RlO1xuICB9XG4gIGlmIChldmVudC5ib2R5Lm1pbGxpYW1wX2hvdXJzICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQubWlsbGlhbXBfaG91cnMgPSBldmVudC5ib2R5Lm1pbGxpYW1wX2hvdXJzO1xuICB9XG5cbiAgLy8gQWRkIGxvY2F0aW9uIGlmIGF2YWlsYWJsZVxuICBpZiAoZXZlbnQubG9jYXRpb24/LmxhdCAhPT0gdW5kZWZpbmVkICYmIGV2ZW50LmxvY2F0aW9uPy5sb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5sYXRpdHVkZSA9IGV2ZW50LmxvY2F0aW9uLmxhdDtcbiAgICByZWNvcmQubG9uZ2l0dWRlID0gZXZlbnQubG9jYXRpb24ubG9uO1xuICAgIHJlY29yZC5sb2NhdGlvbl9zb3VyY2UgPSBldmVudC5sb2NhdGlvbi5zb3VyY2UgfHwgJ3Rvd2VyJztcbiAgfVxuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBURUxFTUVUUllfVEFCTEUsXG4gICAgSXRlbTogcmVjb3JkLFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFdyb3RlIGhlYWx0aCBldmVudCByZWNvcmQgZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH06ICR7ZXZlbnQuYm9keS5tZXRob2R9YCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlTG9jYXRpb25FdmVudChldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBpZiAoIWV2ZW50LmxvY2F0aW9uPy5sYXQgfHwgIWV2ZW50LmxvY2F0aW9uPy5sb24pIHtcbiAgICBjb25zb2xlLmxvZygnTm8gbG9jYXRpb24gZGF0YSBpbiBldmVudCwgc2tpcHBpbmcnKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB0aW1lc3RhbXAgPSBldmVudC50aW1lc3RhbXAgKiAxMDAwOyAvLyBDb252ZXJ0IHRvIG1pbGxpc2Vjb25kc1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSArIFRUTF9TRUNPTkRTO1xuXG4gIGNvbnN0IHJlY29yZDogUmVjb3JkPHN0cmluZywgYW55PiA9IHtcbiAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgIHRpbWVzdGFtcCxcbiAgICB0dGwsXG4gICAgZGF0YV90eXBlOiAndGVsZW1ldHJ5JywgLy8gVXNlIHRlbGVtZXRyeSBzbyBpdCdzIHBpY2tlZCB1cCBieSBsb2NhdGlvbiBxdWVyeVxuICAgIGV2ZW50X3R5cGU6IGV2ZW50LmV2ZW50X3R5cGUsXG4gICAgZXZlbnRfdHlwZV90aW1lc3RhbXA6IGB0ZWxlbWV0cnkjJHt0aW1lc3RhbXB9YCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyIHx8ICd1bmtub3duJyxcbiAgICBmbGVldDogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICAgIGxhdGl0dWRlOiBldmVudC5sb2NhdGlvbi5sYXQsXG4gICAgbG9uZ2l0dWRlOiBldmVudC5sb2NhdGlvbi5sb24sXG4gICAgbG9jYXRpb25fc291cmNlOiBldmVudC5sb2NhdGlvbi5zb3VyY2UgfHwgJ3RyaWFuZ3VsYXRpb24nLFxuICB9O1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBURUxFTUVUUllfVEFCTEUsXG4gICAgSXRlbTogcmVjb3JkLFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFdyb3RlIGxvY2F0aW9uIGV2ZW50IGZvciAke2V2ZW50LmRldmljZV91aWR9OiAke2V2ZW50LmxvY2F0aW9uLnNvdXJjZX0gKCR7ZXZlbnQubG9jYXRpb24ubGF0fSwgJHtldmVudC5sb2NhdGlvbi5sb259KWApO1xufVxuXG5hc3luYyBmdW5jdGlvbiB1cGRhdGVEZXZpY2VNZXRhZGF0YShldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuXG4gIGNvbnN0IHVwZGF0ZUV4cHJlc3Npb25zOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBleHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgY29uc3QgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczogUmVjb3JkPHN0cmluZywgYW55PiA9IHt9O1xuXG4gIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNsYXN0X3NlZW4gPSA6bGFzdF9zZWVuJyk7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI2xhc3Rfc2VlbiddID0gJ2xhc3Rfc2Vlbic7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpsYXN0X3NlZW4nXSA9IG5vdztcblxuICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjdXBkYXRlZF9hdCA9IDp1cGRhdGVkX2F0Jyk7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3VwZGF0ZWRfYXQnXSA9ICd1cGRhdGVkX2F0JztcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnVwZGF0ZWRfYXQnXSA9IG5vdztcblxuICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjc3RhdHVzID0gOnN0YXR1cycpO1xuICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNzdGF0dXMnXSA9ICdzdGF0dXMnO1xuICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6c3RhdHVzJ10gPSAnb25saW5lJztcblxuICBpZiAoZXZlbnQuc2VyaWFsX251bWJlcikge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNzbiA9IDpzbicpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3NuJ10gPSAnc2VyaWFsX251bWJlcic7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnNuJ10gPSBldmVudC5zZXJpYWxfbnVtYmVyO1xuICB9XG5cbiAgaWYgKGV2ZW50LmZsZWV0KSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI2ZsZWV0ID0gOmZsZWV0Jyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjZmxlZXQnXSA9ICdmbGVldCc7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOmZsZWV0J10gPSBldmVudC5mbGVldDtcbiAgfVxuXG4gIGlmIChldmVudC5ib2R5Lm1vZGUpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjbW9kZSA9IDptb2RlJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjbW9kZSddID0gJ2N1cnJlbnRfbW9kZSc7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOm1vZGUnXSA9IGV2ZW50LmJvZHkubW9kZTtcbiAgfVxuXG4gIGlmIChldmVudC5sb2NhdGlvbj8ubGF0ICE9PSB1bmRlZmluZWQgJiYgZXZlbnQubG9jYXRpb24/LmxvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI2xvYyA9IDpsb2MnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNsb2MnXSA9ICdsYXN0X2xvY2F0aW9uJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6bG9jJ10gPSB7XG4gICAgICBsYXQ6IGV2ZW50LmxvY2F0aW9uLmxhdCxcbiAgICAgIGxvbjogZXZlbnQubG9jYXRpb24ubG9uLFxuICAgICAgdGltZTogZXZlbnQubG9jYXRpb24udGltZSB8fCBldmVudC50aW1lc3RhbXAsXG4gICAgICBzb3VyY2U6IGV2ZW50LmxvY2F0aW9uLnNvdXJjZSB8fCAnZ3BzJyxcbiAgICB9O1xuICB9XG5cbiAgaWYgKGV2ZW50LmV2ZW50X3R5cGUgPT09ICd0cmFjay5xbycpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjdGVsZW1ldHJ5ID0gOnRlbGVtZXRyeScpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3RlbGVtZXRyeSddID0gJ2xhc3RfdGVsZW1ldHJ5JztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6dGVsZW1ldHJ5J10gPSB7XG4gICAgICB0ZW1wOiBldmVudC5ib2R5LnRlbXAsXG4gICAgICBodW1pZGl0eTogZXZlbnQuYm9keS5odW1pZGl0eSxcbiAgICAgIHByZXNzdXJlOiBldmVudC5ib2R5LnByZXNzdXJlLFxuICAgICAgdm9sdGFnZTogZXZlbnQuYm9keS52b2x0YWdlLFxuICAgICAgbW90aW9uOiBldmVudC5ib2R5Lm1vdGlvbixcbiAgICAgIHRpbWVzdGFtcDogZXZlbnQudGltZXN0YW1wLFxuICAgIH07XG4gIH1cblxuICBpZiAoZXZlbnQuZXZlbnRfdHlwZSA9PT0gJ19sb2cucW8nKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3Bvd2VyID0gOnBvd2VyJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjcG93ZXInXSA9ICdsYXN0X3Bvd2VyJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6cG93ZXInXSA9IHtcbiAgICAgIHZvbHRhZ2U6IGV2ZW50LmJvZHkudm9sdGFnZSxcbiAgICAgIHRlbXBlcmF0dXJlOiBldmVudC5ib2R5LnRlbXBlcmF0dXJlLFxuICAgICAgbWlsbGlhbXBfaG91cnM6IGV2ZW50LmJvZHkubWlsbGlhbXBfaG91cnMsXG4gICAgICB0aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCxcbiAgICB9O1xuICB9XG5cbiAgLy8gVXBkYXRlIGZpcm13YXJlIHZlcnNpb25zIGZyb20gX3Nlc3Npb24ucW8gZXZlbnRzXG4gIGlmIChldmVudC5zZXNzaW9uPy5maXJtd2FyZV92ZXJzaW9uKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI2Z3X3ZlcnNpb24gPSA6ZndfdmVyc2lvbicpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI2Z3X3ZlcnNpb24nXSA9ICdmaXJtd2FyZV92ZXJzaW9uJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6ZndfdmVyc2lvbiddID0gZXZlbnQuc2Vzc2lvbi5maXJtd2FyZV92ZXJzaW9uO1xuICB9XG5cbiAgaWYgKGV2ZW50LnNlc3Npb24/Lm5vdGVjYXJkX3ZlcnNpb24pIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjbmNfdmVyc2lvbiA9IDpuY192ZXJzaW9uJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjbmNfdmVyc2lvbiddID0gJ25vdGVjYXJkX3ZlcnNpb24nO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpuY192ZXJzaW9uJ10gPSBldmVudC5zZXNzaW9uLm5vdGVjYXJkX3ZlcnNpb247XG4gIH1cblxuICBpZiAoZXZlbnQuc2Vzc2lvbj8ubm90ZWNhcmRfc2t1KSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI25jX3NrdSA9IDpuY19za3UnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNuY19za3UnXSA9ICdub3RlY2FyZF9za3UnO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpuY19za3UnXSA9IGV2ZW50LnNlc3Npb24ubm90ZWNhcmRfc2t1O1xuICB9XG5cbiAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI2NyZWF0ZWRfYXQgPSBpZl9ub3RfZXhpc3RzKCNjcmVhdGVkX2F0LCA6Y3JlYXRlZF9hdCknKTtcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjY3JlYXRlZF9hdCddID0gJ2NyZWF0ZWRfYXQnO1xuICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6Y3JlYXRlZF9hdCddID0gbm93O1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgVXBkYXRlQ29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgIEtleTogeyBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkIH0sXG4gICAgVXBkYXRlRXhwcmVzc2lvbjogJ1NFVCAnICsgdXBkYXRlRXhwcmVzc2lvbnMuam9pbignLCAnKSxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lcyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzLFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFVwZGF0ZWQgZGV2aWNlIG1ldGFkYXRhIGZvciAke2V2ZW50LmRldmljZV91aWR9YCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHByb2Nlc3NDb21tYW5kQWNrKGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGNtZElkID0gZXZlbnQuYm9keS5jbWRfaWQ7XG4gIGlmICghY21kSWQpIHtcbiAgICBjb25zb2xlLmxvZygnQ29tbWFuZCBhY2sgbWlzc2luZyBjbWRfaWQsIHNraXBwaW5nJyk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcblxuICBjb25zdCBjb21tYW5kID0gbmV3IFVwZGF0ZUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogQ09NTUFORFNfVEFCTEUsXG4gICAgS2V5OiB7XG4gICAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgICAgY29tbWFuZF9pZDogY21kSWQsXG4gICAgfSxcbiAgICBVcGRhdGVFeHByZXNzaW9uOiAnU0VUICNzdGF0dXMgPSA6c3RhdHVzLCAjbWVzc2FnZSA9IDptZXNzYWdlLCAjZXhlY3V0ZWRfYXQgPSA6ZXhlY3V0ZWRfYXQsICN1cGRhdGVkX2F0ID0gOnVwZGF0ZWRfYXQnLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczoge1xuICAgICAgJyNzdGF0dXMnOiAnc3RhdHVzJyxcbiAgICAgICcjbWVzc2FnZSc6ICdtZXNzYWdlJyxcbiAgICAgICcjZXhlY3V0ZWRfYXQnOiAnZXhlY3V0ZWRfYXQnLFxuICAgICAgJyN1cGRhdGVkX2F0JzogJ3VwZGF0ZWRfYXQnLFxuICAgIH0sXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzpzdGF0dXMnOiBldmVudC5ib2R5LnN0YXR1cyB8fCAndW5rbm93bicsXG4gICAgICAnOm1lc3NhZ2UnOiBldmVudC5ib2R5Lm1lc3NhZ2UgfHwgJycsXG4gICAgICAnOmV4ZWN1dGVkX2F0JzogZXZlbnQuYm9keS5leGVjdXRlZF9hdCA/IGV2ZW50LmJvZHkuZXhlY3V0ZWRfYXQgKiAxMDAwIDogbm93LFxuICAgICAgJzp1cGRhdGVkX2F0Jzogbm93LFxuICAgIH0sXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgVXBkYXRlZCBjb21tYW5kICR7Y21kSWR9IHdpdGggc3RhdHVzOiAke2V2ZW50LmJvZHkuc3RhdHVzfWApO1xufVxuXG5hc3luYyBmdW5jdGlvbiBzdG9yZUFsZXJ0KGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3Iobm93IC8gMTAwMCkgKyBUVExfU0VDT05EUztcblxuICAvLyBHZW5lcmF0ZSBhIHVuaXF1ZSBhbGVydCBJRFxuICBjb25zdCBhbGVydElkID0gYGFsZXJ0XyR7ZXZlbnQuZGV2aWNlX3VpZH1fJHtub3d9XyR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc3Vic3RyaW5nKDcpfWA7XG5cbiAgY29uc3QgYWxlcnRSZWNvcmQgPSB7XG4gICAgYWxlcnRfaWQ6IGFsZXJ0SWQsXG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyIHx8ICd1bmtub3duJyxcbiAgICBmbGVldDogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICAgIHR5cGU6IGV2ZW50LmJvZHkudHlwZSB8fCAndW5rbm93bicsXG4gICAgdmFsdWU6IGV2ZW50LmJvZHkudmFsdWUsXG4gICAgdGhyZXNob2xkOiBldmVudC5ib2R5LnRocmVzaG9sZCxcbiAgICBtZXNzYWdlOiBldmVudC5ib2R5Lm1lc3NhZ2UgfHwgJycsXG4gICAgY3JlYXRlZF9hdDogbm93LFxuICAgIGV2ZW50X3RpbWVzdGFtcDogZXZlbnQudGltZXN0YW1wICogMTAwMCxcbiAgICBhY2tub3dsZWRnZWQ6ICdmYWxzZScsIC8vIFN0cmluZyBmb3IgR1NJIHBhcnRpdGlvbiBrZXlcbiAgICB0dGwsXG4gICAgbG9jYXRpb246IGV2ZW50LmxvY2F0aW9uID8ge1xuICAgICAgbGF0OiBldmVudC5sb2NhdGlvbi5sYXQsXG4gICAgICBsb246IGV2ZW50LmxvY2F0aW9uLmxvbixcbiAgICB9IDogdW5kZWZpbmVkLFxuICB9O1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBBTEVSVFNfVEFCTEUsXG4gICAgSXRlbTogYWxlcnRSZWNvcmQsXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgU3RvcmVkIGFsZXJ0ICR7YWxlcnRJZH0gZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH1gKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcHVibGlzaEFsZXJ0KGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGFsZXJ0TWVzc2FnZSA9IHtcbiAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgIHNlcmlhbF9udW1iZXI6IGV2ZW50LnNlcmlhbF9udW1iZXIsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0LFxuICAgIGFsZXJ0X3R5cGU6IGV2ZW50LmJvZHkudHlwZSxcbiAgICB2YWx1ZTogZXZlbnQuYm9keS52YWx1ZSxcbiAgICB0aHJlc2hvbGQ6IGV2ZW50LmJvZHkudGhyZXNob2xkLFxuICAgIG1lc3NhZ2U6IGV2ZW50LmJvZHkubWVzc2FnZSxcbiAgICB0aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCxcbiAgICBsb2NhdGlvbjogZXZlbnQubG9jYXRpb24sXG4gIH07XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBQdWJsaXNoQ29tbWFuZCh7XG4gICAgVG9waWNBcm46IEFMRVJUX1RPUElDX0FSTixcbiAgICBTdWJqZWN0OiBgU29uZ2JpcmQgQWxlcnQ6ICR7ZXZlbnQuYm9keS50eXBlfSAtICR7ZXZlbnQuc2VyaWFsX251bWJlciB8fCBldmVudC5kZXZpY2VfdWlkfWAsXG4gICAgTWVzc2FnZTogSlNPTi5zdHJpbmdpZnkoYWxlcnRNZXNzYWdlLCBudWxsLCAyKSxcbiAgICBNZXNzYWdlQXR0cmlidXRlczoge1xuICAgICAgYWxlcnRfdHlwZToge1xuICAgICAgICBEYXRhVHlwZTogJ1N0cmluZycsXG4gICAgICAgIFN0cmluZ1ZhbHVlOiBldmVudC5ib2R5LnR5cGUgfHwgJ3Vua25vd24nLFxuICAgICAgfSxcbiAgICAgIGRldmljZV91aWQ6IHtcbiAgICAgICAgRGF0YVR5cGU6ICdTdHJpbmcnLFxuICAgICAgICBTdHJpbmdWYWx1ZTogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICAgIH0sXG4gICAgICBmbGVldDoge1xuICAgICAgICBEYXRhVHlwZTogJ1N0cmluZycsXG4gICAgICAgIFN0cmluZ1ZhbHVlOiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGF3YWl0IHNuc0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgUHVibGlzaGVkIGFsZXJ0IHRvIFNOUzogJHtldmVudC5ib2R5LnR5cGV9YCk7XG59XG4iXX0=