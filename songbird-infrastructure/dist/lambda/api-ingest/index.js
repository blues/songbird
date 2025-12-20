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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWluZ2VzdC9pbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7O0dBS0c7OztBQUVILDhEQUEwRDtBQUMxRCx3REFBMEY7QUFDMUYsb0RBQWdFO0FBR2hFLHFCQUFxQjtBQUNyQixNQUFNLFNBQVMsR0FBRyxJQUFJLGdDQUFjLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDekMsTUFBTSxTQUFTLEdBQUcscUNBQXNCLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRTtJQUN2RCxlQUFlLEVBQUU7UUFDZixxQkFBcUIsRUFBRSxJQUFJO0tBQzVCO0NBQ0YsQ0FBQyxDQUFDO0FBQ0gsTUFBTSxTQUFTLEdBQUcsSUFBSSxzQkFBUyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBRXBDLHdCQUF3QjtBQUN4QixNQUFNLGVBQWUsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGVBQWdCLENBQUM7QUFDckQsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxhQUFjLENBQUM7QUFDakQsTUFBTSxjQUFjLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFlLENBQUM7QUFDbkQsTUFBTSxZQUFZLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxZQUFhLENBQUM7QUFDL0MsTUFBTSxlQUFlLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxlQUFnQixDQUFDO0FBRXJELDBCQUEwQjtBQUMxQixNQUFNLFFBQVEsR0FBRyxFQUFFLENBQUM7QUFDcEIsTUFBTSxXQUFXLEdBQUcsUUFBUSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxDQUFDO0FBK0RyQyxNQUFNLE9BQU8sR0FBRyxLQUFLLEVBQUUsS0FBMkIsRUFBa0MsRUFBRTtJQUMzRixPQUFPLENBQUMsR0FBRyxDQUFDLGlCQUFpQixFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMs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S0FBSyxDQUFDLElBQUksQ0FBQyxTQUFTO1FBQy9CLE9BQU8sRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLE9BQU87UUFDM0IsU0FBUyxFQUFFLEtBQUssQ0FBQyxTQUFTO1FBQzFCLFFBQVEsRUFBRSxLQUFLLENBQUMsUUFBUTtLQUN6QixDQUFDO0lBRUYsTUFBTSxPQUFPLEdBQUcsSUFBSSwyQkFBYyxDQUFDO1FBQ2pDLFFBQVEsRUFBRSxlQUFlO1FBQ3pCLE9BQU8sRUFBRSxtQkFBbUIsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLE1BQU0sS0FBSyxDQUFDLGFBQWEsSUFBSSxLQUFLLENBQUMsVUFBVSxFQUFFO1FBQzFGLE9BQU8sRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLFlBQVksRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO1FBQzlDLGlCQUFpQixFQUFFO1lBQ2pCLFVBQVUsRUFBRTtnQkFDVixRQUFRLEVBQUUsUUFBUTtnQkFDbEIsV0FBVyxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxJQUFJLFNBQVM7YUFDMUM7WUFDRCxVQUFVLEVBQUU7Z0JBQ1YsUUFBUSxFQUFFLFFBQVE7Z0JBQ2xCLFdBQVcsRUFBRSxLQUFLLENBQUMsVUFBVTthQUM5QjtZQUNELEtBQUssRUFBRTtnQkFDTCxRQUFRLEVBQUUsUUFBUTtnQkFDbEIsV0FBVyxFQUFFLEtBQUssQ0FBQyxLQUFLLElBQUksU0FBUzthQUN0QztTQUNGO0tBQ0YsQ0FBQyxDQUFDO0lBRUgsTUFBTSxTQUFTLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQzlCLE9BQU8sQ0FBQyxHQUFHLENBQUMsMkJBQTJCLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQztBQUM1RCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBFdmVudCBJbmdlc3QgQVBJIExhbWJkYVxuICpcbiAqIEhUVFAgZW5kcG9pbnQgZm9yIHJlY2VpdmluZyBldmVudHMgZnJvbSBOb3RlaHViIEhUVFAgcm91dGVzLlxuICogUHJvY2Vzc2VzIGluY29taW5nIFNvbmdiaXJkIGV2ZW50cyBhbmQgd3JpdGVzIHRvIER5bmFtb0RCLlxuICovXG5cbmltcG9ydCB7IER5bmFtb0RCQ2xpZW50IH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LWR5bmFtb2RiJztcbmltcG9ydCB7IER5bmFtb0RCRG9jdW1lbnRDbGllbnQsIFB1dENvbW1hbmQsIFVwZGF0ZUNvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9saWItZHluYW1vZGInO1xuaW1wb3J0IHsgU05TQ2xpZW50LCBQdWJsaXNoQ29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1zbnMnO1xuaW1wb3J0IHsgQVBJR2F0ZXdheVByb3h5RXZlbnQsIEFQSUdhdGV3YXlQcm94eVJlc3VsdCB9IGZyb20gJ2F3cy1sYW1iZGEnO1xuXG4vLyBJbml0aWFsaXplIGNsaWVudHNcbmNvbnN0IGRkYkNsaWVudCA9IG5ldyBEeW5hbW9EQkNsaWVudCh7fSk7XG5jb25zdCBkb2NDbGllbnQgPSBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LmZyb20oZGRiQ2xpZW50LCB7XG4gIG1hcnNoYWxsT3B0aW9uczoge1xuICAgIHJlbW92ZVVuZGVmaW5lZFZhbHVlczogdHJ1ZSxcbiAgfSxcbn0pO1xuY29uc3Qgc25zQ2xpZW50ID0gbmV3IFNOU0NsaWVudCh7fSk7XG5cbi8vIEVudmlyb25tZW50IHZhcmlhYmxlc1xuY29uc3QgVEVMRU1FVFJZX1RBQkxFID0gcHJvY2Vzcy5lbnYuVEVMRU1FVFJZX1RBQkxFITtcbmNvbnN0IERFVklDRVNfVEFCTEUgPSBwcm9jZXNzLmVudi5ERVZJQ0VTX1RBQkxFITtcbmNvbnN0IENPTU1BTkRTX1RBQkxFID0gcHJvY2Vzcy5lbnYuQ09NTUFORFNfVEFCTEUhO1xuY29uc3QgQUxFUlRTX1RBQkxFID0gcHJvY2Vzcy5lbnYuQUxFUlRTX1RBQkxFITtcbmNvbnN0IEFMRVJUX1RPUElDX0FSTiA9IHByb2Nlc3MuZW52LkFMRVJUX1RPUElDX0FSTiE7XG5cbi8vIFRUTDogOTAgZGF5cyBpbiBzZWNvbmRzXG5jb25zdCBUVExfREFZUyA9IDkwO1xuY29uc3QgVFRMX1NFQ09ORFMgPSBUVExfREFZUyAqIDI0ICogNjAgKiA2MDtcblxuLy8gTm90ZWh1YiBldmVudCBzdHJ1Y3R1cmUgKGZyb20gSFRUUCByb3V0ZSlcbmludGVyZmFjZSBOb3RlaHViRXZlbnQge1xuICBldmVudDogc3RyaW5nOyAgICAgICAgICAgLy8gZS5nLiwgXCJkZXY6eHh4eHgjdHJhY2sucW8jMVwiXG4gIHNlc3Npb246IHN0cmluZztcbiAgYmVzdF9pZDogc3RyaW5nO1xuICBkZXZpY2U6IHN0cmluZzsgICAgICAgICAgLy8gRGV2aWNlIFVJRFxuICBzbjogc3RyaW5nOyAgICAgICAgICAgICAgLy8gU2VyaWFsIG51bWJlclxuICBwcm9kdWN0OiBzdHJpbmc7XG4gIGFwcDogc3RyaW5nO1xuICByZWNlaXZlZDogbnVtYmVyO1xuICByZXE6IHN0cmluZzsgICAgICAgICAgICAgLy8gZS5nLiwgXCJub3RlLmFkZFwiXG4gIHdoZW46IG51bWJlcjsgICAgICAgICAgICAvLyBVbml4IHRpbWVzdGFtcFxuICBmaWxlOiBzdHJpbmc7ICAgICAgICAgICAgLy8gZS5nLiwgXCJ0cmFjay5xb1wiXG4gIGJvZHk6IHtcbiAgICB0ZW1wPzogbnVtYmVyO1xuICAgIGh1bWlkaXR5PzogbnVtYmVyO1xuICAgIHByZXNzdXJlPzogbnVtYmVyO1xuICAgIHZvbHRhZ2U/OiBudW1iZXI7XG4gICAgbW90aW9uPzogYm9vbGVhbjtcbiAgICBtb2RlPzogc3RyaW5nO1xuICAgIC8vIEFsZXJ0LXNwZWNpZmljIGZpZWxkc1xuICAgIHR5cGU/OiBzdHJpbmc7XG4gICAgdmFsdWU/OiBudW1iZXI7XG4gICAgdGhyZXNob2xkPzogbnVtYmVyO1xuICAgIG1lc3NhZ2U/OiBzdHJpbmc7XG4gICAgLy8gQ29tbWFuZCBhY2sgZmllbGRzXG4gICAgY21kPzogc3RyaW5nO1xuICAgIHN0YXR1cz86IHN0cmluZztcbiAgICBleGVjdXRlZF9hdD86IG51bWJlcjtcbiAgICAvLyBNb2pvIHBvd2VyIG1vbml0b3JpbmcgZmllbGRzIChfbG9nLnFvKVxuICAgIG1pbGxpYW1wX2hvdXJzPzogbnVtYmVyO1xuICAgIHRlbXBlcmF0dXJlPzogbnVtYmVyO1xuICAgIC8vIEhlYWx0aCBldmVudCBmaWVsZHMgKF9oZWFsdGgucW8pXG4gICAgbWV0aG9kPzogc3RyaW5nO1xuICAgIHRleHQ/OiBzdHJpbmc7XG4gICAgdm9sdGFnZV9tb2RlPzogc3RyaW5nO1xuICB9O1xuICBiZXN0X2xvY2F0aW9uX3R5cGU/OiBzdHJpbmc7XG4gIGJlc3RfbG9jYXRpb25fd2hlbj86IG51bWJlcjtcbiAgYmVzdF9sYXQ/OiBudW1iZXI7XG4gIGJlc3RfbG9uPzogbnVtYmVyO1xuICBiZXN0X2xvY2F0aW9uPzogc3RyaW5nO1xuICB0b3dlcl9sb2NhdGlvbj86IHN0cmluZztcbiAgdG93ZXJfbGF0PzogbnVtYmVyO1xuICB0b3dlcl9sb24/OiBudW1iZXI7XG4gIHRvd2VyX3doZW4/OiBudW1iZXI7XG4gIC8vIFRyaWFuZ3VsYXRpb24gZmllbGRzIChmcm9tIF9nZW9sb2NhdGUucW8gb3IgZW5yaWNoZWQgZXZlbnRzKVxuICB0cmlfd2hlbj86IG51bWJlcjtcbiAgdHJpX2xhdD86IG51bWJlcjtcbiAgdHJpX2xvbj86IG51bWJlcjtcbiAgdHJpX2xvY2F0aW9uPzogc3RyaW5nO1xuICB0cmlfY291bnRyeT86IHN0cmluZztcbiAgdHJpX3RpbWV6b25lPzogc3RyaW5nO1xuICB0cmlfcG9pbnRzPzogbnVtYmVyOyAgLy8gTnVtYmVyIG9mIHJlZmVyZW5jZSBwb2ludHMgdXNlZCBmb3IgdHJpYW5ndWxhdGlvblxuICBmbGVldHM/OiBzdHJpbmdbXTtcbiAgLy8gU2Vzc2lvbiBmaWVsZHMgKF9zZXNzaW9uLnFvKVxuICBmaXJtd2FyZV9ob3N0Pzogc3RyaW5nOyAgICAgLy8gSlNPTiBzdHJpbmcgd2l0aCBob3N0IGZpcm13YXJlIGluZm9cbiAgZmlybXdhcmVfbm90ZWNhcmQ/OiBzdHJpbmc7IC8vIEpTT04gc3RyaW5nIHdpdGggTm90ZWNhcmQgZmlybXdhcmUgaW5mb1xuICBza3U/OiBzdHJpbmc7ICAgICAgICAgICAgICAgLy8gTm90ZWNhcmQgU0tVIChlLmcuLCBcIk5PVEUtV0JHTFdcIilcbn1cblxuZXhwb3J0IGNvbnN0IGhhbmRsZXIgPSBhc3luYyAoZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50KTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+ID0+IHtcbiAgY29uc29sZS5sb2coJ0luZ2VzdCByZXF1ZXN0OicsIEpTT04uc3RyaW5naWZ5KGV2ZW50KSk7XG5cbiAgY29uc3QgaGVhZGVycyA9IHtcbiAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICB9O1xuXG4gIHRyeSB7XG4gICAgaWYgKCFldmVudC5ib2R5KSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdSZXF1ZXN0IGJvZHkgcmVxdWlyZWQnIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCBub3RlaHViRXZlbnQ6IE5vdGVodWJFdmVudCA9IEpTT04ucGFyc2UoZXZlbnQuYm9keSk7XG4gICAgY29uc29sZS5sb2coJ1Byb2Nlc3NpbmcgTm90ZWh1YiBldmVudDonLCBKU09OLnN0cmluZ2lmeShub3RlaHViRXZlbnQpKTtcblxuICAgIC8vIFRyYW5zZm9ybSB0byBpbnRlcm5hbCBmb3JtYXRcbiAgICAvLyBVc2UgJ3doZW4nIGlmIGF2YWlsYWJsZSwgb3RoZXJ3aXNlIGZhbGwgYmFjayB0byAncmVjZWl2ZWQnIChhcyBpbnRlZ2VyIHNlY29uZHMpXG4gICAgY29uc3QgZXZlbnRUaW1lc3RhbXAgPSBub3RlaHViRXZlbnQud2hlbiB8fCBNYXRoLmZsb29yKG5vdGVodWJFdmVudC5yZWNlaXZlZCk7XG5cbiAgICAvLyBFeHRyYWN0IGxvY2F0aW9uIC0gcHJlZmVyIEdQUyAoYmVzdF9sYXQvYmVzdF9sb24pLCBmYWxsIGJhY2sgdG8gdHJpYW5ndWxhdGlvblxuICAgIGNvbnN0IGxvY2F0aW9uID0gZXh0cmFjdExvY2F0aW9uKG5vdGVodWJFdmVudCk7XG5cbiAgICAvLyBFeHRyYWN0IHNlc3Npb24gaW5mbyAoZmlybXdhcmUgdmVyc2lvbnMsIFNLVSkgZnJvbSBfc2Vzc2lvbi5xbyBldmVudHNcbiAgICBjb25zdCBzZXNzaW9uSW5mbyA9IGV4dHJhY3RTZXNzaW9uSW5mbyhub3RlaHViRXZlbnQpO1xuXG4gICAgY29uc3Qgc29uZ2JpcmRFdmVudCA9IHtcbiAgICAgIGRldmljZV91aWQ6IG5vdGVodWJFdmVudC5kZXZpY2UsXG4gICAgICBzZXJpYWxfbnVtYmVyOiBub3RlaHViRXZlbnQuc24sXG4gICAgICBmbGVldDogbm90ZWh1YkV2ZW50LmZsZWV0cz8uWzBdIHx8ICdkZWZhdWx0JyxcbiAgICAgIGV2ZW50X3R5cGU6IG5vdGVodWJFdmVudC5maWxlLFxuICAgICAgdGltZXN0YW1wOiBldmVudFRpbWVzdGFtcCxcbiAgICAgIHJlY2VpdmVkOiBub3RlaHViRXZlbnQucmVjZWl2ZWQsXG4gICAgICBib2R5OiBub3RlaHViRXZlbnQuYm9keSB8fCB7fSxcbiAgICAgIGxvY2F0aW9uLFxuICAgICAgc2Vzc2lvbjogc2Vzc2lvbkluZm8sXG4gICAgfTtcblxuICAgIC8vIFdyaXRlIHRlbGVtZXRyeSB0byBEeW5hbW9EQiAoZm9yIHRyYWNrLnFvIGV2ZW50cylcbiAgICBpZiAoc29uZ2JpcmRFdmVudC5ldmVudF90eXBlID09PSAndHJhY2sucW8nKSB7XG4gICAgICBhd2FpdCB3cml0ZVRlbGVtZXRyeShzb25nYmlyZEV2ZW50LCAndGVsZW1ldHJ5Jyk7XG4gICAgfVxuXG4gICAgLy8gV3JpdGUgTW9qbyBwb3dlciBkYXRhIHRvIER5bmFtb0RCIChfbG9nLnFvIGNvbnRhaW5zIHBvd2VyIHRlbGVtZXRyeSlcbiAgICBpZiAoc29uZ2JpcmRFdmVudC5ldmVudF90eXBlID09PSAnX2xvZy5xbycpIHtcbiAgICAgIGF3YWl0IHdyaXRlUG93ZXJUZWxlbWV0cnkoc29uZ2JpcmRFdmVudCk7XG4gICAgfVxuXG4gICAgLy8gV3JpdGUgaGVhbHRoIGV2ZW50cyB0byBEeW5hbW9EQiAoX2hlYWx0aC5xbylcbiAgICBpZiAoc29uZ2JpcmRFdmVudC5ldmVudF90eXBlID09PSAnX2hlYWx0aC5xbycpIHtcbiAgICAgIGF3YWl0IHdyaXRlSGVhbHRoRXZlbnQoc29uZ2JpcmRFdmVudCk7XG4gICAgfVxuXG4gICAgLy8gSGFuZGxlIHRyaWFuZ3VsYXRpb24gcmVzdWx0cyAoX2dlb2xvY2F0ZS5xbylcbiAgICAvLyBXcml0ZSBsb2NhdGlvbiB0byB0ZWxlbWV0cnkgdGFibGUgZm9yIGxvY2F0aW9uIGhpc3RvcnkgdHJhaWxcbiAgICBpZiAoc29uZ2JpcmRFdmVudC5ldmVudF90eXBlID09PSAnX2dlb2xvY2F0ZS5xbycgJiYgc29uZ2JpcmRFdmVudC5sb2NhdGlvbikge1xuICAgICAgYXdhaXQgd3JpdGVMb2NhdGlvbkV2ZW50KHNvbmdiaXJkRXZlbnQpO1xuICAgIH1cblxuICAgIC8vIFVwZGF0ZSBkZXZpY2UgbWV0YWRhdGEgaW4gRHluYW1vREJcbiAgICBhd2FpdCB1cGRhdGVEZXZpY2VNZXRhZGF0YShzb25nYmlyZEV2ZW50KTtcblxuICAgIC8vIFN0b3JlIGFuZCBwdWJsaXNoIGFsZXJ0IGlmIHRoaXMgaXMgYW4gYWxlcnQgZXZlbnRcbiAgICBpZiAoc29uZ2JpcmRFdmVudC5ldmVudF90eXBlID09PSAnYWxlcnQucW8nKSB7XG4gICAgICBhd2FpdCBzdG9yZUFsZXJ0KHNvbmdiaXJkRXZlbnQpO1xuICAgICAgYXdhaXQgcHVibGlzaEFsZXJ0KHNvbmdiaXJkRXZlbnQpO1xuICAgIH1cblxuICAgIC8vIFByb2Nlc3MgY29tbWFuZCBhY2tub3dsZWRnbWVudFxuICAgIGlmIChzb25nYmlyZEV2ZW50LmV2ZW50X3R5cGUgPT09ICdjb21tYW5kX2Fjay5xbycpIHtcbiAgICAgIGF3YWl0IHByb2Nlc3NDb21tYW5kQWNrKHNvbmdiaXJkRXZlbnQpO1xuICAgIH1cblxuICAgIGNvbnNvbGUubG9nKCdFdmVudCBwcm9jZXNzZWQgc3VjY2Vzc2Z1bGx5Jyk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgc3RhdHVzOiAnb2snLCBkZXZpY2U6IHNvbmdiaXJkRXZlbnQuZGV2aWNlX3VpZCB9KSxcbiAgICB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHByb2Nlc3NpbmcgZXZlbnQ6JywgZXJyb3IpO1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA1MDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0ludGVybmFsIHNlcnZlciBlcnJvcicgfSksXG4gICAgfTtcbiAgfVxufTtcblxuaW50ZXJmYWNlIFNlc3Npb25JbmZvIHtcbiAgZmlybXdhcmVfdmVyc2lvbj86IHN0cmluZztcbiAgbm90ZWNhcmRfdmVyc2lvbj86IHN0cmluZztcbiAgbm90ZWNhcmRfc2t1Pzogc3RyaW5nO1xufVxuXG4vKipcbiAqIEV4dHJhY3Qgc2Vzc2lvbiBpbmZvIChmaXJtd2FyZSB2ZXJzaW9ucywgU0tVKSBmcm9tIE5vdGVodWIgZXZlbnRcbiAqIFRoaXMgaW5mbyBpcyBhdmFpbGFibGUgaW4gX3Nlc3Npb24ucW8gZXZlbnRzXG4gKi9cbmZ1bmN0aW9uIGV4dHJhY3RTZXNzaW9uSW5mbyhldmVudDogTm90ZWh1YkV2ZW50KTogU2Vzc2lvbkluZm8gfCB1bmRlZmluZWQge1xuICBpZiAoIWV2ZW50LmZpcm13YXJlX2hvc3QgJiYgIWV2ZW50LmZpcm13YXJlX25vdGVjYXJkICYmICFldmVudC5za3UpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG5cbiAgY29uc3Qgc2Vzc2lvbkluZm86IFNlc3Npb25JbmZvID0ge307XG5cbiAgLy8gUGFyc2UgaG9zdCBmaXJtd2FyZSB2ZXJzaW9uXG4gIGlmIChldmVudC5maXJtd2FyZV9ob3N0KSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGhvc3RGaXJtd2FyZSA9IEpTT04ucGFyc2UoZXZlbnQuZmlybXdhcmVfaG9zdCk7XG4gICAgICBzZXNzaW9uSW5mby5maXJtd2FyZV92ZXJzaW9uID0gaG9zdEZpcm13YXJlLnZlcnNpb247XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS5lcnJvcignRmFpbGVkIHRvIHBhcnNlIGZpcm13YXJlX2hvc3Q6JywgZSk7XG4gICAgfVxuICB9XG5cbiAgLy8gUGFyc2UgTm90ZWNhcmQgZmlybXdhcmUgdmVyc2lvblxuICBpZiAoZXZlbnQuZmlybXdhcmVfbm90ZWNhcmQpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgbm90ZWNhcmRGaXJtd2FyZSA9IEpTT04ucGFyc2UoZXZlbnQuZmlybXdhcmVfbm90ZWNhcmQpO1xuICAgICAgc2Vzc2lvbkluZm8ubm90ZWNhcmRfdmVyc2lvbiA9IG5vdGVjYXJkRmlybXdhcmUudmVyc2lvbjtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLmVycm9yKCdGYWlsZWQgdG8gcGFyc2UgZmlybXdhcmVfbm90ZWNhcmQ6JywgZSk7XG4gICAgfVxuICB9XG5cbiAgLy8gU0tVXG4gIGlmIChldmVudC5za3UpIHtcbiAgICBzZXNzaW9uSW5mby5ub3RlY2FyZF9za3UgPSBldmVudC5za3U7XG4gIH1cblxuICByZXR1cm4gT2JqZWN0LmtleXMoc2Vzc2lvbkluZm8pLmxlbmd0aCA+IDAgPyBzZXNzaW9uSW5mbyA6IHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiBOb3JtYWxpemUgbG9jYXRpb24gc291cmNlIHR5cGUgZnJvbSBOb3RlaHViIHRvIG91ciBzdGFuZGFyZCB2YWx1ZXNcbiAqL1xuZnVuY3Rpb24gbm9ybWFsaXplTG9jYXRpb25Tb3VyY2Uoc291cmNlPzogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKCFzb3VyY2UpIHJldHVybiAnZ3BzJztcbiAgY29uc3Qgbm9ybWFsaXplZCA9IHNvdXJjZS50b0xvd2VyQ2FzZSgpO1xuICAvLyBOb3RlaHViIHVzZXMgJ3RyaWFuZ3VsYXRlZCcgYnV0IHdlIHVzZSAndHJpYW5ndWxhdGlvbicgZm9yIGNvbnNpc3RlbmN5XG4gIGlmIChub3JtYWxpemVkID09PSAndHJpYW5ndWxhdGVkJykgcmV0dXJuICd0cmlhbmd1bGF0aW9uJztcbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbi8qKlxuICogRXh0cmFjdCBsb2NhdGlvbiBmcm9tIE5vdGVodWIgZXZlbnQsIHByZWZlcnJpbmcgR1BTIGJ1dCBmYWxsaW5nIGJhY2sgdG8gdHJpYW5ndWxhdGlvblxuICovXG5mdW5jdGlvbiBleHRyYWN0TG9jYXRpb24oZXZlbnQ6IE5vdGVodWJFdmVudCk6IHsgbGF0OiBudW1iZXI7IGxvbjogbnVtYmVyOyB0aW1lPzogbnVtYmVyOyBzb3VyY2U6IHN0cmluZzsgbmFtZT86IHN0cmluZyB9IHwgdW5kZWZpbmVkIHtcbiAgLy8gUHJlZmVyIEdQUyBsb2NhdGlvbiAoYmVzdF9sYXQvYmVzdF9sb24gd2l0aCB0eXBlICdncHMnKVxuICBpZiAoZXZlbnQuYmVzdF9sYXQgIT09IHVuZGVmaW5lZCAmJiBldmVudC5iZXN0X2xvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGxhdDogZXZlbnQuYmVzdF9sYXQsXG4gICAgICBsb246IGV2ZW50LmJlc3RfbG9uLFxuICAgICAgdGltZTogZXZlbnQuYmVzdF9sb2NhdGlvbl93aGVuLFxuICAgICAgc291cmNlOiBub3JtYWxpemVMb2NhdGlvblNvdXJjZShldmVudC5iZXN0X2xvY2F0aW9uX3R5cGUpLFxuICAgICAgbmFtZTogZXZlbnQuYmVzdF9sb2NhdGlvbixcbiAgICB9O1xuICB9XG5cbiAgLy8gRmFsbCBiYWNrIHRvIHRyaWFuZ3VsYXRpb24gZGF0YVxuICBpZiAoZXZlbnQudHJpX2xhdCAhPT0gdW5kZWZpbmVkICYmIGV2ZW50LnRyaV9sb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB7XG4gICAgICBsYXQ6IGV2ZW50LnRyaV9sYXQsXG4gICAgICBsb246IGV2ZW50LnRyaV9sb24sXG4gICAgICB0aW1lOiBldmVudC50cmlfd2hlbixcbiAgICAgIHNvdXJjZTogJ3RyaWFuZ3VsYXRpb24nLFxuICAgICAgbmFtZTogZXZlbnQudG93ZXJfbG9jYXRpb24sXG4gICAgfTtcbiAgfVxuXG4gIC8vIEZhbGwgYmFjayB0byB0b3dlciBsb2NhdGlvblxuICBpZiAoZXZlbnQudG93ZXJfbGF0ICE9PSB1bmRlZmluZWQgJiYgZXZlbnQudG93ZXJfbG9uICE9PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgbGF0OiBldmVudC50b3dlcl9sYXQsXG4gICAgICBsb246IGV2ZW50LnRvd2VyX2xvbixcbiAgICAgIHRpbWU6IGV2ZW50LnRvd2VyX3doZW4sXG4gICAgICBzb3VyY2U6ICd0b3dlcicsXG4gICAgICBuYW1lOiBldmVudC50b3dlcl9sb2NhdGlvbixcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuaW50ZXJmYWNlIFNvbmdiaXJkRXZlbnQge1xuICBkZXZpY2VfdWlkOiBzdHJpbmc7XG4gIHNlcmlhbF9udW1iZXI/OiBzdHJpbmc7XG4gIGZsZWV0Pzogc3RyaW5nO1xuICBldmVudF90eXBlOiBzdHJpbmc7XG4gIHRpbWVzdGFtcDogbnVtYmVyO1xuICByZWNlaXZlZDogbnVtYmVyO1xuICBzZXNzaW9uPzogU2Vzc2lvbkluZm87XG4gIGJvZHk6IHtcbiAgICB0ZW1wPzogbnVtYmVyO1xuICAgIGh1bWlkaXR5PzogbnVtYmVyO1xuICAgIHByZXNzdXJlPzogbnVtYmVyO1xuICAgIHZvbHRhZ2U/OiBudW1iZXI7XG4gICAgbW90aW9uPzogYm9vbGVhbjtcbiAgICBtb2RlPzogc3RyaW5nO1xuICAgIHR5cGU/OiBzdHJpbmc7XG4gICAgdmFsdWU/OiBudW1iZXI7XG4gICAgdGhyZXNob2xkPzogbnVtYmVyO1xuICAgIG1lc3NhZ2U/OiBzdHJpbmc7XG4gICAgY21kPzogc3RyaW5nO1xuICAgIGNtZF9pZD86IHN0cmluZztcbiAgICBzdGF0dXM/OiBzdHJpbmc7XG4gICAgZXhlY3V0ZWRfYXQ/OiBudW1iZXI7XG4gICAgbWlsbGlhbXBfaG91cnM/OiBudW1iZXI7XG4gICAgdGVtcGVyYXR1cmU/OiBudW1iZXI7XG4gICAgLy8gSGVhbHRoIGV2ZW50IGZpZWxkc1xuICAgIG1ldGhvZD86IHN0cmluZztcbiAgICB0ZXh0Pzogc3RyaW5nO1xuICAgIHZvbHRhZ2VfbW9kZT86IHN0cmluZztcbiAgfTtcbiAgbG9jYXRpb24/OiB7XG4gICAgbGF0PzogbnVtYmVyO1xuICAgIGxvbj86IG51bWJlcjtcbiAgICB0aW1lPzogbnVtYmVyO1xuICAgIHNvdXJjZT86IHN0cmluZztcbiAgICBuYW1lPzogc3RyaW5nO1xuICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiB3cml0ZVRlbGVtZXRyeShldmVudDogU29uZ2JpcmRFdmVudCwgZGF0YVR5cGU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0aW1lc3RhbXAgPSBldmVudC50aW1lc3RhbXAgKiAxMDAwOyAvLyBDb252ZXJ0IHRvIG1pbGxpc2Vjb25kc1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSArIFRUTF9TRUNPTkRTO1xuXG4gIGNvbnN0IHJlY29yZDogUmVjb3JkPHN0cmluZywgYW55PiA9IHtcbiAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgIHRpbWVzdGFtcCxcbiAgICB0dGwsXG4gICAgZGF0YV90eXBlOiBkYXRhVHlwZSxcbiAgICBldmVudF90eXBlOiBldmVudC5ldmVudF90eXBlLFxuICAgIGV2ZW50X3R5cGVfdGltZXN0YW1wOiBgJHtkYXRhVHlwZX0jJHt0aW1lc3RhbXB9YCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyIHx8ICd1bmtub3duJyxcbiAgICBmbGVldDogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICB9O1xuXG4gIGlmIChldmVudC5ib2R5LnRlbXAgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC50ZW1wZXJhdHVyZSA9IGV2ZW50LmJvZHkudGVtcDtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS5odW1pZGl0eSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLmh1bWlkaXR5ID0gZXZlbnQuYm9keS5odW1pZGl0eTtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS5wcmVzc3VyZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnByZXNzdXJlID0gZXZlbnQuYm9keS5wcmVzc3VyZTtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS52b2x0YWdlICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQudm9sdGFnZSA9IGV2ZW50LmJvZHkudm9sdGFnZTtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS5tb3Rpb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5tb3Rpb24gPSBldmVudC5ib2R5Lm1vdGlvbjtcbiAgfVxuXG4gIGlmIChldmVudC5sb2NhdGlvbj8ubGF0ICE9PSB1bmRlZmluZWQgJiYgZXZlbnQubG9jYXRpb24/LmxvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLmxhdGl0dWRlID0gZXZlbnQubG9jYXRpb24ubGF0O1xuICAgIHJlY29yZC5sb25naXR1ZGUgPSBldmVudC5sb2NhdGlvbi5sb247XG4gICAgcmVjb3JkLmxvY2F0aW9uX3NvdXJjZSA9IGV2ZW50LmxvY2F0aW9uLnNvdXJjZSB8fCAnZ3BzJztcbiAgfVxuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBURUxFTUVUUllfVEFCTEUsXG4gICAgSXRlbTogcmVjb3JkLFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFdyb3RlIHRlbGVtZXRyeSByZWNvcmQgZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH1gKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gd3JpdGVQb3dlclRlbGVtZXRyeShldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0aW1lc3RhbXAgPSBldmVudC50aW1lc3RhbXAgKiAxMDAwO1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSArIFRUTF9TRUNPTkRTO1xuXG4gIGNvbnN0IHJlY29yZDogUmVjb3JkPHN0cmluZywgYW55PiA9IHtcbiAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgIHRpbWVzdGFtcCxcbiAgICB0dGwsXG4gICAgZGF0YV90eXBlOiAncG93ZXInLFxuICAgIGV2ZW50X3R5cGU6IGV2ZW50LmV2ZW50X3R5cGUsXG4gICAgZXZlbnRfdHlwZV90aW1lc3RhbXA6IGBwb3dlciMke3RpbWVzdGFtcH1gLFxuICAgIHNlcmlhbF9udW1iZXI6IGV2ZW50LnNlcmlhbF9udW1iZXIgfHwgJ3Vua25vd24nLFxuICAgIGZsZWV0OiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gIH07XG5cbiAgaWYgKGV2ZW50LmJvZHkudm9sdGFnZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLm1vam9fdm9sdGFnZSA9IGV2ZW50LmJvZHkudm9sdGFnZTtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS5taWxsaWFtcF9ob3VycyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLm1pbGxpYW1wX2hvdXJzID0gZXZlbnQuYm9keS5taWxsaWFtcF9ob3VycztcbiAgfVxuXG4gIGlmIChyZWNvcmQubW9qb192b2x0YWdlICE9PSB1bmRlZmluZWQgfHxcbiAgICAgIHJlY29yZC5tb2pvX3RlbXBlcmF0dXJlICE9PSB1bmRlZmluZWQgfHxcbiAgICAgIHJlY29yZC5taWxsaWFtcF9ob3VycyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgY29tbWFuZCA9IG5ldyBQdXRDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogVEVMRU1FVFJZX1RBQkxFLFxuICAgICAgSXRlbTogcmVjb3JkLFxuICAgIH0pO1xuXG4gICAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gICAgY29uc29sZS5sb2coYFdyb3RlIHBvd2VyIHRlbGVtZXRyeSByZWNvcmQgZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH1gKTtcbiAgfSBlbHNlIHtcbiAgICBjb25zb2xlLmxvZygnTm8gcG93ZXIgbWV0cmljcyBpbiBfbG9nLnFvIGV2ZW50LCBza2lwcGluZycpO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlSGVhbHRoRXZlbnQoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGltZXN0YW1wID0gZXZlbnQudGltZXN0YW1wICogMTAwMDsgLy8gQ29udmVydCB0byBtaWxsaXNlY29uZHNcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCkgKyBUVExfU0VDT05EUztcblxuICBjb25zdCByZWNvcmQ6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICB0aW1lc3RhbXAsXG4gICAgdHRsLFxuICAgIGRhdGFfdHlwZTogJ2hlYWx0aCcsXG4gICAgZXZlbnRfdHlwZTogZXZlbnQuZXZlbnRfdHlwZSxcbiAgICBldmVudF90eXBlX3RpbWVzdGFtcDogYGhlYWx0aCMke3RpbWVzdGFtcH1gLFxuICAgIHNlcmlhbF9udW1iZXI6IGV2ZW50LnNlcmlhbF9udW1iZXIgfHwgJ3Vua25vd24nLFxuICAgIGZsZWV0OiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gIH07XG5cbiAgLy8gQWRkIGhlYWx0aCBldmVudCBmaWVsZHNcbiAgaWYgKGV2ZW50LmJvZHkubWV0aG9kICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQubWV0aG9kID0gZXZlbnQuYm9keS5tZXRob2Q7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkudGV4dCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnRleHQgPSBldmVudC5ib2R5LnRleHQ7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkudm9sdGFnZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnZvbHRhZ2UgPSBldmVudC5ib2R5LnZvbHRhZ2U7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkudm9sdGFnZV9tb2RlICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQudm9sdGFnZV9tb2RlID0gZXZlbnQuYm9keS52b2x0YWdlX21vZGU7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkubWlsbGlhbXBfaG91cnMgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5taWxsaWFtcF9ob3VycyA9IGV2ZW50LmJvZHkubWlsbGlhbXBfaG91cnM7XG4gIH1cblxuICAvLyBBZGQgbG9jYXRpb24gaWYgYXZhaWxhYmxlXG4gIGlmIChldmVudC5sb2NhdGlvbj8ubGF0ICE9PSB1bmRlZmluZWQgJiYgZXZlbnQubG9jYXRpb24/LmxvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLmxhdGl0dWRlID0gZXZlbnQubG9jYXRpb24ubGF0O1xuICAgIHJlY29yZC5sb25naXR1ZGUgPSBldmVudC5sb2NhdGlvbi5sb247XG4gICAgcmVjb3JkLmxvY2F0aW9uX3NvdXJjZSA9IGV2ZW50LmxvY2F0aW9uLnNvdXJjZSB8fCAndG93ZXInO1xuICB9XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBQdXRDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IFRFTEVNRVRSWV9UQUJMRSxcbiAgICBJdGVtOiByZWNvcmQsXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgV3JvdGUgaGVhbHRoIGV2ZW50IHJlY29yZCBmb3IgJHtldmVudC5kZXZpY2VfdWlkfTogJHtldmVudC5ib2R5Lm1ldGhvZH1gKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gd3JpdGVMb2NhdGlvbkV2ZW50KGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmICghZXZlbnQubG9jYXRpb24/LmxhdCB8fCAhZXZlbnQubG9jYXRpb24/Lmxvbikge1xuICAgIGNvbnNvbGUubG9nKCdObyBsb2NhdGlvbiBkYXRhIGluIGV2ZW50LCBza2lwcGluZycpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHRpbWVzdGFtcCA9IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDA7IC8vIENvbnZlcnQgdG8gbWlsbGlzZWNvbmRzXG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgY29uc3QgcmVjb3JkOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge1xuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgdGltZXN0YW1wLFxuICAgIHR0bCxcbiAgICBkYXRhX3R5cGU6ICd0ZWxlbWV0cnknLCAvLyBVc2UgdGVsZW1ldHJ5IHNvIGl0J3MgcGlja2VkIHVwIGJ5IGxvY2F0aW9uIHF1ZXJ5XG4gICAgZXZlbnRfdHlwZTogZXZlbnQuZXZlbnRfdHlwZSxcbiAgICBldmVudF90eXBlX3RpbWVzdGFtcDogYHRlbGVtZXRyeSMke3RpbWVzdGFtcH1gLFxuICAgIHNlcmlhbF9udW1iZXI6IGV2ZW50LnNlcmlhbF9udW1iZXIgfHwgJ3Vua25vd24nLFxuICAgIGZsZWV0OiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gICAgbGF0aXR1ZGU6IGV2ZW50LmxvY2F0aW9uLmxhdCxcbiAgICBsb25naXR1ZGU6IGV2ZW50LmxvY2F0aW9uLmxvbixcbiAgICBsb2NhdGlvbl9zb3VyY2U6IGV2ZW50LmxvY2F0aW9uLnNvdXJjZSB8fCAndHJpYW5ndWxhdGlvbicsXG4gIH07XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBQdXRDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IFRFTEVNRVRSWV9UQUJMRSxcbiAgICBJdGVtOiByZWNvcmQsXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgV3JvdGUgbG9jYXRpb24gZXZlbnQgZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH06ICR7ZXZlbnQubG9jYXRpb24uc291cmNlfSAoJHtldmVudC5sb2NhdGlvbi5sYXR9LCAke2V2ZW50LmxvY2F0aW9uLmxvbn0pYCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHVwZGF0ZURldmljZU1ldGFkYXRhKGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG5cbiAgY29uc3QgdXBkYXRlRXhwcmVzc2lvbnM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICBjb25zdCBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge307XG5cbiAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI2xhc3Rfc2VlbiA9IDpsYXN0X3NlZW4nKTtcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjbGFzdF9zZWVuJ10gPSAnbGFzdF9zZWVuJztcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOmxhc3Rfc2VlbiddID0gbm93O1xuXG4gIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyN1cGRhdGVkX2F0ID0gOnVwZGF0ZWRfYXQnKTtcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjdXBkYXRlZF9hdCddID0gJ3VwZGF0ZWRfYXQnO1xuICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6dXBkYXRlZF9hdCddID0gbm93O1xuXG4gIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNzdGF0dXMgPSA6c3RhdHVzJyk7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3N0YXR1cyddID0gJ3N0YXR1cyc7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpzdGF0dXMnXSA9ICdvbmxpbmUnO1xuXG4gIGlmIChldmVudC5zZXJpYWxfbnVtYmVyKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3NuID0gOnNuJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjc24nXSA9ICdzZXJpYWxfbnVtYmVyJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6c24nXSA9IGV2ZW50LnNlcmlhbF9udW1iZXI7XG4gIH1cblxuICBpZiAoZXZlbnQuZmxlZXQpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjZmxlZXQgPSA6ZmxlZXQnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNmbGVldCddID0gJ2ZsZWV0JztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6ZmxlZXQnXSA9IGV2ZW50LmZsZWV0O1xuICB9XG5cbiAgaWYgKGV2ZW50LmJvZHkubW9kZSkge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNtb2RlID0gOm1vZGUnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNtb2RlJ10gPSAnY3VycmVudF9tb2RlJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6bW9kZSddID0gZXZlbnQuYm9keS5tb2RlO1xuICB9XG5cbiAgaWYgKGV2ZW50LmxvY2F0aW9uPy5sYXQgIT09IHVuZGVmaW5lZCAmJiBldmVudC5sb2NhdGlvbj8ubG9uICE9PSB1bmRlZmluZWQpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjbG9jID0gOmxvYycpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI2xvYyddID0gJ2xhc3RfbG9jYXRpb24nO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpsb2MnXSA9IHtcbiAgICAgIGxhdDogZXZlbnQubG9jYXRpb24ubGF0LFxuICAgICAgbG9uOiBldmVudC5sb2NhdGlvbi5sb24sXG4gICAgICB0aW1lOiBldmVudC5sb2NhdGlvbi50aW1lIHx8IGV2ZW50LnRpbWVzdGFtcCxcbiAgICAgIHNvdXJjZTogZXZlbnQubG9jYXRpb24uc291cmNlIHx8ICdncHMnLFxuICAgICAgbmFtZTogZXZlbnQubG9jYXRpb24ubmFtZSxcbiAgICB9O1xuICB9XG5cbiAgaWYgKGV2ZW50LmV2ZW50X3R5cGUgPT09ICd0cmFjay5xbycpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjdGVsZW1ldHJ5ID0gOnRlbGVtZXRyeScpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3RlbGVtZXRyeSddID0gJ2xhc3RfdGVsZW1ldHJ5JztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6dGVsZW1ldHJ5J10gPSB7XG4gICAgICB0ZW1wOiBldmVudC5ib2R5LnRlbXAsXG4gICAgICBodW1pZGl0eTogZXZlbnQuYm9keS5odW1pZGl0eSxcbiAgICAgIHByZXNzdXJlOiBldmVudC5ib2R5LnByZXNzdXJlLFxuICAgICAgdm9sdGFnZTogZXZlbnQuYm9keS52b2x0YWdlLFxuICAgICAgbW90aW9uOiBldmVudC5ib2R5Lm1vdGlvbixcbiAgICAgIHRpbWVzdGFtcDogZXZlbnQudGltZXN0YW1wLFxuICAgIH07XG4gIH1cblxuICBpZiAoZXZlbnQuZXZlbnRfdHlwZSA9PT0gJ19sb2cucW8nKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3Bvd2VyID0gOnBvd2VyJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjcG93ZXInXSA9ICdsYXN0X3Bvd2VyJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6cG93ZXInXSA9IHtcbiAgICAgIHZvbHRhZ2U6IGV2ZW50LmJvZHkudm9sdGFnZSxcbiAgICAgIHRlbXBlcmF0dXJlOiBldmVudC5ib2R5LnRlbXBlcmF0dXJlLFxuICAgICAgbWlsbGlhbXBfaG91cnM6IGV2ZW50LmJvZHkubWlsbGlhbXBfaG91cnMsXG4gICAgICB0aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCxcbiAgICB9O1xuICB9XG5cbiAgLy8gVXBkYXRlIGZpcm13YXJlIHZlcnNpb25zIGZyb20gX3Nlc3Npb24ucW8gZXZlbnRzXG4gIGlmIChldmVudC5zZXNzaW9uPy5maXJtd2FyZV92ZXJzaW9uKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI2Z3X3ZlcnNpb24gPSA6ZndfdmVyc2lvbicpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI2Z3X3ZlcnNpb24nXSA9ICdmaXJtd2FyZV92ZXJzaW9uJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6ZndfdmVyc2lvbiddID0gZXZlbnQuc2Vzc2lvbi5maXJtd2FyZV92ZXJzaW9uO1xuICB9XG5cbiAgaWYgKGV2ZW50LnNlc3Npb24/Lm5vdGVjYXJkX3ZlcnNpb24pIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjbmNfdmVyc2lvbiA9IDpuY192ZXJzaW9uJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjbmNfdmVyc2lvbiddID0gJ25vdGVjYXJkX3ZlcnNpb24nO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpuY192ZXJzaW9uJ10gPSBldmVudC5zZXNzaW9uLm5vdGVjYXJkX3ZlcnNpb247XG4gIH1cblxuICBpZiAoZXZlbnQuc2Vzc2lvbj8ubm90ZWNhcmRfc2t1KSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI25jX3NrdSA9IDpuY19za3UnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNuY19za3UnXSA9ICdub3RlY2FyZF9za3UnO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpuY19za3UnXSA9IGV2ZW50LnNlc3Npb24ubm90ZWNhcmRfc2t1O1xuICB9XG5cbiAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI2NyZWF0ZWRfYXQgPSBpZl9ub3RfZXhpc3RzKCNjcmVhdGVkX2F0LCA6Y3JlYXRlZF9hdCknKTtcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjY3JlYXRlZF9hdCddID0gJ2NyZWF0ZWRfYXQnO1xuICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6Y3JlYXRlZF9hdCddID0gbm93O1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgVXBkYXRlQ29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgIEtleTogeyBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkIH0sXG4gICAgVXBkYXRlRXhwcmVzc2lvbjogJ1NFVCAnICsgdXBkYXRlRXhwcmVzc2lvbnMuam9pbignLCAnKSxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lcyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzLFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFVwZGF0ZWQgZGV2aWNlIG1ldGFkYXRhIGZvciAke2V2ZW50LmRldmljZV91aWR9YCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHByb2Nlc3NDb21tYW5kQWNrKGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGNtZElkID0gZXZlbnQuYm9keS5jbWRfaWQ7XG4gIGlmICghY21kSWQpIHtcbiAgICBjb25zb2xlLmxvZygnQ29tbWFuZCBhY2sgbWlzc2luZyBjbWRfaWQsIHNraXBwaW5nJyk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcblxuICBjb25zdCBjb21tYW5kID0gbmV3IFVwZGF0ZUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogQ09NTUFORFNfVEFCTEUsXG4gICAgS2V5OiB7XG4gICAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgICAgY29tbWFuZF9pZDogY21kSWQsXG4gICAgfSxcbiAgICBVcGRhdGVFeHByZXNzaW9uOiAnU0VUICNzdGF0dXMgPSA6c3RhdHVzLCAjbWVzc2FnZSA9IDptZXNzYWdlLCAjZXhlY3V0ZWRfYXQgPSA6ZXhlY3V0ZWRfYXQsICN1cGRhdGVkX2F0ID0gOnVwZGF0ZWRfYXQnLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczoge1xuICAgICAgJyNzdGF0dXMnOiAnc3RhdHVzJyxcbiAgICAgICcjbWVzc2FnZSc6ICdtZXNzYWdlJyxcbiAgICAgICcjZXhlY3V0ZWRfYXQnOiAnZXhlY3V0ZWRfYXQnLFxuICAgICAgJyN1cGRhdGVkX2F0JzogJ3VwZGF0ZWRfYXQnLFxuICAgIH0sXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzpzdGF0dXMnOiBldmVudC5ib2R5LnN0YXR1cyB8fCAndW5rbm93bicsXG4gICAgICAnOm1lc3NhZ2UnOiBldmVudC5ib2R5Lm1lc3NhZ2UgfHwgJycsXG4gICAgICAnOmV4ZWN1dGVkX2F0JzogZXZlbnQuYm9keS5leGVjdXRlZF9hdCA/IGV2ZW50LmJvZHkuZXhlY3V0ZWRfYXQgKiAxMDAwIDogbm93LFxuICAgICAgJzp1cGRhdGVkX2F0Jzogbm93LFxuICAgIH0sXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgVXBkYXRlZCBjb21tYW5kICR7Y21kSWR9IHdpdGggc3RhdHVzOiAke2V2ZW50LmJvZHkuc3RhdHVzfWApO1xufVxuXG5hc3luYyBmdW5jdGlvbiBzdG9yZUFsZXJ0KGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3Iobm93IC8gMTAwMCkgKyBUVExfU0VDT05EUztcblxuICAvLyBHZW5lcmF0ZSBhIHVuaXF1ZSBhbGVydCBJRFxuICBjb25zdCBhbGVydElkID0gYGFsZXJ0XyR7ZXZlbnQuZGV2aWNlX3VpZH1fJHtub3d9XyR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc3Vic3RyaW5nKDcpfWA7XG5cbiAgY29uc3QgYWxlcnRSZWNvcmQgPSB7XG4gICAgYWxlcnRfaWQ6IGFsZXJ0SWQsXG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyIHx8ICd1bmtub3duJyxcbiAgICBmbGVldDogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICAgIHR5cGU6IGV2ZW50LmJvZHkudHlwZSB8fCAndW5rbm93bicsXG4gICAgdmFsdWU6IGV2ZW50LmJvZHkudmFsdWUsXG4gICAgdGhyZXNob2xkOiBldmVudC5ib2R5LnRocmVzaG9sZCxcbiAgICBtZXNzYWdlOiBldmVudC5ib2R5Lm1lc3NhZ2UgfHwgJycsXG4gICAgY3JlYXRlZF9hdDogbm93LFxuICAgIGV2ZW50X3RpbWVzdGFtcDogZXZlbnQudGltZXN0YW1wICogMTAwMCxcbiAgICBhY2tub3dsZWRnZWQ6ICdmYWxzZScsIC8vIFN0cmluZyBmb3IgR1NJIHBhcnRpdGlvbiBrZXlcbiAgICB0dGwsXG4gICAgbG9jYXRpb246IGV2ZW50LmxvY2F0aW9uID8ge1xuICAgICAgbGF0OiBldmVudC5sb2NhdGlvbi5sYXQsXG4gICAgICBsb246IGV2ZW50LmxvY2F0aW9uLmxvbixcbiAgICB9IDogdW5kZWZpbmVkLFxuICB9O1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBBTEVSVFNfVEFCTEUsXG4gICAgSXRlbTogYWxlcnRSZWNvcmQsXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgU3RvcmVkIGFsZXJ0ICR7YWxlcnRJZH0gZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH1gKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcHVibGlzaEFsZXJ0KGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGFsZXJ0TWVzc2FnZSA9IHtcbiAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgIHNlcmlhbF9udW1iZXI6IGV2ZW50LnNlcmlhbF9udW1iZXIsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0LFxuICAgIGFsZXJ0X3R5cGU6IGV2ZW50LmJvZHkudHlwZSxcbiAgICB2YWx1ZTogZXZlbnQuYm9keS52YWx1ZSxcbiAgICB0aHJlc2hvbGQ6IGV2ZW50LmJvZHkudGhyZXNob2xkLFxuICAgIG1lc3NhZ2U6IGV2ZW50LmJvZHkubWVzc2FnZSxcbiAgICB0aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCxcbiAgICBsb2NhdGlvbjogZXZlbnQubG9jYXRpb24sXG4gIH07XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBQdWJsaXNoQ29tbWFuZCh7XG4gICAgVG9waWNBcm46IEFMRVJUX1RPUElDX0FSTixcbiAgICBTdWJqZWN0OiBgU29uZ2JpcmQgQWxlcnQ6ICR7ZXZlbnQuYm9keS50eXBlfSAtICR7ZXZlbnQuc2VyaWFsX251bWJlciB8fCBldmVudC5kZXZpY2VfdWlkfWAsXG4gICAgTWVzc2FnZTogSlNPTi5zdHJpbmdpZnkoYWxlcnRNZXNzYWdlLCBudWxsLCAyKSxcbiAgICBNZXNzYWdlQXR0cmlidXRlczoge1xuICAgICAgYWxlcnRfdHlwZToge1xuICAgICAgICBEYXRhVHlwZTogJ1N0cmluZycsXG4gICAgICAgIFN0cmluZ1ZhbHVlOiBldmVudC5ib2R5LnR5cGUgfHwgJ3Vua25vd24nLFxuICAgICAgfSxcbiAgICAgIGRldmljZV91aWQ6IHtcbiAgICAgICAgRGF0YVR5cGU6ICdTdHJpbmcnLFxuICAgICAgICBTdHJpbmdWYWx1ZTogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICAgIH0sXG4gICAgICBmbGVldDoge1xuICAgICAgICBEYXRhVHlwZTogJ1N0cmluZycsXG4gICAgICAgIFN0cmluZ1ZhbHVlOiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGF3YWl0IHNuc0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgUHVibGlzaGVkIGFsZXJ0IHRvIFNOUzogJHtldmVudC5ib2R5LnR5cGV9YCk7XG59XG4iXX0=