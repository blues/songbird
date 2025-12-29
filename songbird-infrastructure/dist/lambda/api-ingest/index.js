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
const JOURNEYS_TABLE = process.env.JOURNEYS_TABLE;
const LOCATIONS_TABLE = process.env.LOCATIONS_TABLE;
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
        // For _track.qo events, use 'where_when' which is when the GPS fix was captured
        // For other events, use 'when' if available, otherwise fall back to 'received'
        let eventTimestamp;
        if (notehubEvent.file === '_track.qo' && notehubEvent.where_when) {
            eventTimestamp = notehubEvent.where_when;
        }
        else {
            eventTimestamp = notehubEvent.when || Math.floor(notehubEvent.received);
        }
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
        // Skip if device is USB powered (voltage_mode: "usb") - no battery to monitor
        if (songbirdEvent.event_type === '_log.qo') {
            if (songbirdEvent.body.voltage_mode === 'usb') {
                console.log(`Skipping _log.qo event for ${songbirdEvent.device_uid} - USB powered`);
            }
            else {
                await writePowerTelemetry(songbirdEvent);
            }
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
        // Handle GPS tracking events (_track.qo from Notecard)
        if (songbirdEvent.event_type === '_track.qo') {
            await writeTrackingEvent(songbirdEvent);
            await upsertJourney(songbirdEvent);
        }
        // Write to location history table for all events with location
        if (songbirdEvent.location) {
            await writeLocationHistory(songbirdEvent);
        }
        // Track mode changes BEFORE updating device metadata (so we can compare old vs new)
        if (songbirdEvent.body.mode) {
            await trackModeChange(songbirdEvent);
        }
        // Update device metadata in DynamoDB
        await updateDeviceMetadata(songbirdEvent);
        // Check for mode change away from transit - complete any active journeys
        if (songbirdEvent.body.mode && songbirdEvent.body.mode !== 'transit') {
            await completeActiveJourneysOnModeChange(songbirdEvent.device_uid, songbirdEvent.body.mode);
        }
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
 * Extract session info (firmware versions, SKU, power status) from Notehub event
 * This info is available in _session.qo events
 * Note: Some fields may appear at the top level or inside the body depending on the HTTP route configuration
 */
function extractSessionInfo(event) {
    // Check for power_usb at top level OR in body
    const powerUsb = event.power_usb ?? event.body?.power_usb;
    if (!event.firmware_host && !event.firmware_notecard && !event.sku && powerUsb === undefined) {
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
    // USB power status (check top level first, then body)
    if (powerUsb !== undefined) {
        sessionInfo.usb_powered = powerUsb;
        console.log(`Extracted usb_powered: ${powerUsb}`);
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
    // Note: voltage is no longer included in track.qo telemetry
    // Battery info comes from _log.qo (Mojo) and _health.qo events
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
    // For track.qo events, update lock states based on presence of the field
    // If locked is true, set it; if absent or false, clear it
    if (event.event_type === 'track.qo') {
        updateExpressions.push('#transit_locked = :transit_locked');
        expressionAttributeNames['#transit_locked'] = 'transit_locked';
        expressionAttributeValues[':transit_locked'] = event.body.transit_locked === true;
        updateExpressions.push('#demo_locked = :demo_locked');
        expressionAttributeNames['#demo_locked'] = 'demo_locked';
        expressionAttributeValues[':demo_locked'] = event.body.demo_locked === true;
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
            // Note: voltage is no longer sent in track.qo; use last_voltage from _log.qo/_health.qo
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
        // Update device voltage from Mojo power monitoring
        if (event.body.voltage !== undefined) {
            updateExpressions.push('#voltage = :voltage');
            expressionAttributeNames['#voltage'] = 'voltage';
            expressionAttributeValues[':voltage'] = event.body.voltage;
        }
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
    // Update USB power status from _session.qo events
    if (event.session?.usb_powered !== undefined) {
        updateExpressions.push('#usb_powered = :usb_powered');
        expressionAttributeNames['#usb_powered'] = 'usb_powered';
        expressionAttributeValues[':usb_powered'] = event.session.usb_powered;
    }
    // Update USB power status from _health.qo voltage_mode field
    // This is more frequently reported than _session.qo and gives real-time power status
    if (event.body.voltage_mode !== undefined) {
        updateExpressions.push('#usb_powered = :usb_powered');
        expressionAttributeNames['#usb_powered'] = 'usb_powered';
        expressionAttributeValues[':usb_powered'] = event.body.voltage_mode === 'usb';
    }
    // Update device voltage from _health.qo events (fallback when Mojo is not available)
    // Only update if we haven't already set voltage from _log.qo in this event
    if (event.event_type === '_health.qo' && event.body.voltage !== undefined && !expressionAttributeValues[':voltage']) {
        updateExpressions.push('#voltage = :voltage');
        expressionAttributeNames['#voltage'] = 'voltage';
        expressionAttributeValues[':voltage'] = event.body.voltage;
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
/**
 * Write GPS tracking event to telemetry table
 * Handles _track.qo events from Notecard's card.location.track
 */
async function writeTrackingEvent(event) {
    if (!event.location?.lat || !event.location?.lon) {
        console.log('No location data in _track.qo event, skipping');
        return;
    }
    const timestamp = event.timestamp * 1000; // Convert to milliseconds
    const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    const record = {
        device_uid: event.device_uid,
        timestamp,
        ttl,
        data_type: 'tracking',
        event_type: event.event_type,
        event_type_timestamp: `tracking#${timestamp}`,
        serial_number: event.serial_number || 'unknown',
        fleet: event.fleet || 'default',
        latitude: event.location.lat,
        longitude: event.location.lon,
        location_source: event.location.source || 'gps',
    };
    // Add tracking-specific fields
    if (event.body.velocity !== undefined) {
        record.velocity = event.body.velocity;
    }
    if (event.body.bearing !== undefined) {
        record.bearing = event.body.bearing;
    }
    if (event.body.distance !== undefined) {
        record.distance = event.body.distance;
    }
    if (event.body.seconds !== undefined) {
        record.seconds = event.body.seconds;
    }
    if (event.body.dop !== undefined) {
        record.dop = event.body.dop;
    }
    if (event.body.journey !== undefined) {
        record.journey_id = event.body.journey;
    }
    if (event.body.jcount !== undefined) {
        record.jcount = event.body.jcount;
    }
    if (event.body.motion !== undefined) {
        record.motion = event.body.motion;
    }
    const command = new lib_dynamodb_1.PutCommand({
        TableName: TELEMETRY_TABLE,
        Item: record,
    });
    await docClient.send(command);
    console.log(`Wrote tracking event for ${event.device_uid} (journey: ${event.body.journey}, jcount: ${event.body.jcount})`);
}
/**
 * Upsert journey record
 * - Creates new journey when jcount === 1
 * - Updates existing journey with new end_time and point_count
 * - Marks previous journey as completed when a new one starts
 */
async function upsertJourney(event) {
    const journeyId = event.body.journey;
    const jcount = event.body.jcount;
    if (!journeyId || !jcount) {
        console.log('Missing journey or jcount in _track.qo event, skipping journey upsert');
        return;
    }
    const now = Date.now();
    const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    const timestampMs = event.timestamp * 1000;
    // If this is the first point of a new journey, mark previous journey as completed
    if (jcount === 1) {
        await markPreviousJourneyCompleted(event.device_uid, journeyId);
    }
    // Calculate cumulative distance
    const distance = event.body.distance || 0;
    // Upsert journey record
    const command = new lib_dynamodb_1.UpdateCommand({
        TableName: JOURNEYS_TABLE,
        Key: {
            device_uid: event.device_uid,
            journey_id: journeyId,
        },
        UpdateExpression: `
      SET #status = :status,
          #start_time = if_not_exists(#start_time, :start_time),
          #end_time = :end_time,
          #point_count = :point_count,
          #total_distance = if_not_exists(#total_distance, :zero) + :distance,
          #ttl = :ttl,
          #updated_at = :updated_at
    `,
        ExpressionAttributeNames: {
            '#status': 'status',
            '#start_time': 'start_time',
            '#end_time': 'end_time',
            '#point_count': 'point_count',
            '#total_distance': 'total_distance',
            '#ttl': 'ttl',
            '#updated_at': 'updated_at',
        },
        ExpressionAttributeValues: {
            ':status': 'active',
            ':start_time': journeyId * 1000, // Convert to milliseconds
            ':end_time': timestampMs,
            ':point_count': jcount,
            ':distance': distance,
            ':zero': 0,
            ':ttl': ttl,
            ':updated_at': now,
        },
    });
    await docClient.send(command);
    console.log(`Upserted journey ${journeyId} for ${event.device_uid} (point ${jcount})`);
}
/**
 * Mark previous journey as completed when a new journey starts
 */
async function markPreviousJourneyCompleted(deviceUid, currentJourneyId) {
    // Query for the most recent active journey that's not the current one
    const queryCommand = new lib_dynamodb_1.QueryCommand({
        TableName: JOURNEYS_TABLE,
        KeyConditionExpression: 'device_uid = :device_uid AND journey_id < :current_journey',
        FilterExpression: '#status = :active',
        ExpressionAttributeNames: {
            '#status': 'status',
        },
        ExpressionAttributeValues: {
            ':device_uid': deviceUid,
            ':current_journey': currentJourneyId,
            ':active': 'active',
        },
        ScanIndexForward: false, // Most recent first
        Limit: 1,
    });
    const result = await docClient.send(queryCommand);
    if (result.Items && result.Items.length > 0) {
        const previousJourney = result.Items[0];
        const updateCommand = new lib_dynamodb_1.UpdateCommand({
            TableName: JOURNEYS_TABLE,
            Key: {
                device_uid: deviceUid,
                journey_id: previousJourney.journey_id,
            },
            UpdateExpression: 'SET #status = :status, #updated_at = :updated_at',
            ExpressionAttributeNames: {
                '#status': 'status',
                '#updated_at': 'updated_at',
            },
            ExpressionAttributeValues: {
                ':status': 'completed',
                ':updated_at': Date.now(),
            },
        });
        await docClient.send(updateCommand);
        console.log(`Marked journey ${previousJourney.journey_id} as completed for ${deviceUid}`);
    }
}
/**
 * Write location to the locations history table
 * Records all location events regardless of source for unified location history
 */
async function writeLocationHistory(event) {
    if (!event.location?.lat || !event.location?.lon) {
        return;
    }
    const timestamp = event.timestamp * 1000; // Convert to milliseconds
    const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    const record = {
        device_uid: event.device_uid,
        timestamp,
        ttl,
        latitude: event.location.lat,
        longitude: event.location.lon,
        source: event.location.source || 'unknown',
        location_name: event.location.name,
        event_type: event.event_type,
        serial_number: event.serial_number || 'unknown',
        fleet: event.fleet || 'default',
    };
    // Add journey info if this is a tracking event
    if (event.event_type === '_track.qo') {
        if (event.body.journey !== undefined) {
            record.journey_id = event.body.journey;
        }
        if (event.body.jcount !== undefined) {
            record.jcount = event.body.jcount;
        }
        if (event.body.velocity !== undefined) {
            record.velocity = event.body.velocity;
        }
        if (event.body.bearing !== undefined) {
            record.bearing = event.body.bearing;
        }
        if (event.body.distance !== undefined) {
            record.distance = event.body.distance;
        }
        if (event.body.dop !== undefined) {
            record.dop = event.body.dop;
        }
    }
    const command = new lib_dynamodb_1.PutCommand({
        TableName: LOCATIONS_TABLE,
        Item: record,
    });
    await docClient.send(command);
    console.log(`Wrote location history for ${event.device_uid}: ${event.location.source} (${event.location.lat}, ${event.location.lon})`);
}
/**
 * Complete all active journeys when device exits transit mode
 * This ensures journeys are properly closed when mode changes to demo, storage, or sleep
 */
async function completeActiveJourneysOnModeChange(deviceUid, newMode) {
    // Query for all active journeys for this device
    const queryCommand = new lib_dynamodb_1.QueryCommand({
        TableName: JOURNEYS_TABLE,
        IndexName: 'status-index',
        KeyConditionExpression: '#status = :active',
        FilterExpression: 'device_uid = :device_uid',
        ExpressionAttributeNames: {
            '#status': 'status',
        },
        ExpressionAttributeValues: {
            ':active': 'active',
            ':device_uid': deviceUid,
        },
    });
    try {
        const result = await docClient.send(queryCommand);
        if (result.Items && result.Items.length > 0) {
            console.log(`Mode changed to ${newMode} - completing ${result.Items.length} active journey(s) for ${deviceUid}`);
            // Mark each active journey as completed
            for (const journey of result.Items) {
                const updateCommand = new lib_dynamodb_1.UpdateCommand({
                    TableName: JOURNEYS_TABLE,
                    Key: {
                        device_uid: deviceUid,
                        journey_id: journey.journey_id,
                    },
                    UpdateExpression: 'SET #status = :status, #updated_at = :updated_at',
                    ExpressionAttributeNames: {
                        '#status': 'status',
                        '#updated_at': 'updated_at',
                    },
                    ExpressionAttributeValues: {
                        ':status': 'completed',
                        ':updated_at': Date.now(),
                    },
                });
                await docClient.send(updateCommand);
                console.log(`Marked journey ${journey.journey_id} as completed due to mode change to ${newMode}`);
            }
        }
    }
    catch (error) {
        // Log but don't fail the request - journey completion is not critical
        console.error(`Error completing active journeys on mode change: ${error}`);
    }
}
/**
 * Check if mode has changed and write a mode_change event to telemetry table
 * This allows the activity feed to show mode changes
 */
async function trackModeChange(event) {
    if (!event.body.mode) {
        return; // No mode in event, nothing to track
    }
    try {
        // Get current device mode from devices table
        const getCommand = new lib_dynamodb_1.GetCommand({
            TableName: DEVICES_TABLE,
            Key: { device_uid: event.device_uid },
            ProjectionExpression: 'current_mode',
        });
        const result = await docClient.send(getCommand);
        const previousMode = result.Item?.current_mode;
        // If mode has changed (or device is new), record the change
        if (previousMode && previousMode !== event.body.mode) {
            const timestamp = event.timestamp * 1000; // Convert to milliseconds
            const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
            const record = {
                device_uid: event.device_uid,
                timestamp,
                ttl,
                data_type: 'mode_change',
                event_type: event.event_type,
                event_type_timestamp: `mode_change#${timestamp}`,
                serial_number: event.serial_number || 'unknown',
                fleet: event.fleet || 'default',
                previous_mode: previousMode,
                new_mode: event.body.mode,
            };
            const putCommand = new lib_dynamodb_1.PutCommand({
                TableName: TELEMETRY_TABLE,
                Item: record,
            });
            await docClient.send(putCommand);
            console.log(`Recorded mode change for ${event.device_uid}: ${previousMode} -> ${event.body.mode}`);
        }
    }
    catch (error) {
        // Log but don't fail the request - mode tracking is not critical
        console.error(`Error tracking mode change: ${error}`);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWluZ2VzdC9pbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7O0dBS0c7OztBQUVILDhEQUEwRDtBQUMxRCx3REFBb0g7QUFDcEgsb0RBQWdFO0FBR2hFLHFCQUFxQjtBQUNyQixNQUFNLFNBQVMsR0FBRyxJQUFJLGdDQUFjLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDekMsTUFBTSxTQUFTLEdBQUcscUNBQXNCLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRTtJQUN2RCxlQUFlLEVBQUU7UUFDZixxQkFBcUIsRUFBRSxJQUFJO0tBQzVCO0NBQ0YsQ0FBQyxDQUFDO0FBQ0gsTUFBTSxTQUFTLEdBQUcsSUFBSSxzQkFBUyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBRXBDLHdCQUF3QjtBQUN4QixNQUFNLGVBQWUsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGVBQWdCLENBQUM7QUFDckQsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxhQUFjLENBQUM7QUFDakQsTUFBTSxjQUFjLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFlLENBQUM7QUFDbkQsTUFBTSxZQUFZLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxZQUFhLENBQUM7QUFDL0MsTUFBTSxlQUFlLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxlQUFnQixDQUFDO0FBQ3JELE1BQU0sY0FBYyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsY0FBZSxDQUFDO0FBQ25ELE1BQU0sZUFBZSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsZUFBZ0IsQ0FBQztBQUVyRCwwQkFBMEI7QUFDMUIsTUFBTSxRQUFRLEdBQUcsRUFBRSxDQUFDO0FBQ3BCLE1BQU0sV0FBVyxHQUFHLFFBQVEsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsQ0FBQztBQStFckMsTUFBTSxPQUFPLEdBQUcsS0FBSyxFQUFFLEtBQTJCLEVBQWtDLEVBQUU7SUFDM0YsT0FBTyxDQUFDLEdBQUcsQ0FBQyxpQkFBaUIsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFFdEQsTUFBTSxPQUFPLEdBQUc7UUFDZCxjQUFjLEVBQUUsa0JBQWtCO0tBQ25DLENBQUM7SUFFRixJQUFJLENBQUM7UUFDSCxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ2hCLE9BQU87Z0JBQ0wsVUFBVSxFQUFFLEdBQUc7Z0JBQ2YsT0FBTztnQkFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSx1QkFBdUIsRUFBRSxDQUFDO2FBQ3pELENBQUM7UUFDSixDQUFDO1FBRUQsTUFBTSxZQUFZLEdBQWlCLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQzFELE9BQU8sQ0FBQyxHQUFHLENBQUMsMkJBQTJCLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDO1FBRXZFLCtCQUErQjtRQUMvQixnRkFBZ0Y7UUFDaEYsK0VBQStFO1FBQy9FLElBQUksY0FBc0IsQ0FBQztRQUMzQixJQUFJLFlBQVksQ0FBQyxJQUFJLEtBQUssV0FBVyxJQUFJLFlBQVksQ0FBQyxVQUFVLEVBQUUsQ0FBQztZQUNqRSxjQUFjLEdBQUcsWUFBWSxDQUFDLFVBQVUsQ0FBQztRQUMzQyxDQUFDO2FBQU0sQ0FBQztZQUNOLGNBQWMsR0FBRyxZQUFZLENBQUMsSUFBSSxJQUFJLElBQUksQ0FBQyxLQUFLLENBQUMsWUFBWSxDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBQzFFLENBQUM7UUFFRCxnRkFBZ0Y7UUFDaEYsTUFBTSxRQUFRLEdBQUcsZUFBZSxDQUFDLFlBQVksQ0FBQyxDQUFDO1FBRS9DLHdFQUF3RTtRQUN4RSxNQUFNLFdBQVcsR0FBRyxrQkFBa0IsQ0FBQyxZQUFZLENBQUMsQ0FBQztRQUVyRCxNQUFNLGFBQWEsR0FBRztZQUNwQixVQUFVLEVBQUUsWUFBWSxDQUFDLE1BQU07WUFDL0IsYUFBYSxFQUFFLFlBQVksQ0FBQyxFQUFFO1lBQzlCLEtBQUssRUFBRSxZQUFZLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksU0FBUztZQUM1QyxVQUFVLEVBQUUsWUFBWSxDQUFDLElBQUk7WUFDN0IsU0FBUyxFQUFFLGNBQWM7WUFDekIsUUFBUSxFQUFFLFlBQVksQ0FBQyxRQUFRO1lBQy9CLElBQUksRUFBRSxZQUFZLENBQUMsSUFBSSxJQUFJLEVBQUU7WUFDN0IsUUFBUTtZQUNSLE9BQU8sRUFBRSxXQUFXO1NBQ3JCLENBQUM7UUFFRixvREFBb0Q7UUFDcEQsSUFBSSxhQUFhLENBQUMsVUFBVSxLQUFLLFVBQVUsRUFBRSxDQUFDO1lBQzVDLE1BQU0sY0FBYyxDQUFDLGFBQWEsRUFBRSxXQUFXLENBQUMsQ0FBQztRQUNuRCxDQUFDO1FBRUQsdUVBQXVFO1FBQ3ZFLDhFQUE4RTtRQUM5RSxJQUFJLGFBQWEsQ0FBQyxVQUFVLEtBQUssU0FBUyxFQUFFLENBQUM7WUFDM0MsSUFBSSxhQUFhLENBQUMsSUFBSSxDQUFDLFlBQVksS0FBSyxLQUFLLEVBQUUsQ0FBQztnQkFDOUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyw4QkFBOEIsYUFBYSxDQUFDLFVBQVUsZ0JBQWdCLENBQUMsQ0FBQztZQUN0RixDQUFDO2lCQUFNLENBQUM7Z0JBQ04sTUFBTSxtQkFBbUIsQ0FBQyxhQUFhLENBQUMsQ0FBQztZQUMzQyxDQUFDO1FBQ0gsQ0FBQztRQUVELCtDQUErQztRQUMvQyxJQUFJLGFBQWEsQ0FBQyxVQUFVLEtBQUssWUFBWSxFQUFFLENBQUM7WUFDOUMsTUFBTSxnQkFBZ0IsQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUN4QyxDQUFDO1FBRUQsK0NBQStDO1FBQy9DLCtEQUErRDtRQUMvRCxJQUFJLGFBQWEsQ0FBQyxVQUFVLEtBQUssZUFBZSxJQUFJLGFBQWEsQ0FBQyxRQUFRLEVBQUUsQ0FBQztZQUMzRSxNQUFNLGtCQUFrQixDQUFDLGFBQWEsQ0FBQyxDQUFDO1FBQzFDLENBQUM7UUFFRCx1REFBdUQ7UUFDdkQsSUFBSSxhQUFhLENBQUMsVUFBVSxLQUFLLFdBQVcsRUFBRSxDQUFDO1lBQzdDLE1BQU0sa0JBQWtCLENBQUMsYUFBYSxDQUFDLENBQUM7WUFDeEMsTUFBTSxhQUFhLENBQUMsYUFBYSxDQUFDLENBQUM7UUFDckMsQ0FBQztRQUVELCtEQUErRDtRQUMvRCxJQUFJLGFBQWEsQ0FBQyxRQUFRLEVBQUUsQ0FBQztZQUMzQixNQUFNLG9CQUFvQixDQUFDLGFBQWEsQ0FBQyxDQUFDO1FBQzVDLENBQUM7UUFFRCxvRkFBb0Y7UUFDcEYsSUFBSSxhQUFhLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQzVCLE1BQU0sZUFBZSxDQUFDLGFBQWEsQ0FBQyxDQUFDO1FBQ3ZDLENBQUM7UUFFRCxxQ0FBcUM7UUFDckMsTUFBTSxvQkFBb0IsQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUUxQyx5RUFBeUU7UUFDekUsSUFBSSxhQUFhLENBQUMsSUFBSSxDQUFDLElBQUksSUFBSSxhQUFhLENBQUMsSUFBSSxDQUFDLElBQUksS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUNyRSxNQUFNLGtDQUFrQyxDQUFDLGFBQWEsQ0FBQyxVQUFVLEVBQUUsYUFBYSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUM5RixDQUFDO1FBRUQsb0RBQW9EO1FBQ3BELElBQUksYUFBYSxDQUFDLFVBQVUsS0FBSyxVQUFVLEVBQUUsQ0FBQztZQUM1QyxNQUFNLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQztZQUNoQyxNQUFNLFlBQVksQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUNwQyxDQUFDO1FBRUQsaUNBQWlDO1FBQ2pDLElBQUksYUFBYSxDQUFDLFVBQVUsS0FBSyxnQkFBZ0IsRUFBRSxDQUFDO1lBQ2xELE1BQU0saUJBQWlCLENBQUMsYUFBYSxDQUFDLENBQUM7UUFDekMsQ0FBQztRQUVELE9BQU8sQ0FBQyxHQUFHLENBQUMsOEJBQThCLENBQUMsQ0FBQztRQUU1QyxPQUFPO1lBQ0wsVUFBVSxFQUFFLEdBQUc7WUFDZixPQUFPO1lBQ1AsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxhQUFhLENBQUMsVUFBVSxFQUFFLENBQUM7U0FDekUsQ0FBQztJQUNKLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2YsT0FBTyxDQUFDLEtBQUssQ0FBQyx5QkFBeUIsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUNoRCxPQUFPO1lBQ0wsVUFBVSxFQUFFLEdBQUc7WUFDZixPQUFPO1lBQ1AsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxLQUFLLEVBQUUsdUJBQXVCLEVBQUUsQ0FBQztTQUN6RCxDQUFDO0lBQ0osQ0FBQztBQUNILENBQUMsQ0FBQztBQTNIVyxRQUFBLE9BQU8sV0EySGxCO0FBU0Y7Ozs7R0FJRztBQUNILFNBQVMsa0JBQWtCLENBQUMsS0FBbUI7SUFDN0MsOENBQThDO0lBQzlDLE1BQU0sUUFBUSxHQUFHLEtBQUssQ0FBQyxTQUFTLElBQUksS0FBSyxDQUFDLElBQUksRUFBRSxTQUFTLENBQUM7SUFFMUQsSUFBSSxDQUFDLEtBQUssQ0FBQyxhQUFhLElBQUksQ0FBQyxLQUFLLENBQUMsaUJBQWlCLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxJQUFJLFFBQVEsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUM3RixPQUFPLFNBQVMsQ0FBQztJQUNuQixDQUFDO0lBRUQsTUFBTSxXQUFXLEdBQWdCLEVBQUUsQ0FBQztJQUVwQyw4QkFBOEI7SUFDOUIsSUFBSSxLQUFLLENBQUMsYUFBYSxFQUFFLENBQUM7UUFDeEIsSUFBSSxDQUFDO1lBQ0gsTUFBTSxZQUFZLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsYUFBYSxDQUFDLENBQUM7WUFDckQsV0FBVyxDQUFDLGdCQUFnQixHQUFHLFlBQVksQ0FBQyxPQUFPLENBQUM7UUFDdEQsQ0FBQztRQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7WUFDWCxPQUFPLENBQUMsS0FBSyxDQUFDLGdDQUFnQyxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQ3JELENBQUM7SUFDSCxDQUFDO0lBRUQsa0NBQWtDO0lBQ2xDLElBQUksS0FBSyxDQUFDLGlCQUFpQixFQUFFLENBQUM7UUFDNUIsSUFBSSxDQUFDO1lBQ0gsTUFBTSxnQkFBZ0IsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO1lBQzdELFdBQVcsQ0FBQyxnQkFBZ0IsR0FBRyxnQkFBZ0IsQ0FBQyxPQUFPLENBQUM7UUFDMUQsQ0FBQztRQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7WUFDWCxPQUFPLENBQUMsS0FBSyxDQUFDLG9DQUFvQyxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQ3pELENBQUM7SUFDSCxDQUFDO0lBRUQsTUFBTTtJQUNOLElBQUksS0FBSyxDQUFDLEdBQUcsRUFBRSxDQUFDO1FBQ2QsV0FBVyxDQUFDLFlBQVksR0FBRyxLQUFLLENBQUMsR0FBRyxDQUFDO0lBQ3ZDLENBQUM7SUFFRCxzREFBc0Q7SUFDdEQsSUFBSSxRQUFRLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDM0IsV0FBVyxDQUFDLFdBQVcsR0FBRyxRQUFRLENBQUM7UUFDbkMsT0FBTyxDQUFDLEdBQUcsQ0FBQywwQkFBMEIsUUFBUSxFQUFFLENBQUMsQ0FBQztJQUNwRCxDQUFDO0lBRUQsT0FBTyxNQUFNLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO0FBQ3ZFLENBQUM7QUFFRDs7R0FFRztBQUNILFNBQVMsdUJBQXVCLENBQUMsTUFBZTtJQUM5QyxJQUFJLENBQUMsTUFBTTtRQUFFLE9BQU8sS0FBSyxDQUFDO0lBQzFCLE1BQU0sVUFBVSxHQUFHLE1BQU0sQ0FBQyxXQUFXLEVBQUUsQ0FBQztJQUN4Qyx5RUFBeUU7SUFDekUsSUFBSSxVQUFVLEtBQUssY0FBYztRQUFFLE9BQU8sZUFBZSxDQUFDO0lBQzFELE9BQU8sVUFBVSxDQUFDO0FBQ3BCLENBQUM7QUFFRDs7R0FFRztBQUNILFNBQVMsZUFBZSxDQUFDLEtBQW1CO0lBQzFDLDBEQUEwRDtJQUMxRCxJQUFJLEtBQUssQ0FBQyxRQUFRLEtBQUssU0FBUyxJQUFJLEtBQUssQ0FBQyxRQUFRLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDakUsT0FBTztZQUNMLEdBQUcsRUFBRSxLQUFLLENBQUMsUUFBUTtZQUNuQixHQUFHLEVBQUUsS0FBSyxDQUFDLFFBQVE7WUFDbkIsSUFBSSxFQUFFLEtBQUssQ0FBQyxrQkFBa0I7WUFDOUIsTUFBTSxFQUFFLHVCQUF1QixDQUFDLEtBQUssQ0FBQyxrQkFBa0IsQ0FBQztZQUN6RCxJQUFJLEVBQUUsS0FBSyxDQUFDLGFBQWE7U0FDMUIsQ0FBQztJQUNKLENBQUM7SUFFRCxrQ0FBa0M7SUFDbEMsSUFBSSxLQUFLLENBQUMsT0FBTyxLQUFLLFNBQVMsSUFBSSxLQUFLLENBQUMsT0FBTyxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQy9ELE9BQU87WUFDTCxHQUFHLEVBQUUsS0FBSyxDQUFDLE9BQU87WUFDbEIsR0FBRyxFQUFFLEtBQUssQ0FBQyxPQUFPO1lBQ2xCLElBQUksRUFBRSxLQUFLLENBQUMsUUFBUTtZQUNwQixNQUFNLEVBQUUsZUFBZTtZQUN2QixJQUFJLEVBQUUsS0FBSyxDQUFDLGNBQWM7U0FDM0IsQ0FBQztJQUNKLENBQUM7SUFFRCw4QkFBOEI7SUFDOUIsSUFBSSxLQUFLLENBQUMsU0FBUyxLQUFLLFNBQVMsSUFBSSxLQUFLLENBQUMsU0FBUyxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQ25FLE9BQU87WUFDTCxHQUFHLEVBQUUsS0FBSyxDQUFDLFNBQVM7WUFDcEIsR0FBRyxFQUFFLEtBQUssQ0FBQyxTQUFTO1lBQ3BCLElBQUksRUFBRSxLQUFLLENBQUMsVUFBVTtZQUN0QixNQUFNLEVBQUUsT0FBTztZQUNmLElBQUksRUFBRSxLQUFLLENBQUMsY0FBYztTQUMzQixDQUFDO0lBQ0osQ0FBQztJQUVELE9BQU8sU0FBUyxDQUFDO0FBQ25CLENBQUM7QUFxREQsS0FBSyxVQUFVLGNBQWMsQ0FBQyxLQUFvQixFQUFFLFFBQWdCO0lBQ2xFLE1BQU0sU0FBUyxHQUFHLEtBQUssQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDLENBQUMsMEJBQTBCO0lBQ3BFLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLElBQUksQ0FBQyxHQUFHLFdBQVcsQ0FBQztJQUV4RCxNQUFNLE1BQU0sR0FBd0I7UUFDbEMsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVO1FBQzVCLFNBQVM7UUFDVCxHQUFHO1FBQ0gsU0FBUyxFQUFFLFFBQVE7UUFDbkIsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVO1FBQzVCLG9CQUFvQixFQUFFLEdBQUcsUUFBUSxJQUFJLFNBQVMsRUFBRTtRQUNoRCxhQUFhLEVBQUUsS0FBSyxDQUFDLGFBQWEsSUFBSSxTQUFTO1FBQy9DLEtBQUssRUFBRSxLQUFLLENBQUMsS0FBSyxJQUFJLFNBQVM7S0FDaEMsQ0FBQztJQUVGLElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDbEMsTUFBTSxDQUFDLFdBQVcsR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQztJQUN2QyxDQUFDO0lBQ0QsSUFBSSxLQUFLLENBQUMsSUFBSSxDQUFDLFFBQVEsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUN0QyxNQUFNLENBQUMsUUFBUSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDO0lBQ3hDLENBQUM7SUFDRCxJQUFJLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUSxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQ3RDLE1BQU0sQ0FBQyxRQUFRLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUM7SUFDeEMsQ0FBQztJQUNELDREQUE0RDtJQUM1RCwrREFBK0Q7SUFDL0QsSUFBSSxLQUFLLENBQUMsSUFBSSxDQUFDLE1BQU0sS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUNwQyxNQUFNLENBQUMsTUFBTSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDO0lBQ3BDLENBQUM7SUFFRCxJQUFJLEtBQUssQ0FBQyxRQUFRLEVBQUUsR0FBRyxLQUFLLFNBQVMsSUFBSSxLQUFLLENBQUMsUUFBUSxFQUFFLEdBQUcsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUMzRSxNQUFNLENBQUMsUUFBUSxHQUFHLEtBQUssQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDO1FBQ3JDLE1BQU0sQ0FBQyxTQUFTLEdBQUcsS0FBSyxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUM7UUFDdEMsTUFBTSxDQUFDLGVBQWUsR0FBRyxLQUFLLENBQUMsUUFBUSxDQUFDLE1BQU0sSUFBSSxLQUFLLENBQUM7SUFDMUQsQ0FBQztJQUVELE1BQU0sT0FBTyxHQUFHLElBQUkseUJBQVUsQ0FBQztRQUM3QixTQUFTLEVBQUUsZUFBZTtRQUMxQixJQUFJLEVBQUUsTUFBTTtLQUNiLENBQUMsQ0FBQztJQUVILE1BQU0sU0FBUyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUM5QixPQUFPLENBQUMsR0FBRyxDQUFDLDhCQUE4QixLQUFLLENBQUMsVUFBVSxFQUFFLENBQUMsQ0FBQztBQUNoRSxDQUFDO0FBRUQsS0FBSyxVQUFVLG1CQUFtQixDQUFDLEtBQW9CO0lBQ3JELE1BQU0sU0FBUyxHQUFHLEtBQUssQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDO0lBQ3pDLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLElBQUksQ0FBQyxHQUFHLFdBQVcsQ0FBQztJQUV4RCxNQUFNLE1BQU0sR0FBd0I7UUFDbEMsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVO1FBQzVCLFNBQVM7UUFDVCxHQUFHO1FBQ0gsU0FBUyxFQUFFLE9BQU87UUFDbEIsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVO1FBQzVCLG9CQUFvQixFQUFFLFNBQVMsU0FBUyxFQUFFO1FBQzFDLGFBQWEsRUFBRSxLQUFLLENBQUMsYUFBYSxJQUFJLFNBQVM7UUFDL0MsS0FBSyxFQUFFLEtBQUssQ0FBQyxLQUFLLElBQUksU0FBUztLQUNoQyxDQUFDO0lBRUYsSUFBSSxLQUFLLENBQUMsSUFBSSxDQUFDLE9BQU8sS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUNyQyxNQUFNLENBQUMsWUFBWSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDO0lBQzNDLENBQUM7SUFDRCxJQUFJLEtBQUssQ0FBQyxJQUFJLENBQUMsY0FBYyxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQzVDLE1BQU0sQ0FBQyxjQUFjLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxjQUFjLENBQUM7SUFDcEQsQ0FBQztJQUVELElBQUksTUFBTSxDQUFDLFlBQVksS0FBSyxTQUFTO1FBQ2pDLE1BQU0sQ0FBQyxjQUFjLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDeEMsTUFBTSxPQUFPLEdBQUcsSUFBSSx5QkFBVSxDQUFDO1lBQzdCLFNBQVMsRUFBRSxlQUFlO1lBQzFCLElBQUksRUFBRSxNQUFNO1NBQ2IsQ0FBQyxDQUFDO1FBRUgsTUFBTSxTQUFTLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQzlCLE9BQU8sQ0FBQyxHQUFHLENBQUMsb0NBQW9DLEtBQUssQ0FBQyxVQUFVLEVBQUUsQ0FBQyxDQUFDO0lBQ3RFLENBQUM7U0FBTSxDQUFDO1FBQ04sT0FBTyxDQUFDLEdBQUcsQ0FBQyw2Q0FBNkMsQ0FBQyxDQUFDO0lBQzdELENBQUM7QUFDSCxDQUFDO0FBRUQsS0FBSyxVQUFVLGdCQUFnQixDQUFDLEtBQW9CO0lBQ2xELE1BQU0sU0FBUyxHQUFHLEtBQUssQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDLENBQUMsMEJBQTBCO0lBQ3BFLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLElBQUksQ0FBQyxHQUFHLFdBQVcsQ0FBQztJQUV4RCxNQUFNLE1BQU0sR0FBd0I7UUFDbEMsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVO1FBQzVCLFNBQVM7UUFDVCxHQUFHO1FBQ0gsU0FBUyxFQUFFLFFBQVE7UUFDbkIsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVO1FBQzVCLG9CQUFvQixFQUFFLFVBQVUsU0FBUyxFQUFFO1FBQzNDLGFBQWEsRUFBRSxLQUFLLENBQUMsYUFBYSxJQUFJLFNBQVM7UUFDL0MsS0FBSyxFQUFFLEtBQUssQ0FBQyxLQUFLLElBQUksU0FBUztLQUNoQyxDQUFDO0lBRUYsMEJBQTBCO0lBQzFCLElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxNQUFNLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDcEMsTUFBTSxDQUFDLE1BQU0sR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQztJQUNwQyxDQUFDO0lBQ0QsSUFBSSxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUNsQyxNQUFNLENBQUMsSUFBSSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDO0lBQ2hDLENBQUM7SUFDRCxJQUFJLEtBQUssQ0FBQyxJQUFJLENBQUMsT0FBTyxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQ3JDLE1BQU0sQ0FBQyxPQUFPLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUM7SUFDdEMsQ0FBQztJQUNELElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxZQUFZLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDMUMsTUFBTSxDQUFDLFlBQVksR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQztJQUNoRCxDQUFDO0lBQ0QsSUFBSSxLQUFLLENBQUMsSUFBSSxDQUFDLGNBQWMsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUM1QyxNQUFNLENBQUMsY0FBYyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsY0FBYyxDQUFDO0lBQ3BELENBQUM7SUFFRCw0QkFBNEI7SUFDNUIsSUFBSSxLQUFLLENBQUMsUUFBUSxFQUFFLEdBQUcsS0FBSyxTQUFTLElBQUksS0FBSyxDQUFDLFFBQVEsRUFBRSxHQUFHLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDM0UsTUFBTSxDQUFDLFFBQVEsR0FBRyxLQUFLLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQztRQUNyQyxNQUFNLENBQUMsU0FBUyxHQUFHLEtBQUssQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDO1FBQ3RDLE1BQU0sQ0FBQyxlQUFlLEdBQUcsS0FBSyxDQUFDLFFBQVEsQ0FBQyxNQUFNLElBQUksT0FBTyxDQUFDO0lBQzVELENBQUM7SUFFRCxNQUFNLE9BQU8sR0FBRyxJQUFJLHlCQUFVLENBQUM7UUFDN0IsU0FBUyxFQUFFLGVBQWU7UUFDMUIsSUFBSSxFQUFFLE1BQU07S0FDYixDQUFDLENBQUM7SUFFSCxNQUFNLFNBQVMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDOUIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxpQ0FBaUMsS0FBSyxDQUFDLFVBQVUsS0FBSyxLQUFLLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUM7QUFDekYsQ0FBQztBQUVELEtBQUssVUFBVSxrQkFBa0IsQ0FBQyxLQUFvQjtJQUNwRCxJQUFJLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEdBQUcsRUFBRSxDQUFDO1FBQ2pELE9BQU8sQ0FBQyxHQUFHLENBQUMscUNBQXFDLENBQUMsQ0FBQztRQUNuRCxPQUFPO0lBQ1QsQ0FBQztJQUVELE1BQU0sU0FBUyxHQUFHLEtBQUssQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDLENBQUMsMEJBQTBCO0lBQ3BFLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLElBQUksQ0FBQyxHQUFHLFdBQVcsQ0FBQztJQUV4RCxNQUFNLE1BQU0sR0FBd0I7UUFDbEMsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVO1FBQzVCLFNBQVM7UUFDVCxHQUFHO1FBQ0gsU0FBUyxFQUFFLFdBQVcsRUFBRSxvREFBb0Q7UUFDNUUsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVO1FBQzVCLG9CQUFvQixFQUFFLGFBQWEsU0FBUyxFQUFFO1FBQzlDLGFBQWEsRUFBRSxLQUFLLENBQUMsYUFBYSxJQUFJLFNBQVM7UUFDL0MsS0FBSyxFQUFFLEtBQUssQ0FBQyxLQUFLLElBQUksU0FBUztRQUMvQixRQUFRLEVBQUUsS0FBSyxDQUFDLFFBQVEsQ0FBQyxHQUFHO1FBQzVCLFNBQVMsRUFBRSxLQUFLLENBQUMsUUFBUSxDQUFDLEdBQUc7UUFDN0IsZUFBZSxFQUFFLEtBQUssQ0FBQyxRQUFRLENBQUMsTUFBTSxJQUFJLGVBQWU7S0FDMUQsQ0FBQztJQUVGLE1BQU0sT0FBTyxHQUFHLElBQUkseUJBQVUsQ0FBQztRQUM3QixTQUFTLEVBQUUsZUFBZTtRQUMxQixJQUFJLEVBQUUsTUFBTTtLQUNiLENBQUMsQ0FBQztJQUVILE1BQU0sU0FBUyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUM5QixPQUFPLENBQUMsR0FBRyxDQUFDLDRCQUE0QixLQUFLLENBQUMsVUFBVSxLQUFLLEtBQUssQ0FBQyxRQUFRLENBQUMsTUFBTSxLQUFLLEtBQUssQ0FBQyxRQUFRLENBQUMsR0FBRyxLQUFLLEtBQUssQ0FBQyxRQUFRLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQztBQUN2SSxDQUFDO0FBRUQsS0FBSyxVQUFVLG9CQUFvQixDQUFDLEtBQW9CO0lBQ3RELE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUV2QixNQUFNLGlCQUFpQixHQUFhLEVBQUUsQ0FBQztJQUN2QyxNQUFNLHdCQUF3QixHQUEyQixFQUFFLENBQUM7SUFDNUQsTUFBTSx5QkFBeUIsR0FBd0IsRUFBRSxDQUFDO0lBRTFELGlCQUFpQixDQUFDLElBQUksQ0FBQyx5QkFBeUIsQ0FBQyxDQUFDO0lBQ2xELHdCQUF3QixDQUFDLFlBQVksQ0FBQyxHQUFHLFdBQVcsQ0FBQztJQUNyRCx5QkFBeUIsQ0FBQyxZQUFZLENBQUMsR0FBRyxHQUFHLENBQUM7SUFFOUMsaUJBQWlCLENBQUMsSUFBSSxDQUFDLDJCQUEyQixDQUFDLENBQUM7SUFDcEQsd0JBQXdCLENBQUMsYUFBYSxDQUFDLEdBQUcsWUFBWSxDQUFDO0lBQ3ZELHlCQUF5QixDQUFDLGFBQWEsQ0FBQyxHQUFHLEdBQUcsQ0FBQztJQUUvQyxpQkFBaUIsQ0FBQyxJQUFJLENBQUMsbUJBQW1CLENBQUMsQ0FBQztJQUM1Qyx3QkFBd0IsQ0FBQyxTQUFTLENBQUMsR0FBRyxRQUFRLENBQUM7SUFDL0MseUJBQXlCLENBQUMsU0FBUyxDQUFDLEdBQUcsUUFBUSxDQUFDO0lBRWhELElBQUksS0FBSyxDQUFDLGFBQWEsRUFBRSxDQUFDO1FBQ3hCLGlCQUFpQixDQUFDLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUNwQyx3QkFBd0IsQ0FBQyxLQUFLLENBQUMsR0FBRyxlQUFlLENBQUM7UUFDbEQseUJBQXlCLENBQUMsS0FBSyxDQUFDLEdBQUcsS0FBSyxDQUFDLGFBQWEsQ0FBQztJQUN6RCxDQUFDO0lBRUQsSUFBSSxLQUFLLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDaEIsaUJBQWlCLENBQUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLENBQUM7UUFDMUMsd0JBQXdCLENBQUMsUUFBUSxDQUFDLEdBQUcsT0FBTyxDQUFDO1FBQzdDLHlCQUF5QixDQUFDLFFBQVEsQ0FBQyxHQUFHLEtBQUssQ0FBQyxLQUFLLENBQUM7SUFDcEQsQ0FBQztJQUVELElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUNwQixpQkFBaUIsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLENBQUM7UUFDeEMsd0JBQXdCLENBQUMsT0FBTyxDQUFDLEdBQUcsY0FBYyxDQUFDO1FBQ25ELHlCQUF5QixDQUFDLE9BQU8sQ0FBQyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDO0lBQ3ZELENBQUM7SUFFRCx5RUFBeUU7SUFDekUsMERBQTBEO0lBQzFELElBQUksS0FBSyxDQUFDLFVBQVUsS0FBSyxVQUFVLEVBQUUsQ0FBQztRQUNwQyxpQkFBaUIsQ0FBQyxJQUFJLENBQUMsbUNBQW1DLENBQUMsQ0FBQztRQUM1RCx3QkFBd0IsQ0FBQyxpQkFBaUIsQ0FBQyxHQUFHLGdCQUFnQixDQUFDO1FBQy9ELHlCQUF5QixDQUFDLGlCQUFpQixDQUFDLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxjQUFjLEtBQUssSUFBSSxDQUFDO1FBRWxGLGlCQUFpQixDQUFDLElBQUksQ0FBQyw2QkFBNkIsQ0FBQyxDQUFDO1FBQ3RELHdCQUF3QixDQUFDLGNBQWMsQ0FBQyxHQUFHLGFBQWEsQ0FBQztRQUN6RCx5QkFBeUIsQ0FBQyxjQUFjLENBQUMsR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLFdBQVcsS0FBSyxJQUFJLENBQUM7SUFDOUUsQ0FBQztJQUVELElBQUksS0FBSyxDQUFDLFFBQVEsRUFBRSxHQUFHLEtBQUssU0FBUyxJQUFJLEtBQUssQ0FBQyxRQUFRLEVBQUUsR0FBRyxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQzNFLGlCQUFpQixDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUN0Qyx3QkFBd0IsQ0FBQyxNQUFNLENBQUMsR0FBRyxlQUFlLENBQUM7UUFDbkQseUJBQXlCLENBQUMsTUFBTSxDQUFDLEdBQUc7WUFDbEMsR0FBRyxFQUFFLEtBQUssQ0FBQyxRQUFRLENBQUMsR0FBRztZQUN2QixHQUFHLEVBQUUsS0FBSyxDQUFDLFFBQVEsQ0FBQyxHQUFHO1lBQ3ZCLElBQUksRUFBRSxLQUFLLENBQUMsUUFBUSxDQUFDLElBQUksSUFBSSxLQUFLLENBQUMsU0FBUztZQUM1QyxNQUFNLEVBQUUsS0FBSyxDQUFDLFFBQVEsQ0FBQyxNQUFNLElBQUksS0FBSztZQUN0QyxJQUFJLEVBQUUsS0FBSyxDQUFDLFFBQVEsQ0FBQyxJQUFJO1NBQzFCLENBQUM7SUFDSixDQUFDO0lBRUQsSUFBSSxLQUFLLENBQUMsVUFBVSxLQUFLLFVBQVUsRUFBRSxDQUFDO1FBQ3BDLGlCQUFpQixDQUFDLElBQUksQ0FBQyx5QkFBeUIsQ0FBQyxDQUFDO1FBQ2xELHdCQUF3QixDQUFDLFlBQVksQ0FBQyxHQUFHLGdCQUFnQixDQUFDO1FBQzFELHlCQUF5QixDQUFDLFlBQVksQ0FBQyxHQUFHO1lBQ3hDLElBQUksRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUk7WUFDckIsUUFBUSxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUTtZQUM3QixRQUFRLEVBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxRQUFRO1lBQzdCLHdGQUF3RjtZQUN4RixNQUFNLEVBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxNQUFNO1lBQ3pCLFNBQVMsRUFBRSxLQUFLLENBQUMsU0FBUztTQUMzQixDQUFDO0lBQ0osQ0FBQztJQUVELElBQUksS0FBSyxDQUFDLFVBQVUsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUNuQyxpQkFBaUIsQ0FBQyxJQUFJLENBQUMsaUJBQWlCLENBQUMsQ0FBQztRQUMxQyx3QkFBd0IsQ0FBQyxRQUFRLENBQUMsR0FBRyxZQUFZLENBQUM7UUFDbEQseUJBQXlCLENBQUMsUUFBUSxDQUFDLEdBQUc7WUFDcEMsT0FBTyxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsT0FBTztZQUMzQixXQUFXLEVBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxXQUFXO1lBQ25DLGNBQWMsRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLGNBQWM7WUFDekMsU0FBUyxFQUFFLEtBQUssQ0FBQyxTQUFTO1NBQzNCLENBQUM7UUFDRixtREFBbUQ7UUFDbkQsSUFBSSxLQUFLLENBQUMsSUFBSSxDQUFDLE9BQU8sS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUNyQyxpQkFBaUIsQ0FBQyxJQUFJLENBQUMscUJBQXFCLENBQUMsQ0FBQztZQUM5Qyx3QkFBd0IsQ0FBQyxVQUFVLENBQUMsR0FBRyxTQUFTLENBQUM7WUFDakQseUJBQXlCLENBQUMsVUFBVSxDQUFDLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUM7UUFDN0QsQ0FBQztJQUNILENBQUM7SUFFRCxtREFBbUQ7SUFDbkQsSUFBSSxLQUFLLENBQUMsT0FBTyxFQUFFLGdCQUFnQixFQUFFLENBQUM7UUFDcEMsaUJBQWlCLENBQUMsSUFBSSxDQUFDLDJCQUEyQixDQUFDLENBQUM7UUFDcEQsd0JBQXdCLENBQUMsYUFBYSxDQUFDLEdBQUcsa0JBQWtCLENBQUM7UUFDN0QseUJBQXlCLENBQUMsYUFBYSxDQUFDLEdBQUcsS0FBSyxDQUFDLE9BQU8sQ0FBQyxnQkFBZ0IsQ0FBQztJQUM1RSxDQUFDO0lBRUQsSUFBSSxLQUFLLENBQUMsT0FBTyxFQUFFLGdCQUFnQixFQUFFLENBQUM7UUFDcEMsaUJBQWlCLENBQUMsSUFBSSxDQUFDLDJCQUEyQixDQUFDLENBQUM7UUFDcEQsd0JBQXdCLENBQUMsYUFBYSxDQUFDLEdBQUcsa0JBQWtCLENBQUM7UUFDN0QseUJBQXlCLENBQUMsYUFBYSxDQUFDLEdBQUcsS0FBSyxDQUFDLE9BQU8sQ0FBQyxnQkFBZ0IsQ0FBQztJQUM1RSxDQUFDO0lBRUQsSUFBSSxLQUFLLENBQUMsT0FBTyxFQUFFLFlBQVksRUFBRSxDQUFDO1FBQ2hDLGlCQUFpQixDQUFDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDO1FBQzVDLHdCQUF3QixDQUFDLFNBQVMsQ0FBQyxHQUFHLGNBQWMsQ0FBQztRQUNyRCx5QkFBeUIsQ0FBQyxTQUFTLENBQUMsR0FBRyxLQUFLLENBQUMsT0FBTyxDQUFDLFlBQVksQ0FBQztJQUNwRSxDQUFDO0lBRUQsa0RBQWtEO0lBQ2xELElBQUksS0FBSyxDQUFDLE9BQU8sRUFBRSxXQUFXLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDN0MsaUJBQWlCLENBQUMsSUFBSSxDQUFDLDZCQUE2QixDQUFDLENBQUM7UUFDdEQsd0JBQXdCLENBQUMsY0FBYyxDQUFDLEdBQUcsYUFBYSxDQUFDO1FBQ3pELHlCQUF5QixDQUFDLGNBQWMsQ0FBQyxHQUFHLEtBQUssQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDO0lBQ3hFLENBQUM7SUFFRCw2REFBNkQ7SUFDN0QscUZBQXFGO0lBQ3JGLElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxZQUFZLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDMUMsaUJBQWlCLENBQUMsSUFBSSxDQUFDLDZCQUE2QixDQUFDLENBQUM7UUFDdEQsd0JBQXdCLENBQUMsY0FBYyxDQUFDLEdBQUcsYUFBYSxDQUFDO1FBQ3pELHlCQUF5QixDQUFDLGNBQWMsQ0FBQyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsWUFBWSxLQUFLLEtBQUssQ0FBQztJQUNoRixDQUFDO0lBRUQscUZBQXFGO0lBQ3JGLDJFQUEyRTtJQUMzRSxJQUFJLEtBQUssQ0FBQyxVQUFVLEtBQUssWUFBWSxJQUFJLEtBQUssQ0FBQyxJQUFJLENBQUMsT0FBTyxLQUFLLFNBQVMsSUFBSSxDQUFDLHlCQUF5QixDQUFDLFVBQVUsQ0FBQyxFQUFFLENBQUM7UUFDcEgsaUJBQWlCLENBQUMsSUFBSSxDQUFDLHFCQUFxQixDQUFDLENBQUM7UUFDOUMsd0JBQXdCLENBQUMsVUFBVSxDQUFDLEdBQUcsU0FBUyxDQUFDO1FBQ2pELHlCQUF5QixDQUFDLFVBQVUsQ0FBQyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDO0lBQzdELENBQUM7SUFFRCxpQkFBaUIsQ0FBQyxJQUFJLENBQUMsdURBQXVELENBQUMsQ0FBQztJQUNoRix3QkFBd0IsQ0FBQyxhQUFhLENBQUMsR0FBRyxZQUFZLENBQUM7SUFDdkQseUJBQXlCLENBQUMsYUFBYSxDQUFDLEdBQUcsR0FBRyxDQUFDO0lBRS9DLE1BQU0sT0FBTyxHQUFHLElBQUksNEJBQWEsQ0FBQztRQUNoQyxTQUFTLEVBQUUsYUFBYTtRQUN4QixHQUFHLEVBQUUsRUFBRSxVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVUsRUFBRTtRQUNyQyxnQkFBZ0IsRUFBRSxNQUFNLEdBQUcsaUJBQWlCLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQztRQUN2RCx3QkFBd0IsRUFBRSx3QkFBd0I7UUFDbEQseUJBQXlCLEVBQUUseUJBQXlCO0tBQ3JELENBQUMsQ0FBQztJQUVILE1BQU0sU0FBUyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUM5QixPQUFPLENBQUMsR0FBRyxDQUFDLCtCQUErQixLQUFLLENBQUMsVUFBVSxFQUFFLENBQUMsQ0FBQztBQUNqRSxDQUFDO0FBRUQsS0FBSyxVQUFVLGlCQUFpQixDQUFDLEtBQW9CO0lBQ25ELE1BQU0sS0FBSyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDO0lBQ2hDLElBQUksQ0FBQyxLQUFLLEVBQUUsQ0FBQztRQUNYLE9BQU8sQ0FBQyxHQUFHLENBQUMsc0NBQXNDLENBQUMsQ0FBQztRQUNwRCxPQUFPO0lBQ1QsQ0FBQztJQUVELE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUV2QixNQUFNLE9BQU8sR0FBRyxJQUFJLDRCQUFhLENBQUM7UUFDaEMsU0FBUyxFQUFFLGNBQWM7UUFDekIsR0FBRyxFQUFFO1lBQ0gsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVO1lBQzVCLFVBQVUsRUFBRSxLQUFLO1NBQ2xCO1FBQ0QsZ0JBQWdCLEVBQUUsb0dBQW9HO1FBQ3RILHdCQUF3QixFQUFFO1lBQ3hCLFNBQVMsRUFBRSxRQUFRO1lBQ25CLFVBQVUsRUFBRSxTQUFTO1lBQ3JCLGNBQWMsRUFBRSxhQUFhO1lBQzdCLGFBQWEsRUFBRSxZQUFZO1NBQzVCO1FBQ0QseUJBQXlCLEVBQUU7WUFDekIsU0FBUyxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsTUFBTSxJQUFJLFNBQVM7WUFDekMsVUFBVSxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsT0FBTyxJQUFJLEVBQUU7WUFDcEMsY0FBYyxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQUc7WUFDNUUsYUFBYSxFQUFFLEdBQUc7U0FDbkI7S0FDRixDQUFDLENBQUM7SUFFSCxNQUFNLFNBQVMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDOUIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxtQkFBbUIsS0FBSyxpQkFBaUIsS0FBSyxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO0FBQzVFLENBQUM7QUFFRCxLQUFLLFVBQVUsVUFBVSxDQUFDLEtBQW9CO0lBQzVDLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUN2QixNQUFNLEdBQUcsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsR0FBRyxJQUFJLENBQUMsR0FBRyxXQUFXLENBQUM7SUFFakQsNkJBQTZCO0lBQzdCLE1BQU0sT0FBTyxHQUFHLFNBQVMsS0FBSyxDQUFDLFVBQVUsSUFBSSxHQUFHLElBQUksSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztJQUU5RixNQUFNLFdBQVcsR0FBRztRQUNsQixRQUFRLEVBQUUsT0FBTztRQUNqQixVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVU7UUFDNUIsYUFBYSxFQUFFLEtBQUssQ0FBQyxhQUFhLElBQUksU0FBUztRQUMvQyxLQUFLLEVBQUUsS0FBSyxDQUFDLEtBQUssSUFBSSxTQUFTO1FBQy9CLElBQUksRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksSUFBSSxTQUFTO1FBQ2xDLEtBQUssRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUs7UUFDdkIsU0FBUyxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsU0FBUztRQUMvQixPQUFPLEVBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxPQUFPLElBQUksRUFBRTtRQUNqQyxVQUFVLEVBQUUsR0FBRztRQUNmLGVBQWUsRUFBRSxLQUFLLENBQUMsU0FBUyxHQUFHLElBQUk7UUFDdkMsWUFBWSxFQUFFLE9BQU8sRUFBRSwrQkFBK0I7UUFDdEQsR0FBRztRQUNILFFBQVEsRUFBRSxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQztZQUN6QixHQUFHLEVBQUUsS0FBSyxDQUFDLFFBQVEsQ0FBQyxHQUFHO1lBQ3ZCLEdBQUcsRUFBRSxLQUFLLENBQUMsUUFBUSxDQUFDLEdBQUc7U0FDeEIsQ0FBQyxDQUFDLENBQUMsU0FBUztLQUNkLENBQUM7SUFFRixNQUFNLE9BQU8sR0FBRyxJQUFJLHlCQUFVLENBQUM7UUFDN0IsU0FBUyxFQUFFLFlBQVk7UUFDdkIsSUFBSSxFQUFFLFdBQVc7S0FDbEIsQ0FBQyxDQUFDO0lBRUgsTUFBTSxTQUFTLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQzlCLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0JBQWdCLE9BQU8sUUFBUSxLQUFLLENBQUMsVUFBVSxFQUFFLENBQUMsQ0FBQztBQUNqRSxDQUFDO0FBRUQsS0FBSyxVQUFVLFlBQVksQ0FBQyxLQUFvQjtJQUM5QyxNQUFNLFlBQVksR0FBRztRQUNuQixVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVU7UUFDNUIsYUFBYSxFQUFFLEtBQUssQ0FBQyxhQUFhO1FBQ2xDLEtBQUssRUFBRSxLQUFLLENBQUMsS0FBSztRQUNsQixVQUFVLEVBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJO1FBQzNCLEtBQUssRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUs7UUFDdkIsU0FBUyxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsU0FBUztRQUMvQixPQUFPLEVBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxPQUFPO1FBQzNCLFNBQVMsRUFBRSxLQUFLLENBQUMsU0FBUztRQUMxQixRQUFRLEVBQUUsS0FBSyxDQUFDLFFBQVE7S0FDekIsQ0FBQztJQUVGLE1BQU0sT0FBTyxHQUFHLElBQUksMkJBQWMsQ0FBQztRQUNqQyxRQUFRLEVBQUUsZUFBZTtRQUN6QixPQUFPLEVBQUUsbUJBQW1CLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxNQUFNLEtBQUssQ0FBQyxhQUFhLElBQUksS0FBSyxDQUFDLFVBQVUsRUFBRTtRQUMxRixPQUFPLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxZQUFZLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztRQUM5QyxpQkFBaUIsRUFBRTtZQUNqQixVQUFVLEVBQUU7Z0JBQ1YsUUFBUSxFQUFFLFFBQVE7Z0JBQ2xCLFdBQVcsRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksSUFBSSxTQUFTO2FBQzFDO1lBQ0QsVUFBVSxFQUFFO2dCQUNWLFFBQVEsRUFBRSxRQUFRO2dCQUNsQixXQUFXLEVBQUUsS0FBSyxDQUFDLFVBQVU7YUFDOUI7WUFDRCxLQUFLLEVBQUU7Z0JBQ0wsUUFBUSxFQUFFLFFBQVE7Z0JBQ2xCLFdBQVcsRUFBRSxLQUFLLENBQUMsS0FBSyxJQUFJLFNBQVM7YUFDdEM7U0FDRjtLQUNGLENBQUMsQ0FBQztJQUVILE1BQU0sU0FBUyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUM5QixPQUFPLENBQUMsR0FBRyxDQUFDLDJCQUEyQixLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUM7QUFDNUQsQ0FBQztBQUVEOzs7R0FHRztBQUNILEtBQUssVUFBVSxrQkFBa0IsQ0FBQyxLQUFvQjtJQUNwRCxJQUFJLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEdBQUcsRUFBRSxDQUFDO1FBQ2pELE9BQU8sQ0FBQyxHQUFHLENBQUMsK0NBQStDLENBQUMsQ0FBQztRQUM3RCxPQUFPO0lBQ1QsQ0FBQztJQUVELE1BQU0sU0FBUyxHQUFHLEtBQUssQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDLENBQUMsMEJBQTBCO0lBQ3BFLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLElBQUksQ0FBQyxHQUFHLFdBQVcsQ0FBQztJQUV4RCxNQUFNLE1BQU0sR0FBd0I7UUFDbEMsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVO1FBQzVCLFNBQVM7UUFDVCxHQUFHO1FBQ0gsU0FBUyxFQUFFLFVBQVU7UUFDckIsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVO1FBQzVCLG9CQUFvQixFQUFFLFlBQVksU0FBUyxFQUFFO1FBQzdDLGFBQWEsRUFBRSxLQUFLLENBQUMsYUFBYSxJQUFJLFNBQVM7UUFDL0MsS0FBSyxFQUFFLEtBQUssQ0FBQyxLQUFLLElBQUksU0FBUztRQUMvQixRQUFRLEVBQUUsS0FBSyxDQUFDLFFBQVEsQ0FBQyxHQUFHO1FBQzVCLFNBQVMsRUFBRSxLQUFLLENBQUMsUUFBUSxDQUFDLEdBQUc7UUFDN0IsZUFBZSxFQUFFLEtBQUssQ0FBQyxRQUFRLENBQUMsTUFBTSxJQUFJLEtBQUs7S0FDaEQsQ0FBQztJQUVGLCtCQUErQjtJQUMvQixJQUFJLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUSxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQ3RDLE1BQU0sQ0FBQyxRQUFRLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUM7SUFDeEMsQ0FBQztJQUNELElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxPQUFPLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDckMsTUFBTSxDQUFDLE9BQU8sR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQztJQUN0QyxDQUFDO0lBQ0QsSUFBSSxLQUFLLENBQUMsSUFBSSxDQUFDLFFBQVEsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUN0QyxNQUFNLENBQUMsUUFBUSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDO0lBQ3hDLENBQUM7SUFDRCxJQUFJLEtBQUssQ0FBQyxJQUFJLENBQUMsT0FBTyxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQ3JDLE1BQU0sQ0FBQyxPQUFPLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUM7SUFDdEMsQ0FBQztJQUNELElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDakMsTUFBTSxDQUFDLEdBQUcsR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQztJQUM5QixDQUFDO0lBQ0QsSUFBSSxLQUFLLENBQUMsSUFBSSxDQUFDLE9BQU8sS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUNyQyxNQUFNLENBQUMsVUFBVSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDO0lBQ3pDLENBQUM7SUFDRCxJQUFJLEtBQUssQ0FBQyxJQUFJLENBQUMsTUFBTSxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQ3BDLE1BQU0sQ0FBQyxNQUFNLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUM7SUFDcEMsQ0FBQztJQUNELElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxNQUFNLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDcEMsTUFBTSxDQUFDLE1BQU0sR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQztJQUNwQyxDQUFDO0lBRUQsTUFBTSxPQUFPLEdBQUcsSUFBSSx5QkFBVSxDQUFDO1FBQzdCLFNBQVMsRUFBRSxlQUFlO1FBQzFCLElBQUksRUFBRSxNQUFNO0tBQ2IsQ0FBQyxDQUFDO0lBRUgsTUFBTSxTQUFTLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQzlCLE9BQU8sQ0FBQyxHQUFHLENBQUMsNEJBQTRCLEtBQUssQ0FBQyxVQUFVLGNBQWMsS0FBSyxDQUFDLElBQUksQ0FBQyxPQUFPLGFBQWEsS0FBSyxDQUFDLElBQUksQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDO0FBQzdILENBQUM7QUFFRDs7Ozs7R0FLRztBQUNILEtBQUssVUFBVSxhQUFhLENBQUMsS0FBb0I7SUFDL0MsTUFBTSxTQUFTLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUM7SUFDckMsTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUM7SUFFakMsSUFBSSxDQUFDLFNBQVMsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQzFCLE9BQU8sQ0FBQyxHQUFHLENBQUMsdUVBQXVFLENBQUMsQ0FBQztRQUNyRixPQUFPO0lBQ1QsQ0FBQztJQUVELE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUN2QixNQUFNLEdBQUcsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUUsR0FBRyxJQUFJLENBQUMsR0FBRyxXQUFXLENBQUM7SUFDeEQsTUFBTSxXQUFXLEdBQUcsS0FBSyxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUM7SUFFM0Msa0ZBQWtGO0lBQ2xGLElBQUksTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQ2pCLE1BQU0sNEJBQTRCLENBQUMsS0FBSyxDQUFDLFVBQVUsRUFBRSxTQUFTLENBQUMsQ0FBQztJQUNsRSxDQUFDO0lBRUQsZ0NBQWdDO0lBQ2hDLE1BQU0sUUFBUSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUSxJQUFJLENBQUMsQ0FBQztJQUUxQyx3QkFBd0I7SUFDeEIsTUFBTSxPQUFPLEdBQUcsSUFBSSw0QkFBYSxDQUFDO1FBQ2hDLFNBQVMsRUFBRSxjQUFjO1FBQ3pCLEdBQUcsRUFBRTtZQUNILFVBQVUsRUFBRSxLQUFLLENBQUMsVUFBVTtZQUM1QixVQUFVLEVBQUUsU0FBUztTQUN0QjtRQUNELGdCQUFnQixFQUFFOzs7Ozs7OztLQVFqQjtRQUNELHdCQUF3QixFQUFFO1lBQ3hCLFNBQVMsRUFBRSxRQUFRO1lBQ25CLGFBQWEsRUFBRSxZQUFZO1lBQzNCLFdBQVcsRUFBRSxVQUFVO1lBQ3ZCLGNBQWMsRUFBRSxhQUFhO1lBQzdCLGlCQUFpQixFQUFFLGdCQUFnQjtZQUNuQyxNQUFNLEVBQUUsS0FBSztZQUNiLGFBQWEsRUFBRSxZQUFZO1NBQzVCO1FBQ0QseUJBQXlCLEVBQUU7WUFDekIsU0FBUyxFQUFFLFFBQVE7WUFDbkIsYUFBYSxFQUFFLFNBQVMsR0FBRyxJQUFJLEVBQUUsMEJBQTBCO1lBQzNELFdBQVcsRUFBRSxXQUFXO1lBQ3hCLGNBQWMsRUFBRSxNQUFNO1lBQ3RCLFdBQVcsRUFBRSxRQUFRO1lBQ3JCLE9BQU8sRUFBRSxDQUFDO1lBQ1YsTUFBTSxFQUFFLEdBQUc7WUFDWCxhQUFhLEVBQUUsR0FBRztTQUNuQjtLQUNGLENBQUMsQ0FBQztJQUVILE1BQU0sU0FBUyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUM5QixPQUFPLENBQUMsR0FBRyxDQUFDLG9CQUFvQixTQUFTLFFBQVEsS0FBSyxDQUFDLFVBQVUsV0FBVyxNQUFNLEdBQUcsQ0FBQyxDQUFDO0FBQ3pGLENBQUM7QUFFRDs7R0FFRztBQUNILEtBQUssVUFBVSw0QkFBNEIsQ0FBQyxTQUFpQixFQUFFLGdCQUF3QjtJQUNyRixzRUFBc0U7SUFDdEUsTUFBTSxZQUFZLEdBQUcsSUFBSSwyQkFBWSxDQUFDO1FBQ3BDLFNBQVMsRUFBRSxjQUFjO1FBQ3pCLHNCQUFzQixFQUFFLDREQUE0RDtRQUNwRixnQkFBZ0IsRUFBRSxtQkFBbUI7UUFDckMsd0JBQXdCLEVBQUU7WUFDeEIsU0FBUyxFQUFFLFFBQVE7U0FDcEI7UUFDRCx5QkFBeUIsRUFBRTtZQUN6QixhQUFhLEVBQUUsU0FBUztZQUN4QixrQkFBa0IsRUFBRSxnQkFBZ0I7WUFDcEMsU0FBUyxFQUFFLFFBQVE7U0FDcEI7UUFDRCxnQkFBZ0IsRUFBRSxLQUFLLEVBQUUsb0JBQW9CO1FBQzdDLEtBQUssRUFBRSxDQUFDO0tBQ1QsQ0FBQyxDQUFDO0lBRUgsTUFBTSxNQUFNLEdBQUcsTUFBTSxTQUFTLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDO0lBRWxELElBQUksTUFBTSxDQUFDLEtBQUssSUFBSSxNQUFNLENBQUMsS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUM1QyxNQUFNLGVBQWUsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBRXhDLE1BQU0sYUFBYSxHQUFHLElBQUksNEJBQWEsQ0FBQztZQUN0QyxTQUFTLEVBQUUsY0FBYztZQUN6QixHQUFHLEVBQUU7Z0JBQ0gsVUFBVSxFQUFFLFNBQVM7Z0JBQ3JCLFVBQVUsRUFBRSxlQUFlLENBQUMsVUFBVTthQUN2QztZQUNELGdCQUFnQixFQUFFLGtEQUFrRDtZQUNwRSx3QkFBd0IsRUFBRTtnQkFDeEIsU0FBUyxFQUFFLFFBQVE7Z0JBQ25CLGFBQWEsRUFBRSxZQUFZO2FBQzVCO1lBQ0QseUJBQXlCLEVBQUU7Z0JBQ3pCLFNBQVMsRUFBRSxXQUFXO2dCQUN0QixhQUFhLEVBQUUsSUFBSSxDQUFDLEdBQUcsRUFBRTthQUMxQjtTQUNGLENBQUMsQ0FBQztRQUVILE1BQU0sU0FBUyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUNwQyxPQUFPLENBQUMsR0FBRyxDQUFDLGtCQUFrQixlQUFlLENBQUMsVUFBVSxxQkFBcUIsU0FBUyxFQUFFLENBQUMsQ0FBQztJQUM1RixDQUFDO0FBQ0gsQ0FBQztBQUVEOzs7R0FHRztBQUNILEtBQUssVUFBVSxvQkFBb0IsQ0FBQyxLQUFvQjtJQUN0RCxJQUFJLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEdBQUcsRUFBRSxDQUFDO1FBQ2pELE9BQU87SUFDVCxDQUFDO0lBRUQsTUFBTSxTQUFTLEdBQUcsS0FBSyxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUMsQ0FBQywwQkFBMEI7SUFDcEUsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxFQUFFLEdBQUcsSUFBSSxDQUFDLEdBQUcsV0FBVyxDQUFDO0lBRXhELE1BQU0sTUFBTSxHQUF3QjtRQUNsQyxVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVU7UUFDNUIsU0FBUztRQUNULEdBQUc7UUFDSCxRQUFRLEVBQUUsS0FBSyxDQUFDLFFBQVEsQ0FBQyxHQUFHO1FBQzVCLFNBQVMsRUFBRSxLQUFLLENBQUMsUUFBUSxDQUFDLEdBQUc7UUFDN0IsTUFBTSxFQUFFLEtBQUssQ0FBQyxRQUFRLENBQUMsTUFBTSxJQUFJLFNBQVM7UUFDMUMsYUFBYSxFQUFFLEtBQUssQ0FBQyxRQUFRLENBQUMsSUFBSTtRQUNsQyxVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVU7UUFDNUIsYUFBYSxFQUFFLEtBQUssQ0FBQyxhQUFhLElBQUksU0FBUztRQUMvQyxLQUFLLEVBQUUsS0FBSyxDQUFDLEtBQUssSUFBSSxTQUFTO0tBQ2hDLENBQUM7SUFFRiwrQ0FBK0M7SUFDL0MsSUFBSSxLQUFLLENBQUMsVUFBVSxLQUFLLFdBQVcsRUFBRSxDQUFDO1FBQ3JDLElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxPQUFPLEtBQUssU0FBUyxFQUFFLENBQUM7WUFDckMsTUFBTSxDQUFDLFVBQVUsR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQztRQUN6QyxDQUFDO1FBQ0QsSUFBSSxLQUFLLENBQUMsSUFBSSxDQUFDLE1BQU0sS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUNwQyxNQUFNLENBQUMsTUFBTSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDO1FBQ3BDLENBQUM7UUFDRCxJQUFJLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUSxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQ3RDLE1BQU0sQ0FBQyxRQUFRLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUM7UUFDeEMsQ0FBQztRQUNELElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxPQUFPLEtBQUssU0FBUyxFQUFFLENBQUM7WUFDckMsTUFBTSxDQUFDLE9BQU8sR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQztRQUN0QyxDQUFDO1FBQ0QsSUFBSSxLQUFLLENBQUMsSUFBSSxDQUFDLFFBQVEsS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUN0QyxNQUFNLENBQUMsUUFBUSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDO1FBQ3hDLENBQUM7UUFDRCxJQUFJLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQ2pDLE1BQU0sQ0FBQyxHQUFHLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUM7UUFDOUIsQ0FBQztJQUNILENBQUM7SUFFRCxNQUFNLE9BQU8sR0FBRyxJQUFJLHlCQUFVLENBQUM7UUFDN0IsU0FBUyxFQUFFLGVBQWU7UUFDMUIsSUFBSSxFQUFFLE1BQU07S0FDYixDQUFDLENBQUM7SUFFSCxNQUFNLFNBQVMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDOUIsT0FBTyxDQUFDLEdBQUcsQ0FBQyw4QkFBOEIsS0FBSyxDQUFDLFVBQVUsS0FBSyxLQUFLLENBQUMsUUFBUSxDQUFDLE1BQU0sS0FBSyxLQUFLLENBQUMsUUFBUSxDQUFDLEdBQUcsS0FBSyxLQUFLLENBQUMsUUFBUSxDQUFDLEdBQUcsR0FBRyxDQUFDLENBQUM7QUFDekksQ0FBQztBQUVEOzs7R0FHRztBQUNILEtBQUssVUFBVSxrQ0FBa0MsQ0FBQyxTQUFpQixFQUFFLE9BQWU7SUFDbEYsZ0RBQWdEO0lBQ2hELE1BQU0sWUFBWSxHQUFHLElBQUksMkJBQVksQ0FBQztRQUNwQyxTQUFTLEVBQUUsY0FBYztRQUN6QixTQUFTLEVBQUUsY0FBYztRQUN6QixzQkFBc0IsRUFBRSxtQkFBbUI7UUFDM0MsZ0JBQWdCLEVBQUUsMEJBQTBCO1FBQzVDLHdCQUF3QixFQUFFO1lBQ3hCLFNBQVMsRUFBRSxRQUFRO1NBQ3BCO1FBQ0QseUJBQXlCLEVBQUU7WUFDekIsU0FBUyxFQUFFLFFBQVE7WUFDbkIsYUFBYSxFQUFFLFNBQVM7U0FDekI7S0FDRixDQUFDLENBQUM7SUFFSCxJQUFJLENBQUM7UUFDSCxNQUFNLE1BQU0sR0FBRyxNQUFNLFNBQVMsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7UUFFbEQsSUFBSSxNQUFNLENBQUMsS0FBSyxJQUFJLE1BQU0sQ0FBQyxLQUFLLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQzVDLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW1CLE9BQU8saUJBQWlCLE1BQU0sQ0FBQyxLQUFLLENBQUMsTUFBTSwwQkFBMEIsU0FBUyxFQUFFLENBQUMsQ0FBQztZQUVqSCx3Q0FBd0M7WUFDeEMsS0FBSyxNQUFNLE9BQU8sSUFBSSxNQUFNLENBQUMsS0FBSyxFQUFFLENBQUM7Z0JBQ25DLE1BQU0sYUFBYSxHQUFHLElBQUksNEJBQWEsQ0FBQztvQkFDdEMsU0FBUyxFQUFFLGNBQWM7b0JBQ3pCLEdBQUcsRUFBRTt3QkFDSCxVQUFVLEVBQUUsU0FBUzt3QkFDckIsVUFBVSxFQUFFLE9BQU8sQ0FBQyxVQUFVO3FCQUMvQjtvQkFDRCxnQkFBZ0IsRUFBRSxrREFBa0Q7b0JBQ3BFLHdCQUF3QixFQUFFO3dCQUN4QixTQUFTLEVBQUUsUUFBUTt3QkFDbkIsYUFBYSxFQUFFLFlBQVk7cUJBQzVCO29CQUNELHlCQUF5QixFQUFFO3dCQUN6QixTQUFTLEVBQUUsV0FBVzt3QkFDdEIsYUFBYSxFQUFFLElBQUksQ0FBQyxHQUFHLEVBQUU7cUJBQzFCO2lCQUNGLENBQUMsQ0FBQztnQkFFSCxNQUFNLFNBQVMsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLENBQUM7Z0JBQ3BDLE9BQU8sQ0FBQyxHQUFHLENBQUMsa0JBQWtCLE9BQU8sQ0FBQyxVQUFVLHVDQUF1QyxPQUFPLEVBQUUsQ0FBQyxDQUFDO1lBQ3BHLENBQUM7UUFDSCxDQUFDO0lBQ0gsQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDZixzRUFBc0U7UUFDdEUsT0FBTyxDQUFDLEtBQUssQ0FBQyxvREFBb0QsS0FBSyxFQUFFLENBQUMsQ0FBQztJQUM3RSxDQUFDO0FBQ0gsQ0FBQztBQUVEOzs7R0FHRztBQUNILEtBQUssVUFBVSxlQUFlLENBQUMsS0FBb0I7SUFDakQsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDckIsT0FBTyxDQUFDLHFDQUFxQztJQUMvQyxDQUFDO0lBRUQsSUFBSSxDQUFDO1FBQ0gsNkNBQTZDO1FBQzdDLE1BQU0sVUFBVSxHQUFHLElBQUkseUJBQVUsQ0FBQztZQUNoQyxTQUFTLEVBQUUsYUFBYTtZQUN4QixHQUFHLEVBQUUsRUFBRSxVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVUsRUFBRTtZQUNyQyxvQkFBb0IsRUFBRSxjQUFjO1NBQ3JDLENBQUMsQ0FBQztRQUVILE1BQU0sTUFBTSxHQUFHLE1BQU0sU0FBUyxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUNoRCxNQUFNLFlBQVksR0FBRyxNQUFNLENBQUMsSUFBSSxFQUFFLFlBQVksQ0FBQztRQUUvQyw0REFBNEQ7UUFDNUQsSUFBSSxZQUFZLElBQUksWUFBWSxLQUFLLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDckQsTUFBTSxTQUFTLEdBQUcsS0FBSyxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUMsQ0FBQywwQkFBMEI7WUFDcEUsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxFQUFFLEdBQUcsSUFBSSxDQUFDLEdBQUcsV0FBVyxDQUFDO1lBRXhELE1BQU0sTUFBTSxHQUF3QjtnQkFDbEMsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVO2dCQUM1QixTQUFTO2dCQUNULEdBQUc7Z0JBQ0gsU0FBUyxFQUFFLGFBQWE7Z0JBQ3hCLFVBQVUsRUFBRSxLQUFLLENBQUMsVUFBVTtnQkFDNUIsb0JBQW9CLEVBQUUsZUFBZSxTQUFTLEVBQUU7Z0JBQ2hELGFBQWEsRUFBRSxLQUFLLENBQUMsYUFBYSxJQUFJLFNBQVM7Z0JBQy9DLEtBQUssRUFBRSxLQUFLLENBQUMsS0FBSyxJQUFJLFNBQVM7Z0JBQy9CLGFBQWEsRUFBRSxZQUFZO2dCQUMzQixRQUFRLEVBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJO2FBQzFCLENBQUM7WUFFRixNQUFNLFVBQVUsR0FBRyxJQUFJLHlCQUFVLENBQUM7Z0JBQ2hDLFNBQVMsRUFBRSxlQUFlO2dCQUMxQixJQUFJLEVBQUUsTUFBTTthQUNiLENBQUMsQ0FBQztZQUVILE1BQU0sU0FBUyxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQztZQUNqQyxPQUFPLENBQUMsR0FBRyxDQUFDLDRCQUE0QixLQUFLLENBQUMsVUFBVSxLQUFLLFlBQVksT0FBTyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUM7UUFDckcsQ0FBQztJQUNILENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2YsaUVBQWlFO1FBQ2pFLE9BQU8sQ0FBQyxLQUFLLENBQUMsK0JBQStCLEtBQUssRUFBRSxDQUFDLENBQUM7SUFDeEQsQ0FBQztBQUNILENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEV2ZW50IEluZ2VzdCBBUEkgTGFtYmRhXG4gKlxuICogSFRUUCBlbmRwb2ludCBmb3IgcmVjZWl2aW5nIGV2ZW50cyBmcm9tIE5vdGVodWIgSFRUUCByb3V0ZXMuXG4gKiBQcm9jZXNzZXMgaW5jb21pbmcgU29uZ2JpcmQgZXZlbnRzIGFuZCB3cml0ZXMgdG8gRHluYW1vREIuXG4gKi9cblxuaW1wb3J0IHsgRHluYW1vREJDbGllbnQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtZHluYW1vZGInO1xuaW1wb3J0IHsgRHluYW1vREJEb2N1bWVudENsaWVudCwgUHV0Q29tbWFuZCwgVXBkYXRlQ29tbWFuZCwgUXVlcnlDb21tYW5kLCBHZXRDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvbGliLWR5bmFtb2RiJztcbmltcG9ydCB7IFNOU0NsaWVudCwgUHVibGlzaENvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtc25zJztcbmltcG9ydCB7IEFQSUdhdGV3YXlQcm94eUV2ZW50LCBBUElHYXRld2F5UHJveHlSZXN1bHQgfSBmcm9tICdhd3MtbGFtYmRhJztcblxuLy8gSW5pdGlhbGl6ZSBjbGllbnRzXG5jb25zdCBkZGJDbGllbnQgPSBuZXcgRHluYW1vREJDbGllbnQoe30pO1xuY29uc3QgZG9jQ2xpZW50ID0gRHluYW1vREJEb2N1bWVudENsaWVudC5mcm9tKGRkYkNsaWVudCwge1xuICBtYXJzaGFsbE9wdGlvbnM6IHtcbiAgICByZW1vdmVVbmRlZmluZWRWYWx1ZXM6IHRydWUsXG4gIH0sXG59KTtcbmNvbnN0IHNuc0NsaWVudCA9IG5ldyBTTlNDbGllbnQoe30pO1xuXG4vLyBFbnZpcm9ubWVudCB2YXJpYWJsZXNcbmNvbnN0IFRFTEVNRVRSWV9UQUJMRSA9IHByb2Nlc3MuZW52LlRFTEVNRVRSWV9UQUJMRSE7XG5jb25zdCBERVZJQ0VTX1RBQkxFID0gcHJvY2Vzcy5lbnYuREVWSUNFU19UQUJMRSE7XG5jb25zdCBDT01NQU5EU19UQUJMRSA9IHByb2Nlc3MuZW52LkNPTU1BTkRTX1RBQkxFITtcbmNvbnN0IEFMRVJUU19UQUJMRSA9IHByb2Nlc3MuZW52LkFMRVJUU19UQUJMRSE7XG5jb25zdCBBTEVSVF9UT1BJQ19BUk4gPSBwcm9jZXNzLmVudi5BTEVSVF9UT1BJQ19BUk4hO1xuY29uc3QgSk9VUk5FWVNfVEFCTEUgPSBwcm9jZXNzLmVudi5KT1VSTkVZU19UQUJMRSE7XG5jb25zdCBMT0NBVElPTlNfVEFCTEUgPSBwcm9jZXNzLmVudi5MT0NBVElPTlNfVEFCTEUhO1xuXG4vLyBUVEw6IDkwIGRheXMgaW4gc2Vjb25kc1xuY29uc3QgVFRMX0RBWVMgPSA5MDtcbmNvbnN0IFRUTF9TRUNPTkRTID0gVFRMX0RBWVMgKiAyNCAqIDYwICogNjA7XG5cbi8vIE5vdGVodWIgZXZlbnQgc3RydWN0dXJlIChmcm9tIEhUVFAgcm91dGUpXG5pbnRlcmZhY2UgTm90ZWh1YkV2ZW50IHtcbiAgZXZlbnQ6IHN0cmluZzsgICAgICAgICAgIC8vIGUuZy4sIFwiZGV2Onh4eHh4I3RyYWNrLnFvIzFcIlxuICBzZXNzaW9uOiBzdHJpbmc7XG4gIGJlc3RfaWQ6IHN0cmluZztcbiAgZGV2aWNlOiBzdHJpbmc7ICAgICAgICAgIC8vIERldmljZSBVSURcbiAgc246IHN0cmluZzsgICAgICAgICAgICAgIC8vIFNlcmlhbCBudW1iZXJcbiAgcHJvZHVjdDogc3RyaW5nO1xuICBhcHA6IHN0cmluZztcbiAgcmVjZWl2ZWQ6IG51bWJlcjtcbiAgcmVxOiBzdHJpbmc7ICAgICAgICAgICAgIC8vIGUuZy4sIFwibm90ZS5hZGRcIlxuICB3aGVuOiBudW1iZXI7ICAgICAgICAgICAgLy8gVW5peCB0aW1lc3RhbXBcbiAgZmlsZTogc3RyaW5nOyAgICAgICAgICAgIC8vIGUuZy4sIFwidHJhY2sucW9cIlxuICBib2R5OiB7XG4gICAgdGVtcD86IG51bWJlcjtcbiAgICBodW1pZGl0eT86IG51bWJlcjtcbiAgICBwcmVzc3VyZT86IG51bWJlcjtcbiAgICAvLyBOb3RlOiB2b2x0YWdlIGlzIG5vIGxvbmdlciBzZW50IGluIHRyYWNrLnFvOyBiYXR0ZXJ5IGluZm8gY29tZXMgZnJvbSBfbG9nLnFvIGFuZCBfaGVhbHRoLnFvXG4gICAgbW90aW9uPzogYm9vbGVhbiB8IG51bWJlcjtcbiAgICBtb2RlPzogc3RyaW5nO1xuICAgIHRyYW5zaXRfbG9ja2VkPzogYm9vbGVhbjtcbiAgICBkZW1vX2xvY2tlZD86IGJvb2xlYW47XG4gICAgLy8gQWxlcnQtc3BlY2lmaWMgZmllbGRzXG4gICAgdHlwZT86IHN0cmluZztcbiAgICB2YWx1ZT86IG51bWJlcjtcbiAgICB0aHJlc2hvbGQ/OiBudW1iZXI7XG4gICAgbWVzc2FnZT86IHN0cmluZztcbiAgICAvLyBDb21tYW5kIGFjayBmaWVsZHNcbiAgICBjbWQ/OiBzdHJpbmc7XG4gICAgc3RhdHVzPzogc3RyaW5nO1xuICAgIGV4ZWN1dGVkX2F0PzogbnVtYmVyO1xuICAgIC8vIE1vam8gcG93ZXIgbW9uaXRvcmluZyBmaWVsZHMgKF9sb2cucW8pXG4gICAgbWlsbGlhbXBfaG91cnM/OiBudW1iZXI7XG4gICAgdGVtcGVyYXR1cmU/OiBudW1iZXI7XG4gICAgLy8gSGVhbHRoIGV2ZW50IGZpZWxkcyAoX2hlYWx0aC5xbylcbiAgICBtZXRob2Q/OiBzdHJpbmc7XG4gICAgdGV4dD86IHN0cmluZztcbiAgICB2b2x0YWdlX21vZGU/OiBzdHJpbmc7XG4gICAgLy8gU2Vzc2lvbiBmaWVsZHMgbWF5IGFwcGVhciBpbiBib2R5IGZvciBfc2Vzc2lvbi5xb1xuICAgIHBvd2VyX3VzYj86IGJvb2xlYW47XG4gICAgLy8gR1BTIHRyYWNraW5nIGZpZWxkcyAoX3RyYWNrLnFvKVxuICAgIHZlbG9jaXR5PzogbnVtYmVyOyAgICAgIC8vIFNwZWVkIGluIG0vc1xuICAgIGJlYXJpbmc/OiBudW1iZXI7ICAgICAgIC8vIERpcmVjdGlvbiBpbiBkZWdyZWVzIGZyb20gbm9ydGhcbiAgICBkaXN0YW5jZT86IG51bWJlcjsgICAgICAvLyBEaXN0YW5jZSBmcm9tIHByZXZpb3VzIHBvaW50IGluIG1ldGVyc1xuICAgIHNlY29uZHM/OiBudW1iZXI7ICAgICAgIC8vIFNlY29uZHMgc2luY2UgcHJldmlvdXMgdHJhY2tpbmcgZXZlbnRcbiAgICBkb3A/OiBudW1iZXI7ICAgICAgICAgIC8vIERpbHV0aW9uIG9mIHByZWNpc2lvbiAoR1BTIGFjY3VyYWN5KVxuICAgIGpvdXJuZXk/OiBudW1iZXI7ICAgICAgLy8gSm91cm5leSBJRCAoVW5peCB0aW1lc3RhbXAgb2Ygam91cm5leSBzdGFydClcbiAgICBqY291bnQ/OiBudW1iZXI7ICAgICAgIC8vIFBvaW50IG51bWJlciBpbiBjdXJyZW50IGpvdXJuZXkgKHN0YXJ0cyBhdCAxKVxuICAgIHRpbWU/OiBudW1iZXI7ICAgICAgICAgLy8gVGltZXN0YW1wIHdoZW4gR1BTIGZpeCB3YXMgY2FwdHVyZWRcbiAgfTtcbiAgYmVzdF9sb2NhdGlvbl90eXBlPzogc3RyaW5nO1xuICBiZXN0X2xvY2F0aW9uX3doZW4/OiBudW1iZXI7XG4gIGJlc3RfbGF0PzogbnVtYmVyO1xuICBiZXN0X2xvbj86IG51bWJlcjtcbiAgYmVzdF9sb2NhdGlvbj86IHN0cmluZztcbiAgdG93ZXJfbG9jYXRpb24/OiBzdHJpbmc7XG4gIHRvd2VyX2xhdD86IG51bWJlcjtcbiAgdG93ZXJfbG9uPzogbnVtYmVyO1xuICB0b3dlcl93aGVuPzogbnVtYmVyO1xuICAvLyBUcmlhbmd1bGF0aW9uIGZpZWxkcyAoZnJvbSBfZ2VvbG9jYXRlLnFvIG9yIGVucmljaGVkIGV2ZW50cylcbiAgdHJpX3doZW4/OiBudW1iZXI7XG4gIHRyaV9sYXQ/OiBudW1iZXI7XG4gIHRyaV9sb24/OiBudW1iZXI7XG4gIHRyaV9sb2NhdGlvbj86IHN0cmluZztcbiAgdHJpX2NvdW50cnk/OiBzdHJpbmc7XG4gIHRyaV90aW1lem9uZT86IHN0cmluZztcbiAgdHJpX3BvaW50cz86IG51bWJlcjsgIC8vIE51bWJlciBvZiByZWZlcmVuY2UgcG9pbnRzIHVzZWQgZm9yIHRyaWFuZ3VsYXRpb25cbiAgZmxlZXRzPzogc3RyaW5nW107XG4gIC8vIEdQUyB0aW1lc3RhbXAgZm9yIF90cmFjay5xbyBldmVudHNcbiAgd2hlcmVfd2hlbj86IG51bWJlcjsgIC8vIFVuaXggdGltZXN0YW1wIHdoZW4gR1BTIGZpeCB3YXMgY2FwdHVyZWQgKG1vcmUgYWNjdXJhdGUgdGhhbiAnd2hlbicgZm9yIHRyYWNraW5nKVxuICAvLyBTZXNzaW9uIGZpZWxkcyAoX3Nlc3Npb24ucW8pIC0gbWF5IGFwcGVhciBhdCB0b3AgbGV2ZWwgb3IgaW4gYm9keVxuICBmaXJtd2FyZV9ob3N0Pzogc3RyaW5nOyAgICAgLy8gSlNPTiBzdHJpbmcgd2l0aCBob3N0IGZpcm13YXJlIGluZm9cbiAgZmlybXdhcmVfbm90ZWNhcmQ/OiBzdHJpbmc7IC8vIEpTT04gc3RyaW5nIHdpdGggTm90ZWNhcmQgZmlybXdhcmUgaW5mb1xuICBza3U/OiBzdHJpbmc7ICAgICAgICAgICAgICAgLy8gTm90ZWNhcmQgU0tVIChlLmcuLCBcIk5PVEUtV0JHTFdcIilcbiAgcG93ZXJfdXNiPzogYm9vbGVhbjsgICAgICAgIC8vIHRydWUgaWYgZGV2aWNlIGlzIFVTQiBwb3dlcmVkXG59XG5cbmV4cG9ydCBjb25zdCBoYW5kbGVyID0gYXN5bmMgKGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudCk6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiA9PiB7XG4gIGNvbnNvbGUubG9nKCdJbmdlc3QgcmVxdWVzdDonLCBKU09OLnN0cmluZ2lmeShldmVudCkpO1xuXG4gIGNvbnN0IGhlYWRlcnMgPSB7XG4gICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgfTtcblxuICB0cnkge1xuICAgIGlmICghZXZlbnQuYm9keSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnUmVxdWVzdCBib2R5IHJlcXVpcmVkJyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgY29uc3Qgbm90ZWh1YkV2ZW50OiBOb3RlaHViRXZlbnQgPSBKU09OLnBhcnNlKGV2ZW50LmJvZHkpO1xuICAgIGNvbnNvbGUubG9nKCdQcm9jZXNzaW5nIE5vdGVodWIgZXZlbnQ6JywgSlNPTi5zdHJpbmdpZnkobm90ZWh1YkV2ZW50KSk7XG5cbiAgICAvLyBUcmFuc2Zvcm0gdG8gaW50ZXJuYWwgZm9ybWF0XG4gICAgLy8gRm9yIF90cmFjay5xbyBldmVudHMsIHVzZSAnd2hlcmVfd2hlbicgd2hpY2ggaXMgd2hlbiB0aGUgR1BTIGZpeCB3YXMgY2FwdHVyZWRcbiAgICAvLyBGb3Igb3RoZXIgZXZlbnRzLCB1c2UgJ3doZW4nIGlmIGF2YWlsYWJsZSwgb3RoZXJ3aXNlIGZhbGwgYmFjayB0byAncmVjZWl2ZWQnXG4gICAgbGV0IGV2ZW50VGltZXN0YW1wOiBudW1iZXI7XG4gICAgaWYgKG5vdGVodWJFdmVudC5maWxlID09PSAnX3RyYWNrLnFvJyAmJiBub3RlaHViRXZlbnQud2hlcmVfd2hlbikge1xuICAgICAgZXZlbnRUaW1lc3RhbXAgPSBub3RlaHViRXZlbnQud2hlcmVfd2hlbjtcbiAgICB9IGVsc2Uge1xuICAgICAgZXZlbnRUaW1lc3RhbXAgPSBub3RlaHViRXZlbnQud2hlbiB8fCBNYXRoLmZsb29yKG5vdGVodWJFdmVudC5yZWNlaXZlZCk7XG4gICAgfVxuXG4gICAgLy8gRXh0cmFjdCBsb2NhdGlvbiAtIHByZWZlciBHUFMgKGJlc3RfbGF0L2Jlc3RfbG9uKSwgZmFsbCBiYWNrIHRvIHRyaWFuZ3VsYXRpb25cbiAgICBjb25zdCBsb2NhdGlvbiA9IGV4dHJhY3RMb2NhdGlvbihub3RlaHViRXZlbnQpO1xuXG4gICAgLy8gRXh0cmFjdCBzZXNzaW9uIGluZm8gKGZpcm13YXJlIHZlcnNpb25zLCBTS1UpIGZyb20gX3Nlc3Npb24ucW8gZXZlbnRzXG4gICAgY29uc3Qgc2Vzc2lvbkluZm8gPSBleHRyYWN0U2Vzc2lvbkluZm8obm90ZWh1YkV2ZW50KTtcblxuICAgIGNvbnN0IHNvbmdiaXJkRXZlbnQgPSB7XG4gICAgICBkZXZpY2VfdWlkOiBub3RlaHViRXZlbnQuZGV2aWNlLFxuICAgICAgc2VyaWFsX251bWJlcjogbm90ZWh1YkV2ZW50LnNuLFxuICAgICAgZmxlZXQ6IG5vdGVodWJFdmVudC5mbGVldHM/LlswXSB8fCAnZGVmYXVsdCcsXG4gICAgICBldmVudF90eXBlOiBub3RlaHViRXZlbnQuZmlsZSxcbiAgICAgIHRpbWVzdGFtcDogZXZlbnRUaW1lc3RhbXAsXG4gICAgICByZWNlaXZlZDogbm90ZWh1YkV2ZW50LnJlY2VpdmVkLFxuICAgICAgYm9keTogbm90ZWh1YkV2ZW50LmJvZHkgfHwge30sXG4gICAgICBsb2NhdGlvbixcbiAgICAgIHNlc3Npb246IHNlc3Npb25JbmZvLFxuICAgIH07XG5cbiAgICAvLyBXcml0ZSB0ZWxlbWV0cnkgdG8gRHluYW1vREIgKGZvciB0cmFjay5xbyBldmVudHMpXG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuZXZlbnRfdHlwZSA9PT0gJ3RyYWNrLnFvJykge1xuICAgICAgYXdhaXQgd3JpdGVUZWxlbWV0cnkoc29uZ2JpcmRFdmVudCwgJ3RlbGVtZXRyeScpO1xuICAgIH1cblxuICAgIC8vIFdyaXRlIE1vam8gcG93ZXIgZGF0YSB0byBEeW5hbW9EQiAoX2xvZy5xbyBjb250YWlucyBwb3dlciB0ZWxlbWV0cnkpXG4gICAgLy8gU2tpcCBpZiBkZXZpY2UgaXMgVVNCIHBvd2VyZWQgKHZvbHRhZ2VfbW9kZTogXCJ1c2JcIikgLSBubyBiYXR0ZXJ5IHRvIG1vbml0b3JcbiAgICBpZiAoc29uZ2JpcmRFdmVudC5ldmVudF90eXBlID09PSAnX2xvZy5xbycpIHtcbiAgICAgIGlmIChzb25nYmlyZEV2ZW50LmJvZHkudm9sdGFnZV9tb2RlID09PSAndXNiJykge1xuICAgICAgICBjb25zb2xlLmxvZyhgU2tpcHBpbmcgX2xvZy5xbyBldmVudCBmb3IgJHtzb25nYmlyZEV2ZW50LmRldmljZV91aWR9IC0gVVNCIHBvd2VyZWRgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGF3YWl0IHdyaXRlUG93ZXJUZWxlbWV0cnkoc29uZ2JpcmRFdmVudCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gV3JpdGUgaGVhbHRoIGV2ZW50cyB0byBEeW5hbW9EQiAoX2hlYWx0aC5xbylcbiAgICBpZiAoc29uZ2JpcmRFdmVudC5ldmVudF90eXBlID09PSAnX2hlYWx0aC5xbycpIHtcbiAgICAgIGF3YWl0IHdyaXRlSGVhbHRoRXZlbnQoc29uZ2JpcmRFdmVudCk7XG4gICAgfVxuXG4gICAgLy8gSGFuZGxlIHRyaWFuZ3VsYXRpb24gcmVzdWx0cyAoX2dlb2xvY2F0ZS5xbylcbiAgICAvLyBXcml0ZSBsb2NhdGlvbiB0byB0ZWxlbWV0cnkgdGFibGUgZm9yIGxvY2F0aW9uIGhpc3RvcnkgdHJhaWxcbiAgICBpZiAoc29uZ2JpcmRFdmVudC5ldmVudF90eXBlID09PSAnX2dlb2xvY2F0ZS5xbycgJiYgc29uZ2JpcmRFdmVudC5sb2NhdGlvbikge1xuICAgICAgYXdhaXQgd3JpdGVMb2NhdGlvbkV2ZW50KHNvbmdiaXJkRXZlbnQpO1xuICAgIH1cblxuICAgIC8vIEhhbmRsZSBHUFMgdHJhY2tpbmcgZXZlbnRzIChfdHJhY2sucW8gZnJvbSBOb3RlY2FyZClcbiAgICBpZiAoc29uZ2JpcmRFdmVudC5ldmVudF90eXBlID09PSAnX3RyYWNrLnFvJykge1xuICAgICAgYXdhaXQgd3JpdGVUcmFja2luZ0V2ZW50KHNvbmdiaXJkRXZlbnQpO1xuICAgICAgYXdhaXQgdXBzZXJ0Sm91cm5leShzb25nYmlyZEV2ZW50KTtcbiAgICB9XG5cbiAgICAvLyBXcml0ZSB0byBsb2NhdGlvbiBoaXN0b3J5IHRhYmxlIGZvciBhbGwgZXZlbnRzIHdpdGggbG9jYXRpb25cbiAgICBpZiAoc29uZ2JpcmRFdmVudC5sb2NhdGlvbikge1xuICAgICAgYXdhaXQgd3JpdGVMb2NhdGlvbkhpc3Rvcnkoc29uZ2JpcmRFdmVudCk7XG4gICAgfVxuXG4gICAgLy8gVHJhY2sgbW9kZSBjaGFuZ2VzIEJFRk9SRSB1cGRhdGluZyBkZXZpY2UgbWV0YWRhdGEgKHNvIHdlIGNhbiBjb21wYXJlIG9sZCB2cyBuZXcpXG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuYm9keS5tb2RlKSB7XG4gICAgICBhd2FpdCB0cmFja01vZGVDaGFuZ2Uoc29uZ2JpcmRFdmVudCk7XG4gICAgfVxuXG4gICAgLy8gVXBkYXRlIGRldmljZSBtZXRhZGF0YSBpbiBEeW5hbW9EQlxuICAgIGF3YWl0IHVwZGF0ZURldmljZU1ldGFkYXRhKHNvbmdiaXJkRXZlbnQpO1xuXG4gICAgLy8gQ2hlY2sgZm9yIG1vZGUgY2hhbmdlIGF3YXkgZnJvbSB0cmFuc2l0IC0gY29tcGxldGUgYW55IGFjdGl2ZSBqb3VybmV5c1xuICAgIGlmIChzb25nYmlyZEV2ZW50LmJvZHkubW9kZSAmJiBzb25nYmlyZEV2ZW50LmJvZHkubW9kZSAhPT0gJ3RyYW5zaXQnKSB7XG4gICAgICBhd2FpdCBjb21wbGV0ZUFjdGl2ZUpvdXJuZXlzT25Nb2RlQ2hhbmdlKHNvbmdiaXJkRXZlbnQuZGV2aWNlX3VpZCwgc29uZ2JpcmRFdmVudC5ib2R5Lm1vZGUpO1xuICAgIH1cblxuICAgIC8vIFN0b3JlIGFuZCBwdWJsaXNoIGFsZXJ0IGlmIHRoaXMgaXMgYW4gYWxlcnQgZXZlbnRcbiAgICBpZiAoc29uZ2JpcmRFdmVudC5ldmVudF90eXBlID09PSAnYWxlcnQucW8nKSB7XG4gICAgICBhd2FpdCBzdG9yZUFsZXJ0KHNvbmdiaXJkRXZlbnQpO1xuICAgICAgYXdhaXQgcHVibGlzaEFsZXJ0KHNvbmdiaXJkRXZlbnQpO1xuICAgIH1cblxuICAgIC8vIFByb2Nlc3MgY29tbWFuZCBhY2tub3dsZWRnbWVudFxuICAgIGlmIChzb25nYmlyZEV2ZW50LmV2ZW50X3R5cGUgPT09ICdjb21tYW5kX2Fjay5xbycpIHtcbiAgICAgIGF3YWl0IHByb2Nlc3NDb21tYW5kQWNrKHNvbmdiaXJkRXZlbnQpO1xuICAgIH1cblxuICAgIGNvbnNvbGUubG9nKCdFdmVudCBwcm9jZXNzZWQgc3VjY2Vzc2Z1bGx5Jyk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgc3RhdHVzOiAnb2snLCBkZXZpY2U6IHNvbmdiaXJkRXZlbnQuZGV2aWNlX3VpZCB9KSxcbiAgICB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHByb2Nlc3NpbmcgZXZlbnQ6JywgZXJyb3IpO1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA1MDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0ludGVybmFsIHNlcnZlciBlcnJvcicgfSksXG4gICAgfTtcbiAgfVxufTtcblxuaW50ZXJmYWNlIFNlc3Npb25JbmZvIHtcbiAgZmlybXdhcmVfdmVyc2lvbj86IHN0cmluZztcbiAgbm90ZWNhcmRfdmVyc2lvbj86IHN0cmluZztcbiAgbm90ZWNhcmRfc2t1Pzogc3RyaW5nO1xuICB1c2JfcG93ZXJlZD86IGJvb2xlYW47XG59XG5cbi8qKlxuICogRXh0cmFjdCBzZXNzaW9uIGluZm8gKGZpcm13YXJlIHZlcnNpb25zLCBTS1UsIHBvd2VyIHN0YXR1cykgZnJvbSBOb3RlaHViIGV2ZW50XG4gKiBUaGlzIGluZm8gaXMgYXZhaWxhYmxlIGluIF9zZXNzaW9uLnFvIGV2ZW50c1xuICogTm90ZTogU29tZSBmaWVsZHMgbWF5IGFwcGVhciBhdCB0aGUgdG9wIGxldmVsIG9yIGluc2lkZSB0aGUgYm9keSBkZXBlbmRpbmcgb24gdGhlIEhUVFAgcm91dGUgY29uZmlndXJhdGlvblxuICovXG5mdW5jdGlvbiBleHRyYWN0U2Vzc2lvbkluZm8oZXZlbnQ6IE5vdGVodWJFdmVudCk6IFNlc3Npb25JbmZvIHwgdW5kZWZpbmVkIHtcbiAgLy8gQ2hlY2sgZm9yIHBvd2VyX3VzYiBhdCB0b3AgbGV2ZWwgT1IgaW4gYm9keVxuICBjb25zdCBwb3dlclVzYiA9IGV2ZW50LnBvd2VyX3VzYiA/PyBldmVudC5ib2R5Py5wb3dlcl91c2I7XG5cbiAgaWYgKCFldmVudC5maXJtd2FyZV9ob3N0ICYmICFldmVudC5maXJtd2FyZV9ub3RlY2FyZCAmJiAhZXZlbnQuc2t1ICYmIHBvd2VyVXNiID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG5cbiAgY29uc3Qgc2Vzc2lvbkluZm86IFNlc3Npb25JbmZvID0ge307XG5cbiAgLy8gUGFyc2UgaG9zdCBmaXJtd2FyZSB2ZXJzaW9uXG4gIGlmIChldmVudC5maXJtd2FyZV9ob3N0KSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGhvc3RGaXJtd2FyZSA9IEpTT04ucGFyc2UoZXZlbnQuZmlybXdhcmVfaG9zdCk7XG4gICAgICBzZXNzaW9uSW5mby5maXJtd2FyZV92ZXJzaW9uID0gaG9zdEZpcm13YXJlLnZlcnNpb247XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS5lcnJvcignRmFpbGVkIHRvIHBhcnNlIGZpcm13YXJlX2hvc3Q6JywgZSk7XG4gICAgfVxuICB9XG5cbiAgLy8gUGFyc2UgTm90ZWNhcmQgZmlybXdhcmUgdmVyc2lvblxuICBpZiAoZXZlbnQuZmlybXdhcmVfbm90ZWNhcmQpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgbm90ZWNhcmRGaXJtd2FyZSA9IEpTT04ucGFyc2UoZXZlbnQuZmlybXdhcmVfbm90ZWNhcmQpO1xuICAgICAgc2Vzc2lvbkluZm8ubm90ZWNhcmRfdmVyc2lvbiA9IG5vdGVjYXJkRmlybXdhcmUudmVyc2lvbjtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLmVycm9yKCdGYWlsZWQgdG8gcGFyc2UgZmlybXdhcmVfbm90ZWNhcmQ6JywgZSk7XG4gICAgfVxuICB9XG5cbiAgLy8gU0tVXG4gIGlmIChldmVudC5za3UpIHtcbiAgICBzZXNzaW9uSW5mby5ub3RlY2FyZF9za3UgPSBldmVudC5za3U7XG4gIH1cblxuICAvLyBVU0IgcG93ZXIgc3RhdHVzIChjaGVjayB0b3AgbGV2ZWwgZmlyc3QsIHRoZW4gYm9keSlcbiAgaWYgKHBvd2VyVXNiICE9PSB1bmRlZmluZWQpIHtcbiAgICBzZXNzaW9uSW5mby51c2JfcG93ZXJlZCA9IHBvd2VyVXNiO1xuICAgIGNvbnNvbGUubG9nKGBFeHRyYWN0ZWQgdXNiX3Bvd2VyZWQ6ICR7cG93ZXJVc2J9YCk7XG4gIH1cblxuICByZXR1cm4gT2JqZWN0LmtleXMoc2Vzc2lvbkluZm8pLmxlbmd0aCA+IDAgPyBzZXNzaW9uSW5mbyA6IHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiBOb3JtYWxpemUgbG9jYXRpb24gc291cmNlIHR5cGUgZnJvbSBOb3RlaHViIHRvIG91ciBzdGFuZGFyZCB2YWx1ZXNcbiAqL1xuZnVuY3Rpb24gbm9ybWFsaXplTG9jYXRpb25Tb3VyY2Uoc291cmNlPzogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKCFzb3VyY2UpIHJldHVybiAnZ3BzJztcbiAgY29uc3Qgbm9ybWFsaXplZCA9IHNvdXJjZS50b0xvd2VyQ2FzZSgpO1xuICAvLyBOb3RlaHViIHVzZXMgJ3RyaWFuZ3VsYXRlZCcgYnV0IHdlIHVzZSAndHJpYW5ndWxhdGlvbicgZm9yIGNvbnNpc3RlbmN5XG4gIGlmIChub3JtYWxpemVkID09PSAndHJpYW5ndWxhdGVkJykgcmV0dXJuICd0cmlhbmd1bGF0aW9uJztcbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbi8qKlxuICogRXh0cmFjdCBsb2NhdGlvbiBmcm9tIE5vdGVodWIgZXZlbnQsIHByZWZlcnJpbmcgR1BTIGJ1dCBmYWxsaW5nIGJhY2sgdG8gdHJpYW5ndWxhdGlvblxuICovXG5mdW5jdGlvbiBleHRyYWN0TG9jYXRpb24oZXZlbnQ6IE5vdGVodWJFdmVudCk6IHsgbGF0OiBudW1iZXI7IGxvbjogbnVtYmVyOyB0aW1lPzogbnVtYmVyOyBzb3VyY2U6IHN0cmluZzsgbmFtZT86IHN0cmluZyB9IHwgdW5kZWZpbmVkIHtcbiAgLy8gUHJlZmVyIEdQUyBsb2NhdGlvbiAoYmVzdF9sYXQvYmVzdF9sb24gd2l0aCB0eXBlICdncHMnKVxuICBpZiAoZXZlbnQuYmVzdF9sYXQgIT09IHVuZGVmaW5lZCAmJiBldmVudC5iZXN0X2xvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGxhdDogZXZlbnQuYmVzdF9sYXQsXG4gICAgICBsb246IGV2ZW50LmJlc3RfbG9uLFxuICAgICAgdGltZTogZXZlbnQuYmVzdF9sb2NhdGlvbl93aGVuLFxuICAgICAgc291cmNlOiBub3JtYWxpemVMb2NhdGlvblNvdXJjZShldmVudC5iZXN0X2xvY2F0aW9uX3R5cGUpLFxuICAgICAgbmFtZTogZXZlbnQuYmVzdF9sb2NhdGlvbixcbiAgICB9O1xuICB9XG5cbiAgLy8gRmFsbCBiYWNrIHRvIHRyaWFuZ3VsYXRpb24gZGF0YVxuICBpZiAoZXZlbnQudHJpX2xhdCAhPT0gdW5kZWZpbmVkICYmIGV2ZW50LnRyaV9sb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB7XG4gICAgICBsYXQ6IGV2ZW50LnRyaV9sYXQsXG4gICAgICBsb246IGV2ZW50LnRyaV9sb24sXG4gICAgICB0aW1lOiBldmVudC50cmlfd2hlbixcbiAgICAgIHNvdXJjZTogJ3RyaWFuZ3VsYXRpb24nLFxuICAgICAgbmFtZTogZXZlbnQudG93ZXJfbG9jYXRpb24sXG4gICAgfTtcbiAgfVxuXG4gIC8vIEZhbGwgYmFjayB0byB0b3dlciBsb2NhdGlvblxuICBpZiAoZXZlbnQudG93ZXJfbGF0ICE9PSB1bmRlZmluZWQgJiYgZXZlbnQudG93ZXJfbG9uICE9PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgbGF0OiBldmVudC50b3dlcl9sYXQsXG4gICAgICBsb246IGV2ZW50LnRvd2VyX2xvbixcbiAgICAgIHRpbWU6IGV2ZW50LnRvd2VyX3doZW4sXG4gICAgICBzb3VyY2U6ICd0b3dlcicsXG4gICAgICBuYW1lOiBldmVudC50b3dlcl9sb2NhdGlvbixcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuaW50ZXJmYWNlIFNvbmdiaXJkRXZlbnQge1xuICBkZXZpY2VfdWlkOiBzdHJpbmc7XG4gIHNlcmlhbF9udW1iZXI/OiBzdHJpbmc7XG4gIGZsZWV0Pzogc3RyaW5nO1xuICBldmVudF90eXBlOiBzdHJpbmc7XG4gIHRpbWVzdGFtcDogbnVtYmVyO1xuICByZWNlaXZlZDogbnVtYmVyO1xuICBzZXNzaW9uPzogU2Vzc2lvbkluZm87XG4gIGJvZHk6IHtcbiAgICB0ZW1wPzogbnVtYmVyO1xuICAgIGh1bWlkaXR5PzogbnVtYmVyO1xuICAgIHByZXNzdXJlPzogbnVtYmVyO1xuICAgIC8vIE5vdGU6IHZvbHRhZ2UgaXMgbm8gbG9uZ2VyIHNlbnQgaW4gdHJhY2sucW87IGJhdHRlcnkgaW5mbyBjb21lcyBmcm9tIF9sb2cucW8gYW5kIF9oZWFsdGgucW9cbiAgICB2b2x0YWdlPzogbnVtYmVyOyAgICAgIC8vIFN0aWxsIHByZXNlbnQgaW4gX2xvZy5xbyAoTW9qbykgYW5kIF9oZWFsdGgucW8gZXZlbnRzXG4gICAgbW90aW9uPzogYm9vbGVhbiB8IG51bWJlcjtcbiAgICBtb2RlPzogc3RyaW5nO1xuICAgIHRyYW5zaXRfbG9ja2VkPzogYm9vbGVhbjtcbiAgICBkZW1vX2xvY2tlZD86IGJvb2xlYW47XG4gICAgdHlwZT86IHN0cmluZztcbiAgICB2YWx1ZT86IG51bWJlcjtcbiAgICB0aHJlc2hvbGQ/OiBudW1iZXI7XG4gICAgbWVzc2FnZT86IHN0cmluZztcbiAgICBjbWQ/OiBzdHJpbmc7XG4gICAgY21kX2lkPzogc3RyaW5nO1xuICAgIHN0YXR1cz86IHN0cmluZztcbiAgICBleGVjdXRlZF9hdD86IG51bWJlcjtcbiAgICBtaWxsaWFtcF9ob3Vycz86IG51bWJlcjtcbiAgICB0ZW1wZXJhdHVyZT86IG51bWJlcjtcbiAgICAvLyBIZWFsdGggZXZlbnQgZmllbGRzXG4gICAgbWV0aG9kPzogc3RyaW5nO1xuICAgIHRleHQ/OiBzdHJpbmc7XG4gICAgdm9sdGFnZV9tb2RlPzogc3RyaW5nO1xuICAgIC8vIEdQUyB0cmFja2luZyBmaWVsZHMgKF90cmFjay5xbylcbiAgICB2ZWxvY2l0eT86IG51bWJlcjtcbiAgICBiZWFyaW5nPzogbnVtYmVyO1xuICAgIGRpc3RhbmNlPzogbnVtYmVyO1xuICAgIHNlY29uZHM/OiBudW1iZXI7XG4gICAgZG9wPzogbnVtYmVyO1xuICAgIGpvdXJuZXk/OiBudW1iZXI7XG4gICAgamNvdW50PzogbnVtYmVyO1xuICAgIHRpbWU/OiBudW1iZXI7XG4gIH07XG4gIGxvY2F0aW9uPzoge1xuICAgIGxhdD86IG51bWJlcjtcbiAgICBsb24/OiBudW1iZXI7XG4gICAgdGltZT86IG51bWJlcjtcbiAgICBzb3VyY2U/OiBzdHJpbmc7XG4gICAgbmFtZT86IHN0cmluZztcbiAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gd3JpdGVUZWxlbWV0cnkoZXZlbnQ6IFNvbmdiaXJkRXZlbnQsIGRhdGFUeXBlOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGltZXN0YW1wID0gZXZlbnQudGltZXN0YW1wICogMTAwMDsgLy8gQ29udmVydCB0byBtaWxsaXNlY29uZHNcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCkgKyBUVExfU0VDT05EUztcblxuICBjb25zdCByZWNvcmQ6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICB0aW1lc3RhbXAsXG4gICAgdHRsLFxuICAgIGRhdGFfdHlwZTogZGF0YVR5cGUsXG4gICAgZXZlbnRfdHlwZTogZXZlbnQuZXZlbnRfdHlwZSxcbiAgICBldmVudF90eXBlX3RpbWVzdGFtcDogYCR7ZGF0YVR5cGV9IyR7dGltZXN0YW1wfWAsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgfTtcblxuICBpZiAoZXZlbnQuYm9keS50ZW1wICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQudGVtcGVyYXR1cmUgPSBldmVudC5ib2R5LnRlbXA7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuaHVtaWRpdHkgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5odW1pZGl0eSA9IGV2ZW50LmJvZHkuaHVtaWRpdHk7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkucHJlc3N1cmUgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5wcmVzc3VyZSA9IGV2ZW50LmJvZHkucHJlc3N1cmU7XG4gIH1cbiAgLy8gTm90ZTogdm9sdGFnZSBpcyBubyBsb25nZXIgaW5jbHVkZWQgaW4gdHJhY2sucW8gdGVsZW1ldHJ5XG4gIC8vIEJhdHRlcnkgaW5mbyBjb21lcyBmcm9tIF9sb2cucW8gKE1vam8pIGFuZCBfaGVhbHRoLnFvIGV2ZW50c1xuICBpZiAoZXZlbnQuYm9keS5tb3Rpb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5tb3Rpb24gPSBldmVudC5ib2R5Lm1vdGlvbjtcbiAgfVxuXG4gIGlmIChldmVudC5sb2NhdGlvbj8ubGF0ICE9PSB1bmRlZmluZWQgJiYgZXZlbnQubG9jYXRpb24/LmxvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLmxhdGl0dWRlID0gZXZlbnQubG9jYXRpb24ubGF0O1xuICAgIHJlY29yZC5sb25naXR1ZGUgPSBldmVudC5sb2NhdGlvbi5sb247XG4gICAgcmVjb3JkLmxvY2F0aW9uX3NvdXJjZSA9IGV2ZW50LmxvY2F0aW9uLnNvdXJjZSB8fCAnZ3BzJztcbiAgfVxuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBURUxFTUVUUllfVEFCTEUsXG4gICAgSXRlbTogcmVjb3JkLFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFdyb3RlIHRlbGVtZXRyeSByZWNvcmQgZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH1gKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gd3JpdGVQb3dlclRlbGVtZXRyeShldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0aW1lc3RhbXAgPSBldmVudC50aW1lc3RhbXAgKiAxMDAwO1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSArIFRUTF9TRUNPTkRTO1xuXG4gIGNvbnN0IHJlY29yZDogUmVjb3JkPHN0cmluZywgYW55PiA9IHtcbiAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgIHRpbWVzdGFtcCxcbiAgICB0dGwsXG4gICAgZGF0YV90eXBlOiAncG93ZXInLFxuICAgIGV2ZW50X3R5cGU6IGV2ZW50LmV2ZW50X3R5cGUsXG4gICAgZXZlbnRfdHlwZV90aW1lc3RhbXA6IGBwb3dlciMke3RpbWVzdGFtcH1gLFxuICAgIHNlcmlhbF9udW1iZXI6IGV2ZW50LnNlcmlhbF9udW1iZXIgfHwgJ3Vua25vd24nLFxuICAgIGZsZWV0OiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gIH07XG5cbiAgaWYgKGV2ZW50LmJvZHkudm9sdGFnZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLm1vam9fdm9sdGFnZSA9IGV2ZW50LmJvZHkudm9sdGFnZTtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS5taWxsaWFtcF9ob3VycyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLm1pbGxpYW1wX2hvdXJzID0gZXZlbnQuYm9keS5taWxsaWFtcF9ob3VycztcbiAgfVxuXG4gIGlmIChyZWNvcmQubW9qb192b2x0YWdlICE9PSB1bmRlZmluZWQgfHxcbiAgICAgIHJlY29yZC5taWxsaWFtcF9ob3VycyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgY29tbWFuZCA9IG5ldyBQdXRDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogVEVMRU1FVFJZX1RBQkxFLFxuICAgICAgSXRlbTogcmVjb3JkLFxuICAgIH0pO1xuXG4gICAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gICAgY29uc29sZS5sb2coYFdyb3RlIHBvd2VyIHRlbGVtZXRyeSByZWNvcmQgZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH1gKTtcbiAgfSBlbHNlIHtcbiAgICBjb25zb2xlLmxvZygnTm8gcG93ZXIgbWV0cmljcyBpbiBfbG9nLnFvIGV2ZW50LCBza2lwcGluZycpO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlSGVhbHRoRXZlbnQoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGltZXN0YW1wID0gZXZlbnQudGltZXN0YW1wICogMTAwMDsgLy8gQ29udmVydCB0byBtaWxsaXNlY29uZHNcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCkgKyBUVExfU0VDT05EUztcblxuICBjb25zdCByZWNvcmQ6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICB0aW1lc3RhbXAsXG4gICAgdHRsLFxuICAgIGRhdGFfdHlwZTogJ2hlYWx0aCcsXG4gICAgZXZlbnRfdHlwZTogZXZlbnQuZXZlbnRfdHlwZSxcbiAgICBldmVudF90eXBlX3RpbWVzdGFtcDogYGhlYWx0aCMke3RpbWVzdGFtcH1gLFxuICAgIHNlcmlhbF9udW1iZXI6IGV2ZW50LnNlcmlhbF9udW1iZXIgfHwgJ3Vua25vd24nLFxuICAgIGZsZWV0OiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gIH07XG5cbiAgLy8gQWRkIGhlYWx0aCBldmVudCBmaWVsZHNcbiAgaWYgKGV2ZW50LmJvZHkubWV0aG9kICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQubWV0aG9kID0gZXZlbnQuYm9keS5tZXRob2Q7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkudGV4dCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnRleHQgPSBldmVudC5ib2R5LnRleHQ7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkudm9sdGFnZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnZvbHRhZ2UgPSBldmVudC5ib2R5LnZvbHRhZ2U7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkudm9sdGFnZV9tb2RlICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQudm9sdGFnZV9tb2RlID0gZXZlbnQuYm9keS52b2x0YWdlX21vZGU7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkubWlsbGlhbXBfaG91cnMgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5taWxsaWFtcF9ob3VycyA9IGV2ZW50LmJvZHkubWlsbGlhbXBfaG91cnM7XG4gIH1cblxuICAvLyBBZGQgbG9jYXRpb24gaWYgYXZhaWxhYmxlXG4gIGlmIChldmVudC5sb2NhdGlvbj8ubGF0ICE9PSB1bmRlZmluZWQgJiYgZXZlbnQubG9jYXRpb24/LmxvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLmxhdGl0dWRlID0gZXZlbnQubG9jYXRpb24ubGF0O1xuICAgIHJlY29yZC5sb25naXR1ZGUgPSBldmVudC5sb2NhdGlvbi5sb247XG4gICAgcmVjb3JkLmxvY2F0aW9uX3NvdXJjZSA9IGV2ZW50LmxvY2F0aW9uLnNvdXJjZSB8fCAndG93ZXInO1xuICB9XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBQdXRDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IFRFTEVNRVRSWV9UQUJMRSxcbiAgICBJdGVtOiByZWNvcmQsXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgV3JvdGUgaGVhbHRoIGV2ZW50IHJlY29yZCBmb3IgJHtldmVudC5kZXZpY2VfdWlkfTogJHtldmVudC5ib2R5Lm1ldGhvZH1gKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gd3JpdGVMb2NhdGlvbkV2ZW50KGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmICghZXZlbnQubG9jYXRpb24/LmxhdCB8fCAhZXZlbnQubG9jYXRpb24/Lmxvbikge1xuICAgIGNvbnNvbGUubG9nKCdObyBsb2NhdGlvbiBkYXRhIGluIGV2ZW50LCBza2lwcGluZycpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHRpbWVzdGFtcCA9IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDA7IC8vIENvbnZlcnQgdG8gbWlsbGlzZWNvbmRzXG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgY29uc3QgcmVjb3JkOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge1xuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgdGltZXN0YW1wLFxuICAgIHR0bCxcbiAgICBkYXRhX3R5cGU6ICd0ZWxlbWV0cnknLCAvLyBVc2UgdGVsZW1ldHJ5IHNvIGl0J3MgcGlja2VkIHVwIGJ5IGxvY2F0aW9uIHF1ZXJ5XG4gICAgZXZlbnRfdHlwZTogZXZlbnQuZXZlbnRfdHlwZSxcbiAgICBldmVudF90eXBlX3RpbWVzdGFtcDogYHRlbGVtZXRyeSMke3RpbWVzdGFtcH1gLFxuICAgIHNlcmlhbF9udW1iZXI6IGV2ZW50LnNlcmlhbF9udW1iZXIgfHwgJ3Vua25vd24nLFxuICAgIGZsZWV0OiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gICAgbGF0aXR1ZGU6IGV2ZW50LmxvY2F0aW9uLmxhdCxcbiAgICBsb25naXR1ZGU6IGV2ZW50LmxvY2F0aW9uLmxvbixcbiAgICBsb2NhdGlvbl9zb3VyY2U6IGV2ZW50LmxvY2F0aW9uLnNvdXJjZSB8fCAndHJpYW5ndWxhdGlvbicsXG4gIH07XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBQdXRDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IFRFTEVNRVRSWV9UQUJMRSxcbiAgICBJdGVtOiByZWNvcmQsXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgV3JvdGUgbG9jYXRpb24gZXZlbnQgZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH06ICR7ZXZlbnQubG9jYXRpb24uc291cmNlfSAoJHtldmVudC5sb2NhdGlvbi5sYXR9LCAke2V2ZW50LmxvY2F0aW9uLmxvbn0pYCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHVwZGF0ZURldmljZU1ldGFkYXRhKGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG5cbiAgY29uc3QgdXBkYXRlRXhwcmVzc2lvbnM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICBjb25zdCBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge307XG5cbiAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI2xhc3Rfc2VlbiA9IDpsYXN0X3NlZW4nKTtcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjbGFzdF9zZWVuJ10gPSAnbGFzdF9zZWVuJztcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOmxhc3Rfc2VlbiddID0gbm93O1xuXG4gIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyN1cGRhdGVkX2F0ID0gOnVwZGF0ZWRfYXQnKTtcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjdXBkYXRlZF9hdCddID0gJ3VwZGF0ZWRfYXQnO1xuICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6dXBkYXRlZF9hdCddID0gbm93O1xuXG4gIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNzdGF0dXMgPSA6c3RhdHVzJyk7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3N0YXR1cyddID0gJ3N0YXR1cyc7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpzdGF0dXMnXSA9ICdvbmxpbmUnO1xuXG4gIGlmIChldmVudC5zZXJpYWxfbnVtYmVyKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3NuID0gOnNuJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjc24nXSA9ICdzZXJpYWxfbnVtYmVyJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6c24nXSA9IGV2ZW50LnNlcmlhbF9udW1iZXI7XG4gIH1cblxuICBpZiAoZXZlbnQuZmxlZXQpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjZmxlZXQgPSA6ZmxlZXQnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNmbGVldCddID0gJ2ZsZWV0JztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6ZmxlZXQnXSA9IGV2ZW50LmZsZWV0O1xuICB9XG5cbiAgaWYgKGV2ZW50LmJvZHkubW9kZSkge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNtb2RlID0gOm1vZGUnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNtb2RlJ10gPSAnY3VycmVudF9tb2RlJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6bW9kZSddID0gZXZlbnQuYm9keS5tb2RlO1xuICB9XG5cbiAgLy8gRm9yIHRyYWNrLnFvIGV2ZW50cywgdXBkYXRlIGxvY2sgc3RhdGVzIGJhc2VkIG9uIHByZXNlbmNlIG9mIHRoZSBmaWVsZFxuICAvLyBJZiBsb2NrZWQgaXMgdHJ1ZSwgc2V0IGl0OyBpZiBhYnNlbnQgb3IgZmFsc2UsIGNsZWFyIGl0XG4gIGlmIChldmVudC5ldmVudF90eXBlID09PSAndHJhY2sucW8nKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3RyYW5zaXRfbG9ja2VkID0gOnRyYW5zaXRfbG9ja2VkJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjdHJhbnNpdF9sb2NrZWQnXSA9ICd0cmFuc2l0X2xvY2tlZCc7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnRyYW5zaXRfbG9ja2VkJ10gPSBldmVudC5ib2R5LnRyYW5zaXRfbG9ja2VkID09PSB0cnVlO1xuXG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI2RlbW9fbG9ja2VkID0gOmRlbW9fbG9ja2VkJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjZGVtb19sb2NrZWQnXSA9ICdkZW1vX2xvY2tlZCc7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOmRlbW9fbG9ja2VkJ10gPSBldmVudC5ib2R5LmRlbW9fbG9ja2VkID09PSB0cnVlO1xuICB9XG5cbiAgaWYgKGV2ZW50LmxvY2F0aW9uPy5sYXQgIT09IHVuZGVmaW5lZCAmJiBldmVudC5sb2NhdGlvbj8ubG9uICE9PSB1bmRlZmluZWQpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjbG9jID0gOmxvYycpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI2xvYyddID0gJ2xhc3RfbG9jYXRpb24nO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpsb2MnXSA9IHtcbiAgICAgIGxhdDogZXZlbnQubG9jYXRpb24ubGF0LFxuICAgICAgbG9uOiBldmVudC5sb2NhdGlvbi5sb24sXG4gICAgICB0aW1lOiBldmVudC5sb2NhdGlvbi50aW1lIHx8IGV2ZW50LnRpbWVzdGFtcCxcbiAgICAgIHNvdXJjZTogZXZlbnQubG9jYXRpb24uc291cmNlIHx8ICdncHMnLFxuICAgICAgbmFtZTogZXZlbnQubG9jYXRpb24ubmFtZSxcbiAgICB9O1xuICB9XG5cbiAgaWYgKGV2ZW50LmV2ZW50X3R5cGUgPT09ICd0cmFjay5xbycpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjdGVsZW1ldHJ5ID0gOnRlbGVtZXRyeScpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3RlbGVtZXRyeSddID0gJ2xhc3RfdGVsZW1ldHJ5JztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6dGVsZW1ldHJ5J10gPSB7XG4gICAgICB0ZW1wOiBldmVudC5ib2R5LnRlbXAsXG4gICAgICBodW1pZGl0eTogZXZlbnQuYm9keS5odW1pZGl0eSxcbiAgICAgIHByZXNzdXJlOiBldmVudC5ib2R5LnByZXNzdXJlLFxuICAgICAgLy8gTm90ZTogdm9sdGFnZSBpcyBubyBsb25nZXIgc2VudCBpbiB0cmFjay5xbzsgdXNlIGxhc3Rfdm9sdGFnZSBmcm9tIF9sb2cucW8vX2hlYWx0aC5xb1xuICAgICAgbW90aW9uOiBldmVudC5ib2R5Lm1vdGlvbixcbiAgICAgIHRpbWVzdGFtcDogZXZlbnQudGltZXN0YW1wLFxuICAgIH07XG4gIH1cblxuICBpZiAoZXZlbnQuZXZlbnRfdHlwZSA9PT0gJ19sb2cucW8nKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3Bvd2VyID0gOnBvd2VyJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjcG93ZXInXSA9ICdsYXN0X3Bvd2VyJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6cG93ZXInXSA9IHtcbiAgICAgIHZvbHRhZ2U6IGV2ZW50LmJvZHkudm9sdGFnZSxcbiAgICAgIHRlbXBlcmF0dXJlOiBldmVudC5ib2R5LnRlbXBlcmF0dXJlLFxuICAgICAgbWlsbGlhbXBfaG91cnM6IGV2ZW50LmJvZHkubWlsbGlhbXBfaG91cnMsXG4gICAgICB0aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCxcbiAgICB9O1xuICAgIC8vIFVwZGF0ZSBkZXZpY2Ugdm9sdGFnZSBmcm9tIE1vam8gcG93ZXIgbW9uaXRvcmluZ1xuICAgIGlmIChldmVudC5ib2R5LnZvbHRhZ2UgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3ZvbHRhZ2UgPSA6dm9sdGFnZScpO1xuICAgICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjdm9sdGFnZSddID0gJ3ZvbHRhZ2UnO1xuICAgICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnZvbHRhZ2UnXSA9IGV2ZW50LmJvZHkudm9sdGFnZTtcbiAgICB9XG4gIH1cblxuICAvLyBVcGRhdGUgZmlybXdhcmUgdmVyc2lvbnMgZnJvbSBfc2Vzc2lvbi5xbyBldmVudHNcbiAgaWYgKGV2ZW50LnNlc3Npb24/LmZpcm13YXJlX3ZlcnNpb24pIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjZndfdmVyc2lvbiA9IDpmd192ZXJzaW9uJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjZndfdmVyc2lvbiddID0gJ2Zpcm13YXJlX3ZlcnNpb24nO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpmd192ZXJzaW9uJ10gPSBldmVudC5zZXNzaW9uLmZpcm13YXJlX3ZlcnNpb247XG4gIH1cblxuICBpZiAoZXZlbnQuc2Vzc2lvbj8ubm90ZWNhcmRfdmVyc2lvbikge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNuY192ZXJzaW9uID0gOm5jX3ZlcnNpb24nKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNuY192ZXJzaW9uJ10gPSAnbm90ZWNhcmRfdmVyc2lvbic7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOm5jX3ZlcnNpb24nXSA9IGV2ZW50LnNlc3Npb24ubm90ZWNhcmRfdmVyc2lvbjtcbiAgfVxuXG4gIGlmIChldmVudC5zZXNzaW9uPy5ub3RlY2FyZF9za3UpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjbmNfc2t1ID0gOm5jX3NrdScpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI25jX3NrdSddID0gJ25vdGVjYXJkX3NrdSc7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOm5jX3NrdSddID0gZXZlbnQuc2Vzc2lvbi5ub3RlY2FyZF9za3U7XG4gIH1cblxuICAvLyBVcGRhdGUgVVNCIHBvd2VyIHN0YXR1cyBmcm9tIF9zZXNzaW9uLnFvIGV2ZW50c1xuICBpZiAoZXZlbnQuc2Vzc2lvbj8udXNiX3Bvd2VyZWQgIT09IHVuZGVmaW5lZCkge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyN1c2JfcG93ZXJlZCA9IDp1c2JfcG93ZXJlZCcpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3VzYl9wb3dlcmVkJ10gPSAndXNiX3Bvd2VyZWQnO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzp1c2JfcG93ZXJlZCddID0gZXZlbnQuc2Vzc2lvbi51c2JfcG93ZXJlZDtcbiAgfVxuXG4gIC8vIFVwZGF0ZSBVU0IgcG93ZXIgc3RhdHVzIGZyb20gX2hlYWx0aC5xbyB2b2x0YWdlX21vZGUgZmllbGRcbiAgLy8gVGhpcyBpcyBtb3JlIGZyZXF1ZW50bHkgcmVwb3J0ZWQgdGhhbiBfc2Vzc2lvbi5xbyBhbmQgZ2l2ZXMgcmVhbC10aW1lIHBvd2VyIHN0YXR1c1xuICBpZiAoZXZlbnQuYm9keS52b2x0YWdlX21vZGUgIT09IHVuZGVmaW5lZCkge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyN1c2JfcG93ZXJlZCA9IDp1c2JfcG93ZXJlZCcpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3VzYl9wb3dlcmVkJ10gPSAndXNiX3Bvd2VyZWQnO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzp1c2JfcG93ZXJlZCddID0gZXZlbnQuYm9keS52b2x0YWdlX21vZGUgPT09ICd1c2InO1xuICB9XG5cbiAgLy8gVXBkYXRlIGRldmljZSB2b2x0YWdlIGZyb20gX2hlYWx0aC5xbyBldmVudHMgKGZhbGxiYWNrIHdoZW4gTW9qbyBpcyBub3QgYXZhaWxhYmxlKVxuICAvLyBPbmx5IHVwZGF0ZSBpZiB3ZSBoYXZlbid0IGFscmVhZHkgc2V0IHZvbHRhZ2UgZnJvbSBfbG9nLnFvIGluIHRoaXMgZXZlbnRcbiAgaWYgKGV2ZW50LmV2ZW50X3R5cGUgPT09ICdfaGVhbHRoLnFvJyAmJiBldmVudC5ib2R5LnZvbHRhZ2UgIT09IHVuZGVmaW5lZCAmJiAhZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnZvbHRhZ2UnXSkge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyN2b2x0YWdlID0gOnZvbHRhZ2UnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyN2b2x0YWdlJ10gPSAndm9sdGFnZSc7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnZvbHRhZ2UnXSA9IGV2ZW50LmJvZHkudm9sdGFnZTtcbiAgfVxuXG4gIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNjcmVhdGVkX2F0ID0gaWZfbm90X2V4aXN0cygjY3JlYXRlZF9hdCwgOmNyZWF0ZWRfYXQpJyk7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI2NyZWF0ZWRfYXQnXSA9ICdjcmVhdGVkX2F0JztcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOmNyZWF0ZWRfYXQnXSA9IG5vdztcblxuICBjb25zdCBjb21tYW5kID0gbmV3IFVwZGF0ZUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICBLZXk6IHsgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCB9LFxuICAgIFVwZGF0ZUV4cHJlc3Npb246ICdTRVQgJyArIHVwZGF0ZUV4cHJlc3Npb25zLmpvaW4oJywgJyksXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiBleHByZXNzaW9uQXR0cmlidXRlTmFtZXMsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczogZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlcyxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBVcGRhdGVkIGRldmljZSBtZXRhZGF0YSBmb3IgJHtldmVudC5kZXZpY2VfdWlkfWApO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwcm9jZXNzQ29tbWFuZEFjayhldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBjbWRJZCA9IGV2ZW50LmJvZHkuY21kX2lkO1xuICBpZiAoIWNtZElkKSB7XG4gICAgY29uc29sZS5sb2coJ0NvbW1hbmQgYWNrIG1pc3NpbmcgY21kX2lkLCBza2lwcGluZycpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBVcGRhdGVDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IENPTU1BTkRTX1RBQkxFLFxuICAgIEtleToge1xuICAgICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICAgIGNvbW1hbmRfaWQ6IGNtZElkLFxuICAgIH0sXG4gICAgVXBkYXRlRXhwcmVzc2lvbjogJ1NFVCAjc3RhdHVzID0gOnN0YXR1cywgI21lc3NhZ2UgPSA6bWVzc2FnZSwgI2V4ZWN1dGVkX2F0ID0gOmV4ZWN1dGVkX2F0LCAjdXBkYXRlZF9hdCA9IDp1cGRhdGVkX2F0JyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICcjc3RhdHVzJzogJ3N0YXR1cycsXG4gICAgICAnI21lc3NhZ2UnOiAnbWVzc2FnZScsXG4gICAgICAnI2V4ZWN1dGVkX2F0JzogJ2V4ZWN1dGVkX2F0JyxcbiAgICAgICcjdXBkYXRlZF9hdCc6ICd1cGRhdGVkX2F0JyxcbiAgICB9LFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6c3RhdHVzJzogZXZlbnQuYm9keS5zdGF0dXMgfHwgJ3Vua25vd24nLFxuICAgICAgJzptZXNzYWdlJzogZXZlbnQuYm9keS5tZXNzYWdlIHx8ICcnLFxuICAgICAgJzpleGVjdXRlZF9hdCc6IGV2ZW50LmJvZHkuZXhlY3V0ZWRfYXQgPyBldmVudC5ib2R5LmV4ZWN1dGVkX2F0ICogMTAwMCA6IG5vdyxcbiAgICAgICc6dXBkYXRlZF9hdCc6IG5vdyxcbiAgICB9LFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFVwZGF0ZWQgY29tbWFuZCAke2NtZElkfSB3aXRoIHN0YXR1czogJHtldmVudC5ib2R5LnN0YXR1c31gKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc3RvcmVBbGVydChldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKG5vdyAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgLy8gR2VuZXJhdGUgYSB1bmlxdWUgYWxlcnQgSURcbiAgY29uc3QgYWxlcnRJZCA9IGBhbGVydF8ke2V2ZW50LmRldmljZV91aWR9XyR7bm93fV8ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnN1YnN0cmluZyg3KX1gO1xuXG4gIGNvbnN0IGFsZXJ0UmVjb3JkID0ge1xuICAgIGFsZXJ0X2lkOiBhbGVydElkLFxuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgICB0eXBlOiBldmVudC5ib2R5LnR5cGUgfHwgJ3Vua25vd24nLFxuICAgIHZhbHVlOiBldmVudC5ib2R5LnZhbHVlLFxuICAgIHRocmVzaG9sZDogZXZlbnQuYm9keS50aHJlc2hvbGQsXG4gICAgbWVzc2FnZTogZXZlbnQuYm9keS5tZXNzYWdlIHx8ICcnLFxuICAgIGNyZWF0ZWRfYXQ6IG5vdyxcbiAgICBldmVudF90aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDAsXG4gICAgYWNrbm93bGVkZ2VkOiAnZmFsc2UnLCAvLyBTdHJpbmcgZm9yIEdTSSBwYXJ0aXRpb24ga2V5XG4gICAgdHRsLFxuICAgIGxvY2F0aW9uOiBldmVudC5sb2NhdGlvbiA/IHtcbiAgICAgIGxhdDogZXZlbnQubG9jYXRpb24ubGF0LFxuICAgICAgbG9uOiBldmVudC5sb2NhdGlvbi5sb24sXG4gICAgfSA6IHVuZGVmaW5lZCxcbiAgfTtcblxuICBjb25zdCBjb21tYW5kID0gbmV3IFB1dENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogQUxFUlRTX1RBQkxFLFxuICAgIEl0ZW06IGFsZXJ0UmVjb3JkLFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFN0b3JlZCBhbGVydCAke2FsZXJ0SWR9IGZvciAke2V2ZW50LmRldmljZV91aWR9YCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHB1Ymxpc2hBbGVydChldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBhbGVydE1lc3NhZ2UgPSB7XG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyLFxuICAgIGZsZWV0OiBldmVudC5mbGVldCxcbiAgICBhbGVydF90eXBlOiBldmVudC5ib2R5LnR5cGUsXG4gICAgdmFsdWU6IGV2ZW50LmJvZHkudmFsdWUsXG4gICAgdGhyZXNob2xkOiBldmVudC5ib2R5LnRocmVzaG9sZCxcbiAgICBtZXNzYWdlOiBldmVudC5ib2R5Lm1lc3NhZ2UsXG4gICAgdGltZXN0YW1wOiBldmVudC50aW1lc3RhbXAsXG4gICAgbG9jYXRpb246IGV2ZW50LmxvY2F0aW9uLFxuICB9O1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHVibGlzaENvbW1hbmQoe1xuICAgIFRvcGljQXJuOiBBTEVSVF9UT1BJQ19BUk4sXG4gICAgU3ViamVjdDogYFNvbmdiaXJkIEFsZXJ0OiAke2V2ZW50LmJvZHkudHlwZX0gLSAke2V2ZW50LnNlcmlhbF9udW1iZXIgfHwgZXZlbnQuZGV2aWNlX3VpZH1gLFxuICAgIE1lc3NhZ2U6IEpTT04uc3RyaW5naWZ5KGFsZXJ0TWVzc2FnZSwgbnVsbCwgMiksXG4gICAgTWVzc2FnZUF0dHJpYnV0ZXM6IHtcbiAgICAgIGFsZXJ0X3R5cGU6IHtcbiAgICAgICAgRGF0YVR5cGU6ICdTdHJpbmcnLFxuICAgICAgICBTdHJpbmdWYWx1ZTogZXZlbnQuYm9keS50eXBlIHx8ICd1bmtub3duJyxcbiAgICAgIH0sXG4gICAgICBkZXZpY2VfdWlkOiB7XG4gICAgICAgIERhdGFUeXBlOiAnU3RyaW5nJyxcbiAgICAgICAgU3RyaW5nVmFsdWU6IGV2ZW50LmRldmljZV91aWQsXG4gICAgICB9LFxuICAgICAgZmxlZXQ6IHtcbiAgICAgICAgRGF0YVR5cGU6ICdTdHJpbmcnLFxuICAgICAgICBTdHJpbmdWYWx1ZTogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICAgICAgfSxcbiAgICB9LFxuICB9KTtcblxuICBhd2FpdCBzbnNDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFB1Ymxpc2hlZCBhbGVydCB0byBTTlM6ICR7ZXZlbnQuYm9keS50eXBlfWApO1xufVxuXG4vKipcbiAqIFdyaXRlIEdQUyB0cmFja2luZyBldmVudCB0byB0ZWxlbWV0cnkgdGFibGVcbiAqIEhhbmRsZXMgX3RyYWNrLnFvIGV2ZW50cyBmcm9tIE5vdGVjYXJkJ3MgY2FyZC5sb2NhdGlvbi50cmFja1xuICovXG5hc3luYyBmdW5jdGlvbiB3cml0ZVRyYWNraW5nRXZlbnQoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKCFldmVudC5sb2NhdGlvbj8ubGF0IHx8ICFldmVudC5sb2NhdGlvbj8ubG9uKSB7XG4gICAgY29uc29sZS5sb2coJ05vIGxvY2F0aW9uIGRhdGEgaW4gX3RyYWNrLnFvIGV2ZW50LCBza2lwcGluZycpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHRpbWVzdGFtcCA9IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDA7IC8vIENvbnZlcnQgdG8gbWlsbGlzZWNvbmRzXG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgY29uc3QgcmVjb3JkOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge1xuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgdGltZXN0YW1wLFxuICAgIHR0bCxcbiAgICBkYXRhX3R5cGU6ICd0cmFja2luZycsXG4gICAgZXZlbnRfdHlwZTogZXZlbnQuZXZlbnRfdHlwZSxcbiAgICBldmVudF90eXBlX3RpbWVzdGFtcDogYHRyYWNraW5nIyR7dGltZXN0YW1wfWAsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgICBsYXRpdHVkZTogZXZlbnQubG9jYXRpb24ubGF0LFxuICAgIGxvbmdpdHVkZTogZXZlbnQubG9jYXRpb24ubG9uLFxuICAgIGxvY2F0aW9uX3NvdXJjZTogZXZlbnQubG9jYXRpb24uc291cmNlIHx8ICdncHMnLFxuICB9O1xuXG4gIC8vIEFkZCB0cmFja2luZy1zcGVjaWZpYyBmaWVsZHNcbiAgaWYgKGV2ZW50LmJvZHkudmVsb2NpdHkgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC52ZWxvY2l0eSA9IGV2ZW50LmJvZHkudmVsb2NpdHk7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuYmVhcmluZyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLmJlYXJpbmcgPSBldmVudC5ib2R5LmJlYXJpbmc7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuZGlzdGFuY2UgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5kaXN0YW5jZSA9IGV2ZW50LmJvZHkuZGlzdGFuY2U7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuc2Vjb25kcyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnNlY29uZHMgPSBldmVudC5ib2R5LnNlY29uZHM7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuZG9wICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQuZG9wID0gZXZlbnQuYm9keS5kb3A7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuam91cm5leSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLmpvdXJuZXlfaWQgPSBldmVudC5ib2R5LmpvdXJuZXk7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuamNvdW50ICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQuamNvdW50ID0gZXZlbnQuYm9keS5qY291bnQ7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkubW90aW9uICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQubW90aW9uID0gZXZlbnQuYm9keS5tb3Rpb247XG4gIH1cblxuICBjb25zdCBjb21tYW5kID0gbmV3IFB1dENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogVEVMRU1FVFJZX1RBQkxFLFxuICAgIEl0ZW06IHJlY29yZCxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBXcm90ZSB0cmFja2luZyBldmVudCBmb3IgJHtldmVudC5kZXZpY2VfdWlkfSAoam91cm5leTogJHtldmVudC5ib2R5LmpvdXJuZXl9LCBqY291bnQ6ICR7ZXZlbnQuYm9keS5qY291bnR9KWApO1xufVxuXG4vKipcbiAqIFVwc2VydCBqb3VybmV5IHJlY29yZFxuICogLSBDcmVhdGVzIG5ldyBqb3VybmV5IHdoZW4gamNvdW50ID09PSAxXG4gKiAtIFVwZGF0ZXMgZXhpc3Rpbmcgam91cm5leSB3aXRoIG5ldyBlbmRfdGltZSBhbmQgcG9pbnRfY291bnRcbiAqIC0gTWFya3MgcHJldmlvdXMgam91cm5leSBhcyBjb21wbGV0ZWQgd2hlbiBhIG5ldyBvbmUgc3RhcnRzXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHVwc2VydEpvdXJuZXkoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgam91cm5leUlkID0gZXZlbnQuYm9keS5qb3VybmV5O1xuICBjb25zdCBqY291bnQgPSBldmVudC5ib2R5Lmpjb3VudDtcblxuICBpZiAoIWpvdXJuZXlJZCB8fCAhamNvdW50KSB7XG4gICAgY29uc29sZS5sb2coJ01pc3Npbmcgam91cm5leSBvciBqY291bnQgaW4gX3RyYWNrLnFvIGV2ZW50LCBza2lwcGluZyBqb3VybmV5IHVwc2VydCcpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG4gIGNvbnN0IHRpbWVzdGFtcE1zID0gZXZlbnQudGltZXN0YW1wICogMTAwMDtcblxuICAvLyBJZiB0aGlzIGlzIHRoZSBmaXJzdCBwb2ludCBvZiBhIG5ldyBqb3VybmV5LCBtYXJrIHByZXZpb3VzIGpvdXJuZXkgYXMgY29tcGxldGVkXG4gIGlmIChqY291bnQgPT09IDEpIHtcbiAgICBhd2FpdCBtYXJrUHJldmlvdXNKb3VybmV5Q29tcGxldGVkKGV2ZW50LmRldmljZV91aWQsIGpvdXJuZXlJZCk7XG4gIH1cblxuICAvLyBDYWxjdWxhdGUgY3VtdWxhdGl2ZSBkaXN0YW5jZVxuICBjb25zdCBkaXN0YW5jZSA9IGV2ZW50LmJvZHkuZGlzdGFuY2UgfHwgMDtcblxuICAvLyBVcHNlcnQgam91cm5leSByZWNvcmRcbiAgY29uc3QgY29tbWFuZCA9IG5ldyBVcGRhdGVDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IEpPVVJORVlTX1RBQkxFLFxuICAgIEtleToge1xuICAgICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICAgIGpvdXJuZXlfaWQ6IGpvdXJuZXlJZCxcbiAgICB9LFxuICAgIFVwZGF0ZUV4cHJlc3Npb246IGBcbiAgICAgIFNFVCAjc3RhdHVzID0gOnN0YXR1cyxcbiAgICAgICAgICAjc3RhcnRfdGltZSA9IGlmX25vdF9leGlzdHMoI3N0YXJ0X3RpbWUsIDpzdGFydF90aW1lKSxcbiAgICAgICAgICAjZW5kX3RpbWUgPSA6ZW5kX3RpbWUsXG4gICAgICAgICAgI3BvaW50X2NvdW50ID0gOnBvaW50X2NvdW50LFxuICAgICAgICAgICN0b3RhbF9kaXN0YW5jZSA9IGlmX25vdF9leGlzdHMoI3RvdGFsX2Rpc3RhbmNlLCA6emVybykgKyA6ZGlzdGFuY2UsXG4gICAgICAgICAgI3R0bCA9IDp0dGwsXG4gICAgICAgICAgI3VwZGF0ZWRfYXQgPSA6dXBkYXRlZF9hdFxuICAgIGAsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAnI3N0YXR1cyc6ICdzdGF0dXMnLFxuICAgICAgJyNzdGFydF90aW1lJzogJ3N0YXJ0X3RpbWUnLFxuICAgICAgJyNlbmRfdGltZSc6ICdlbmRfdGltZScsXG4gICAgICAnI3BvaW50X2NvdW50JzogJ3BvaW50X2NvdW50JyxcbiAgICAgICcjdG90YWxfZGlzdGFuY2UnOiAndG90YWxfZGlzdGFuY2UnLFxuICAgICAgJyN0dGwnOiAndHRsJyxcbiAgICAgICcjdXBkYXRlZF9hdCc6ICd1cGRhdGVkX2F0JyxcbiAgICB9LFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6c3RhdHVzJzogJ2FjdGl2ZScsXG4gICAgICAnOnN0YXJ0X3RpbWUnOiBqb3VybmV5SWQgKiAxMDAwLCAvLyBDb252ZXJ0IHRvIG1pbGxpc2Vjb25kc1xuICAgICAgJzplbmRfdGltZSc6IHRpbWVzdGFtcE1zLFxuICAgICAgJzpwb2ludF9jb3VudCc6IGpjb3VudCxcbiAgICAgICc6ZGlzdGFuY2UnOiBkaXN0YW5jZSxcbiAgICAgICc6emVybyc6IDAsXG4gICAgICAnOnR0bCc6IHR0bCxcbiAgICAgICc6dXBkYXRlZF9hdCc6IG5vdyxcbiAgICB9LFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFVwc2VydGVkIGpvdXJuZXkgJHtqb3VybmV5SWR9IGZvciAke2V2ZW50LmRldmljZV91aWR9IChwb2ludCAke2pjb3VudH0pYCk7XG59XG5cbi8qKlxuICogTWFyayBwcmV2aW91cyBqb3VybmV5IGFzIGNvbXBsZXRlZCB3aGVuIGEgbmV3IGpvdXJuZXkgc3RhcnRzXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIG1hcmtQcmV2aW91c0pvdXJuZXlDb21wbGV0ZWQoZGV2aWNlVWlkOiBzdHJpbmcsIGN1cnJlbnRKb3VybmV5SWQ6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICAvLyBRdWVyeSBmb3IgdGhlIG1vc3QgcmVjZW50IGFjdGl2ZSBqb3VybmV5IHRoYXQncyBub3QgdGhlIGN1cnJlbnQgb25lXG4gIGNvbnN0IHF1ZXJ5Q29tbWFuZCA9IG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogSk9VUk5FWVNfVEFCTEUsXG4gICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQgPSA6ZGV2aWNlX3VpZCBBTkQgam91cm5leV9pZCA8IDpjdXJyZW50X2pvdXJuZXknLFxuICAgIEZpbHRlckV4cHJlc3Npb246ICcjc3RhdHVzID0gOmFjdGl2ZScsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAnI3N0YXR1cyc6ICdzdGF0dXMnLFxuICAgIH0sXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgJzpjdXJyZW50X2pvdXJuZXknOiBjdXJyZW50Sm91cm5leUlkLFxuICAgICAgJzphY3RpdmUnOiAnYWN0aXZlJyxcbiAgICB9LFxuICAgIFNjYW5JbmRleEZvcndhcmQ6IGZhbHNlLCAvLyBNb3N0IHJlY2VudCBmaXJzdFxuICAgIExpbWl0OiAxLFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChxdWVyeUNvbW1hbmQpO1xuXG4gIGlmIChyZXN1bHQuSXRlbXMgJiYgcmVzdWx0Lkl0ZW1zLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBwcmV2aW91c0pvdXJuZXkgPSByZXN1bHQuSXRlbXNbMF07XG5cbiAgICBjb25zdCB1cGRhdGVDb21tYW5kID0gbmV3IFVwZGF0ZUNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICAgIEtleToge1xuICAgICAgICBkZXZpY2VfdWlkOiBkZXZpY2VVaWQsXG4gICAgICAgIGpvdXJuZXlfaWQ6IHByZXZpb3VzSm91cm5leS5qb3VybmV5X2lkLFxuICAgICAgfSxcbiAgICAgIFVwZGF0ZUV4cHJlc3Npb246ICdTRVQgI3N0YXR1cyA9IDpzdGF0dXMsICN1cGRhdGVkX2F0ID0gOnVwZGF0ZWRfYXQnLFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAgICcjc3RhdHVzJzogJ3N0YXR1cycsXG4gICAgICAgICcjdXBkYXRlZF9hdCc6ICd1cGRhdGVkX2F0JyxcbiAgICAgIH0sXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICc6c3RhdHVzJzogJ2NvbXBsZXRlZCcsXG4gICAgICAgICc6dXBkYXRlZF9hdCc6IERhdGUubm93KCksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgYXdhaXQgZG9jQ2xpZW50LnNlbmQodXBkYXRlQ29tbWFuZCk7XG4gICAgY29uc29sZS5sb2coYE1hcmtlZCBqb3VybmV5ICR7cHJldmlvdXNKb3VybmV5LmpvdXJuZXlfaWR9IGFzIGNvbXBsZXRlZCBmb3IgJHtkZXZpY2VVaWR9YCk7XG4gIH1cbn1cblxuLyoqXG4gKiBXcml0ZSBsb2NhdGlvbiB0byB0aGUgbG9jYXRpb25zIGhpc3RvcnkgdGFibGVcbiAqIFJlY29yZHMgYWxsIGxvY2F0aW9uIGV2ZW50cyByZWdhcmRsZXNzIG9mIHNvdXJjZSBmb3IgdW5pZmllZCBsb2NhdGlvbiBoaXN0b3J5XG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlTG9jYXRpb25IaXN0b3J5KGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmICghZXZlbnQubG9jYXRpb24/LmxhdCB8fCAhZXZlbnQubG9jYXRpb24/Lmxvbikge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHRpbWVzdGFtcCA9IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDA7IC8vIENvbnZlcnQgdG8gbWlsbGlzZWNvbmRzXG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgY29uc3QgcmVjb3JkOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge1xuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgdGltZXN0YW1wLFxuICAgIHR0bCxcbiAgICBsYXRpdHVkZTogZXZlbnQubG9jYXRpb24ubGF0LFxuICAgIGxvbmdpdHVkZTogZXZlbnQubG9jYXRpb24ubG9uLFxuICAgIHNvdXJjZTogZXZlbnQubG9jYXRpb24uc291cmNlIHx8ICd1bmtub3duJyxcbiAgICBsb2NhdGlvbl9uYW1lOiBldmVudC5sb2NhdGlvbi5uYW1lLFxuICAgIGV2ZW50X3R5cGU6IGV2ZW50LmV2ZW50X3R5cGUsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgfTtcblxuICAvLyBBZGQgam91cm5leSBpbmZvIGlmIHRoaXMgaXMgYSB0cmFja2luZyBldmVudFxuICBpZiAoZXZlbnQuZXZlbnRfdHlwZSA9PT0gJ190cmFjay5xbycpIHtcbiAgICBpZiAoZXZlbnQuYm9keS5qb3VybmV5ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHJlY29yZC5qb3VybmV5X2lkID0gZXZlbnQuYm9keS5qb3VybmV5O1xuICAgIH1cbiAgICBpZiAoZXZlbnQuYm9keS5qY291bnQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgcmVjb3JkLmpjb3VudCA9IGV2ZW50LmJvZHkuamNvdW50O1xuICAgIH1cbiAgICBpZiAoZXZlbnQuYm9keS52ZWxvY2l0eSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICByZWNvcmQudmVsb2NpdHkgPSBldmVudC5ib2R5LnZlbG9jaXR5O1xuICAgIH1cbiAgICBpZiAoZXZlbnQuYm9keS5iZWFyaW5nICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHJlY29yZC5iZWFyaW5nID0gZXZlbnQuYm9keS5iZWFyaW5nO1xuICAgIH1cbiAgICBpZiAoZXZlbnQuYm9keS5kaXN0YW5jZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICByZWNvcmQuZGlzdGFuY2UgPSBldmVudC5ib2R5LmRpc3RhbmNlO1xuICAgIH1cbiAgICBpZiAoZXZlbnQuYm9keS5kb3AgIT09IHVuZGVmaW5lZCkge1xuICAgICAgcmVjb3JkLmRvcCA9IGV2ZW50LmJvZHkuZG9wO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBMT0NBVElPTlNfVEFCTEUsXG4gICAgSXRlbTogcmVjb3JkLFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFdyb3RlIGxvY2F0aW9uIGhpc3RvcnkgZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH06ICR7ZXZlbnQubG9jYXRpb24uc291cmNlfSAoJHtldmVudC5sb2NhdGlvbi5sYXR9LCAke2V2ZW50LmxvY2F0aW9uLmxvbn0pYCk7XG59XG5cbi8qKlxuICogQ29tcGxldGUgYWxsIGFjdGl2ZSBqb3VybmV5cyB3aGVuIGRldmljZSBleGl0cyB0cmFuc2l0IG1vZGVcbiAqIFRoaXMgZW5zdXJlcyBqb3VybmV5cyBhcmUgcHJvcGVybHkgY2xvc2VkIHdoZW4gbW9kZSBjaGFuZ2VzIHRvIGRlbW8sIHN0b3JhZ2UsIG9yIHNsZWVwXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNvbXBsZXRlQWN0aXZlSm91cm5leXNPbk1vZGVDaGFuZ2UoZGV2aWNlVWlkOiBzdHJpbmcsIG5ld01vZGU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAvLyBRdWVyeSBmb3IgYWxsIGFjdGl2ZSBqb3VybmV5cyBmb3IgdGhpcyBkZXZpY2VcbiAgY29uc3QgcXVlcnlDb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICBJbmRleE5hbWU6ICdzdGF0dXMtaW5kZXgnLFxuICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICcjc3RhdHVzID0gOmFjdGl2ZScsXG4gICAgRmlsdGVyRXhwcmVzc2lvbjogJ2RldmljZV91aWQgPSA6ZGV2aWNlX3VpZCcsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAnI3N0YXR1cyc6ICdzdGF0dXMnLFxuICAgIH0sXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzphY3RpdmUnOiAnYWN0aXZlJyxcbiAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICB9LFxuICB9KTtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKHF1ZXJ5Q29tbWFuZCk7XG5cbiAgICBpZiAocmVzdWx0Lkl0ZW1zICYmIHJlc3VsdC5JdGVtcy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zb2xlLmxvZyhgTW9kZSBjaGFuZ2VkIHRvICR7bmV3TW9kZX0gLSBjb21wbGV0aW5nICR7cmVzdWx0Lkl0ZW1zLmxlbmd0aH0gYWN0aXZlIGpvdXJuZXkocykgZm9yICR7ZGV2aWNlVWlkfWApO1xuXG4gICAgICAvLyBNYXJrIGVhY2ggYWN0aXZlIGpvdXJuZXkgYXMgY29tcGxldGVkXG4gICAgICBmb3IgKGNvbnN0IGpvdXJuZXkgb2YgcmVzdWx0Lkl0ZW1zKSB7XG4gICAgICAgIGNvbnN0IHVwZGF0ZUNvbW1hbmQgPSBuZXcgVXBkYXRlQ29tbWFuZCh7XG4gICAgICAgICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICAgICAgICBLZXk6IHtcbiAgICAgICAgICAgIGRldmljZV91aWQ6IGRldmljZVVpZCxcbiAgICAgICAgICAgIGpvdXJuZXlfaWQ6IGpvdXJuZXkuam91cm5leV9pZCxcbiAgICAgICAgICB9LFxuICAgICAgICAgIFVwZGF0ZUV4cHJlc3Npb246ICdTRVQgI3N0YXR1cyA9IDpzdGF0dXMsICN1cGRhdGVkX2F0ID0gOnVwZGF0ZWRfYXQnLFxuICAgICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczoge1xuICAgICAgICAgICAgJyNzdGF0dXMnOiAnc3RhdHVzJyxcbiAgICAgICAgICAgICcjdXBkYXRlZF9hdCc6ICd1cGRhdGVkX2F0JyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgICAgICc6c3RhdHVzJzogJ2NvbXBsZXRlZCcsXG4gICAgICAgICAgICAnOnVwZGF0ZWRfYXQnOiBEYXRlLm5vdygpLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGF3YWl0IGRvY0NsaWVudC5zZW5kKHVwZGF0ZUNvbW1hbmQpO1xuICAgICAgICBjb25zb2xlLmxvZyhgTWFya2VkIGpvdXJuZXkgJHtqb3VybmV5LmpvdXJuZXlfaWR9IGFzIGNvbXBsZXRlZCBkdWUgdG8gbW9kZSBjaGFuZ2UgdG8gJHtuZXdNb2RlfWApO1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAvLyBMb2cgYnV0IGRvbid0IGZhaWwgdGhlIHJlcXVlc3QgLSBqb3VybmV5IGNvbXBsZXRpb24gaXMgbm90IGNyaXRpY2FsXG4gICAgY29uc29sZS5lcnJvcihgRXJyb3IgY29tcGxldGluZyBhY3RpdmUgam91cm5leXMgb24gbW9kZSBjaGFuZ2U6ICR7ZXJyb3J9YCk7XG4gIH1cbn1cblxuLyoqXG4gKiBDaGVjayBpZiBtb2RlIGhhcyBjaGFuZ2VkIGFuZCB3cml0ZSBhIG1vZGVfY2hhbmdlIGV2ZW50IHRvIHRlbGVtZXRyeSB0YWJsZVxuICogVGhpcyBhbGxvd3MgdGhlIGFjdGl2aXR5IGZlZWQgdG8gc2hvdyBtb2RlIGNoYW5nZXNcbiAqL1xuYXN5bmMgZnVuY3Rpb24gdHJhY2tNb2RlQ2hhbmdlKGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmICghZXZlbnQuYm9keS5tb2RlKSB7XG4gICAgcmV0dXJuOyAvLyBObyBtb2RlIGluIGV2ZW50LCBub3RoaW5nIHRvIHRyYWNrXG4gIH1cblxuICB0cnkge1xuICAgIC8vIEdldCBjdXJyZW50IGRldmljZSBtb2RlIGZyb20gZGV2aWNlcyB0YWJsZVxuICAgIGNvbnN0IGdldENvbW1hbmQgPSBuZXcgR2V0Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IERFVklDRVNfVEFCTEUsXG4gICAgICBLZXk6IHsgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCB9LFxuICAgICAgUHJvamVjdGlvbkV4cHJlc3Npb246ICdjdXJyZW50X21vZGUnLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoZ2V0Q29tbWFuZCk7XG4gICAgY29uc3QgcHJldmlvdXNNb2RlID0gcmVzdWx0Lkl0ZW0/LmN1cnJlbnRfbW9kZTtcblxuICAgIC8vIElmIG1vZGUgaGFzIGNoYW5nZWQgKG9yIGRldmljZSBpcyBuZXcpLCByZWNvcmQgdGhlIGNoYW5nZVxuICAgIGlmIChwcmV2aW91c01vZGUgJiYgcHJldmlvdXNNb2RlICE9PSBldmVudC5ib2R5Lm1vZGUpIHtcbiAgICAgIGNvbnN0IHRpbWVzdGFtcCA9IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDA7IC8vIENvbnZlcnQgdG8gbWlsbGlzZWNvbmRzXG4gICAgICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSArIFRUTF9TRUNPTkRTO1xuXG4gICAgICBjb25zdCByZWNvcmQ6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgICAgIHRpbWVzdGFtcCxcbiAgICAgICAgdHRsLFxuICAgICAgICBkYXRhX3R5cGU6ICdtb2RlX2NoYW5nZScsXG4gICAgICAgIGV2ZW50X3R5cGU6IGV2ZW50LmV2ZW50X3R5cGUsXG4gICAgICAgIGV2ZW50X3R5cGVfdGltZXN0YW1wOiBgbW9kZV9jaGFuZ2UjJHt0aW1lc3RhbXB9YCxcbiAgICAgICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgICAgIGZsZWV0OiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gICAgICAgIHByZXZpb3VzX21vZGU6IHByZXZpb3VzTW9kZSxcbiAgICAgICAgbmV3X21vZGU6IGV2ZW50LmJvZHkubW9kZSxcbiAgICAgIH07XG5cbiAgICAgIGNvbnN0IHB1dENvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgICAgIFRhYmxlTmFtZTogVEVMRU1FVFJZX1RBQkxFLFxuICAgICAgICBJdGVtOiByZWNvcmQsXG4gICAgICB9KTtcblxuICAgICAgYXdhaXQgZG9jQ2xpZW50LnNlbmQocHV0Q29tbWFuZCk7XG4gICAgICBjb25zb2xlLmxvZyhgUmVjb3JkZWQgbW9kZSBjaGFuZ2UgZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH06ICR7cHJldmlvdXNNb2RlfSAtPiAke2V2ZW50LmJvZHkubW9kZX1gKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgLy8gTG9nIGJ1dCBkb24ndCBmYWlsIHRoZSByZXF1ZXN0IC0gbW9kZSB0cmFja2luZyBpcyBub3QgY3JpdGljYWxcbiAgICBjb25zb2xlLmVycm9yKGBFcnJvciB0cmFja2luZyBtb2RlIGNoYW5nZTogJHtlcnJvcn1gKTtcbiAgfVxufVxuIl19