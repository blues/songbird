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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWluZ2VzdC9pbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7O0dBS0c7OztBQUVILDhEQUEwRDtBQUMxRCx3REFBb0g7QUFDcEgsb0RBQWdFO0FBRWhFLDJEQUE0RDtBQUU1RCxxQkFBcUI7QUFDckIsTUFBTSxTQUFTLEdBQUcsSUFBSSxnQ0FBYyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQ3pDLE1BQU0sU0FBUyxHQUFHLHFDQUFzQixDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUU7SUFDdkQsZUFBZSxFQUFFO1FBQ2YscUJBQXFCLEVBQUUsSUFBSTtLQUM1QjtDQUNGLENBQUMsQ0FBQztBQUNILE1BQU0sU0FBUyxHQUFHLElBQUksc0JBQVMsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUVwQyx3QkFBd0I7QUFDeEIsTUFBTSxlQUFlLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxlQUFnQixDQUFDO0FBQ3JELE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsYUFBYyxDQUFDO0FBQ2pELE1BQU0sY0FBYyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsY0FBZSxDQUFDO0FBQ25ELE1BQU0sWUFBWSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsWUFBYSxDQUFDO0FBQy9DLE1BQU0sZUFBZSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsZUFBZ0IsQ0FBQztBQUNyRCxNQUFNLGNBQWMsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGNBQWUsQ0FBQztBQUNuRCxNQUFNLGVBQWUsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGVBQWdCLENBQUM7QUFFckQsMEJBQTBCO0FBQzFCLE1BQU0sUUFBUSxHQUFHLEVBQUUsQ0FBQztBQUNwQixNQUFNLFdBQVcsR0FBRyxRQUFRLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLENBQUM7QUFtRnJD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LElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxRQUFRLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDdEMsTUFBTSxDQUFDLFFBQVEsR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQztJQUN4QyxDQUFDO0lBQ0QsSUFBSSxLQUFLLENBQUMsSUFBSSxDQUFDLE9BQU8sS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUNyQyxNQUFNLENBQUMsT0FBTyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDO0lBQ3RDLENBQUM7SUFDRCxJQUFJLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUSxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQ3RDLE1BQU0sQ0FBQyxRQUFRLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUM7SUFDeEMsQ0FBQztJQUNELElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxPQUFPLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDckMsTUFBTSxDQUFDLE9BQU8sR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQztJQUN0QyxDQUFDO0lBQ0QsSUFBSSxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUNqQyxNQUFNLENBQUMsR0FBRyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDO0lBQzlCLENBQUM7SUFDRCxJQUFJLEtBQUssQ0FBQyxJQUFJLENBQUMsT0FBTyxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQ3JDLE1BQU0sQ0FBQyxVQUFVLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUM7SUFDekMsQ0FBQztJQUNELElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxNQUFNLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDcEMsTUFBTSxDQUFDLE1BQU0sR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQztJQUNwQyxDQUFDO0lBQ0QsSUFBSSxLQUFLLENBQUMsSUFBSSxDQUFDLE1BQU0sS0FBSyxTQUFTLEVBQUUs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QUFDO0lBQ3JDLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLElBQUksQ0FBQyxHQUFHLFdBQVcsQ0FBQztJQUV4RCxNQUFNLE1BQU0sR0FBRztRQUNiLFVBQVUsRUFBRSxZQUFZO1FBQ3hCLGFBQWEsRUFBRSxZQUFZO1FBQzNCLFNBQVMsRUFBRSxXQUFXO1FBQ3RCLEdBQUc7UUFDSCxTQUFTLEVBQUUsZUFBZTtRQUMxQixVQUFVLEVBQUUsZUFBZTtRQUMzQixvQkFBb0IsRUFBRSxpQkFBaUIsV0FBVyxFQUFFO1FBQ3BELGNBQWMsRUFBRSxZQUFZO1FBQzVCLGNBQWMsRUFBRSxZQUFZO0tBQzdCLENBQUM7SUFFRixNQUFNLE9BQU8sR0FBRyxJQUFJLHlCQUFVLENBQUM7UUFDN0IsU0FBUyxFQUFFLGVBQWU7UUFDMUIsSUFBSSxFQUFFLE1BQU07S0FDYixDQUFDLENBQUM7SUFFSCxNQUFNLFNBQVMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDOUIsT0FBTyxDQUFDLEdBQUcsQ0FBQyw4QkFBOEIsWUFBWSxLQUFLLFlBQVksT0FBTyxZQUFZLEVBQUUsQ0FBQyxDQUFDO0FBQ2hHLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEV2ZW50IEluZ2VzdCBBUEkgTGFtYmRhXG4gKlxuICogSFRUUCBlbmRwb2ludCBmb3IgcmVjZWl2aW5nIGV2ZW50cyBmcm9tIE5vdGVodWIgSFRUUCByb3V0ZXMuXG4gKiBQcm9jZXNzZXMgaW5jb21pbmcgU29uZ2JpcmQgZXZlbnRzIGFuZCB3cml0ZXMgdG8gRHluYW1vREIuXG4gKi9cblxuaW1wb3J0IHsgRHluYW1vREJDbGllbnQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtZHluYW1vZGInO1xuaW1wb3J0IHsgRHluYW1vREJEb2N1bWVudENsaWVudCwgUHV0Q29tbWFuZCwgVXBkYXRlQ29tbWFuZCwgUXVlcnlDb21tYW5kLCBHZXRDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvbGliLWR5bmFtb2RiJztcbmltcG9ydCB7IFNOU0NsaWVudCwgUHVibGlzaENvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtc25zJztcbmltcG9ydCB7IEFQSUdhdGV3YXlQcm94eUV2ZW50LCBBUElHYXRld2F5UHJveHlSZXN1bHQgfSBmcm9tICdhd3MtbGFtYmRhJztcbmltcG9ydCB7IGhhbmRsZURldmljZUFsaWFzIH0gZnJvbSAnLi4vc2hhcmVkL2RldmljZS1sb29rdXAnO1xuXG4vLyBJbml0aWFsaXplIGNsaWVudHNcbmNvbnN0IGRkYkNsaWVudCA9IG5ldyBEeW5hbW9EQkNsaWVudCh7fSk7XG5jb25zdCBkb2NDbGllbnQgPSBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LmZyb20oZGRiQ2xpZW50LCB7XG4gIG1hcnNoYWxsT3B0aW9uczoge1xuICAgIHJlbW92ZVVuZGVmaW5lZFZhbHVlczogdHJ1ZSxcbiAgfSxcbn0pO1xuY29uc3Qgc25zQ2xpZW50ID0gbmV3IFNOU0NsaWVudCh7fSk7XG5cbi8vIEVudmlyb25tZW50IHZhcmlhYmxlc1xuY29uc3QgVEVMRU1FVFJZX1RBQkxFID0gcHJvY2Vzcy5lbnYuVEVMRU1FVFJZX1RBQkxFITtcbmNvbnN0IERFVklDRVNfVEFCTEUgPSBwcm9jZXNzLmVudi5ERVZJQ0VTX1RBQkxFITtcbmNvbnN0IENPTU1BTkRTX1RBQkxFID0gcHJvY2Vzcy5lbnYuQ09NTUFORFNfVEFCTEUhO1xuY29uc3QgQUxFUlRTX1RBQkxFID0gcHJvY2Vzcy5lbnYuQUxFUlRTX1RBQkxFITtcbmNvbnN0IEFMRVJUX1RPUElDX0FSTiA9IHByb2Nlc3MuZW52LkFMRVJUX1RPUElDX0FSTiE7XG5jb25zdCBKT1VSTkVZU19UQUJMRSA9IHByb2Nlc3MuZW52LkpPVVJORVlTX1RBQkxFITtcbmNvbnN0IExPQ0FUSU9OU19UQUJMRSA9IHByb2Nlc3MuZW52LkxPQ0FUSU9OU19UQUJMRSE7XG5cbi8vIFRUTDogOTAgZGF5cyBpbiBzZWNvbmRzXG5jb25zdCBUVExfREFZUyA9IDkwO1xuY29uc3QgVFRMX1NFQ09ORFMgPSBUVExfREFZUyAqIDI0ICogNjAgKiA2MDtcblxuLy8gTm90ZWh1YiBldmVudCBzdHJ1Y3R1cmUgKGZyb20gSFRUUCByb3V0ZSlcbmludGVyZmFjZSBOb3RlaHViRXZlbnQge1xuICBldmVudDogc3RyaW5nOyAgICAgICAgICAgLy8gZS5nLiwgXCJkZXY6eHh4eHgjdHJhY2sucW8jMVwiXG4gIHNlc3Npb246IHN0cmluZztcbiAgYmVzdF9pZDogc3RyaW5nO1xuICBkZXZpY2U6IHN0cmluZzsgICAgICAgICAgLy8gRGV2aWNlIFVJRFxuICBzbjogc3RyaW5nOyAgICAgICAgICAgICAgLy8gU2VyaWFsIG51bWJlclxuICBwcm9kdWN0OiBzdHJpbmc7XG4gIGFwcDogc3RyaW5nO1xuICByZWNlaXZlZDogbnVtYmVyO1xuICByZXE6IHN0cmluZzsgICAgICAgICAgICAgLy8gZS5nLiwgXCJub3RlLmFkZFwiXG4gIHdoZW46IG51bWJlcjsgICAgICAgICAgICAvLyBVbml4IHRpbWVzdGFtcFxuICBmaWxlOiBzdHJpbmc7ICAgICAgICAgICAgLy8gZS5nLiwgXCJ0cmFjay5xb1wiXG4gIGJvZHk6IHtcbiAgICB0ZW1wPzogbnVtYmVyO1xuICAgIGh1bWlkaXR5PzogbnVtYmVyO1xuICAgIHByZXNzdXJlPzogbnVtYmVyO1xuICAgIC8vIE5vdGU6IHZvbHRhZ2UgaXMgbm8gbG9uZ2VyIHNlbnQgaW4gdHJhY2sucW87IGJhdHRlcnkgaW5mbyBjb21lcyBmcm9tIF9sb2cucW8gYW5kIF9oZWFsdGgucW9cbiAgICBtb3Rpb24/OiBib29sZWFuIHwgbnVtYmVyO1xuICAgIG1vZGU/OiBzdHJpbmc7XG4gICAgdHJhbnNpdF9sb2NrZWQ/OiBib29sZWFuO1xuICAgIGRlbW9fbG9ja2VkPzogYm9vbGVhbjtcbiAgICBncHNfcG93ZXJfc2F2aW5nPzogYm9vbGVhbjtcbiAgICAvLyBBbGVydC1zcGVjaWZpYyBmaWVsZHNcbiAgICB0eXBlPzogc3RyaW5nO1xuICAgIHZhbHVlPzogbnVtYmVyO1xuICAgIHRocmVzaG9sZD86IG51bWJlcjtcbiAgICBtZXNzYWdlPzogc3RyaW5nO1xuICAgIC8vIENvbW1hbmQgYWNrIGZpZWxkc1xuICAgIGNtZD86IHN0cmluZztcbiAgICBzdGF0dXM/OiBzdHJpbmc7XG4gICAgZXhlY3V0ZWRfYXQ/OiBudW1iZXI7XG4gICAgLy8gTW9qbyBwb3dlciBtb25pdG9yaW5nIGZpZWxkcyAoX2xvZy5xbylcbiAgICBtaWxsaWFtcF9ob3Vycz86IG51bWJlcjtcbiAgICB0ZW1wZXJhdHVyZT86IG51bWJlcjtcbiAgICAvLyBIZWFsdGggZXZlbnQgZmllbGRzIChfaGVhbHRoLnFvKVxuICAgIG1ldGhvZD86IHN0cmluZztcbiAgICB0ZXh0Pzogc3RyaW5nO1xuICAgIHZvbHRhZ2VfbW9kZT86IHN0cmluZztcbiAgICAvLyBTZXNzaW9uIGZpZWxkcyBtYXkgYXBwZWFyIGluIGJvZHkgZm9yIF9zZXNzaW9uLnFvXG4gICAgcG93ZXJfdXNiPzogYm9vbGVhbjtcbiAgICAvLyBHUFMgdHJhY2tpbmcgZmllbGRzIChfdHJhY2sucW8pXG4gICAgdmVsb2NpdHk/OiBudW1iZXI7ICAgICAgLy8gU3BlZWQgaW4gbS9zXG4gICAgYmVhcmluZz86IG51bWJlcjsgICAgICAgLy8gRGlyZWN0aW9uIGluIGRlZ3JlZXMgZnJvbSBub3J0aFxuICAgIGRpc3RhbmNlPzogbnVtYmVyOyAgICAgIC8vIERpc3RhbmNlIGZyb20gcHJldmlvdXMgcG9pbnQgaW4gbWV0ZXJzXG4gICAgc2Vjb25kcz86IG51bWJlcjsgICAgICAgLy8gU2Vjb25kcyBzaW5jZSBwcmV2aW91cyB0cmFja2luZyBldmVudFxuICAgIGRvcD86IG51bWJlcjsgICAgICAgICAgLy8gRGlsdXRpb24gb2YgcHJlY2lzaW9uIChHUFMgYWNjdXJhY3kpXG4gICAgam91cm5leT86IG51bWJlcjsgICAgICAvLyBKb3VybmV5IElEIChVbml4IHRpbWVzdGFtcCBvZiBqb3VybmV5IHN0YXJ0KVxuICAgIGpjb3VudD86IG51bWJlcjsgICAgICAgLy8gUG9pbnQgbnVtYmVyIGluIGN1cnJlbnQgam91cm5leSAoc3RhcnRzIGF0IDEpXG4gICAgdGltZT86IG51bWJlcjsgICAgICAgICAvLyBUaW1lc3RhbXAgd2hlbiBHUFMgZml4IHdhcyBjYXB0dXJlZFxuICB9O1xuICAvLyBfdHJhY2sucW8gc3RhdHVzIGZpZWxkIGluZGljYXRlcyBHUFMgZml4IHN0YXR1cyAoYXQgdG9wIGxldmVsIG9mIGV2ZW50KVxuICAvLyBcIm5vLXNhdFwiIG1lYW5zIGRldmljZSBjYW5ub3QgYWNxdWlyZSBzYXRlbGxpdGUgZml4XG4gIHN0YXR1cz86IHN0cmluZztcbiAgYmVzdF9sb2NhdGlvbl90eXBlPzogc3RyaW5nO1xuICBiZXN0X2xvY2F0aW9uX3doZW4/OiBudW1iZXI7XG4gIGJlc3RfbGF0PzogbnVtYmVyO1xuICBiZXN0X2xvbj86IG51bWJlcjtcbiAgYmVzdF9sb2NhdGlvbj86IHN0cmluZztcbiAgdG93ZXJfbG9jYXRpb24/OiBzdHJpbmc7XG4gIHRvd2VyX2xhdD86IG51bWJlcjtcbiAgdG93ZXJfbG9uPzogbnVtYmVyO1xuICB0b3dlcl93aGVuPzogbnVtYmVyO1xuICAvLyBUcmlhbmd1bGF0aW9uIGZpZWxkcyAoZnJvbSBfZ2VvbG9jYXRlLnFvIG9yIGVucmljaGVkIGV2ZW50cylcbiAgdHJpX3doZW4/OiBudW1iZXI7XG4gIHRyaV9sYXQ/OiBudW1iZXI7XG4gIHRyaV9sb24/OiBudW1iZXI7XG4gIHRyaV9sb2NhdGlvbj86IHN0cmluZztcbiAgdHJpX2NvdW50cnk/OiBzdHJpbmc7XG4gIHRyaV90aW1lem9uZT86IHN0cmluZztcbiAgdHJpX3BvaW50cz86IG51bWJlcjsgIC8vIE51bWJlciBvZiByZWZlcmVuY2UgcG9pbnRzIHVzZWQgZm9yIHRyaWFuZ3VsYXRpb25cbiAgZmxlZXRzPzogc3RyaW5nW107XG4gIC8vIEdQUyB0aW1lc3RhbXAgZm9yIF90cmFjay5xbyBldmVudHNcbiAgd2hlcmVfd2hlbj86IG51bWJlcjsgIC8vIFVuaXggdGltZXN0YW1wIHdoZW4gR1BTIGZpeCB3YXMgY2FwdHVyZWQgKG1vcmUgYWNjdXJhdGUgdGhhbiAnd2hlbicgZm9yIHRyYWNraW5nKVxuICAvLyBTZXNzaW9uIGZpZWxkcyAoX3Nlc3Npb24ucW8pIC0gbWF5IGFwcGVhciBhdCB0b3AgbGV2ZWwgb3IgaW4gYm9keVxuICBmaXJtd2FyZV9ob3N0Pzogc3RyaW5nOyAgICAgLy8gSlNPTiBzdHJpbmcgd2l0aCBob3N0IGZpcm13YXJlIGluZm9cbiAgZmlybXdhcmVfbm90ZWNhcmQ/OiBzdHJpbmc7IC8vIEpTT04gc3RyaW5nIHdpdGggTm90ZWNhcmQgZmlybXdhcmUgaW5mb1xuICBza3U/OiBzdHJpbmc7ICAgICAgICAgICAgICAgLy8gTm90ZWNhcmQgU0tVIChlLmcuLCBcIk5PVEUtV0JHTFdcIilcbiAgcG93ZXJfdXNiPzogYm9vbGVhbjsgICAgICAgIC8vIHRydWUgaWYgZGV2aWNlIGlzIFVTQiBwb3dlcmVkXG59XG5cbmV4cG9ydCBjb25zdCBoYW5kbGVyID0gYXN5bmMgKGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudCk6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiA9PiB7XG4gIGNvbnNvbGUubG9nKCdJbmdlc3QgcmVxdWVzdDonLCBKU09OLnN0cmluZ2lmeShldmVudCkpO1xuXG4gIGNvbnN0IGhlYWRlcnMgPSB7XG4gICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgfTtcblxuICB0cnkge1xuICAgIGlmICghZXZlbnQuYm9keSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnUmVxdWVzdCBib2R5IHJlcXVpcmVkJyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgY29uc3Qgbm90ZWh1YkV2ZW50OiBOb3RlaHViRXZlbnQgPSBKU09OLnBhcnNlKGV2ZW50LmJvZHkpO1xuICAgIGNvbnNvbGUubG9nKCdQcm9jZXNzaW5nIE5vdGVodWIgZXZlbnQ6JywgSlNPTi5zdHJpbmdpZnkobm90ZWh1YkV2ZW50KSk7XG5cbiAgICAvLyBSZWplY3QgZXZlbnRzIHdpdGhvdXQgc2VyaWFsIG51bWJlclxuICAgIGlmICghbm90ZWh1YkV2ZW50LnNuIHx8IG5vdGVodWJFdmVudC5zbi50cmltKCkgPT09ICcnKSB7XG4gICAgICBjb25zb2xlLmVycm9yKGBSZWplY3RpbmcgZXZlbnQgLSBubyBzZXJpYWwgbnVtYmVyIHNldCBmb3IgZGV2aWNlICR7bm90ZWh1YkV2ZW50LmRldmljZX1gKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1NlcmlhbCBudW1iZXIgKHNuKSBpcyByZXF1aXJlZC4gQ29uZmlndXJlIHRoZSBkZXZpY2Ugc2VyaWFsIG51bWJlciBpbiBOb3RlaHViLicgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIEhhbmRsZSBkZXZpY2UgYWxpYXMgKGNyZWF0ZSBpZiBuZXcsIGRldGVjdCBOb3RlY2FyZCBzd2FwcylcbiAgICBjb25zdCBhbGlhc1Jlc3VsdCA9IGF3YWl0IGhhbmRsZURldmljZUFsaWFzKG5vdGVodWJFdmVudC5zbiwgbm90ZWh1YkV2ZW50LmRldmljZSk7XG5cbiAgICAvLyBJZiBhIE5vdGVjYXJkIHN3YXAgd2FzIGRldGVjdGVkLCB3cml0ZSBhbiBldmVudCBmb3IgdGhlIGFjdGl2aXR5IGZlZWRcbiAgICBpZiAoYWxpYXNSZXN1bHQuaXNTd2FwICYmIGFsaWFzUmVzdWx0Lm9sZERldmljZVVpZCkge1xuICAgICAgYXdhaXQgd3JpdGVOb3RlY2FyZFN3YXBFdmVudChcbiAgICAgICAgbm90ZWh1YkV2ZW50LnNuLFxuICAgICAgICBhbGlhc1Jlc3VsdC5vbGREZXZpY2VVaWQsXG4gICAgICAgIG5vdGVodWJFdmVudC5kZXZpY2UsXG4gICAgICAgIG5vdGVodWJFdmVudC53aGVuIHx8IE1hdGguZmxvb3Iobm90ZWh1YkV2ZW50LnJlY2VpdmVkKVxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBUcmFuc2Zvcm0gdG8gaW50ZXJuYWwgZm9ybWF0XG4gICAgLy8gRm9yIF90cmFjay5xbyBldmVudHMsIHVzZSAnd2hlcmVfd2hlbicgd2hpY2ggaXMgd2hlbiB0aGUgR1BTIGZpeCB3YXMgY2FwdHVyZWRcbiAgICAvLyBGb3Igb3RoZXIgZXZlbnRzLCB1c2UgJ3doZW4nIGlmIGF2YWlsYWJsZSwgb3RoZXJ3aXNlIGZhbGwgYmFjayB0byAncmVjZWl2ZWQnXG4gICAgbGV0IGV2ZW50VGltZXN0YW1wOiBudW1iZXI7XG4gICAgaWYgKG5vdGVodWJFdmVudC5maWxlID09PSAnX3RyYWNrLnFvJyAmJiBub3RlaHViRXZlbnQud2hlcmVfd2hlbikge1xuICAgICAgZXZlbnRUaW1lc3RhbXAgPSBub3RlaHViRXZlbnQud2hlcmVfd2hlbjtcbiAgICB9IGVsc2Uge1xuICAgICAgZXZlbnRUaW1lc3RhbXAgPSBub3RlaHViRXZlbnQud2hlbiB8fCBNYXRoLmZsb29yKG5vdGVodWJFdmVudC5yZWNlaXZlZCk7XG4gICAgfVxuXG4gICAgLy8gRXh0cmFjdCBsb2NhdGlvbiAtIHByZWZlciBHUFMgKGJlc3RfbGF0L2Jlc3RfbG9uKSwgZmFsbCBiYWNrIHRvIHRyaWFuZ3VsYXRpb25cbiAgICBjb25zdCBsb2NhdGlvbiA9IGV4dHJhY3RMb2NhdGlvbihub3RlaHViRXZlbnQpO1xuXG4gICAgLy8gRXh0cmFjdCBzZXNzaW9uIGluZm8gKGZpcm13YXJlIHZlcnNpb25zLCBTS1UpIGZyb20gX3Nlc3Npb24ucW8gZXZlbnRzXG4gICAgY29uc3Qgc2Vzc2lvbkluZm8gPSBleHRyYWN0U2Vzc2lvbkluZm8obm90ZWh1YkV2ZW50KTtcblxuICAgIC8vIEZvciBfdHJhY2sucW8gZXZlbnRzLCB0aGUgXCJzdGF0dXNcIiBmaWVsZCAoZS5nLiwgXCJuby1zYXRcIikgY2FuIGFwcGVhciBhdCB0aGUgdG9wIGxldmVsXG4gICAgLy8gb3IgaW5zaWRlIHRoZSBib2R5LCBkZXBlbmRpbmcgb24gTm90ZWh1YiBIVFRQIHJvdXRlIGNvbmZpZ3VyYXRpb25cbiAgICBjb25zdCBncHNTdGF0dXMgPSBub3RlaHViRXZlbnQuc3RhdHVzIHx8IG5vdGVodWJFdmVudC5ib2R5Py5zdGF0dXM7XG5cbiAgICBjb25zdCBzb25nYmlyZEV2ZW50ID0ge1xuICAgICAgZGV2aWNlX3VpZDogbm90ZWh1YkV2ZW50LmRldmljZSxcbiAgICAgIHNlcmlhbF9udW1iZXI6IG5vdGVodWJFdmVudC5zbixcbiAgICAgIGZsZWV0OiBub3RlaHViRXZlbnQuZmxlZXRzPy5bMF0gfHwgJ2RlZmF1bHQnLFxuICAgICAgZXZlbnRfdHlwZTogbm90ZWh1YkV2ZW50LmZpbGUsXG4gICAgICB0aW1lc3RhbXA6IGV2ZW50VGltZXN0YW1wLFxuICAgICAgcmVjZWl2ZWQ6IG5vdGVodWJFdmVudC5yZWNlaXZlZCxcbiAgICAgIGJvZHk6IG5vdGVodWJFdmVudC5ib2R5IHx8IHt9LFxuICAgICAgbG9jYXRpb24sXG4gICAgICBzZXNzaW9uOiBzZXNzaW9uSW5mbyxcbiAgICAgIHN0YXR1czogZ3BzU3RhdHVzLCAgLy8gR1BTIHN0YXR1cyBmcm9tIF90cmFjay5xbyBldmVudHMgKGUuZy4sIFwibm8tc2F0XCIpXG4gICAgfTtcblxuICAgIC8vIFdyaXRlIHRlbGVtZXRyeSB0byBEeW5hbW9EQiAoZm9yIHRyYWNrLnFvIGV2ZW50cylcbiAgICBpZiAoc29uZ2JpcmRFdmVudC5ldmVudF90eXBlID09PSAndHJhY2sucW8nKSB7XG4gICAgICBhd2FpdCB3cml0ZVRlbGVtZXRyeShzb25nYmlyZEV2ZW50LCAndGVsZW1ldHJ5Jyk7XG4gICAgfVxuXG4gICAgLy8gV3JpdGUgTW9qbyBwb3dlciBkYXRhIHRvIER5bmFtb0RCIChfbG9nLnFvIGNvbnRhaW5zIHBvd2VyIHRlbGVtZXRyeSlcbiAgICAvLyBTa2lwIGlmIGRldmljZSBpcyBVU0IgcG93ZXJlZCAodm9sdGFnZV9tb2RlOiBcInVzYlwiKSAtIG5vIGJhdHRlcnkgdG8gbW9uaXRvclxuICAgIGlmIChzb25nYmlyZEV2ZW50LmV2ZW50X3R5cGUgPT09ICdfbG9nLnFvJykge1xuICAgICAgaWYgKHNvbmdiaXJkRXZlbnQuYm9keS52b2x0YWdlX21vZGUgPT09ICd1c2InKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKGBTa2lwcGluZyBfbG9nLnFvIGV2ZW50IGZvciAke3NvbmdiaXJkRXZlbnQuZGV2aWNlX3VpZH0gLSBVU0IgcG93ZXJlZGApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYXdhaXQgd3JpdGVQb3dlclRlbGVtZXRyeShzb25nYmlyZEV2ZW50KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBXcml0ZSBoZWFsdGggZXZlbnRzIHRvIER5bmFtb0RCIChfaGVhbHRoLnFvKVxuICAgIGlmIChzb25nYmlyZEV2ZW50LmV2ZW50X3R5cGUgPT09ICdfaGVhbHRoLnFvJykge1xuICAgICAgYXdhaXQgd3JpdGVIZWFsdGhFdmVudChzb25nYmlyZEV2ZW50KTtcbiAgICB9XG5cbiAgICAvLyBIYW5kbGUgdHJpYW5ndWxhdGlvbiByZXN1bHRzIChfZ2VvbG9jYXRlLnFvKVxuICAgIC8vIFdyaXRlIGxvY2F0aW9uIHRvIHRlbGVtZXRyeSB0YWJsZSBmb3IgbG9jYXRpb24gaGlzdG9yeSB0cmFpbFxuICAgIGlmIChzb25nYmlyZEV2ZW50LmV2ZW50X3R5cGUgPT09ICdfZ2VvbG9jYXRlLnFvJyAmJiBzb25nYmlyZEV2ZW50LmxvY2F0aW9uKSB7XG4gICAgICBhd2FpdCB3cml0ZUxvY2F0aW9uRXZlbnQoc29uZ2JpcmRFdmVudCk7XG4gICAgfVxuXG4gICAgLy8gSGFuZGxlIEdQUyB0cmFja2luZyBldmVudHMgKF90cmFjay5xbyBmcm9tIE5vdGVjYXJkKVxuICAgIGlmIChzb25nYmlyZEV2ZW50LmV2ZW50X3R5cGUgPT09ICdfdHJhY2sucW8nKSB7XG4gICAgICBhd2FpdCB3cml0ZVRyYWNraW5nRXZlbnQoc29uZ2JpcmRFdmVudCk7XG4gICAgICBhd2FpdCB1cHNlcnRKb3VybmV5KHNvbmdiaXJkRXZlbnQpO1xuICAgICAgLy8gQ2hlY2sgZm9yIG5vLXNhdCBzdGF0dXMgKEdQUyBjYW5ub3QgYWNxdWlyZSBzYXRlbGxpdGUgZml4KVxuICAgICAgLy8gU3RhdHVzIGNhbiBiZSBhdCB0b3AgbGV2ZWwgb3IgaW4gYm9keSBkZXBlbmRpbmcgb24gTm90ZWh1YiByb3V0ZSBjb25maWdcbiAgICAgIGNvbnNvbGUubG9nKGBfdHJhY2sucW8gZXZlbnQgLSBzdGF0dXM6ICR7c29uZ2JpcmRFdmVudC5zdGF0dXN9LCBib2R5LnN0YXR1czogJHtzb25nYmlyZEV2ZW50LmJvZHk/LnN0YXR1c31gKTtcbiAgICAgIGlmIChzb25nYmlyZEV2ZW50LnN0YXR1cyA9PT0gJ25vLXNhdCcpIHtcbiAgICAgICAgY29uc29sZS5sb2coYERldGVjdGVkIG5vLXNhdCBzdGF0dXMgZm9yICR7c29uZ2JpcmRFdmVudC5kZXZpY2VfdWlkfWApO1xuICAgICAgICBhd2FpdCBjaGVja05vU2F0QWxlcnQoc29uZ2JpcmRFdmVudCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gV3JpdGUgdG8gbG9jYXRpb24gaGlzdG9yeSB0YWJsZSBmb3IgYWxsIGV2ZW50cyB3aXRoIGxvY2F0aW9uXG4gICAgaWYgKHNvbmdiaXJkRXZlbnQubG9jYXRpb24pIHtcbiAgICAgIGF3YWl0IHdyaXRlTG9jYXRpb25IaXN0b3J5KHNvbmdiaXJkRXZlbnQpO1xuICAgIH1cblxuICAgIC8vIFRyYWNrIG1vZGUgY2hhbmdlcyBCRUZPUkUgdXBkYXRpbmcgZGV2aWNlIG1ldGFkYXRhIChzbyB3ZSBjYW4gY29tcGFyZSBvbGQgdnMgbmV3KVxuICAgIGlmIChzb25nYmlyZEV2ZW50LmJvZHkubW9kZSkge1xuICAgICAgYXdhaXQgdHJhY2tNb2RlQ2hhbmdlKHNvbmdiaXJkRXZlbnQpO1xuICAgIH1cblxuICAgIC8vIFVwZGF0ZSBkZXZpY2UgbWV0YWRhdGEgaW4gRHluYW1vREJcbiAgICBhd2FpdCB1cGRhdGVEZXZpY2VNZXRhZGF0YShzb25nYmlyZEV2ZW50KTtcblxuICAgIC8vIENoZWNrIGZvciBtb2RlIGNoYW5nZSBhd2F5IGZyb20gdHJhbnNpdCAtIGNvbXBsZXRlIGFueSBhY3RpdmUgam91cm5leXNcbiAgICBpZiAoc29uZ2JpcmRFdmVudC5ib2R5Lm1vZGUgJiYgc29uZ2JpcmRFdmVudC5ib2R5Lm1vZGUgIT09ICd0cmFuc2l0Jykge1xuICAgICAgYXdhaXQgY29tcGxldGVBY3RpdmVKb3VybmV5c09uTW9kZUNoYW5nZShzb25nYmlyZEV2ZW50LmRldmljZV91aWQsIHNvbmdiaXJkRXZlbnQuYm9keS5tb2RlKTtcbiAgICB9XG5cbiAgICAvLyBTdG9yZSBhbmQgcHVibGlzaCBhbGVydCBpZiB0aGlzIGlzIGFuIGFsZXJ0IGV2ZW50XG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuZXZlbnRfdHlwZSA9PT0gJ2FsZXJ0LnFvJykge1xuICAgICAgYXdhaXQgc3RvcmVBbGVydChzb25nYmlyZEV2ZW50KTtcbiAgICAgIGF3YWl0IHB1Ymxpc2hBbGVydChzb25nYmlyZEV2ZW50KTtcbiAgICB9XG5cbiAgICAvLyBDaGVjayBmb3IgR1BTIHBvd2VyIHNhdmUgc3RhdGUgY2hhbmdlICh0cmFjay5xbyBvbmx5KVxuICAgIGlmIChzb25nYmlyZEV2ZW50LmV2ZW50X3R5cGUgPT09ICd0cmFjay5xbycgJiYgc29uZ2JpcmRFdmVudC5ib2R5Lmdwc19wb3dlcl9zYXZpbmcgPT09IHRydWUpIHtcbiAgICAgIGF3YWl0IGNoZWNrR3BzUG93ZXJTYXZlQWxlcnQoc29uZ2JpcmRFdmVudCk7XG4gICAgfVxuXG4gICAgLy8gUHJvY2VzcyBjb21tYW5kIGFja25vd2xlZGdtZW50XG4gICAgaWYgKHNvbmdiaXJkRXZlbnQuZXZlbnRfdHlwZSA9PT0gJ2NvbW1hbmRfYWNrLnFvJykge1xuICAgICAgYXdhaXQgcHJvY2Vzc0NvbW1hbmRBY2soc29uZ2JpcmRFdmVudCk7XG4gICAgfVxuXG4gICAgY29uc29sZS5sb2coJ0V2ZW50IHByb2Nlc3NlZCBzdWNjZXNzZnVsbHknKTtcblxuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBzdGF0dXM6ICdvaycsIGRldmljZTogc29uZ2JpcmRFdmVudC5kZXZpY2VfdWlkIH0pLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3IgcHJvY2Vzc2luZyBldmVudDonLCBlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnSW50ZXJuYWwgc2VydmVyIGVycm9yJyB9KSxcbiAgICB9O1xuICB9XG59O1xuXG5pbnRlcmZhY2UgU2Vzc2lvbkluZm8ge1xuICBmaXJtd2FyZV92ZXJzaW9uPzogc3RyaW5nO1xuICBub3RlY2FyZF92ZXJzaW9uPzogc3RyaW5nO1xuICBub3RlY2FyZF9za3U/OiBzdHJpbmc7XG4gIHVzYl9wb3dlcmVkPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBFeHRyYWN0IHNlc3Npb24gaW5mbyAoZmlybXdhcmUgdmVyc2lvbnMsIFNLVSwgcG93ZXIgc3RhdHVzKSBmcm9tIE5vdGVodWIgZXZlbnRcbiAqIFRoaXMgaW5mbyBpcyBhdmFpbGFibGUgaW4gX3Nlc3Npb24ucW8gZXZlbnRzXG4gKiBOb3RlOiBTb21lIGZpZWxkcyBtYXkgYXBwZWFyIGF0IHRoZSB0b3AgbGV2ZWwgb3IgaW5zaWRlIHRoZSBib2R5IGRlcGVuZGluZyBvbiB0aGUgSFRUUCByb3V0ZSBjb25maWd1cmF0aW9uXG4gKi9cbmZ1bmN0aW9uIGV4dHJhY3RTZXNzaW9uSW5mbyhldmVudDogTm90ZWh1YkV2ZW50KTogU2Vzc2lvbkluZm8gfCB1bmRlZmluZWQge1xuICAvLyBDaGVjayBmb3IgcG93ZXJfdXNiIGF0IHRvcCBsZXZlbCBPUiBpbiBib2R5XG4gIGNvbnN0IHBvd2VyVXNiID0gZXZlbnQucG93ZXJfdXNiID8/IGV2ZW50LmJvZHk/LnBvd2VyX3VzYjtcblxuICBpZiAoIWV2ZW50LmZpcm13YXJlX2hvc3QgJiYgIWV2ZW50LmZpcm13YXJlX25vdGVjYXJkICYmICFldmVudC5za3UgJiYgcG93ZXJVc2IgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cblxuICBjb25zdCBzZXNzaW9uSW5mbzogU2Vzc2lvbkluZm8gPSB7fTtcblxuICAvLyBQYXJzZSBob3N0IGZpcm13YXJlIHZlcnNpb25cbiAgaWYgKGV2ZW50LmZpcm13YXJlX2hvc3QpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgaG9zdEZpcm13YXJlID0gSlNPTi5wYXJzZShldmVudC5maXJtd2FyZV9ob3N0KTtcbiAgICAgIHNlc3Npb25JbmZvLmZpcm13YXJlX3ZlcnNpb24gPSBob3N0RmlybXdhcmUudmVyc2lvbjtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLmVycm9yKCdGYWlsZWQgdG8gcGFyc2UgZmlybXdhcmVfaG9zdDonLCBlKTtcbiAgICB9XG4gIH1cblxuICAvLyBQYXJzZSBOb3RlY2FyZCBmaXJtd2FyZSB2ZXJzaW9uXG4gIGlmIChldmVudC5maXJtd2FyZV9ub3RlY2FyZCkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBub3RlY2FyZEZpcm13YXJlID0gSlNPTi5wYXJzZShldmVudC5maXJtd2FyZV9ub3RlY2FyZCk7XG4gICAgICBzZXNzaW9uSW5mby5ub3RlY2FyZF92ZXJzaW9uID0gbm90ZWNhcmRGaXJtd2FyZS52ZXJzaW9uO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ0ZhaWxlZCB0byBwYXJzZSBmaXJtd2FyZV9ub3RlY2FyZDonLCBlKTtcbiAgICB9XG4gIH1cblxuICAvLyBTS1VcbiAgaWYgKGV2ZW50LnNrdSkge1xuICAgIHNlc3Npb25JbmZvLm5vdGVjYXJkX3NrdSA9IGV2ZW50LnNrdTtcbiAgfVxuXG4gIC8vIFVTQiBwb3dlciBzdGF0dXMgKGNoZWNrIHRvcCBsZXZlbCBmaXJzdCwgdGhlbiBib2R5KVxuICBpZiAocG93ZXJVc2IgIT09IHVuZGVmaW5lZCkge1xuICAgIHNlc3Npb25JbmZvLnVzYl9wb3dlcmVkID0gcG93ZXJVc2I7XG4gICAgY29uc29sZS5sb2coYEV4dHJhY3RlZCB1c2JfcG93ZXJlZDogJHtwb3dlclVzYn1gKTtcbiAgfVxuXG4gIHJldHVybiBPYmplY3Qua2V5cyhzZXNzaW9uSW5mbykubGVuZ3RoID4gMCA/IHNlc3Npb25JbmZvIDogdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIE5vcm1hbGl6ZSBsb2NhdGlvbiBzb3VyY2UgdHlwZSBmcm9tIE5vdGVodWIgdG8gb3VyIHN0YW5kYXJkIHZhbHVlc1xuICovXG5mdW5jdGlvbiBub3JtYWxpemVMb2NhdGlvblNvdXJjZShzb3VyY2U/OiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoIXNvdXJjZSkgcmV0dXJuICdncHMnO1xuICBjb25zdCBub3JtYWxpemVkID0gc291cmNlLnRvTG93ZXJDYXNlKCk7XG4gIC8vIE5vdGVodWIgdXNlcyAndHJpYW5ndWxhdGVkJyBidXQgd2UgdXNlICd0cmlhbmd1bGF0aW9uJyBmb3IgY29uc2lzdGVuY3lcbiAgaWYgKG5vcm1hbGl6ZWQgPT09ICd0cmlhbmd1bGF0ZWQnKSByZXR1cm4gJ3RyaWFuZ3VsYXRpb24nO1xuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuLyoqXG4gKiBFeHRyYWN0IGxvY2F0aW9uIGZyb20gTm90ZWh1YiBldmVudCwgcHJlZmVycmluZyBHUFMgYnV0IGZhbGxpbmcgYmFjayB0byB0cmlhbmd1bGF0aW9uXG4gKi9cbmZ1bmN0aW9uIGV4dHJhY3RMb2NhdGlvbihldmVudDogTm90ZWh1YkV2ZW50KTogeyBsYXQ6IG51bWJlcjsgbG9uOiBudW1iZXI7IHRpbWU/OiBudW1iZXI7IHNvdXJjZTogc3RyaW5nOyBuYW1lPzogc3RyaW5nIH0gfCB1bmRlZmluZWQge1xuICAvLyBQcmVmZXIgR1BTIGxvY2F0aW9uIChiZXN0X2xhdC9iZXN0X2xvbiB3aXRoIHR5cGUgJ2dwcycpXG4gIGlmIChldmVudC5iZXN0X2xhdCAhPT0gdW5kZWZpbmVkICYmIGV2ZW50LmJlc3RfbG9uICE9PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgbGF0OiBldmVudC5iZXN0X2xhdCxcbiAgICAgIGxvbjogZXZlbnQuYmVzdF9sb24sXG4gICAgICB0aW1lOiBldmVudC5iZXN0X2xvY2F0aW9uX3doZW4sXG4gICAgICBzb3VyY2U6IG5vcm1hbGl6ZUxvY2F0aW9uU291cmNlKGV2ZW50LmJlc3RfbG9jYXRpb25fdHlwZSksXG4gICAgICBuYW1lOiBldmVudC5iZXN0X2xvY2F0aW9uLFxuICAgIH07XG4gIH1cblxuICAvLyBGYWxsIGJhY2sgdG8gdHJpYW5ndWxhdGlvbiBkYXRhXG4gIGlmIChldmVudC50cmlfbGF0ICE9PSB1bmRlZmluZWQgJiYgZXZlbnQudHJpX2xvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGxhdDogZXZlbnQudHJpX2xhdCxcbiAgICAgIGxvbjogZXZlbnQudHJpX2xvbixcbiAgICAgIHRpbWU6IGV2ZW50LnRyaV93aGVuLFxuICAgICAgc291cmNlOiAndHJpYW5ndWxhdGlvbicsXG4gICAgICBuYW1lOiBldmVudC50b3dlcl9sb2NhdGlvbixcbiAgICB9O1xuICB9XG5cbiAgLy8gRmFsbCBiYWNrIHRvIHRvd2VyIGxvY2F0aW9uXG4gIGlmIChldmVudC50b3dlcl9sYXQgIT09IHVuZGVmaW5lZCAmJiBldmVudC50b3dlcl9sb24gIT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB7XG4gICAgICBsYXQ6IGV2ZW50LnRvd2VyX2xhdCxcbiAgICAgIGxvbjogZXZlbnQudG93ZXJfbG9uLFxuICAgICAgdGltZTogZXZlbnQudG93ZXJfd2hlbixcbiAgICAgIHNvdXJjZTogJ3Rvd2VyJyxcbiAgICAgIG5hbWU6IGV2ZW50LnRvd2VyX2xvY2F0aW9uLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5pbnRlcmZhY2UgU29uZ2JpcmRFdmVudCB7XG4gIGRldmljZV91aWQ6IHN0cmluZztcbiAgc2VyaWFsX251bWJlcj86IHN0cmluZztcbiAgZmxlZXQ/OiBzdHJpbmc7XG4gIGV2ZW50X3R5cGU6IHN0cmluZztcbiAgdGltZXN0YW1wOiBudW1iZXI7XG4gIHJlY2VpdmVkOiBudW1iZXI7XG4gIHNlc3Npb24/OiBTZXNzaW9uSW5mbztcbiAgYm9keToge1xuICAgIHRlbXA/OiBudW1iZXI7XG4gICAgaHVtaWRpdHk/OiBudW1iZXI7XG4gICAgcHJlc3N1cmU/OiBudW1iZXI7XG4gICAgLy8gTm90ZTogdm9sdGFnZSBpcyBubyBsb25nZXIgc2VudCBpbiB0cmFjay5xbzsgYmF0dGVyeSBpbmZvIGNvbWVzIGZyb20gX2xvZy5xbyBhbmQgX2hlYWx0aC5xb1xuICAgIHZvbHRhZ2U/OiBudW1iZXI7ICAgICAgLy8gU3RpbGwgcHJlc2VudCBpbiBfbG9nLnFvIChNb2pvKSBhbmQgX2hlYWx0aC5xbyBldmVudHNcbiAgICBtb3Rpb24/OiBib29sZWFuIHwgbnVtYmVyO1xuICAgIG1vZGU/OiBzdHJpbmc7XG4gICAgdHJhbnNpdF9sb2NrZWQ/OiBib29sZWFuO1xuICAgIGRlbW9fbG9ja2VkPzogYm9vbGVhbjtcbiAgICBncHNfcG93ZXJfc2F2aW5nPzogYm9vbGVhbjtcbiAgICB0eXBlPzogc3RyaW5nO1xuICAgIHZhbHVlPzogbnVtYmVyO1xuICAgIHRocmVzaG9sZD86IG51bWJlcjtcbiAgICBtZXNzYWdlPzogc3RyaW5nO1xuICAgIGNtZD86IHN0cmluZztcbiAgICBjbWRfaWQ/OiBzdHJpbmc7XG4gICAgc3RhdHVzPzogc3RyaW5nO1xuICAgIGV4ZWN1dGVkX2F0PzogbnVtYmVyO1xuICAgIG1pbGxpYW1wX2hvdXJzPzogbnVtYmVyO1xuICAgIHRlbXBlcmF0dXJlPzogbnVtYmVyO1xuICAgIC8vIEhlYWx0aCBldmVudCBmaWVsZHNcbiAgICBtZXRob2Q/OiBzdHJpbmc7XG4gICAgdGV4dD86IHN0cmluZztcbiAgICB2b2x0YWdlX21vZGU/OiBzdHJpbmc7XG4gICAgLy8gR1BTIHRyYWNraW5nIGZpZWxkcyAoX3RyYWNrLnFvKVxuICAgIHZlbG9jaXR5PzogbnVtYmVyO1xuICAgIGJlYXJpbmc/OiBudW1iZXI7XG4gICAgZGlzdGFuY2U/OiBudW1iZXI7XG4gICAgc2Vjb25kcz86IG51bWJlcjtcbiAgICBkb3A/OiBudW1iZXI7XG4gICAgam91cm5leT86IG51bWJlcjtcbiAgICBqY291bnQ/OiBudW1iZXI7XG4gICAgdGltZT86IG51bWJlcjtcbiAgfTtcbiAgbG9jYXRpb24/OiB7XG4gICAgbGF0PzogbnVtYmVyO1xuICAgIGxvbj86IG51bWJlcjtcbiAgICB0aW1lPzogbnVtYmVyO1xuICAgIHNvdXJjZT86IHN0cmluZztcbiAgICBuYW1lPzogc3RyaW5nO1xuICB9O1xuICAvLyBUb3AtbGV2ZWwgc3RhdHVzIGZyb20gX3RyYWNrLnFvIGV2ZW50cyAoZS5nLiwgXCJuby1zYXRcIilcbiAgc3RhdHVzPzogc3RyaW5nO1xufVxuXG5hc3luYyBmdW5jdGlvbiB3cml0ZVRlbGVtZXRyeShldmVudDogU29uZ2JpcmRFdmVudCwgZGF0YVR5cGU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0aW1lc3RhbXAgPSBldmVudC50aW1lc3RhbXAgKiAxMDAwOyAvLyBDb252ZXJ0IHRvIG1pbGxpc2Vjb25kc1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSArIFRUTF9TRUNPTkRTO1xuXG4gIGNvbnN0IHJlY29yZDogUmVjb3JkPHN0cmluZywgYW55PiA9IHtcbiAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgIHRpbWVzdGFtcCxcbiAgICB0dGwsXG4gICAgZGF0YV90eXBlOiBkYXRhVHlwZSxcbiAgICBldmVudF90eXBlOiBldmVudC5ldmVudF90eXBlLFxuICAgIGV2ZW50X3R5cGVfdGltZXN0YW1wOiBgJHtkYXRhVHlwZX0jJHt0aW1lc3RhbXB9YCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyIHx8ICd1bmtub3duJyxcbiAgICBmbGVldDogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICB9O1xuXG4gIGlmIChldmVudC5ib2R5LnRlbXAgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC50ZW1wZXJhdHVyZSA9IGV2ZW50LmJvZHkudGVtcDtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS5odW1pZGl0eSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLmh1bWlkaXR5ID0gZXZlbnQuYm9keS5odW1pZGl0eTtcbiAgfVxuICBpZiAoZXZlbnQuYm9keS5wcmVzc3VyZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnByZXNzdXJlID0gZXZlbnQuYm9keS5wcmVzc3VyZTtcbiAgfVxuICAvLyBOb3RlOiB2b2x0YWdlIGlzIG5vIGxvbmdlciBpbmNsdWRlZCBpbiB0cmFjay5xbyB0ZWxlbWV0cnlcbiAgLy8gQmF0dGVyeSBpbmZvIGNvbWVzIGZyb20gX2xvZy5xbyAoTW9qbykgYW5kIF9oZWFsdGgucW8gZXZlbnRzXG4gIGlmIChldmVudC5ib2R5Lm1vdGlvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLm1vdGlvbiA9IGV2ZW50LmJvZHkubW90aW9uO1xuICB9XG5cbiAgaWYgKGV2ZW50LmxvY2F0aW9uPy5sYXQgIT09IHVuZGVmaW5lZCAmJiBldmVudC5sb2NhdGlvbj8ubG9uICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQubGF0aXR1ZGUgPSBldmVudC5sb2NhdGlvbi5sYXQ7XG4gICAgcmVjb3JkLmxvbmdpdHVkZSA9IGV2ZW50LmxvY2F0aW9uLmxvbjtcbiAgICByZWNvcmQubG9jYXRpb25fc291cmNlID0gZXZlbnQubG9jYXRpb24uc291cmNlIHx8ICdncHMnO1xuICB9XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBQdXRDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IFRFTEVNRVRSWV9UQUJMRSxcbiAgICBJdGVtOiByZWNvcmQsXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgV3JvdGUgdGVsZW1ldHJ5IHJlY29yZCBmb3IgJHtldmVudC5kZXZpY2VfdWlkfWApO1xufVxuXG5hc3luYyBmdW5jdGlvbiB3cml0ZVBvd2VyVGVsZW1ldHJ5KGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRpbWVzdGFtcCA9IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDA7XG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgY29uc3QgcmVjb3JkOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge1xuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgdGltZXN0YW1wLFxuICAgIHR0bCxcbiAgICBkYXRhX3R5cGU6ICdwb3dlcicsXG4gICAgZXZlbnRfdHlwZTogZXZlbnQuZXZlbnRfdHlwZSxcbiAgICBldmVudF90eXBlX3RpbWVzdGFtcDogYHBvd2VyIyR7dGltZXN0YW1wfWAsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgfTtcblxuICBpZiAoZXZlbnQuYm9keS52b2x0YWdlICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQubW9qb192b2x0YWdlID0gZXZlbnQuYm9keS52b2x0YWdlO1xuICB9XG4gIGlmIChldmVudC5ib2R5Lm1pbGxpYW1wX2hvdXJzICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQubWlsbGlhbXBfaG91cnMgPSBldmVudC5ib2R5Lm1pbGxpYW1wX2hvdXJzO1xuICB9XG5cbiAgaWYgKHJlY29yZC5tb2pvX3ZvbHRhZ2UgIT09IHVuZGVmaW5lZCB8fFxuICAgICAgcmVjb3JkLm1pbGxpYW1wX2hvdXJzICE9PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCBjb21tYW5kID0gbmV3IFB1dENvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBURUxFTUVUUllfVEFCTEUsXG4gICAgICBJdGVtOiByZWNvcmQsXG4gICAgfSk7XG5cbiAgICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgICBjb25zb2xlLmxvZyhgV3JvdGUgcG93ZXIgdGVsZW1ldHJ5IHJlY29yZCBmb3IgJHtldmVudC5kZXZpY2VfdWlkfWApO1xuICB9IGVsc2Uge1xuICAgIGNvbnNvbGUubG9nKCdObyBwb3dlciBtZXRyaWNzIGluIF9sb2cucW8gZXZlbnQsIHNraXBwaW5nJyk7XG4gIH1cbn1cblxuLy8gTG93IGJhdHRlcnkgdGhyZXNob2xkIGluIHZvbHRzXG5jb25zdCBMT1dfQkFUVEVSWV9USFJFU0hPTEQgPSAzLjA7XG5cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlSGVhbHRoRXZlbnQoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGltZXN0YW1wID0gZXZlbnQudGltZXN0YW1wICogMTAwMDsgLy8gQ29udmVydCB0byBtaWxsaXNlY29uZHNcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCkgKyBUVExfU0VDT05EUztcblxuICBjb25zdCByZWNvcmQ6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICB0aW1lc3RhbXAsXG4gICAgdHRsLFxuICAgIGRhdGFfdHlwZTogJ2hlYWx0aCcsXG4gICAgZXZlbnRfdHlwZTogZXZlbnQuZXZlbnRfdHlwZSxcbiAgICBldmVudF90eXBlX3RpbWVzdGFtcDogYGhlYWx0aCMke3RpbWVzdGFtcH1gLFxuICAgIHNlcmlhbF9udW1iZXI6IGV2ZW50LnNlcmlhbF9udW1iZXIgfHwgJ3Vua25vd24nLFxuICAgIGZsZWV0OiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gIH07XG5cbiAgLy8gQWRkIGhlYWx0aCBldmVudCBmaWVsZHNcbiAgaWYgKGV2ZW50LmJvZHkubWV0aG9kICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQubWV0aG9kID0gZXZlbnQuYm9keS5tZXRob2Q7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkudGV4dCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnRleHQgPSBldmVudC5ib2R5LnRleHQ7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkudm9sdGFnZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnZvbHRhZ2UgPSBldmVudC5ib2R5LnZvbHRhZ2U7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkudm9sdGFnZV9tb2RlICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQudm9sdGFnZV9tb2RlID0gZXZlbnQuYm9keS52b2x0YWdlX21vZGU7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkubWlsbGlhbXBfaG91cnMgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5taWxsaWFtcF9ob3VycyA9IGV2ZW50LmJvZHkubWlsbGlhbXBfaG91cnM7XG4gIH1cblxuICAvLyBBZGQgbG9jYXRpb24gaWYgYXZhaWxhYmxlXG4gIGlmIChldmVudC5sb2NhdGlvbj8ubGF0ICE9PSB1bmRlZmluZWQgJiYgZXZlbnQubG9jYXRpb24/LmxvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLmxhdGl0dWRlID0gZXZlbnQubG9jYXRpb24ubGF0O1xuICAgIHJlY29yZC5sb25naXR1ZGUgPSBldmVudC5sb2NhdGlvbi5sb247XG4gICAgcmVjb3JkLmxvY2F0aW9uX3NvdXJjZSA9IGV2ZW50LmxvY2F0aW9uLnNvdXJjZSB8fCAndG93ZXInO1xuICB9XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBQdXRDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IFRFTEVNRVRSWV9UQUJMRSxcbiAgICBJdGVtOiByZWNvcmQsXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgV3JvdGUgaGVhbHRoIGV2ZW50IHJlY29yZCBmb3IgJHtldmVudC5kZXZpY2VfdWlkfTogJHtldmVudC5ib2R5Lm1ldGhvZH1gKTtcblxuICAvLyBDaGVjayBmb3IgbG93IGJhdHRlcnkgY29uZGl0aW9uOiB2b2x0YWdlIDwgMy4wViBhbmQgZGV2aWNlIHJlc3RhcnRlZFxuICBpZiAoXG4gICAgdHlwZW9mIGV2ZW50LmJvZHkudm9sdGFnZSA9PT0gJ251bWJlcicgJiZcbiAgICBldmVudC5ib2R5LnZvbHRhZ2UgPCBMT1dfQkFUVEVSWV9USFJFU0hPTEQgJiZcbiAgICB0eXBlb2YgZXZlbnQuYm9keS50ZXh0ID09PSAnc3RyaW5nJyAmJlxuICAgIGV2ZW50LmJvZHkudGV4dC5pbmNsdWRlcygncmVzdGFydGVkJylcbiAgKSB7XG4gICAgYXdhaXQgY3JlYXRlTG93QmF0dGVyeUFsZXJ0KGV2ZW50KTtcbiAgfVxufVxuXG4vKipcbiAqIENyZWF0ZSBhIGxvdyBiYXR0ZXJ5IGFsZXJ0IHdoZW4gZGV2aWNlIHJlc3RhcnRzIGR1ZSB0byBpbnN1ZmZpY2llbnQgcG93ZXJcbiAqL1xuYXN5bmMgZnVuY3Rpb24gY3JlYXRlTG93QmF0dGVyeUFsZXJ0KGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3Iobm93IC8gMTAwMCkgKyBUVExfU0VDT05EUztcbiAgY29uc3QgYWxlcnRJZCA9IGBhbGVydF8ke2V2ZW50LmRldmljZV91aWR9XyR7bm93fV8ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnN1YnN0cmluZyg3KX1gO1xuXG4gIGNvbnN0IGFsZXJ0UmVjb3JkID0ge1xuICAgIGFsZXJ0X2lkOiBhbGVydElkLFxuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgICB0eXBlOiAnbG93X2JhdHRlcnknLFxuICAgIHZhbHVlOiBldmVudC5ib2R5LnZvbHRhZ2UsXG4gICAgbWVzc2FnZTogYERldmljZSByZXN0YXJ0ZWQgZHVlIHRvIGxvdyBiYXR0ZXJ5ICgke2V2ZW50LmJvZHkudm9sdGFnZT8udG9GaXhlZCgyKX1WKWAsXG4gICAgY3JlYXRlZF9hdDogbm93LFxuICAgIGV2ZW50X3RpbWVzdGFtcDogZXZlbnQudGltZXN0YW1wICogMTAwMCxcbiAgICBhY2tub3dsZWRnZWQ6ICdmYWxzZScsXG4gICAgdHRsLFxuICAgIGxvY2F0aW9uOiBldmVudC5sb2NhdGlvbiA/IHtcbiAgICAgIGxhdDogZXZlbnQubG9jYXRpb24ubGF0LFxuICAgICAgbG9uOiBldmVudC5sb2NhdGlvbi5sb24sXG4gICAgfSA6IHVuZGVmaW5lZCxcbiAgICBtZXRhZGF0YToge1xuICAgICAgdm9sdGFnZTogZXZlbnQuYm9keS52b2x0YWdlLFxuICAgICAgdm9sdGFnZV9tb2RlOiBldmVudC5ib2R5LnZvbHRhZ2VfbW9kZSxcbiAgICAgIG1pbGxpYW1wX2hvdXJzOiBldmVudC5ib2R5Lm1pbGxpYW1wX2hvdXJzLFxuICAgICAgaGVhbHRoX3RleHQ6IGV2ZW50LmJvZHkudGV4dCxcbiAgICB9LFxuICB9O1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBBTEVSVFNfVEFCTEUsXG4gICAgSXRlbTogYWxlcnRSZWNvcmQsXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgQ3JlYXRlZCBsb3cgYmF0dGVyeSBhbGVydCAke2FsZXJ0SWR9IGZvciAke2V2ZW50LmRldmljZV91aWR9ICgke2V2ZW50LmJvZHkudm9sdGFnZT8udG9GaXhlZCgyKX1WKWApO1xuXG4gIC8vIFB1Ymxpc2ggdG8gU05TIGZvciBub3RpZmljYXRpb25zXG4gIGNvbnN0IGFsZXJ0TWVzc2FnZSA9IHtcbiAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgIHNlcmlhbF9udW1iZXI6IGV2ZW50LnNlcmlhbF9udW1iZXIsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0LFxuICAgIGFsZXJ0X3R5cGU6ICdsb3dfYmF0dGVyeScsXG4gICAgdmFsdWU6IGV2ZW50LmJvZHkudm9sdGFnZSxcbiAgICBtZXNzYWdlOiBgRGV2aWNlIHJlc3RhcnRlZCBkdWUgdG8gbG93IGJhdHRlcnkgKCR7ZXZlbnQuYm9keS52b2x0YWdlPy50b0ZpeGVkKDIpfVYpYCxcbiAgICB0aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCxcbiAgICBsb2NhdGlvbjogZXZlbnQubG9jYXRpb24sXG4gIH07XG5cbiAgY29uc3QgcHVibGlzaENvbW1hbmQgPSBuZXcgUHVibGlzaENvbW1hbmQoe1xuICAgIFRvcGljQXJuOiBBTEVSVF9UT1BJQ19BUk4sXG4gICAgU3ViamVjdDogYFNvbmdiaXJkIEFsZXJ0OiBMb3cgQmF0dGVyeSAtICR7ZXZlbnQuc2VyaWFsX251bWJlciB8fCBldmVudC5kZXZpY2VfdWlkfWAsXG4gICAgTWVzc2FnZTogSlNPTi5zdHJpbmdpZnkoYWxlcnRNZXNzYWdlLCBudWxsLCAyKSxcbiAgICBNZXNzYWdlQXR0cmlidXRlczoge1xuICAgICAgYWxlcnRfdHlwZToge1xuICAgICAgICBEYXRhVHlwZTogJ1N0cmluZycsXG4gICAgICAgIFN0cmluZ1ZhbHVlOiAnbG93X2JhdHRlcnknLFxuICAgICAgfSxcbiAgICAgIGRldmljZV91aWQ6IHtcbiAgICAgICAgRGF0YVR5cGU6ICdTdHJpbmcnLFxuICAgICAgICBTdHJpbmdWYWx1ZTogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICAgIH0sXG4gICAgICBmbGVldDoge1xuICAgICAgICBEYXRhVHlwZTogJ1N0cmluZycsXG4gICAgICAgIFN0cmluZ1ZhbHVlOiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGF3YWl0IHNuc0NsaWVudC5zZW5kKHB1Ymxpc2hDb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFB1Ymxpc2hlZCBsb3cgYmF0dGVyeSBhbGVydCB0byBTTlMgZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH1gKTtcbn1cblxuLyoqXG4gKiBDaGVjayBpZiBHUFMgcG93ZXIgc2F2ZSBhbGVydCBzaG91bGQgYmUgY3JlYXRlZFxuICogT25seSBjcmVhdGVzIGFsZXJ0IGlmIGdwc19wb3dlcl9zYXZpbmcgc3RhdGUgY2hhbmdlZCBmcm9tIGZhbHNlIHRvIHRydWVcbiAqL1xuYXN5bmMgZnVuY3Rpb24gY2hlY2tHcHNQb3dlclNhdmVBbGVydChldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICB0cnkge1xuICAgIC8vIEdldCBjdXJyZW50IGRldmljZSBzdGF0ZSB0byBjaGVjayBpZiBncHNfcG93ZXJfc2F2aW5nIHdhcyBhbHJlYWR5IHRydWVcbiAgICBjb25zdCBnZXRDb21tYW5kID0gbmV3IEdldENvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgICAgS2V5OiB7IGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQgfSxcbiAgICAgIFByb2plY3Rpb25FeHByZXNzaW9uOiAnZ3BzX3Bvd2VyX3NhdmluZycsXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChnZXRDb21tYW5kKTtcbiAgICBjb25zdCB3YXNHcHNQb3dlclNhdmluZyA9IHJlc3VsdC5JdGVtPy5ncHNfcG93ZXJfc2F2aW5nID09PSB0cnVlO1xuXG4gICAgLy8gT25seSBjcmVhdGUgYWxlcnQgaWYgc3RhdGUgY2hhbmdlZCBmcm9tIGZhbHNlIHRvIHRydWVcbiAgICBpZiAoIXdhc0dwc1Bvd2VyU2F2aW5nKSB7XG4gICAgICBhd2FpdCBjcmVhdGVHcHNQb3dlclNhdmVBbGVydChldmVudCk7XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIC8vIExvZyBidXQgZG9uJ3QgZmFpbCB0aGUgcmVxdWVzdCAtIGFsZXJ0IGNyZWF0aW9uIGlzIG5vdCBjcml0aWNhbFxuICAgIGNvbnNvbGUuZXJyb3IoYEVycm9yIGNoZWNraW5nIEdQUyBwb3dlciBzYXZlIGFsZXJ0OiAke2Vycm9yfWApO1xuICB9XG59XG5cbi8qKlxuICogQ3JlYXRlIGEgR1BTIHBvd2VyIHNhdmUgYWxlcnQgd2hlbiBkZXZpY2UgZGlzYWJsZXMgR1BTIGR1ZSB0byBubyBzaWduYWxcbiAqL1xuYXN5bmMgZnVuY3Rpb24gY3JlYXRlR3BzUG93ZXJTYXZlQWxlcnQoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihub3cgLyAxMDAwKSArIFRUTF9TRUNPTkRTO1xuICBjb25zdCBhbGVydElkID0gYGFsZXJ0XyR7ZXZlbnQuZGV2aWNlX3VpZH1fJHtub3d9XyR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc3Vic3RyaW5nKDcpfWA7XG5cbiAgY29uc3QgYWxlcnRSZWNvcmQgPSB7XG4gICAgYWxlcnRfaWQ6IGFsZXJ0SWQsXG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyIHx8ICd1bmtub3duJyxcbiAgICBmbGVldDogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICAgIHR5cGU6ICdncHNfcG93ZXJfc2F2ZScsXG4gICAgbWVzc2FnZTogJ0dQUyBkaXNhYmxlZCBmb3IgcG93ZXIgc2F2aW5nIC0gdW5hYmxlIHRvIGFjcXVpcmUgc2F0ZWxsaXRlIHNpZ25hbCcsXG4gICAgY3JlYXRlZF9hdDogbm93LFxuICAgIGV2ZW50X3RpbWVzdGFtcDogZXZlbnQudGltZXN0YW1wICogMTAwMCxcbiAgICBhY2tub3dsZWRnZWQ6ICdmYWxzZScsXG4gICAgdHRsLFxuICAgIGxvY2F0aW9uOiBldmVudC5sb2NhdGlvbiA/IHtcbiAgICAgIGxhdDogZXZlbnQubG9jYXRpb24ubGF0LFxuICAgICAgbG9uOiBldmVudC5sb2NhdGlvbi5sb24sXG4gICAgfSA6IHVuZGVmaW5lZCxcbiAgICBtZXRhZGF0YToge1xuICAgICAgbW9kZTogZXZlbnQuYm9keS5tb2RlLFxuICAgICAgdHJhbnNpdF9sb2NrZWQ6IGV2ZW50LmJvZHkudHJhbnNpdF9sb2NrZWQsXG4gICAgfSxcbiAgfTtcblxuICBjb25zdCBjb21tYW5kID0gbmV3IFB1dENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogQUxFUlRTX1RBQkxFLFxuICAgIEl0ZW06IGFsZXJ0UmVjb3JkLFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYENyZWF0ZWQgR1BTIHBvd2VyIHNhdmUgYWxlcnQgJHthbGVydElkfSBmb3IgJHtldmVudC5kZXZpY2VfdWlkfWApO1xuXG4gIC8vIFB1Ymxpc2ggdG8gU05TIGZvciBub3RpZmljYXRpb25zXG4gIGNvbnN0IGFsZXJ0TWVzc2FnZSA9IHtcbiAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgIHNlcmlhbF9udW1iZXI6IGV2ZW50LnNlcmlhbF9udW1iZXIsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0LFxuICAgIGFsZXJ0X3R5cGU6ICdncHNfcG93ZXJfc2F2ZScsXG4gICAgbWVzc2FnZTogJ0dQUyBkaXNhYmxlZCBmb3IgcG93ZXIgc2F2aW5nIC0gdW5hYmxlIHRvIGFjcXVpcmUgc2F0ZWxsaXRlIHNpZ25hbCcsXG4gICAgdGltZXN0YW1wOiBldmVudC50aW1lc3RhbXAsXG4gICAgbG9jYXRpb246IGV2ZW50LmxvY2F0aW9uLFxuICB9O1xuXG4gIGNvbnN0IHB1Ymxpc2hDb21tYW5kID0gbmV3IFB1Ymxpc2hDb21tYW5kKHtcbiAgICBUb3BpY0FybjogQUxFUlRfVE9QSUNfQVJOLFxuICAgIFN1YmplY3Q6IGBTb25nYmlyZCBBbGVydDogR1BTIFBvd2VyIFNhdmUgLSAke2V2ZW50LnNlcmlhbF9udW1iZXIgfHwgZXZlbnQuZGV2aWNlX3VpZH1gLFxuICAgIE1lc3NhZ2U6IEpTT04uc3RyaW5naWZ5KGFsZXJ0TWVzc2FnZSwgbnVsbCwgMiksXG4gICAgTWVzc2FnZUF0dHJpYnV0ZXM6IHtcbiAgICAgIGFsZXJ0X3R5cGU6IHtcbiAgICAgICAgRGF0YVR5cGU6ICdTdHJpbmcnLFxuICAgICAgICBTdHJpbmdWYWx1ZTogJ2dwc19wb3dlcl9zYXZlJyxcbiAgICAgIH0sXG4gICAgICBkZXZpY2VfdWlkOiB7XG4gICAgICAgIERhdGFUeXBlOiAnU3RyaW5nJyxcbiAgICAgICAgU3RyaW5nVmFsdWU6IGV2ZW50LmRldmljZV91aWQsXG4gICAgICB9LFxuICAgICAgZmxlZXQ6IHtcbiAgICAgICAgRGF0YVR5cGU6ICdTdHJpbmcnLFxuICAgICAgICBTdHJpbmdWYWx1ZTogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICAgICAgfSxcbiAgICB9LFxuICB9KTtcblxuICBhd2FpdCBzbnNDbGllbnQuc2VuZChwdWJsaXNoQ29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBQdWJsaXNoZWQgR1BTIHBvd2VyIHNhdmUgYWxlcnQgdG8gU05TIGZvciAke2V2ZW50LmRldmljZV91aWR9YCk7XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgbm8tc2F0IGFsZXJ0IHNob3VsZCBiZSBjcmVhdGVkXG4gKiBPbmx5IGNyZWF0ZXMgYWxlcnQgaWYgZ3BzX25vX3NhdCBzdGF0ZSBjaGFuZ2VkIGZyb20gZmFsc2UgdG8gdHJ1ZVxuICovXG5hc3luYyBmdW5jdGlvbiBjaGVja05vU2F0QWxlcnQoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICAvLyBHZXQgY3VycmVudCBkZXZpY2Ugc3RhdGUgdG8gY2hlY2sgaWYgZ3BzX25vX3NhdCB3YXMgYWxyZWFkeSB0cnVlXG4gICAgY29uc3QgZ2V0Q29tbWFuZCA9IG5ldyBHZXRDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICAgIEtleTogeyBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkIH0sXG4gICAgICBQcm9qZWN0aW9uRXhwcmVzc2lvbjogJ2dwc19ub19zYXQnLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoZ2V0Q29tbWFuZCk7XG4gICAgY29uc3Qgd2FzTm9TYXQgPSByZXN1bHQuSXRlbT8uZ3BzX25vX3NhdCA9PT0gdHJ1ZTtcblxuICAgIC8vIE9ubHkgY3JlYXRlIGFsZXJ0IGlmIHN0YXRlIGNoYW5nZWQgZnJvbSBmYWxzZSB0byB0cnVlXG4gICAgaWYgKCF3YXNOb1NhdCkge1xuICAgICAgYXdhaXQgY3JlYXRlTm9TYXRBbGVydChldmVudCk7XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIC8vIExvZyBidXQgZG9uJ3QgZmFpbCB0aGUgcmVxdWVzdCAtIGFsZXJ0IGNyZWF0aW9uIGlzIG5vdCBjcml0aWNhbFxuICAgIGNvbnNvbGUuZXJyb3IoYEVycm9yIGNoZWNraW5nIG5vLXNhdCBhbGVydDogJHtlcnJvcn1gKTtcbiAgfVxufVxuXG4vKipcbiAqIENyZWF0ZSBhIG5vLXNhdCBhbGVydCB3aGVuIGRldmljZSBjYW5ub3QgYWNxdWlyZSBzYXRlbGxpdGUgZml4XG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNyZWF0ZU5vU2F0QWxlcnQoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihub3cgLyAxMDAwKSArIFRUTF9TRUNPTkRTO1xuICBjb25zdCBhbGVydElkID0gYGFsZXJ0XyR7ZXZlbnQuZGV2aWNlX3VpZH1fJHtub3d9XyR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc3Vic3RyaW5nKDcpfWA7XG5cbiAgY29uc3QgYWxlcnRSZWNvcmQgPSB7XG4gICAgYWxlcnRfaWQ6IGFsZXJ0SWQsXG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyIHx8ICd1bmtub3duJyxcbiAgICBmbGVldDogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICAgIHR5cGU6ICdncHNfbm9fc2F0JyxcbiAgICBtZXNzYWdlOiAnVW5hYmxlIHRvIG9idGFpbiBHUFMgbG9jYXRpb24nLFxuICAgIGNyZWF0ZWRfYXQ6IG5vdyxcbiAgICBldmVudF90aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDAsXG4gICAgYWNrbm93bGVkZ2VkOiAnZmFsc2UnLFxuICAgIHR0bCxcbiAgICBsb2NhdGlvbjogZXZlbnQubG9jYXRpb24gPyB7XG4gICAgICBsYXQ6IGV2ZW50LmxvY2F0aW9uLmxhdCxcbiAgICAgIGxvbjogZXZlbnQubG9jYXRpb24ubG9uLFxuICAgIH0gOiB1bmRlZmluZWQsXG4gIH07XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBQdXRDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IEFMRVJUU19UQUJMRSxcbiAgICBJdGVtOiBhbGVydFJlY29yZCxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBDcmVhdGVkIG5vLXNhdCBhbGVydCAke2FsZXJ0SWR9IGZvciAke2V2ZW50LmRldmljZV91aWR9YCk7XG5cbiAgLy8gUHVibGlzaCB0byBTTlMgZm9yIG5vdGlmaWNhdGlvbnNcbiAgY29uc3QgYWxlcnRNZXNzYWdlID0ge1xuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlcixcbiAgICBmbGVldDogZXZlbnQuZmxlZXQsXG4gICAgYWxlcnRfdHlwZTogJ2dwc19ub19zYXQnLFxuICAgIG1lc3NhZ2U6ICdVbmFibGUgdG8gb2J0YWluIEdQUyBsb2NhdGlvbicsXG4gICAgdGltZXN0YW1wOiBldmVudC50aW1lc3RhbXAsXG4gICAgbG9jYXRpb246IGV2ZW50LmxvY2F0aW9uLFxuICB9O1xuXG4gIGNvbnN0IHB1Ymxpc2hDb21tYW5kID0gbmV3IFB1Ymxpc2hDb21tYW5kKHtcbiAgICBUb3BpY0FybjogQUxFUlRfVE9QSUNfQVJOLFxuICAgIFN1YmplY3Q6IGBTb25nYmlyZCBBbGVydDogVW5hYmxlIHRvIG9idGFpbiBHUFMgbG9jYXRpb24gLSAke2V2ZW50LnNlcmlhbF9udW1iZXIgfHwgZXZlbnQuZGV2aWNlX3VpZH1gLFxuICAgIE1lc3NhZ2U6IEpTT04uc3RyaW5naWZ5KGFsZXJ0TWVzc2FnZSwgbnVsbCwgMiksXG4gICAgTWVzc2FnZUF0dHJpYnV0ZXM6IHtcbiAgICAgIGFsZXJ0X3R5cGU6IHtcbiAgICAgICAgRGF0YVR5cGU6ICdTdHJpbmcnLFxuICAgICAgICBTdHJpbmdWYWx1ZTogJ2dwc19ub19zYXQnLFxuICAgICAgfSxcbiAgICAgIGRldmljZV91aWQ6IHtcbiAgICAgICAgRGF0YVR5cGU6ICdTdHJpbmcnLFxuICAgICAgICBTdHJpbmdWYWx1ZTogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICAgIH0sXG4gICAgICBmbGVldDoge1xuICAgICAgICBEYXRhVHlwZTogJ1N0cmluZycsXG4gICAgICAgIFN0cmluZ1ZhbHVlOiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuXG4gIGF3YWl0IHNuc0NsaWVudC5zZW5kKHB1Ymxpc2hDb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFB1Ymxpc2hlZCBuby1zYXQgYWxlcnQgdG8gU05TIGZvciAke2V2ZW50LmRldmljZV91aWR9YCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlTG9jYXRpb25FdmVudChldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBpZiAoIWV2ZW50LmxvY2F0aW9uPy5sYXQgfHwgIWV2ZW50LmxvY2F0aW9uPy5sb24pIHtcbiAgICBjb25zb2xlLmxvZygnTm8gbG9jYXRpb24gZGF0YSBpbiBldmVudCwgc2tpcHBpbmcnKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB0aW1lc3RhbXAgPSBldmVudC50aW1lc3RhbXAgKiAxMDAwOyAvLyBDb252ZXJ0IHRvIG1pbGxpc2Vjb25kc1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSArIFRUTF9TRUNPTkRTO1xuXG4gIGNvbnN0IHJlY29yZDogUmVjb3JkPHN0cmluZywgYW55PiA9IHtcbiAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgIHRpbWVzdGFtcCxcbiAgICB0dGwsXG4gICAgZGF0YV90eXBlOiAndGVsZW1ldHJ5JywgLy8gVXNlIHRlbGVtZXRyeSBzbyBpdCdzIHBpY2tlZCB1cCBieSBsb2NhdGlvbiBxdWVyeVxuICAgIGV2ZW50X3R5cGU6IGV2ZW50LmV2ZW50X3R5cGUsXG4gICAgZXZlbnRfdHlwZV90aW1lc3RhbXA6IGB0ZWxlbWV0cnkjJHt0aW1lc3RhbXB9YCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyIHx8ICd1bmtub3duJyxcbiAgICBmbGVldDogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICAgIGxhdGl0dWRlOiBldmVudC5sb2NhdGlvbi5sYXQsXG4gICAgbG9uZ2l0dWRlOiBldmVudC5sb2NhdGlvbi5sb24sXG4gICAgbG9jYXRpb25fc291cmNlOiBldmVudC5sb2NhdGlvbi5zb3VyY2UgfHwgJ3RyaWFuZ3VsYXRpb24nLFxuICB9O1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBURUxFTUVUUllfVEFCTEUsXG4gICAgSXRlbTogcmVjb3JkLFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFdyb3RlIGxvY2F0aW9uIGV2ZW50IGZvciAke2V2ZW50LmRldmljZV91aWR9OiAke2V2ZW50LmxvY2F0aW9uLnNvdXJjZX0gKCR7ZXZlbnQubG9jYXRpb24ubGF0fSwgJHtldmVudC5sb2NhdGlvbi5sb259KWApO1xufVxuXG5hc3luYyBmdW5jdGlvbiB1cGRhdGVEZXZpY2VNZXRhZGF0YShldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuXG4gIGNvbnN0IHVwZGF0ZUV4cHJlc3Npb25zOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBleHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgY29uc3QgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczogUmVjb3JkPHN0cmluZywgYW55PiA9IHt9O1xuXG4gIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNsYXN0X3NlZW4gPSA6bGFzdF9zZWVuJyk7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI2xhc3Rfc2VlbiddID0gJ2xhc3Rfc2Vlbic7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpsYXN0X3NlZW4nXSA9IG5vdztcblxuICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjdXBkYXRlZF9hdCA9IDp1cGRhdGVkX2F0Jyk7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3VwZGF0ZWRfYXQnXSA9ICd1cGRhdGVkX2F0JztcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnVwZGF0ZWRfYXQnXSA9IG5vdztcblxuICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjc3RhdHVzID0gOnN0YXR1cycpO1xuICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNzdGF0dXMnXSA9ICdzdGF0dXMnO1xuICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6c3RhdHVzJ10gPSAnb25saW5lJztcblxuICBpZiAoZXZlbnQuc2VyaWFsX251bWJlcikge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNzbiA9IDpzbicpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3NuJ10gPSAnc2VyaWFsX251bWJlcic7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnNuJ10gPSBldmVudC5zZXJpYWxfbnVtYmVyO1xuICB9XG5cbiAgaWYgKGV2ZW50LmZsZWV0KSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI2ZsZWV0ID0gOmZsZWV0Jyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjZmxlZXQnXSA9ICdmbGVldCc7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOmZsZWV0J10gPSBldmVudC5mbGVldDtcbiAgfVxuXG4gIGlmIChldmVudC5ib2R5Lm1vZGUpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjbW9kZSA9IDptb2RlJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjbW9kZSddID0gJ2N1cnJlbnRfbW9kZSc7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOm1vZGUnXSA9IGV2ZW50LmJvZHkubW9kZTtcbiAgfVxuXG4gIC8vIEZvciB0cmFjay5xbyBldmVudHMsIHVwZGF0ZSBsb2NrIHN0YXRlcyBhbmQgR1BTIHBvd2VyIHN0YXRlXG4gIC8vIElmIGxvY2tlZC9ncHNfcG93ZXJfc2F2aW5nIGlzIHRydWUsIHNldCBpdDsgaWYgYWJzZW50IG9yIGZhbHNlLCBjbGVhciBpdFxuICBpZiAoZXZlbnQuZXZlbnRfdHlwZSA9PT0gJ3RyYWNrLnFvJykge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyN0cmFuc2l0X2xvY2tlZCA9IDp0cmFuc2l0X2xvY2tlZCcpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3RyYW5zaXRfbG9ja2VkJ10gPSAndHJhbnNpdF9sb2NrZWQnO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzp0cmFuc2l0X2xvY2tlZCddID0gZXZlbnQuYm9keS50cmFuc2l0X2xvY2tlZCA9PT0gdHJ1ZTtcblxuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNkZW1vX2xvY2tlZCA9IDpkZW1vX2xvY2tlZCcpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI2RlbW9fbG9ja2VkJ10gPSAnZGVtb19sb2NrZWQnO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpkZW1vX2xvY2tlZCddID0gZXZlbnQuYm9keS5kZW1vX2xvY2tlZCA9PT0gdHJ1ZTtcblxuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNncHNfcG93ZXJfc2F2aW5nID0gOmdwc19wb3dlcl9zYXZpbmcnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNncHNfcG93ZXJfc2F2aW5nJ10gPSAnZ3BzX3Bvd2VyX3NhdmluZyc7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOmdwc19wb3dlcl9zYXZpbmcnXSA9IGV2ZW50LmJvZHkuZ3BzX3Bvd2VyX3NhdmluZyA9PT0gdHJ1ZTtcbiAgfVxuXG4gIC8vIEZvciBfdHJhY2sucW8gZXZlbnRzLCB0cmFjayBncHNfbm9fc2F0IHN0YXR1c1xuICBpZiAoZXZlbnQuZXZlbnRfdHlwZSA9PT0gJ190cmFjay5xbycpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjZ3BzX25vX3NhdCA9IDpncHNfbm9fc2F0Jyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjZ3BzX25vX3NhdCddID0gJ2dwc19ub19zYXQnO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpncHNfbm9fc2F0J10gPSBldmVudC5zdGF0dXMgPT09ICduby1zYXQnO1xuICB9XG5cbiAgaWYgKGV2ZW50LmxvY2F0aW9uPy5sYXQgIT09IHVuZGVmaW5lZCAmJiBldmVudC5sb2NhdGlvbj8ubG9uICE9PSB1bmRlZmluZWQpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjbG9jID0gOmxvYycpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI2xvYyddID0gJ2xhc3RfbG9jYXRpb24nO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpsb2MnXSA9IHtcbiAgICAgIGxhdDogZXZlbnQubG9jYXRpb24ubGF0LFxuICAgICAgbG9uOiBldmVudC5sb2NhdGlvbi5sb24sXG4gICAgICB0aW1lOiBldmVudC5sb2NhdGlvbi50aW1lIHx8IGV2ZW50LnRpbWVzdGFtcCxcbiAgICAgIHNvdXJjZTogZXZlbnQubG9jYXRpb24uc291cmNlIHx8ICdncHMnLFxuICAgICAgbmFtZTogZXZlbnQubG9jYXRpb24ubmFtZSxcbiAgICB9O1xuICB9XG5cbiAgaWYgKGV2ZW50LmV2ZW50X3R5cGUgPT09ICd0cmFjay5xbycpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjdGVsZW1ldHJ5ID0gOnRlbGVtZXRyeScpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3RlbGVtZXRyeSddID0gJ2xhc3RfdGVsZW1ldHJ5JztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6dGVsZW1ldHJ5J10gPSB7XG4gICAgICB0ZW1wOiBldmVudC5ib2R5LnRlbXAsXG4gICAgICBodW1pZGl0eTogZXZlbnQuYm9keS5odW1pZGl0eSxcbiAgICAgIHByZXNzdXJlOiBldmVudC5ib2R5LnByZXNzdXJlLFxuICAgICAgLy8gTm90ZTogdm9sdGFnZSBpcyBubyBsb25nZXIgc2VudCBpbiB0cmFjay5xbzsgdXNlIGxhc3Rfdm9sdGFnZSBmcm9tIF9sb2cucW8vX2hlYWx0aC5xb1xuICAgICAgbW90aW9uOiBldmVudC5ib2R5Lm1vdGlvbixcbiAgICAgIHRpbWVzdGFtcDogZXZlbnQudGltZXN0YW1wLFxuICAgIH07XG4gIH1cblxuICBpZiAoZXZlbnQuZXZlbnRfdHlwZSA9PT0gJ19sb2cucW8nKSB7XG4gICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3Bvd2VyID0gOnBvd2VyJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjcG93ZXInXSA9ICdsYXN0X3Bvd2VyJztcbiAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6cG93ZXInXSA9IHtcbiAgICAgIHZvbHRhZ2U6IGV2ZW50LmJvZHkudm9sdGFnZSxcbiAgICAgIHRlbXBlcmF0dXJlOiBldmVudC5ib2R5LnRlbXBlcmF0dXJlLFxuICAgICAgbWlsbGlhbXBfaG91cnM6IGV2ZW50LmJvZHkubWlsbGlhbXBfaG91cnMsXG4gICAgICB0aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCxcbiAgICB9O1xuICAgIC8vIFVwZGF0ZSBkZXZpY2Ugdm9sdGFnZSBmcm9tIE1vam8gcG93ZXIgbW9uaXRvcmluZ1xuICAgIGlmIChldmVudC5ib2R5LnZvbHRhZ2UgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3ZvbHRhZ2UgPSA6dm9sdGFnZScpO1xuICAgICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjdm9sdGFnZSddID0gJ3ZvbHRhZ2UnO1xuICAgICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnZvbHRhZ2UnXSA9IGV2ZW50LmJvZHkudm9sdGFnZTtcbiAgICB9XG4gIH1cblxuICAvLyBVcGRhdGUgZmlybXdhcmUgdmVyc2lvbnMgZnJvbSBfc2Vzc2lvbi5xbyBldmVudHNcbiAgaWYgKGV2ZW50LnNlc3Npb24/LmZpcm13YXJlX3ZlcnNpb24pIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjZndfdmVyc2lvbiA9IDpmd192ZXJzaW9uJyk7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjZndfdmVyc2lvbiddID0gJ2Zpcm13YXJlX3ZlcnNpb24nO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpmd192ZXJzaW9uJ10gPSBldmVudC5zZXNzaW9uLmZpcm13YXJlX3ZlcnNpb247XG4gIH1cblxuICBpZiAoZXZlbnQuc2Vzc2lvbj8ubm90ZWNhcmRfdmVyc2lvbikge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNuY192ZXJzaW9uID0gOm5jX3ZlcnNpb24nKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNuY192ZXJzaW9uJ10gPSAnbm90ZWNhcmRfdmVyc2lvbic7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOm5jX3ZlcnNpb24nXSA9IGV2ZW50LnNlc3Npb24ubm90ZWNhcmRfdmVyc2lvbjtcbiAgfVxuXG4gIGlmIChldmVudC5zZXNzaW9uPy5ub3RlY2FyZF9za3UpIHtcbiAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjbmNfc2t1ID0gOm5jX3NrdScpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI25jX3NrdSddID0gJ25vdGVjYXJkX3NrdSc7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOm5jX3NrdSddID0gZXZlbnQuc2Vzc2lvbi5ub3RlY2FyZF9za3U7XG4gIH1cblxuICAvLyBVcGRhdGUgVVNCIHBvd2VyIHN0YXR1cyBmcm9tIF9zZXNzaW9uLnFvIGV2ZW50c1xuICBpZiAoZXZlbnQuc2Vzc2lvbj8udXNiX3Bvd2VyZWQgIT09IHVuZGVmaW5lZCkge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyN1c2JfcG93ZXJlZCA9IDp1c2JfcG93ZXJlZCcpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3VzYl9wb3dlcmVkJ10gPSAndXNiX3Bvd2VyZWQnO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzp1c2JfcG93ZXJlZCddID0gZXZlbnQuc2Vzc2lvbi51c2JfcG93ZXJlZDtcbiAgfVxuXG4gIC8vIFVwZGF0ZSBVU0IgcG93ZXIgc3RhdHVzIGZyb20gX2hlYWx0aC5xbyB2b2x0YWdlX21vZGUgZmllbGRcbiAgLy8gVGhpcyBpcyBtb3JlIGZyZXF1ZW50bHkgcmVwb3J0ZWQgdGhhbiBfc2Vzc2lvbi5xbyBhbmQgZ2l2ZXMgcmVhbC10aW1lIHBvd2VyIHN0YXR1c1xuICBpZiAoZXZlbnQuYm9keS52b2x0YWdlX21vZGUgIT09IHVuZGVmaW5lZCkge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyN1c2JfcG93ZXJlZCA9IDp1c2JfcG93ZXJlZCcpO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3VzYl9wb3dlcmVkJ10gPSAndXNiX3Bvd2VyZWQnO1xuICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzp1c2JfcG93ZXJlZCddID0gZXZlbnQuYm9keS52b2x0YWdlX21vZGUgPT09ICd1c2InO1xuICB9XG5cbiAgLy8gVXBkYXRlIGRldmljZSB2b2x0YWdlIGZyb20gX2hlYWx0aC5xbyBldmVudHMgKGZhbGxiYWNrIHdoZW4gTW9qbyBpcyBub3QgYXZhaWxhYmxlKVxuICAvLyBPbmx5IHVwZGF0ZSBpZiB3ZSBoYXZlbid0IGFscmVhZHkgc2V0IHZvbHRhZ2UgZnJvbSBfbG9nLnFvIGluIHRoaXMgZXZlbnRcbiAgaWYgKGV2ZW50LmV2ZW50X3R5cGUgPT09ICdfaGVhbHRoLnFvJyAmJiBldmVudC5ib2R5LnZvbHRhZ2UgIT09IHVuZGVmaW5lZCAmJiAhZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnZvbHRhZ2UnXSkge1xuICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyN2b2x0YWdlID0gOnZvbHRhZ2UnKTtcbiAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyN2b2x0YWdlJ10gPSAndm9sdGFnZSc7XG4gICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnZvbHRhZ2UnXSA9IGV2ZW50LmJvZHkudm9sdGFnZTtcbiAgfVxuXG4gIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNjcmVhdGVkX2F0ID0gaWZfbm90X2V4aXN0cygjY3JlYXRlZF9hdCwgOmNyZWF0ZWRfYXQpJyk7XG4gIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI2NyZWF0ZWRfYXQnXSA9ICdjcmVhdGVkX2F0JztcbiAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOmNyZWF0ZWRfYXQnXSA9IG5vdztcblxuICBjb25zdCBjb21tYW5kID0gbmV3IFVwZGF0ZUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICBLZXk6IHsgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCB9LFxuICAgIFVwZGF0ZUV4cHJlc3Npb246ICdTRVQgJyArIHVwZGF0ZUV4cHJlc3Npb25zLmpvaW4oJywgJyksXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiBleHByZXNzaW9uQXR0cmlidXRlTmFtZXMsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczogZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlcyxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBVcGRhdGVkIGRldmljZSBtZXRhZGF0YSBmb3IgJHtldmVudC5kZXZpY2VfdWlkfWApO1xuXG4gIC8vIENsZWFyIHBlbmRpbmdfbW9kZSBpZiB0aGUgZGV2aWNlJ3MgcmVwb3J0ZWQgbW9kZSBtYXRjaGVzIGl0XG4gIGlmIChldmVudC5ib2R5Lm1vZGUpIHtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IFVwZGF0ZUNvbW1hbmQoe1xuICAgICAgICBUYWJsZU5hbWU6IERFVklDRVNfVEFCTEUsXG4gICAgICAgIEtleTogeyBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkIH0sXG4gICAgICAgIFVwZGF0ZUV4cHJlc3Npb246ICdSRU1PVkUgcGVuZGluZ19tb2RlJyxcbiAgICAgICAgQ29uZGl0aW9uRXhwcmVzc2lvbjogJ3BlbmRpbmdfbW9kZSA9IDpyZXBvcnRlZF9tb2RlJyxcbiAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczogeyAnOnJlcG9ydGVkX21vZGUnOiBldmVudC5ib2R5Lm1vZGUgfSxcbiAgICAgIH0pKTtcbiAgICAgIGNvbnNvbGUubG9nKGBDbGVhcmVkIHBlbmRpbmdfbW9kZSBmb3IgJHtldmVudC5kZXZpY2VfdWlkfSAobWF0Y2hlZCAke2V2ZW50LmJvZHkubW9kZX0pYCk7XG4gICAgfSBjYXRjaCAoZXJyOiBhbnkpIHtcbiAgICAgIGlmIChlcnIubmFtZSAhPT0gJ0NvbmRpdGlvbmFsQ2hlY2tGYWlsZWRFeGNlcHRpb24nKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIGNsZWFyaW5nIHBlbmRpbmdfbW9kZTonLCBlcnIpO1xuICAgICAgfVxuICAgIH1cbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBwcm9jZXNzQ29tbWFuZEFjayhldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBjbWRJZCA9IGV2ZW50LmJvZHkuY21kX2lkO1xuICBpZiAoIWNtZElkKSB7XG4gICAgY29uc29sZS5sb2coJ0NvbW1hbmQgYWNrIG1pc3NpbmcgY21kX2lkLCBza2lwcGluZycpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBVcGRhdGVDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IENPTU1BTkRTX1RBQkxFLFxuICAgIEtleToge1xuICAgICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICAgIGNvbW1hbmRfaWQ6IGNtZElkLFxuICAgIH0sXG4gICAgVXBkYXRlRXhwcmVzc2lvbjogJ1NFVCAjc3RhdHVzID0gOnN0YXR1cywgI21lc3NhZ2UgPSA6bWVzc2FnZSwgI2V4ZWN1dGVkX2F0ID0gOmV4ZWN1dGVkX2F0LCAjdXBkYXRlZF9hdCA9IDp1cGRhdGVkX2F0JyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICcjc3RhdHVzJzogJ3N0YXR1cycsXG4gICAgICAnI21lc3NhZ2UnOiAnbWVzc2FnZScsXG4gICAgICAnI2V4ZWN1dGVkX2F0JzogJ2V4ZWN1dGVkX2F0JyxcbiAgICAgICcjdXBkYXRlZF9hdCc6ICd1cGRhdGVkX2F0JyxcbiAgICB9LFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6c3RhdHVzJzogZXZlbnQuYm9keS5zdGF0dXMgfHwgJ3Vua25vd24nLFxuICAgICAgJzptZXNzYWdlJzogZXZlbnQuYm9keS5tZXNzYWdlIHx8ICcnLFxuICAgICAgJzpleGVjdXRlZF9hdCc6IGV2ZW50LmJvZHkuZXhlY3V0ZWRfYXQgPyBldmVudC5ib2R5LmV4ZWN1dGVkX2F0ICogMTAwMCA6IG5vdyxcbiAgICAgICc6dXBkYXRlZF9hdCc6IG5vdyxcbiAgICB9LFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFVwZGF0ZWQgY29tbWFuZCAke2NtZElkfSB3aXRoIHN0YXR1czogJHtldmVudC5ib2R5LnN0YXR1c31gKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc3RvcmVBbGVydChldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKG5vdyAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgLy8gR2VuZXJhdGUgYSB1bmlxdWUgYWxlcnQgSURcbiAgY29uc3QgYWxlcnRJZCA9IGBhbGVydF8ke2V2ZW50LmRldmljZV91aWR9XyR7bm93fV8ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnN1YnN0cmluZyg3KX1gO1xuXG4gIGNvbnN0IGFsZXJ0UmVjb3JkID0ge1xuICAgIGFsZXJ0X2lkOiBhbGVydElkLFxuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgICB0eXBlOiBldmVudC5ib2R5LnR5cGUgfHwgJ3Vua25vd24nLFxuICAgIHZhbHVlOiBldmVudC5ib2R5LnZhbHVlLFxuICAgIHRocmVzaG9sZDogZXZlbnQuYm9keS50aHJlc2hvbGQsXG4gICAgbWVzc2FnZTogZXZlbnQuYm9keS5tZXNzYWdlIHx8ICcnLFxuICAgIGNyZWF0ZWRfYXQ6IG5vdyxcbiAgICBldmVudF90aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDAsXG4gICAgYWNrbm93bGVkZ2VkOiAnZmFsc2UnLCAvLyBTdHJpbmcgZm9yIEdTSSBwYXJ0aXRpb24ga2V5XG4gICAgdHRsLFxuICAgIGxvY2F0aW9uOiBldmVudC5sb2NhdGlvbiA/IHtcbiAgICAgIGxhdDogZXZlbnQubG9jYXRpb24ubGF0LFxuICAgICAgbG9uOiBldmVudC5sb2NhdGlvbi5sb24sXG4gICAgfSA6IHVuZGVmaW5lZCxcbiAgfTtcblxuICBjb25zdCBjb21tYW5kID0gbmV3IFB1dENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogQUxFUlRTX1RBQkxFLFxuICAgIEl0ZW06IGFsZXJ0UmVjb3JkLFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFN0b3JlZCBhbGVydCAke2FsZXJ0SWR9IGZvciAke2V2ZW50LmRldmljZV91aWR9YCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHB1Ymxpc2hBbGVydChldmVudDogU29uZ2JpcmRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBhbGVydE1lc3NhZ2UgPSB7XG4gICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICBzZXJpYWxfbnVtYmVyOiBldmVudC5zZXJpYWxfbnVtYmVyLFxuICAgIGZsZWV0OiBldmVudC5mbGVldCxcbiAgICBhbGVydF90eXBlOiBldmVudC5ib2R5LnR5cGUsXG4gICAgdmFsdWU6IGV2ZW50LmJvZHkudmFsdWUsXG4gICAgdGhyZXNob2xkOiBldmVudC5ib2R5LnRocmVzaG9sZCxcbiAgICBtZXNzYWdlOiBldmVudC5ib2R5Lm1lc3NhZ2UsXG4gICAgdGltZXN0YW1wOiBldmVudC50aW1lc3RhbXAsXG4gICAgbG9jYXRpb246IGV2ZW50LmxvY2F0aW9uLFxuICB9O1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHVibGlzaENvbW1hbmQoe1xuICAgIFRvcGljQXJuOiBBTEVSVF9UT1BJQ19BUk4sXG4gICAgU3ViamVjdDogYFNvbmdiaXJkIEFsZXJ0OiAke2V2ZW50LmJvZHkudHlwZX0gLSAke2V2ZW50LnNlcmlhbF9udW1iZXIgfHwgZXZlbnQuZGV2aWNlX3VpZH1gLFxuICAgIE1lc3NhZ2U6IEpTT04uc3RyaW5naWZ5KGFsZXJ0TWVzc2FnZSwgbnVsbCwgMiksXG4gICAgTWVzc2FnZUF0dHJpYnV0ZXM6IHtcbiAgICAgIGFsZXJ0X3R5cGU6IHtcbiAgICAgICAgRGF0YVR5cGU6ICdTdHJpbmcnLFxuICAgICAgICBTdHJpbmdWYWx1ZTogZXZlbnQuYm9keS50eXBlIHx8ICd1bmtub3duJyxcbiAgICAgIH0sXG4gICAgICBkZXZpY2VfdWlkOiB7XG4gICAgICAgIERhdGFUeXBlOiAnU3RyaW5nJyxcbiAgICAgICAgU3RyaW5nVmFsdWU6IGV2ZW50LmRldmljZV91aWQsXG4gICAgICB9LFxuICAgICAgZmxlZXQ6IHtcbiAgICAgICAgRGF0YVR5cGU6ICdTdHJpbmcnLFxuICAgICAgICBTdHJpbmdWYWx1ZTogZXZlbnQuZmxlZXQgfHwgJ2RlZmF1bHQnLFxuICAgICAgfSxcbiAgICB9LFxuICB9KTtcblxuICBhd2FpdCBzbnNDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFB1Ymxpc2hlZCBhbGVydCB0byBTTlM6ICR7ZXZlbnQuYm9keS50eXBlfWApO1xufVxuXG4vKipcbiAqIFdyaXRlIEdQUyB0cmFja2luZyBldmVudCB0byB0ZWxlbWV0cnkgdGFibGVcbiAqIEhhbmRsZXMgX3RyYWNrLnFvIGV2ZW50cyBmcm9tIE5vdGVjYXJkJ3MgY2FyZC5sb2NhdGlvbi50cmFja1xuICovXG5hc3luYyBmdW5jdGlvbiB3cml0ZVRyYWNraW5nRXZlbnQoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKCFldmVudC5sb2NhdGlvbj8ubGF0IHx8ICFldmVudC5sb2NhdGlvbj8ubG9uKSB7XG4gICAgY29uc29sZS5sb2coJ05vIGxvY2F0aW9uIGRhdGEgaW4gX3RyYWNrLnFvIGV2ZW50LCBza2lwcGluZycpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHRpbWVzdGFtcCA9IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDA7IC8vIENvbnZlcnQgdG8gbWlsbGlzZWNvbmRzXG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgY29uc3QgcmVjb3JkOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge1xuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgdGltZXN0YW1wLFxuICAgIHR0bCxcbiAgICBkYXRhX3R5cGU6ICd0cmFja2luZycsXG4gICAgZXZlbnRfdHlwZTogZXZlbnQuZXZlbnRfdHlwZSxcbiAgICBldmVudF90eXBlX3RpbWVzdGFtcDogYHRyYWNraW5nIyR7dGltZXN0YW1wfWAsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgICBsYXRpdHVkZTogZXZlbnQubG9jYXRpb24ubGF0LFxuICAgIGxvbmdpdHVkZTogZXZlbnQubG9jYXRpb24ubG9uLFxuICAgIGxvY2F0aW9uX3NvdXJjZTogZXZlbnQubG9jYXRpb24uc291cmNlIHx8ICdncHMnLFxuICB9O1xuXG4gIC8vIEFkZCB0cmFja2luZy1zcGVjaWZpYyBmaWVsZHNcbiAgaWYgKGV2ZW50LmJvZHkudmVsb2NpdHkgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC52ZWxvY2l0eSA9IGV2ZW50LmJvZHkudmVsb2NpdHk7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuYmVhcmluZyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLmJlYXJpbmcgPSBldmVudC5ib2R5LmJlYXJpbmc7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuZGlzdGFuY2UgIT09IHVuZGVmaW5lZCkge1xuICAgIHJlY29yZC5kaXN0YW5jZSA9IGV2ZW50LmJvZHkuZGlzdGFuY2U7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuc2Vjb25kcyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLnNlY29uZHMgPSBldmVudC5ib2R5LnNlY29uZHM7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuZG9wICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQuZG9wID0gZXZlbnQuYm9keS5kb3A7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuam91cm5leSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVjb3JkLmpvdXJuZXlfaWQgPSBldmVudC5ib2R5LmpvdXJuZXk7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkuamNvdW50ICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQuamNvdW50ID0gZXZlbnQuYm9keS5qY291bnQ7XG4gIH1cbiAgaWYgKGV2ZW50LmJvZHkubW90aW9uICE9PSB1bmRlZmluZWQpIHtcbiAgICByZWNvcmQubW90aW9uID0gZXZlbnQuYm9keS5tb3Rpb247XG4gIH1cblxuICBjb25zdCBjb21tYW5kID0gbmV3IFB1dENvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogVEVMRU1FVFJZX1RBQkxFLFxuICAgIEl0ZW06IHJlY29yZCxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBXcm90ZSB0cmFja2luZyBldmVudCBmb3IgJHtldmVudC5kZXZpY2VfdWlkfSAoam91cm5leTogJHtldmVudC5ib2R5LmpvdXJuZXl9LCBqY291bnQ6ICR7ZXZlbnQuYm9keS5qY291bnR9KWApO1xufVxuXG4vKipcbiAqIFVwc2VydCBqb3VybmV5IHJlY29yZFxuICogLSBDcmVhdGVzIG5ldyBqb3VybmV5IHdoZW4gamNvdW50ID09PSAxXG4gKiAtIFVwZGF0ZXMgZXhpc3Rpbmcgam91cm5leSB3aXRoIG5ldyBlbmRfdGltZSBhbmQgcG9pbnRfY291bnRcbiAqIC0gTWFya3MgcHJldmlvdXMgam91cm5leSBhcyBjb21wbGV0ZWQgd2hlbiBhIG5ldyBvbmUgc3RhcnRzXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHVwc2VydEpvdXJuZXkoZXZlbnQ6IFNvbmdiaXJkRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgam91cm5leUlkID0gZXZlbnQuYm9keS5qb3VybmV5O1xuICBjb25zdCBqY291bnQgPSBldmVudC5ib2R5Lmpjb3VudDtcblxuICBpZiAoIWpvdXJuZXlJZCB8fCAhamNvdW50KSB7XG4gICAgY29uc29sZS5sb2coJ01pc3Npbmcgam91cm5leSBvciBqY291bnQgaW4gX3RyYWNrLnFvIGV2ZW50LCBza2lwcGluZyBqb3VybmV5IHVwc2VydCcpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG4gIGNvbnN0IHRpbWVzdGFtcE1zID0gZXZlbnQudGltZXN0YW1wICogMTAwMDtcblxuICAvLyBJZiB0aGlzIGlzIHRoZSBmaXJzdCBwb2ludCBvZiBhIG5ldyBqb3VybmV5LCBtYXJrIHByZXZpb3VzIGpvdXJuZXkgYXMgY29tcGxldGVkXG4gIGlmIChqY291bnQgPT09IDEpIHtcbiAgICBhd2FpdCBtYXJrUHJldmlvdXNKb3VybmV5Q29tcGxldGVkKGV2ZW50LmRldmljZV91aWQsIGpvdXJuZXlJZCk7XG4gIH1cblxuICAvLyBDYWxjdWxhdGUgY3VtdWxhdGl2ZSBkaXN0YW5jZVxuICBjb25zdCBkaXN0YW5jZSA9IGV2ZW50LmJvZHkuZGlzdGFuY2UgfHwgMDtcblxuICAvLyBVcHNlcnQgam91cm5leSByZWNvcmRcbiAgY29uc3QgY29tbWFuZCA9IG5ldyBVcGRhdGVDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IEpPVVJORVlTX1RBQkxFLFxuICAgIEtleToge1xuICAgICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICAgIGpvdXJuZXlfaWQ6IGpvdXJuZXlJZCxcbiAgICB9LFxuICAgIFVwZGF0ZUV4cHJlc3Npb246IGBcbiAgICAgIFNFVCAjc3RhdHVzID0gOnN0YXR1cyxcbiAgICAgICAgICAjc3RhcnRfdGltZSA9IGlmX25vdF9leGlzdHMoI3N0YXJ0X3RpbWUsIDpzdGFydF90aW1lKSxcbiAgICAgICAgICAjZW5kX3RpbWUgPSA6ZW5kX3RpbWUsXG4gICAgICAgICAgI3BvaW50X2NvdW50ID0gOnBvaW50X2NvdW50LFxuICAgICAgICAgICN0b3RhbF9kaXN0YW5jZSA9IGlmX25vdF9leGlzdHMoI3RvdGFsX2Rpc3RhbmNlLCA6emVybykgKyA6ZGlzdGFuY2UsXG4gICAgICAgICAgI3R0bCA9IDp0dGwsXG4gICAgICAgICAgI3VwZGF0ZWRfYXQgPSA6dXBkYXRlZF9hdFxuICAgIGAsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAnI3N0YXR1cyc6ICdzdGF0dXMnLFxuICAgICAgJyNzdGFydF90aW1lJzogJ3N0YXJ0X3RpbWUnLFxuICAgICAgJyNlbmRfdGltZSc6ICdlbmRfdGltZScsXG4gICAgICAnI3BvaW50X2NvdW50JzogJ3BvaW50X2NvdW50JyxcbiAgICAgICcjdG90YWxfZGlzdGFuY2UnOiAndG90YWxfZGlzdGFuY2UnLFxuICAgICAgJyN0dGwnOiAndHRsJyxcbiAgICAgICcjdXBkYXRlZF9hdCc6ICd1cGRhdGVkX2F0JyxcbiAgICB9LFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6c3RhdHVzJzogJ2FjdGl2ZScsXG4gICAgICAnOnN0YXJ0X3RpbWUnOiBqb3VybmV5SWQgKiAxMDAwLCAvLyBDb252ZXJ0IHRvIG1pbGxpc2Vjb25kc1xuICAgICAgJzplbmRfdGltZSc6IHRpbWVzdGFtcE1zLFxuICAgICAgJzpwb2ludF9jb3VudCc6IGpjb3VudCxcbiAgICAgICc6ZGlzdGFuY2UnOiBkaXN0YW5jZSxcbiAgICAgICc6emVybyc6IDAsXG4gICAgICAnOnR0bCc6IHR0bCxcbiAgICAgICc6dXBkYXRlZF9hdCc6IG5vdyxcbiAgICB9LFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFVwc2VydGVkIGpvdXJuZXkgJHtqb3VybmV5SWR9IGZvciAke2V2ZW50LmRldmljZV91aWR9IChwb2ludCAke2pjb3VudH0pYCk7XG59XG5cbi8qKlxuICogTWFyayBwcmV2aW91cyBqb3VybmV5IGFzIGNvbXBsZXRlZCB3aGVuIGEgbmV3IGpvdXJuZXkgc3RhcnRzXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIG1hcmtQcmV2aW91c0pvdXJuZXlDb21wbGV0ZWQoZGV2aWNlVWlkOiBzdHJpbmcsIGN1cnJlbnRKb3VybmV5SWQ6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICAvLyBRdWVyeSBmb3IgdGhlIG1vc3QgcmVjZW50IGFjdGl2ZSBqb3VybmV5IHRoYXQncyBub3QgdGhlIGN1cnJlbnQgb25lXG4gIGNvbnN0IHF1ZXJ5Q29tbWFuZCA9IG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogSk9VUk5FWVNfVEFCTEUsXG4gICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQgPSA6ZGV2aWNlX3VpZCBBTkQgam91cm5leV9pZCA8IDpjdXJyZW50X2pvdXJuZXknLFxuICAgIEZpbHRlckV4cHJlc3Npb246ICcjc3RhdHVzID0gOmFjdGl2ZScsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAnI3N0YXR1cyc6ICdzdGF0dXMnLFxuICAgIH0sXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgJzpjdXJyZW50X2pvdXJuZXknOiBjdXJyZW50Sm91cm5leUlkLFxuICAgICAgJzphY3RpdmUnOiAnYWN0aXZlJyxcbiAgICB9LFxuICAgIFNjYW5JbmRleEZvcndhcmQ6IGZhbHNlLCAvLyBNb3N0IHJlY2VudCBmaXJzdFxuICAgIExpbWl0OiAxLFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChxdWVyeUNvbW1hbmQpO1xuXG4gIGlmIChyZXN1bHQuSXRlbXMgJiYgcmVzdWx0Lkl0ZW1zLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBwcmV2aW91c0pvdXJuZXkgPSByZXN1bHQuSXRlbXNbMF07XG5cbiAgICBjb25zdCB1cGRhdGVDb21tYW5kID0gbmV3IFVwZGF0ZUNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICAgIEtleToge1xuICAgICAgICBkZXZpY2VfdWlkOiBkZXZpY2VVaWQsXG4gICAgICAgIGpvdXJuZXlfaWQ6IHByZXZpb3VzSm91cm5leS5qb3VybmV5X2lkLFxuICAgICAgfSxcbiAgICAgIFVwZGF0ZUV4cHJlc3Npb246ICdTRVQgI3N0YXR1cyA9IDpzdGF0dXMsICN1cGRhdGVkX2F0ID0gOnVwZGF0ZWRfYXQnLFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAgICcjc3RhdHVzJzogJ3N0YXR1cycsXG4gICAgICAgICcjdXBkYXRlZF9hdCc6ICd1cGRhdGVkX2F0JyxcbiAgICAgIH0sXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICc6c3RhdHVzJzogJ2NvbXBsZXRlZCcsXG4gICAgICAgICc6dXBkYXRlZF9hdCc6IERhdGUubm93KCksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgYXdhaXQgZG9jQ2xpZW50LnNlbmQodXBkYXRlQ29tbWFuZCk7XG4gICAgY29uc29sZS5sb2coYE1hcmtlZCBqb3VybmV5ICR7cHJldmlvdXNKb3VybmV5LmpvdXJuZXlfaWR9IGFzIGNvbXBsZXRlZCBmb3IgJHtkZXZpY2VVaWR9YCk7XG4gIH1cbn1cblxuLyoqXG4gKiBXcml0ZSBsb2NhdGlvbiB0byB0aGUgbG9jYXRpb25zIGhpc3RvcnkgdGFibGVcbiAqIFJlY29yZHMgYWxsIGxvY2F0aW9uIGV2ZW50cyByZWdhcmRsZXNzIG9mIHNvdXJjZSBmb3IgdW5pZmllZCBsb2NhdGlvbiBoaXN0b3J5XG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlTG9jYXRpb25IaXN0b3J5KGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmICghZXZlbnQubG9jYXRpb24/LmxhdCB8fCAhZXZlbnQubG9jYXRpb24/Lmxvbikge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHRpbWVzdGFtcCA9IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDA7IC8vIENvbnZlcnQgdG8gbWlsbGlzZWNvbmRzXG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG5cbiAgY29uc3QgcmVjb3JkOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge1xuICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgdGltZXN0YW1wLFxuICAgIHR0bCxcbiAgICBsYXRpdHVkZTogZXZlbnQubG9jYXRpb24ubGF0LFxuICAgIGxvbmdpdHVkZTogZXZlbnQubG9jYXRpb24ubG9uLFxuICAgIHNvdXJjZTogZXZlbnQubG9jYXRpb24uc291cmNlIHx8ICd1bmtub3duJyxcbiAgICBsb2NhdGlvbl9uYW1lOiBldmVudC5sb2NhdGlvbi5uYW1lLFxuICAgIGV2ZW50X3R5cGU6IGV2ZW50LmV2ZW50X3R5cGUsXG4gICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgZmxlZXQ6IGV2ZW50LmZsZWV0IHx8ICdkZWZhdWx0JyxcbiAgfTtcblxuICAvLyBBZGQgam91cm5leSBpbmZvIGlmIHRoaXMgaXMgYSB0cmFja2luZyBldmVudFxuICBpZiAoZXZlbnQuZXZlbnRfdHlwZSA9PT0gJ190cmFjay5xbycpIHtcbiAgICBpZiAoZXZlbnQuYm9keS5qb3VybmV5ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHJlY29yZC5qb3VybmV5X2lkID0gZXZlbnQuYm9keS5qb3VybmV5O1xuICAgIH1cbiAgICBpZiAoZXZlbnQuYm9keS5qY291bnQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgcmVjb3JkLmpjb3VudCA9IGV2ZW50LmJvZHkuamNvdW50O1xuICAgIH1cbiAgICBpZiAoZXZlbnQuYm9keS52ZWxvY2l0eSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICByZWNvcmQudmVsb2NpdHkgPSBldmVudC5ib2R5LnZlbG9jaXR5O1xuICAgIH1cbiAgICBpZiAoZXZlbnQuYm9keS5iZWFyaW5nICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHJlY29yZC5iZWFyaW5nID0gZXZlbnQuYm9keS5iZWFyaW5nO1xuICAgIH1cbiAgICBpZiAoZXZlbnQuYm9keS5kaXN0YW5jZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICByZWNvcmQuZGlzdGFuY2UgPSBldmVudC5ib2R5LmRpc3RhbmNlO1xuICAgIH1cbiAgICBpZiAoZXZlbnQuYm9keS5kb3AgIT09IHVuZGVmaW5lZCkge1xuICAgICAgcmVjb3JkLmRvcCA9IGV2ZW50LmJvZHkuZG9wO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBMT0NBVElPTlNfVEFCTEUsXG4gICAgSXRlbTogcmVjb3JkLFxuICB9KTtcblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc29sZS5sb2coYFdyb3RlIGxvY2F0aW9uIGhpc3RvcnkgZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH06ICR7ZXZlbnQubG9jYXRpb24uc291cmNlfSAoJHtldmVudC5sb2NhdGlvbi5sYXR9LCAke2V2ZW50LmxvY2F0aW9uLmxvbn0pYCk7XG59XG5cbi8qKlxuICogQ29tcGxldGUgYWxsIGFjdGl2ZSBqb3VybmV5cyB3aGVuIGRldmljZSBleGl0cyB0cmFuc2l0IG1vZGVcbiAqIFRoaXMgZW5zdXJlcyBqb3VybmV5cyBhcmUgcHJvcGVybHkgY2xvc2VkIHdoZW4gbW9kZSBjaGFuZ2VzIHRvIGRlbW8sIHN0b3JhZ2UsIG9yIHNsZWVwXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNvbXBsZXRlQWN0aXZlSm91cm5leXNPbk1vZGVDaGFuZ2UoZGV2aWNlVWlkOiBzdHJpbmcsIG5ld01vZGU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAvLyBRdWVyeSBmb3IgYWxsIGFjdGl2ZSBqb3VybmV5cyBmb3IgdGhpcyBkZXZpY2VcbiAgY29uc3QgcXVlcnlDb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICBJbmRleE5hbWU6ICdzdGF0dXMtaW5kZXgnLFxuICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICcjc3RhdHVzID0gOmFjdGl2ZScsXG4gICAgRmlsdGVyRXhwcmVzc2lvbjogJ2RldmljZV91aWQgPSA6ZGV2aWNlX3VpZCcsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAnI3N0YXR1cyc6ICdzdGF0dXMnLFxuICAgIH0sXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzphY3RpdmUnOiAnYWN0aXZlJyxcbiAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICB9LFxuICB9KTtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKHF1ZXJ5Q29tbWFuZCk7XG5cbiAgICBpZiAocmVzdWx0Lkl0ZW1zICYmIHJlc3VsdC5JdGVtcy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zb2xlLmxvZyhgTW9kZSBjaGFuZ2VkIHRvICR7bmV3TW9kZX0gLSBjb21wbGV0aW5nICR7cmVzdWx0Lkl0ZW1zLmxlbmd0aH0gYWN0aXZlIGpvdXJuZXkocykgZm9yICR7ZGV2aWNlVWlkfWApO1xuXG4gICAgICAvLyBNYXJrIGVhY2ggYWN0aXZlIGpvdXJuZXkgYXMgY29tcGxldGVkXG4gICAgICBmb3IgKGNvbnN0IGpvdXJuZXkgb2YgcmVzdWx0Lkl0ZW1zKSB7XG4gICAgICAgIGNvbnN0IHVwZGF0ZUNvbW1hbmQgPSBuZXcgVXBkYXRlQ29tbWFuZCh7XG4gICAgICAgICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICAgICAgICBLZXk6IHtcbiAgICAgICAgICAgIGRldmljZV91aWQ6IGRldmljZVVpZCxcbiAgICAgICAgICAgIGpvdXJuZXlfaWQ6IGpvdXJuZXkuam91cm5leV9pZCxcbiAgICAgICAgICB9LFxuICAgICAgICAgIFVwZGF0ZUV4cHJlc3Npb246ICdTRVQgI3N0YXR1cyA9IDpzdGF0dXMsICN1cGRhdGVkX2F0ID0gOnVwZGF0ZWRfYXQnLFxuICAgICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczoge1xuICAgICAgICAgICAgJyNzdGF0dXMnOiAnc3RhdHVzJyxcbiAgICAgICAgICAgICcjdXBkYXRlZF9hdCc6ICd1cGRhdGVkX2F0JyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgICAgICc6c3RhdHVzJzogJ2NvbXBsZXRlZCcsXG4gICAgICAgICAgICAnOnVwZGF0ZWRfYXQnOiBEYXRlLm5vdygpLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGF3YWl0IGRvY0NsaWVudC5zZW5kKHVwZGF0ZUNvbW1hbmQpO1xuICAgICAgICBjb25zb2xlLmxvZyhgTWFya2VkIGpvdXJuZXkgJHtqb3VybmV5LmpvdXJuZXlfaWR9IGFzIGNvbXBsZXRlZCBkdWUgdG8gbW9kZSBjaGFuZ2UgdG8gJHtuZXdNb2RlfWApO1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAvLyBMb2cgYnV0IGRvbid0IGZhaWwgdGhlIHJlcXVlc3QgLSBqb3VybmV5IGNvbXBsZXRpb24gaXMgbm90IGNyaXRpY2FsXG4gICAgY29uc29sZS5lcnJvcihgRXJyb3IgY29tcGxldGluZyBhY3RpdmUgam91cm5leXMgb24gbW9kZSBjaGFuZ2U6ICR7ZXJyb3J9YCk7XG4gIH1cbn1cblxuLyoqXG4gKiBDaGVjayBpZiBtb2RlIGhhcyBjaGFuZ2VkIGFuZCB3cml0ZSBhIG1vZGVfY2hhbmdlIGV2ZW50IHRvIHRlbGVtZXRyeSB0YWJsZVxuICogVGhpcyBhbGxvd3MgdGhlIGFjdGl2aXR5IGZlZWQgdG8gc2hvdyBtb2RlIGNoYW5nZXNcbiAqL1xuYXN5bmMgZnVuY3Rpb24gdHJhY2tNb2RlQ2hhbmdlKGV2ZW50OiBTb25nYmlyZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmICghZXZlbnQuYm9keS5tb2RlKSB7XG4gICAgcmV0dXJuOyAvLyBObyBtb2RlIGluIGV2ZW50LCBub3RoaW5nIHRvIHRyYWNrXG4gIH1cblxuICB0cnkge1xuICAgIC8vIEdldCBjdXJyZW50IGRldmljZSBtb2RlIGZyb20gZGV2aWNlcyB0YWJsZVxuICAgIGNvbnN0IGdldENvbW1hbmQgPSBuZXcgR2V0Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IERFVklDRVNfVEFCTEUsXG4gICAgICBLZXk6IHsgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCB9LFxuICAgICAgUHJvamVjdGlvbkV4cHJlc3Npb246ICdjdXJyZW50X21vZGUnLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoZ2V0Q29tbWFuZCk7XG4gICAgY29uc3QgcHJldmlvdXNNb2RlID0gcmVzdWx0Lkl0ZW0/LmN1cnJlbnRfbW9kZTtcblxuICAgIC8vIElmIG1vZGUgaGFzIGNoYW5nZWQgKG9yIGRldmljZSBpcyBuZXcpLCByZWNvcmQgdGhlIGNoYW5nZVxuICAgIGlmIChwcmV2aW91c01vZGUgJiYgcHJldmlvdXNNb2RlICE9PSBldmVudC5ib2R5Lm1vZGUpIHtcbiAgICAgIGNvbnN0IHRpbWVzdGFtcCA9IGV2ZW50LnRpbWVzdGFtcCAqIDEwMDA7IC8vIENvbnZlcnQgdG8gbWlsbGlzZWNvbmRzXG4gICAgICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSArIFRUTF9TRUNPTkRTO1xuXG4gICAgICBjb25zdCByZWNvcmQ6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgICAgIHRpbWVzdGFtcCxcbiAgICAgICAgdHRsLFxuICAgICAgICBkYXRhX3R5cGU6ICdtb2RlX2NoYW5nZScsXG4gICAgICAgIGV2ZW50X3R5cGU6IGV2ZW50LmV2ZW50X3R5cGUsXG4gICAgICAgIGV2ZW50X3R5cGVfdGltZXN0YW1wOiBgbW9kZV9jaGFuZ2UjJHt0aW1lc3RhbXB9YCxcbiAgICAgICAgc2VyaWFsX251bWJlcjogZXZlbnQuc2VyaWFsX251bWJlciB8fCAndW5rbm93bicsXG4gICAgICAgIGZsZWV0OiBldmVudC5mbGVldCB8fCAnZGVmYXVsdCcsXG4gICAgICAgIHByZXZpb3VzX21vZGU6IHByZXZpb3VzTW9kZSxcbiAgICAgICAgbmV3X21vZGU6IGV2ZW50LmJvZHkubW9kZSxcbiAgICAgIH07XG5cbiAgICAgIGNvbnN0IHB1dENvbW1hbmQgPSBuZXcgUHV0Q29tbWFuZCh7XG4gICAgICAgIFRhYmxlTmFtZTogVEVMRU1FVFJZX1RBQkxFLFxuICAgICAgICBJdGVtOiByZWNvcmQsXG4gICAgICB9KTtcblxuICAgICAgYXdhaXQgZG9jQ2xpZW50LnNlbmQocHV0Q29tbWFuZCk7XG4gICAgICBjb25zb2xlLmxvZyhgUmVjb3JkZWQgbW9kZSBjaGFuZ2UgZm9yICR7ZXZlbnQuZGV2aWNlX3VpZH06ICR7cHJldmlvdXNNb2RlfSAtPiAke2V2ZW50LmJvZHkubW9kZX1gKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgLy8gTG9nIGJ1dCBkb24ndCBmYWlsIHRoZSByZXF1ZXN0IC0gbW9kZSB0cmFja2luZyBpcyBub3QgY3JpdGljYWxcbiAgICBjb25zb2xlLmVycm9yKGBFcnJvciB0cmFja2luZyBtb2RlIGNoYW5nZTogJHtlcnJvcn1gKTtcbiAgfVxufVxuXG4vKipcbiAqIFdyaXRlIGEgTm90ZWNhcmQgc3dhcCBldmVudCB0byB0aGUgdGVsZW1ldHJ5IHRhYmxlIGZvciB0aGUgYWN0aXZpdHkgZmVlZFxuICovXG5hc3luYyBmdW5jdGlvbiB3cml0ZU5vdGVjYXJkU3dhcEV2ZW50KFxuICBzZXJpYWxOdW1iZXI6IHN0cmluZyxcbiAgb2xkRGV2aWNlVWlkOiBzdHJpbmcsXG4gIG5ld0RldmljZVVpZDogc3RyaW5nLFxuICB0aW1lc3RhbXA6IG51bWJlclxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRpbWVzdGFtcE1zID0gdGltZXN0YW1wICogMTAwMDtcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCkgKyBUVExfU0VDT05EUztcblxuICBjb25zdCByZWNvcmQgPSB7XG4gICAgZGV2aWNlX3VpZDogbmV3RGV2aWNlVWlkLFxuICAgIHNlcmlhbF9udW1iZXI6IHNlcmlhbE51bWJlcixcbiAgICB0aW1lc3RhbXA6IHRpbWVzdGFtcE1zLFxuICAgIHR0bCxcbiAgICBkYXRhX3R5cGU6ICdub3RlY2FyZF9zd2FwJyxcbiAgICBldmVudF90eXBlOiAnbm90ZWNhcmRfc3dhcCcsXG4gICAgZXZlbnRfdHlwZV90aW1lc3RhbXA6IGBub3RlY2FyZF9zd2FwIyR7dGltZXN0YW1wTXN9YCxcbiAgICBvbGRfZGV2aWNlX3VpZDogb2xkRGV2aWNlVWlkLFxuICAgIG5ld19kZXZpY2VfdWlkOiBuZXdEZXZpY2VVaWQsXG4gIH07XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBQdXRDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IFRFTEVNRVRSWV9UQUJMRSxcbiAgICBJdGVtOiByZWNvcmQsXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgUmVjb3JkZWQgTm90ZWNhcmQgc3dhcCBmb3IgJHtzZXJpYWxOdW1iZXJ9OiAke29sZERldmljZVVpZH0gLT4gJHtuZXdEZXZpY2VVaWR9YCk7XG59XG4iXX0=