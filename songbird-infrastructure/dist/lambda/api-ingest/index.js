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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWluZ2VzdC9pbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7O0dBS0c7OztBQUVILDhEQUEwRDtBQUMxRCx3REFBMEY7QUFDMUYsb0RBQWdFO0FBR2hFLHFCQUFxQjtBQUNyQixNQUFNLFNBQVMsR0FBRyxJQUFJLGdDQUFjLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDekMsTUFBTSxTQUFTLEdBQUcscUNBQXNCLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRTtJQUN2RCxlQUFlLEVBQUU7UUFDZixxQkFBcUIsRUFBRSxJQUFJO0tBQzVCO0NBQ0YsQ0FBQyxDQUFDO0FBQ0gsTUFBTSxTQUFTLEdBQUcsSUFBSSxzQkFBUyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBRXBDLHdCQUF3QjtBQUN4QixNQUFNLGVBQWUsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGVBQWdCLENBQUM7QUFDckQsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxhQUFjLENBQUM7QUFDakQsTUFBTSxjQUFjLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFlLENBQUM7QUFDbkQsTUFBTSxZQUFZLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxZQUFhLENBQUM7QUFDL0MsTUFBTSxlQUFlLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxlQUFnQixDQUFDO0FBRXJELDBCQUEwQjtBQUMxQixNQUFNLFFBQVEsR0FBRyxFQUFFLENBQUM7QUFDcEIsTUFBTSxXQUFXLEdBQUcsUUFBUSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxDQUFDO0FBK0RyQyxNQUFNLE9BQU8sR0FBRyxLQUFLLEVBQUUsS0FBMkIsRUFBa0MsRUFBRTtJQUMzRixPQUFPLENBQUMsR0FBRyxDQUFDLGlCQUFpQixFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMs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LENBQUM7SUFFRixNQUFNLE9BQU8sR0FBRyxJQUFJLDJCQUFjLENBQUM7UUFDakMsUUFBUSxFQUFFLGVBQWU7UUFDekIsT0FBTyxFQUFFLG1CQUFtQixLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksTUFBTSxLQUFLLENBQUMsYUFBYSxJQUFJLEtBQUssQ0FBQyxVQUFVLEVBQUU7UUFDMUYsT0FBTyxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsWUFBWSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7UUFDOUMsaUJBQWlCLEVBQUU7WUFDakIsVUFBVSxFQUFFO2dCQUNWLFFBQVEsRUFBRSxRQUFRO2dCQUNsQixXQUFXLEVBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLElBQUksU0FBUzthQUMxQztZQUNELFVBQVUsRUFBRTtnQkFDVixRQUFRLEVBQUUsUUFBUTtnQkFDbEIsV0FBVyxFQUFFLEtBQUssQ0FBQyxVQUFVO2FBQzlCO1lBQ0QsS0FBSyxFQUFFO2dCQUNMLFFBQVEsRUFBRSxRQUFRO2dCQUNsQixXQUFXLEVBQUUsS0FBSyxDQUFDLEtBQUssSUFBSSxTQUFTO2FBQ3RDO1NBQ0Y7S0FDRixDQUFDLENBQUM7SUFFSCxNQUFNLFNBQVMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDOUIsT0FBTyxDQUFDLEdBQUcsQ0FBQywyQkFBMkIsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO0FBQzVELENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEV2ZW50IEluZ2VzdCBBUEkgTGFtYmRhXG4gKlxuICogSFRUUCBlbmRwb2ludCBmb3IgcmVjZWl2aW5nIGV2ZW50cyBmcm9tIE5vdGVodWIgSFRUUCByb3V0ZXMuXG4gKiBQcm9jZXNzZXMgaW5jb21pbmcgU29uZ2JpcmQgZXZlbnRzIGFuZCB3cml0ZXMgdG8gRHluYW1vREIuXG4gKi9cblxuaW1wb3J0IHsgRHluYW1vREJDbGllbnQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtZHluYW1vZGInO1xuaW1wb3J0IHsgRHluYW1vREJEb2N1bWVudENsaWVudCwgUHV0Q29tbWFuZCwgVXBkYXRlQ29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2xpYi1keW5hbW9kYic7XG5pbXBvcnQgeyBTTlNDbGllbnQsIFB1Ymxpc2hDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LXNucyc7XG5pbXBvcnQgeyBBUElHYXRld2F5UHJveHlFdmVudCwgQVBJR2F0ZXdheVByb3h5UmVzdWx0IH0gZnJvbSAnYXdzLWxhbWJkYSc7XG5cbi8vIEluaXRpYWxpemUgY2xpZW50c1xuY29uc3QgZGRiQ2xpZW50ID0gbmV3IER5bmFtb0RCQ2xpZW50KHt9KTtcbmNvbnN0IGRvY0NsaWVudCA9IER5bmFtb0RCRG9jdW1lbnRDbGllbnQuZnJvbShkZGJDbGllbnQsIHtcbiAgbWFyc2hhbGxPcHRpb25zOiB7XG4gICAgcmVtb3ZlVW5kZWZpbmVkVmFsdWVzOiB0cnVlLFxuICB9LFxufSk7XG5jb25zdCBzbnNDbGllbnQgPSBuZXcgU05TQ2xpZW50KHt9KTtcblxuLy8gRW52aXJvbm1lbnQgdmFyaWFibGVzXG5jb25zdCBURUxFTUVUUllfVEFCTEUgPSBwcm9jZXNzLmVudi5URUxFTUVUUllfVEFCTEUhO1xuY29uc3QgREVWSUNFU19UQUJMRSA9IHByb2Nlc3MuZW52LkRFVklDRVNfVEFCTEUhO1xuY29uc3QgQ09NTUFORFNfVEFCTEUgPSBwcm9jZXNzLmVudi5DT01NQU5EU19UQUJMRSE7XG5jb25zdCBBTEVSVFNfVEFCTEUgPSBwcm9jZXNzLmVudi5BTEVSVFNfVEFCTEUhO1xuY29uc3QgQUxFUlRfVE9QSUNfQVJOID0gcHJvY2Vzcy5lbnYuQUxFUlRfVE9QSUNfQVJOITtcblxuLy8gVFRMOiA5MCBkYXlzIGluIHNlY29uZHNcbmNvbnN0IFRUTF9EQVlTID0gOTA7XG5jb25zdCBUVExfU0VDT05EUyA9IFRUTF9EQVlTICogMjQgKiA2MCAqIDYwO1xuXG4vLyBOb3RlaHViIGV2ZW50IHN0cnVjdHVyZSAoZnJvbSBIVFRQIHJvdXRlKVxuaW50ZXJmYWNlIE5vdGVodWJFdmVudCB7XG4gIGV2ZW50OiBzdHJpbmc7ICAgICAgICAgICAvLyBlLmcuLCBcImRldjp4eHh4eCN0cmFjay5xbyMxXCJcbiAgc2Vzc2lvbjogc3RyaW5nO1xuICBiZXN0X2lkOiBzdHJpbmc7XG4gIGRldmljZTogc3RyaW5nOyAgICAgICAgICAvLyBEZXZpY2UgVUlEXG4gIHNuOiBzdHJpbmc7ICAgICAgICAgICAgICAvLyBTZXJpYWwgbnVtYmVyXG4gIHByb2R1Y3Q6IHN0cmluZztcbiAgYXBwOiBzdHJpbmc7XG4gIHJlY2VpdmVkOiBudW1iZXI7XG4gIHJlcTogc3RyaW5nOyAgICAgICAgICAgICAvLyBlLmcuLCBcIm5vdGUuYWRkXCJcbiAgd2hlbjogbnVtYmVyOyAgICAgICAgICAgIC8vIFVuaXggdGltZXN0YW1wXG4gIGZpbGU6IHN0cmluZzsgICAgICAgICAgICAvLyBlLmcuLCBcInRyYWNrLnFvXCJcbiAgYm9keToge1xuICAgIHRlbXA/OiBudW1iZXI7XG4gICAgaHVtaWRpdHk/OiBudW1iZXI7XG4gICAgcHJlc3N1cmU/OiBudW1iZXI7XG4gICAgdm9sdGFnZT86IG51bWJlcjtcbiAgICBtb3Rpb24/OiBib29sZWFuO1xuICAgIG1vZGU/OiBzdHJpbmc7XG4gICAgLy8gQWxlcnQtc3BlY2lmaWMgZmllbGRzXG4gICAgdHlwZT86IHN0cmluZztcbiAgICB2YWx1ZT86IG51bWJlcjtcbiAgICB0aHJlc2hvbGQ/OiBudW1iZXI7XG4gICAgbWVzc2FnZT86IHN0cmluZztcbiAgICAvLyBDb21tYW5kIGFjayBmaWVsZHNcbiAgICBjbWQ/OiBzdHJpbmc7XG4gICAgc3RhdHVzPzogc3RyaW5nO1xuICAgIGV4ZWN1dGVkX2F0PzogbnVtYmVyO1xuICAgIC8vIE1vam8gcG93ZXIgbW9uaXRvcmluZyBmaWVsZHMgKF9sb2cucW8pXG4gICAgbWlsbGlhbXBfaG91cnM/OiBudW1iZXI7XG4gICAgdGVtcGVyYXR1cmU/OiBudW1iZXI7XG4gICAgLy8gSGVhbHRoIGV2ZW50IGZpZWxkcyAoX2hlYWx0aC5xbylcbiAgICBtZXRob2Q/OiBzdHJpbmc7XG4gICAgdGV4dD86IHN0cmluZztcbiAgICB2b2x0YWdlX21vZGU/OiBzdHJpbmc7XG4gIH07XG4gIGJlc3RfbG9jYXRpb25fdHlwZT86IHN0cmluZztcbiAgYmVzdF9sb2NhdGlvbl93aGVuPzogbnVtYmVyO1xuICBiZXN0X2xhdD86IG51bWJlcjtcbiAgYmVzdF9sb24/OiBudW1iZXI7XG4gIGJlc3RfbG9jYXRpb24/OiBzdHJpbmc7XG4gIHRvd2VyX2xvY2F0aW9uPzogc3RyaW5nO1xuICB0b3dlcl9sYXQ/OiBudW1iZXI7XG4gIHRvd2VyX2xvbj86IG51bWJlcjtcbiAgdG93ZXJfd2hlbj86IG51bWJlcjtcbiAgLy8gVHJpYW5ndWxhdGlvbiBmaWVsZHMgKGZyb20gX2dlb2xvY2F0ZS5xbyBvciBlbnJpY2hlZCBldmVudHMpXG4gIHRyaV93aGVuPzogbnVtYmVyO1xuICB0cmlfbGF0PzogbnVtYmVyO1xuICB0cmlfbG9uPzogbnVtYmVyO1xuICB0cmlfbG9jYXRpb24/OiBzdHJpbmc7XG4gIHRyaV9jb3VudHJ5Pzogc3RyaW5nO1xuICB0cmlfdGltZXpvbmU/OiBzdHJpbmc7XG4gIHRyaV9wb2ludHM/OiBudW1iZXI7ICAvLyBOdW1iZXIgb2YgcmVmZXJlbmNlIHBvaW50cyB1c2VkIGZvciB0cmlhbmd1bGF0aW9uXG4gIGZsZWV0cz86IHN0cmluZ1tdO1xuICAvLyBTZXNzaW9uIGZpZWxkcyAoX3Nlc3Npb24ucW8pXG4gIGZpcm13YXJlX2hvc3Q/OiBzdHJpbmc7ICAgICAvLyBKU09OIHN0cmluZyB3aXRoIGhvc3QgZmlybXdhcmUgaW5mb1xuICBmaXJtd2FyZV9ub3RlY2FyZD86IHN0cmluZzsgLy8gSlNPTiBzdHJpbmcgd2l0aCBOb3RlY2FyZCBmaXJtd2FyZSBpbmZvXG4gIHNrdT86IHN0cmluZzsgICAgICAgICAgICAgICAvLyBOb3RlY2FyZCBTS1UgKGUuZy4sIFwiTk9URS1XQkdMV1wiKVxufVxuXG5leHBvcnQgY29uc3QgaGFuZGxlciA9IGFzeW5jIChldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQpOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4gPT4ge1xuICBjb25zb2xlLmxvZygnSW5nZXN0IHJlcXVlc3Q6JywgSlNPTi5zdHJpbmdpZnkoZXZlbnQpKTtcblxuICBjb25zdCBoZWFkZXJzID0ge1xuICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gIH07XG5cbiAgdHJ5IHtcbiAgICBpZiAoIWV2ZW50LmJvZHkpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1JlcXVlc3QgYm9keSByZXF1aXJlZCcgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIGNvbnN0IG5vdGVodWJFdmVudDogTm90ZWh1YkV2ZW50ID0gSlNPTi5wYXJzZShldmVudC5ib2R5KTtcbiAgICBjb25zb2xlLmxvZygnUHJvY2Vzc2luZyBOb3RlaHViIGV2ZW50OicsIEpTT04uc3RyaW5naWZ5KG5vdGVodWJFdmVudCkpO1xuXG4gICAgLy8gVHJhbnNmb3JtIHRvIGludGVybmFsIGZvcm1hdFxuICAgIC8vIFVzZSAnd2hlbicgaWYgYXZhaWxhYmxlLCBvdGhlcndpc2UgZmFsbCBiYWNrIHRvICdyZWNlaXZlZCcgKGFzIGludGVnZXIgc2Vjb25kcylcbiAgICBjb25zdCBldmVudFRpbWVzdGFtcCA9IG5vdGVodWJFdmVudC53aGVuIHx8IE1hdGguZmxvb3Iobm90ZWh1YkV2ZW50LnJlY2VpdmVkKTtcblxuICAgIC8vIEV4dHJhY3QgbG9jYXRpb24gLSBwcmVmZXIgR1BTIChiZXN0X2xhdC9iZXN0X2xvbiksIGZhbGwgYmFjayB0byB0cmlhbmd1bGF0aW9uXG4gICAgY29uc3QgbG9jYXRpb24gPSBleHRyYWN0TG9jYXRpb24obm90ZWh1YkV2ZW50KTtcblxuICAgIC8vIEV4dHJhY3Qgc2Vzc2lvbiBpbmZvIChmaXJtd2FyZSB2ZXJzaW9ucywgU0tVKSBmcm9tIF9zZXNzaW9uLnFvIGV2ZW50c1xuICAgIGNvbnN0IHNlc3Npb25JbmZvID0gZXh0cmFjdFNlc3Npb25JbmZvKG5vdGVodWJFdmVudCk7XG5cbiAgICBjb25zdCBzb25nYmlyZEV2ZW50ID0ge1xuICAgICAgZGV2aWNlX3VpZDogbm90ZWh1YkV2ZW50LmRldmljZSxcbiAgICAgIHNlcmlhbF9udW1iZXI6IG5vdGVodWJFdmVudC5zbixcbiAgICAgIGZsZWV0OiBub3RlaHViRXZlbnQuZmxlZXRzPy5bMF0gfHwgJ2RlZmF1bHQnLFxuICAgICAgZXZlbnRfdHlwZTogbm90ZWh1YkV2ZW50LmZpbGUsXG4gICAgICB0aW1lc3RhbXA6IGV2ZW50VGltZXN0YW1wLFxuICAgICAgcmVjZWl2ZWQ6IG5vdGVodWJFdmVudC5yZWNlaXZlZCxcbiAgICAgIGJvZHk6IG5vdGVodWJFdmVudC5ib2R5IHx8IHt9LFxuICAgICAgbG9jYXRpb24sXG4gICAgICBzZXNzaW9uOiBzZXNzaW9uSW5mbyxcbiAgICB9O1xuXG4gICAgLy8gV3JpdGUgdGVsZW1ldHJ5IHRvIER5bmFtb0RCIChmb3IgdHJhY2sucW8gZXZlbnRzKVxuICAgIGlmIChzb25nYmlyZEV2ZW50LmV2ZW50X3R5cGUgPT09ICd0cmFjay5xbycpIHtcbiAgICAgIGF3YWl0IHdyaXRlVGVsZW1ldHJ5KHNvbmdiaXJkRXZlbnQsICd0ZWxlbWV0cnknKTtcbiAgICB9XG5cbiAgICAvLyBXcml0ZSBNb2pvIHBvd2VyIGRhdGEgdG8gRHluYW1vREIgKF9sb2cucW8gY29udGFpbnMgcG93ZXIgdGVsZW1ldHJ5KVxuICAgIGlmIChzb25nYmlyZEV2ZW50LmV2ZW50X3R5cGUgPT09ICdfbG9nLnFvJykge1xuICAgICAgYXdhaXQgd3JpdGVQb3dlclRlbGVtZXRyeShzb25nYmlyZEV2ZW50KTtcbiAgICB9XG5cbiAgICAvLyBXcml0ZSBoZWFsdGggZXZlbnRzIHRvIER5bmFtb0RCIChfaGVhbHRoLnFvKVxuICAgIGlmIChzb25nYmlyZEV2ZW50LmV2ZW50X3R5cGUgPT09ICdfaGVhbHRoLnFvJykge1xuICAgICAgYXdhaXQgd3JpdGVIZWFsdGhFdmVudChzb25nYmlyZEV2ZW50KTtcbiAgICB9XG5cbiAgICAvLyBIYW5kbGUgdHJpYW5ndWxhdGlvbiByZXN1bHRzIChfZ2VvbG9jYXRlLnFvKVxuICAgIC8vIFdyaXRlIGxvY2F0aW9uIHRvIHRlbGVtZXRyeSB0YWJsZSBmb3IgbG9jYXRpb24gaGlzdG9yeSB0cmFpbFxuICAgIGlmIChzb25nYmlyZEV2ZW50LmV2ZW50X3R5cGUgPT09ICdfZ2VvbG9jYXRlLnFvJyAmJiBzb25nYmlyZEV2ZW50LmxvY2F0aW9uKSB7XG4gICAgICBhd2FpdCB3cml0ZUxvY2F0aW9uRXZlbnQoc29uZ2JpcmRFdmVudCk7XG4gICAgfVxuXG4gICAgLy8gVXBkYXRlIGRldmljZSBtZXRhZGF0YSBpbiBEeW5hbW9EQlxuICAgIGF3YWl0IHVwZGF0ZURldmljZU1ldGFkYXRhKHNvbmdiaXJkRXZlbnQpO1xuXG4gICAgLy8gU3RvcmUgYW5kIHB1Ymxpc2ggYWxlcnQgaWYgdGhpcyBpcyBhbiBhbGVydCBldmVudFxuICAgIGlmIChzb25nYmlyZEV2ZW50LmV2ZW50X3R5cGUgPT09ICdhbGVydC5xbycpIHtcbiAgICAgIGF3YWl0IHN0b3JlQWxlcnQoc29uZ2JpcmRFdmVudCk7XG4gICAgICBhd2FpdCBwdWJsaXNoQWxlcnQoc29uZ2JpcmRFdmVudCk7XG4gICAgfVxuXG4gICAgLy8gUHJvY2VzcyBjb21tYW5kIGFja25vd2xlZGdtZW50XG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuZXZlbnRfdHlwZSA9PT0gJ2NvbW1hbmRfYWNrLnFvJykge1xuICAgICAgYXdhaXQgcHJvY2Vzc0NvbW1hbmRBY2soc29uZ2JpcmRFdmVudCk7XG4gICAgfVxuXG4gICAgY29uc29sZS5sb2coJ0V2ZW50IHByb2Nlc3NlZCBzdWNjZXNzZnVsbHknKTtcblxuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBzdGF0dXM6ICdvaycsIGRldmljZTogc29uZ2JpcmRFdmVudC5kZXZpY2VfdWlkIH0pLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3IgcHJvY2Vzc2luZyBldmVudDonLCBlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnSW50ZXJuYWwgc2VydmVyIGVycm9yJyB9KSxcbiAgICB9O1xuICB9XG59O1xuXG5pbnRlcmZhY2UgU2Vzc2lvbkluZm8ge1xuICBmaXJtd2FyZV92ZXJzaW9uPzogc3RyaW5nO1xuICBub3RlY2FyZF92ZXJzaW9uPzogc3RyaW5nO1xuICBub3RlY2FyZF9za3U/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogRXh0cmFjdCBzZXNzaW9uIGluZm8gKGZpcm13YXJlIHZlcnNpb25zLCBTS1UpIGZyb20gTm90ZWh1YiBldmVudFxuICogVGhpcyBpbmZvIGlzIGF2YWlsYWJsZSBpbiBfc2Vzc2lvbi5xbyBldmVudHNcbiAqL1xuZnVuY3Rpb24gZXh0cmFjdFNlc3Npb25JbmZvKGV2ZW50OiBOb3RlaHViRXZlbnQpOiBTZXNzaW9uSW5mbyB8IHVuZGVmaW5lZCB7XG4gIGlmICghZXZlbnQuZmlybXdhcmVfaG9zdCAmJiAhZXZlbnQuZmlybXdhcmVfbm90ZWNhcmQgJiYgIWV2ZW50LnNrdSkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cblxuICBjb25zdCBzZXNzaW9uSW5mbzogU2Vzc2lvbkluZm8gPSB7fTtcblxuICAvLyBQYXJzZSBob3N0IGZpcm13YXJlIHZlcnNpb25cbiAgaWYgKGV2ZW50LmZpcm13YXJlX2hvc3QpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgaG9zdEZpcm13YXJlID0gSlNPTi5wYXJzZShldmVudC5maXJtd2FyZV9ob3N0KTtcbiAgICAgIHNlc3Npb25JbmZvLmZpcm13YXJlX3ZlcnNpb24gPSBob3N0RmlybXdhcmUudmVyc2lvbjtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLmVycm9yKCdGYWlsZWQgdG8gcGFyc2UgZmlybXdhcmVfaG9zdDonLCBlKTtcbiAgICB9XG4gIH1cblxuICAvLyBQYXJzZSBOb3RlY2FyZCBmaXJtd2FyZSB2ZXJzaW9uXG4gIGlmIChldmVudC5maXJtd2FyZV9ub3RlY2FyZCkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBub3RlY2FyZEZpcm13YXJlID0gSlNPTi5wYXJzZShldmVudC5maXJtd2FyZV9ub3RlY2FyZCk7XG4gICAgICBzZXNzaW9uSW5mby5ub3RlY2FyZF92ZXJzaW9uID0gbm90ZWNhcmRGaXJtd2FyZS52ZXJzaW9uO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ0ZhaWxlZCB0byBwYXJzZSBmaXJtd2FyZV9ub3RlY2FyZDonLCBlKTtcbiAgICB9XG4gIH1cblxuICAvLyBTS1VcbiAgaWYgKGV2ZW50LnNrdSkge1xuICAgIHNlc3Npb25JbmZvLm5vdGVjYXJkX3NrdSA9IGV2ZW50LnNrdTtcbiAgfVxuXG4gIHJldHVybiBPYmplY3Qua2V5cyhzZXNzaW9uSW5mbykubGVuZ3RoID4gMCA/IHNlc3Npb25JbmZvIDogdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIE5vcm1hbGl6ZSBsb2NhdGlvbiBzb3VyY2UgdHlwZSBmcm9tIE5vdGVodWIgdG8gb3VyIHN0YW5kYXJkIHZhbHVlc1xuICovXG5mdW5jdGlvbiBub3JtYWxpemVMb2NhdGlvblNvdXJjZShzb3VyY2U/OiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoIXNvdXJjZSkgcmV0dXJuICdncHMnO1xuICBjb25zdCBub3JtYWxpemVkID0gc291cmNlLnRvTG93ZXJDYXNlKCk7XG4gIC8vIE5vdGVodWIgdXNlcyAndHJpYW5ndWxhdGVkJyBidXQgd2UgdXNlICd0cmlhbmd1bGF0aW9uJyBmb3IgY29uc2lzdGVuY3lcbiAgaWYgKG5vcm1hbGl6ZWQgPT09ICd0cmlhbmd1bGF0ZWQnKSByZXR1cm4gJ3RyaWFuZ3VsYXRpb24nO1xuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuLyoqXG4gKiBFeHRyYWN0IGxvY2F0aW9uIGZyb20gTm90ZWh1YiBldmVudCwgcHJlZmVycmluZyBHUFMgYnV0IGZhbGxpbmcgYmFjayB0byB0cmlhbmd1bGF0aW9uXG4gKi9cbmZ1bmN0aW9uIGV4dHJhY3RMb2NhdGlvbihldmVudDogTm90ZWh1YkV2ZW50KTogeyBsYXQ6IG51bWJlcjsgbG9uOiBudW1iZXI7IHRpbWU/OiBudW1iZXI7IHNvdXJjZTogc3RyaW5nIH0gfCB1bmRlZmluZWQge1xuICAvLyBQcmVmZXIgR1BTIGxvY2F0aW9uIChiZXN0X2xhdC9iZXN0X2xvbiB3aXRoIHR5cGUgJ2dwcycpXG4gIGlmIChldmVudC5iZXN0X2xhdCAhPT0gdW5kZWZpbmVkICYmIGV2ZW50LmJlc3RfbG9uICE9PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgbGF0OiBldmVudC5iZXN0X2xhdCxcbiAgICAgIGxvbjogZXZlbnQuYmVzdF9sb24sXG4gICAgICB0aW1lOiBldmVudC5iZXN0X2xvY2F0aW9uX3doZW4sXG4gICAgICBzb3VyY2U6IG5vcm1hbGl6ZUxvY2F0aW9uU291cmNlKGV2ZW50LmJlc3RfbG9jYXRpb25fdHlwZSksXG4gICAgfTtcbiAgfVxuXG4gIC8vIEZhbGwgYmFjayB0byB0cmlhbmd1bGF0aW9uIGRhdGFcbiAgaWYgKGV2ZW50LnRyaV9sYXQgIT09IHVuZGVmaW5lZCAmJiBldmVudC50cmlfbG9uICE9PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgbGF0OiBldmVudC50cmlfbGF0LFxuICAgICAgbG9uOiBldmVudC50cmlfbG9uLFxuICAgICAgdGltZTogZXZlbnQudHJpX3doZW4sXG4gICAgICBzb3VyY2U6ICd0cmlhbmd1bGF0aW9uJyxcbiAgICB9O1xuICB9XG5cbiAgLy8gRmFsbCBiYWNrIHRvIHRvd2VyIGxvY2F0aW9uXG4gIGlmIChldmVudC50b3dlcl9sYXQgIT09IHVuZGVmaW5lZCAmJiBldmVudC50b3dlcl9sb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB7XG4gICAgICBsYXQ6IGV2ZW50LnRvd2VyX2xhdCxcbiAgICAgIGxvbjogZXZlbnQudG93ZXJfbG9uLFxuICAgICAgdGltZTogZXZlbnQudG93ZXJfd2hlbixcbiAgICAgIHNvdXJjZTogJ3Rvd2VyJyxcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuaW50ZXJmYWNlIFNvbmdiaXJkRXZlbnQge1xuICBkZXZpY2VfdWlkOiBzdHJpbmc7XG4gIHNlcmlhbF9udW1iZXI/OiBzdHJpbmc7XG4gIGZsZWV0Pzogc3RyaW5nO1xuICBldmVudF90eXBlOiBzdHJpbmc7XG4gIHRpbWVzdGFtcDogbnVtYmVyO1xuICByZWNlaXZlZDogbnVtYmVyO1xuICBzZXNzaW9uPzogU2Vzc2lvbkluZm87XG4gIGJvZHk6IHtcbiAgICB0ZW1wPzogbnVtYmVyO1xuICAgIGh1bWlkaXR5PzogbnVtYmVyO1xuICAgIHByZXNzdXJlPzogbnVtYmVyO1xuICAgIHZvbHRhZ2U/OiBudW1iZXI7XG4gICAgbW90aW9uPzogYm9vbGVhbjtcbiAgICBtb2RlPzogc3RyaW5nO1xuICAgIHR5cGU/OiBzdHJpbmc7XG4gICAgdmFsdWU/OiBudW1iZXI7XG4gICAgdGhyZXNob2xkPzogbnVtYmVyO1xuICAgIG1lc3NhZ2U/OiBzdHJpbmc7XG4gICAgY21kPzogc3RyaW5nO1xuICAgIGNtZF9pZD86IHN0cmluZztcbiAgICBzdGF0dXM/OiBzdHJpbmc7XG4gICAgZXhlY3V0ZWRfYXQ/OiBudW1iZXI7XG4gICAgbWlsbGlhbXBfaG91cnM/OiBudW1iZXI7XG4gICAgdGVtcGVyYXR1cmU/OiBudW1iZXI7XG4gICAgLy8gSGVhbHRoIGV2ZW50IGZpZWxkc1xuICAgIG1ldGhvZD86IHN0cmluZztcbiAgICB0ZXh0Pzogc3RyaW5nO1xuICAgIHZvbHRhZ2VfbW9kZT86IHN0cmluZztcbiAgfTtcbiAgbG9jYXRpb24/OiB7XG4gICAgbGF0PzogbnVtYmVyO1xuICAgIGxvbj86IG51bWJlcjtcbiAgICB0aW1lPzogbnVtYmVyO1xuICAgIHNvdXJjZT86IHN0cmluZztcbiAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gd3JpdGVUZWxlbWV0cnkoZXZlbnQ6IFNvbmdiaXJkRXZlbnQsIGRhdGFUeXBlOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGltZXN0YW1wID0gZXZlbnQudGltZXN0YW1wICogMTAwMDsgLy8gQ29udmVydCB0byBtaWxsaXNlY29uZHNcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCkgKyBUVExfU0VDT05EUztcblxuICBjb25zdCByZWNvcmQ6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICB0aW1lc3RhbXAsXG4gICAgdHRsLFxuICAgIGRhdGFfdHlwZTogZGF0YVR5cGUsXG4gICAgZXZlbnRfdHlwZTogZXZlbnQuZXZlbnRfdHlwZSxcbiAgICBldmVudF90eXBlX3RpbWVzdGFtcDogYCR7ZGF0YVR5cGV9IyR7dGltZXN0YW1wfWAsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgfTtcblxuICBpZiAoZXZlbnQuYm9keS50ZW1wICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQudGVtcGVyYXR1cmUgPSBldmVudC5ib2R5LnRlbXA7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuaHVtaWRpdHkgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5odW1pZGl0eSA9IGV2ZW50LmJvZHkuaHVtaWRpdHk7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkucHJlc3N1cmUgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5wcmVzc3VyZSA9IGV2ZW50LmJvZHkucHJlc3N1cmU7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkudm9sdGFnZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnZvbHRhZ2UgPSBldmVudC5ib2R5LnZvbHRhZ2U7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkubW90aW9uICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQubW90aW9uID0gZXZlbnQuYm9keS5tb3Rpb247XG4gIH1cblxuICBpZiAoZXZlbnQubG9jYXRpb24/LmxhdCAhPT0gdW5kZWZpbmVkICYmIGV2ZW50LmxvY2F0aW9uPy5sb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5sYXRpdHVkZSA9IGV2ZW50LmxvY2F0aW9uLmxhdDtcbiAgICByZWNvcmQubG9uZ2l0dWRlID0gZXZlbnQubG9jYXRpb24ubG9uO1xuICAgIHJlY29yZC5sb2NhdGlvbl9zb3VyY2UgPSBldmVudC5sb2NhdGlvbi5zb3VyY2UgfHwgJ2dwcyc7XG4gIH1cblxuICBjb25zdCBjb21tYW5kID0gbmV3IFB1dENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogVEVMRU1FVFJZX1RBQkxFLFxuICAgIEl0ZW06IHJlY29yZCxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBXcm90ZSB0ZWxlbWV0cnkgcmVjb3JkIGZvciAke2V2ZW50LmRldmljZV91aWR9YCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlUG93ZXJUZWxlbWV0cnkoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGltZXN0YW1wID0gZXZlbnQudGltZXN0YW1wICogMTAwMDtcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCkgKyBUVExfU0VDT05EUztcblxuICBjb25zdCByZWNvcmQ6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICB0aW1lc3RhbXAsXG4gICAgdHRsLFxuICAgIGRhdGFfdHlwZTogJ3Bvd2VyJyxcbiAgICBldmVudF90eXBlOiBldmVudC5ldmVudF90eXBlLFxuICAgIGV2ZW50X3R5cGVfdGltZXN0YW1wOiBgcG93ZXIjJHt0aW1lc3RhbXB9YCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyIHx8ICd1bmtub3duJyxcbiAgICBmbGVldDogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICB9O1xuXG4gIGlmIChldmVudC5ib2R5LnZvbHRhZ2UgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5tb2pvX3ZvbHRhZ2UgPSBldmVudC5ib2R5LnZvbHRhZ2U7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkubWlsbGlhbXBfaG91cnMgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5taWxsaWFtcF9ob3VycyA9IGV2ZW50LmJvZHkubWlsbGlhbXBfaG91cnM7XG4gIH1cblxuICBpZiAocmVjb3JkLm1vam9fdm9sdGFnZSAhPT0gdW5kZWZpbmVkIHx8XG4gICAgICByZWNvcmQubW9qb190ZW1wZXJhdHVyZSAhPT0gdW5kZWZpbmVkIHx8XG4gICAgICByZWNvcmQubWlsbGlhbXBfaG91cnMgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IFRFTEVNRVRSWV9UQUJMRSxcbiAgICAgIEl0ZW06IHJlY29yZCxcbiAgICB9KTtcblxuICAgIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICAgIGNvbnNvbGUubG9nKGBXcm90ZSBwb3dlciB0ZWxlbWV0cnkgcmVjb3JkIGZvciAke2V2ZW50LmRldmljZV91aWR9YCk7XG4gIH0gZWxzZSB7XG4gICAgY29uc29sZS5sb2coJ05vIHBvd2VyIG1ldHJpY3MgaW4gX2xvZy5xbyBldmVudCwgc2tpcHBpbmcnKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiB3cml0ZUhlYWx0aEV2ZW50KGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRpbWVzdGFtcCA9IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDA7IC8vIENvbnZlcnQgdG8gbWlsbGlzZWNvbmRzXG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgY29uc3QgcmVjb3JkOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge1xuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgdGltZXN0YW1wLFxuICAgIHR0bCxcbiAgICBkYXRhX3R5cGU6ICdoZWFsdGgnLFxuICAgIGV2ZW50X3R5cGU6IGV2ZW50LmV2ZW50X3R5cGUsXG4gICAgZXZlbnRfdHlwZV90aW1lc3RhbXA6IGBoZWFsdGgjJHt0aW1lc3RhbXB9YCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyIHx8ICd1bmtub3duJyxcbiAgICBmbGVldDogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICB9O1xuXG4gIC8vIEFkZCBoZWFsdGggZXZlbnQgZmllbGRzXG4gIGlmIChldmVudC5ib2R5Lm1ldGhvZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLm1ldGhvZCA9IGV2ZW50LmJvZHkubWV0aG9kO1xuICB9XG4gIGlmIChldmVudC5ib2R5LnRleHQgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC50ZXh0ID0gZXZlbnQuYm9keS50ZXh0O1xuICB9XG4gIGlmIChldmVudC5ib2R5LnZvbHRhZ2UgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC52b2x0YWdlID0gZXZlbnQuYm9keS52b2x0YWdlO1xuICB9XG4gIGlmIChldmVudC5ib2R5LnZvbHRhZ2VfbW9kZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnZvbHRhZ2VfbW9kZSA9IGV2ZW50LmJvZHkudm9sdGFnZV9tb2RlO1xuICB9XG4gIGlmIChldmVudC5ib2R5Lm1pbGxpYW1wX2hvdXJzICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQubWlsbGlhbXBfaG91cnMgPSBldmVudC5ib2R5Lm1pbGxpYW1wX2hvdXJzO1xuICB9XG5cbiAgLy8gQWRkIGxvY2F0aW9uIGlmIGF2YWlsYWJsZVxuICBpZiAoZXZlbnQubG9jYXRpb24/LmxhdCAhPT0gdW5kZWZpbmVkICYmIGV2ZW50LmxvY2F0aW9uPy5sb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5sYXRpdHVkZSA9IGV2ZW50LmxvY2F0aW9uLmxhdDtcbiAgICByZWNvcmQubG9uZ2l0dWRlID0gZXZlbnQubG9jYXRpb24ubG9uO1xuICAgIHJlY29yZC5sb2NhdGlvbl9zb3VyY2UgPSBldmVudC5sb2NhdGlvbi5zb3VyY2UgfHwgJ3Rvd2VyJztcbiAgfVxuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBURUxFTUVUUllfVEFCTEUsXG4gICAgSXRlbTogcmVjb3JkLFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFdyb3RlIGhlYWx0aCBldmVudCByZWNvcmQgZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH06ICR7ZXZlbnQuYm9keS5tZXRob2R9YCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlTG9jYXRpb25FdmVudChldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBpZiAoIWV2ZW50LmxvY2F0aW9uPy5sYXQgfHwgIWV2ZW50LmxvY2F0aW9uPy5sb24pIHtcbiAgICBjb25zb2xlLmxvZygnTm8gbG9jYXRpb24gZGF0YSBpbiBldmVudCwgc2tpcHBpbmcnKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB0aW1lc3RhbXAgPSBldmVudC50aW1lc3RhbXAgKiAxMDAwOyAvLyBDb252ZXJ0IHRvIG1pbGxpc2Vjb25kc1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSArIFRUTF9TRUNPTkRTO1xuXG4gIGNvbnN0IHJlY29yZDogUmVjb3JkPHN0cmluZywgYW55PiA9IHtcbiAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgIHRpbWVzdGFtcCxcbiAgICB0dGwsXG4gICAgZGF0YV90eXBlOiAndGVsZW1ldHJ5JywgLy8gVXNlIHRlbGVtZXRyeSBzbyBpdCdzIHBpY2tlZCB1cCBieSBsb2NhdGlvbiBxdWVyeVxuICAgIGV2ZW50X3R5cGU6IGV2ZW50LmV2ZW50X3R5cGUsXG4gICAgZXZlbnRfdHlwZV90aW1lc3RhbXA6IGB0ZWxlbWV0cnkjJHt0aW1lc3RhbXB9YCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyIHx8ICd1bmtub3duJyxcbiAgICBmbGVldDogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICAgIGxhdGl0dWRlOiBldmVudC5sb2NhdGlvbi5sYXQsXG4gICAgbG9uZ2l0dWRlOiBldmVudC5sb2NhdGlvbi5sb24sXG4gICAgbG9jYXRpb25fc291cmNlOiBldmVudC5sb2NhdGlvbi5zb3VyY2UgfHwgJ3RyaWFuZ3VsYXRpb24nLFxuICB9O1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBURUxFTUVUUllfVEFCTEUsXG4gICAgSXRlbTogcmVjb3JkLFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFdyb3RlIGxvY2F0aW9uIGV2ZW50IGZvciAke2V2ZW50LmRldmljZV91aWR9OiAke2V2ZW50LmxvY2F0aW9uLnNvdXJjZX0gKCR7ZXZlbnQubG9jYXRpb24ubGF0fSwgJHtldmVudC5sb2NhdGlvbi5sb259KWApO1xufVxuXG5hc3luYyBmdW5jdGlvbiB1cGRhdGVEZXZpY2VNZXRhZGF0YShldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuXG4gIGNvbnN0IHVwZGF0ZUV4cHJlc3Npb25zOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBleHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgY29uc3QgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczogUmVjb3JkPHN0cmluZywgYW55PiA9IHt9O1xuXG4gIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNsYXN0X3NlZW4gPSA6bGFzdF9zZWVuJyk7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI2xhc3Rfc2VlbiddID0gJ2xhc3Rfc2Vlbic7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpsYXN0X3NlZW4nXSA9IG5vdztcblxuICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjdXBkYXRlZF9hdCA9IDp1cGRhdGVkX2F0Jyk7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3VwZGF0ZWRfYXQnXSA9ICd1cGRhdGVkX2F0JztcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnVwZGF0ZWRfYXQnXSA9IG5vdztcblxuICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjc3RhdHVzID0gOnN0YXR1cycpO1xuICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNzdGF0dXMnXSA9ICdzdGF0dXMnO1xuICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6c3RhdHVzJ10gPSAnb25saW5lJztcblxuICBpZiAoZXZlbnQuc2VyaWFsX251bWJlcikge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNzbiA9IDpzbicpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3NuJ10gPSAnc2VyaWFsX251bWJlcic7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnNuJ10gPSBldmVudC5zZXJpYWxfbnVtYmVyO1xuICB9XG5cbiAgaWYgKGV2ZW50LmZsZWV0KSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI2ZsZWV0ID0gOmZsZWV0Jyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjZmxlZXQnXSA9ICdmbGVldCc7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOmZsZWV0J10gPSBldmVudC5mbGVldDtcbiAgfVxuXG4gIGlmIChldmVudC5ib2R5Lm1vZGUpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjbW9kZSA9IDptb2RlJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjbW9kZSddID0gJ2N1cnJlbnRfbW9kZSc7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOm1vZGUnXSA9IGV2ZW50LmJvZHkubW9kZTtcbiAgfVxuXG4gIGlmIChldmVudC5sb2NhdGlvbj8ubGF0ICE9PSB1bmRlZmluZWQgJiYgZXZlbnQubG9jYXRpb24/LmxvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI2xvYyA9IDpsb2MnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNsb2MnXSA9ICdsYXN0X2xvY2F0aW9uJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6bG9jJ10gPSB7XG4gICAgICBsYXQ6IGV2ZW50LmxvY2F0aW9uLmxhdCxcbiAgICAgIGxvbjogZXZlbnQubG9jYXRpb24ubG9uLFxuICAgICAgdGltZTogZXZlbnQubG9jYXRpb24udGltZSB8fCBldmVudC50aW1lc3RhbXAsXG4gICAgICBzb3VyY2U6IGV2ZW50LmxvY2F0aW9uLnNvdXJjZSB8fCAnZ3BzJyxcbiAgICB9O1xuICB9XG5cbiAgaWYgKGV2ZW50LmV2ZW50X3R5cGUgPT09ICd0cmFjay5xbycpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjdGVsZW1ldHJ5ID0gOnRlbGVtZXRyeScpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3RlbGVtZXRyeSddID0gJ2xhc3RfdGVsZW1ldHJ5JztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6dGVsZW1ldHJ5J10gPSB7XG4gICAgICB0ZW1wOiBldmVudC5ib2R5LnRlbXAsXG4gICAgICBodW1pZGl0eTogZXZlbnQuYm9keS5odW1pZGl0eSxcbiAgICAgIHByZXNzdXJlOiBldmVudC5ib2R5LnByZXNzdXJlLFxuICAgICAgdm9sdGFnZTogZXZlbnQuYm9keS52b2x0YWdlLFxuICAgICAgbW90aW9uOiBldmVudC5ib2R5Lm1vdGlvbixcbiAgICAgIHRpbWVzdGFtcDogZXZlbnQudGltZXN0YW1wLFxuICAgIH07XG4gIH1cblxuICBpZiAoZXZlbnQuZXZlbnRfdHlwZSA9PT0gJ19sb2cucW8nKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3Bvd2VyID0gOnBvd2VyJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjcG93ZXInXSA9ICdsYXN0X3Bvd2VyJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6cG93ZXInXSA9IHtcbiAgICAgIHZvbHRhZ2U6IGV2ZW50LmJvZHkudm9sdGFnZSxcbiAgICAgIHRlbXBlcmF0dXJlOiBldmVudC5ib2R5LnRlbXBlcmF0dXJlLFxuICAgICAgbWlsbGlhbXBfaG91cnM6IGV2ZW50LmJvZHkubWlsbGlhbXBfaG91cnMsXG4gICAgICB0aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCxcbiAgICB9O1xuICB9XG5cbiAgLy8gVXBkYXRlIGZpcm13YXJlIHZlcnNpb25zIGZyb20gX3Nlc3Npb24ucW8gZXZlbnRzXG4gIGlmIChldmVudC5zZXNzaW9uPy5maXJtd2FyZV92ZXJzaW9uKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI2Z3X3ZlcnNpb24gPSA6ZndfdmVyc2lvbicpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI2Z3X3ZlcnNpb24nXSA9ICdmaXJtd2FyZV92ZXJzaW9uJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6ZndfdmVyc2lvbiddID0gZXZlbnQuc2Vzc2lvbi5maXJtd2FyZV92ZXJzaW9uO1xuICB9XG5cbiAgaWYgKGV2ZW50LnNlc3Npb24/Lm5vdGVjYXJkX3ZlcnNpb24pIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjbmNfdmVyc2lvbiA9IDpuY192ZXJzaW9uJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjbmNfdmVyc2lvbiddID0gJ25vdGVjYXJkX3ZlcnNpb24nO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpuY192ZXJzaW9uJ10gPSBldmVudC5zZXNzaW9uLm5vdGVjYXJkX3ZlcnNpb247XG4gIH1cblxuICBpZiAoZXZlbnQuc2Vzc2lvbj8ubm90ZWNhcmRfc2t1KSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI25jX3NrdSA9IDpuY19za3UnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNuY19za3UnXSA9ICdub3RlY2FyZF9za3UnO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpuY19za3UnXSA9IGV2ZW50LnNlc3Npb24ubm90ZWNhcmRfc2t1O1xuICB9XG5cbiAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI2NyZWF0ZWRfYXQgPSBpZl9ub3RfZXhpc3RzKCNjcmVhdGVkX2F0LCA6Y3JlYXRlZF9hdCknKTtcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjY3JlYXRlZF9hdCddID0gJ2NyZWF0ZWRfYXQnO1xuICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6Y3JlYXRlZF9hdCddID0gbm93O1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgVXBkYXRlQ29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgIEtleTogeyBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkIH0sXG4gICAgVXBkYXRlRXhwcmVzc2lvbjogJ1NFVCAnICsgdXBkYXRlRXhwcmVzc2lvbnMuam9pbignLCAnKSxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lcyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzLFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFVwZGF0ZWQgZGV2aWNlIG1ldGFkYXRhIGZvciAke2V2ZW50LmRldmljZV91aWR9YCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHByb2Nlc3NDb21tYW5kQWNrKGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGNtZElkID0gZXZlbnQuYm9keS5jbWRfaWQ7XG4gIGlmICghY21kSWQpIHtcbiAgICBjb25zb2xlLmxvZygnQ29tbWFuZCBhY2sgbWlzc2luZyBjbWRfaWQsIHNraXBwaW5nJyk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcblxuICBjb25zdCBjb21tYW5kID0gbmV3IFVwZGF0ZUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogQ09NTUFORFNfVEFCTEUsXG4gICAgS2V5OiB7XG4gICAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgICAgY29tbWFuZF9pZDogY21kSWQsXG4gICAgfSxcbiAgICBVcGRhdGVFeHByZXNzaW9uOiAnU0VUICNzdGF0dXMgPSA6c3RhdHVzLCAjbWVzc2FnZSA9IDptZXNzYWdlLCAjZXhlY3V0ZWRfYXQgPSA6ZXhlY3V0ZWRfYXQsICN1cGRhdGVkX2F0ID0gOnVwZGF0ZWRfYXQnLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczoge1xuICAgICAgJyNzdGF0dXMnOiAnc3RhdHVzJyxcbiAgICAgICcjbWVzc2FnZSc6ICdtZXNzYWdlJyxcbiAgICAgICcjZXhlY3V0ZWRfYXQnOiAnZXhlY3V0ZWRfYXQnLFxuICAgICAgJyN1cGRhdGVkX2F0JzogJ3VwZGF0ZWRfYXQnLFxuICAgIH0sXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzpzdGF0dXMnOiBldmVudC5ib2R5LnN0YXR1cyB8fCAndW5rbm93bicsXG4gICAgICAnOm1lc3NhZ2UnOiBldmVudC5ib2R5Lm1lc3NhZ2UgfHwgJycsXG4gICAgICAnOmV4ZWN1dGVkX2F0JzogZXZlbnQuYm9keS5leGVjdXRlZF9hdCA/IGV2ZW50LmJvZHkuZXhlY3V0ZWRfYXQgKiAxMDAwIDogbm93LFxuICAgICAgJzp1cGRhdGVkX2F0Jzogbm93LFxuICAgIH0sXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgVXBkYXRlZCBjb21tYW5kICR7Y21kSWR9IHdpdGggc3RhdHVzOiAke2V2ZW50LmJvZHkuc3RhdHVzfWApO1xufVxuXG5hc3luYyBmdW5jdGlvbiBzdG9yZUFsZXJ0KGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3Iobm93IC8gMTAwMCkgKyBUVExfU0VDT05EUztcblxuICAvLyBHZW5lcmF0ZSBhIHVuaXF1ZSBhbGVydCBJRFxuICBjb25zdCBhbGVydElkID0gYGFsZXJ0XyR7ZXZlbnQuZGV2aWNlX3VpZH1fJHtub3d9XyR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc3Vic3RyaW5nKDcpfWA7XG5cbiAgY29uc3QgYWxlcnRSZWNvcmQgPSB7XG4gICAgYWxlcnRfaWQ6IGFsZXJ0SWQsXG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyIHx8ICd1bmtub3duJyxcbiAgICBmbGVldDogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICAgIHR5cGU6IGV2ZW50LmJvZHkudHlwZSB8fCAndW5rbm93bicsXG4gICAgdmFsdWU6IGV2ZW50LmJvZHkudmFsdWUsXG4gICAgdGhyZXNob2xkOiBldmVudC5ib2R5LnRocmVzaG9sZCxcbiAgICBtZXNzYWdlOiBldmVudC5ib2R5Lm1lc3NhZ2UgfHwgJycsXG4gICAgY3JlYXRlZF9hdDogbm93LFxuICAgIGV2ZW50X3RpbWVzdGFtcDogZXZlbnQudGltZXN0YW1wICogMTAwMCxcbiAgICBhY2tub3dsZWRnZWQ6ICdmYWxzZScsIC8vIFN0cmluZyBmb3IgR1NJIHBhcnRpdGlvbiBrZXlcbiAgICB0dGwsXG4gICAgbG9jYXRpb246IGV2ZW50LmxvY2F0aW9uID8ge1xuICAgICAgbGF0OiBldmVudC5sb2NhdGlvbi5sYXQsXG4gICAgICBsb246IGV2ZW50LmxvY2F0aW9uLmxvbixcbiAgICB9IDogdW5kZWZpbmVkLFxuICB9O1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBBTEVSVFNfVEFCTEUsXG4gICAgSXRlbTogYWxlcnRSZWNvcmQsXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgU3RvcmVkIGFsZXJ0ICR7YWxlcnRJZH0gZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH1gKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcHVibGlzaEFsZXJ0KGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGFsZXJ0TWVzc2FnZSA9IHtcbiAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgIHNlcmlhbF9udW1iZXI6IGV2ZW50LnNlcmlhbF9udW1iZXIsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0LFxuICAgIGFsZXJ0X3R5cGU6IGV2ZW50LmJvZHkudHlwZSxcbiAgICB2YWx1ZTogZXZlbnQuYm9keS52YWx1ZSxcbiAgICB0aHJlc2hvbGQ6IGV2ZW50LmJvZHkudGhyZXNob2xkLFxuICAgIG1lc3NhZ2U6IGV2ZW50LmJvZHkubWVzc2FnZSxcbiAgICB0aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCxcbiAgICBsb2NhdGlvbjogZXZlbnQubG9jYXRpb24sXG4gIH07XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBQdWJsaXNoQ29tbWFuZCh7XG4gICAgVG9waWNBcm46IEFMRVJUX1RPUElDX0FSTixcbiAgICBTdWJqZWN0OiBgU29uZ2JpcmQgQWxlcnQ6ICR7ZXZlbnQuYm9keS50eXBlfSAtICR7ZXZlbnQuc2VyaWFsX251bWJlciB8fCBldmVudC5kZXZpY2VfdWlkfWAsXG4gICAgTWVzc2FnZTogSlNPTi5zdHJpbmdpZnkoYWxlcnRNZXNzYWdlLCBudWxsLCAyKSxcbiAgICBNZXNzYWdlQXR0cmlidXRlczoge1xuICAgICAgYWxlcnRfdHlwZToge1xuICAgICAgICBEYXRhVHlwZTogJ1N0cmluZycsXG4gICAgICAgIFN0cmluZ1ZhbHVlOiBldmVudC5ib2R5LnR5cGUgfHwgJ3Vua25vd24nLFxuICAgICAgfSxcbiAgICAgIGRldmljZV91aWQ6IHtcbiAgICAgICAgRGF0YVR5cGU6ICdTdHJpbmcnLFxuICAgICAgICBTdHJpbmdWYWx1ZTogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICAgIH0sXG4gICAgICBmbGVldDoge1xuICAgICAgICBEYXRhVHlwZTogJ1N0cmluZycsXG4gICAgICAgIFN0cmluZ1ZhbHVlOiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGF3YWl0IHNuc0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgUHVibGlzaGVkIGFsZXJ0IHRvIFNOUzogJHtldmVudC5ib2R5LnR5cGV9YCk7XG59XG4iXX0=