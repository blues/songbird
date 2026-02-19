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
const device_lookup_1 = require("../shared/device-lookup");
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
        // Reject events without serial number
        if (!notehubEvent.sn || notehubEvent.sn.trim() === '') {
            console.error(`Rejecting event - no serial number set for device ${notehubEvent.device}`);
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Serial number (sn) is required. Configure the device serial number in Notehub.' }),
            };
        }
        // Handle device alias (create if new, detect Notecard swaps)
        const aliasResult = await (0, device_lookup_1.handleDeviceAlias)(notehubEvent.sn, notehubEvent.device);
        // If a Notecard swap was detected, write an event for the activity feed
        if (aliasResult.isSwap && aliasResult.oldDeviceUid) {
            await writeNotecardSwapEvent(notehubEvent.sn, aliasResult.oldDeviceUid, notehubEvent.device, notehubEvent.when || Math.floor(notehubEvent.received));
        }
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
        // For _track.qo events, the "status" field (e.g., "no-sat") can appear at the top level
        // or inside the body, depending on Notehub HTTP route configuration
        const gpsStatus = notehubEvent.status || notehubEvent.body?.status;
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
            status: gpsStatus, // GPS status from _track.qo events (e.g., "no-sat")
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
            // Check for no-sat status (GPS cannot acquire satellite fix)
            // Status can be at top level or in body depending on Notehub route config
            console.log(`_track.qo event - status: ${songbirdEvent.status}, body.status: ${songbirdEvent.body?.status}`);
            if (songbirdEvent.status === 'no-sat') {
                console.log(`Detected no-sat status for ${songbirdEvent.device_uid}`);
                await checkNoSatAlert(songbirdEvent);
            }
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
        // Check for GPS power save state change (track.qo only)
        if (songbirdEvent.event_type === 'track.qo' && songbirdEvent.body.gps_power_saving === true) {
            await checkGpsPowerSaveAlert(songbirdEvent);
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
// Low battery threshold in volts
const LOW_BATTERY_THRESHOLD = 3.0;
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
    // Check for low battery condition: voltage < 3.0V and device restarted
    if (typeof event.body.voltage === 'number' &&
        event.body.voltage < LOW_BATTERY_THRESHOLD &&
        typeof event.body.text === 'string' &&
        event.body.text.includes('restarted')) {
        await createLowBatteryAlert(event);
    }
}
/**
 * Create a low battery alert when device restarts due to insufficient power
 */
async function createLowBatteryAlert(event) {
    // Skip if unacknowledged alert already exists
    if (await hasUnacknowledgedAlert(event.device_uid, 'low_battery')) {
        return;
    }
    const now = Date.now();
    const ttl = Math.floor(now / 1000) + TTL_SECONDS;
    const alertId = `alert_${event.device_uid}_${now}_${Math.random().toString(36).substring(7)}`;
    const alertRecord = {
        alert_id: alertId,
        device_uid: event.device_uid,
        serial_number: event.serial_number || 'unknown',
        fleet: event.fleet || 'default',
        type: 'low_battery',
        value: event.body.voltage,
        message: `Device restarted due to low battery (${event.body.voltage?.toFixed(2)}V)`,
        created_at: now,
        event_timestamp: event.timestamp * 1000,
        acknowledged: 'false',
        ttl,
        location: event.location ? {
            lat: event.location.lat,
            lon: event.location.lon,
        } : undefined,
        metadata: {
            voltage: event.body.voltage,
            voltage_mode: event.body.voltage_mode,
            milliamp_hours: event.body.milliamp_hours,
            health_text: event.body.text,
        },
    };
    const command = new lib_dynamodb_1.PutCommand({
        TableName: ALERTS_TABLE,
        Item: alertRecord,
    });
    await docClient.send(command);
    console.log(`Created low battery alert ${alertId} for ${event.device_uid} (${event.body.voltage?.toFixed(2)}V)`);
    // Publish to SNS for notifications
    const alertMessage = {
        device_uid: event.device_uid,
        serial_number: event.serial_number,
        fleet: event.fleet,
        alert_type: 'low_battery',
        value: event.body.voltage,
        message: `Device restarted due to low battery (${event.body.voltage?.toFixed(2)}V)`,
        timestamp: event.timestamp,
        location: event.location,
    };
    const publishCommand = new client_sns_1.PublishCommand({
        TopicArn: ALERT_TOPIC_ARN,
        Subject: `Songbird Alert: Low Battery - ${event.serial_number || event.device_uid}`,
        Message: JSON.stringify(alertMessage, null, 2),
        MessageAttributes: {
            alert_type: {
                DataType: 'String',
                StringValue: 'low_battery',
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
    await snsClient.send(publishCommand);
    console.log(`Published low battery alert to SNS for ${event.device_uid}`);
}
/**
 * Check if GPS power save alert should be created
 * Only creates alert if gps_power_saving state changed from false to true
 */
async function checkGpsPowerSaveAlert(event) {
    try {
        // Get current device state to check if gps_power_saving was already true
        const getCommand = new lib_dynamodb_1.GetCommand({
            TableName: DEVICES_TABLE,
            Key: { device_uid: event.device_uid },
            ProjectionExpression: 'gps_power_saving',
        });
        const result = await docClient.send(getCommand);
        const wasGpsPowerSaving = result.Item?.gps_power_saving === true;
        // Only create alert if state changed from false to true
        if (!wasGpsPowerSaving) {
            await createGpsPowerSaveAlert(event);
        }
    }
    catch (error) {
        // Log but don't fail the request - alert creation is not critical
        console.error(`Error checking GPS power save alert: ${error}`);
    }
}
/**
 * Create a GPS power save alert when device disables GPS due to no signal
 */
async function createGpsPowerSaveAlert(event) {
    // Skip if unacknowledged alert already exists
    if (await hasUnacknowledgedAlert(event.device_uid, 'gps_power_save')) {
        return;
    }
    const now = Date.now();
    const ttl = Math.floor(now / 1000) + TTL_SECONDS;
    const alertId = `alert_${event.device_uid}_${now}_${Math.random().toString(36).substring(7)}`;
    const alertRecord = {
        alert_id: alertId,
        device_uid: event.device_uid,
        serial_number: event.serial_number || 'unknown',
        fleet: event.fleet || 'default',
        type: 'gps_power_save',
        message: 'GPS disabled for power saving - unable to acquire satellite signal',
        created_at: now,
        event_timestamp: event.timestamp * 1000,
        acknowledged: 'false',
        ttl,
        location: event.location ? {
            lat: event.location.lat,
            lon: event.location.lon,
        } : undefined,
        metadata: {
            mode: event.body.mode,
            transit_locked: event.body.transit_locked,
        },
    };
    const command = new lib_dynamodb_1.PutCommand({
        TableName: ALERTS_TABLE,
        Item: alertRecord,
    });
    await docClient.send(command);
    console.log(`Created GPS power save alert ${alertId} for ${event.device_uid}`);
    // Publish to SNS for notifications
    const alertMessage = {
        device_uid: event.device_uid,
        serial_number: event.serial_number,
        fleet: event.fleet,
        alert_type: 'gps_power_save',
        message: 'GPS disabled for power saving - unable to acquire satellite signal',
        timestamp: event.timestamp,
        location: event.location,
    };
    const publishCommand = new client_sns_1.PublishCommand({
        TopicArn: ALERT_TOPIC_ARN,
        Subject: `Songbird Alert: GPS Power Save - ${event.serial_number || event.device_uid}`,
        Message: JSON.stringify(alertMessage, null, 2),
        MessageAttributes: {
            alert_type: {
                DataType: 'String',
                StringValue: 'gps_power_save',
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
    await snsClient.send(publishCommand);
    console.log(`Published GPS power save alert to SNS for ${event.device_uid}`);
}
/**
 * Check if no-sat alert should be created
 * Only creates alert if gps_no_sat state changed from false to true
 */
async function checkNoSatAlert(event) {
    try {
        // Get current device state to check if gps_no_sat was already true
        const getCommand = new lib_dynamodb_1.GetCommand({
            TableName: DEVICES_TABLE,
            Key: { device_uid: event.device_uid },
            ProjectionExpression: 'gps_no_sat',
        });
        const result = await docClient.send(getCommand);
        const wasNoSat = result.Item?.gps_no_sat === true;
        // Only create alert if state changed from false to true
        if (!wasNoSat) {
            await createNoSatAlert(event);
        }
    }
    catch (error) {
        // Log but don't fail the request - alert creation is not critical
        console.error(`Error checking no-sat alert: ${error}`);
    }
}
/**
 * Create a no-sat alert when device cannot acquire satellite fix
 */
async function createNoSatAlert(event) {
    // Skip if unacknowledged alert already exists
    if (await hasUnacknowledgedAlert(event.device_uid, 'gps_no_sat')) {
        return;
    }
    const now = Date.now();
    const ttl = Math.floor(now / 1000) + TTL_SECONDS;
    const alertId = `alert_${event.device_uid}_${now}_${Math.random().toString(36).substring(7)}`;
    const alertRecord = {
        alert_id: alertId,
        device_uid: event.device_uid,
        serial_number: event.serial_number || 'unknown',
        fleet: event.fleet || 'default',
        type: 'gps_no_sat',
        message: 'Unable to obtain GPS location',
        created_at: now,
        event_timestamp: event.timestamp * 1000,
        acknowledged: 'false',
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
    console.log(`Created no-sat alert ${alertId} for ${event.device_uid}`);
    // Publish to SNS for notifications
    const alertMessage = {
        device_uid: event.device_uid,
        serial_number: event.serial_number,
        fleet: event.fleet,
        alert_type: 'gps_no_sat',
        message: 'Unable to obtain GPS location',
        timestamp: event.timestamp,
        location: event.location,
    };
    const publishCommand = new client_sns_1.PublishCommand({
        TopicArn: ALERT_TOPIC_ARN,
        Subject: `Songbird Alert: Unable to obtain GPS location - ${event.serial_number || event.device_uid}`,
        Message: JSON.stringify(alertMessage, null, 2),
        MessageAttributes: {
            alert_type: {
                DataType: 'String',
                StringValue: 'gps_no_sat',
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
    await snsClient.send(publishCommand);
    console.log(`Published no-sat alert to SNS for ${event.device_uid}`);
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
    // For track.qo events, update lock states and GPS power state
    // If locked/gps_power_saving is true, set it; if absent or false, clear it
    if (event.event_type === 'track.qo') {
        updateExpressions.push('#transit_locked = :transit_locked');
        expressionAttributeNames['#transit_locked'] = 'transit_locked';
        expressionAttributeValues[':transit_locked'] = event.body.transit_locked === true;
        updateExpressions.push('#demo_locked = :demo_locked');
        expressionAttributeNames['#demo_locked'] = 'demo_locked';
        expressionAttributeValues[':demo_locked'] = event.body.demo_locked === true;
        updateExpressions.push('#gps_power_saving = :gps_power_saving');
        expressionAttributeNames['#gps_power_saving'] = 'gps_power_saving';
        expressionAttributeValues[':gps_power_saving'] = event.body.gps_power_saving === true;
    }
    // For _track.qo events, track gps_no_sat status
    if (event.event_type === '_track.qo') {
        updateExpressions.push('#gps_no_sat = :gps_no_sat');
        expressionAttributeNames['#gps_no_sat'] = 'gps_no_sat';
        expressionAttributeValues[':gps_no_sat'] = event.status === 'no-sat';
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
    // Clear pending_mode if the device's reported mode matches it
    if (event.body.mode) {
        try {
            await docClient.send(new lib_dynamodb_1.UpdateCommand({
                TableName: DEVICES_TABLE,
                Key: { device_uid: event.device_uid },
                UpdateExpression: 'REMOVE pending_mode',
                ConditionExpression: 'pending_mode = :reported_mode',
                ExpressionAttributeValues: { ':reported_mode': event.body.mode },
            }));
            console.log(`Cleared pending_mode for ${event.device_uid} (matched ${event.body.mode})`);
        }
        catch (err) {
            if (err.name !== 'ConditionalCheckFailedException') {
                console.error('Error clearing pending_mode:', err);
            }
        }
    }
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
    const alertType = event.body.type || 'unknown';
    // Skip if unacknowledged alert already exists
    if (await hasUnacknowledgedAlert(event.device_uid, alertType)) {
        return;
    }
    const now = Date.now();
    const ttl = Math.floor(now / 1000) + TTL_SECONDS;
    // Generate a unique alert ID
    const alertId = `alert_${event.device_uid}_${now}_${Math.random().toString(36).substring(7)}`;
    const alertRecord = {
        alert_id: alertId,
        device_uid: event.device_uid,
        serial_number: event.serial_number || 'unknown',
        fleet: event.fleet || 'default',
        type: alertType,
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
/**
 * Write a Notecard swap event to the telemetry table for the activity feed
 */
async function writeNotecardSwapEvent(serialNumber, oldDeviceUid, newDeviceUid, timestamp) {
    const timestampMs = timestamp * 1000;
    const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    const record = {
        device_uid: newDeviceUid,
        serial_number: serialNumber,
        timestamp: timestampMs,
        ttl,
        data_type: 'notecard_swap',
        event_type: 'notecard_swap',
        event_type_timestamp: `notecard_swap#${timestampMs}`,
        old_device_uid: oldDeviceUid,
        new_device_uid: newDeviceUid,
    };
    const command = new lib_dynamodb_1.PutCommand({
        TableName: TELEMETRY_TABLE,
        Item: record,
    });
    await docClient.send(command);
    console.log(`Recorded Notecard swap for ${serialNumber}: ${oldDeviceUid} -> ${newDeviceUid}`);
}
/**
 * Check if device has an unacknowledged alert of the specified type
 * Used to prevent duplicate alerts from piling up
 */
async function hasUnacknowledgedAlert(deviceUid, alertType) {
    const queryCommand = new lib_dynamodb_1.QueryCommand({
        TableName: ALERTS_TABLE,
        IndexName: 'device-index',
        KeyConditionExpression: 'device_uid = :device_uid',
        FilterExpression: '#type = :alert_type AND acknowledged = :false',
        ExpressionAttributeNames: {
            '#type': 'type',
        },
        ExpressionAttributeValues: {
            ':device_uid': deviceUid,
            ':alert_type': alertType,
            ':false': 'false',
        },
        Limit: 1,
        ScanIndexForward: false, // Most recent first
    });
    try {
        const result = await docClient.send(queryCommand);
        const hasUnacked = (result.Items?.length || 0) > 0;
        if (hasUnacked) {
            console.log(`Skipping duplicate alert creation: device ${deviceUid} already has unacknowledged ${alertType} alert`);
        }
        return hasUnacked;
    }
    catch (error) {
        console.error(`Error checking for duplicate alert: ${error}`);
        // On error, allow alert creation (fail open)
        return false;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWluZ2VzdC9pbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7O0dBS0c7OztBQUVILDhEQUEwRDtBQUMxRCx3REFBb0g7QUFDcEgsb0RBQWdFO0FBRWhFLDJEQUE0RDtBQUU1RCxxQkFBcUI7QUFDckIsTUFBTSxTQUFTLEdBQUcsSUFBSSxnQ0FBYyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQ3pDLE1BQU0sU0FBUyxHQUFHLHFDQUFzQixDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUU7SUFDdkQsZUFBZSxFQUFFO1FBQ2YscUJBQXFCLEVBQUUsSUFBSTtLQUM1QjtDQUNGLENBQUMsQ0FBQztBQUNILE1BQU0sU0FBUyxHQUFHLElBQUksc0JBQVMsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUVwQyx3QkFBd0I7QUFDeEIsTUFBTSxlQUFlLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxlQUFnQixDQUFDO0FBQ3JELE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsYUFBYyxDQUFDO0FBQ2pELE1BQU0sY0FBYyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsY0FBZSxDQUFDO0FBQ25ELE1BQU0sWUFBWSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsWUFBYSxDQUFDO0FBQy9DLE1BQU0sZUFBZSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsZUFBZ0IsQ0FBQztBQUNyRCxNQUFNLGNBQWMsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGNBQWUsQ0FBQztBQUNuRCxNQUFNLGVBQWUsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGVBQWdCLENBQUM7QUFFckQsMEJBQTBCO0FBQzFCLE1BQU0sUUFBUSxHQUFHLEVBQUUsQ0FBQztBQUNwQixNQUFNLFdBQVcsR0FBRyxRQUFRLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLENBQUM7QUFtRnJD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Ii8qKlxuICogRXZlbnQgSW5nZXN0IEFQSSBMYW1iZGFcbiAqXG4gKiBIVFRQIGVuZHBvaW50IGZvciByZWNlaXZpbmcgZXZlbnRzIGZyb20gTm90ZWh1YiBIVFRQIHJvdXRlcy5cbiAqIFByb2Nlc3NlcyBpbmNvbWluZyBTb25nYmlyZCBldmVudHMgYW5kIHdyaXRlcyB0byBEeW5hbW9EQi5cbiAqL1xuXG5pbXBvcnQgeyBEeW5hbW9EQkNsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYic7XG5pbXBvcnQgeyBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LCBQdXRDb21tYW5kLCBVcGRhdGVDb21tYW5kLCBRdWVyeUNvbW1hbmQsIEdldENvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9saWItZHluYW1vZGInO1xuaW1wb3J0IHsgU05TQ2xpZW50LCBQdWJsaXNoQ29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1zbnMnO1xuaW1wb3J0IHsgQVBJR2F0ZXdheVByb3h5RXZlbnQsIEFQSUdhdGV3YXlQcm94eVJlc3VsdCB9IGZyb20gJ2F3cy1sYW1iZGEnO1xuaW1wb3J0IHsgaGFuZGxlRGV2aWNlQWxpYXMgfSBmcm9tICcuLi9zaGFyZWQvZGV2aWNlLWxvb2t1cCc7XG5cbi8vIEluaXRpYWxpemUgY2xpZW50c1xuY29uc3QgZGRiQ2xpZW50ID0gbmV3IER5bmFtb0RCQ2xpZW50KHt9KTtcbmNvbnN0IGRvY0NsaWVudCA9IER5bmFtb0RCRG9jdW1lbnRDbGllbnQuZnJvbShkZGJDbGllbnQsIHtcbiAgbWFyc2hhbGxPcHRpb25zOiB7XG4gICAgcmVtb3ZlVW5kZWZpbmVkVmFsdWVzOiB0cnVlLFxuICB9LFxufSk7XG5jb25zdCBzbnNDbGllbnQgPSBuZXcgU05TQ2xpZW50KHt9KTtcblxuLy8gRW52aXJvbm1lbnQgdmFyaWFibGVzXG5jb25zdCBURUxFTUVUUllfVEFCTEUgPSBwcm9jZXNzLmVudi5URUxFTUVUUllfVEFCTEUhO1xuY29uc3QgREVWSUNFU19UQUJMRSA9IHByb2Nlc3MuZW52LkRFVklDRVNfVEFCTEUhO1xuY29uc3QgQ09NTUFORFNfVEFCTEUgPSBwcm9jZXNzLmVudi5DT01NQU5EU19UQUJMRSE7XG5jb25zdCBBTEVSVFNfVEFCTEUgPSBwcm9jZXNzLmVudi5BTEVSVFNfVEFCTEUhO1xuY29uc3QgQUxFUlRfVE9QSUNfQVJOID0gcHJvY2Vzcy5lbnYuQUxFUlRfVE9QSUNfQVJOITtcbmNvbnN0IEpPVVJORVlTX1RBQkxFID0gcHJvY2Vzcy5lbnYuSk9VUk5FWVNfVEFCTEUhO1xuY29uc3QgTE9DQVRJT05TX1RBQkxFID0gcHJvY2Vzcy5lbnYuTE9DQVRJT05TX1RBQkxFITtcblxuLy8gVFRMOiA5MCBkYXlzIGluIHNlY29uZHNcbmNvbnN0IFRUTF9EQVlTID0gOTA7XG5jb25zdCBUVExfU0VDT05EUyA9IFRUTF9EQVlTICogMjQgKiA2MCAqIDYwO1xuXG4vLyBOb3RlaHViIGV2ZW50IHN0cnVjdHVyZSAoZnJvbSBIVFRQIHJvdXRlKVxuaW50ZXJmYWNlIE5vdGVodWJFdmVudCB7XG4gIGV2ZW50OiBzdHJpbmc7ICAgICAgICAgICAvLyBlLmcuLCBcImRldjp4eHh4eCN0cmFjay5xbyMxXCJcbiAgc2Vzc2lvbjogc3RyaW5nO1xuICBiZXN0X2lkOiBzdHJpbmc7XG4gIGRldmljZTogc3RyaW5nOyAgICAgICAgICAvLyBEZXZpY2UgVUlEXG4gIHNuOiBzdHJpbmc7ICAgICAgICAgICAgICAvLyBTZXJpYWwgbnVtYmVyXG4gIHByb2R1Y3Q6IHN0cmluZztcbiAgYXBwOiBzdHJpbmc7XG4gIHJlY2VpdmVkOiBudW1iZXI7XG4gIHJlcTogc3RyaW5nOyAgICAgICAgICAgICAvLyBlLmcuLCBcIm5vdGUuYWRkXCJcbiAgd2hlbjogbnVtYmVyOyAgICAgICAgICAgIC8vIFVuaXggdGltZXN0YW1wXG4gIGZpbGU6IHN0cmluZzsgICAgICAgICAgICAvLyBlLmcuLCBcInRyYWNrLnFvXCJcbiAgYm9keToge1xuICAgIHRlbXA/OiBudW1iZXI7XG4gICAgaHVtaWRpdHk/OiBudW1iZXI7XG4gICAgcHJlc3N1cmU/OiBudW1iZXI7XG4gICAgLy8gTm90ZTogdm9sdGFnZSBpcyBubyBsb25nZXIgc2VudCBpbiB0cmFjay5xbzsgYmF0dGVyeSBpbmZvIGNvbWVzIGZyb20gX2xvZy5xbyBhbmQgX2hlYWx0aC5xb1xuICAgIG1vdGlvbj86IGJvb2xlYW4gfCBudW1iZXI7XG4gICAgbW9kZT86IHN0cmluZztcbiAgICB0cmFuc2l0X2xvY2tlZD86IGJvb2xlYW47XG4gICAgZGVtb19sb2NrZWQ/OiBib29sZWFuO1xuICAgIGdwc19wb3dlcl9zYXZpbmc/OiBib29sZWFuO1xuICAgIC8vIEFsZXJ0LXNwZWNpZmljIGZpZWxkc1xuICAgIHR5cGU/OiBzdHJpbmc7XG4gICAgdmFsdWU/OiBudW1iZXI7XG4gICAgdGhyZXNob2xkPzogbnVtYmVyO1xuICAgIG1lc3NhZ2U/OiBzdHJpbmc7XG4gICAgLy8gQ29tbWFuZCBhY2sgZmllbGRzXG4gICAgY21kPzogc3RyaW5nO1xuICAgIHN0YXR1cz86IHN0cmluZztcbiAgICBleGVjdXRlZF9hdD86IG51bWJlcjtcbiAgICAvLyBNb2pvIHBvd2VyIG1vbml0b3JpbmcgZmllbGRzIChfbG9nLnFvKVxuICAgIG1pbGxpYW1wX2hvdXJzPzogbnVtYmVyO1xuICAgIHRlbXBlcmF0dXJlPzogbnVtYmVyO1xuICAgIC8vIEhlYWx0aCBldmVudCBmaWVsZHMgKF9oZWFsdGgucW8pXG4gICAgbWV0aG9kPzogc3RyaW5nO1xuICAgIHRleHQ/OiBzdHJpbmc7XG4gICAgdm9sdGFnZV9tb2RlPzogc3RyaW5nO1xuICAgIC8vIFNlc3Npb24gZmllbGRzIG1heSBhcHBlYXIgaW4gYm9keSBmb3IgX3Nlc3Npb24ucW9cbiAgICBwb3dlcl91c2I/OiBib29sZWFuO1xuICAgIC8vIEdQUyB0cmFja2luZyBmaWVsZHMgKF90cmFjay5xbylcbiAgICB2ZWxvY2l0eT86IG51bWJlcjsgICAgICAvLyBTcGVlZCBpbiBtL3NcbiAgICBiZWFyaW5nPzogbnVtYmVyOyAgICAgICAvLyBEaXJlY3Rpb24gaW4gZGVncmVlcyBmcm9tIG5vcnRoXG4gICAgZGlzdGFuY2U/OiBudW1iZXI7ICAgICAgLy8gRGlzdGFuY2UgZnJvbSBwcmV2aW91cyBwb2ludCBpbiBtZXRlcnNcbiAgICBzZWNvbmRzPzogbnVtYmVyOyAgICAgICAvLyBTZWNvbmRzIHNpbmNlIHByZXZpb3VzIHRyYWNraW5nIGV2ZW50XG4gICAgZG9wPzogbnVtYmVyOyAgICAgICAgICAvLyBEaWx1dGlvbiBvZiBwcmVjaXNpb24gKEdQUyBhY2N1cmFjeSlcbiAgICBqb3VybmV5PzogbnVtYmVyOyAgICAgIC8vIEpvdXJuZXkgSUQgKFVuaXggdGltZXN0YW1wIG9mIGpvdXJuZXkgc3RhcnQpXG4gICAgamNvdW50PzogbnVtYmVyOyAgICAgICAvLyBQb2ludCBudW1iZXIgaW4gY3VycmVudCBqb3VybmV5IChzdGFydHMgYXQgMSlcbiAgICB0aW1lPzogbnVtYmVyOyAgICAgICAgIC8vIFRpbWVzdGFtcCB3aGVuIEdQUyBmaXggd2FzIGNhcHR1cmVkXG4gIH07XG4gIC8vIF90cmFjay5xbyBzdGF0dXMgZmllbGQgaW5kaWNhdGVzIEdQUyBmaXggc3RhdHVzIChhdCB0b3AgbGV2ZWwgb2YgZXZlbnQpXG4gIC8vIFwibm8tc2F0XCIgbWVhbnMgZGV2aWNlIGNhbm5vdCBhY3F1aXJlIHNhdGVsbGl0ZSBmaXhcbiAgc3RhdHVzPzogc3RyaW5nO1xuICBiZXN0X2xvY2F0aW9uX3R5cGU/OiBzdHJpbmc7XG4gIGJlc3RfbG9jYXRpb25fd2hlbj86IG51bWJlcjtcbiAgYmVzdF9sYXQ/OiBudW1iZXI7XG4gIGJlc3RfbG9uPzogbnVtYmVyO1xuICBiZXN0X2xvY2F0aW9uPzogc3RyaW5nO1xuICB0b3dlcl9sb2NhdGlvbj86IHN0cmluZztcbiAgdG93ZXJfbGF0PzogbnVtYmVyO1xuICB0b3dlcl9sb24/OiBudW1iZXI7XG4gIHRvd2VyX3doZW4/OiBudW1iZXI7XG4gIC8vIFRyaWFuZ3VsYXRpb24gZmllbGRzIChmcm9tIF9nZW9sb2NhdGUucW8gb3IgZW5yaWNoZWQgZXZlbnRzKVxuICB0cmlfd2hlbj86IG51bWJlcjtcbiAgdHJpX2xhdD86IG51bWJlcjtcbiAgdHJpX2xvbj86IG51bWJlcjtcbiAgdHJpX2xvY2F0aW9uPzogc3RyaW5nO1xuICB0cmlfY291bnRyeT86IHN0cmluZztcbiAgdHJpX3RpbWV6b25lPzogc3RyaW5nO1xuICB0cmlfcG9pbnRzPzogbnVtYmVyOyAgLy8gTnVtYmVyIG9mIHJlZmVyZW5jZSBwb2ludHMgdXNlZCBmb3IgdHJpYW5ndWxhdGlvblxuICBmbGVldHM/OiBzdHJpbmdbXTtcbiAgLy8gR1BTIHRpbWVzdGFtcCBmb3IgX3RyYWNrLnFvIGV2ZW50c1xuICB3aGVyZV93aGVuPzogbnVtYmVyOyAgLy8gVW5peCB0aW1lc3RhbXAgd2hlbiBHUFMgZml4IHdhcyBjYXB0dXJlZCAobW9yZSBhY2N1cmF0ZSB0aGFuICd3aGVuJyBmb3IgdHJhY2tpbmcpXG4gIC8vIFNlc3Npb24gZmllbGRzIChfc2Vzc2lvbi5xbykgLSBtYXkgYXBwZWFyIGF0IHRvcCBsZXZlbCBvciBpbiBib2R5XG4gIGZpcm13YXJlX2hvc3Q/OiBzdHJpbmc7ICAgICAvLyBKU09OIHN0cmluZyB3aXRoIGhvc3QgZmlybXdhcmUgaW5mb1xuICBmaXJtd2FyZV9ub3RlY2FyZD86IHN0cmluZzsgLy8gSlNPTiBzdHJpbmcgd2l0aCBOb3RlY2FyZCBmaXJtd2FyZSBpbmZvXG4gIHNrdT86IHN0cmluZzsgICAgICAgICAgICAgICAvLyBOb3RlY2FyZCBTS1UgKGUuZy4sIFwiTk9URS1XQkdMV1wiKVxuICBwb3dlcl91c2I/OiBib29sZWFuOyAgICAgICAgLy8gdHJ1ZSBpZiBkZXZpY2UgaXMgVVNCIHBvd2VyZWRcbn1cblxuZXhwb3J0IGNvbnN0IGhhbmRsZXIgPSBhc3luYyAoZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50KTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+ID0+IHtcbiAgY29uc29sZS5sb2coJ0luZ2VzdCByZXF1ZXN0OicsIEpTT04uc3RyaW5naWZ5KGV2ZW50KSk7XG5cbiAgY29uc3QgaGVhZGVycyA9IHtcbiAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICB9O1xuXG4gIHRyeSB7XG4gICAgaWYgKCFldmVudC5ib2R5KSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdSZXF1ZXN0IGJvZHkgcmVxdWlyZWQnIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCBub3RlaHViRXZlbnQ6IE5vdGVodWJFdmVudCA9IEpTT04ucGFyc2UoZXZlbnQuYm9keSk7XG4gICAgY29uc29sZS5sb2coJ1Byb2Nlc3NpbmcgTm90ZWh1YiBldmVudDonLCBKU09OLnN0cmluZ2lmeShub3RlaHViRXZlbnQpKTtcblxuICAgIC8vIFJlamVjdCBldmVudHMgd2l0aG91dCBzZXJpYWwgbnVtYmVyXG4gICAgaWYgKCFub3RlaHViRXZlbnQuc24gfHwgbm90ZWh1YkV2ZW50LnNuLnRyaW0oKSA9PT0gJycpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoYFJlamVjdGluZyBldmVudCAtIG5vIHNlcmlhbCBudW1iZXIgc2V0IGZvciBkZXZpY2UgJHtub3RlaHViRXZlbnQuZGV2aWNlfWApO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnU2VyaWFsIG51bWJlciAoc24pIGlzIHJlcXVpcmVkLiBDb25maWd1cmUgdGhlIGRldmljZSBzZXJpYWwgbnVtYmVyIGluIE5vdGVodWIuJyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gSGFuZGxlIGRldmljZSBhbGlhcyAoY3JlYXRlIGlmIG5ldywgZGV0ZWN0IE5vdGVjYXJkIHN3YXBzKVxuICAgIGNvbnN0IGFsaWFzUmVzdWx0ID0gYXdhaXQgaGFuZGxlRGV2aWNlQWxpYXMobm90ZWh1YkV2ZW50LnNuLCBub3RlaHViRXZlbnQuZGV2aWNlKTtcblxuICAgIC8vIElmIGEgTm90ZWNhcmQgc3dhcCB3YXMgZGV0ZWN0ZWQsIHdyaXRlIGFuIGV2ZW50IGZvciB0aGUgYWN0aXZpdHkgZmVlZFxuICAgIGlmIChhbGlhc1Jlc3VsdC5pc1N3YXAgJiYgYWxpYXNSZXN1bHQub2xkRGV2aWNlVWlkKSB7XG4gICAgICBhd2FpdCB3cml0ZU5vdGVjYXJkU3dhcEV2ZW50KFxuICAgICAgICBub3RlaHViRXZlbnQuc24sXG4gICAgICAgIGFsaWFzUmVzdWx0Lm9sZERldmljZVVpZCxcbiAgICAgICAgbm90ZWh1YkV2ZW50LmRldmljZSxcbiAgICAgICAgbm90ZWh1YkV2ZW50LndoZW4gfHwgTWF0aC5mbG9vcihub3RlaHViRXZlbnQucmVjZWl2ZWQpXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIFRyYW5zZm9ybSB0byBpbnRlcm5hbCBmb3JtYXRcbiAgICAvLyBGb3IgX3RyYWNrLnFvIGV2ZW50cywgdXNlICd3aGVyZV93aGVuJyB3aGljaCBpcyB3aGVuIHRoZSBHUFMgZml4IHdhcyBjYXB0dXJlZFxuICAgIC8vIEZvciBvdGhlciBldmVudHMsIHVzZSAnd2hlbicgaWYgYXZhaWxhYmxlLCBvdGhlcndpc2UgZmFsbCBiYWNrIHRvICdyZWNlaXZlZCdcbiAgICBsZXQgZXZlbnRUaW1lc3RhbXA6IG51bWJlcjtcbiAgICBpZiAobm90ZWh1YkV2ZW50LmZpbGUgPT09ICdfdHJhY2sucW8nICYmIG5vdGVodWJFdmVudC53aGVyZV93aGVuKSB7XG4gICAgICBldmVudFRpbWVzdGFtcCA9IG5vdGVodWJFdmVudC53aGVyZV93aGVuO1xuICAgIH0gZWxzZSB7XG4gICAgICBldmVudFRpbWVzdGFtcCA9IG5vdGVodWJFdmVudC53aGVuIHx8IE1hdGguZmxvb3Iobm90ZWh1YkV2ZW50LnJlY2VpdmVkKTtcbiAgICB9XG5cbiAgICAvLyBFeHRyYWN0IGxvY2F0aW9uIC0gcHJlZmVyIEdQUyAoYmVzdF9sYXQvYmVzdF9sb24pLCBmYWxsIGJhY2sgdG8gdHJpYW5ndWxhdGlvblxuICAgIGNvbnN0IGxvY2F0aW9uID0gZXh0cmFjdExvY2F0aW9uKG5vdGVodWJFdmVudCk7XG5cbiAgICAvLyBFeHRyYWN0IHNlc3Npb24gaW5mbyAoZmlybXdhcmUgdmVyc2lvbnMsIFNLVSkgZnJvbSBfc2Vzc2lvbi5xbyBldmVudHNcbiAgICBjb25zdCBzZXNzaW9uSW5mbyA9IGV4dHJhY3RTZXNzaW9uSW5mbyhub3RlaHViRXZlbnQpO1xuXG4gICAgLy8gRm9yIF90cmFjay5xbyBldmVudHMsIHRoZSBcInN0YXR1c1wiIGZpZWxkIChlLmcuLCBcIm5vLXNhdFwiKSBjYW4gYXBwZWFyIGF0IHRoZSB0b3AgbGV2ZWxcbiAgICAvLyBvciBpbnNpZGUgdGhlIGJvZHksIGRlcGVuZGluZyBvbiBOb3RlaHViIEhUVFAgcm91dGUgY29uZmlndXJhdGlvblxuICAgIGNvbnN0IGdwc1N0YXR1cyA9IG5vdGVodWJFdmVudC5zdGF0dXMgfHwgbm90ZWh1YkV2ZW50LmJvZHk/LnN0YXR1cztcblxuICAgIGNvbnN0IHNvbmdiaXJkRXZlbnQgPSB7XG4gICAgICBkZXZpY2VfdWlkOiBub3RlaHViRXZlbnQuZGV2aWNlLFxuICAgICAgc2VyaWFsX251bWJlcjogbm90ZWh1YkV2ZW50LnNuLFxuICAgICAgZmxlZXQ6IG5vdGVodWJFdmVudC5mbGVldHM/LlswXSB8fCAnZGVmYXVsdCcsXG4gICAgICBldmVudF90eXBlOiBub3RlaHViRXZlbnQuZmlsZSxcbiAgICAgIHRpbWVzdGFtcDogZXZlbnRUaW1lc3RhbXAsXG4gICAgICByZWNlaXZlZDogbm90ZWh1YkV2ZW50LnJlY2VpdmVkLFxuICAgICAgYm9keTogbm90ZWh1YkV2ZW50LmJvZHkgfHwge30sXG4gICAgICBsb2NhdGlvbixcbiAgICAgIHNlc3Npb246IHNlc3Npb25JbmZvLFxuICAgICAgc3RhdHVzOiBncHNTdGF0dXMsICAvLyBHUFMgc3RhdHVzIGZyb20gX3RyYWNrLnFvIGV2ZW50cyAoZS5nLiwgXCJuby1zYXRcIilcbiAgICB9O1xuXG4gICAgLy8gV3JpdGUgdGVsZW1ldHJ5IHRvIER5bmFtb0RCIChmb3IgdHJhY2sucW8gZXZlbnRzKVxuICAgIGlmIChzb25nYmlyZEV2ZW50LmV2ZW50X3R5cGUgPT09ICd0cmFjay5xbycpIHtcbiAgICAgIGF3YWl0IHdyaXRlVGVsZW1ldHJ5KHNvbmdiaXJkRXZlbnQsICd0ZWxlbWV0cnknKTtcbiAgICB9XG5cbiAgICAvLyBXcml0ZSBNb2pvIHBvd2VyIGRhdGEgdG8gRHluYW1vREIgKF9sb2cucW8gY29udGFpbnMgcG93ZXIgdGVsZW1ldHJ5KVxuICAgIC8vIFNraXAgaWYgZGV2aWNlIGlzIFVTQiBwb3dlcmVkICh2b2x0YWdlX21vZGU6IFwidXNiXCIpIC0gbm8gYmF0dGVyeSB0byBtb25pdG9yXG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuZXZlbnRfdHlwZSA9PT0gJ19sb2cucW8nKSB7XG4gICAgICBpZiAoc29uZ2JpcmRFdmVudC5ib2R5LnZvbHRhZ2VfbW9kZSA9PT0gJ3VzYicpIHtcbiAgICAgICAgY29uc29sZS5sb2coYFNraXBwaW5nIF9sb2cucW8gZXZlbnQgZm9yICR7c29uZ2JpcmRFdmVudC5kZXZpY2VfdWlkfSAtIFVTQiBwb3dlcmVkYCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhd2FpdCB3cml0ZVBvd2VyVGVsZW1ldHJ5KHNvbmdiaXJkRXZlbnQpO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFdyaXRlIGhlYWx0aCBldmVudHMgdG8gRHluYW1vREIgKF9oZWFsdGgucW8pXG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuZXZlbnRfdHlwZSA9PT0gJ19oZWFsdGgucW8nKSB7XG4gICAgICBhd2FpdCB3cml0ZUhlYWx0aEV2ZW50KHNvbmdiaXJkRXZlbnQpO1xuICAgIH1cblxuICAgIC8vIEhhbmRsZSB0cmlhbmd1bGF0aW9uIHJlc3VsdHMgKF9nZW9sb2NhdGUucW8pXG4gICAgLy8gV3JpdGUgbG9jYXRpb24gdG8gdGVsZW1ldHJ5IHRhYmxlIGZvciBsb2NhdGlvbiBoaXN0b3J5IHRyYWlsXG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuZXZlbnRfdHlwZSA9PT0gJ19nZW9sb2NhdGUucW8nICYmIHNvbmdiaXJkRXZlbnQubG9jYXRpb24pIHtcbiAgICAgIGF3YWl0IHdyaXRlTG9jYXRpb25FdmVudChzb25nYmlyZEV2ZW50KTtcbiAgICB9XG5cbiAgICAvLyBIYW5kbGUgR1BTIHRyYWNraW5nIGV2ZW50cyAoX3RyYWNrLnFvIGZyb20gTm90ZWNhcmQpXG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuZXZlbnRfdHlwZSA9PT0gJ190cmFjay5xbycpIHtcbiAgICAgIGF3YWl0IHdyaXRlVHJhY2tpbmdFdmVudChzb25nYmlyZEV2ZW50KTtcbiAgICAgIGF3YWl0IHVwc2VydEpvdXJuZXkoc29uZ2JpcmRFdmVudCk7XG4gICAgICAvLyBDaGVjayBmb3Igbm8tc2F0IHN0YXR1cyAoR1BTIGNhbm5vdCBhY3F1aXJlIHNhdGVsbGl0ZSBmaXgpXG4gICAgICAvLyBTdGF0dXMgY2FuIGJlIGF0IHRvcCBsZXZlbCBvciBpbiBib2R5IGRlcGVuZGluZyBvbiBOb3RlaHViIHJvdXRlIGNvbmZpZ1xuICAgICAgY29uc29sZS5sb2coYF90cmFjay5xbyBldmVudCAtIHN0YXR1czogJHtzb25nYmlyZEV2ZW50LnN0YXR1c30sIGJvZHkuc3RhdHVzOiAke3NvbmdiaXJkRXZlbnQuYm9keT8uc3RhdHVzfWApO1xuICAgICAgaWYgKHNvbmdiaXJkRXZlbnQuc3RhdHVzID09PSAnbm8tc2F0Jykge1xuICAgICAgICBjb25zb2xlLmxvZyhgRGV0ZWN0ZWQgbm8tc2F0IHN0YXR1cyBmb3IgJHtzb25nYmlyZEV2ZW50LmRldmljZV91aWR9YCk7XG4gICAgICAgIGF3YWl0IGNoZWNrTm9TYXRBbGVydChzb25nYmlyZEV2ZW50KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBXcml0ZSB0byBsb2NhdGlvbiBoaXN0b3J5IHRhYmxlIGZvciBhbGwgZXZlbnRzIHdpdGggbG9jYXRpb25cbiAgICBpZiAoc29uZ2JpcmRFdmVudC5sb2NhdGlvbikge1xuICAgICAgYXdhaXQgd3JpdGVMb2NhdGlvbkhpc3Rvcnkoc29uZ2JpcmRFdmVudCk7XG4gICAgfVxuXG4gICAgLy8gVHJhY2sgbW9kZSBjaGFuZ2VzIEJFRk9SRSB1cGRhdGluZyBkZXZpY2UgbWV0YWRhdGEgKHNvIHdlIGNhbiBjb21wYXJlIG9sZCB2cyBuZXcpXG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuYm9keS5tb2RlKSB7XG4gICAgICBhd2FpdCB0cmFja01vZGVDaGFuZ2Uoc29uZ2JpcmRFdmVudCk7XG4gICAgfVxuXG4gICAgLy8gVXBkYXRlIGRldmljZSBtZXRhZGF0YSBpbiBEeW5hbW9EQlxuICAgIGF3YWl0IHVwZGF0ZURldmljZU1ldGFkYXRhKHNvbmdiaXJkRXZlbnQpO1xuXG4gICAgLy8gQ2hlY2sgZm9yIG1vZGUgY2hhbmdlIGF3YXkgZnJvbSB0cmFuc2l0IC0gY29tcGxldGUgYW55IGFjdGl2ZSBqb3VybmV5c1xuICAgIGlmIChzb25nYmlyZEV2ZW50LmJvZHkubW9kZSAmJiBzb25nYmlyZEV2ZW50LmJvZHkubW9kZSAhPT0gJ3RyYW5zaXQnKSB7XG4gICAgICBhd2FpdCBjb21wbGV0ZUFjdGl2ZUpvdXJuZXlzT25Nb2RlQ2hhbmdlKHNvbmdiaXJkRXZlbnQuZGV2aWNlX3VpZCwgc29uZ2JpcmRFdmVudC5ib2R5Lm1vZGUpO1xuICAgIH1cblxuICAgIC8vIFN0b3JlIGFuZCBwdWJsaXNoIGFsZXJ0IGlmIHRoaXMgaXMgYW4gYWxlcnQgZXZlbnRcbiAgICBpZiAoc29uZ2JpcmRFdmVudC5ldmVudF90eXBlID09PSAnYWxlcnQucW8nKSB7XG4gICAgICBhd2FpdCBzdG9yZUFsZXJ0KHNvbmdiaXJkRXZlbnQpO1xuICAgICAgYXdhaXQgcHVibGlzaEFsZXJ0KHNvbmdiaXJkRXZlbnQpO1xuICAgIH1cblxuICAgIC8vIENoZWNrIGZvciBHUFMgcG93ZXIgc2F2ZSBzdGF0ZSBjaGFuZ2UgKHRyYWNrLnFvIG9ubHkpXG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuZXZlbnRfdHlwZSA9PT0gJ3RyYWNrLnFvJyAmJiBzb25nYmlyZEV2ZW50LmJvZHkuZ3BzX3Bvd2VyX3NhdmluZyA9PT0gdHJ1ZSkge1xuICAgICAgYXdhaXQgY2hlY2tHcHNQb3dlclNhdmVBbGVydChzb25nYmlyZEV2ZW50KTtcbiAgICB9XG5cbiAgICAvLyBQcm9jZXNzIGNvbW1hbmQgYWNrbm93bGVkZ21lbnRcbiAgICBpZiAoc29uZ2JpcmRFdmVudC5ldmVudF90eXBlID09PSAnY29tbWFuZF9hY2sucW8nKSB7XG4gICAgICBhd2FpdCBwcm9jZXNzQ29tbWFuZEFjayhzb25nYmlyZEV2ZW50KTtcbiAgICB9XG5cbiAgICBjb25zb2xlLmxvZygnRXZlbnQgcHJvY2Vzc2VkIHN1Y2Nlc3NmdWxseScpO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHN0YXR1czogJ29rJywgZGV2aWNlOiBzb25nYmlyZEV2ZW50LmRldmljZV91aWQgfSksXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvciBwcm9jZXNzaW5nIGV2ZW50OicsIGVycm9yKTtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNTAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnRlcm5hbCBzZXJ2ZXIgZXJyb3InIH0pLFxuICAgIH07XG4gIH1cbn07XG5cbmludGVyZmFjZSBTZXNzaW9uSW5mbyB7XG4gIGZpcm13YXJlX3ZlcnNpb24/OiBzdHJpbmc7XG4gIG5vdGVjYXJkX3ZlcnNpb24/OiBzdHJpbmc7XG4gIG5vdGVjYXJkX3NrdT86IHN0cmluZztcbiAgdXNiX3Bvd2VyZWQ/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIEV4dHJhY3Qgc2Vzc2lvbiBpbmZvIChmaXJtd2FyZSB2ZXJzaW9ucywgU0tVLCBwb3dlciBzdGF0dXMpIGZyb20gTm90ZWh1YiBldmVudFxuICogVGhpcyBpbmZvIGlzIGF2YWlsYWJsZSBpbiBfc2Vzc2lvbi5xbyBldmVudHNcbiAqIE5vdGU6IFNvbWUgZmllbGRzIG1heSBhcHBlYXIgYXQgdGhlIHRvcCBsZXZlbCBvciBpbnNpZGUgdGhlIGJvZHkgZGVwZW5kaW5nIG9uIHRoZSBIVFRQIHJvdXRlIGNvbmZpZ3VyYXRpb25cbiAqL1xuZnVuY3Rpb24gZXh0cmFjdFNlc3Npb25JbmZvKGV2ZW50OiBOb3RlaHViRXZlbnQpOiBTZXNzaW9uSW5mbyB8IHVuZGVmaW5lZCB7XG4gIC8vIENoZWNrIGZvciBwb3dlcl91c2IgYXQgdG9wIGxldmVsIE9SIGluIGJvZHlcbiAgY29uc3QgcG93ZXJVc2IgPSBldmVudC5wb3dlcl91c2IgPz8gZXZlbnQuYm9keT8ucG93ZXJfdXNiO1xuXG4gIGlmICghZXZlbnQuZmlybXdhcmVfaG9zdCAmJiAhZXZlbnQuZmlybXdhcmVfbm90ZWNhcmQgJiYgIWV2ZW50LnNrdSAmJiBwb3dlclVzYiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuXG4gIGNvbnN0IHNlc3Npb25JbmZvOiBTZXNzaW9uSW5mbyA9IHt9O1xuXG4gIC8vIFBhcnNlIGhvc3QgZmlybXdhcmUgdmVyc2lvblxuICBpZiAoZXZlbnQuZmlybXdhcmVfaG9zdCkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBob3N0RmlybXdhcmUgPSBKU09OLnBhcnNlKGV2ZW50LmZpcm13YXJlX2hvc3QpO1xuICAgICAgc2Vzc2lvbkluZm8uZmlybXdhcmVfdmVyc2lvbiA9IGhvc3RGaXJtd2FyZS52ZXJzaW9uO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ0ZhaWxlZCB0byBwYXJzZSBmaXJtd2FyZV9ob3N0OicsIGUpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFBhcnNlIE5vdGVjYXJkIGZpcm13YXJlIHZlcnNpb25cbiAgaWYgKGV2ZW50LmZpcm13YXJlX25vdGVjYXJkKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IG5vdGVjYXJkRmlybXdhcmUgPSBKU09OLnBhcnNlKGV2ZW50LmZpcm13YXJlX25vdGVjYXJkKTtcbiAgICAgIHNlc3Npb25JbmZvLm5vdGVjYXJkX3ZlcnNpb24gPSBub3RlY2FyZEZpcm13YXJlLnZlcnNpb247XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS5lcnJvcignRmFpbGVkIHRvIHBhcnNlIGZpcm13YXJlX25vdGVjYXJkOicsIGUpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFNLVVxuICBpZiAoZXZlbnQuc2t1KSB7XG4gICAgc2Vzc2lvbkluZm8ubm90ZWNhcmRfc2t1ID0gZXZlbnQuc2t1O1xuICB9XG5cbiAgLy8gVVNCIHBvd2VyIHN0YXR1cyAoY2hlY2sgdG9wIGxldmVsIGZpcnN0LCB0aGVuIGJvZHkpXG4gIGlmIChwb3dlclVzYiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgc2Vzc2lvbkluZm8udXNiX3Bvd2VyZWQgPSBwb3dlclVzYjtcbiAgICBjb25zb2xlLmxvZyhgRXh0cmFjdGVkIHVzYl9wb3dlcmVkOiAke3Bvd2VyVXNifWApO1xuICB9XG5cbiAgcmV0dXJuIE9iamVjdC5rZXlzKHNlc3Npb25JbmZvKS5sZW5ndGggPiAwID8gc2Vzc2lvbkluZm8gOiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogTm9ybWFsaXplIGxvY2F0aW9uIHNvdXJjZSB0eXBlIGZyb20gTm90ZWh1YiB0byBvdXIgc3RhbmRhcmQgdmFsdWVzXG4gKi9cbmZ1bmN0aW9uIG5vcm1hbGl6ZUxvY2F0aW9uU291cmNlKHNvdXJjZT86IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICghc291cmNlKSByZXR1cm4gJ2dwcyc7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBzb3VyY2UudG9Mb3dlckNhc2UoKTtcbiAgLy8gTm90ZWh1YiB1c2VzICd0cmlhbmd1bGF0ZWQnIGJ1dCB3ZSB1c2UgJ3RyaWFuZ3VsYXRpb24nIGZvciBjb25zaXN0ZW5jeVxuICBpZiAobm9ybWFsaXplZCA9PT0gJ3RyaWFuZ3VsYXRlZCcpIHJldHVybiAndHJpYW5ndWxhdGlvbic7XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG4vKipcbiAqIEV4dHJhY3QgbG9jYXRpb24gZnJvbSBOb3RlaHViIGV2ZW50LCBwcmVmZXJyaW5nIEdQUyBidXQgZmFsbGluZyBiYWNrIHRvIHRyaWFuZ3VsYXRpb25cbiAqL1xuZnVuY3Rpb24gZXh0cmFjdExvY2F0aW9uKGV2ZW50OiBOb3RlaHViRXZlbnQpOiB7IGxhdDogbnVtYmVyOyBsb246IG51bWJlcjsgdGltZT86IG51bWJlcjsgc291cmNlOiBzdHJpbmc7IG5hbWU/OiBzdHJpbmcgfSB8IHVuZGVmaW5lZCB7XG4gIC8vIFByZWZlciBHUFMgbG9jYXRpb24gKGJlc3RfbGF0L2Jlc3RfbG9uIHdpdGggdHlwZSAnZ3BzJylcbiAgaWYgKGV2ZW50LmJlc3RfbGF0ICE9PSB1bmRlZmluZWQgJiYgZXZlbnQuYmVzdF9sb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB7XG4gICAgICBsYXQ6IGV2ZW50LmJlc3RfbGF0LFxuICAgICAgbG9uOiBldmVudC5iZXN0X2xvbixcbiAgICAgIHRpbWU6IGV2ZW50LmJlc3RfbG9jYXRpb25fd2hlbixcbiAgICAgIHNvdXJjZTogbm9ybWFsaXplTG9jYXRpb25Tb3VyY2UoZXZlbnQuYmVzdF9sb2NhdGlvbl90eXBlKSxcbiAgICAgIG5hbWU6IGV2ZW50LmJlc3RfbG9jYXRpb24sXG4gICAgfTtcbiAgfVxuXG4gIC8vIEZhbGwgYmFjayB0byB0cmlhbmd1bGF0aW9uIGRhdGFcbiAgaWYgKGV2ZW50LnRyaV9sYXQgIT09IHVuZGVmaW5lZCAmJiBldmVudC50cmlfbG9uICE9PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgbGF0OiBldmVudC50cmlfbGF0LFxuICAgICAgbG9uOiBldmVudC50cmlfbG9uLFxuICAgICAgdGltZTogZXZlbnQudHJpX3doZW4sXG4gICAgICBzb3VyY2U6ICd0cmlhbmd1bGF0aW9uJyxcbiAgICAgIG5hbWU6IGV2ZW50LnRvd2VyX2xvY2F0aW9uLFxuICAgIH07XG4gIH1cblxuICAvLyBGYWxsIGJhY2sgdG8gdG93ZXIgbG9jYXRpb25cbiAgaWYgKGV2ZW50LnRvd2VyX2xhdCAhPT0gdW5kZWZpbmVkICYmIGV2ZW50LnRvd2VyX2xvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGxhdDogZXZlbnQudG93ZXJfbGF0LFxuICAgICAgbG9uOiBldmVudC50b3dlcl9sb24sXG4gICAgICB0aW1lOiBldmVudC50b3dlcl93aGVuLFxuICAgICAgc291cmNlOiAndG93ZXInLFxuICAgICAgbmFtZTogZXZlbnQudG93ZXJfbG9jYXRpb24sXG4gICAgfTtcbiAgfVxuXG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmludGVyZmFjZSBTb25nYmlyZEV2ZW50IHtcbiAgZGV2aWNlX3VpZDogc3RyaW5nO1xuICBzZXJpYWxfbnVtYmVyPzogc3RyaW5nO1xuICBmbGVldD86IHN0cmluZztcbiAgZXZlbnRfdHlwZTogc3RyaW5nO1xuICB0aW1lc3RhbXA6IG51bWJlcjtcbiAgcmVjZWl2ZWQ6IG51bWJlcjtcbiAgc2Vzc2lvbj86IFNlc3Npb25JbmZvO1xuICBib2R5OiB7XG4gICAgdGVtcD86IG51bWJlcjtcbiAgICBodW1pZGl0eT86IG51bWJlcjtcbiAgICBwcmVzc3VyZT86IG51bWJlcjtcbiAgICAvLyBOb3RlOiB2b2x0YWdlIGlzIG5vIGxvbmdlciBzZW50IGluIHRyYWNrLnFvOyBiYXR0ZXJ5IGluZm8gY29tZXMgZnJvbSBfbG9nLnFvIGFuZCBfaGVhbHRoLnFvXG4gICAgdm9sdGFnZT86IG51bWJlcjsgICAgICAvLyBTdGlsbCBwcmVzZW50IGluIF9sb2cucW8gKE1vam8pIGFuZCBfaGVhbHRoLnFvIGV2ZW50c1xuICAgIG1vdGlvbj86IGJvb2xlYW4gfCBudW1iZXI7XG4gICAgbW9kZT86IHN0cmluZztcbiAgICB0cmFuc2l0X2xvY2tlZD86IGJvb2xlYW47XG4gICAgZGVtb19sb2NrZWQ/OiBib29sZWFuO1xuICAgIGdwc19wb3dlcl9zYXZpbmc/OiBib29sZWFuO1xuICAgIHR5cGU/OiBzdHJpbmc7XG4gICAgdmFsdWU/OiBudW1iZXI7XG4gICAgdGhyZXNob2xkPzogbnVtYmVyO1xuICAgIG1lc3NhZ2U/OiBzdHJpbmc7XG4gICAgY21kPzogc3RyaW5nO1xuICAgIGNtZF9pZD86IHN0cmluZztcbiAgICBzdGF0dXM/OiBzdHJpbmc7XG4gICAgZXhlY3V0ZWRfYXQ/OiBudW1iZXI7XG4gICAgbWlsbGlhbXBfaG91cnM/OiBudW1iZXI7XG4gICAgdGVtcGVyYXR1cmU/OiBudW1iZXI7XG4gICAgLy8gSGVhbHRoIGV2ZW50IGZpZWxkc1xuICAgIG1ldGhvZD86IHN0cmluZztcbiAgICB0ZXh0Pzogc3RyaW5nO1xuICAgIHZvbHRhZ2VfbW9kZT86IHN0cmluZztcbiAgICAvLyBHUFMgdHJhY2tpbmcgZmllbGRzIChfdHJhY2sucW8pXG4gICAgdmVsb2NpdHk/OiBudW1iZXI7XG4gICAgYmVhcmluZz86IG51bWJlcjtcbiAgICBkaXN0YW5jZT86IG51bWJlcjtcbiAgICBzZWNvbmRzPzogbnVtYmVyO1xuICAgIGRvcD86IG51bWJlcjtcbiAgICBqb3VybmV5PzogbnVtYmVyO1xuICAgIGpjb3VudD86IG51bWJlcjtcbiAgICB0aW1lPzogbnVtYmVyO1xuICB9O1xuICBsb2NhdGlvbj86IHtcbiAgICBsYXQ/OiBudW1iZXI7XG4gICAgbG9uPzogbnVtYmVyO1xuICAgIHRpbWU/OiBudW1iZXI7XG4gICAgc291cmNlPzogc3RyaW5nO1xuICAgIG5hbWU/OiBzdHJpbmc7XG4gIH07XG4gIC8vIFRvcC1sZXZlbCBzdGF0dXMgZnJvbSBfdHJhY2sucW8gZXZlbnRzIChlLmcuLCBcIm5vLXNhdFwiKVxuICBzdGF0dXM/OiBzdHJpbmc7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlVGVsZW1ldHJ5KGV2ZW50OiBTb25nYmlyZEV2ZW50LCBkYXRhVHlwZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRpbWVzdGFtcCA9IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDA7IC8vIENvbnZlcnQgdG8gbWlsbGlzZWNvbmRzXG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgY29uc3QgcmVjb3JkOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge1xuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgdGltZXN0YW1wLFxuICAgIHR0bCxcbiAgICBkYXRhX3R5cGU6IGRhdGFUeXBlLFxuICAgIGV2ZW50X3R5cGU6IGV2ZW50LmV2ZW50X3R5cGUsXG4gICAgZXZlbnRfdHlwZV90aW1lc3RhbXA6IGAke2RhdGFUeXBlfSMke3RpbWVzdGFtcH1gLFxuICAgIHNlcmlhbF9udW1iZXI6IGV2ZW50LnNlcmlhbF9udW1iZXIgfHwgJ3Vua25vd24nLFxuICAgIGZsZWV0OiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gIH07XG5cbiAgaWYgKGV2ZW50LmJvZHkudGVtcCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnRlbXBlcmF0dXJlID0gZXZlbnQuYm9keS50ZW1wO1xuICB9XG4gIGlmIChldmVudC5ib2R5Lmh1bWlkaXR5ICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQuaHVtaWRpdHkgPSBldmVudC5ib2R5Lmh1bWlkaXR5O1xuICB9XG4gIGlmIChldmVudC5ib2R5LnByZXNzdXJlICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQucHJlc3N1cmUgPSBldmVudC5ib2R5LnByZXNzdXJlO1xuICB9XG4gIC8vIE5vdGU6IHZvbHRhZ2UgaXMgbm8gbG9uZ2VyIGluY2x1ZGVkIGluIHRyYWNrLnFvIHRlbGVtZXRyeVxuICAvLyBCYXR0ZXJ5IGluZm8gY29tZXMgZnJvbSBfbG9nLnFvIChNb2pvKSBhbmQgX2hlYWx0aC5xbyBldmVudHNcbiAgaWYgKGV2ZW50LmJvZHkubW90aW9uICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQubW90aW9uID0gZXZlbnQuYm9keS5tb3Rpb247XG4gIH1cblxuICBpZiAoZXZlbnQubG9jYXRpb24/LmxhdCAhPT0gdW5kZWZpbmVkICYmIGV2ZW50LmxvY2F0aW9uPy5sb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5sYXRpdHVkZSA9IGV2ZW50LmxvY2F0aW9uLmxhdDtcbiAgICByZWNvcmQubG9uZ2l0dWRlID0gZXZlbnQubG9jYXRpb24ubG9uO1xuICAgIHJlY29yZC5sb2NhdGlvbl9zb3VyY2UgPSBldmVudC5sb2NhdGlvbi5zb3VyY2UgfHwgJ2dwcyc7XG4gIH1cblxuICBjb25zdCBjb21tYW5kID0gbmV3IFB1dENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogVEVMRU1FVFJZX1RBQkxFLFxuICAgIEl0ZW06IHJlY29yZCxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBXcm90ZSB0ZWxlbWV0cnkgcmVjb3JkIGZvciAke2V2ZW50LmRldmljZV91aWR9YCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlUG93ZXJUZWxlbWV0cnkoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGltZXN0YW1wID0gZXZlbnQudGltZXN0YW1wICogMTAwMDtcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCkgKyBUVExfU0VDT05EUztcblxuICBjb25zdCByZWNvcmQ6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICB0aW1lc3RhbXAsXG4gICAgdHRsLFxuICAgIGRhdGFfdHlwZTogJ3Bvd2VyJyxcbiAgICBldmVudF90eXBlOiBldmVudC5ldmVudF90eXBlLFxuICAgIGV2ZW50X3R5cGVfdGltZXN0YW1wOiBgcG93ZXIjJHt0aW1lc3RhbXB9YCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyIHx8ICd1bmtub3duJyxcbiAgICBmbGVldDogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICB9O1xuXG4gIGlmIChldmVudC5ib2R5LnZvbHRhZ2UgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5tb2pvX3ZvbHRhZ2UgPSBldmVudC5ib2R5LnZvbHRhZ2U7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkubWlsbGlhbXBfaG91cnMgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5taWxsaWFtcF9ob3VycyA9IGV2ZW50LmJvZHkubWlsbGlhbXBfaG91cnM7XG4gIH1cblxuICBpZiAocmVjb3JkLm1vam9fdm9sdGFnZSAhPT0gdW5kZWZpbmVkIHx8XG4gICAgICByZWNvcmQubWlsbGlhbXBfaG91cnMgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IFRFTEVNRVRSWV9UQUJMRSxcbiAgICAgIEl0ZW06IHJlY29yZCxcbiAgICB9KTtcblxuICAgIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICAgIGNvbnNvbGUubG9nKGBXcm90ZSBwb3dlciB0ZWxlbWV0cnkgcmVjb3JkIGZvciAke2V2ZW50LmRldmljZV91aWR9YCk7XG4gIH0gZWxzZSB7XG4gICAgY29uc29sZS5sb2coJ05vIHBvd2VyIG1ldHJpY3MgaW4gX2xvZy5xbyBldmVudCwgc2tpcHBpbmcnKTtcbiAgfVxufVxuXG4vLyBMb3cgYmF0dGVyeSB0aHJlc2hvbGQgaW4gdm9sdHNcbmNvbnN0IExPV19CQVRURVJZX1RIUkVTSE9MRCA9IDMuMDtcblxuYXN5bmMgZnVuY3Rpb24gd3JpdGVIZWFsdGhFdmVudChldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0aW1lc3RhbXAgPSBldmVudC50aW1lc3RhbXAgKiAxMDAwOyAvLyBDb252ZXJ0IHRvIG1pbGxpc2Vjb25kc1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSArIFRUTF9TRUNPTkRTO1xuXG4gIGNvbnN0IHJlY29yZDogUmVjb3JkPHN0cmluZywgYW55PiA9IHtcbiAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgIHRpbWVzdGFtcCxcbiAgICB0dGwsXG4gICAgZGF0YV90eXBlOiAnaGVhbHRoJyxcbiAgICBldmVudF90eXBlOiBldmVudC5ldmVudF90eXBlLFxuICAgIGV2ZW50X3R5cGVfdGltZXN0YW1wOiBgaGVhbHRoIyR7dGltZXN0YW1wfWAsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgfTtcblxuICAvLyBBZGQgaGVhbHRoIGV2ZW50IGZpZWxkc1xuICBpZiAoZXZlbnQuYm9keS5tZXRob2QgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5tZXRob2QgPSBldmVudC5ib2R5Lm1ldGhvZDtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS50ZXh0ICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQudGV4dCA9IGV2ZW50LmJvZHkudGV4dDtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS52b2x0YWdlICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQudm9sdGFnZSA9IGV2ZW50LmJvZHkudm9sdGFnZTtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS52b2x0YWdlX21vZGUgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC52b2x0YWdlX21vZGUgPSBldmVudC5ib2R5LnZvbHRhZ2VfbW9kZTtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS5taWxsaWFtcF9ob3VycyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLm1pbGxpYW1wX2hvdXJzID0gZXZlbnQuYm9keS5taWxsaWFtcF9ob3VycztcbiAgfVxuXG4gIC8vIEFkZCBsb2NhdGlvbiBpZiBhdmFpbGFibGVcbiAgaWYgKGV2ZW50LmxvY2F0aW9uPy5sYXQgIT09IHVuZGVmaW5lZCAmJiBldmVudC5sb2NhdGlvbj8ubG9uICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQubGF0aXR1ZGUgPSBldmVudC5sb2NhdGlvbi5sYXQ7XG4gICAgcmVjb3JkLmxvbmdpdHVkZSA9IGV2ZW50LmxvY2F0aW9uLmxvbjtcbiAgICByZWNvcmQubG9jYXRpb25fc291cmNlID0gZXZlbnQubG9jYXRpb24uc291cmNlIHx8ICd0b3dlcic7XG4gIH1cblxuICBjb25zdCBjb21tYW5kID0gbmV3IFB1dENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogVEVMRU1FVFJZX1RBQkxFLFxuICAgIEl0ZW06IHJlY29yZCxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBXcm90ZSBoZWFsdGggZXZlbnQgcmVjb3JkIGZvciAke2V2ZW50LmRldmljZV91aWR9OiAke2V2ZW50LmJvZHkubWV0aG9kfWApO1xuXG4gIC8vIENoZWNrIGZvciBsb3cgYmF0dGVyeSBjb25kaXRpb246IHZvbHRhZ2UgPCAzLjBWIGFuZCBkZXZpY2UgcmVzdGFydGVkXG4gIGlmIChcbiAgICB0eXBlb2YgZXZlbnQuYm9keS52b2x0YWdlID09PSAnbnVtYmVyJyAmJlxuICAgIGV2ZW50LmJvZHkudm9sdGFnZSA8IExPV19CQVRURVJZX1RIUkVTSE9MRCAmJlxuICAgIHR5cGVvZiBldmVudC5ib2R5LnRleHQgPT09ICdzdHJpbmcnICYmXG4gICAgZXZlbnQuYm9keS50ZXh0LmluY2x1ZGVzKCdyZXN0YXJ0ZWQnKVxuICApIHtcbiAgICBhd2FpdCBjcmVhdGVMb3dCYXR0ZXJ5QWxlcnQoZXZlbnQpO1xuICB9XG59XG5cbi8qKlxuICogQ3JlYXRlIGEgbG93IGJhdHRlcnkgYWxlcnQgd2hlbiBkZXZpY2UgcmVzdGFydHMgZHVlIHRvIGluc3VmZmljaWVudCBwb3dlclxuICovXG5hc3luYyBmdW5jdGlvbiBjcmVhdGVMb3dCYXR0ZXJ5QWxlcnQoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgLy8gU2tpcCBpZiB1bmFja25vd2xlZGdlZCBhbGVydCBhbHJlYWR5IGV4aXN0c1xuICBpZiAoYXdhaXQgaGFzVW5hY2tub3dsZWRnZWRBbGVydChldmVudC5kZXZpY2VfdWlkLCAnbG93X2JhdHRlcnknKSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3Iobm93IC8gMTAwMCkgKyBUVExfU0VDT05EUztcbiAgY29uc3QgYWxlcnRJZCA9IGBhbGVydF8ke2V2ZW50LmRldmljZV91aWR9XyR7bm93fV8ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnN1YnN0cmluZyg3KX1gO1xuXG4gIGNvbnN0IGFsZXJ0UmVjb3JkID0ge1xuICAgIGFsZXJ0X2lkOiBhbGVydElkLFxuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgICB0eXBlOiAnbG93X2JhdHRlcnknLFxuICAgIHZhbHVlOiBldmVudC5ib2R5LnZvbHRhZ2UsXG4gICAgbWVzc2FnZTogYERldmljZSByZXN0YXJ0ZWQgZHVlIHRvIGxvdyBiYXR0ZXJ5ICgke2V2ZW50LmJvZHkudm9sdGFnZT8udG9GaXhlZCgyKX1WKWAsXG4gICAgY3JlYXRlZF9hdDogbm93LFxuICAgIGV2ZW50X3RpbWVzdGFtcDogZXZlbnQudGltZXN0YW1wICogMTAwMCxcbiAgICBhY2tub3dsZWRnZWQ6ICdmYWxzZScsXG4gICAgdHRsLFxuICAgIGxvY2F0aW9uOiBldmVudC5sb2NhdGlvbiA/IHtcbiAgICAgIGxhdDogZXZlbnQubG9jYXRpb24ubGF0LFxuICAgICAgbG9uOiBldmVudC5sb2NhdGlvbi5sb24sXG4gICAgfSA6IHVuZGVmaW5lZCxcbiAgICBtZXRhZGF0YToge1xuICAgICAgdm9sdGFnZTogZXZlbnQuYm9keS52b2x0YWdlLFxuICAgICAgdm9sdGFnZV9tb2RlOiBldmVudC5ib2R5LnZvbHRhZ2VfbW9kZSxcbiAgICAgIG1pbGxpYW1wX2hvdXJzOiBldmVudC5ib2R5Lm1pbGxpYW1wX2hvdXJzLFxuICAgICAgaGVhbHRoX3RleHQ6IGV2ZW50LmJvZHkudGV4dCxcbiAgICB9LFxuICB9O1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBBTEVSVFNfVEFCTEUsXG4gICAgSXRlbTogYWxlcnRSZWNvcmQsXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgQ3JlYXRlZCBsb3cgYmF0dGVyeSBhbGVydCAke2FsZXJ0SWR9IGZvciAke2V2ZW50LmRldmljZV91aWR9ICgke2V2ZW50LmJvZHkudm9sdGFnZT8udG9GaXhlZCgyKX1WKWApO1xuXG4gIC8vIFB1Ymxpc2ggdG8gU05TIGZvciBub3RpZmljYXRpb25zXG4gIGNvbnN0IGFsZXJ0TWVzc2FnZSA9IHtcbiAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgIHNlcmlhbF9udW1iZXI6IGV2ZW50LnNlcmlhbF9udW1iZXIsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0LFxuICAgIGFsZXJ0X3R5cGU6ICdsb3dfYmF0dGVyeScsXG4gICAgdmFsdWU6IGV2ZW50LmJvZHkudm9sdGFnZSxcbiAgICBtZXNzYWdlOiBgRGV2aWNlIHJlc3RhcnRlZCBkdWUgdG8gbG93IGJhdHRlcnkgKCR7ZXZlbnQuYm9keS52b2x0YWdlPy50b0ZpeGVkKDIpfVYpYCxcbiAgICB0aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCxcbiAgICBsb2NhdGlvbjogZXZlbnQubG9jYXRpb24sXG4gIH07XG5cbiAgY29uc3QgcHVibGlzaENvbW1hbmQgPSBuZXcgUHVibGlzaENvbW1hbmQoe1xuICAgIFRvcGljQXJuOiBBTEVSVF9UT1BJQ19BUk4sXG4gICAgU3ViamVjdDogYFNvbmdiaXJkIEFsZXJ0OiBMb3cgQmF0dGVyeSAtICR7ZXZlbnQuc2VyaWFsX251bWJlciB8fCBldmVudC5kZXZpY2VfdWlkfWAsXG4gICAgTWVzc2FnZTogSlNPTi5zdHJpbmdpZnkoYWxlcnRNZXNzYWdlLCBudWxsLCAyKSxcbiAgICBNZXNzYWdlQXR0cmlidXRlczoge1xuICAgICAgYWxlcnRfdHlwZToge1xuICAgICAgICBEYXRhVHlwZTogJ1N0cmluZycsXG4gICAgICAgIFN0cmluZ1ZhbHVlOiAnbG93X2JhdHRlcnknLFxuICAgICAgfSxcbiAgICAgIGRldmljZV91aWQ6IHtcbiAgICAgICAgRGF0YVR5cGU6ICdTdHJpbmcnLFxuICAgICAgICBTdHJpbmdWYWx1ZTogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICAgIH0sXG4gICAgICBmbGVldDoge1xuICAgICAgICBEYXRhVHlwZTogJ1N0cmluZycsXG4gICAgICAgIFN0cmluZ1ZhbHVlOiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGF3YWl0IHNuc0NsaWVudC5zZW5kKHB1Ymxpc2hDb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFB1Ymxpc2hlZCBsb3cgYmF0dGVyeSBhbGVydCB0byBTTlMgZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH1gKTtcbn1cblxuLyoqXG4gKiBDaGVjayBpZiBHUFMgcG93ZXIgc2F2ZSBhbGVydCBzaG91bGQgYmUgY3JlYXRlZFxuICogT25seSBjcmVhdGVzIGFsZXJ0IGlmIGdwc19wb3dlcl9zYXZpbmcgc3RhdGUgY2hhbmdlZCBmcm9tIGZhbHNlIHRvIHRydWVcbiAqL1xuYXN5bmMgZnVuY3Rpb24gY2hlY2tHcHNQb3dlclNhdmVBbGVydChldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICB0cnkge1xuICAgIC8vIEdldCBjdXJyZW50IGRldmljZSBzdGF0ZSB0byBjaGVjayBpZiBncHNfcG93ZXJfc2F2aW5nIHdhcyBhbHJlYWR5IHRydWVcbiAgICBjb25zdCBnZXRDb21tYW5kID0gbmV3IEdldENvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgICAgS2V5OiB7IGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQgfSxcbiAgICAgIFByb2plY3Rpb25FeHByZXNzaW9uOiAnZ3BzX3Bvd2VyX3NhdmluZycsXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChnZXRDb21tYW5kKTtcbiAgICBjb25zdCB3YXNHcHNQb3dlclNhdmluZyA9IHJlc3VsdC5JdGVtPy5ncHNfcG93ZXJfc2F2aW5nID09PSB0cnVlO1xuXG4gICAgLy8gT25seSBjcmVhdGUgYWxlcnQgaWYgc3RhdGUgY2hhbmdlZCBmcm9tIGZhbHNlIHRvIHRydWVcbiAgICBpZiAoIXdhc0dwc1Bvd2VyU2F2aW5nKSB7XG4gICAgICBhd2FpdCBjcmVhdGVHcHNQb3dlclNhdmVBbGVydChldmVudCk7XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIC8vIExvZyBidXQgZG9uJ3QgZmFpbCB0aGUgcmVxdWVzdCAtIGFsZXJ0IGNyZWF0aW9uIGlzIG5vdCBjcml0aWNhbFxuICAgIGNvbnNvbGUuZXJyb3IoYEVycm9yIGNoZWNraW5nIEdQUyBwb3dlciBzYXZlIGFsZXJ0OiAke2Vycm9yfWApO1xuICB9XG59XG5cbi8qKlxuICogQ3JlYXRlIGEgR1BTIHBvd2VyIHNhdmUgYWxlcnQgd2hlbiBkZXZpY2UgZGlzYWJsZXMgR1BTIGR1ZSB0byBubyBzaWduYWxcbiAqL1xuYXN5bmMgZnVuY3Rpb24gY3JlYXRlR3BzUG93ZXJTYXZlQWxlcnQoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgLy8gU2tpcCBpZiB1bmFja25vd2xlZGdlZCBhbGVydCBhbHJlYWR5IGV4aXN0c1xuICBpZiAoYXdhaXQgaGFzVW5hY2tub3dsZWRnZWRBbGVydChldmVudC5kZXZpY2VfdWlkLCAnZ3BzX3Bvd2VyX3NhdmUnKSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3Iobm93IC8gMTAwMCkgKyBUVExfU0VDT05EUztcbiAgY29uc3QgYWxlcnRJZCA9IGBhbGVydF8ke2V2ZW50LmRldmljZV91aWR9XyR7bm93fV8ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnN1YnN0cmluZyg3KX1gO1xuXG4gIGNvbnN0IGFsZXJ0UmVjb3JkID0ge1xuICAgIGFsZXJ0X2lkOiBhbGVydElkLFxuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgICB0eXBlOiAnZ3BzX3Bvd2VyX3NhdmUnLFxuICAgIG1lc3NhZ2U6ICdHUFMgZGlzYWJsZWQgZm9yIHBvd2VyIHNhdmluZyAtIHVuYWJsZSB0byBhY3F1aXJlIHNhdGVsbGl0ZSBzaWduYWwnLFxuICAgIGNyZWF0ZWRfYXQ6IG5vdyxcbiAgICBldmVudF90aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDAsXG4gICAgYWNrbm93bGVkZ2VkOiAnZmFsc2UnLFxuICAgIHR0bCxcbiAgICBsb2NhdGlvbjogZXZlbnQubG9jYXRpb24gPyB7XG4gICAgICBsYXQ6IGV2ZW50LmxvY2F0aW9uLmxhdCxcbiAgICAgIGxvbjogZXZlbnQubG9jYXRpb24ubG9uLFxuICAgIH0gOiB1bmRlZmluZWQsXG4gICAgbWV0YWRhdGE6IHtcbiAgICAgIG1vZGU6IGV2ZW50LmJvZHkubW9kZSxcbiAgICAgIHRyYW5zaXRfbG9ja2VkOiBldmVudC5ib2R5LnRyYW5zaXRfbG9ja2VkLFxuICAgIH0sXG4gIH07XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBQdXRDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IEFMRVJUU19UQUJMRSxcbiAgICBJdGVtOiBhbGVydFJlY29yZCxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBDcmVhdGVkIEdQUyBwb3dlciBzYXZlIGFsZXJ0ICR7YWxlcnRJZH0gZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH1gKTtcblxuICAvLyBQdWJsaXNoIHRvIFNOUyBmb3Igbm90aWZpY2F0aW9uc1xuICBjb25zdCBhbGVydE1lc3NhZ2UgPSB7XG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyLFxuICAgIGZsZWV0OiBldmVudC5mbGVldCxcbiAgICBhbGVydF90eXBlOiAnZ3BzX3Bvd2VyX3NhdmUnLFxuICAgIG1lc3NhZ2U6ICdHUFMgZGlzYWJsZWQgZm9yIHBvd2VyIHNhdmluZyAtIHVuYWJsZSB0byBhY3F1aXJlIHNhdGVsbGl0ZSBzaWduYWwnLFxuICAgIHRpbWVzdGFtcDogZXZlbnQudGltZXN0YW1wLFxuICAgIGxvY2F0aW9uOiBldmVudC5sb2NhdGlvbixcbiAgfTtcblxuICBjb25zdCBwdWJsaXNoQ29tbWFuZCA9IG5ldyBQdWJsaXNoQ29tbWFuZCh7XG4gICAgVG9waWNBcm46IEFMRVJUX1RPUElDX0FSTixcbiAgICBTdWJqZWN0OiBgU29uZ2JpcmQgQWxlcnQ6IEdQUyBQb3dlciBTYXZlIC0gJHtldmVudC5zZXJpYWxfbnVtYmVyIHx8IGV2ZW50LmRldmljZV91aWR9YCxcbiAgICBNZXNzYWdlOiBKU09OLnN0cmluZ2lmeShhbGVydE1lc3NhZ2UsIG51bGwsIDIpLFxuICAgIE1lc3NhZ2VBdHRyaWJ1dGVzOiB7XG4gICAgICBhbGVydF90eXBlOiB7XG4gICAgICAgIERhdGFUeXBlOiAnU3RyaW5nJyxcbiAgICAgICAgU3RyaW5nVmFsdWU6ICdncHNfcG93ZXJfc2F2ZScsXG4gICAgICB9LFxuICAgICAgZGV2aWNlX3VpZDoge1xuICAgICAgICBEYXRhVHlwZTogJ1N0cmluZycsXG4gICAgICAgIFN0cmluZ1ZhbHVlOiBldmVudC5kZXZpY2VfdWlkLFxuICAgICAgfSxcbiAgICAgIGZsZWV0OiB7XG4gICAgICAgIERhdGFUeXBlOiAnU3RyaW5nJyxcbiAgICAgICAgU3RyaW5nVmFsdWU6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgICAgIH0sXG4gICAgfSxcbiAgfSk7XG5cbiAgYXdhaXQgc25zQ2xpZW50LnNlbmQocHVibGlzaENvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgUHVibGlzaGVkIEdQUyBwb3dlciBzYXZlIGFsZXJ0IHRvIFNOUyBmb3IgJHtldmVudC5kZXZpY2VfdWlkfWApO1xufVxuXG4vKipcbiAqIENoZWNrIGlmIG5vLXNhdCBhbGVydCBzaG91bGQgYmUgY3JlYXRlZFxuICogT25seSBjcmVhdGVzIGFsZXJ0IGlmIGdwc19ub19zYXQgc3RhdGUgY2hhbmdlZCBmcm9tIGZhbHNlIHRvIHRydWVcbiAqL1xuYXN5bmMgZnVuY3Rpb24gY2hlY2tOb1NhdEFsZXJ0KGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIHRyeSB7XG4gICAgLy8gR2V0IGN1cnJlbnQgZGV2aWNlIHN0YXRlIHRvIGNoZWNrIGlmIGdwc19ub19zYXQgd2FzIGFscmVhZHkgdHJ1ZVxuICAgIGNvbnN0IGdldENvbW1hbmQgPSBuZXcgR2V0Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IERFVklDRVNfVEFCTEUsXG4gICAgICBLZXk6IHsgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCB9LFxuICAgICAgUHJvamVjdGlvbkV4cHJlc3Npb246ICdncHNfbm9fc2F0JyxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGdldENvbW1hbmQpO1xuICAgIGNvbnN0IHdhc05vU2F0ID0gcmVzdWx0Lkl0ZW0/Lmdwc19ub19zYXQgPT09IHRydWU7XG5cbiAgICAvLyBPbmx5IGNyZWF0ZSBhbGVydCBpZiBzdGF0ZSBjaGFuZ2VkIGZyb20gZmFsc2UgdG8gdHJ1ZVxuICAgIGlmICghd2FzTm9TYXQpIHtcbiAgICAgIGF3YWl0IGNyZWF0ZU5vU2F0QWxlcnQoZXZlbnQpO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAvLyBMb2cgYnV0IGRvbid0IGZhaWwgdGhlIHJlcXVlc3QgLSBhbGVydCBjcmVhdGlvbiBpcyBub3QgY3JpdGljYWxcbiAgICBjb25zb2xlLmVycm9yKGBFcnJvciBjaGVja2luZyBuby1zYXQgYWxlcnQ6ICR7ZXJyb3J9YCk7XG4gIH1cbn1cblxuLyoqXG4gKiBDcmVhdGUgYSBuby1zYXQgYWxlcnQgd2hlbiBkZXZpY2UgY2Fubm90IGFjcXVpcmUgc2F0ZWxsaXRlIGZpeFxuICovXG5hc3luYyBmdW5jdGlvbiBjcmVhdGVOb1NhdEFsZXJ0KGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIFNraXAgaWYgdW5hY2tub3dsZWRnZWQgYWxlcnQgYWxyZWFkeSBleGlzdHNcbiAgaWYgKGF3YWl0IGhhc1VuYWNrbm93bGVkZ2VkQWxlcnQoZXZlbnQuZGV2aWNlX3VpZCwgJ2dwc19ub19zYXQnKSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3Iobm93IC8gMTAwMCkgKyBUVExfU0VDT05EUztcbiAgY29uc3QgYWxlcnRJZCA9IGBhbGVydF8ke2V2ZW50LmRldmljZV91aWR9XyR7bm93fV8ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnN1YnN0cmluZyg3KX1gO1xuXG4gIGNvbnN0IGFsZXJ0UmVjb3JkID0ge1xuICAgIGFsZXJ0X2lkOiBhbGVydElkLFxuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgICB0eXBlOiAnZ3BzX25vX3NhdCcsXG4gICAgbWVzc2FnZTogJ1VuYWJsZSB0byBvYnRhaW4gR1BTIGxvY2F0aW9uJyxcbiAgICBjcmVhdGVkX2F0OiBub3csXG4gICAgZXZlbnRfdGltZXN0YW1wOiBldmVudC50aW1lc3RhbXAgKiAxMDAwLFxuICAgIGFja25vd2xlZGdlZDogJ2ZhbHNlJyxcbiAgICB0dGwsXG4gICAgbG9jYXRpb246IGV2ZW50LmxvY2F0aW9uID8ge1xuICAgICAgbGF0OiBldmVudC5sb2NhdGlvbi5sYXQsXG4gICAgICBsb246IGV2ZW50LmxvY2F0aW9uLmxvbixcbiAgICB9IDogdW5kZWZpbmVkLFxuICB9O1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBBTEVSVFNfVEFCTEUsXG4gICAgSXRlbTogYWxlcnRSZWNvcmQsXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgQ3JlYXRlZCBuby1zYXQgYWxlcnQgJHthbGVydElkfSBmb3IgJHtldmVudC5kZXZpY2VfdWlkfWApO1xuXG4gIC8vIFB1Ymxpc2ggdG8gU05TIGZvciBub3RpZmljYXRpb25zXG4gIGNvbnN0IGFsZXJ0TWVzc2FnZSA9IHtcbiAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgIHNlcmlhbF9udW1iZXI6IGV2ZW50LnNlcmlhbF9udW1iZXIsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0LFxuICAgIGFsZXJ0X3R5cGU6ICdncHNfbm9fc2F0JyxcbiAgICBtZXNzYWdlOiAnVW5hYmxlIHRvIG9idGFpbiBHUFMgbG9jYXRpb24nLFxuICAgIHRpbWVzdGFtcDogZXZlbnQudGltZXN0YW1wLFxuICAgIGxvY2F0aW9uOiBldmVudC5sb2NhdGlvbixcbiAgfTtcblxuICBjb25zdCBwdWJsaXNoQ29tbWFuZCA9IG5ldyBQdWJsaXNoQ29tbWFuZCh7XG4gICAgVG9waWNBcm46IEFMRVJUX1RPUElDX0FSTixcbiAgICBTdWJqZWN0OiBgU29uZ2JpcmQgQWxlcnQ6IFVuYWJsZSB0byBvYnRhaW4gR1BTIGxvY2F0aW9uIC0gJHtldmVudC5zZXJpYWxfbnVtYmVyIHx8IGV2ZW50LmRldmljZV91aWR9YCxcbiAgICBNZXNzYWdlOiBKU09OLnN0cmluZ2lmeShhbGVydE1lc3NhZ2UsIG51bGwsIDIpLFxuICAgIE1lc3NhZ2VBdHRyaWJ1dGVzOiB7XG4gICAgICBhbGVydF90eXBlOiB7XG4gICAgICAgIERhdGFUeXBlOiAnU3RyaW5nJyxcbiAgICAgICAgU3RyaW5nVmFsdWU6ICdncHNfbm9fc2F0JyxcbiAgICAgIH0sXG4gICAgICBkZXZpY2VfdWlkOiB7XG4gICAgICAgIERhdGFUeXBlOiAnU3RyaW5nJyxcbiAgICAgICAgU3RyaW5nVmFsdWU6IGV2ZW50LmRldmljZV91aWQsXG4gICAgICB9LFxuICAgICAgZmxlZXQ6IHtcbiAgICAgICAgRGF0YVR5cGU6ICdTdHJpbmcnLFxuICAgICAgICBTdHJpbmdWYWx1ZTogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICAgICAgfSxcbiAgICB9LFxuICB9KTtcblxuICBhd2FpdCBzbnNDbGllbnQuc2VuZChwdWJsaXNoQ29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBQdWJsaXNoZWQgbm8tc2F0IGFsZXJ0IHRvIFNOUyBmb3IgJHtldmVudC5kZXZpY2VfdWlkfWApO1xufVxuXG5hc3luYyBmdW5jdGlvbiB3cml0ZUxvY2F0aW9uRXZlbnQoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKCFldmVudC5sb2NhdGlvbj8ubGF0IHx8ICFldmVudC5sb2NhdGlvbj8ubG9uKSB7XG4gICAgY29uc29sZS5sb2coJ05vIGxvY2F0aW9uIGRhdGEgaW4gZXZlbnQsIHNraXBwaW5nJyk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgdGltZXN0YW1wID0gZXZlbnQudGltZXN0YW1wICogMTAwMDsgLy8gQ29udmVydCB0byBtaWxsaXNlY29uZHNcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCkgKyBUVExfU0VDT05EUztcblxuICBjb25zdCByZWNvcmQ6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICB0aW1lc3RhbXAsXG4gICAgdHRsLFxuICAgIGRhdGFfdHlwZTogJ3RlbGVtZXRyeScsIC8vIFVzZSB0ZWxlbWV0cnkgc28gaXQncyBwaWNrZWQgdXAgYnkgbG9jYXRpb24gcXVlcnlcbiAgICBldmVudF90eXBlOiBldmVudC5ldmVudF90eXBlLFxuICAgIGV2ZW50X3R5cGVfdGltZXN0YW1wOiBgdGVsZW1ldHJ5IyR7dGltZXN0YW1wfWAsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgICBsYXRpdHVkZTogZXZlbnQubG9jYXRpb24ubGF0LFxuICAgIGxvbmdpdHVkZTogZXZlbnQubG9jYXRpb24ubG9uLFxuICAgIGxvY2F0aW9uX3NvdXJjZTogZXZlbnQubG9jYXRpb24uc291cmNlIHx8ICd0cmlhbmd1bGF0aW9uJyxcbiAgfTtcblxuICBjb25zdCBjb21tYW5kID0gbmV3IFB1dENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogVEVMRU1FVFJZX1RBQkxFLFxuICAgIEl0ZW06IHJlY29yZCxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBXcm90ZSBsb2NhdGlvbiBldmVudCBmb3IgJHtldmVudC5kZXZpY2VfdWlkfTogJHtldmVudC5sb2NhdGlvbi5zb3VyY2V9ICgke2V2ZW50LmxvY2F0aW9uLmxhdH0sICR7ZXZlbnQubG9jYXRpb24ubG9ufSlgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gdXBkYXRlRGV2aWNlTWV0YWRhdGEoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcblxuICBjb25zdCB1cGRhdGVFeHByZXNzaW9uczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gIGNvbnN0IGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7fTtcblxuICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjbGFzdF9zZWVuID0gOmxhc3Rfc2VlbicpO1xuICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNsYXN0X3NlZW4nXSA9ICdsYXN0X3NlZW4nO1xuICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6bGFzdF9zZWVuJ10gPSBub3c7XG5cbiAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3VwZGF0ZWRfYXQgPSA6dXBkYXRlZF9hdCcpO1xuICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyN1cGRhdGVkX2F0J10gPSAndXBkYXRlZF9hdCc7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzp1cGRhdGVkX2F0J10gPSBub3c7XG5cbiAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3N0YXR1cyA9IDpzdGF0dXMnKTtcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjc3RhdHVzJ10gPSAnc3RhdHVzJztcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnN0YXR1cyddID0gJ29ubGluZSc7XG5cbiAgaWYgKGV2ZW50LnNlcmlhbF9udW1iZXIpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjc24gPSA6c24nKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNzbiddID0gJ3NlcmlhbF9udW1iZXInO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpzbiddID0gZXZlbnQuc2VyaWFsX251bWJlcjtcbiAgfVxuXG4gIGlmIChldmVudC5mbGVldCkge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNmbGVldCA9IDpmbGVldCcpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI2ZsZWV0J10gPSAnZmxlZXQnO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpmbGVldCddID0gZXZlbnQuZmxlZXQ7XG4gIH1cblxuICBpZiAoZXZlbnQuYm9keS5tb2RlKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI21vZGUgPSA6bW9kZScpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI21vZGUnXSA9ICdjdXJyZW50X21vZGUnO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzptb2RlJ10gPSBldmVudC5ib2R5Lm1vZGU7XG4gIH1cblxuICAvLyBGb3IgdHJhY2sucW8gZXZlbnRzLCB1cGRhdGUgbG9jayBzdGF0ZXMgYW5kIEdQUyBwb3dlciBzdGF0ZVxuICAvLyBJZiBsb2NrZWQvZ3BzX3Bvd2VyX3NhdmluZyBpcyB0cnVlLCBzZXQgaXQ7IGlmIGFic2VudCBvciBmYWxzZSwgY2xlYXIgaXRcbiAgaWYgKGV2ZW50LmV2ZW50X3R5cGUgPT09ICd0cmFjay5xbycpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjdHJhbnNpdF9sb2NrZWQgPSA6dHJhbnNpdF9sb2NrZWQnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyN0cmFuc2l0X2xvY2tlZCddID0gJ3RyYW5zaXRfbG9ja2VkJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6dHJhbnNpdF9sb2NrZWQnXSA9IGV2ZW50LmJvZHkudHJhbnNpdF9sb2NrZWQgPT09IHRydWU7XG5cbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjZGVtb19sb2NrZWQgPSA6ZGVtb19sb2NrZWQnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNkZW1vX2xvY2tlZCddID0gJ2RlbW9fbG9ja2VkJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6ZGVtb19sb2NrZWQnXSA9IGV2ZW50LmJvZHkuZGVtb19sb2NrZWQgPT09IHRydWU7XG5cbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjZ3BzX3Bvd2VyX3NhdmluZyA9IDpncHNfcG93ZXJfc2F2aW5nJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjZ3BzX3Bvd2VyX3NhdmluZyddID0gJ2dwc19wb3dlcl9zYXZpbmcnO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpncHNfcG93ZXJfc2F2aW5nJ10gPSBldmVudC5ib2R5Lmdwc19wb3dlcl9zYXZpbmcgPT09IHRydWU7XG4gIH1cblxuICAvLyBGb3IgX3RyYWNrLnFvIGV2ZW50cywgdHJhY2sgZ3BzX25vX3NhdCBzdGF0dXNcbiAgaWYgKGV2ZW50LmV2ZW50X3R5cGUgPT09ICdfdHJhY2sucW8nKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI2dwc19ub19zYXQgPSA6Z3BzX25vX3NhdCcpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI2dwc19ub19zYXQnXSA9ICdncHNfbm9fc2F0JztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6Z3BzX25vX3NhdCddID0gZXZlbnQuc3RhdHVzID09PSAnbm8tc2F0JztcbiAgfVxuXG4gIGlmIChldmVudC5sb2NhdGlvbj8ubGF0ICE9PSB1bmRlZmluZWQgJiYgZXZlbnQubG9jYXRpb24/LmxvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI2xvYyA9IDpsb2MnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNsb2MnXSA9ICdsYXN0X2xvY2F0aW9uJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6bG9jJ10gPSB7XG4gICAgICBsYXQ6IGV2ZW50LmxvY2F0aW9uLmxhdCxcbiAgICAgIGxvbjogZXZlbnQubG9jYXRpb24ubG9uLFxuICAgICAgdGltZTogZXZlbnQubG9jYXRpb24udGltZSB8fCBldmVudC50aW1lc3RhbXAsXG4gICAgICBzb3VyY2U6IGV2ZW50LmxvY2F0aW9uLnNvdXJjZSB8fCAnZ3BzJyxcbiAgICAgIG5hbWU6IGV2ZW50LmxvY2F0aW9uLm5hbWUsXG4gICAgfTtcbiAgfVxuXG4gIGlmIChldmVudC5ldmVudF90eXBlID09PSAndHJhY2sucW8nKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3RlbGVtZXRyeSA9IDp0ZWxlbWV0cnknKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyN0ZWxlbWV0cnknXSA9ICdsYXN0X3RlbGVtZXRyeSc7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnRlbGVtZXRyeSddID0ge1xuICAgICAgdGVtcDogZXZlbnQuYm9keS50ZW1wLFxuICAgICAgaHVtaWRpdHk6IGV2ZW50LmJvZHkuaHVtaWRpdHksXG4gICAgICBwcmVzc3VyZTogZXZlbnQuYm9keS5wcmVzc3VyZSxcbiAgICAgIC8vIE5vdGU6IHZvbHRhZ2UgaXMgbm8gbG9uZ2VyIHNlbnQgaW4gdHJhY2sucW87IHVzZSBsYXN0X3ZvbHRhZ2UgZnJvbSBfbG9nLnFvL19oZWFsdGgucW9cbiAgICAgIG1vdGlvbjogZXZlbnQuYm9keS5tb3Rpb24sXG4gICAgICB0aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCxcbiAgICB9O1xuICB9XG5cbiAgaWYgKGV2ZW50LmV2ZW50X3R5cGUgPT09ICdfbG9nLnFvJykge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNwb3dlciA9IDpwb3dlcicpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3Bvd2VyJ10gPSAnbGFzdF9wb3dlcic7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnBvd2VyJ10gPSB7XG4gICAgICB2b2x0YWdlOiBldmVudC5ib2R5LnZvbHRhZ2UsXG4gICAgICB0ZW1wZXJhdHVyZTogZXZlbnQuYm9keS50ZW1wZXJhdHVyZSxcbiAgICAgIG1pbGxpYW1wX2hvdXJzOiBldmVudC5ib2R5Lm1pbGxpYW1wX2hvdXJzLFxuICAgICAgdGltZXN0YW1wOiBldmVudC50aW1lc3RhbXAsXG4gICAgfTtcbiAgICAvLyBVcGRhdGUgZGV2aWNlIHZvbHRhZ2UgZnJvbSBNb2pvIHBvd2VyIG1vbml0b3JpbmdcbiAgICBpZiAoZXZlbnQuYm9keS52b2x0YWdlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyN2b2x0YWdlID0gOnZvbHRhZ2UnKTtcbiAgICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3ZvbHRhZ2UnXSA9ICd2b2x0YWdlJztcbiAgICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzp2b2x0YWdlJ10gPSBldmVudC5ib2R5LnZvbHRhZ2U7XG4gICAgfVxuICB9XG5cbiAgLy8gVXBkYXRlIGZpcm13YXJlIHZlcnNpb25zIGZyb20gX3Nlc3Npb24ucW8gZXZlbnRzXG4gIGlmIChldmVudC5zZXNzaW9uPy5maXJtd2FyZV92ZXJzaW9uKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI2Z3X3ZlcnNpb24gPSA6ZndfdmVyc2lvbicpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI2Z3X3ZlcnNpb24nXSA9ICdmaXJtd2FyZV92ZXJzaW9uJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6ZndfdmVyc2lvbiddID0gZXZlbnQuc2Vzc2lvbi5maXJtd2FyZV92ZXJzaW9uO1xuICB9XG5cbiAgaWYgKGV2ZW50LnNlc3Npb24/Lm5vdGVjYXJkX3ZlcnNpb24pIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjbmNfdmVyc2lvbiA9IDpuY192ZXJzaW9uJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjbmNfdmVyc2lvbiddID0gJ25vdGVjYXJkX3ZlcnNpb24nO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpuY192ZXJzaW9uJ10gPSBldmVudC5zZXNzaW9uLm5vdGVjYXJkX3ZlcnNpb247XG4gIH1cblxuICBpZiAoZXZlbnQuc2Vzc2lvbj8ubm90ZWNhcmRfc2t1KSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI25jX3NrdSA9IDpuY19za3UnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNuY19za3UnXSA9ICdub3RlY2FyZF9za3UnO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpuY19za3UnXSA9IGV2ZW50LnNlc3Npb24ubm90ZWNhcmRfc2t1O1xuICB9XG5cbiAgLy8gVXBkYXRlIFVTQiBwb3dlciBzdGF0dXMgZnJvbSBfc2Vzc2lvbi5xbyBldmVudHNcbiAgaWYgKGV2ZW50LnNlc3Npb24/LnVzYl9wb3dlcmVkICE9PSB1bmRlZmluZWQpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjdXNiX3Bvd2VyZWQgPSA6dXNiX3Bvd2VyZWQnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyN1c2JfcG93ZXJlZCddID0gJ3VzYl9wb3dlcmVkJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6dXNiX3Bvd2VyZWQnXSA9IGV2ZW50LnNlc3Npb24udXNiX3Bvd2VyZWQ7XG4gIH1cblxuICAvLyBVcGRhdGUgVVNCIHBvd2VyIHN0YXR1cyBmcm9tIF9oZWFsdGgucW8gdm9sdGFnZV9tb2RlIGZpZWxkXG4gIC8vIFRoaXMgaXMgbW9yZSBmcmVxdWVudGx5IHJlcG9ydGVkIHRoYW4gX3Nlc3Npb24ucW8gYW5kIGdpdmVzIHJlYWwtdGltZSBwb3dlciBzdGF0dXNcbiAgaWYgKGV2ZW50LmJvZHkudm9sdGFnZV9tb2RlICE9PSB1bmRlZmluZWQpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjdXNiX3Bvd2VyZWQgPSA6dXNiX3Bvd2VyZWQnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyN1c2JfcG93ZXJlZCddID0gJ3VzYl9wb3dlcmVkJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6dXNiX3Bvd2VyZWQnXSA9IGV2ZW50LmJvZHkudm9sdGFnZV9tb2RlID09PSAndXNiJztcbiAgfVxuXG4gIC8vIFVwZGF0ZSBkZXZpY2Ugdm9sdGFnZSBmcm9tIF9oZWFsdGgucW8gZXZlbnRzIChmYWxsYmFjayB3aGVuIE1vam8gaXMgbm90IGF2YWlsYWJsZSlcbiAgLy8gT25seSB1cGRhdGUgaWYgd2UgaGF2ZW4ndCBhbHJlYWR5IHNldCB2b2x0YWdlIGZyb20gX2xvZy5xbyBpbiB0aGlzIGV2ZW50XG4gIGlmIChldmVudC5ldmVudF90eXBlID09PSAnX2hlYWx0aC5xbycgJiYgZXZlbnQuYm9keS52b2x0YWdlICE9PSB1bmRlZmluZWQgJiYgIWV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzp2b2x0YWdlJ10pIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjdm9sdGFnZSA9IDp2b2x0YWdlJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjdm9sdGFnZSddID0gJ3ZvbHRhZ2UnO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzp2b2x0YWdlJ10gPSBldmVudC5ib2R5LnZvbHRhZ2U7XG4gIH1cblxuICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjY3JlYXRlZF9hdCA9IGlmX25vdF9leGlzdHMoI2NyZWF0ZWRfYXQsIDpjcmVhdGVkX2F0KScpO1xuICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNjcmVhdGVkX2F0J10gPSAnY3JlYXRlZF9hdCc7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpjcmVhdGVkX2F0J10gPSBub3c7XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBVcGRhdGVDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IERFVklDRVNfVEFCTEUsXG4gICAgS2V5OiB7IGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQgfSxcbiAgICBVcGRhdGVFeHByZXNzaW9uOiAnU0VUICcgKyB1cGRhdGVFeHByZXNzaW9ucy5qb2luKCcsICcpLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczogZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXMsXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgVXBkYXRlZCBkZXZpY2UgbWV0YWRhdGEgZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH1gKTtcblxuICAvLyBDbGVhciBwZW5kaW5nX21vZGUgaWYgdGhlIGRldmljZSdzIHJlcG9ydGVkIG1vZGUgbWF0Y2hlcyBpdFxuICBpZiAoZXZlbnQuYm9keS5tb2RlKSB7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGRvY0NsaWVudC5zZW5kKG5ldyBVcGRhdGVDb21tYW5kKHtcbiAgICAgICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgICAgICBLZXk6IHsgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCB9LFxuICAgICAgICBVcGRhdGVFeHByZXNzaW9uOiAnUkVNT1ZFIHBlbmRpbmdfbW9kZScsXG4gICAgICAgIENvbmRpdGlvbkV4cHJlc3Npb246ICdwZW5kaW5nX21vZGUgPSA6cmVwb3J0ZWRfbW9kZScsXG4gICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHsgJzpyZXBvcnRlZF9tb2RlJzogZXZlbnQuYm9keS5tb2RlIH0sXG4gICAgICB9KSk7XG4gICAgICBjb25zb2xlLmxvZyhgQ2xlYXJlZCBwZW5kaW5nX21vZGUgZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH0gKG1hdGNoZWQgJHtldmVudC5ib2R5Lm1vZGV9KWApO1xuICAgIH0gY2F0Y2ggKGVycjogYW55KSB7XG4gICAgICBpZiAoZXJyLm5hbWUgIT09ICdDb25kaXRpb25hbENoZWNrRmFpbGVkRXhjZXB0aW9uJykge1xuICAgICAgICBjb25zb2xlLmVycm9yKCdFcnJvciBjbGVhcmluZyBwZW5kaW5nX21vZGU6JywgZXJyKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gcHJvY2Vzc0NvbW1hbmRBY2soZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgY21kSWQgPSBldmVudC5ib2R5LmNtZF9pZDtcbiAgaWYgKCFjbWRJZCkge1xuICAgIGNvbnNvbGUubG9nKCdDb21tYW5kIGFjayBtaXNzaW5nIGNtZF9pZCwgc2tpcHBpbmcnKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgVXBkYXRlQ29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBDT01NQU5EU19UQUJMRSxcbiAgICBLZXk6IHtcbiAgICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgICBjb21tYW5kX2lkOiBjbWRJZCxcbiAgICB9LFxuICAgIFVwZGF0ZUV4cHJlc3Npb246ICdTRVQgI3N0YXR1cyA9IDpzdGF0dXMsICNtZXNzYWdlID0gOm1lc3NhZ2UsICNleGVjdXRlZF9hdCA9IDpleGVjdXRlZF9hdCwgI3VwZGF0ZWRfYXQgPSA6dXBkYXRlZF9hdCcsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAnI3N0YXR1cyc6ICdzdGF0dXMnLFxuICAgICAgJyNtZXNzYWdlJzogJ21lc3NhZ2UnLFxuICAgICAgJyNleGVjdXRlZF9hdCc6ICdleGVjdXRlZF9hdCcsXG4gICAgICAnI3VwZGF0ZWRfYXQnOiAndXBkYXRlZF9hdCcsXG4gICAgfSxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAnOnN0YXR1cyc6IGV2ZW50LmJvZHkuc3RhdHVzIHx8ICd1bmtub3duJyxcbiAgICAgICc6bWVzc2FnZSc6IGV2ZW50LmJvZHkubWVzc2FnZSB8fCAnJyxcbiAgICAgICc6ZXhlY3V0ZWRfYXQnOiBldmVudC5ib2R5LmV4ZWN1dGVkX2F0ID8gZXZlbnQuYm9keS5leGVjdXRlZF9hdCAqIDEwMDAgOiBub3csXG4gICAgICAnOnVwZGF0ZWRfYXQnOiBub3csXG4gICAgfSxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBVcGRhdGVkIGNvbW1hbmQgJHtjbWRJZH0gd2l0aCBzdGF0dXM6ICR7ZXZlbnQuYm9keS5zdGF0dXN9YCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHN0b3JlQWxlcnQoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgYWxlcnRUeXBlID0gZXZlbnQuYm9keS50eXBlIHx8ICd1bmtub3duJztcblxuICAvLyBTa2lwIGlmIHVuYWNrbm93bGVkZ2VkIGFsZXJ0IGFscmVhZHkgZXhpc3RzXG4gIGlmIChhd2FpdCBoYXNVbmFja25vd2xlZGdlZEFsZXJ0KGV2ZW50LmRldmljZV91aWQsIGFsZXJ0VHlwZSkpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKG5vdyAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgLy8gR2VuZXJhdGUgYSB1bmlxdWUgYWxlcnQgSURcbiAgY29uc3QgYWxlcnRJZCA9IGBhbGVydF8ke2V2ZW50LmRldmljZV91aWR9XyR7bm93fV8ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnN1YnN0cmluZyg3KX1gO1xuXG4gIGNvbnN0IGFsZXJ0UmVjb3JkID0ge1xuICAgIGFsZXJ0X2lkOiBhbGVydElkLFxuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgICB0eXBlOiBhbGVydFR5cGUsXG4gICAgdmFsdWU6IGV2ZW50LmJvZHkudmFsdWUsXG4gICAgdGhyZXNob2xkOiBldmVudC5ib2R5LnRocmVzaG9sZCxcbiAgICBtZXNzYWdlOiBldmVudC5ib2R5Lm1lc3NhZ2UgfHwgJycsXG4gICAgY3JlYXRlZF9hdDogbm93LFxuICAgIGV2ZW50X3RpbWVzdGFtcDogZXZlbnQudGltZXN0YW1wICogMTAwMCxcbiAgICBhY2tub3dsZWRnZWQ6ICdmYWxzZScsIC8vIFN0cmluZyBmb3IgR1NJIHBhcnRpdGlvbiBrZXlcbiAgICB0dGwsXG4gICAgbG9jYXRpb246IGV2ZW50LmxvY2F0aW9uID8ge1xuICAgICAgbGF0OiBldmVudC5sb2NhdGlvbi5sYXQsXG4gICAgICBsb246IGV2ZW50LmxvY2F0aW9uLmxvbixcbiAgICB9IDogdW5kZWZpbmVkLFxuICB9O1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBBTEVSVFNfVEFCTEUsXG4gICAgSXRlbTogYWxlcnRSZWNvcmQsXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgU3RvcmVkIGFsZXJ0ICR7YWxlcnRJZH0gZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH1gKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcHVibGlzaEFsZXJ0KGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGFsZXJ0TWVzc2FnZSA9IHtcbiAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgIHNlcmlhbF9udW1iZXI6IGV2ZW50LnNlcmlhbF9udW1iZXIsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0LFxuICAgIGFsZXJ0X3R5cGU6IGV2ZW50LmJvZHkudHlwZSxcbiAgICB2YWx1ZTogZXZlbnQuYm9keS52YWx1ZSxcbiAgICB0aHJlc2hvbGQ6IGV2ZW50LmJvZHkudGhyZXNob2xkLFxuICAgIG1lc3NhZ2U6IGV2ZW50LmJvZHkubWVzc2FnZSxcbiAgICB0aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCxcbiAgICBsb2NhdGlvbjogZXZlbnQubG9jYXRpb24sXG4gIH07XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBQdWJsaXNoQ29tbWFuZCh7XG4gICAgVG9waWNBcm46IEFMRVJUX1RPUElDX0FSTixcbiAgICBTdWJqZWN0OiBgU29uZ2JpcmQgQWxlcnQ6ICR7ZXZlbnQuYm9keS50eXBlfSAtICR7ZXZlbnQuc2VyaWFsX251bWJlciB8fCBldmVudC5kZXZpY2VfdWlkfWAsXG4gICAgTWVzc2FnZTogSlNPTi5zdHJpbmdpZnkoYWxlcnRNZXNzYWdlLCBudWxsLCAyKSxcbiAgICBNZXNzYWdlQXR0cmlidXRlczoge1xuICAgICAgYWxlcnRfdHlwZToge1xuICAgICAgICBEYXRhVHlwZTogJ1N0cmluZycsXG4gICAgICAgIFN0cmluZ1ZhbHVlOiBldmVudC5ib2R5LnR5cGUgfHwgJ3Vua25vd24nLFxuICAgICAgfSxcbiAgICAgIGRldmljZV91aWQ6IHtcbiAgICAgICAgRGF0YVR5cGU6ICdTdHJpbmcnLFxuICAgICAgICBTdHJpbmdWYWx1ZTogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICAgIH0sXG4gICAgICBmbGVldDoge1xuICAgICAgICBEYXRhVHlwZTogJ1N0cmluZycsXG4gICAgICAgIFN0cmluZ1ZhbHVlOiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGF3YWl0IHNuc0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgUHVibGlzaGVkIGFsZXJ0IHRvIFNOUzogJHtldmVudC5ib2R5LnR5cGV9YCk7XG59XG5cbi8qKlxuICogV3JpdGUgR1BTIHRyYWNraW5nIGV2ZW50IHRvIHRlbGVtZXRyeSB0YWJsZVxuICogSGFuZGxlcyBfdHJhY2sucW8gZXZlbnRzIGZyb20gTm90ZWNhcmQncyBjYXJkLmxvY2F0aW9uLnRyYWNrXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlVHJhY2tpbmdFdmVudChldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBpZiAoIWV2ZW50LmxvY2F0aW9uPy5sYXQgfHwgIWV2ZW50LmxvY2F0aW9uPy5sb24pIHtcbiAgICBjb25zb2xlLmxvZygnTm8gbG9jYXRpb24gZGF0YSBpbiBfdHJhY2sucW8gZXZlbnQsIHNraXBwaW5nJyk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgdGltZXN0YW1wID0gZXZlbnQudGltZXN0YW1wICogMTAwMDsgLy8gQ29udmVydCB0byBtaWxsaXNlY29uZHNcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCkgKyBUVExfU0VDT05EUztcblxuICBjb25zdCByZWNvcmQ6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICB0aW1lc3RhbXAsXG4gICAgdHRsLFxuICAgIGRhdGFfdHlwZTogJ3RyYWNraW5nJyxcbiAgICBldmVudF90eXBlOiBldmVudC5ldmVudF90eXBlLFxuICAgIGV2ZW50X3R5cGVfdGltZXN0YW1wOiBgdHJhY2tpbmcjJHt0aW1lc3RhbXB9YCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyIHx8ICd1bmtub3duJyxcbiAgICBmbGVldDogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICAgIGxhdGl0dWRlOiBldmVudC5sb2NhdGlvbi5sYXQsXG4gICAgbG9uZ2l0dWRlOiBldmVudC5sb2NhdGlvbi5sb24sXG4gICAgbG9jYXRpb25fc291cmNlOiBldmVudC5sb2NhdGlvbi5zb3VyY2UgfHwgJ2dwcycsXG4gIH07XG5cbiAgLy8gQWRkIHRyYWNraW5nLXNwZWNpZmljIGZpZWxkc1xuICBpZiAoZXZlbnQuYm9keS52ZWxvY2l0eSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnZlbG9jaXR5ID0gZXZlbnQuYm9keS52ZWxvY2l0eTtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS5iZWFyaW5nICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQuYmVhcmluZyA9IGV2ZW50LmJvZHkuYmVhcmluZztcbiAgfVxuICBpZiAoZXZlbnQuYm9keS5kaXN0YW5jZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLmRpc3RhbmNlID0gZXZlbnQuYm9keS5kaXN0YW5jZTtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS5zZWNvbmRzICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQuc2Vjb25kcyA9IGV2ZW50LmJvZHkuc2Vjb25kcztcbiAgfVxuICBpZiAoZXZlbnQuYm9keS5kb3AgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5kb3AgPSBldmVudC5ib2R5LmRvcDtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS5qb3VybmV5ICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQuam91cm5leV9pZCA9IGV2ZW50LmJvZHkuam91cm5leTtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS5qY291bnQgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5qY291bnQgPSBldmVudC5ib2R5Lmpjb3VudDtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS5tb3Rpb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5tb3Rpb24gPSBldmVudC5ib2R5Lm1vdGlvbjtcbiAgfVxuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBURUxFTUVUUllfVEFCTEUsXG4gICAgSXRlbTogcmVjb3JkLFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFdyb3RlIHRyYWNraW5nIGV2ZW50IGZvciAke2V2ZW50LmRldmljZV91aWR9IChqb3VybmV5OiAke2V2ZW50LmJvZHkuam91cm5leX0sIGpjb3VudDogJHtldmVudC5ib2R5Lmpjb3VudH0pYCk7XG59XG5cbi8qKlxuICogVXBzZXJ0IGpvdXJuZXkgcmVjb3JkXG4gKiAtIENyZWF0ZXMgbmV3IGpvdXJuZXkgd2hlbiBqY291bnQgPT09IDFcbiAqIC0gVXBkYXRlcyBleGlzdGluZyBqb3VybmV5IHdpdGggbmV3IGVuZF90aW1lIGFuZCBwb2ludF9jb3VudFxuICogLSBNYXJrcyBwcmV2aW91cyBqb3VybmV5IGFzIGNvbXBsZXRlZCB3aGVuIGEgbmV3IG9uZSBzdGFydHNcbiAqL1xuYXN5bmMgZnVuY3Rpb24gdXBzZXJ0Sm91cm5leShldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBqb3VybmV5SWQgPSBldmVudC5ib2R5LmpvdXJuZXk7XG4gIGNvbnN0IGpjb3VudCA9IGV2ZW50LmJvZHkuamNvdW50O1xuXG4gIGlmICgham91cm5leUlkIHx8ICFqY291bnQpIHtcbiAgICBjb25zb2xlLmxvZygnTWlzc2luZyBqb3VybmV5IG9yIGpjb3VudCBpbiBfdHJhY2sucW8gZXZlbnQsIHNraXBwaW5nIGpvdXJuZXkgdXBzZXJ0Jyk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCkgKyBUVExfU0VDT05EUztcbiAgY29uc3QgdGltZXN0YW1wTXMgPSBldmVudC50aW1lc3RhbXAgKiAxMDAwO1xuXG4gIC8vIElmIHRoaXMgaXMgdGhlIGZpcnN0IHBvaW50IG9mIGEgbmV3IGpvdXJuZXksIG1hcmsgcHJldmlvdXMgam91cm5leSBhcyBjb21wbGV0ZWRcbiAgaWYgKGpjb3VudCA9PT0gMSkge1xuICAgIGF3YWl0IG1hcmtQcmV2aW91c0pvdXJuZXlDb21wbGV0ZWQoZXZlbnQuZGV2aWNlX3VpZCwgam91cm5leUlkKTtcbiAgfVxuXG4gIC8vIENhbGN1bGF0ZSBjdW11bGF0aXZlIGRpc3RhbmNlXG4gIGNvbnN0IGRpc3RhbmNlID0gZXZlbnQuYm9keS5kaXN0YW5jZSB8fCAwO1xuXG4gIC8vIFVwc2VydCBqb3VybmV5IHJlY29yZFxuICBjb25zdCBjb21tYW5kID0gbmV3IFVwZGF0ZUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogSk9VUk5FWVNfVEFCTEUsXG4gICAgS2V5OiB7XG4gICAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgICAgam91cm5leV9pZDogam91cm5leUlkLFxuICAgIH0sXG4gICAgVXBkYXRlRXhwcmVzc2lvbjogYFxuICAgICAgU0VUICNzdGF0dXMgPSA6c3RhdHVzLFxuICAgICAgICAgICNzdGFydF90aW1lID0gaWZfbm90X2V4aXN0cygjc3RhcnRfdGltZSwgOnN0YXJ0X3RpbWUpLFxuICAgICAgICAgICNlbmRfdGltZSA9IDplbmRfdGltZSxcbiAgICAgICAgICAjcG9pbnRfY291bnQgPSA6cG9pbnRfY291bnQsXG4gICAgICAgICAgI3RvdGFsX2Rpc3RhbmNlID0gaWZfbm90X2V4aXN0cygjdG90YWxfZGlzdGFuY2UsIDp6ZXJvKSArIDpkaXN0YW5jZSxcbiAgICAgICAgICAjdHRsID0gOnR0bCxcbiAgICAgICAgICAjdXBkYXRlZF9hdCA9IDp1cGRhdGVkX2F0XG4gICAgYCxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICcjc3RhdHVzJzogJ3N0YXR1cycsXG4gICAgICAnI3N0YXJ0X3RpbWUnOiAnc3RhcnRfdGltZScsXG4gICAgICAnI2VuZF90aW1lJzogJ2VuZF90aW1lJyxcbiAgICAgICcjcG9pbnRfY291bnQnOiAncG9pbnRfY291bnQnLFxuICAgICAgJyN0b3RhbF9kaXN0YW5jZSc6ICd0b3RhbF9kaXN0YW5jZScsXG4gICAgICAnI3R0bCc6ICd0dGwnLFxuICAgICAgJyN1cGRhdGVkX2F0JzogJ3VwZGF0ZWRfYXQnLFxuICAgIH0sXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzpzdGF0dXMnOiAnYWN0aXZlJyxcbiAgICAgICc6c3RhcnRfdGltZSc6IGpvdXJuZXlJZCAqIDEwMDAsIC8vIENvbnZlcnQgdG8gbWlsbGlzZWNvbmRzXG4gICAgICAnOmVuZF90aW1lJzogdGltZXN0YW1wTXMsXG4gICAgICAnOnBvaW50X2NvdW50JzogamNvdW50LFxuICAgICAgJzpkaXN0YW5jZSc6IGRpc3RhbmNlLFxuICAgICAgJzp6ZXJvJzogMCxcbiAgICAgICc6dHRsJzogdHRsLFxuICAgICAgJzp1cGRhdGVkX2F0Jzogbm93LFxuICAgIH0sXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgVXBzZXJ0ZWQgam91cm5leSAke2pvdXJuZXlJZH0gZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH0gKHBvaW50ICR7amNvdW50fSlgKTtcbn1cblxuLyoqXG4gKiBNYXJrIHByZXZpb3VzIGpvdXJuZXkgYXMgY29tcGxldGVkIHdoZW4gYSBuZXcgam91cm5leSBzdGFydHNcbiAqL1xuYXN5bmMgZnVuY3Rpb24gbWFya1ByZXZpb3VzSm91cm5leUNvbXBsZXRlZChkZXZpY2VVaWQ6IHN0cmluZywgY3VycmVudEpvdXJuZXlJZDogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIFF1ZXJ5IGZvciB0aGUgbW9zdCByZWNlbnQgYWN0aXZlIGpvdXJuZXkgdGhhdCdzIG5vdCB0aGUgY3VycmVudCBvbmVcbiAgY29uc3QgcXVlcnlDb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCBqb3VybmV5X2lkIDwgOmN1cnJlbnRfam91cm5leScsXG4gICAgRmlsdGVyRXhwcmVzc2lvbjogJyNzdGF0dXMgPSA6YWN0aXZlJyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICcjc3RhdHVzJzogJ3N0YXR1cycsXG4gICAgfSxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAnOmRldmljZV91aWQnOiBkZXZpY2VVaWQsXG4gICAgICAnOmN1cnJlbnRfam91cm5leSc6IGN1cnJlbnRKb3VybmV5SWQsXG4gICAgICAnOmFjdGl2ZSc6ICdhY3RpdmUnLFxuICAgIH0sXG4gICAgU2NhbkluZGV4Rm9yd2FyZDogZmFsc2UsIC8vIE1vc3QgcmVjZW50IGZpcnN0XG4gICAgTGltaXQ6IDEsXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKHF1ZXJ5Q29tbWFuZCk7XG5cbiAgaWYgKHJlc3VsdC5JdGVtcyAmJiByZXN1bHQuSXRlbXMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IHByZXZpb3VzSm91cm5leSA9IHJlc3VsdC5JdGVtc1swXTtcblxuICAgIGNvbnN0IHVwZGF0ZUNvbW1hbmQgPSBuZXcgVXBkYXRlQ29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IEpPVVJORVlTX1RBQkxFLFxuICAgICAgS2V5OiB7XG4gICAgICAgIGRldmljZV91aWQ6IGRldmljZVVpZCxcbiAgICAgICAgam91cm5leV9pZDogcHJldmlvdXNKb3VybmV5LmpvdXJuZXlfaWQsXG4gICAgICB9LFxuICAgICAgVXBkYXRlRXhwcmVzc2lvbjogJ1NFVCAjc3RhdHVzID0gOnN0YXR1cywgI3VwZGF0ZWRfYXQgPSA6dXBkYXRlZF9hdCcsXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICAgJyNzdGF0dXMnOiAnc3RhdHVzJyxcbiAgICAgICAgJyN1cGRhdGVkX2F0JzogJ3VwZGF0ZWRfYXQnLFxuICAgICAgfSxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgJzpzdGF0dXMnOiAnY29tcGxldGVkJyxcbiAgICAgICAgJzp1cGRhdGVkX2F0JzogRGF0ZS5ub3coKSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBhd2FpdCBkb2NDbGllbnQuc2VuZCh1cGRhdGVDb21tYW5kKTtcbiAgICBjb25zb2xlLmxvZyhgTWFya2VkIGpvdXJuZXkgJHtwcmV2aW91c0pvdXJuZXkuam91cm5leV9pZH0gYXMgY29tcGxldGVkIGZvciAke2RldmljZVVpZH1gKTtcbiAgfVxufVxuXG4vKipcbiAqIFdyaXRlIGxvY2F0aW9uIHRvIHRoZSBsb2NhdGlvbnMgaGlzdG9yeSB0YWJsZVxuICogUmVjb3JkcyBhbGwgbG9jYXRpb24gZXZlbnRzIHJlZ2FyZGxlc3Mgb2Ygc291cmNlIGZvciB1bmlmaWVkIGxvY2F0aW9uIGhpc3RvcnlcbiAqL1xuYXN5bmMgZnVuY3Rpb24gd3JpdGVMb2NhdGlvbkhpc3RvcnkoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKCFldmVudC5sb2NhdGlvbj8ubGF0IHx8ICFldmVudC5sb2NhdGlvbj8ubG9uKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgdGltZXN0YW1wID0gZXZlbnQudGltZXN0YW1wICogMTAwMDsgLy8gQ29udmVydCB0byBtaWxsaXNlY29uZHNcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCkgKyBUVExfU0VDT05EUztcblxuICBjb25zdCByZWNvcmQ6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICB0aW1lc3RhbXAsXG4gICAgdHRsLFxuICAgIGxhdGl0dWRlOiBldmVudC5sb2NhdGlvbi5sYXQsXG4gICAgbG9uZ2l0dWRlOiBldmVudC5sb2NhdGlvbi5sb24sXG4gICAgc291cmNlOiBldmVudC5sb2NhdGlvbi5zb3VyY2UgfHwgJ3Vua25vd24nLFxuICAgIGxvY2F0aW9uX25hbWU6IGV2ZW50LmxvY2F0aW9uLm5hbWUsXG4gICAgZXZlbnRfdHlwZTogZXZlbnQuZXZlbnRfdHlwZSxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyIHx8ICd1bmtub3duJyxcbiAgICBmbGVldDogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICB9O1xuXG4gIC8vIEFkZCBqb3VybmV5IGluZm8gaWYgdGhpcyBpcyBhIHRyYWNraW5nIGV2ZW50XG4gIGlmIChldmVudC5ldmVudF90eXBlID09PSAnX3RyYWNrLnFvJykge1xuICAgIGlmIChldmVudC5ib2R5LmpvdXJuZXkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgcmVjb3JkLmpvdXJuZXlfaWQgPSBldmVudC5ib2R5LmpvdXJuZXk7XG4gICAgfVxuICAgIGlmIChldmVudC5ib2R5Lmpjb3VudCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICByZWNvcmQuamNvdW50ID0gZXZlbnQuYm9keS5qY291bnQ7XG4gICAgfVxuICAgIGlmIChldmVudC5ib2R5LnZlbG9jaXR5ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHJlY29yZC52ZWxvY2l0eSA9IGV2ZW50LmJvZHkudmVsb2NpdHk7XG4gICAgfVxuICAgIGlmIChldmVudC5ib2R5LmJlYXJpbmcgIT09IHVuZGVmaW5lZCkge1xuICAgICAgcmVjb3JkLmJlYXJpbmcgPSBldmVudC5ib2R5LmJlYXJpbmc7XG4gICAgfVxuICAgIGlmIChldmVudC5ib2R5LmRpc3RhbmNlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHJlY29yZC5kaXN0YW5jZSA9IGV2ZW50LmJvZHkuZGlzdGFuY2U7XG4gICAgfVxuICAgIGlmIChldmVudC5ib2R5LmRvcCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICByZWNvcmQuZG9wID0gZXZlbnQuYm9keS5kb3A7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBQdXRDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IExPQ0FUSU9OU19UQUJMRSxcbiAgICBJdGVtOiByZWNvcmQsXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgV3JvdGUgbG9jYXRpb24gaGlzdG9yeSBmb3IgJHtldmVudC5kZXZpY2VfdWlkfTogJHtldmVudC5sb2NhdGlvbi5zb3VyY2V9ICgke2V2ZW50LmxvY2F0aW9uLmxhdH0sICR7ZXZlbnQubG9jYXRpb24ubG9ufSlgKTtcbn1cblxuLyoqXG4gKiBDb21wbGV0ZSBhbGwgYWN0aXZlIGpvdXJuZXlzIHdoZW4gZGV2aWNlIGV4aXRzIHRyYW5zaXQgbW9kZVxuICogVGhpcyBlbnN1cmVzIGpvdXJuZXlzIGFyZSBwcm9wZXJseSBjbG9zZWQgd2hlbiBtb2RlIGNoYW5nZXMgdG8gZGVtbywgc3RvcmFnZSwgb3Igc2xlZXBcbiAqL1xuYXN5bmMgZnVuY3Rpb24gY29tcGxldGVBY3RpdmVKb3VybmV5c09uTW9kZUNoYW5nZShkZXZpY2VVaWQ6IHN0cmluZywgbmV3TW9kZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIFF1ZXJ5IGZvciBhbGwgYWN0aXZlIGpvdXJuZXlzIGZvciB0aGlzIGRldmljZVxuICBjb25zdCBxdWVyeUNvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IEpPVVJORVlTX1RBQkxFLFxuICAgIEluZGV4TmFtZTogJ3N0YXR1cy1pbmRleCcsXG4gICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJyNzdGF0dXMgPSA6YWN0aXZlJyxcbiAgICBGaWx0ZXJFeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkJyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICcjc3RhdHVzJzogJ3N0YXR1cycsXG4gICAgfSxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAnOmFjdGl2ZSc6ICdhY3RpdmUnLFxuICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgIH0sXG4gIH0pO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQocXVlcnlDb21tYW5kKTtcblxuICAgIGlmIChyZXN1bHQuSXRlbXMgJiYgcmVzdWx0Lkl0ZW1zLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnNvbGUubG9nKGBNb2RlIGNoYW5nZWQgdG8gJHtuZXdNb2RlfSAtIGNvbXBsZXRpbmcgJHtyZXN1bHQuSXRlbXMubGVuZ3RofSBhY3RpdmUgam91cm5leShzKSBmb3IgJHtkZXZpY2VVaWR9YCk7XG5cbiAgICAgIC8vIE1hcmsgZWFjaCBhY3RpdmUgam91cm5leSBhcyBjb21wbGV0ZWRcbiAgICAgIGZvciAoY29uc3Qgam91cm5leSBvZiByZXN1bHQuSXRlbXMpIHtcbiAgICAgICAgY29uc3QgdXBkYXRlQ29tbWFuZCA9IG5ldyBVcGRhdGVDb21tYW5kKHtcbiAgICAgICAgICBUYWJsZU5hbWU6IEpPVVJORVlTX1RBQkxFLFxuICAgICAgICAgIEtleToge1xuICAgICAgICAgICAgZGV2aWNlX3VpZDogZGV2aWNlVWlkLFxuICAgICAgICAgICAgam91cm5leV9pZDogam91cm5leS5qb3VybmV5X2lkLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgVXBkYXRlRXhwcmVzc2lvbjogJ1NFVCAjc3RhdHVzID0gOnN0YXR1cywgI3VwZGF0ZWRfYXQgPSA6dXBkYXRlZF9hdCcsXG4gICAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAgICAgICAnI3N0YXR1cyc6ICdzdGF0dXMnLFxuICAgICAgICAgICAgJyN1cGRhdGVkX2F0JzogJ3VwZGF0ZWRfYXQnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAgICAgJzpzdGF0dXMnOiAnY29tcGxldGVkJyxcbiAgICAgICAgICAgICc6dXBkYXRlZF9hdCc6IERhdGUubm93KCksXG4gICAgICAgICAgfSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgYXdhaXQgZG9jQ2xpZW50LnNlbmQodXBkYXRlQ29tbWFuZCk7XG4gICAgICAgIGNvbnNvbGUubG9nKGBNYXJrZWQgam91cm5leSAke2pvdXJuZXkuam91cm5leV9pZH0gYXMgY29tcGxldGVkIGR1ZSB0byBtb2RlIGNoYW5nZSB0byAke25ld01vZGV9YCk7XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIC8vIExvZyBidXQgZG9uJ3QgZmFpbCB0aGUgcmVxdWVzdCAtIGpvdXJuZXkgY29tcGxldGlvbiBpcyBub3QgY3JpdGljYWxcbiAgICBjb25zb2xlLmVycm9yKGBFcnJvciBjb21wbGV0aW5nIGFjdGl2ZSBqb3VybmV5cyBvbiBtb2RlIGNoYW5nZTogJHtlcnJvcn1gKTtcbiAgfVxufVxuXG4vKipcbiAqIENoZWNrIGlmIG1vZGUgaGFzIGNoYW5nZWQgYW5kIHdyaXRlIGEgbW9kZV9jaGFuZ2UgZXZlbnQgdG8gdGVsZW1ldHJ5IHRhYmxlXG4gKiBUaGlzIGFsbG93cyB0aGUgYWN0aXZpdHkgZmVlZCB0byBzaG93IG1vZGUgY2hhbmdlc1xuICovXG5hc3luYyBmdW5jdGlvbiB0cmFja01vZGVDaGFuZ2UoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKCFldmVudC5ib2R5Lm1vZGUpIHtcbiAgICByZXR1cm47IC8vIE5vIG1vZGUgaW4gZXZlbnQsIG5vdGhpbmcgdG8gdHJhY2tcbiAgfVxuXG4gIHRyeSB7XG4gICAgLy8gR2V0IGN1cnJlbnQgZGV2aWNlIG1vZGUgZnJvbSBkZXZpY2VzIHRhYmxlXG4gICAgY29uc3QgZ2V0Q29tbWFuZCA9IG5ldyBHZXRDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICAgIEtleTogeyBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkIH0sXG4gICAgICBQcm9qZWN0aW9uRXhwcmVzc2lvbjogJ2N1cnJlbnRfbW9kZScsXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChnZXRDb21tYW5kKTtcbiAgICBjb25zdCBwcmV2aW91c01vZGUgPSByZXN1bHQuSXRlbT8uY3VycmVudF9tb2RlO1xuXG4gICAgLy8gSWYgbW9kZSBoYXMgY2hhbmdlZCAob3IgZGV2aWNlIGlzIG5ldyksIHJlY29yZCB0aGUgY2hhbmdlXG4gICAgaWYgKHByZXZpb3VzTW9kZSAmJiBwcmV2aW91c01vZGUgIT09IGV2ZW50LmJvZHkubW9kZSkge1xuICAgICAgY29uc3QgdGltZXN0YW1wID0gZXZlbnQudGltZXN0YW1wICogMTAwMDsgLy8gQ29udmVydCB0byBtaWxsaXNlY29uZHNcbiAgICAgIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgICAgIGNvbnN0IHJlY29yZDogUmVjb3JkPHN0cmluZywgYW55PiA9IHtcbiAgICAgICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICAgICAgdGltZXN0YW1wLFxuICAgICAgICB0dGwsXG4gICAgICAgIGRhdGFfdHlwZTogJ21vZGVfY2hhbmdlJyxcbiAgICAgICAgZXZlbnRfdHlwZTogZXZlbnQuZXZlbnRfdHlwZSxcbiAgICAgICAgZXZlbnRfdHlwZV90aW1lc3RhbXA6IGBtb2RlX2NoYW5nZSMke3RpbWVzdGFtcH1gLFxuICAgICAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyIHx8ICd1bmtub3duJyxcbiAgICAgICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgICAgICAgcHJldmlvdXNfbW9kZTogcHJldmlvdXNNb2RlLFxuICAgICAgICBuZXdfbW9kZTogZXZlbnQuYm9keS5tb2RlLFxuICAgICAgfTtcblxuICAgICAgY29uc3QgcHV0Q29tbWFuZCA9IG5ldyBQdXRDb21tYW5kKHtcbiAgICAgICAgVGFibGVOYW1lOiBURUxFTUVUUllfVEFCTEUsXG4gICAgICAgIEl0ZW06IHJlY29yZCxcbiAgICAgIH0pO1xuXG4gICAgICBhd2FpdCBkb2NDbGllbnQuc2VuZChwdXRDb21tYW5kKTtcbiAgICAgIGNvbnNvbGUubG9nKGBSZWNvcmRlZCBtb2RlIGNoYW5nZSBmb3IgJHtldmVudC5kZXZpY2VfdWlkfTogJHtwcmV2aW91c01vZGV9IC0+ICR7ZXZlbnQuYm9keS5tb2RlfWApO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAvLyBMb2cgYnV0IGRvbid0IGZhaWwgdGhlIHJlcXVlc3QgLSBtb2RlIHRyYWNraW5nIGlzIG5vdCBjcml0aWNhbFxuICAgIGNvbnNvbGUuZXJyb3IoYEVycm9yIHRyYWNraW5nIG1vZGUgY2hhbmdlOiAke2Vycm9yfWApO1xuICB9XG59XG5cbi8qKlxuICogV3JpdGUgYSBOb3RlY2FyZCBzd2FwIGV2ZW50IHRvIHRoZSB0ZWxlbWV0cnkgdGFibGUgZm9yIHRoZSBhY3Rpdml0eSBmZWVkXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlTm90ZWNhcmRTd2FwRXZlbnQoXG4gIHNlcmlhbE51bWJlcjogc3RyaW5nLFxuICBvbGREZXZpY2VVaWQ6IHN0cmluZyxcbiAgbmV3RGV2aWNlVWlkOiBzdHJpbmcsXG4gIHRpbWVzdGFtcDogbnVtYmVyXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGltZXN0YW1wTXMgPSB0aW1lc3RhbXAgKiAxMDAwO1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSArIFRUTF9TRUNPTkRTO1xuXG4gIGNvbnN0IHJlY29yZCA9IHtcbiAgICBkZXZpY2VfdWlkOiBuZXdEZXZpY2VVaWQsXG4gICAgc2VyaWFsX251bWJlcjogc2VyaWFsTnVtYmVyLFxuICAgIHRpbWVzdGFtcDogdGltZXN0YW1wTXMsXG4gICAgdHRsLFxuICAgIGRhdGFfdHlwZTogJ25vdGVjYXJkX3N3YXAnLFxuICAgIGV2ZW50X3R5cGU6ICdub3RlY2FyZF9zd2FwJyxcbiAgICBldmVudF90eXBlX3RpbWVzdGFtcDogYG5vdGVjYXJkX3N3YXAjJHt0aW1lc3RhbXBNc31gLFxuICAgIG9sZF9kZXZpY2VfdWlkOiBvbGREZXZpY2VVaWQsXG4gICAgbmV3X2RldmljZV91aWQ6IG5ld0RldmljZVVpZCxcbiAgfTtcblxuICBjb25zdCBjb21tYW5kID0gbmV3IFB1dENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogVEVMRU1FVFJZX1RBQkxFLFxuICAgIEl0ZW06IHJlY29yZCxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBSZWNvcmRlZCBOb3RlY2FyZCBzd2FwIGZvciAke3NlcmlhbE51bWJlcn06ICR7b2xkRGV2aWNlVWlkfSAtPiAke25ld0RldmljZVVpZH1gKTtcbn1cblxuLyoqXG4gKiBDaGVjayBpZiBkZXZpY2UgaGFzIGFuIHVuYWNrbm93bGVkZ2VkIGFsZXJ0IG9mIHRoZSBzcGVjaWZpZWQgdHlwZVxuICogVXNlZCB0byBwcmV2ZW50IGR1cGxpY2F0ZSBhbGVydHMgZnJvbSBwaWxpbmcgdXBcbiAqL1xuYXN5bmMgZnVuY3Rpb24gaGFzVW5hY2tub3dsZWRnZWRBbGVydChkZXZpY2VVaWQ6IHN0cmluZywgYWxlcnRUeXBlOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3QgcXVlcnlDb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBBTEVSVFNfVEFCTEUsXG4gICAgSW5kZXhOYW1lOiAnZGV2aWNlLWluZGV4JyxcbiAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkJyxcbiAgICBGaWx0ZXJFeHByZXNzaW9uOiAnI3R5cGUgPSA6YWxlcnRfdHlwZSBBTkQgYWNrbm93bGVkZ2VkID0gOmZhbHNlJyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICcjdHlwZSc6ICd0eXBlJyxcbiAgICB9LFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICAgICc6YWxlcnRfdHlwZSc6IGFsZXJ0VHlwZSxcbiAgICAgICc6ZmFsc2UnOiAnZmFsc2UnLFxuICAgIH0sXG4gICAgTGltaXQ6IDEsXG4gICAgU2NhbkluZGV4Rm9yd2FyZDogZmFsc2UsIC8vIE1vc3QgcmVjZW50IGZpcnN0XG4gIH0pO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQocXVlcnlDb21tYW5kKTtcbiAgICBjb25zdCBoYXNVbmFja2VkID0gKHJlc3VsdC5JdGVtcz8ubGVuZ3RoIHx8IDApID4gMDtcblxuICAgIGlmIChoYXNVbmFja2VkKSB7XG4gICAgICBjb25zb2xlLmxvZyhgU2tpcHBpbmcgZHVwbGljYXRlIGFsZXJ0IGNyZWF0aW9uOiBkZXZpY2UgJHtkZXZpY2VVaWR9IGFscmVhZHkgaGFzIHVuYWNrbm93bGVkZ2VkICR7YWxlcnRUeXBlfSBhbGVydGApO1xuICAgIH1cblxuICAgIHJldHVybiBoYXNVbmFja2VkO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoYEVycm9yIGNoZWNraW5nIGZvciBkdXBsaWNhdGUgYWxlcnQ6ICR7ZXJyb3J9YCk7XG4gICAgLy8gT24gZXJyb3IsIGFsbG93IGFsZXJ0IGNyZWF0aW9uIChmYWlsIG9wZW4pXG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG4iXX0=