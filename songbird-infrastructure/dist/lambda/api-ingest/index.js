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
    // Update USB power status from _session.qo events
    if (event.session?.usb_powered !== undefined) {
        updateExpressions.push('#usb_powered = :usb_powered');
        expressionAttributeNames['#usb_powered'] = 'usb_powered';
        expressionAttributeValues[':usb_powered'] = event.session.usb_powered;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWluZ2VzdC9pbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7O0dBS0c7OztBQUVILDhEQUEwRDtBQUMxRCx3REFBd0c7QUFDeEcsb0RBQWdFO0FBR2hFLHFCQUFxQjtBQUNyQixNQUFNLFNBQVMsR0FBRyxJQUFJLGdDQUFjLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDekMsTUFBTSxTQUFTLEdBQUcscUNBQXNCLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRTtJQUN2RCxlQUFlLEVBQUU7UUFDZixxQkFBcUIsRUFBRSxJQUFJO0tBQzVCO0NBQ0YsQ0FBQyxDQUFDO0FBQ0gsTUFBTSxTQUFTLEdBQUcsSUFBSSxzQkFBUyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBRXBDLHdCQUF3QjtBQUN4QixNQUFNLGVBQWUsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGVBQWdCLENBQUM7QUFDckQsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxhQUFjLENBQUM7QUFDakQsTUFBTSxjQUFjLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFlLENBQUM7QUFDbkQsTUFBTSxZQUFZLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxZQUFhLENBQUM7QUFDL0MsTUFBTSxlQUFlLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxlQUFnQixDQUFDO0FBQ3JELE1BQU0sY0FBYyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsY0FBZSxDQUFDO0FBQ25ELE1BQU0sZUFBZSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsZUFBZ0IsQ0FBQztBQUVyRCwwQkFBMEI7QUFDMUIsTUFBTSxRQUFRLEdBQUcsRUFBRSxDQUFDO0FBQ3BCLE1BQU0sV0FBVyxHQUFHLFFBQVEsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsQ0FBQztBQTZFckMsTUFBTSxPQUFPLEdB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T0FBTyxDQUFDLEdBQUcsQ0FBQyxtQkFBbUIsT0FBTyxpQkFBaUIsTUFBTSxDQUFDLEtBQUssQ0FBQyxNQUFNLDBCQUEwQixTQUFTLEVBQUUsQ0FBQyxDQUFDO1lBRWpILHdDQUF3QztZQUN4QyxLQUFLLE1BQU0sT0FBTyxJQUFJLE1BQU0sQ0FBQyxLQUFLLEVBQUUsQ0FBQztnQkFDbkMsTUFBTSxhQUFhLEdBQUcsSUFBSSw0QkFBYSxDQUFDO29CQUN0QyxTQUFTLEVBQUUsY0FBYztvQkFDekIsR0FBRyxFQUFFO3dCQUNILFVBQVUsRUFBRSxTQUFTO3dCQUNyQixVQUFVLEVBQUUsT0FBTyxDQUFDLFVBQVU7cUJBQy9CO29CQUNELGdCQUFnQixFQUFFLGtEQUFrRDtvQkFDcEUsd0JBQXdCLEVBQUU7d0JBQ3hCLFNBQVMsRUFBRSxRQUFRO3dCQUNuQixhQUFhLEVBQUUsWUFBWTtxQkFDNUI7b0JBQ0QseUJBQXlCLEVBQUU7d0JBQ3pCLFNBQVMsRUFBRSxXQUFXO3dCQUN0QixhQUFhLEVBQUUsSUFBSSxDQUFDLEdBQUcsRUFBRTtxQkFDMUI7aUJBQ0YsQ0FBQyxDQUFDO2dCQUVILE1BQU0sU0FBUyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQztnQkFDcEMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxrQkFBa0IsT0FBTyxDQUFDLFVBQVUsdUNBQXVDLE9BQU8sRUFBRSxDQUFDLENBQUM7WUFDcEcsQ0FBQztRQUNILENBQUM7SUFDSCxDQUFDO0lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztRQUNmLHNFQUFzRTtRQUN0RSxPQUFPLENBQUMsS0FBSyxDQUFDLG9EQUFvRCxLQUFLLEVBQUUsQ0FBQyxDQUFDO0lBQzdFLENBQUM7QUFDSCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBFdmVudCBJbmdlc3QgQVBJIExhbWJkYVxuICpcbiAqIEhUVFAgZW5kcG9pbnQgZm9yIHJlY2VpdmluZyBldmVudHMgZnJvbSBOb3RlaHViIEhUVFAgcm91dGVzLlxuICogUHJvY2Vzc2VzIGluY29taW5nIFNvbmdiaXJkIGV2ZW50cyBhbmQgd3JpdGVzIHRvIER5bmFtb0RCLlxuICovXG5cbmltcG9ydCB7IER5bmFtb0RCQ2xpZW50IH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LWR5bmFtb2RiJztcbmltcG9ydCB7IER5bmFtb0RCRG9jdW1lbnRDbGllbnQsIFB1dENvbW1hbmQsIFVwZGF0ZUNvbW1hbmQsIFF1ZXJ5Q29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2xpYi1keW5hbW9kYic7XG5pbXBvcnQgeyBTTlNDbGllbnQsIFB1Ymxpc2hDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LXNucyc7XG5pbXBvcnQgeyBBUElHYXRld2F5UHJveHlFdmVudCwgQVBJR2F0ZXdheVByb3h5UmVzdWx0IH0gZnJvbSAnYXdzLWxhbWJkYSc7XG5cbi8vIEluaXRpYWxpemUgY2xpZW50c1xuY29uc3QgZGRiQ2xpZW50ID0gbmV3IER5bmFtb0RCQ2xpZW50KHt9KTtcbmNvbnN0IGRvY0NsaWVudCA9IER5bmFtb0RCRG9jdW1lbnRDbGllbnQuZnJvbShkZGJDbGllbnQsIHtcbiAgbWFyc2hhbGxPcHRpb25zOiB7XG4gICAgcmVtb3ZlVW5kZWZpbmVkVmFsdWVzOiB0cnVlLFxuICB9LFxufSk7XG5jb25zdCBzbnNDbGllbnQgPSBuZXcgU05TQ2xpZW50KHt9KTtcblxuLy8gRW52aXJvbm1lbnQgdmFyaWFibGVzXG5jb25zdCBURUxFTUVUUllfVEFCTEUgPSBwcm9jZXNzLmVudi5URUxFTUVUUllfVEFCTEUhO1xuY29uc3QgREVWSUNFU19UQUJMRSA9IHByb2Nlc3MuZW52LkRFVklDRVNfVEFCTEUhO1xuY29uc3QgQ09NTUFORFNfVEFCTEUgPSBwcm9jZXNzLmVudi5DT01NQU5EU19UQUJMRSE7XG5jb25zdCBBTEVSVFNfVEFCTEUgPSBwcm9jZXNzLmVudi5BTEVSVFNfVEFCTEUhO1xuY29uc3QgQUxFUlRfVE9QSUNfQVJOID0gcHJvY2Vzcy5lbnYuQUxFUlRfVE9QSUNfQVJOITtcbmNvbnN0IEpPVVJORVlTX1RBQkxFID0gcHJvY2Vzcy5lbnYuSk9VUk5FWVNfVEFCTEUhO1xuY29uc3QgTE9DQVRJT05TX1RBQkxFID0gcHJvY2Vzcy5lbnYuTE9DQVRJT05TX1RBQkxFITtcblxuLy8gVFRMOiA5MCBkYXlzIGluIHNlY29uZHNcbmNvbnN0IFRUTF9EQVlTID0gOTA7XG5jb25zdCBUVExfU0VDT05EUyA9IFRUTF9EQVlTICogMjQgKiA2MCAqIDYwO1xuXG4vLyBOb3RlaHViIGV2ZW50IHN0cnVjdHVyZSAoZnJvbSBIVFRQIHJvdXRlKVxuaW50ZXJmYWNlIE5vdGVodWJFdmVudCB7XG4gIGV2ZW50OiBzdHJpbmc7ICAgICAgICAgICAvLyBlLmcuLCBcImRldjp4eHh4eCN0cmFjay5xbyMxXCJcbiAgc2Vzc2lvbjogc3RyaW5nO1xuICBiZXN0X2lkOiBzdHJpbmc7XG4gIGRldmljZTogc3RyaW5nOyAgICAgICAgICAvLyBEZXZpY2UgVUlEXG4gIHNuOiBzdHJpbmc7ICAgICAgICAgICAgICAvLyBTZXJpYWwgbnVtYmVyXG4gIHByb2R1Y3Q6IHN0cmluZztcbiAgYXBwOiBzdHJpbmc7XG4gIHJlY2VpdmVkOiBudW1iZXI7XG4gIHJlcTogc3RyaW5nOyAgICAgICAgICAgICAvLyBlLmcuLCBcIm5vdGUuYWRkXCJcbiAgd2hlbjogbnVtYmVyOyAgICAgICAgICAgIC8vIFVuaXggdGltZXN0YW1wXG4gIGZpbGU6IHN0cmluZzsgICAgICAgICAgICAvLyBlLmcuLCBcInRyYWNrLnFvXCJcbiAgYm9keToge1xuICAgIHRlbXA/OiBudW1iZXI7XG4gICAgaHVtaWRpdHk/OiBudW1iZXI7XG4gICAgcHJlc3N1cmU/OiBudW1iZXI7XG4gICAgdm9sdGFnZT86IG51bWJlcjtcbiAgICBtb3Rpb24/OiBib29sZWFuIHwgbnVtYmVyO1xuICAgIG1vZGU/OiBzdHJpbmc7XG4gICAgdHJhbnNpdF9sb2NrZWQ/OiBib29sZWFuO1xuICAgIGRlbW9fbG9ja2VkPzogYm9vbGVhbjtcbiAgICAvLyBBbGVydC1zcGVjaWZpYyBmaWVsZHNcbiAgICB0eXBlPzogc3RyaW5nO1xuICAgIHZhbHVlPzogbnVtYmVyO1xuICAgIHRocmVzaG9sZD86IG51bWJlcjtcbiAgICBtZXNzYWdlPzogc3RyaW5nO1xuICAgIC8vIENvbW1hbmQgYWNrIGZpZWxkc1xuICAgIGNtZD86IHN0cmluZztcbiAgICBzdGF0dXM/OiBzdHJpbmc7XG4gICAgZXhlY3V0ZWRfYXQ/OiBudW1iZXI7XG4gICAgLy8gTW9qbyBwb3dlciBtb25pdG9yaW5nIGZpZWxkcyAoX2xvZy5xbylcbiAgICBtaWxsaWFtcF9ob3Vycz86IG51bWJlcjtcbiAgICB0ZW1wZXJhdHVyZT86IG51bWJlcjtcbiAgICAvLyBIZWFsdGggZXZlbnQgZmllbGRzIChfaGVhbHRoLnFvKVxuICAgIG1ldGhvZD86IHN0cmluZztcbiAgICB0ZXh0Pzogc3RyaW5nO1xuICAgIHZvbHRhZ2VfbW9kZT86IHN0cmluZztcbiAgICAvLyBTZXNzaW9uIGZpZWxkcyBtYXkgYXBwZWFyIGluIGJvZHkgZm9yIF9zZXNzaW9uLnFvXG4gICAgcG93ZXJfdXNiPzogYm9vbGVhbjtcbiAgICAvLyBHUFMgdHJhY2tpbmcgZmllbGRzIChfdHJhY2sucW8pXG4gICAgdmVsb2NpdHk/OiBudW1iZXI7ICAgICAgLy8gU3BlZWQgaW4gbS9zXG4gICAgYmVhcmluZz86IG51bWJlcjsgICAgICAgLy8gRGlyZWN0aW9uIGluIGRlZ3JlZXMgZnJvbSBub3J0aFxuICAgIGRpc3RhbmNlPzogbnVtYmVyOyAgICAgIC8vIERpc3RhbmNlIGZyb20gcHJldmlvdXMgcG9pbnQgaW4gbWV0ZXJzXG4gICAgc2Vjb25kcz86IG51bWJlcjsgICAgICAgLy8gU2Vjb25kcyBzaW5jZSBwcmV2aW91cyB0cmFja2luZyBldmVudFxuICAgIGRvcD86IG51bWJlcjsgICAgICAgICAgLy8gRGlsdXRpb24gb2YgcHJlY2lzaW9uIChHUFMgYWNjdXJhY3kpXG4gICAgam91cm5leT86IG51bWJlcjsgICAgICAvLyBKb3VybmV5IElEIChVbml4IHRpbWVzdGFtcCBvZiBqb3VybmV5IHN0YXJ0KVxuICAgIGpjb3VudD86IG51bWJlcjsgICAgICAgLy8gUG9pbnQgbnVtYmVyIGluIGN1cnJlbnQgam91cm5leSAoc3RhcnRzIGF0IDEpXG4gICAgdGltZT86IG51bWJlcjsgICAgICAgICAvLyBUaW1lc3RhbXAgd2hlbiBHUFMgZml4IHdhcyBjYXB0dXJlZFxuICB9O1xuICBiZXN0X2xvY2F0aW9uX3R5cGU/OiBzdHJpbmc7XG4gIGJlc3RfbG9jYXRpb25fd2hlbj86IG51bWJlcjtcbiAgYmVzdF9sYXQ/OiBudW1iZXI7XG4gIGJlc3RfbG9uPzogbnVtYmVyO1xuICBiZXN0X2xvY2F0aW9uPzogc3RyaW5nO1xuICB0b3dlcl9sb2NhdGlvbj86IHN0cmluZztcbiAgdG93ZXJfbGF0PzogbnVtYmVyO1xuICB0b3dlcl9sb24/OiBudW1iZXI7XG4gIHRvd2VyX3doZW4/OiBudW1iZXI7XG4gIC8vIFRyaWFuZ3VsYXRpb24gZmllbGRzIChmcm9tIF9nZW9sb2NhdGUucW8gb3IgZW5yaWNoZWQgZXZlbnRzKVxuICB0cmlfd2hlbj86IG51bWJlcjtcbiAgdHJpX2xhdD86IG51bWJlcjtcbiAgdHJpX2xvbj86IG51bWJlcjtcbiAgdHJpX2xvY2F0aW9uPzogc3RyaW5nO1xuICB0cmlfY291bnRyeT86IHN0cmluZztcbiAgdHJpX3RpbWV6b25lPzogc3RyaW5nO1xuICB0cmlfcG9pbnRzPzogbnVtYmVyOyAgLy8gTnVtYmVyIG9mIHJlZmVyZW5jZSBwb2ludHMgdXNlZCBmb3IgdHJpYW5ndWxhdGlvblxuICBmbGVldHM/OiBzdHJpbmdbXTtcbiAgLy8gU2Vzc2lvbiBmaWVsZHMgKF9zZXNzaW9uLnFvKSAtIG1heSBhcHBlYXIgYXQgdG9wIGxldmVsIG9yIGluIGJvZHlcbiAgZmlybXdhcmVfaG9zdD86IHN0cmluZzsgICAgIC8vIEpTT04gc3RyaW5nIHdpdGggaG9zdCBmaXJtd2FyZSBpbmZvXG4gIGZpcm13YXJlX25vdGVjYXJkPzogc3RyaW5nOyAvLyBKU09OIHN0cmluZyB3aXRoIE5vdGVjYXJkIGZpcm13YXJlIGluZm9cbiAgc2t1Pzogc3RyaW5nOyAgICAgICAgICAgICAgIC8vIE5vdGVjYXJkIFNLVSAoZS5nLiwgXCJOT1RFLVdCR0xXXCIpXG4gIHBvd2VyX3VzYj86IGJvb2xlYW47ICAgICAgICAvLyB0cnVlIGlmIGRldmljZSBpcyBVU0IgcG93ZXJlZFxufVxuXG5leHBvcnQgY29uc3QgaGFuZGxlciA9IGFzeW5jIChldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQpOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4gPT4ge1xuICBjb25zb2xlLmxvZygnSW5nZXN0IHJlcXVlc3Q6JywgSlNPTi5zdHJpbmdpZnkoZXZlbnQpKTtcblxuICBjb25zdCBoZWFkZXJzID0ge1xuICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gIH07XG5cbiAgdHJ5IHtcbiAgICBpZiAoIWV2ZW50LmJvZHkpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1JlcXVlc3QgYm9keSByZXF1aXJlZCcgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIGNvbnN0IG5vdGVodWJFdmVudDogTm90ZWh1YkV2ZW50ID0gSlNPTi5wYXJzZShldmVudC5ib2R5KTtcbiAgICBjb25zb2xlLmxvZygnUHJvY2Vzc2luZyBOb3RlaHViIGV2ZW50OicsIEpTT04uc3RyaW5naWZ5KG5vdGVodWJFdmVudCkpO1xuXG4gICAgLy8gVHJhbnNmb3JtIHRvIGludGVybmFsIGZvcm1hdFxuICAgIC8vIFVzZSAnd2hlbicgaWYgYXZhaWxhYmxlLCBvdGhlcndpc2UgZmFsbCBiYWNrIHRvICdyZWNlaXZlZCcgKGFzIGludGVnZXIgc2Vjb25kcylcbiAgICBjb25zdCBldmVudFRpbWVzdGFtcCA9IG5vdGVodWJFdmVudC53aGVuIHx8IE1hdGguZmxvb3Iobm90ZWh1YkV2ZW50LnJlY2VpdmVkKTtcblxuICAgIC8vIEV4dHJhY3QgbG9jYXRpb24gLSBwcmVmZXIgR1BTIChiZXN0X2xhdC9iZXN0X2xvbiksIGZhbGwgYmFjayB0byB0cmlhbmd1bGF0aW9uXG4gICAgY29uc3QgbG9jYXRpb24gPSBleHRyYWN0TG9jYXRpb24obm90ZWh1YkV2ZW50KTtcblxuICAgIC8vIEV4dHJhY3Qgc2Vzc2lvbiBpbmZvIChmaXJtd2FyZSB2ZXJzaW9ucywgU0tVKSBmcm9tIF9zZXNzaW9uLnFvIGV2ZW50c1xuICAgIGNvbnN0IHNlc3Npb25JbmZvID0gZXh0cmFjdFNlc3Npb25JbmZvKG5vdGVodWJFdmVudCk7XG5cbiAgICBjb25zdCBzb25nYmlyZEV2ZW50ID0ge1xuICAgICAgZGV2aWNlX3VpZDogbm90ZWh1YkV2ZW50LmRldmljZSxcbiAgICAgIHNlcmlhbF9udW1iZXI6IG5vdGVodWJFdmVudC5zbixcbiAgICAgIGZsZWV0OiBub3RlaHViRXZlbnQuZmxlZXRzPy5bMF0gfHwgJ2RlZmF1bHQnLFxuICAgICAgZXZlbnRfdHlwZTogbm90ZWh1YkV2ZW50LmZpbGUsXG4gICAgICB0aW1lc3RhbXA6IGV2ZW50VGltZXN0YW1wLFxuICAgICAgcmVjZWl2ZWQ6IG5vdGVodWJFdmVudC5yZWNlaXZlZCxcbiAgICAgIGJvZHk6IG5vdGVodWJFdmVudC5ib2R5IHx8IHt9LFxuICAgICAgbG9jYXRpb24sXG4gICAgICBzZXNzaW9uOiBzZXNzaW9uSW5mbyxcbiAgICB9O1xuXG4gICAgLy8gV3JpdGUgdGVsZW1ldHJ5IHRvIER5bmFtb0RCIChmb3IgdHJhY2sucW8gZXZlbnRzKVxuICAgIGlmIChzb25nYmlyZEV2ZW50LmV2ZW50X3R5cGUgPT09ICd0cmFjay5xbycpIHtcbiAgICAgIGF3YWl0IHdyaXRlVGVsZW1ldHJ5KHNvbmdiaXJkRXZlbnQsICd0ZWxlbWV0cnknKTtcbiAgICB9XG5cbiAgICAvLyBXcml0ZSBNb2pvIHBvd2VyIGRhdGEgdG8gRHluYW1vREIgKF9sb2cucW8gY29udGFpbnMgcG93ZXIgdGVsZW1ldHJ5KVxuICAgIC8vIFNraXAgaWYgZGV2aWNlIGlzIFVTQiBwb3dlcmVkICh2b2x0YWdlX21vZGU6IFwidXNiXCIpIC0gbm8gYmF0dGVyeSB0byBtb25pdG9yXG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuZXZlbnRfdHlwZSA9PT0gJ19sb2cucW8nKSB7XG4gICAgICBpZiAoc29uZ2JpcmRFdmVudC5ib2R5LnZvbHRhZ2VfbW9kZSA9PT0gJ3VzYicpIHtcbiAgICAgICAgY29uc29sZS5sb2coYFNraXBwaW5nIF9sb2cucW8gZXZlbnQgZm9yICR7c29uZ2JpcmRFdmVudC5kZXZpY2VfdWlkfSAtIFVTQiBwb3dlcmVkYCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhd2FpdCB3cml0ZVBvd2VyVGVsZW1ldHJ5KHNvbmdiaXJkRXZlbnQpO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFdyaXRlIGhlYWx0aCBldmVudHMgdG8gRHluYW1vREIgKF9oZWFsdGgucW8pXG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuZXZlbnRfdHlwZSA9PT0gJ19oZWFsdGgucW8nKSB7XG4gICAgICBhd2FpdCB3cml0ZUhlYWx0aEV2ZW50KHNvbmdiaXJkRXZlbnQpO1xuICAgIH1cblxuICAgIC8vIEhhbmRsZSB0cmlhbmd1bGF0aW9uIHJlc3VsdHMgKF9nZW9sb2NhdGUucW8pXG4gICAgLy8gV3JpdGUgbG9jYXRpb24gdG8gdGVsZW1ldHJ5IHRhYmxlIGZvciBsb2NhdGlvbiBoaXN0b3J5IHRyYWlsXG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuZXZlbnRfdHlwZSA9PT0gJ19nZW9sb2NhdGUucW8nICYmIHNvbmdiaXJkRXZlbnQubG9jYXRpb24pIHtcbiAgICAgIGF3YWl0IHdyaXRlTG9jYXRpb25FdmVudChzb25nYmlyZEV2ZW50KTtcbiAgICB9XG5cbiAgICAvLyBIYW5kbGUgR1BTIHRyYWNraW5nIGV2ZW50cyAoX3RyYWNrLnFvIGZyb20gTm90ZWNhcmQpXG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuZXZlbnRfdHlwZSA9PT0gJ190cmFjay5xbycpIHtcbiAgICAgIGF3YWl0IHdyaXRlVHJhY2tpbmdFdmVudChzb25nYmlyZEV2ZW50KTtcbiAgICAgIGF3YWl0IHVwc2VydEpvdXJuZXkoc29uZ2JpcmRFdmVudCk7XG4gICAgfVxuXG4gICAgLy8gV3JpdGUgdG8gbG9jYXRpb24gaGlzdG9yeSB0YWJsZSBmb3IgYWxsIGV2ZW50cyB3aXRoIGxvY2F0aW9uXG4gICAgaWYgKHNvbmdiaXJkRXZlbnQubG9jYXRpb24pIHtcbiAgICAgIGF3YWl0IHdyaXRlTG9jYXRpb25IaXN0b3J5KHNvbmdiaXJkRXZlbnQpO1xuICAgIH1cblxuICAgIC8vIFVwZGF0ZSBkZXZpY2UgbWV0YWRhdGEgaW4gRHluYW1vREJcbiAgICBhd2FpdCB1cGRhdGVEZXZpY2VNZXRhZGF0YShzb25nYmlyZEV2ZW50KTtcblxuICAgIC8vIENoZWNrIGZvciBtb2RlIGNoYW5nZSBhd2F5IGZyb20gdHJhbnNpdCAtIGNvbXBsZXRlIGFueSBhY3RpdmUgam91cm5leXNcbiAgICBpZiAoc29uZ2JpcmRFdmVudC5ib2R5Lm1vZGUgJiYgc29uZ2JpcmRFdmVudC5ib2R5Lm1vZGUgIT09ICd0cmFuc2l0Jykge1xuICAgICAgYXdhaXQgY29tcGxldGVBY3RpdmVKb3VybmV5c09uTW9kZUNoYW5nZShzb25nYmlyZEV2ZW50LmRldmljZV91aWQsIHNvbmdiaXJkRXZlbnQuYm9keS5tb2RlKTtcbiAgICB9XG5cbiAgICAvLyBTdG9yZSBhbmQgcHVibGlzaCBhbGVydCBpZiB0aGlzIGlzIGFuIGFsZXJ0IGV2ZW50XG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuZXZlbnRfdHlwZSA9PT0gJ2FsZXJ0LnFvJykge1xuICAgICAgYXdhaXQgc3RvcmVBbGVydChzb25nYmlyZEV2ZW50KTtcbiAgICAgIGF3YWl0IHB1Ymxpc2hBbGVydChzb25nYmlyZEV2ZW50KTtcbiAgICB9XG5cbiAgICAvLyBQcm9jZXNzIGNvbW1hbmQgYWNrbm93bGVkZ21lbnRcbiAgICBpZiAoc29uZ2JpcmRFdmVudC5ldmVudF90eXBlID09PSAnY29tbWFuZF9hY2sucW8nKSB7XG4gICAgICBhd2FpdCBwcm9jZXNzQ29tbWFuZEFjayhzb25nYmlyZEV2ZW50KTtcbiAgICB9XG5cbiAgICBjb25zb2xlLmxvZygnRXZlbnQgcHJvY2Vzc2VkIHN1Y2Nlc3NmdWxseScpO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHN0YXR1czogJ29rJywgZGV2aWNlOiBzb25nYmlyZEV2ZW50LmRldmljZV91aWQgfSksXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvciBwcm9jZXNzaW5nIGV2ZW50OicsIGVycm9yKTtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNTAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnRlcm5hbCBzZXJ2ZXIgZXJyb3InIH0pLFxuICAgIH07XG4gIH1cbn07XG5cbmludGVyZmFjZSBTZXNzaW9uSW5mbyB7XG4gIGZpcm13YXJlX3ZlcnNpb24/OiBzdHJpbmc7XG4gIG5vdGVjYXJkX3ZlcnNpb24/OiBzdHJpbmc7XG4gIG5vdGVjYXJkX3NrdT86IHN0cmluZztcbiAgdXNiX3Bvd2VyZWQ/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIEV4dHJhY3Qgc2Vzc2lvbiBpbmZvIChmaXJtd2FyZSB2ZXJzaW9ucywgU0tVLCBwb3dlciBzdGF0dXMpIGZyb20gTm90ZWh1YiBldmVudFxuICogVGhpcyBpbmZvIGlzIGF2YWlsYWJsZSBpbiBfc2Vzc2lvbi5xbyBldmVudHNcbiAqIE5vdGU6IFNvbWUgZmllbGRzIG1heSBhcHBlYXIgYXQgdGhlIHRvcCBsZXZlbCBvciBpbnNpZGUgdGhlIGJvZHkgZGVwZW5kaW5nIG9uIHRoZSBIVFRQIHJvdXRlIGNvbmZpZ3VyYXRpb25cbiAqL1xuZnVuY3Rpb24gZXh0cmFjdFNlc3Npb25JbmZvKGV2ZW50OiBOb3RlaHViRXZlbnQpOiBTZXNzaW9uSW5mbyB8IHVuZGVmaW5lZCB7XG4gIC8vIENoZWNrIGZvciBwb3dlcl91c2IgYXQgdG9wIGxldmVsIE9SIGluIGJvZHlcbiAgY29uc3QgcG93ZXJVc2IgPSBldmVudC5wb3dlcl91c2IgPz8gZXZlbnQuYm9keT8ucG93ZXJfdXNiO1xuXG4gIGlmICghZXZlbnQuZmlybXdhcmVfaG9zdCAmJiAhZXZlbnQuZmlybXdhcmVfbm90ZWNhcmQgJiYgIWV2ZW50LnNrdSAmJiBwb3dlclVzYiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuXG4gIGNvbnN0IHNlc3Npb25JbmZvOiBTZXNzaW9uSW5mbyA9IHt9O1xuXG4gIC8vIFBhcnNlIGhvc3QgZmlybXdhcmUgdmVyc2lvblxuICBpZiAoZXZlbnQuZmlybXdhcmVfaG9zdCkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBob3N0RmlybXdhcmUgPSBKU09OLnBhcnNlKGV2ZW50LmZpcm13YXJlX2hvc3QpO1xuICAgICAgc2Vzc2lvbkluZm8uZmlybXdhcmVfdmVyc2lvbiA9IGhvc3RGaXJtd2FyZS52ZXJzaW9uO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ0ZhaWxlZCB0byBwYXJzZSBmaXJtd2FyZV9ob3N0OicsIGUpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFBhcnNlIE5vdGVjYXJkIGZpcm13YXJlIHZlcnNpb25cbiAgaWYgKGV2ZW50LmZpcm13YXJlX25vdGVjYXJkKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IG5vdGVjYXJkRmlybXdhcmUgPSBKU09OLnBhcnNlKGV2ZW50LmZpcm13YXJlX25vdGVjYXJkKTtcbiAgICAgIHNlc3Npb25JbmZvLm5vdGVjYXJkX3ZlcnNpb24gPSBub3RlY2FyZEZpcm13YXJlLnZlcnNpb247XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS5lcnJvcignRmFpbGVkIHRvIHBhcnNlIGZpcm13YXJlX25vdGVjYXJkOicsIGUpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFNLVVxuICBpZiAoZXZlbnQuc2t1KSB7XG4gICAgc2Vzc2lvbkluZm8ubm90ZWNhcmRfc2t1ID0gZXZlbnQuc2t1O1xuICB9XG5cbiAgLy8gVVNCIHBvd2VyIHN0YXR1cyAoY2hlY2sgdG9wIGxldmVsIGZpcnN0LCB0aGVuIGJvZHkpXG4gIGlmIChwb3dlclVzYiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgc2Vzc2lvbkluZm8udXNiX3Bvd2VyZWQgPSBwb3dlclVzYjtcbiAgICBjb25zb2xlLmxvZyhgRXh0cmFjdGVkIHVzYl9wb3dlcmVkOiAke3Bvd2VyVXNifWApO1xuICB9XG5cbiAgcmV0dXJuIE9iamVjdC5rZXlzKHNlc3Npb25JbmZvKS5sZW5ndGggPiAwID8gc2Vzc2lvbkluZm8gOiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogTm9ybWFsaXplIGxvY2F0aW9uIHNvdXJjZSB0eXBlIGZyb20gTm90ZWh1YiB0byBvdXIgc3RhbmRhcmQgdmFsdWVzXG4gKi9cbmZ1bmN0aW9uIG5vcm1hbGl6ZUxvY2F0aW9uU291cmNlKHNvdXJjZT86IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICghc291cmNlKSByZXR1cm4gJ2dwcyc7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBzb3VyY2UudG9Mb3dlckNhc2UoKTtcbiAgLy8gTm90ZWh1YiB1c2VzICd0cmlhbmd1bGF0ZWQnIGJ1dCB3ZSB1c2UgJ3RyaWFuZ3VsYXRpb24nIGZvciBjb25zaXN0ZW5jeVxuICBpZiAobm9ybWFsaXplZCA9PT0gJ3RyaWFuZ3VsYXRlZCcpIHJldHVybiAndHJpYW5ndWxhdGlvbic7XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG4vKipcbiAqIEV4dHJhY3QgbG9jYXRpb24gZnJvbSBOb3RlaHViIGV2ZW50LCBwcmVmZXJyaW5nIEdQUyBidXQgZmFsbGluZyBiYWNrIHRvIHRyaWFuZ3VsYXRpb25cbiAqL1xuZnVuY3Rpb24gZXh0cmFjdExvY2F0aW9uKGV2ZW50OiBOb3RlaHViRXZlbnQpOiB7IGxhdDogbnVtYmVyOyBsb246IG51bWJlcjsgdGltZT86IG51bWJlcjsgc291cmNlOiBzdHJpbmc7IG5hbWU/OiBzdHJpbmcgfSB8IHVuZGVmaW5lZCB7XG4gIC8vIFByZWZlciBHUFMgbG9jYXRpb24gKGJlc3RfbGF0L2Jlc3RfbG9uIHdpdGggdHlwZSAnZ3BzJylcbiAgaWYgKGV2ZW50LmJlc3RfbGF0ICE9PSB1bmRlZmluZWQgJiYgZXZlbnQuYmVzdF9sb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB7XG4gICAgICBsYXQ6IGV2ZW50LmJlc3RfbGF0LFxuICAgICAgbG9uOiBldmVudC5iZXN0X2xvbixcbiAgICAgIHRpbWU6IGV2ZW50LmJlc3RfbG9jYXRpb25fd2hlbixcbiAgICAgIHNvdXJjZTogbm9ybWFsaXplTG9jYXRpb25Tb3VyY2UoZXZlbnQuYmVzdF9sb2NhdGlvbl90eXBlKSxcbiAgICAgIG5hbWU6IGV2ZW50LmJlc3RfbG9jYXRpb24sXG4gICAgfTtcbiAgfVxuXG4gIC8vIEZhbGwgYmFjayB0byB0cmlhbmd1bGF0aW9uIGRhdGFcbiAgaWYgKGV2ZW50LnRyaV9sYXQgIT09IHVuZGVmaW5lZCAmJiBldmVudC50cmlfbG9uICE9PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgbGF0OiBldmVudC50cmlfbGF0LFxuICAgICAgbG9uOiBldmVudC50cmlfbG9uLFxuICAgICAgdGltZTogZXZlbnQudHJpX3doZW4sXG4gICAgICBzb3VyY2U6ICd0cmlhbmd1bGF0aW9uJyxcbiAgICAgIG5hbWU6IGV2ZW50LnRvd2VyX2xvY2F0aW9uLFxuICAgIH07XG4gIH1cblxuICAvLyBGYWxsIGJhY2sgdG8gdG93ZXIgbG9jYXRpb25cbiAgaWYgKGV2ZW50LnRvd2VyX2xhdCAhPT0gdW5kZWZpbmVkICYmIGV2ZW50LnRvd2VyX2xvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGxhdDogZXZlbnQudG93ZXJfbGF0LFxuICAgICAgbG9uOiBldmVudC50b3dlcl9sb24sXG4gICAgICB0aW1lOiBldmVudC50b3dlcl93aGVuLFxuICAgICAgc291cmNlOiAndG93ZXInLFxuICAgICAgbmFtZTogZXZlbnQudG93ZXJfbG9jYXRpb24sXG4gICAgfTtcbiAgfVxuXG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmludGVyZmFjZSBTb25nYmlyZEV2ZW50IHtcbiAgZGV2aWNlX3VpZDogc3RyaW5nO1xuICBzZXJpYWxfbnVtYmVyPzogc3RyaW5nO1xuICBmbGVldD86IHN0cmluZztcbiAgZXZlbnRfdHlwZTogc3RyaW5nO1xuICB0aW1lc3RhbXA6IG51bWJlcjtcbiAgcmVjZWl2ZWQ6IG51bWJlcjtcbiAgc2Vzc2lvbj86IFNlc3Npb25JbmZvO1xuICBib2R5OiB7XG4gICAgdGVtcD86IG51bWJlcjtcbiAgICBodW1pZGl0eT86IG51bWJlcjtcbiAgICBwcmVzc3VyZT86IG51bWJlcjtcbiAgICB2b2x0YWdlPzogbnVtYmVyO1xuICAgIG1vdGlvbj86IGJvb2xlYW4gfCBudW1iZXI7XG4gICAgbW9kZT86IHN0cmluZztcbiAgICB0cmFuc2l0X2xvY2tlZD86IGJvb2xlYW47XG4gICAgZGVtb19sb2NrZWQ/OiBib29sZWFuO1xuICAgIHR5cGU/OiBzdHJpbmc7XG4gICAgdmFsdWU/OiBudW1iZXI7XG4gICAgdGhyZXNob2xkPzogbnVtYmVyO1xuICAgIG1lc3NhZ2U/OiBzdHJpbmc7XG4gICAgY21kPzogc3RyaW5nO1xuICAgIGNtZF9pZD86IHN0cmluZztcbiAgICBzdGF0dXM/OiBzdHJpbmc7XG4gICAgZXhlY3V0ZWRfYXQ/OiBudW1iZXI7XG4gICAgbWlsbGlhbXBfaG91cnM/OiBudW1iZXI7XG4gICAgdGVtcGVyYXR1cmU/OiBudW1iZXI7XG4gICAgLy8gSGVhbHRoIGV2ZW50IGZpZWxkc1xuICAgIG1ldGhvZD86IHN0cmluZztcbiAgICB0ZXh0Pzogc3RyaW5nO1xuICAgIHZvbHRhZ2VfbW9kZT86IHN0cmluZztcbiAgICAvLyBHUFMgdHJhY2tpbmcgZmllbGRzIChfdHJhY2sucW8pXG4gICAgdmVsb2NpdHk/OiBudW1iZXI7XG4gICAgYmVhcmluZz86IG51bWJlcjtcbiAgICBkaXN0YW5jZT86IG51bWJlcjtcbiAgICBzZWNvbmRzPzogbnVtYmVyO1xuICAgIGRvcD86IG51bWJlcjtcbiAgICBqb3VybmV5PzogbnVtYmVyO1xuICAgIGpjb3VudD86IG51bWJlcjtcbiAgICB0aW1lPzogbnVtYmVyO1xuICB9O1xuICBsb2NhdGlvbj86IHtcbiAgICBsYXQ/OiBudW1iZXI7XG4gICAgbG9uPzogbnVtYmVyO1xuICAgIHRpbWU/OiBudW1iZXI7XG4gICAgc291cmNlPzogc3RyaW5nO1xuICAgIG5hbWU/OiBzdHJpbmc7XG4gIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlVGVsZW1ldHJ5KGV2ZW50OiBTb25nYmlyZEV2ZW50LCBkYXRhVHlwZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRpbWVzdGFtcCA9IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDA7IC8vIENvbnZlcnQgdG8gbWlsbGlzZWNvbmRzXG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgY29uc3QgcmVjb3JkOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge1xuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgdGltZXN0YW1wLFxuICAgIHR0bCxcbiAgICBkYXRhX3R5cGU6IGRhdGFUeXBlLFxuICAgIGV2ZW50X3R5cGU6IGV2ZW50LmV2ZW50X3R5cGUsXG4gICAgZXZlbnRfdHlwZV90aW1lc3RhbXA6IGAke2RhdGFUeXBlfSMke3RpbWVzdGFtcH1gLFxuICAgIHNlcmlhbF9udW1iZXI6IGV2ZW50LnNlcmlhbF9udW1iZXIgfHwgJ3Vua25vd24nLFxuICAgIGZsZWV0OiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gIH07XG5cbiAgaWYgKGV2ZW50LmJvZHkudGVtcCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnRlbXBlcmF0dXJlID0gZXZlbnQuYm9keS50ZW1wO1xuICB9XG4gIGlmIChldmVudC5ib2R5Lmh1bWlkaXR5ICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQuaHVtaWRpdHkgPSBldmVudC5ib2R5Lmh1bWlkaXR5O1xuICB9XG4gIGlmIChldmVudC5ib2R5LnByZXNzdXJlICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQucHJlc3N1cmUgPSBldmVudC5ib2R5LnByZXNzdXJlO1xuICB9XG4gIGlmIChldmVudC5ib2R5LnZvbHRhZ2UgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC52b2x0YWdlID0gZXZlbnQuYm9keS52b2x0YWdlO1xuICB9XG4gIGlmIChldmVudC5ib2R5Lm1vdGlvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLm1vdGlvbiA9IGV2ZW50LmJvZHkubW90aW9uO1xuICB9XG5cbiAgaWYgKGV2ZW50LmxvY2F0aW9uPy5sYXQgIT09IHVuZGVmaW5lZCAmJiBldmVudC5sb2NhdGlvbj8ubG9uICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQubGF0aXR1ZGUgPSBldmVudC5sb2NhdGlvbi5sYXQ7XG4gICAgcmVjb3JkLmxvbmdpdHVkZSA9IGV2ZW50LmxvY2F0aW9uLmxvbjtcbiAgICByZWNvcmQubG9jYXRpb25fc291cmNlID0gZXZlbnQubG9jYXRpb24uc291cmNlIHx8ICdncHMnO1xuICB9XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBQdXRDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IFRFTEVNRVRSWV9UQUJMRSxcbiAgICBJdGVtOiByZWNvcmQsXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgV3JvdGUgdGVsZW1ldHJ5IHJlY29yZCBmb3IgJHtldmVudC5kZXZpY2VfdWlkfWApO1xufVxuXG5hc3luYyBmdW5jdGlvbiB3cml0ZVBvd2VyVGVsZW1ldHJ5KGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRpbWVzdGFtcCA9IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDA7XG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgY29uc3QgcmVjb3JkOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge1xuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgdGltZXN0YW1wLFxuICAgIHR0bCxcbiAgICBkYXRhX3R5cGU6ICdwb3dlcicsXG4gICAgZXZlbnRfdHlwZTogZXZlbnQuZXZlbnRfdHlwZSxcbiAgICBldmVudF90eXBlX3RpbWVzdGFtcDogYHBvd2VyIyR7dGltZXN0YW1wfWAsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgfTtcblxuICBpZiAoZXZlbnQuYm9keS52b2x0YWdlICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQubW9qb192b2x0YWdlID0gZXZlbnQuYm9keS52b2x0YWdlO1xuICB9XG4gIGlmIChldmVudC5ib2R5Lm1pbGxpYW1wX2hvdXJzICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQubWlsbGlhbXBfaG91cnMgPSBldmVudC5ib2R5Lm1pbGxpYW1wX2hvdXJzO1xuICB9XG5cbiAgaWYgKHJlY29yZC5tb2pvX3ZvbHRhZ2UgIT09IHVuZGVmaW5lZCB8fFxuICAgICAgcmVjb3JkLm1vam9fdGVtcGVyYXR1cmUgIT09IHVuZGVmaW5lZCB8fFxuICAgICAgcmVjb3JkLm1pbGxpYW1wX2hvdXJzICE9PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCBjb21tYW5kID0gbmV3IFB1dENvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBURUxFTUVUUllfVEFCTEUsXG4gICAgICBJdGVtOiByZWNvcmQsXG4gICAgfSk7XG5cbiAgICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgICBjb25zb2xlLmxvZyhgV3JvdGUgcG93ZXIgdGVsZW1ldHJ5IHJlY29yZCBmb3IgJHtldmVudC5kZXZpY2VfdWlkfWApO1xuICB9IGVsc2Uge1xuICAgIGNvbnNvbGUubG9nKCdObyBwb3dlciBtZXRyaWNzIGluIF9sb2cucW8gZXZlbnQsIHNraXBwaW5nJyk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gd3JpdGVIZWFsdGhFdmVudChldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0aW1lc3RhbXAgPSBldmVudC50aW1lc3RhbXAgKiAxMDAwOyAvLyBDb252ZXJ0IHRvIG1pbGxpc2Vjb25kc1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSArIFRUTF9TRUNPTkRTO1xuXG4gIGNvbnN0IHJlY29yZDogUmVjb3JkPHN0cmluZywgYW55PiA9IHtcbiAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgIHRpbWVzdGFtcCxcbiAgICB0dGwsXG4gICAgZGF0YV90eXBlOiAnaGVhbHRoJyxcbiAgICBldmVudF90eXBlOiBldmVudC5ldmVudF90eXBlLFxuICAgIGV2ZW50X3R5cGVfdGltZXN0YW1wOiBgaGVhbHRoIyR7dGltZXN0YW1wfWAsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgfTtcblxuICAvLyBBZGQgaGVhbHRoIGV2ZW50IGZpZWxkc1xuICBpZiAoZXZlbnQuYm9keS5tZXRob2QgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5tZXRob2QgPSBldmVudC5ib2R5Lm1ldGhvZDtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS50ZXh0ICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQudGV4dCA9IGV2ZW50LmJvZHkudGV4dDtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS52b2x0YWdlICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQudm9sdGFnZSA9IGV2ZW50LmJvZHkudm9sdGFnZTtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS52b2x0YWdlX21vZGUgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC52b2x0YWdlX21vZGUgPSBldmVudC5ib2R5LnZvbHRhZ2VfbW9kZTtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS5taWxsaWFtcF9ob3VycyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLm1pbGxpYW1wX2hvdXJzID0gZXZlbnQuYm9keS5taWxsaWFtcF9ob3VycztcbiAgfVxuXG4gIC8vIEFkZCBsb2NhdGlvbiBpZiBhdmFpbGFibGVcbiAgaWYgKGV2ZW50LmxvY2F0aW9uPy5sYXQgIT09IHVuZGVmaW5lZCAmJiBldmVudC5sb2NhdGlvbj8ubG9uICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQubGF0aXR1ZGUgPSBldmVudC5sb2NhdGlvbi5sYXQ7XG4gICAgcmVjb3JkLmxvbmdpdHVkZSA9IGV2ZW50LmxvY2F0aW9uLmxvbjtcbiAgICByZWNvcmQubG9jYXRpb25fc291cmNlID0gZXZlbnQubG9jYXRpb24uc291cmNlIHx8ICd0b3dlcic7XG4gIH1cblxuICBjb25zdCBjb21tYW5kID0gbmV3IFB1dENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogVEVMRU1FVFJZX1RBQkxFLFxuICAgIEl0ZW06IHJlY29yZCxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBXcm90ZSBoZWFsdGggZXZlbnQgcmVjb3JkIGZvciAke2V2ZW50LmRldmljZV91aWR9OiAke2V2ZW50LmJvZHkubWV0aG9kfWApO1xufVxuXG5hc3luYyBmdW5jdGlvbiB3cml0ZUxvY2F0aW9uRXZlbnQoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKCFldmVudC5sb2NhdGlvbj8ubGF0IHx8ICFldmVudC5sb2NhdGlvbj8ubG9uKSB7XG4gICAgY29uc29sZS5sb2coJ05vIGxvY2F0aW9uIGRhdGEgaW4gZXZlbnQsIHNraXBwaW5nJyk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgdGltZXN0YW1wID0gZXZlbnQudGltZXN0YW1wICogMTAwMDsgLy8gQ29udmVydCB0byBtaWxsaXNlY29uZHNcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCkgKyBUVExfU0VDT05EUztcblxuICBjb25zdCByZWNvcmQ6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICB0aW1lc3RhbXAsXG4gICAgdHRsLFxuICAgIGRhdGFfdHlwZTogJ3RlbGVtZXRyeScsIC8vIFVzZSB0ZWxlbWV0cnkgc28gaXQncyBwaWNrZWQgdXAgYnkgbG9jYXRpb24gcXVlcnlcbiAgICBldmVudF90eXBlOiBldmVudC5ldmVudF90eXBlLFxuICAgIGV2ZW50X3R5cGVfdGltZXN0YW1wOiBgdGVsZW1ldHJ5IyR7dGltZXN0YW1wfWAsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgICBsYXRpdHVkZTogZXZlbnQubG9jYXRpb24ubGF0LFxuICAgIGxvbmdpdHVkZTogZXZlbnQubG9jYXRpb24ubG9uLFxuICAgIGxvY2F0aW9uX3NvdXJjZTogZXZlbnQubG9jYXRpb24uc291cmNlIHx8ICd0cmlhbmd1bGF0aW9uJyxcbiAgfTtcblxuICBjb25zdCBjb21tYW5kID0gbmV3IFB1dENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogVEVMRU1FVFJZX1RBQkxFLFxuICAgIEl0ZW06IHJlY29yZCxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBXcm90ZSBsb2NhdGlvbiBldmVudCBmb3IgJHtldmVudC5kZXZpY2VfdWlkfTogJHtldmVudC5sb2NhdGlvbi5zb3VyY2V9ICgke2V2ZW50LmxvY2F0aW9uLmxhdH0sICR7ZXZlbnQubG9jYXRpb24ubG9ufSlgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gdXBkYXRlRGV2aWNlTWV0YWRhdGEoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcblxuICBjb25zdCB1cGRhdGVFeHByZXNzaW9uczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gIGNvbnN0IGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7fTtcblxuICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjbGFzdF9zZWVuID0gOmxhc3Rfc2VlbicpO1xuICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNsYXN0X3NlZW4nXSA9ICdsYXN0X3NlZW4nO1xuICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6bGFzdF9zZWVuJ10gPSBub3c7XG5cbiAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3VwZGF0ZWRfYXQgPSA6dXBkYXRlZF9hdCcpO1xuICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyN1cGRhdGVkX2F0J10gPSAndXBkYXRlZF9hdCc7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzp1cGRhdGVkX2F0J10gPSBub3c7XG5cbiAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3N0YXR1cyA9IDpzdGF0dXMnKTtcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjc3RhdHVzJ10gPSAnc3RhdHVzJztcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnN0YXR1cyddID0gJ29ubGluZSc7XG5cbiAgaWYgKGV2ZW50LnNlcmlhbF9udW1iZXIpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjc24gPSA6c24nKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNzbiddID0gJ3NlcmlhbF9udW1iZXInO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpzbiddID0gZXZlbnQuc2VyaWFsX251bWJlcjtcbiAgfVxuXG4gIGlmIChldmVudC5mbGVldCkge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNmbGVldCA9IDpmbGVldCcpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI2ZsZWV0J10gPSAnZmxlZXQnO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpmbGVldCddID0gZXZlbnQuZmxlZXQ7XG4gIH1cblxuICBpZiAoZXZlbnQuYm9keS5tb2RlKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI21vZGUgPSA6bW9kZScpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI21vZGUnXSA9ICdjdXJyZW50X21vZGUnO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzptb2RlJ10gPSBldmVudC5ib2R5Lm1vZGU7XG4gIH1cblxuICAvLyBGb3IgdHJhY2sucW8gZXZlbnRzLCB1cGRhdGUgbG9jayBzdGF0ZXMgYmFzZWQgb24gcHJlc2VuY2Ugb2YgdGhlIGZpZWxkXG4gIC8vIElmIGxvY2tlZCBpcyB0cnVlLCBzZXQgaXQ7IGlmIGFic2VudCBvciBmYWxzZSwgY2xlYXIgaXRcbiAgaWYgKGV2ZW50LmV2ZW50X3R5cGUgPT09ICd0cmFjay5xbycpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjdHJhbnNpdF9sb2NrZWQgPSA6dHJhbnNpdF9sb2NrZWQnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyN0cmFuc2l0X2xvY2tlZCddID0gJ3RyYW5zaXRfbG9ja2VkJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6dHJhbnNpdF9sb2NrZWQnXSA9IGV2ZW50LmJvZHkudHJhbnNpdF9sb2NrZWQgPT09IHRydWU7XG5cbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjZGVtb19sb2NrZWQgPSA6ZGVtb19sb2NrZWQnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNkZW1vX2xvY2tlZCddID0gJ2RlbW9fbG9ja2VkJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6ZGVtb19sb2NrZWQnXSA9IGV2ZW50LmJvZHkuZGVtb19sb2NrZWQgPT09IHRydWU7XG4gIH1cblxuICBpZiAoZXZlbnQubG9jYXRpb24/LmxhdCAhPT0gdW5kZWZpbmVkICYmIGV2ZW50LmxvY2F0aW9uPy5sb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNsb2MgPSA6bG9jJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjbG9jJ10gPSAnbGFzdF9sb2NhdGlvbic7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOmxvYyddID0ge1xuICAgICAgbGF0OiBldmVudC5sb2NhdGlvbi5sYXQsXG4gICAgICBsb246IGV2ZW50LmxvY2F0aW9uLmxvbixcbiAgICAgIHRpbWU6IGV2ZW50LmxvY2F0aW9uLnRpbWUgfHwgZXZlbnQudGltZXN0YW1wLFxuICAgICAgc291cmNlOiBldmVudC5sb2NhdGlvbi5zb3VyY2UgfHwgJ2dwcycsXG4gICAgICBuYW1lOiBldmVudC5sb2NhdGlvbi5uYW1lLFxuICAgIH07XG4gIH1cblxuICBpZiAoZXZlbnQuZXZlbnRfdHlwZSA9PT0gJ3RyYWNrLnFvJykge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyN0ZWxlbWV0cnkgPSA6dGVsZW1ldHJ5Jyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjdGVsZW1ldHJ5J10gPSAnbGFzdF90ZWxlbWV0cnknO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzp0ZWxlbWV0cnknXSA9IHtcbiAgICAgIHRlbXA6IGV2ZW50LmJvZHkudGVtcCxcbiAgICAgIGh1bWlkaXR5OiBldmVudC5ib2R5Lmh1bWlkaXR5LFxuICAgICAgcHJlc3N1cmU6IGV2ZW50LmJvZHkucHJlc3N1cmUsXG4gICAgICB2b2x0YWdlOiBldmVudC5ib2R5LnZvbHRhZ2UsXG4gICAgICBtb3Rpb246IGV2ZW50LmJvZHkubW90aW9uLFxuICAgICAgdGltZXN0YW1wOiBldmVudC50aW1lc3RhbXAsXG4gICAgfTtcbiAgfVxuXG4gIGlmIChldmVudC5ldmVudF90eXBlID09PSAnX2xvZy5xbycpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjcG93ZXIgPSA6cG93ZXInKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNwb3dlciddID0gJ2xhc3RfcG93ZXInO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpwb3dlciddID0ge1xuICAgICAgdm9sdGFnZTogZXZlbnQuYm9keS52b2x0YWdlLFxuICAgICAgdGVtcGVyYXR1cmU6IGV2ZW50LmJvZHkudGVtcGVyYXR1cmUsXG4gICAgICBtaWxsaWFtcF9ob3VyczogZXZlbnQuYm9keS5taWxsaWFtcF9ob3VycyxcbiAgICAgIHRpbWVzdGFtcDogZXZlbnQudGltZXN0YW1wLFxuICAgIH07XG4gIH1cblxuICAvLyBVcGRhdGUgZmlybXdhcmUgdmVyc2lvbnMgZnJvbSBfc2Vzc2lvbi5xbyBldmVudHNcbiAgaWYgKGV2ZW50LnNlc3Npb24/LmZpcm13YXJlX3ZlcnNpb24pIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjZndfdmVyc2lvbiA9IDpmd192ZXJzaW9uJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjZndfdmVyc2lvbiddID0gJ2Zpcm13YXJlX3ZlcnNpb24nO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpmd192ZXJzaW9uJ10gPSBldmVudC5zZXNzaW9uLmZpcm13YXJlX3ZlcnNpb247XG4gIH1cblxuICBpZiAoZXZlbnQuc2Vzc2lvbj8ubm90ZWNhcmRfdmVyc2lvbikge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNuY192ZXJzaW9uID0gOm5jX3ZlcnNpb24nKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNuY192ZXJzaW9uJ10gPSAnbm90ZWNhcmRfdmVyc2lvbic7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOm5jX3ZlcnNpb24nXSA9IGV2ZW50LnNlc3Npb24ubm90ZWNhcmRfdmVyc2lvbjtcbiAgfVxuXG4gIGlmIChldmVudC5zZXNzaW9uPy5ub3RlY2FyZF9za3UpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjbmNfc2t1ID0gOm5jX3NrdScpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI25jX3NrdSddID0gJ25vdGVjYXJkX3NrdSc7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOm5jX3NrdSddID0gZXZlbnQuc2Vzc2lvbi5ub3RlY2FyZF9za3U7XG4gIH1cblxuICAvLyBVcGRhdGUgVVNCIHBvd2VyIHN0YXR1cyBmcm9tIF9zZXNzaW9uLnFvIGV2ZW50c1xuICBpZiAoZXZlbnQuc2Vzc2lvbj8udXNiX3Bvd2VyZWQgIT09IHVuZGVmaW5lZCkge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyN1c2JfcG93ZXJlZCA9IDp1c2JfcG93ZXJlZCcpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3VzYl9wb3dlcmVkJ10gPSAndXNiX3Bvd2VyZWQnO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzp1c2JfcG93ZXJlZCddID0gZXZlbnQuc2Vzc2lvbi51c2JfcG93ZXJlZDtcbiAgfVxuXG4gIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNjcmVhdGVkX2F0ID0gaWZfbm90X2V4aXN0cygjY3JlYXRlZF9hdCwgOmNyZWF0ZWRfYXQpJyk7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI2NyZWF0ZWRfYXQnXSA9ICdjcmVhdGVkX2F0JztcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOmNyZWF0ZWRfYXQnXSA9IG5vdztcblxuICBjb25zdCBjb21tYW5kID0gbmV3IFVwZGF0ZUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICBLZXk6IHsgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCB9LFxuICAgIFVwZGF0ZUV4cHJlc3Npb246ICdTRVQgJyArIHVwZGF0ZUV4cHJlc3Npb25zLmpvaW4oJywgJyksXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiBleHByZXNzaW9uQXR0cmlidXRlTmFtZXMsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczogZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlcyxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBVcGRhdGVkIGRldmljZSBtZXRhZGF0YSBmb3IgJHtldmVudC5kZXZpY2VfdWlkfWApO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwcm9jZXNzQ29tbWFuZEFjayhldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBjbWRJZCA9IGV2ZW50LmJvZHkuY21kX2lkO1xuICBpZiAoIWNtZElkKSB7XG4gICAgY29uc29sZS5sb2coJ0NvbW1hbmQgYWNrIG1pc3NpbmcgY21kX2lkLCBza2lwcGluZycpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBVcGRhdGVDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IENPTU1BTkRTX1RBQkxFLFxuICAgIEtleToge1xuICAgICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICAgIGNvbW1hbmRfaWQ6IGNtZElkLFxuICAgIH0sXG4gICAgVXBkYXRlRXhwcmVzc2lvbjogJ1NFVCAjc3RhdHVzID0gOnN0YXR1cywgI21lc3NhZ2UgPSA6bWVzc2FnZSwgI2V4ZWN1dGVkX2F0ID0gOmV4ZWN1dGVkX2F0LCAjdXBkYXRlZF9hdCA9IDp1cGRhdGVkX2F0JyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICcjc3RhdHVzJzogJ3N0YXR1cycsXG4gICAgICAnI21lc3NhZ2UnOiAnbWVzc2FnZScsXG4gICAgICAnI2V4ZWN1dGVkX2F0JzogJ2V4ZWN1dGVkX2F0JyxcbiAgICAgICcjdXBkYXRlZF9hdCc6ICd1cGRhdGVkX2F0JyxcbiAgICB9LFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6c3RhdHVzJzogZXZlbnQuYm9keS5zdGF0dXMgfHwgJ3Vua25vd24nLFxuICAgICAgJzptZXNzYWdlJzogZXZlbnQuYm9keS5tZXNzYWdlIHx8ICcnLFxuICAgICAgJzpleGVjdXRlZF9hdCc6IGV2ZW50LmJvZHkuZXhlY3V0ZWRfYXQgPyBldmVudC5ib2R5LmV4ZWN1dGVkX2F0ICogMTAwMCA6IG5vdyxcbiAgICAgICc6dXBkYXRlZF9hdCc6IG5vdyxcbiAgICB9LFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFVwZGF0ZWQgY29tbWFuZCAke2NtZElkfSB3aXRoIHN0YXR1czogJHtldmVudC5ib2R5LnN0YXR1c31gKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc3RvcmVBbGVydChldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKG5vdyAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgLy8gR2VuZXJhdGUgYSB1bmlxdWUgYWxlcnQgSURcbiAgY29uc3QgYWxlcnRJZCA9IGBhbGVydF8ke2V2ZW50LmRldmljZV91aWR9XyR7bm93fV8ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnN1YnN0cmluZyg3KX1gO1xuXG4gIGNvbnN0IGFsZXJ0UmVjb3JkID0ge1xuICAgIGFsZXJ0X2lkOiBhbGVydElkLFxuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgICB0eXBlOiBldmVudC5ib2R5LnR5cGUgfHwgJ3Vua25vd24nLFxuICAgIHZhbHVlOiBldmVudC5ib2R5LnZhbHVlLFxuICAgIHRocmVzaG9sZDogZXZlbnQuYm9keS50aHJlc2hvbGQsXG4gICAgbWVzc2FnZTogZXZlbnQuYm9keS5tZXNzYWdlIHx8ICcnLFxuICAgIGNyZWF0ZWRfYXQ6IG5vdyxcbiAgICBldmVudF90aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDAsXG4gICAgYWNrbm93bGVkZ2VkOiAnZmFsc2UnLCAvLyBTdHJpbmcgZm9yIEdTSSBwYXJ0aXRpb24ga2V5XG4gICAgdHRsLFxuICAgIGxvY2F0aW9uOiBldmVudC5sb2NhdGlvbiA/IHtcbiAgICAgIGxhdDogZXZlbnQubG9jYXRpb24ubGF0LFxuICAgICAgbG9uOiBldmVudC5sb2NhdGlvbi5sb24sXG4gICAgfSA6IHVuZGVmaW5lZCxcbiAgfTtcblxuICBjb25zdCBjb21tYW5kID0gbmV3IFB1dENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogQUxFUlRTX1RBQkxFLFxuICAgIEl0ZW06IGFsZXJ0UmVjb3JkLFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFN0b3JlZCBhbGVydCAke2FsZXJ0SWR9IGZvciAke2V2ZW50LmRldmljZV91aWR9YCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHB1Ymxpc2hBbGVydChldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBhbGVydE1lc3NhZ2UgPSB7XG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyLFxuICAgIGZsZWV0OiBldmVudC5mbGVldCxcbiAgICBhbGVydF90eXBlOiBldmVudC5ib2R5LnR5cGUsXG4gICAgdmFsdWU6IGV2ZW50LmJvZHkudmFsdWUsXG4gICAgdGhyZXNob2xkOiBldmVudC5ib2R5LnRocmVzaG9sZCxcbiAgICBtZXNzYWdlOiBldmVudC5ib2R5Lm1lc3NhZ2UsXG4gICAgdGltZXN0YW1wOiBldmVudC50aW1lc3RhbXAsXG4gICAgbG9jYXRpb246IGV2ZW50LmxvY2F0aW9uLFxuICB9O1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHVibGlzaENvbW1hbmQoe1xuICAgIFRvcGljQXJuOiBBTEVSVF9UT1BJQ19BUk4sXG4gICAgU3ViamVjdDogYFNvbmdiaXJkIEFsZXJ0OiAke2V2ZW50LmJvZHkudHlwZX0gLSAke2V2ZW50LnNlcmlhbF9udW1iZXIgfHwgZXZlbnQuZGV2aWNlX3VpZH1gLFxuICAgIE1lc3NhZ2U6IEpTT04uc3RyaW5naWZ5KGFsZXJ0TWVzc2FnZSwgbnVsbCwgMiksXG4gICAgTWVzc2FnZUF0dHJpYnV0ZXM6IHtcbiAgICAgIGFsZXJ0X3R5cGU6IHtcbiAgICAgICAgRGF0YVR5cGU6ICdTdHJpbmcnLFxuICAgICAgICBTdHJpbmdWYWx1ZTogZXZlbnQuYm9keS50eXBlIHx8ICd1bmtub3duJyxcbiAgICAgIH0sXG4gICAgICBkZXZpY2VfdWlkOiB7XG4gICAgICAgIERhdGFUeXBlOiAnU3RyaW5nJyxcbiAgICAgICAgU3RyaW5nVmFsdWU6IGV2ZW50LmRldmljZV91aWQsXG4gICAgICB9LFxuICAgICAgZmxlZXQ6IHtcbiAgICAgICAgRGF0YVR5cGU6ICdTdHJpbmcnLFxuICAgICAgICBTdHJpbmdWYWx1ZTogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICAgICAgfSxcbiAgICB9LFxuICB9KTtcblxuICBhd2FpdCBzbnNDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFB1Ymxpc2hlZCBhbGVydCB0byBTTlM6ICR7ZXZlbnQuYm9keS50eXBlfWApO1xufVxuXG4vKipcbiAqIFdyaXRlIEdQUyB0cmFja2luZyBldmVudCB0byB0ZWxlbWV0cnkgdGFibGVcbiAqIEhhbmRsZXMgX3RyYWNrLnFvIGV2ZW50cyBmcm9tIE5vdGVjYXJkJ3MgY2FyZC5sb2NhdGlvbi50cmFja1xuICovXG5hc3luYyBmdW5jdGlvbiB3cml0ZVRyYWNraW5nRXZlbnQoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKCFldmVudC5sb2NhdGlvbj8ubGF0IHx8ICFldmVudC5sb2NhdGlvbj8ubG9uKSB7XG4gICAgY29uc29sZS5sb2coJ05vIGxvY2F0aW9uIGRhdGEgaW4gX3RyYWNrLnFvIGV2ZW50LCBza2lwcGluZycpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHRpbWVzdGFtcCA9IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDA7IC8vIENvbnZlcnQgdG8gbWlsbGlzZWNvbmRzXG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgY29uc3QgcmVjb3JkOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge1xuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgdGltZXN0YW1wLFxuICAgIHR0bCxcbiAgICBkYXRhX3R5cGU6ICd0cmFja2luZycsXG4gICAgZXZlbnRfdHlwZTogZXZlbnQuZXZlbnRfdHlwZSxcbiAgICBldmVudF90eXBlX3RpbWVzdGFtcDogYHRyYWNraW5nIyR7dGltZXN0YW1wfWAsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgICBsYXRpdHVkZTogZXZlbnQubG9jYXRpb24ubGF0LFxuICAgIGxvbmdpdHVkZTogZXZlbnQubG9jYXRpb24ubG9uLFxuICAgIGxvY2F0aW9uX3NvdXJjZTogZXZlbnQubG9jYXRpb24uc291cmNlIHx8ICdncHMnLFxuICB9O1xuXG4gIC8vIEFkZCB0cmFja2luZy1zcGVjaWZpYyBmaWVsZHNcbiAgaWYgKGV2ZW50LmJvZHkudmVsb2NpdHkgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC52ZWxvY2l0eSA9IGV2ZW50LmJvZHkudmVsb2NpdHk7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuYmVhcmluZyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLmJlYXJpbmcgPSBldmVudC5ib2R5LmJlYXJpbmc7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuZGlzdGFuY2UgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5kaXN0YW5jZSA9IGV2ZW50LmJvZHkuZGlzdGFuY2U7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuc2Vjb25kcyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnNlY29uZHMgPSBldmVudC5ib2R5LnNlY29uZHM7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuZG9wICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQuZG9wID0gZXZlbnQuYm9keS5kb3A7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuam91cm5leSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLmpvdXJuZXlfaWQgPSBldmVudC5ib2R5LmpvdXJuZXk7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuamNvdW50ICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQuamNvdW50ID0gZXZlbnQuYm9keS5qY291bnQ7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkubW90aW9uICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQubW90aW9uID0gZXZlbnQuYm9keS5tb3Rpb247XG4gIH1cblxuICBjb25zdCBjb21tYW5kID0gbmV3IFB1dENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogVEVMRU1FVFJZX1RBQkxFLFxuICAgIEl0ZW06IHJlY29yZCxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBXcm90ZSB0cmFja2luZyBldmVudCBmb3IgJHtldmVudC5kZXZpY2VfdWlkfSAoam91cm5leTogJHtldmVudC5ib2R5LmpvdXJuZXl9LCBqY291bnQ6ICR7ZXZlbnQuYm9keS5qY291bnR9KWApO1xufVxuXG4vKipcbiAqIFVwc2VydCBqb3VybmV5IHJlY29yZFxuICogLSBDcmVhdGVzIG5ldyBqb3VybmV5IHdoZW4gamNvdW50ID09PSAxXG4gKiAtIFVwZGF0ZXMgZXhpc3Rpbmcgam91cm5leSB3aXRoIG5ldyBlbmRfdGltZSBhbmQgcG9pbnRfY291bnRcbiAqIC0gTWFya3MgcHJldmlvdXMgam91cm5leSBhcyBjb21wbGV0ZWQgd2hlbiBhIG5ldyBvbmUgc3RhcnRzXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHVwc2VydEpvdXJuZXkoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgam91cm5leUlkID0gZXZlbnQuYm9keS5qb3VybmV5O1xuICBjb25zdCBqY291bnQgPSBldmVudC5ib2R5Lmpjb3VudDtcblxuICBpZiAoIWpvdXJuZXlJZCB8fCAhamNvdW50KSB7XG4gICAgY29uc29sZS5sb2coJ01pc3Npbmcgam91cm5leSBvciBqY291bnQgaW4gX3RyYWNrLnFvIGV2ZW50LCBza2lwcGluZyBqb3VybmV5IHVwc2VydCcpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG4gIGNvbnN0IHRpbWVzdGFtcE1zID0gZXZlbnQudGltZXN0YW1wICogMTAwMDtcblxuICAvLyBJZiB0aGlzIGlzIHRoZSBmaXJzdCBwb2ludCBvZiBhIG5ldyBqb3VybmV5LCBtYXJrIHByZXZpb3VzIGpvdXJuZXkgYXMgY29tcGxldGVkXG4gIGlmIChqY291bnQgPT09IDEpIHtcbiAgICBhd2FpdCBtYXJrUHJldmlvdXNKb3VybmV5Q29tcGxldGVkKGV2ZW50LmRldmljZV91aWQsIGpvdXJuZXlJZCk7XG4gIH1cblxuICAvLyBDYWxjdWxhdGUgY3VtdWxhdGl2ZSBkaXN0YW5jZVxuICBjb25zdCBkaXN0YW5jZSA9IGV2ZW50LmJvZHkuZGlzdGFuY2UgfHwgMDtcblxuICAvLyBVcHNlcnQgam91cm5leSByZWNvcmRcbiAgY29uc3QgY29tbWFuZCA9IG5ldyBVcGRhdGVDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IEpPVVJORVlTX1RBQkxFLFxuICAgIEtleToge1xuICAgICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICAgIGpvdXJuZXlfaWQ6IGpvdXJuZXlJZCxcbiAgICB9LFxuICAgIFVwZGF0ZUV4cHJlc3Npb246IGBcbiAgICAgIFNFVCAjc3RhdHVzID0gOnN0YXR1cyxcbiAgICAgICAgICAjc3RhcnRfdGltZSA9IGlmX25vdF9leGlzdHMoI3N0YXJ0X3RpbWUsIDpzdGFydF90aW1lKSxcbiAgICAgICAgICAjZW5kX3RpbWUgPSA6ZW5kX3RpbWUsXG4gICAgICAgICAgI3BvaW50X2NvdW50ID0gOnBvaW50X2NvdW50LFxuICAgICAgICAgICN0b3RhbF9kaXN0YW5jZSA9IGlmX25vdF9leGlzdHMoI3RvdGFsX2Rpc3RhbmNlLCA6emVybykgKyA6ZGlzdGFuY2UsXG4gICAgICAgICAgI3R0bCA9IDp0dGwsXG4gICAgICAgICAgI3VwZGF0ZWRfYXQgPSA6dXBkYXRlZF9hdFxuICAgIGAsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAnI3N0YXR1cyc6ICdzdGF0dXMnLFxuICAgICAgJyNzdGFydF90aW1lJzogJ3N0YXJ0X3RpbWUnLFxuICAgICAgJyNlbmRfdGltZSc6ICdlbmRfdGltZScsXG4gICAgICAnI3BvaW50X2NvdW50JzogJ3BvaW50X2NvdW50JyxcbiAgICAgICcjdG90YWxfZGlzdGFuY2UnOiAndG90YWxfZGlzdGFuY2UnLFxuICAgICAgJyN0dGwnOiAndHRsJyxcbiAgICAgICcjdXBkYXRlZF9hdCc6ICd1cGRhdGVkX2F0JyxcbiAgICB9LFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6c3RhdHVzJzogJ2FjdGl2ZScsXG4gICAgICAnOnN0YXJ0X3RpbWUnOiBqb3VybmV5SWQgKiAxMDAwLCAvLyBDb252ZXJ0IHRvIG1pbGxpc2Vjb25kc1xuICAgICAgJzplbmRfdGltZSc6IHRpbWVzdGFtcE1zLFxuICAgICAgJzpwb2ludF9jb3VudCc6IGpjb3VudCxcbiAgICAgICc6ZGlzdGFuY2UnOiBkaXN0YW5jZSxcbiAgICAgICc6emVybyc6IDAsXG4gICAgICAnOnR0bCc6IHR0bCxcbiAgICAgICc6dXBkYXRlZF9hdCc6IG5vdyxcbiAgICB9LFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFVwc2VydGVkIGpvdXJuZXkgJHtqb3VybmV5SWR9IGZvciAke2V2ZW50LmRldmljZV91aWR9IChwb2ludCAke2pjb3VudH0pYCk7XG59XG5cbi8qKlxuICogTWFyayBwcmV2aW91cyBqb3VybmV5IGFzIGNvbXBsZXRlZCB3aGVuIGEgbmV3IGpvdXJuZXkgc3RhcnRzXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIG1hcmtQcmV2aW91c0pvdXJuZXlDb21wbGV0ZWQoZGV2aWNlVWlkOiBzdHJpbmcsIGN1cnJlbnRKb3VybmV5SWQ6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICAvLyBRdWVyeSBmb3IgdGhlIG1vc3QgcmVjZW50IGFjdGl2ZSBqb3VybmV5IHRoYXQncyBub3QgdGhlIGN1cnJlbnQgb25lXG4gIGNvbnN0IHF1ZXJ5Q29tbWFuZCA9IG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogSk9VUk5FWVNfVEFCTEUsXG4gICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQgPSA6ZGV2aWNlX3VpZCBBTkQgam91cm5leV9pZCA8IDpjdXJyZW50X2pvdXJuZXknLFxuICAgIEZpbHRlckV4cHJlc3Npb246ICcjc3RhdHVzID0gOmFjdGl2ZScsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAnI3N0YXR1cyc6ICdzdGF0dXMnLFxuICAgIH0sXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgJzpjdXJyZW50X2pvdXJuZXknOiBjdXJyZW50Sm91cm5leUlkLFxuICAgICAgJzphY3RpdmUnOiAnYWN0aXZlJyxcbiAgICB9LFxuICAgIFNjYW5JbmRleEZvcndhcmQ6IGZhbHNlLCAvLyBNb3N0IHJlY2VudCBmaXJzdFxuICAgIExpbWl0OiAxLFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChxdWVyeUNvbW1hbmQpO1xuXG4gIGlmIChyZXN1bHQuSXRlbXMgJiYgcmVzdWx0Lkl0ZW1zLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBwcmV2aW91c0pvdXJuZXkgPSByZXN1bHQuSXRlbXNbMF07XG5cbiAgICBjb25zdCB1cGRhdGVDb21tYW5kID0gbmV3IFVwZGF0ZUNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICAgIEtleToge1xuICAgICAgICBkZXZpY2VfdWlkOiBkZXZpY2VVaWQsXG4gICAgICAgIGpvdXJuZXlfaWQ6IHByZXZpb3VzSm91cm5leS5qb3VybmV5X2lkLFxuICAgICAgfSxcbiAgICAgIFVwZGF0ZUV4cHJlc3Npb246ICdTRVQgI3N0YXR1cyA9IDpzdGF0dXMsICN1cGRhdGVkX2F0ID0gOnVwZGF0ZWRfYXQnLFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAgICcjc3RhdHVzJzogJ3N0YXR1cycsXG4gICAgICAgICcjdXBkYXRlZF9hdCc6ICd1cGRhdGVkX2F0JyxcbiAgICAgIH0sXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICc6c3RhdHVzJzogJ2NvbXBsZXRlZCcsXG4gICAgICAgICc6dXBkYXRlZF9hdCc6IERhdGUubm93KCksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgYXdhaXQgZG9jQ2xpZW50LnNlbmQodXBkYXRlQ29tbWFuZCk7XG4gICAgY29uc29sZS5sb2coYE1hcmtlZCBqb3VybmV5ICR7cHJldmlvdXNKb3VybmV5LmpvdXJuZXlfaWR9IGFzIGNvbXBsZXRlZCBmb3IgJHtkZXZpY2VVaWR9YCk7XG4gIH1cbn1cblxuLyoqXG4gKiBXcml0ZSBsb2NhdGlvbiB0byB0aGUgbG9jYXRpb25zIGhpc3RvcnkgdGFibGVcbiAqIFJlY29yZHMgYWxsIGxvY2F0aW9uIGV2ZW50cyByZWdhcmRsZXNzIG9mIHNvdXJjZSBmb3IgdW5pZmllZCBsb2NhdGlvbiBoaXN0b3J5XG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlTG9jYXRpb25IaXN0b3J5KGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmICghZXZlbnQubG9jYXRpb24/LmxhdCB8fCAhZXZlbnQubG9jYXRpb24/Lmxvbikge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHRpbWVzdGFtcCA9IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDA7IC8vIENvbnZlcnQgdG8gbWlsbGlzZWNvbmRzXG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgY29uc3QgcmVjb3JkOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge1xuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgdGltZXN0YW1wLFxuICAgIHR0bCxcbiAgICBsYXRpdHVkZTogZXZlbnQubG9jYXRpb24ubGF0LFxuICAgIGxvbmdpdHVkZTogZXZlbnQubG9jYXRpb24ubG9uLFxuICAgIHNvdXJjZTogZXZlbnQubG9jYXRpb24uc291cmNlIHx8ICd1bmtub3duJyxcbiAgICBsb2NhdGlvbl9uYW1lOiBldmVudC5sb2NhdGlvbi5uYW1lLFxuICAgIGV2ZW50X3R5cGU6IGV2ZW50LmV2ZW50X3R5cGUsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgfTtcblxuICAvLyBBZGQgam91cm5leSBpbmZvIGlmIHRoaXMgaXMgYSB0cmFja2luZyBldmVudFxuICBpZiAoZXZlbnQuZXZlbnRfdHlwZSA9PT0gJ190cmFjay5xbycpIHtcbiAgICBpZiAoZXZlbnQuYm9keS5qb3VybmV5ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHJlY29yZC5qb3VybmV5X2lkID0gZXZlbnQuYm9keS5qb3VybmV5O1xuICAgIH1cbiAgICBpZiAoZXZlbnQuYm9keS5qY291bnQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgcmVjb3JkLmpjb3VudCA9IGV2ZW50LmJvZHkuamNvdW50O1xuICAgIH1cbiAgICBpZiAoZXZlbnQuYm9keS52ZWxvY2l0eSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICByZWNvcmQudmVsb2NpdHkgPSBldmVudC5ib2R5LnZlbG9jaXR5O1xuICAgIH1cbiAgICBpZiAoZXZlbnQuYm9keS5iZWFyaW5nICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHJlY29yZC5iZWFyaW5nID0gZXZlbnQuYm9keS5iZWFyaW5nO1xuICAgIH1cbiAgICBpZiAoZXZlbnQuYm9keS5kaXN0YW5jZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICByZWNvcmQuZGlzdGFuY2UgPSBldmVudC5ib2R5LmRpc3RhbmNlO1xuICAgIH1cbiAgICBpZiAoZXZlbnQuYm9keS5kb3AgIT09IHVuZGVmaW5lZCkge1xuICAgICAgcmVjb3JkLmRvcCA9IGV2ZW50LmJvZHkuZG9wO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBMT0NBVElPTlNfVEFCTEUsXG4gICAgSXRlbTogcmVjb3JkLFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFdyb3RlIGxvY2F0aW9uIGhpc3RvcnkgZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH06ICR7ZXZlbnQubG9jYXRpb24uc291cmNlfSAoJHtldmVudC5sb2NhdGlvbi5sYXR9LCAke2V2ZW50LmxvY2F0aW9uLmxvbn0pYCk7XG59XG5cbi8qKlxuICogQ29tcGxldGUgYWxsIGFjdGl2ZSBqb3VybmV5cyB3aGVuIGRldmljZSBleGl0cyB0cmFuc2l0IG1vZGVcbiAqIFRoaXMgZW5zdXJlcyBqb3VybmV5cyBhcmUgcHJvcGVybHkgY2xvc2VkIHdoZW4gbW9kZSBjaGFuZ2VzIHRvIGRlbW8sIHN0b3JhZ2UsIG9yIHNsZWVwXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNvbXBsZXRlQWN0aXZlSm91cm5leXNPbk1vZGVDaGFuZ2UoZGV2aWNlVWlkOiBzdHJpbmcsIG5ld01vZGU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAvLyBRdWVyeSBmb3IgYWxsIGFjdGl2ZSBqb3VybmV5cyBmb3IgdGhpcyBkZXZpY2VcbiAgY29uc3QgcXVlcnlDb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICBJbmRleE5hbWU6ICdzdGF0dXMtaW5kZXgnLFxuICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICcjc3RhdHVzID0gOmFjdGl2ZScsXG4gICAgRmlsdGVyRXhwcmVzc2lvbjogJ2RldmljZV91aWQgPSA6ZGV2aWNlX3VpZCcsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAnI3N0YXR1cyc6ICdzdGF0dXMnLFxuICAgIH0sXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzphY3RpdmUnOiAnYWN0aXZlJyxcbiAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICB9LFxuICB9KTtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKHF1ZXJ5Q29tbWFuZCk7XG5cbiAgICBpZiAocmVzdWx0Lkl0ZW1zICYmIHJlc3VsdC5JdGVtcy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zb2xlLmxvZyhgTW9kZSBjaGFuZ2VkIHRvICR7bmV3TW9kZX0gLSBjb21wbGV0aW5nICR7cmVzdWx0Lkl0ZW1zLmxlbmd0aH0gYWN0aXZlIGpvdXJuZXkocykgZm9yICR7ZGV2aWNlVWlkfWApO1xuXG4gICAgICAvLyBNYXJrIGVhY2ggYWN0aXZlIGpvdXJuZXkgYXMgY29tcGxldGVkXG4gICAgICBmb3IgKGNvbnN0IGpvdXJuZXkgb2YgcmVzdWx0Lkl0ZW1zKSB7XG4gICAgICAgIGNvbnN0IHVwZGF0ZUNvbW1hbmQgPSBuZXcgVXBkYXRlQ29tbWFuZCh7XG4gICAgICAgICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICAgICAgICBLZXk6IHtcbiAgICAgICAgICAgIGRldmljZV91aWQ6IGRldmljZVVpZCxcbiAgICAgICAgICAgIGpvdXJuZXlfaWQ6IGpvdXJuZXkuam91cm5leV9pZCxcbiAgICAgICAgICB9LFxuICAgICAgICAgIFVwZGF0ZUV4cHJlc3Npb246ICdTRVQgI3N0YXR1cyA9IDpzdGF0dXMsICN1cGRhdGVkX2F0ID0gOnVwZGF0ZWRfYXQnLFxuICAgICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczoge1xuICAgICAgICAgICAgJyNzdGF0dXMnOiAnc3RhdHVzJyxcbiAgICAgICAgICAgICcjdXBkYXRlZF9hdCc6ICd1cGRhdGVkX2F0JyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgICAgICc6c3RhdHVzJzogJ2NvbXBsZXRlZCcsXG4gICAgICAgICAgICAnOnVwZGF0ZWRfYXQnOiBEYXRlLm5vdygpLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGF3YWl0IGRvY0NsaWVudC5zZW5kKHVwZGF0ZUNvbW1hbmQpO1xuICAgICAgICBjb25zb2xlLmxvZyhgTWFya2VkIGpvdXJuZXkgJHtqb3VybmV5LmpvdXJuZXlfaWR9IGFzIGNvbXBsZXRlZCBkdWUgdG8gbW9kZSBjaGFuZ2UgdG8gJHtuZXdNb2RlfWApO1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAvLyBMb2cgYnV0IGRvbid0IGZhaWwgdGhlIHJlcXVlc3QgLSBqb3VybmV5IGNvbXBsZXRpb24gaXMgbm90IGNyaXRpY2FsXG4gICAgY29uc29sZS5lcnJvcihgRXJyb3IgY29tcGxldGluZyBhY3RpdmUgam91cm5leXMgb24gbW9kZSBjaGFuZ2U6ICR7ZXJyb3J9YCk7XG4gIH1cbn1cbiJdfQ==