"use strict";
/**
 * Activity Feed API Lambda
 *
 * Returns a unified activity feed combining:
 * - Alerts (from alerts table)
 * - Health events (from telemetry table)
 * - Commands (from commands table)
 * - Journey start/end events (from journeys table)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const ddbClient = new client_dynamodb_1.DynamoDBClient({});
const docClient = lib_dynamodb_1.DynamoDBDocumentClient.from(ddbClient);
const TELEMETRY_TABLE = process.env.TELEMETRY_TABLE;
const ALERTS_TABLE = process.env.ALERTS_TABLE;
const DEVICES_TABLE = process.env.DEVICES_TABLE;
const COMMANDS_TABLE = process.env.COMMANDS_TABLE;
const JOURNEYS_TABLE = process.env.JOURNEYS_TABLE;
const handler = async (event) => {
    console.log('Request:', JSON.stringify(event));
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
    };
    try {
        const method = event.requestContext?.http?.method || event.httpMethod;
        if (method === 'OPTIONS') {
            return { statusCode: 200, headers: corsHeaders, body: '' };
        }
        const queryParams = event.queryStringParameters || {};
        const hours = parseInt(queryParams.hours || '24');
        const limit = parseInt(queryParams.limit || '50');
        // Fetch activities from all sources in parallel
        const [alerts, healthEvents, commands, journeys, modeChanges, devices] = await Promise.all([
            getRecentAlerts(hours, limit),
            getRecentHealthEvents(hours, limit),
            getRecentCommands(hours, limit),
            getRecentJourneys(hours, limit),
            getRecentModeChanges(hours, limit),
            getDevices(),
        ]);
        // Create device name lookup
        const deviceNames = {};
        for (const device of devices) {
            deviceNames[device.device_uid] = device.name || device.serial_number || device.device_uid;
        }
        // Transform alerts to activity items
        const alertActivities = alerts.map((alert) => ({
            id: `alert-${alert.alert_id}`,
            type: 'alert',
            device_uid: alert.device_uid,
            device_name: deviceNames[alert.device_uid],
            message: formatAlertMessage(alert),
            timestamp: new Date(alert.created_at).toISOString(),
            data: {
                alert_type: alert.type,
                value: alert.value,
                threshold: alert.threshold,
                acknowledged: alert.acknowledged,
            },
        }));
        // Transform health events to activity items
        const healthActivities = healthEvents.map((event) => ({
            id: `health-${event.device_uid}-${event.timestamp}`,
            type: 'health',
            device_uid: event.device_uid,
            device_name: deviceNames[event.device_uid],
            message: formatHealthMessage(event),
            timestamp: new Date(event.timestamp).toISOString(),
            data: {
                method: event.method,
                voltage: event.voltage,
            },
        }));
        // Transform commands to activity items
        const commandActivities = commands.map((cmd) => ({
            id: `command-${cmd.command_id}`,
            type: 'command',
            device_uid: cmd.device_uid,
            device_name: deviceNames[cmd.device_uid],
            message: formatCommandMessage(cmd),
            timestamp: new Date(cmd.created_at).toISOString(),
            data: {
                cmd: cmd.cmd,
                status: cmd.status,
                ack_status: cmd.ack_status,
            },
        }));
        // Transform journeys to activity items (start and end events)
        const journeyActivities = [];
        for (const journey of journeys) {
            // Journey start event
            journeyActivities.push({
                id: `journey-start-${journey.device_uid}-${journey.journey_id}`,
                type: 'journey',
                device_uid: journey.device_uid,
                device_name: deviceNames[journey.device_uid],
                message: 'Journey started',
                timestamp: new Date(journey.start_time).toISOString(),
                data: {
                    journey_id: journey.journey_id,
                    event: 'start',
                },
            });
            // Journey end event (only if completed)
            if (journey.status === 'completed' && journey.end_time) {
                journeyActivities.push({
                    id: `journey-end-${journey.device_uid}-${journey.journey_id}`,
                    type: 'journey',
                    device_uid: journey.device_uid,
                    device_name: deviceNames[journey.device_uid],
                    message: formatJourneyEndMessage(journey),
                    timestamp: new Date(journey.end_time).toISOString(),
                    data: {
                        journey_id: journey.journey_id,
                        event: 'end',
                        point_count: journey.point_count,
                        total_distance: journey.total_distance,
                    },
                });
            }
        }
        // Transform mode changes to activity items
        const modeChangeActivities = modeChanges.map((change) => ({
            id: `mode-${change.device_uid}-${change.timestamp}`,
            type: 'mode_change',
            device_uid: change.device_uid,
            device_name: deviceNames[change.device_uid],
            message: formatModeChangeMessage(change),
            timestamp: new Date(change.timestamp).toISOString(),
            data: {
                previous_mode: change.previous_mode,
                new_mode: change.new_mode,
            },
        }));
        // Merge all activities and sort by timestamp (newest first)
        const allActivities = [...alertActivities, ...healthActivities, ...commandActivities, ...journeyActivities, ...modeChangeActivities]
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
            .slice(0, limit);
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                hours,
                count: allActivities.length,
                activities: allActivities,
            }),
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
async function getRecentAlerts(hours, limit) {
    const cutoffTime = Date.now() - hours * 60 * 60 * 1000;
    const allItems = [];
    let lastEvaluatedKey;
    // Paginate through all results
    do {
        const command = new lib_dynamodb_1.ScanCommand({
            TableName: ALERTS_TABLE,
            FilterExpression: 'created_at > :cutoff',
            ExpressionAttributeValues: {
                ':cutoff': cutoffTime,
            },
            ExclusiveStartKey: lastEvaluatedKey,
        });
        const result = await docClient.send(command);
        allItems.push(...(result.Items || []));
        lastEvaluatedKey = result.LastEvaluatedKey;
        // Stop early if we have enough items
        if (allItems.length >= limit * 2)
            break;
    } while (lastEvaluatedKey);
    return allItems.slice(0, limit * 2);
}
async function getRecentHealthEvents(hours, limit) {
    const cutoffTime = Date.now() - hours * 60 * 60 * 1000;
    const allItems = [];
    let lastEvaluatedKey;
    // Paginate through all results
    do {
        const command = new lib_dynamodb_1.ScanCommand({
            TableName: TELEMETRY_TABLE,
            FilterExpression: '#ts > :cutoff AND data_type = :data_type',
            ExpressionAttributeNames: {
                '#ts': 'timestamp',
            },
            ExpressionAttributeValues: {
                ':cutoff': cutoffTime,
                ':data_type': 'health',
            },
            ExclusiveStartKey: lastEvaluatedKey,
        });
        const result = await docClient.send(command);
        allItems.push(...(result.Items || []));
        lastEvaluatedKey = result.LastEvaluatedKey;
        // Stop early if we have enough items
        if (allItems.length >= limit * 2)
            break;
    } while (lastEvaluatedKey);
    return allItems.slice(0, limit * 2);
}
async function getRecentCommands(hours, limit) {
    const cutoffTime = Date.now() - hours * 60 * 60 * 1000;
    const allItems = [];
    let lastEvaluatedKey;
    do {
        const command = new lib_dynamodb_1.ScanCommand({
            TableName: COMMANDS_TABLE,
            FilterExpression: 'created_at > :cutoff',
            ExpressionAttributeValues: {
                ':cutoff': cutoffTime,
            },
            ExclusiveStartKey: lastEvaluatedKey,
        });
        const result = await docClient.send(command);
        allItems.push(...(result.Items || []));
        lastEvaluatedKey = result.LastEvaluatedKey;
        if (allItems.length >= limit * 2)
            break;
    } while (lastEvaluatedKey);
    return allItems.slice(0, limit * 2);
}
async function getRecentJourneys(hours, limit) {
    const cutoffTime = Date.now() - hours * 60 * 60 * 1000;
    const allItems = [];
    let lastEvaluatedKey;
    do {
        const command = new lib_dynamodb_1.ScanCommand({
            TableName: JOURNEYS_TABLE,
            FilterExpression: 'start_time > :cutoff',
            ExpressionAttributeValues: {
                ':cutoff': cutoffTime,
            },
            ExclusiveStartKey: lastEvaluatedKey,
        });
        const result = await docClient.send(command);
        allItems.push(...(result.Items || []));
        lastEvaluatedKey = result.LastEvaluatedKey;
        if (allItems.length >= limit * 2)
            break;
    } while (lastEvaluatedKey);
    return allItems.slice(0, limit * 2);
}
async function getDevices() {
    const command = new lib_dynamodb_1.ScanCommand({
        TableName: DEVICES_TABLE,
        ProjectionExpression: 'device_uid, #name, serial_number',
        ExpressionAttributeNames: {
            '#name': 'name',
        },
    });
    const result = await docClient.send(command);
    return result.Items || [];
}
function formatAlertMessage(alert) {
    const alertLabels = {
        temp_high: 'High temperature alert',
        temp_low: 'Low temperature alert',
        humidity_high: 'High humidity alert',
        humidity_low: 'Low humidity alert',
        pressure_change: 'Pressure change alert',
        low_battery: 'Low battery alert',
        motion: 'Motion detected',
    };
    const label = alertLabels[alert.type] || alert.type;
    if (alert.value !== undefined) {
        return `${label}: ${alert.value.toFixed(1)}`;
    }
    return label;
}
function formatHealthMessage(event) {
    const methodLabels = {
        dfu: 'Firmware update',
        boot: 'Device booted',
        reboot: 'Device rebooted',
        reset: 'Device reset',
        usb: 'USB connected',
        battery: 'Battery status update',
        sync: 'Sync completed',
        connected: 'Connected to network',
        disconnected: 'Disconnected from network',
    };
    const label = methodLabels[event.method] || event.method || 'Health event';
    if (event.text) {
        return `${label}: ${event.text}`;
    }
    return label;
}
function formatCommandMessage(cmd) {
    const cmdLabels = {
        ping: 'Ping command',
        locate: 'Locate command',
        play_melody: 'Play melody command',
        test_audio: 'Test audio command',
        set_volume: 'Set volume command',
    };
    const label = cmdLabels[cmd.cmd] || cmd.cmd || 'Command';
    const statusLabels = {
        queued: 'queued',
        sent: 'sent',
        ok: 'acknowledged',
        error: 'failed',
        ignored: 'ignored',
    };
    const status = statusLabels[cmd.ack_status || cmd.status] || cmd.status;
    return `${label} ${status}`;
}
function formatJourneyEndMessage(journey) {
    const distance = journey.total_distance || 0;
    const points = journey.point_count || 0;
    // Format distance in km or m
    let distanceStr;
    if (distance >= 1000) {
        distanceStr = `${(distance / 1000).toFixed(1)} km`;
    }
    else {
        distanceStr = `${Math.round(distance)} m`;
    }
    return `Journey ended: ${distanceStr}, ${points} points`;
}
async function getRecentModeChanges(hours, limit) {
    const cutoffTime = Date.now() - hours * 60 * 60 * 1000;
    const allItems = [];
    let lastEvaluatedKey;
    do {
        const command = new lib_dynamodb_1.ScanCommand({
            TableName: TELEMETRY_TABLE,
            FilterExpression: '#ts > :cutoff AND data_type = :data_type',
            ExpressionAttributeNames: {
                '#ts': 'timestamp',
            },
            ExpressionAttributeValues: {
                ':cutoff': cutoffTime,
                ':data_type': 'mode_change',
            },
            ExclusiveStartKey: lastEvaluatedKey,
        });
        const result = await docClient.send(command);
        allItems.push(...(result.Items || []));
        lastEvaluatedKey = result.LastEvaluatedKey;
        if (allItems.length >= limit * 2)
            break;
    } while (lastEvaluatedKey);
    return allItems.slice(0, limit * 2);
}
function formatModeChangeMessage(change) {
    const modeLabels = {
        demo: 'Demo',
        transit: 'Transit',
        storage: 'Storage',
        sleep: 'Sleep',
    };
    const prevLabel = modeLabels[change.previous_mode] || change.previous_mode;
    const newLabel = modeLabels[change.new_mode] || change.new_mode;
    return `Mode changed: ${prevLabel} → ${newLabel}`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWFjdGl2aXR5L2luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7R0FRRzs7O0FBRUgsOERBQTBEO0FBQzFELHdEQUE0RTtBQUc1RSxNQUFNLFNBQVMsR0FBRyxJQUFJLGdDQUFjLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDekMsTUFBTSxTQUFTLEdBQUcscUNBQXNCLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBRXpELE1BQU0sZUFBZSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsZUFBZ0IsQ0FBQztBQUNyRCxNQUFNLFlBQVksR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLFlBQWEsQ0FBQztBQUMvQyxNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGFBQWMsQ0FBQztBQUNqRCxNQUFNLGNBQWMsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGNBQWUsQ0FBQztBQUNuRCxNQUFNLGNBQWMsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGNBQWUsQ0FBQztBQVk1QyxNQUFNLE9BQU8sR0FBRyxLQUFLLEVBQUUsS0FBMkIsRUFBa0MsRUFBRTtJQUMzRixPQUFPLENBQUMsR0FBRyxDQUFDLFVBQVUsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFFL0MsTUFBTSxXQUFXLEdBQUc7UUFDbEIsNkJBQTZCLEVBQUUsR0FBRztRQUNsQyw4QkFBOEIsRUFBRSw0QkFBNEI7UUFDNUQsOEJBQThCLEVBQUUsYUFBYTtLQUM5QyxDQUFDO0lBRUYsSUFBSSxDQUFDO1FBQ0gsTUFBTSxNQUFNLEdBQUksS0FBSyxDQUFDLGNBQXNCLEVBQUUsSUFBSSxFQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsVUFBVSxDQUFDO1FBRS9FLElBQUksTUFBTSxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQ3pCLE9B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QkFDekIsU0FBUyxFQUFFLFVBQVU7Z0JBQ3JCLFlBQVksRUFBRSxhQUFhO2FBQzVCO1lBQ0QsaUJBQWlCLEVBQUUsZ0JBQWdCO1NBQ3BDLENBQUMsQ0FBQztRQUVILE1BQU0sTUFBTSxHQUFHLE1BQU0sU0FBUyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUM3QyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFDdkMsZ0JBQWdCLEdBQUcsTUFBTSxDQUFDLGdCQUFnQixDQUFDO1FBRTNDLElBQUksUUFBUSxDQUFDLE1BQU0sSUFBSSxLQUFLLEdBQUcsQ0FBQztZQUFFLE1BQU07SUFDMUMsQ0FBQyxRQUFRLGdCQUFnQixFQUFFO0lBRTNCLE9BQU8sUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQ3RDLENBQUM7QUFFRCxTQUFTLHVCQUF1QixDQUFDLE1BQVc7SUFDMUMsTUFBTSxVQUFVLEdBQTJCO1FBQ3pDLElBQUksRUFBRSxNQUFNO1FBQ1osT0FBTyxFQUFFLFNBQVM7UUFDbEIsT0FBTyxFQUFFLFNBQVM7UUFDbEIsS0FBSyxFQUFFLE9BQU87S0FDZixDQUFDO0lBRUYsTUFBTSxTQUFTLEdBQUcsVUFBVSxDQUFDLE1BQU0sQ0FBQyxhQUFhLENBQUMsSUFBSSxNQUFNLENBQUMsYUFBYSxDQUFDO0lBQzNFLE1BQU0sUUFBUSxHQUFHLFVBQVUsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksTUFBTSxDQUFDLFFBQVEsQ0FBQztJQUVoRSxPQUFPLGlCQUFpQixTQUFTLE1BQU0sUUFBUSxFQUFFLENBQUM7QUFDcEQsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQWN0aXZpdHkgRmVlZCBBUEkgTGFtYmRhXG4gKlxuICogUmV0dXJucyBhIHVuaWZpZWQgYWN0aXZpdHkgZmVlZCBjb21iaW5pbmc6XG4gKiAtIEFsZXJ0cyAoZnJvbSBhbGVydHMgdGFibGUpXG4gKiAtIEhlYWx0aCBldmVudHMgKGZyb20gdGVsZW1ldHJ5IHRhYmxlKVxuICogLSBDb21tYW5kcyAoZnJvbSBjb21tYW5kcyB0YWJsZSlcbiAqIC0gSm91cm5leSBzdGFydC9lbmQgZXZlbnRzIChmcm9tIGpvdXJuZXlzIHRhYmxlKVxuICovXG5cbmltcG9ydCB7IER5bmFtb0RCQ2xpZW50IH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LWR5bmFtb2RiJztcbmltcG9ydCB7IER5bmFtb0RCRG9jdW1lbnRDbGllbnQsIFNjYW5Db21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvbGliLWR5bmFtb2RiJztcbmltcG9ydCB7IEFQSUdhdGV3YXlQcm94eUV2ZW50LCBBUElHYXRld2F5UHJveHlSZXN1bHQgfSBmcm9tICdhd3MtbGFtYmRhJztcblxuY29uc3QgZGRiQ2xpZW50ID0gbmV3IER5bmFtb0RCQ2xpZW50KHt9KTtcbmNvbnN0IGRvY0NsaWVudCA9IER5bmFtb0RCRG9jdW1lbnRDbGllbnQuZnJvbShkZGJDbGllbnQpO1xuXG5jb25zdCBURUxFTUVUUllfVEFCTEUgPSBwcm9jZXNzLmVudi5URUxFTUVUUllfVEFCTEUhO1xuY29uc3QgQUxFUlRTX1RBQkxFID0gcHJvY2Vzcy5lbnYuQUxFUlRTX1RBQkxFITtcbmNvbnN0IERFVklDRVNfVEFCTEUgPSBwcm9jZXNzLmVudi5ERVZJQ0VTX1RBQkxFITtcbmNvbnN0IENPTU1BTkRTX1RBQkxFID0gcHJvY2Vzcy5lbnYuQ09NTUFORFNfVEFCTEUhO1xuY29uc3QgSk9VUk5FWVNfVEFCTEUgPSBwcm9jZXNzLmVudi5KT1VSTkVZU19UQUJMRSE7XG5cbmludGVyZmFjZSBBY3Rpdml0eUl0ZW0ge1xuICBpZDogc3RyaW5nO1xuICB0eXBlOiAnYWxlcnQnIHwgJ2hlYWx0aCcgfCAnY29tbWFuZCcgfCAnam91cm5leScgfCAnbW9kZV9jaGFuZ2UnO1xuICBkZXZpY2VfdWlkOiBzdHJpbmc7XG4gIGRldmljZV9uYW1lPzogc3RyaW5nO1xuICBtZXNzYWdlOiBzdHJpbmc7XG4gIHRpbWVzdGFtcDogc3RyaW5nO1xuICBkYXRhPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG59XG5cbmV4cG9ydCBjb25zdCBoYW5kbGVyID0gYXN5bmMgKGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudCk6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiA9PiB7XG4gIGNvbnNvbGUubG9nKCdSZXF1ZXN0OicsIEpTT04uc3RyaW5naWZ5KGV2ZW50KSk7XG5cbiAgY29uc3QgY29yc0hlYWRlcnMgPSB7XG4gICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbic6ICcqJyxcbiAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctSGVhZGVycyc6ICdDb250ZW50LVR5cGUsQXV0aG9yaXphdGlvbicsXG4gICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHMnOiAnR0VULE9QVElPTlMnLFxuICB9O1xuXG4gIHRyeSB7XG4gICAgY29uc3QgbWV0aG9kID0gKGV2ZW50LnJlcXVlc3RDb250ZXh0IGFzIGFueSk/Lmh0dHA/Lm1ldGhvZCB8fCBldmVudC5odHRwTWV0aG9kO1xuXG4gICAgaWYgKG1ldGhvZCA9PT0gJ09QVElPTlMnKSB7XG4gICAgICByZXR1cm4geyBzdGF0dXNDb2RlOiAyMDAsIGhlYWRlcnM6IGNvcnNIZWFkZXJzLCBib2R5OiAnJyB9O1xuICAgIH1cblxuICAgIGNvbnN0IHF1ZXJ5UGFyYW1zID0gZXZlbnQucXVlcnlTdHJpbmdQYXJhbWV0ZXJzIHx8IHt9O1xuICAgIGNvbnN0IGhvdXJzID0gcGFyc2VJbnQocXVlcnlQYXJhbXMuaG91cnMgfHwgJzI0Jyk7XG4gICAgY29uc3QgbGltaXQgPSBwYXJzZUludChxdWVyeVBhcmFtcy5saW1pdCB8fCAnNTAnKTtcblxuICAgIC8vIEZldGNoIGFjdGl2aXRpZXMgZnJvbSBhbGwgc291cmNlcyBpbiBwYXJhbGxlbFxuICAgIGNvbnN0IFthbGVydHMsIGhlYWx0aEV2ZW50cywgY29tbWFuZHMsIGpvdXJuZXlzLCBtb2RlQ2hhbmdlcywgZGV2aWNlc10gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICBnZXRSZWNlbnRBbGVydHMoaG91cnMsIGxpbWl0KSxcbiAgICAgIGdldFJlY2VudEhlYWx0aEV2ZW50cyhob3VycywgbGltaXQpLFxuICAgICAgZ2V0UmVjZW50Q29tbWFuZHMoaG91cnMsIGxpbWl0KSxcbiAgICAgIGdldFJlY2VudEpvdXJuZXlzKGhvdXJzLCBsaW1pdCksXG4gICAgICBnZXRSZWNlbnRNb2RlQ2hhbmdlcyhob3VycywgbGltaXQpLFxuICAgICAgZ2V0RGV2aWNlcygpLFxuICAgIF0pO1xuXG4gICAgLy8gQ3JlYXRlIGRldmljZSBuYW1lIGxvb2t1cFxuICAgIGNvbnN0IGRldmljZU5hbWVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gICAgZm9yIChjb25zdCBkZXZpY2Ugb2YgZGV2aWNlcykge1xuICAgICAgZGV2aWNlTmFtZXNbZGV2aWNlLmRldmljZV91aWRdID0gZGV2aWNlLm5hbWUgfHwgZGV2aWNlLnNlcmlhbF9udW1iZXIgfHwgZGV2aWNlLmRldmljZV91aWQ7XG4gICAgfVxuXG4gICAgLy8gVHJhbnNmb3JtIGFsZXJ0cyB0byBhY3Rpdml0eSBpdGVtc1xuICAgIGNvbnN0IGFsZXJ0QWN0aXZpdGllczogQWN0aXZpdHlJdGVtW10gPSBhbGVydHMubWFwKChhbGVydCkgPT4gKHtcbiAgICAgIGlkOiBgYWxlcnQtJHthbGVydC5hbGVydF9pZH1gLFxuICAgICAgdHlwZTogJ2FsZXJ0JyxcbiAgICAgIGRldmljZV91aWQ6IGFsZXJ0LmRldmljZV91aWQsXG4gICAgICBkZXZpY2VfbmFtZTogZGV2aWNlTmFtZXNbYWxlcnQuZGV2aWNlX3VpZF0sXG4gICAgICBtZXNzYWdlOiBmb3JtYXRBbGVydE1lc3NhZ2UoYWxlcnQpLFxuICAgICAgdGltZXN0YW1wOiBuZXcgRGF0ZShhbGVydC5jcmVhdGVkX2F0KS50b0lTT1N0cmluZygpLFxuICAgICAgZGF0YToge1xuICAgICAgICBhbGVydF90eXBlOiBhbGVydC50eXBlLFxuICAgICAgICB2YWx1ZTogYWxlcnQudmFsdWUsXG4gICAgICAgIHRocmVzaG9sZDogYWxlcnQudGhyZXNob2xkLFxuICAgICAgICBhY2tub3dsZWRnZWQ6IGFsZXJ0LmFja25vd2xlZGdlZCxcbiAgICAgIH0sXG4gICAgfSkpO1xuXG4gICAgLy8gVHJhbnNmb3JtIGhlYWx0aCBldmVudHMgdG8gYWN0aXZpdHkgaXRlbXNcbiAgICBjb25zdCBoZWFsdGhBY3Rpdml0aWVzOiBBY3Rpdml0eUl0ZW1bXSA9IGhlYWx0aEV2ZW50cy5tYXAoKGV2ZW50KSA9PiAoe1xuICAgICAgaWQ6IGBoZWFsdGgtJHtldmVudC5kZXZpY2VfdWlkfS0ke2V2ZW50LnRpbWVzdGFtcH1gLFxuICAgICAgdHlwZTogJ2hlYWx0aCcsXG4gICAgICBkZXZpY2VfdWlkOiBldmVudC5kZXZpY2VfdWlkLFxuICAgICAgZGV2aWNlX25hbWU6IGRldmljZU5hbWVzW2V2ZW50LmRldmljZV91aWRdLFxuICAgICAgbWVzc2FnZTogZm9ybWF0SGVhbHRoTWVzc2FnZShldmVudCksXG4gICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKGV2ZW50LnRpbWVzdGFtcCkudG9JU09TdHJpbmcoKSxcbiAgICAgIGRhdGE6IHtcbiAgICAgICAgbWV0aG9kOiBldmVudC5tZXRob2QsXG4gICAgICAgIHZvbHRhZ2U6IGV2ZW50LnZvbHRhZ2UsXG4gICAgICB9LFxuICAgIH0pKTtcblxuICAgIC8vIFRyYW5zZm9ybSBjb21tYW5kcyB0byBhY3Rpdml0eSBpdGVtc1xuICAgIGNvbnN0IGNvbW1hbmRBY3Rpdml0aWVzOiBBY3Rpdml0eUl0ZW1bXSA9IGNvbW1hbmRzLm1hcCgoY21kKSA9PiAoe1xuICAgICAgaWQ6IGBjb21tYW5kLSR7Y21kLmNvbW1hbmRfaWR9YCxcbiAgICAgIHR5cGU6ICdjb21tYW5kJyxcbiAgICAgIGRldmljZV91aWQ6IGNtZC5kZXZpY2VfdWlkLFxuICAgICAgZGV2aWNlX25hbWU6IGRldmljZU5hbWVzW2NtZC5kZXZpY2VfdWlkXSxcbiAgICAgIG1lc3NhZ2U6IGZvcm1hdENvbW1hbmRNZXNzYWdlKGNtZCksXG4gICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKGNtZC5jcmVhdGVkX2F0KS50b0lTT1N0cmluZygpLFxuICAgICAgZGF0YToge1xuICAgICAgICBjbWQ6IGNtZC5jbWQsXG4gICAgICAgIHN0YXR1czogY21kLnN0YXR1cyxcbiAgICAgICAgYWNrX3N0YXR1czogY21kLmFja19zdGF0dXMsXG4gICAgICB9LFxuICAgIH0pKTtcblxuICAgIC8vIFRyYW5zZm9ybSBqb3VybmV5cyB0byBhY3Rpdml0eSBpdGVtcyAoc3RhcnQgYW5kIGVuZCBldmVudHMpXG4gICAgY29uc3Qgam91cm5leUFjdGl2aXRpZXM6IEFjdGl2aXR5SXRlbVtdID0gW107XG4gICAgZm9yIChjb25zdCBqb3VybmV5IG9mIGpvdXJuZXlzKSB7XG4gICAgICAvLyBKb3VybmV5IHN0YXJ0IGV2ZW50XG4gICAgICBqb3VybmV5QWN0aXZpdGllcy5wdXNoKHtcbiAgICAgICAgaWQ6IGBqb3VybmV5LXN0YXJ0LSR7am91cm5leS5kZXZpY2VfdWlkfS0ke2pvdXJuZXkuam91cm5leV9pZH1gLFxuICAgICAgICB0eXBlOiAnam91cm5leScsXG4gICAgICAgIGRldmljZV91aWQ6IGpvdXJuZXkuZGV2aWNlX3VpZCxcbiAgICAgICAgZGV2aWNlX25hbWU6IGRldmljZU5hbWVzW2pvdXJuZXkuZGV2aWNlX3VpZF0sXG4gICAgICAgIG1lc3NhZ2U6ICdKb3VybmV5IHN0YXJ0ZWQnLFxuICAgICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKGpvdXJuZXkuc3RhcnRfdGltZSkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgZGF0YToge1xuICAgICAgICAgIGpvdXJuZXlfaWQ6IGpvdXJuZXkuam91cm5leV9pZCxcbiAgICAgICAgICBldmVudDogJ3N0YXJ0JyxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBKb3VybmV5IGVuZCBldmVudCAob25seSBpZiBjb21wbGV0ZWQpXG4gICAgICBpZiAoam91cm5leS5zdGF0dXMgPT09ICdjb21wbGV0ZWQnICYmIGpvdXJuZXkuZW5kX3RpbWUpIHtcbiAgICAgICAgam91cm5leUFjdGl2aXRpZXMucHVzaCh7XG4gICAgICAgICAgaWQ6IGBqb3VybmV5LWVuZC0ke2pvdXJuZXkuZGV2aWNlX3VpZH0tJHtqb3VybmV5LmpvdXJuZXlfaWR9YCxcbiAgICAgICAgICB0eXBlOiAnam91cm5leScsXG4gICAgICAgICAgZGV2aWNlX3VpZDogam91cm5leS5kZXZpY2VfdWlkLFxuICAgICAgICAgIGRldmljZV9uYW1lOiBkZXZpY2VOYW1lc1tqb3VybmV5LmRldmljZV91aWRdLFxuICAgICAgICAgIG1lc3NhZ2U6IGZvcm1hdEpvdXJuZXlFbmRNZXNzYWdlKGpvdXJuZXkpLFxuICAgICAgICAgIHRpbWVzdGFtcDogbmV3IERhdGUoam91cm5leS5lbmRfdGltZSkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgICBkYXRhOiB7XG4gICAgICAgICAgICBqb3VybmV5X2lkOiBqb3VybmV5LmpvdXJuZXlfaWQsXG4gICAgICAgICAgICBldmVudDogJ2VuZCcsXG4gICAgICAgICAgICBwb2ludF9jb3VudDogam91cm5leS5wb2ludF9jb3VudCxcbiAgICAgICAgICAgIHRvdGFsX2Rpc3RhbmNlOiBqb3VybmV5LnRvdGFsX2Rpc3RhbmNlLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFRyYW5zZm9ybSBtb2RlIGNoYW5nZXMgdG8gYWN0aXZpdHkgaXRlbXNcbiAgICBjb25zdCBtb2RlQ2hhbmdlQWN0aXZpdGllczogQWN0aXZpdHlJdGVtW10gPSBtb2RlQ2hhbmdlcy5tYXAoKGNoYW5nZSkgPT4gKHtcbiAgICAgIGlkOiBgbW9kZS0ke2NoYW5nZS5kZXZpY2VfdWlkfS0ke2NoYW5nZS50aW1lc3RhbXB9YCxcbiAgICAgIHR5cGU6ICdtb2RlX2NoYW5nZScsXG4gICAgICBkZXZpY2VfdWlkOiBjaGFuZ2UuZGV2aWNlX3VpZCxcbiAgICAgIGRldmljZV9uYW1lOiBkZXZpY2VOYW1lc1tjaGFuZ2UuZGV2aWNlX3VpZF0sXG4gICAgICBtZXNzYWdlOiBmb3JtYXRNb2RlQ2hhbmdlTWVzc2FnZShjaGFuZ2UpLFxuICAgICAgdGltZXN0YW1wOiBuZXcgRGF0ZShjaGFuZ2UudGltZXN0YW1wKS50b0lTT1N0cmluZygpLFxuICAgICAgZGF0YToge1xuICAgICAgICBwcmV2aW91c19tb2RlOiBjaGFuZ2UucHJldmlvdXNfbW9kZSxcbiAgICAgICAgbmV3X21vZGU6IGNoYW5nZS5uZXdfbW9kZSxcbiAgICAgIH0sXG4gICAgfSkpO1xuXG4gICAgLy8gTWVyZ2UgYWxsIGFjdGl2aXRpZXMgYW5kIHNvcnQgYnkgdGltZXN0YW1wIChuZXdlc3QgZmlyc3QpXG4gICAgY29uc3QgYWxsQWN0aXZpdGllcyA9IFsuLi5hbGVydEFjdGl2aXRpZXMsIC4uLmhlYWx0aEFjdGl2aXRpZXMsIC4uLmNvbW1hbmRBY3Rpdml0aWVzLCAuLi5qb3VybmV5QWN0aXZpdGllcywgLi4ubW9kZUNoYW5nZUFjdGl2aXRpZXNdXG4gICAgICAuc29ydCgoYSwgYikgPT4gbmV3IERhdGUoYi50aW1lc3RhbXApLmdldFRpbWUoKSAtIG5ldyBEYXRlKGEudGltZXN0YW1wKS5nZXRUaW1lKCkpXG4gICAgICAuc2xpY2UoMCwgbGltaXQpO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgIGhlYWRlcnM6IGNvcnNIZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBob3VycyxcbiAgICAgICAgY291bnQ6IGFsbEFjdGl2aXRpZXMubGVuZ3RoLFxuICAgICAgICBhY3Rpdml0aWVzOiBhbGxBY3Rpdml0aWVzLFxuICAgICAgfSksXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvcjonLCBlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMCxcbiAgICAgIGhlYWRlcnM6IGNvcnNIZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0ludGVybmFsIHNlcnZlciBlcnJvcicgfSksXG4gICAgfTtcbiAgfVxufTtcblxuYXN5bmMgZnVuY3Rpb24gZ2V0UmVjZW50QWxlcnRzKGhvdXJzOiBudW1iZXIsIGxpbWl0OiBudW1iZXIpOiBQcm9taXNlPGFueVtdPiB7XG4gIGNvbnN0IGN1dG9mZlRpbWUgPSBEYXRlLm5vdygpIC0gaG91cnMgKiA2MCAqIDYwICogMTAwMDtcbiAgY29uc3QgYWxsSXRlbXM6IGFueVtdID0gW107XG4gIGxldCBsYXN0RXZhbHVhdGVkS2V5OiBSZWNvcmQ8c3RyaW5nLCBhbnk+IHwgdW5kZWZpbmVkO1xuXG4gIC8vIFBhZ2luYXRlIHRocm91Z2ggYWxsIHJlc3VsdHNcbiAgZG8ge1xuICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgU2NhbkNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBBTEVSVFNfVEFCTEUsXG4gICAgICBGaWx0ZXJFeHByZXNzaW9uOiAnY3JlYXRlZF9hdCA+IDpjdXRvZmYnLFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAnOmN1dG9mZic6IGN1dG9mZlRpbWUsXG4gICAgICB9LFxuICAgICAgRXhjbHVzaXZlU3RhcnRLZXk6IGxhc3RFdmFsdWF0ZWRLZXksXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgICBhbGxJdGVtcy5wdXNoKC4uLihyZXN1bHQuSXRlbXMgfHwgW10pKTtcbiAgICBsYXN0RXZhbHVhdGVkS2V5ID0gcmVzdWx0Lkxhc3RFdmFsdWF0ZWRLZXk7XG5cbiAgICAvLyBTdG9wIGVhcmx5IGlmIHdlIGhhdmUgZW5vdWdoIGl0ZW1zXG4gICAgaWYgKGFsbEl0ZW1zLmxlbmd0aCA+PSBsaW1pdCAqIDIpIGJyZWFrO1xuICB9IHdoaWxlIChsYXN0RXZhbHVhdGVkS2V5KTtcblxuICByZXR1cm4gYWxsSXRlbXMuc2xpY2UoMCwgbGltaXQgKiAyKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0UmVjZW50SGVhbHRoRXZlbnRzKGhvdXJzOiBudW1iZXIsIGxpbWl0OiBudW1iZXIpOiBQcm9taXNlPGFueVtdPiB7XG4gIGNvbnN0IGN1dG9mZlRpbWUgPSBEYXRlLm5vdygpIC0gaG91cnMgKiA2MCAqIDYwICogMTAwMDtcbiAgY29uc3QgYWxsSXRlbXM6IGFueVtdID0gW107XG4gIGxldCBsYXN0RXZhbHVhdGVkS2V5OiBSZWNvcmQ8c3RyaW5nLCBhbnk+IHwgdW5kZWZpbmVkO1xuXG4gIC8vIFBhZ2luYXRlIHRocm91Z2ggYWxsIHJlc3VsdHNcbiAgZG8ge1xuICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgU2NhbkNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBURUxFTUVUUllfVEFCTEUsXG4gICAgICBGaWx0ZXJFeHByZXNzaW9uOiAnI3RzID4gOmN1dG9mZiBBTkQgZGF0YV90eXBlID0gOmRhdGFfdHlwZScsXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICAgJyN0cyc6ICd0aW1lc3RhbXAnLFxuICAgICAgfSxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgJzpjdXRvZmYnOiBjdXRvZmZUaW1lLFxuICAgICAgICAnOmRhdGFfdHlwZSc6ICdoZWFsdGgnLFxuICAgICAgfSxcbiAgICAgIEV4Y2x1c2l2ZVN0YXJ0S2V5OiBsYXN0RXZhbHVhdGVkS2V5LFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gICAgYWxsSXRlbXMucHVzaCguLi4ocmVzdWx0Lkl0ZW1zIHx8IFtdKSk7XG4gICAgbGFzdEV2YWx1YXRlZEtleSA9IHJlc3VsdC5MYXN0RXZhbHVhdGVkS2V5O1xuXG4gICAgLy8gU3RvcCBlYXJseSBpZiB3ZSBoYXZlIGVub3VnaCBpdGVtc1xuICAgIGlmIChhbGxJdGVtcy5sZW5ndGggPj0gbGltaXQgKiAyKSBicmVhaztcbiAgfSB3aGlsZSAobGFzdEV2YWx1YXRlZEtleSk7XG5cbiAgcmV0dXJuIGFsbEl0ZW1zLnNsaWNlKDAsIGxpbWl0ICogMik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldFJlY2VudENvbW1hbmRzKGhvdXJzOiBudW1iZXIsIGxpbWl0OiBudW1iZXIpOiBQcm9taXNlPGFueVtdPiB7XG4gIGNvbnN0IGN1dG9mZlRpbWUgPSBEYXRlLm5vdygpIC0gaG91cnMgKiA2MCAqIDYwICogMTAwMDtcbiAgY29uc3QgYWxsSXRlbXM6IGFueVtdID0gW107XG4gIGxldCBsYXN0RXZhbHVhdGVkS2V5OiBSZWNvcmQ8c3RyaW5nLCBhbnk+IHwgdW5kZWZpbmVkO1xuXG4gIGRvIHtcbiAgICBjb25zdCBjb21tYW5kID0gbmV3IFNjYW5Db21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogQ09NTUFORFNfVEFCTEUsXG4gICAgICBGaWx0ZXJFeHByZXNzaW9uOiAnY3JlYXRlZF9hdCA+IDpjdXRvZmYnLFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAnOmN1dG9mZic6IGN1dG9mZlRpbWUsXG4gICAgICB9LFxuICAgICAgRXhjbHVzaXZlU3RhcnRLZXk6IGxhc3RFdmFsdWF0ZWRLZXksXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgICBhbGxJdGVtcy5wdXNoKC4uLihyZXN1bHQuSXRlbXMgfHwgW10pKTtcbiAgICBsYXN0RXZhbHVhdGVkS2V5ID0gcmVzdWx0Lkxhc3RFdmFsdWF0ZWRLZXk7XG5cbiAgICBpZiAoYWxsSXRlbXMubGVuZ3RoID49IGxpbWl0ICogMikgYnJlYWs7XG4gIH0gd2hpbGUgKGxhc3RFdmFsdWF0ZWRLZXkpO1xuXG4gIHJldHVybiBhbGxJdGVtcy5zbGljZSgwLCBsaW1pdCAqIDIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRSZWNlbnRKb3VybmV5cyhob3VyczogbnVtYmVyLCBsaW1pdDogbnVtYmVyKTogUHJvbWlzZTxhbnlbXT4ge1xuICBjb25zdCBjdXRvZmZUaW1lID0gRGF0ZS5ub3coKSAtIGhvdXJzICogNjAgKiA2MCAqIDEwMDA7XG4gIGNvbnN0IGFsbEl0ZW1zOiBhbnlbXSA9IFtdO1xuICBsZXQgbGFzdEV2YWx1YXRlZEtleTogUmVjb3JkPHN0cmluZywgYW55PiB8IHVuZGVmaW5lZDtcblxuICBkbyB7XG4gICAgY29uc3QgY29tbWFuZCA9IG5ldyBTY2FuQ29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IEpPVVJORVlTX1RBQkxFLFxuICAgICAgRmlsdGVyRXhwcmVzc2lvbjogJ3N0YXJ0X3RpbWUgPiA6Y3V0b2ZmJyxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgJzpjdXRvZmYnOiBjdXRvZmZUaW1lLFxuICAgICAgfSxcbiAgICAgIEV4Y2x1c2l2ZVN0YXJ0S2V5OiBsYXN0RXZhbHVhdGVkS2V5LFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gICAgYWxsSXRlbXMucHVzaCguLi4ocmVzdWx0Lkl0ZW1zIHx8IFtdKSk7XG4gICAgbGFzdEV2YWx1YXRlZEtleSA9IHJlc3VsdC5MYXN0RXZhbHVhdGVkS2V5O1xuXG4gICAgaWYgKGFsbEl0ZW1zLmxlbmd0aCA+PSBsaW1pdCAqIDIpIGJyZWFrO1xuICB9IHdoaWxlIChsYXN0RXZhbHVhdGVkS2V5KTtcblxuICByZXR1cm4gYWxsSXRlbXMuc2xpY2UoMCwgbGltaXQgKiAyKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0RGV2aWNlcygpOiBQcm9taXNlPGFueVtdPiB7XG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgU2NhbkNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICBQcm9qZWN0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQsICNuYW1lLCBzZXJpYWxfbnVtYmVyJyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICcjbmFtZSc6ICduYW1lJyxcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgcmV0dXJuIHJlc3VsdC5JdGVtcyB8fCBbXTtcbn1cblxuZnVuY3Rpb24gZm9ybWF0QWxlcnRNZXNzYWdlKGFsZXJ0OiBhbnkpOiBzdHJpbmcge1xuICBjb25zdCBhbGVydExhYmVsczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICB0ZW1wX2hpZ2g6ICdIaWdoIHRlbXBlcmF0dXJlIGFsZXJ0JyxcbiAgICB0ZW1wX2xvdzogJ0xvdyB0ZW1wZXJhdHVyZSBhbGVydCcsXG4gICAgaHVtaWRpdHlfaGlnaDogJ0hpZ2ggaHVtaWRpdHkgYWxlcnQnLFxuICAgIGh1bWlkaXR5X2xvdzogJ0xvdyBodW1pZGl0eSBhbGVydCcsXG4gICAgcHJlc3N1cmVfY2hhbmdlOiAnUHJlc3N1cmUgY2hhbmdlIGFsZXJ0JyxcbiAgICBsb3dfYmF0dGVyeTogJ0xvdyBiYXR0ZXJ5IGFsZXJ0JyxcbiAgICBtb3Rpb246ICdNb3Rpb24gZGV0ZWN0ZWQnLFxuICB9O1xuXG4gIGNvbnN0IGxhYmVsID0gYWxlcnRMYWJlbHNbYWxlcnQudHlwZV0gfHwgYWxlcnQudHlwZTtcbiAgaWYgKGFsZXJ0LnZhbHVlICE9PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gYCR7bGFiZWx9OiAke2FsZXJ0LnZhbHVlLnRvRml4ZWQoMSl9YDtcbiAgfVxuICByZXR1cm4gbGFiZWw7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdEhlYWx0aE1lc3NhZ2UoZXZlbnQ6IGFueSk6IHN0cmluZyB7XG4gIGNvbnN0IG1ldGhvZExhYmVsczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICBkZnU6ICdGaXJtd2FyZSB1cGRhdGUnLFxuICAgIGJvb3Q6ICdEZXZpY2UgYm9vdGVkJyxcbiAgICByZWJvb3Q6ICdEZXZpY2UgcmVib290ZWQnLFxuICAgIHJlc2V0OiAnRGV2aWNlIHJlc2V0JyxcbiAgICB1c2I6ICdVU0IgY29ubmVjdGVkJyxcbiAgICBiYXR0ZXJ5OiAnQmF0dGVyeSBzdGF0dXMgdXBkYXRlJyxcbiAgICBzeW5jOiAnU3luYyBjb21wbGV0ZWQnLFxuICAgIGNvbm5lY3RlZDogJ0Nvbm5lY3RlZCB0byBuZXR3b3JrJyxcbiAgICBkaXNjb25uZWN0ZWQ6ICdEaXNjb25uZWN0ZWQgZnJvbSBuZXR3b3JrJyxcbiAgfTtcblxuICBjb25zdCBsYWJlbCA9IG1ldGhvZExhYmVsc1tldmVudC5tZXRob2RdIHx8IGV2ZW50Lm1ldGhvZCB8fCAnSGVhbHRoIGV2ZW50JztcbiAgaWYgKGV2ZW50LnRleHQpIHtcbiAgICByZXR1cm4gYCR7bGFiZWx9OiAke2V2ZW50LnRleHR9YDtcbiAgfVxuICByZXR1cm4gbGFiZWw7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdENvbW1hbmRNZXNzYWdlKGNtZDogYW55KTogc3RyaW5nIHtcbiAgY29uc3QgY21kTGFiZWxzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgIHBpbmc6ICdQaW5nIGNvbW1hbmQnLFxuICAgIGxvY2F0ZTogJ0xvY2F0ZSBjb21tYW5kJyxcbiAgICBwbGF5X21lbG9keTogJ1BsYXkgbWVsb2R5IGNvbW1hbmQnLFxuICAgIHRlc3RfYXVkaW86ICdUZXN0IGF1ZGlvIGNvbW1hbmQnLFxuICAgIHNldF92b2x1bWU6ICdTZXQgdm9sdW1lIGNvbW1hbmQnLFxuICB9O1xuXG4gIGNvbnN0IGxhYmVsID0gY21kTGFiZWxzW2NtZC5jbWRdIHx8IGNtZC5jbWQgfHwgJ0NvbW1hbmQnO1xuICBjb25zdCBzdGF0dXNMYWJlbHM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgcXVldWVkOiAncXVldWVkJyxcbiAgICBzZW50OiAnc2VudCcsXG4gICAgb2s6ICdhY2tub3dsZWRnZWQnLFxuICAgIGVycm9yOiAnZmFpbGVkJyxcbiAgICBpZ25vcmVkOiAnaWdub3JlZCcsXG4gIH07XG5cbiAgY29uc3Qgc3RhdHVzID0gc3RhdHVzTGFiZWxzW2NtZC5hY2tfc3RhdHVzIHx8IGNtZC5zdGF0dXNdIHx8IGNtZC5zdGF0dXM7XG4gIHJldHVybiBgJHtsYWJlbH0gJHtzdGF0dXN9YDtcbn1cblxuZnVuY3Rpb24gZm9ybWF0Sm91cm5leUVuZE1lc3NhZ2Uoam91cm5leTogYW55KTogc3RyaW5nIHtcbiAgY29uc3QgZGlzdGFuY2UgPSBqb3VybmV5LnRvdGFsX2Rpc3RhbmNlIHx8IDA7XG4gIGNvbnN0IHBvaW50cyA9IGpvdXJuZXkucG9pbnRfY291bnQgfHwgMDtcblxuICAvLyBGb3JtYXQgZGlzdGFuY2UgaW4ga20gb3IgbVxuICBsZXQgZGlzdGFuY2VTdHI6IHN0cmluZztcbiAgaWYgKGRpc3RhbmNlID49IDEwMDApIHtcbiAgICBkaXN0YW5jZVN0ciA9IGAkeyhkaXN0YW5jZSAvIDEwMDApLnRvRml4ZWQoMSl9IGttYDtcbiAgfSBlbHNlIHtcbiAgICBkaXN0YW5jZVN0ciA9IGAke01hdGgucm91bmQoZGlzdGFuY2UpfSBtYDtcbiAgfVxuXG4gIHJldHVybiBgSm91cm5leSBlbmRlZDogJHtkaXN0YW5jZVN0cn0sICR7cG9pbnRzfSBwb2ludHNgO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRSZWNlbnRNb2RlQ2hhbmdlcyhob3VyczogbnVtYmVyLCBsaW1pdDogbnVtYmVyKTogUHJvbWlzZTxhbnlbXT4ge1xuICBjb25zdCBjdXRvZmZUaW1lID0gRGF0ZS5ub3coKSAtIGhvdXJzICogNjAgKiA2MCAqIDEwMDA7XG4gIGNvbnN0IGFsbEl0ZW1zOiBhbnlbXSA9IFtdO1xuICBsZXQgbGFzdEV2YWx1YXRlZEtleTogUmVjb3JkPHN0cmluZywgYW55PiB8IHVuZGVmaW5lZDtcblxuICBkbyB7XG4gICAgY29uc3QgY29tbWFuZCA9IG5ldyBTY2FuQ29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IFRFTEVNRVRSWV9UQUJMRSxcbiAgICAgIEZpbHRlckV4cHJlc3Npb246ICcjdHMgPiA6Y3V0b2ZmIEFORCBkYXRhX3R5cGUgPSA6ZGF0YV90eXBlJyxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczoge1xuICAgICAgICAnI3RzJzogJ3RpbWVzdGFtcCcsXG4gICAgICB9LFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAnOmN1dG9mZic6IGN1dG9mZlRpbWUsXG4gICAgICAgICc6ZGF0YV90eXBlJzogJ21vZGVfY2hhbmdlJyxcbiAgICAgIH0sXG4gICAgICBFeGNsdXNpdmVTdGFydEtleTogbGFzdEV2YWx1YXRlZEtleSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICAgIGFsbEl0ZW1zLnB1c2goLi4uKHJlc3VsdC5JdGVtcyB8fCBbXSkpO1xuICAgIGxhc3RFdmFsdWF0ZWRLZXkgPSByZXN1bHQuTGFzdEV2YWx1YXRlZEtleTtcblxuICAgIGlmIChhbGxJdGVtcy5sZW5ndGggPj0gbGltaXQgKiAyKSBicmVhaztcbiAgfSB3aGlsZSAobGFzdEV2YWx1YXRlZEtleSk7XG5cbiAgcmV0dXJuIGFsbEl0ZW1zLnNsaWNlKDAsIGxpbWl0ICogMik7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdE1vZGVDaGFuZ2VNZXNzYWdlKGNoYW5nZTogYW55KTogc3RyaW5nIHtcbiAgY29uc3QgbW9kZUxhYmVsczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICBkZW1vOiAnRGVtbycsXG4gICAgdHJhbnNpdDogJ1RyYW5zaXQnLFxuICAgIHN0b3JhZ2U6ICdTdG9yYWdlJyxcbiAgICBzbGVlcDogJ1NsZWVwJyxcbiAgfTtcblxuICBjb25zdCBwcmV2TGFiZWwgPSBtb2RlTGFiZWxzW2NoYW5nZS5wcmV2aW91c19tb2RlXSB8fCBjaGFuZ2UucHJldmlvdXNfbW9kZTtcbiAgY29uc3QgbmV3TGFiZWwgPSBtb2RlTGFiZWxzW2NoYW5nZS5uZXdfbW9kZV0gfHwgY2hhbmdlLm5ld19tb2RlO1xuXG4gIHJldHVybiBgTW9kZSBjaGFuZ2VkOiAke3ByZXZMYWJlbH0g4oaSICR7bmV3TGFiZWx9YDtcbn1cbiJdfQ==