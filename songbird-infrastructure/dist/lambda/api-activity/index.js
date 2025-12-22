"use strict";
/**
 * Activity Feed API Lambda
 *
 * Returns a unified activity feed combining:
 * - Alerts (from alerts table)
 * - Health events (from telemetry table)
 * - Location updates (from telemetry table)
 * - Device status changes (derived from device last_seen)
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
        const [alerts, healthEvents, locationEvents, devices] = await Promise.all([
            getRecentAlerts(hours, limit),
            getRecentHealthEvents(hours, limit),
            getRecentLocationEvents(hours, limit),
            getDevices(),
        ]);
        // Filter location events to only show significant changes
        const significantLocationEvents = filterSignificantLocationChanges(locationEvents);
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
        // Transform location events to activity items (only significant changes)
        const locationActivities = significantLocationEvents.map((event) => ({
            id: `location-${event.device_uid}-${event.timestamp}`,
            type: 'location',
            device_uid: event.device_uid,
            device_name: deviceNames[event.device_uid],
            message: formatLocationMessage(event, deviceNames[event.device_uid]),
            timestamp: new Date(event.timestamp).toISOString(),
            data: {
                lat: event.latitude,
                lon: event.longitude,
                source: event.location_source,
            },
        }));
        // Merge all activities and sort by timestamp (newest first)
        const allActivities = [...alertActivities, ...healthActivities, ...locationActivities]
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
async function getRecentLocationEvents(hours, limit) {
    const cutoffTime = Date.now() - hours * 60 * 60 * 1000;
    const allItems = [];
    let lastEvaluatedKey;
    // Paginate through ALL results - DynamoDB Scan doesn't return items in order,
    // so we must scan everything to ensure we get the most recent events
    do {
        const command = new lib_dynamodb_1.ScanCommand({
            TableName: TELEMETRY_TABLE,
            FilterExpression: '#ts > :cutoff AND event_type = :event_type',
            ExpressionAttributeNames: {
                '#ts': 'timestamp',
            },
            ExpressionAttributeValues: {
                ':cutoff': cutoffTime,
                ':event_type': '_geolocate.qo',
            },
            ExclusiveStartKey: lastEvaluatedKey,
        });
        const result = await docClient.send(command);
        allItems.push(...(result.Items || []));
        lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);
    // Sort by timestamp descending and return the most recent items
    return allItems
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit * 2);
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
function formatLocationMessage(event, deviceName) {
    const sourceLabels = {
        gps: 'GPS location',
        triangulation: 'Triangulated location',
        cell: 'Cell tower location',
        tower: 'Cell tower location',
        wifi: 'Wi-Fi location',
    };
    const sourceLabel = sourceLabels[event.location_source] || 'Location update';
    return `${sourceLabel} received`;
}
/**
 * Calculate distance between two lat/lon points using Haversine formula
 * Returns distance in meters
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth's radius in meters
    const toRad = (deg) => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}
/**
 * Filter location events to only include meaningful changes per device.
 * A location is considered "changed" if:
 * - It's the first event for that device
 * - The location source changed
 * - The distance moved is > 100 meters
 *
 * Always includes the most recent event per device so users see current status.
 */
function filterSignificantLocationChanges(events) {
    // Sort by device_uid, then timestamp ascending (oldest first)
    const sorted = [...events].sort((a, b) => {
        if (a.device_uid !== b.device_uid) {
            return a.device_uid.localeCompare(b.device_uid);
        }
        return a.timestamp - b.timestamp;
    });
    const significantEvents = [];
    const lastSignificantByDevice = {};
    const mostRecentByDevice = {};
    for (const event of sorted) {
        const deviceUid = event.device_uid;
        // Track the most recent event for each device
        mostRecentByDevice[deviceUid] = event;
        const lastSignificant = lastSignificantByDevice[deviceUid];
        if (!lastSignificant) {
            // First event for this device
            significantEvents.push(event);
            lastSignificantByDevice[deviceUid] = event;
            continue;
        }
        // Check if location source changed
        if (event.location_source !== lastSignificant.location_source) {
            significantEvents.push(event);
            lastSignificantByDevice[deviceUid] = event;
            continue;
        }
        // Check if moved more than 100 meters
        const distance = haversineDistance(lastSignificant.latitude, lastSignificant.longitude, event.latitude, event.longitude);
        if (distance > 100) {
            significantEvents.push(event);
            lastSignificantByDevice[deviceUid] = event;
        }
    }
    // Ensure the most recent event for each device is included
    for (const deviceUid of Object.keys(mostRecentByDevice)) {
        const mostRecent = mostRecentByDevice[deviceUid];
        const alreadyIncluded = significantEvents.some((e) => e.device_uid === deviceUid && e.timestamp === mostRecent.timestamp);
        if (!alreadyIncluded) {
            significantEvents.push(mostRecent);
        }
    }
    return significantEvents;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWFjdGl2aXR5L2luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7R0FRRzs7O0FBRUgsOERBQTBEO0FBQzFELHdEQUEwRjtBQUcxRixNQUFNLFNBQVMsR0FBRyxJQUFJLGdDQUFjLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDekMsTUFBTSxTQUFTLEdBQUcscUNBQXNCLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBRXpELE1BQU0sZUFBZSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsZUFBZ0IsQ0FBQztBQUNyRCxNQUFNLFlBQVksR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLFlBQWEsQ0FBQztBQUMvQyxNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGFBQWMsQ0FBQztBQVkxQyxNQUFNLE9BQU8sR0FBRyxLQUFLLEVBQUUsS0FBMkIsRUFBa0MsRUFBRTtJQUMzRixPQUFPLENBQUMsR0FBRyxDQUFDLFVBQVUsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFFL0MsTUFBTSxXQUFXLEdBQUc7UUFDbEIsNkJBQTZCLEVBQUUsR0FBRztRQUNsQyw4QkFBOEIsRUFBRSw0QkFBNEI7UUFDNUQsOEJBQThCLEVBQUUsYUFBYTtLQUM5QyxDQUFDO0lBRUYsSUFBSSxDQUFDO1FBQ0gsTUFBTSxNQUFNLEdBQUksS0FBSyxDQUFDLGNBQXNCLEVBQUUsSUFBSSxFQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsVUFBVSxDQUFDO1FBRS9FLElBQUksTUFBTSxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQ3pCLE9BQU8sRUFBRSxVQUFVLEVBQUUsR0FBRyxFQUFFLE9BQU8sRUFBRSxXQUFXLEVBQUUsSUFBSSxFQUFFLEVBQUUsRUFBRSxDQUFDO1FBQzdELENBQUM7UUFFRCxNQUFNLFdBQVcsR0FB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SyxVQUFVLENBQUMsU0FBUyxDQUMxRSxDQUFDO1FBQ0YsSUFBSSxDQUFDLGVBQWUsRUFBRSxDQUFDO1lBQ3JCLGlCQUFpQixDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUNyQyxDQUFDO0lBQ0gsQ0FBQztJQUVELE9BQU8saUJBQWlCLENBQUM7QUFDM0IsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQWN0aXZpdHkgRmVlZCBBUEkgTGFtYmRhXG4gKlxuICogUmV0dXJucyBhIHVuaWZpZWQgYWN0aXZpdHkgZmVlZCBjb21iaW5pbmc6XG4gKiAtIEFsZXJ0cyAoZnJvbSBhbGVydHMgdGFibGUpXG4gKiAtIEhlYWx0aCBldmVudHMgKGZyb20gdGVsZW1ldHJ5IHRhYmxlKVxuICogLSBMb2NhdGlvbiB1cGRhdGVzIChmcm9tIHRlbGVtZXRyeSB0YWJsZSlcbiAqIC0gRGV2aWNlIHN0YXR1cyBjaGFuZ2VzIChkZXJpdmVkIGZyb20gZGV2aWNlIGxhc3Rfc2VlbilcbiAqL1xuXG5pbXBvcnQgeyBEeW5hbW9EQkNsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYic7XG5pbXBvcnQgeyBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LCBRdWVyeUNvbW1hbmQsIFNjYW5Db21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvbGliLWR5bmFtb2RiJztcbmltcG9ydCB7IEFQSUdhdGV3YXlQcm94eUV2ZW50LCBBUElHYXRld2F5UHJveHlSZXN1bHQgfSBmcm9tICdhd3MtbGFtYmRhJztcblxuY29uc3QgZGRiQ2xpZW50ID0gbmV3IER5bmFtb0RCQ2xpZW50KHt9KTtcbmNvbnN0IGRvY0NsaWVudCA9IER5bmFtb0RCRG9jdW1lbnRDbGllbnQuZnJvbShkZGJDbGllbnQpO1xuXG5jb25zdCBURUxFTUVUUllfVEFCTEUgPSBwcm9jZXNzLmVudi5URUxFTUVUUllfVEFCTEUhO1xuY29uc3QgQUxFUlRTX1RBQkxFID0gcHJvY2Vzcy5lbnYuQUxFUlRTX1RBQkxFITtcbmNvbnN0IERFVklDRVNfVEFCTEUgPSBwcm9jZXNzLmVudi5ERVZJQ0VTX1RBQkxFITtcblxuaW50ZXJmYWNlIEFjdGl2aXR5SXRlbSB7XG4gIGlkOiBzdHJpbmc7XG4gIHR5cGU6ICdhbGVydCcgfCAnaGVhbHRoJyB8ICdsb2NhdGlvbicgfCAnc3RhdHVzJztcbiAgZGV2aWNlX3VpZDogc3RyaW5nO1xuICBkZXZpY2VfbmFtZT86IHN0cmluZztcbiAgbWVzc2FnZTogc3RyaW5nO1xuICB0aW1lc3RhbXA6IHN0cmluZztcbiAgZGF0YT86IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xufVxuXG5leHBvcnQgY29uc3QgaGFuZGxlciA9IGFzeW5jIChldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQpOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4gPT4ge1xuICBjb25zb2xlLmxvZygnUmVxdWVzdDonLCBKU09OLnN0cmluZ2lmeShldmVudCkpO1xuXG4gIGNvbnN0IGNvcnNIZWFkZXJzID0ge1xuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nOiAnKicsXG4gICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnMnOiAnQ29udGVudC1UeXBlLEF1dGhvcml6YXRpb24nLFxuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzJzogJ0dFVCxPUFRJT05TJyxcbiAgfTtcblxuICB0cnkge1xuICAgIGNvbnN0IG1ldGhvZCA9IChldmVudC5yZXF1ZXN0Q29udGV4dCBhcyBhbnkpPy5odHRwPy5tZXRob2QgfHwgZXZlbnQuaHR0cE1ldGhvZDtcblxuICAgIGlmIChtZXRob2QgPT09ICdPUFRJT05TJykge1xuICAgICAgcmV0dXJuIHsgc3RhdHVzQ29kZTogMjAwLCBoZWFkZXJzOiBjb3JzSGVhZGVycywgYm9keTogJycgfTtcbiAgICB9XG5cbiAgICBjb25zdCBxdWVyeVBhcmFtcyA9IGV2ZW50LnF1ZXJ5U3RyaW5nUGFyYW1ldGVycyB8fCB7fTtcbiAgICBjb25zdCBob3VycyA9IHBhcnNlSW50KHF1ZXJ5UGFyYW1zLmhvdXJzIHx8ICcyNCcpO1xuICAgIGNvbnN0IGxpbWl0ID0gcGFyc2VJbnQocXVlcnlQYXJhbXMubGltaXQgfHwgJzUwJyk7XG5cbiAgICAvLyBGZXRjaCBhY3Rpdml0aWVzIGZyb20gYWxsIHNvdXJjZXMgaW4gcGFyYWxsZWxcbiAgICBjb25zdCBbYWxlcnRzLCBoZWFsdGhFdmVudHMsIGxvY2F0aW9uRXZlbnRzLCBkZXZpY2VzXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgIGdldFJlY2VudEFsZXJ0cyhob3VycywgbGltaXQpLFxuICAgICAgZ2V0UmVjZW50SGVhbHRoRXZlbnRzKGhvdXJzLCBsaW1pdCksXG4gICAgICBnZXRSZWNlbnRMb2NhdGlvbkV2ZW50cyhob3VycywgbGltaXQpLFxuICAgICAgZ2V0RGV2aWNlcygpLFxuICAgIF0pO1xuXG4gICAgLy8gRmlsdGVyIGxvY2F0aW9uIGV2ZW50cyB0byBvbmx5IHNob3cgc2lnbmlmaWNhbnQgY2hhbmdlc1xuICAgIGNvbnN0IHNpZ25pZmljYW50TG9jYXRpb25FdmVudHMgPSBmaWx0ZXJTaWduaWZpY2FudExvY2F0aW9uQ2hhbmdlcyhsb2NhdGlvbkV2ZW50cyk7XG5cblxuICAgIC8vIENyZWF0ZSBkZXZpY2UgbmFtZSBsb29rdXBcbiAgICBjb25zdCBkZXZpY2VOYW1lczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgIGZvciAoY29uc3QgZGV2aWNlIG9mIGRldmljZXMpIHtcbiAgICAgIGRldmljZU5hbWVzW2RldmljZS5kZXZpY2VfdWlkXSA9IGRldmljZS5uYW1lIHx8IGRldmljZS5zZXJpYWxfbnVtYmVyIHx8IGRldmljZS5kZXZpY2VfdWlkO1xuICAgIH1cblxuICAgIC8vIFRyYW5zZm9ybSBhbGVydHMgdG8gYWN0aXZpdHkgaXRlbXNcbiAgICBjb25zdCBhbGVydEFjdGl2aXRpZXM6IEFjdGl2aXR5SXRlbVtdID0gYWxlcnRzLm1hcCgoYWxlcnQpID0+ICh7XG4gICAgICBpZDogYGFsZXJ0LSR7YWxlcnQuYWxlcnRfaWR9YCxcbiAgICAgIHR5cGU6ICdhbGVydCcsXG4gICAgICBkZXZpY2VfdWlkOiBhbGVydC5kZXZpY2VfdWlkLFxuICAgICAgZGV2aWNlX25hbWU6IGRldmljZU5hbWVzW2FsZXJ0LmRldmljZV91aWRdLFxuICAgICAgbWVzc2FnZTogZm9ybWF0QWxlcnRNZXNzYWdlKGFsZXJ0KSxcbiAgICAgIHRpbWVzdGFtcDogbmV3IERhdGUoYWxlcnQuY3JlYXRlZF9hdCkudG9JU09TdHJpbmcoKSxcbiAgICAgIGRhdGE6IHtcbiAgICAgICAgYWxlcnRfdHlwZTogYWxlcnQudHlwZSxcbiAgICAgICAgdmFsdWU6IGFsZXJ0LnZhbHVlLFxuICAgICAgICB0aHJlc2hvbGQ6IGFsZXJ0LnRocmVzaG9sZCxcbiAgICAgICAgYWNrbm93bGVkZ2VkOiBhbGVydC5hY2tub3dsZWRnZWQsXG4gICAgICB9LFxuICAgIH0pKTtcblxuICAgIC8vIFRyYW5zZm9ybSBoZWFsdGggZXZlbnRzIHRvIGFjdGl2aXR5IGl0ZW1zXG4gICAgY29uc3QgaGVhbHRoQWN0aXZpdGllczogQWN0aXZpdHlJdGVtW10gPSBoZWFsdGhFdmVudHMubWFwKChldmVudCkgPT4gKHtcbiAgICAgIGlkOiBgaGVhbHRoLSR7ZXZlbnQuZGV2aWNlX3VpZH0tJHtldmVudC50aW1lc3RhbXB9YCxcbiAgICAgIHR5cGU6ICdoZWFsdGgnLFxuICAgICAgZGV2aWNlX3VpZDogZXZlbnQuZGV2aWNlX3VpZCxcbiAgICAgIGRldmljZV9uYW1lOiBkZXZpY2VOYW1lc1tldmVudC5kZXZpY2VfdWlkXSxcbiAgICAgIG1lc3NhZ2U6IGZvcm1hdEhlYWx0aE1lc3NhZ2UoZXZlbnQpLFxuICAgICAgdGltZXN0YW1wOiBuZXcgRGF0ZShldmVudC50aW1lc3RhbXApLnRvSVNPU3RyaW5nKCksXG4gICAgICBkYXRhOiB7XG4gICAgICAgIG1ldGhvZDogZXZlbnQubWV0aG9kLFxuICAgICAgICB2b2x0YWdlOiBldmVudC52b2x0YWdlLFxuICAgICAgfSxcbiAgICB9KSk7XG5cbiAgICAvLyBUcmFuc2Zvcm0gbG9jYXRpb24gZXZlbnRzIHRvIGFjdGl2aXR5IGl0ZW1zIChvbmx5IHNpZ25pZmljYW50IGNoYW5nZXMpXG4gICAgY29uc3QgbG9jYXRpb25BY3Rpdml0aWVzOiBBY3Rpdml0eUl0ZW1bXSA9IHNpZ25pZmljYW50TG9jYXRpb25FdmVudHMubWFwKChldmVudCkgPT4gKHtcbiAgICAgIGlkOiBgbG9jYXRpb24tJHtldmVudC5kZXZpY2VfdWlkfS0ke2V2ZW50LnRpbWVzdGFtcH1gLFxuICAgICAgdHlwZTogJ2xvY2F0aW9uJyxcbiAgICAgIGRldmljZV91aWQ6IGV2ZW50LmRldmljZV91aWQsXG4gICAgICBkZXZpY2VfbmFtZTogZGV2aWNlTmFtZXNbZXZlbnQuZGV2aWNlX3VpZF0sXG4gICAgICBtZXNzYWdlOiBmb3JtYXRMb2NhdGlvbk1lc3NhZ2UoZXZlbnQsIGRldmljZU5hbWVzW2V2ZW50LmRldmljZV91aWRdKSxcbiAgICAgIHRpbWVzdGFtcDogbmV3IERhdGUoZXZlbnQudGltZXN0YW1wKS50b0lTT1N0cmluZygpLFxuICAgICAgZGF0YToge1xuICAgICAgICBsYXQ6IGV2ZW50LmxhdGl0dWRlLFxuICAgICAgICBsb246IGV2ZW50LmxvbmdpdHVkZSxcbiAgICAgICAgc291cmNlOiBldmVudC5sb2NhdGlvbl9zb3VyY2UsXG4gICAgICB9LFxuICAgIH0pKTtcblxuICAgIC8vIE1lcmdlIGFsbCBhY3Rpdml0aWVzIGFuZCBzb3J0IGJ5IHRpbWVzdGFtcCAobmV3ZXN0IGZpcnN0KVxuICAgIGNvbnN0IGFsbEFjdGl2aXRpZXMgPSBbLi4uYWxlcnRBY3Rpdml0aWVzLCAuLi5oZWFsdGhBY3Rpdml0aWVzLCAuLi5sb2NhdGlvbkFjdGl2aXRpZXNdXG4gICAgICAuc29ydCgoYSwgYikgPT4gbmV3IERhdGUoYi50aW1lc3RhbXApLmdldFRpbWUoKSAtIG5ldyBEYXRlKGEudGltZXN0YW1wKS5nZXRUaW1lKCkpXG4gICAgICAuc2xpY2UoMCwgbGltaXQpO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgIGhlYWRlcnM6IGNvcnNIZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBob3VycyxcbiAgICAgICAgY291bnQ6IGFsbEFjdGl2aXRpZXMubGVuZ3RoLFxuICAgICAgICBhY3Rpdml0aWVzOiBhbGxBY3Rpdml0aWVzLFxuICAgICAgfSksXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvcjonLCBlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMCxcbiAgICAgIGhlYWRlcnM6IGNvcnNIZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0ludGVybmFsIHNlcnZlciBlcnJvcicgfSksXG4gICAgfTtcbiAgfVxufTtcblxuYXN5bmMgZnVuY3Rpb24gZ2V0UmVjZW50QWxlcnRzKGhvdXJzOiBudW1iZXIsIGxpbWl0OiBudW1iZXIpOiBQcm9taXNlPGFueVtdPiB7XG4gIGNvbnN0IGN1dG9mZlRpbWUgPSBEYXRlLm5vdygpIC0gaG91cnMgKiA2MCAqIDYwICogMTAwMDtcbiAgY29uc3QgYWxsSXRlbXM6IGFueVtdID0gW107XG4gIGxldCBsYXN0RXZhbHVhdGVkS2V5OiBSZWNvcmQ8c3RyaW5nLCBhbnk+IHwgdW5kZWZpbmVkO1xuXG4gIC8vIFBhZ2luYXRlIHRocm91Z2ggYWxsIHJlc3VsdHNcbiAgZG8ge1xuICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgU2NhbkNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBBTEVSVFNfVEFCTEUsXG4gICAgICBGaWx0ZXJFeHByZXNzaW9uOiAnY3JlYXRlZF9hdCA+IDpjdXRvZmYnLFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAnOmN1dG9mZic6IGN1dG9mZlRpbWUsXG4gICAgICB9LFxuICAgICAgRXhjbHVzaXZlU3RhcnRLZXk6IGxhc3RFdmFsdWF0ZWRLZXksXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgICBhbGxJdGVtcy5wdXNoKC4uLihyZXN1bHQuSXRlbXMgfHwgW10pKTtcbiAgICBsYXN0RXZhbHVhdGVkS2V5ID0gcmVzdWx0Lkxhc3RFdmFsdWF0ZWRLZXk7XG5cbiAgICAvLyBTdG9wIGVhcmx5IGlmIHdlIGhhdmUgZW5vdWdoIGl0ZW1zXG4gICAgaWYgKGFsbEl0ZW1zLmxlbmd0aCA+PSBsaW1pdCAqIDIpIGJyZWFrO1xuICB9IHdoaWxlIChsYXN0RXZhbHVhdGVkS2V5KTtcblxuICByZXR1cm4gYWxsSXRlbXMuc2xpY2UoMCwgbGltaXQgKiAyKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0UmVjZW50SGVhbHRoRXZlbnRzKGhvdXJzOiBudW1iZXIsIGxpbWl0OiBudW1iZXIpOiBQcm9taXNlPGFueVtdPiB7XG4gIGNvbnN0IGN1dG9mZlRpbWUgPSBEYXRlLm5vdygpIC0gaG91cnMgKiA2MCAqIDYwICogMTAwMDtcbiAgY29uc3QgYWxsSXRlbXM6IGFueVtdID0gW107XG4gIGxldCBsYXN0RXZhbHVhdGVkS2V5OiBSZWNvcmQ8c3RyaW5nLCBhbnk+IHwgdW5kZWZpbmVkO1xuXG4gIC8vIFBhZ2luYXRlIHRocm91Z2ggYWxsIHJlc3VsdHNcbiAgZG8ge1xuICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgU2NhbkNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBURUxFTUVUUllfVEFCTEUsXG4gICAgICBGaWx0ZXJFeHByZXNzaW9uOiAnI3RzID4gOmN1dG9mZiBBTkQgZGF0YV90eXBlID0gOmRhdGFfdHlwZScsXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICAgJyN0cyc6ICd0aW1lc3RhbXAnLFxuICAgICAgfSxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgJzpjdXRvZmYnOiBjdXRvZmZUaW1lLFxuICAgICAgICAnOmRhdGFfdHlwZSc6ICdoZWFsdGgnLFxuICAgICAgfSxcbiAgICAgIEV4Y2x1c2l2ZVN0YXJ0S2V5OiBsYXN0RXZhbHVhdGVkS2V5LFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gICAgYWxsSXRlbXMucHVzaCguLi4ocmVzdWx0Lkl0ZW1zIHx8IFtdKSk7XG4gICAgbGFzdEV2YWx1YXRlZEtleSA9IHJlc3VsdC5MYXN0RXZhbHVhdGVkS2V5O1xuXG4gICAgLy8gU3RvcCBlYXJseSBpZiB3ZSBoYXZlIGVub3VnaCBpdGVtc1xuICAgIGlmIChhbGxJdGVtcy5sZW5ndGggPj0gbGltaXQgKiAyKSBicmVhaztcbiAgfSB3aGlsZSAobGFzdEV2YWx1YXRlZEtleSk7XG5cbiAgcmV0dXJuIGFsbEl0ZW1zLnNsaWNlKDAsIGxpbWl0ICogMik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldFJlY2VudExvY2F0aW9uRXZlbnRzKGhvdXJzOiBudW1iZXIsIGxpbWl0OiBudW1iZXIpOiBQcm9taXNlPGFueVtdPiB7XG4gIGNvbnN0IGN1dG9mZlRpbWUgPSBEYXRlLm5vdygpIC0gaG91cnMgKiA2MCAqIDYwICogMTAwMDtcbiAgY29uc3QgYWxsSXRlbXM6IGFueVtdID0gW107XG4gIGxldCBsYXN0RXZhbHVhdGVkS2V5OiBSZWNvcmQ8c3RyaW5nLCBhbnk+IHwgdW5kZWZpbmVkO1xuXG4gIC8vIFBhZ2luYXRlIHRocm91Z2ggQUxMIHJlc3VsdHMgLSBEeW5hbW9EQiBTY2FuIGRvZXNuJ3QgcmV0dXJuIGl0ZW1zIGluIG9yZGVyLFxuICAvLyBzbyB3ZSBtdXN0IHNjYW4gZXZlcnl0aGluZyB0byBlbnN1cmUgd2UgZ2V0IHRoZSBtb3N0IHJlY2VudCBldmVudHNcbiAgZG8ge1xuICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgU2NhbkNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBURUxFTUVUUllfVEFCTEUsXG4gICAgICBGaWx0ZXJFeHByZXNzaW9uOiAnI3RzID4gOmN1dG9mZiBBTkQgZXZlbnRfdHlwZSA9IDpldmVudF90eXBlJyxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczoge1xuICAgICAgICAnI3RzJzogJ3RpbWVzdGFtcCcsXG4gICAgICB9LFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAnOmN1dG9mZic6IGN1dG9mZlRpbWUsXG4gICAgICAgICc6ZXZlbnRfdHlwZSc6ICdfZ2VvbG9jYXRlLnFvJyxcbiAgICAgIH0sXG4gICAgICBFeGNsdXNpdmVTdGFydEtleTogbGFzdEV2YWx1YXRlZEtleSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICAgIGFsbEl0ZW1zLnB1c2goLi4uKHJlc3VsdC5JdGVtcyB8fCBbXSkpO1xuICAgIGxhc3RFdmFsdWF0ZWRLZXkgPSByZXN1bHQuTGFzdEV2YWx1YXRlZEtleTtcbiAgfSB3aGlsZSAobGFzdEV2YWx1YXRlZEtleSk7XG5cbiAgLy8gU29ydCBieSB0aW1lc3RhbXAgZGVzY2VuZGluZyBhbmQgcmV0dXJuIHRoZSBtb3N0IHJlY2VudCBpdGVtc1xuICByZXR1cm4gYWxsSXRlbXNcbiAgICAuc29ydCgoYSwgYikgPT4gYi50aW1lc3RhbXAgLSBhLnRpbWVzdGFtcClcbiAgICAuc2xpY2UoMCwgbGltaXQgKiAyKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0RGV2aWNlcygpOiBQcm9taXNlPGFueVtdPiB7XG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgU2NhbkNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICBQcm9qZWN0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQsICNuYW1lLCBzZXJpYWxfbnVtYmVyJyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICcjbmFtZSc6ICduYW1lJyxcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgcmV0dXJuIHJlc3VsdC5JdGVtcyB8fCBbXTtcbn1cblxuZnVuY3Rpb24gZm9ybWF0QWxlcnRNZXNzYWdlKGFsZXJ0OiBhbnkpOiBzdHJpbmcge1xuICBjb25zdCBhbGVydExhYmVsczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICB0ZW1wX2hpZ2g6ICdIaWdoIHRlbXBlcmF0dXJlIGFsZXJ0JyxcbiAgICB0ZW1wX2xvdzogJ0xvdyB0ZW1wZXJhdHVyZSBhbGVydCcsXG4gICAgaHVtaWRpdHlfaGlnaDogJ0hpZ2ggaHVtaWRpdHkgYWxlcnQnLFxuICAgIGh1bWlkaXR5X2xvdzogJ0xvdyBodW1pZGl0eSBhbGVydCcsXG4gICAgcHJlc3N1cmVfY2hhbmdlOiAnUHJlc3N1cmUgY2hhbmdlIGFsZXJ0JyxcbiAgICBsb3dfYmF0dGVyeTogJ0xvdyBiYXR0ZXJ5IGFsZXJ0JyxcbiAgICBtb3Rpb246ICdNb3Rpb24gZGV0ZWN0ZWQnLFxuICB9O1xuXG4gIGNvbnN0IGxhYmVsID0gYWxlcnRMYWJlbHNbYWxlcnQudHlwZV0gfHwgYWxlcnQudHlwZTtcbiAgaWYgKGFsZXJ0LnZhbHVlICE9PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gYCR7bGFiZWx9OiAke2FsZXJ0LnZhbHVlLnRvRml4ZWQoMSl9YDtcbiAgfVxuICByZXR1cm4gbGFiZWw7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdEhlYWx0aE1lc3NhZ2UoZXZlbnQ6IGFueSk6IHN0cmluZyB7XG4gIGNvbnN0IG1ldGhvZExhYmVsczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICBkZnU6ICdGaXJtd2FyZSB1cGRhdGUnLFxuICAgIGJvb3Q6ICdEZXZpY2UgYm9vdGVkJyxcbiAgICByZWJvb3Q6ICdEZXZpY2UgcmVib290ZWQnLFxuICAgIHJlc2V0OiAnRGV2aWNlIHJlc2V0JyxcbiAgICB1c2I6ICdVU0IgY29ubmVjdGVkJyxcbiAgICBiYXR0ZXJ5OiAnQmF0dGVyeSBzdGF0dXMgdXBkYXRlJyxcbiAgICBzeW5jOiAnU3luYyBjb21wbGV0ZWQnLFxuICAgIGNvbm5lY3RlZDogJ0Nvbm5lY3RlZCB0byBuZXR3b3JrJyxcbiAgICBkaXNjb25uZWN0ZWQ6ICdEaXNjb25uZWN0ZWQgZnJvbSBuZXR3b3JrJyxcbiAgfTtcblxuICBjb25zdCBsYWJlbCA9IG1ldGhvZExhYmVsc1tldmVudC5tZXRob2RdIHx8IGV2ZW50Lm1ldGhvZCB8fCAnSGVhbHRoIGV2ZW50JztcbiAgaWYgKGV2ZW50LnRleHQpIHtcbiAgICByZXR1cm4gYCR7bGFiZWx9OiAke2V2ZW50LnRleHR9YDtcbiAgfVxuICByZXR1cm4gbGFiZWw7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdExvY2F0aW9uTWVzc2FnZShldmVudDogYW55LCBkZXZpY2VOYW1lPzogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgc291cmNlTGFiZWxzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgIGdwczogJ0dQUyBsb2NhdGlvbicsXG4gICAgdHJpYW5ndWxhdGlvbjogJ1RyaWFuZ3VsYXRlZCBsb2NhdGlvbicsXG4gICAgY2VsbDogJ0NlbGwgdG93ZXIgbG9jYXRpb24nLFxuICAgIHRvd2VyOiAnQ2VsbCB0b3dlciBsb2NhdGlvbicsXG4gICAgd2lmaTogJ1dpLUZpIGxvY2F0aW9uJyxcbiAgfTtcblxuICBjb25zdCBzb3VyY2VMYWJlbCA9IHNvdXJjZUxhYmVsc1tldmVudC5sb2NhdGlvbl9zb3VyY2VdIHx8ICdMb2NhdGlvbiB1cGRhdGUnO1xuICByZXR1cm4gYCR7c291cmNlTGFiZWx9IHJlY2VpdmVkYDtcbn1cblxuLyoqXG4gKiBDYWxjdWxhdGUgZGlzdGFuY2UgYmV0d2VlbiB0d28gbGF0L2xvbiBwb2ludHMgdXNpbmcgSGF2ZXJzaW5lIGZvcm11bGFcbiAqIFJldHVybnMgZGlzdGFuY2UgaW4gbWV0ZXJzXG4gKi9cbmZ1bmN0aW9uIGhhdmVyc2luZURpc3RhbmNlKGxhdDE6IG51bWJlciwgbG9uMTogbnVtYmVyLCBsYXQyOiBudW1iZXIsIGxvbjI6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IFIgPSA2MzcxMDAwOyAvLyBFYXJ0aCdzIHJhZGl1cyBpbiBtZXRlcnNcbiAgY29uc3QgdG9SYWQgPSAoZGVnOiBudW1iZXIpID0+IGRlZyAqIE1hdGguUEkgLyAxODA7XG5cbiAgY29uc3QgZExhdCA9IHRvUmFkKGxhdDIgLSBsYXQxKTtcbiAgY29uc3QgZExvbiA9IHRvUmFkKGxvbjIgLSBsb24xKTtcblxuICBjb25zdCBhID0gTWF0aC5zaW4oZExhdCAvIDIpICogTWF0aC5zaW4oZExhdCAvIDIpICtcbiAgICAgICAgICAgIE1hdGguY29zKHRvUmFkKGxhdDEpKSAqIE1hdGguY29zKHRvUmFkKGxhdDIpKSAqXG4gICAgICAgICAgICBNYXRoLnNpbihkTG9uIC8gMikgKiBNYXRoLnNpbihkTG9uIC8gMik7XG5cbiAgY29uc3QgYyA9IDIgKiBNYXRoLmF0YW4yKE1hdGguc3FydChhKSwgTWF0aC5zcXJ0KDEgLSBhKSk7XG4gIHJldHVybiBSICogYztcbn1cblxuLyoqXG4gKiBGaWx0ZXIgbG9jYXRpb24gZXZlbnRzIHRvIG9ubHkgaW5jbHVkZSBtZWFuaW5nZnVsIGNoYW5nZXMgcGVyIGRldmljZS5cbiAqIEEgbG9jYXRpb24gaXMgY29uc2lkZXJlZCBcImNoYW5nZWRcIiBpZjpcbiAqIC0gSXQncyB0aGUgZmlyc3QgZXZlbnQgZm9yIHRoYXQgZGV2aWNlXG4gKiAtIFRoZSBsb2NhdGlvbiBzb3VyY2UgY2hhbmdlZFxuICogLSBUaGUgZGlzdGFuY2UgbW92ZWQgaXMgPiAxMDAgbWV0ZXJzXG4gKlxuICogQWx3YXlzIGluY2x1ZGVzIHRoZSBtb3N0IHJlY2VudCBldmVudCBwZXIgZGV2aWNlIHNvIHVzZXJzIHNlZSBjdXJyZW50IHN0YXR1cy5cbiAqL1xuZnVuY3Rpb24gZmlsdGVyU2lnbmlmaWNhbnRMb2NhdGlvbkNoYW5nZXMoZXZlbnRzOiBhbnlbXSk6IGFueVtdIHtcbiAgLy8gU29ydCBieSBkZXZpY2VfdWlkLCB0aGVuIHRpbWVzdGFtcCBhc2NlbmRpbmcgKG9sZGVzdCBmaXJzdClcbiAgY29uc3Qgc29ydGVkID0gWy4uLmV2ZW50c10uc29ydCgoYSwgYikgPT4ge1xuICAgIGlmIChhLmRldmljZV91aWQgIT09IGIuZGV2aWNlX3VpZCkge1xuICAgICAgcmV0dXJuIGEuZGV2aWNlX3VpZC5sb2NhbGVDb21wYXJlKGIuZGV2aWNlX3VpZCk7XG4gICAgfVxuICAgIHJldHVybiBhLnRpbWVzdGFtcCAtIGIudGltZXN0YW1wO1xuICB9KTtcblxuICBjb25zdCBzaWduaWZpY2FudEV2ZW50czogYW55W10gPSBbXTtcbiAgY29uc3QgbGFzdFNpZ25pZmljYW50QnlEZXZpY2U6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7fTtcbiAgY29uc3QgbW9zdFJlY2VudEJ5RGV2aWNlOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge307XG5cbiAgZm9yIChjb25zdCBldmVudCBvZiBzb3J0ZWQpIHtcbiAgICBjb25zdCBkZXZpY2VVaWQgPSBldmVudC5kZXZpY2VfdWlkO1xuXG4gICAgLy8gVHJhY2sgdGhlIG1vc3QgcmVjZW50IGV2ZW50IGZvciBlYWNoIGRldmljZVxuICAgIG1vc3RSZWNlbnRCeURldmljZVtkZXZpY2VVaWRdID0gZXZlbnQ7XG5cbiAgICBjb25zdCBsYXN0U2lnbmlmaWNhbnQgPSBsYXN0U2lnbmlmaWNhbnRCeURldmljZVtkZXZpY2VVaWRdO1xuXG4gICAgaWYgKCFsYXN0U2lnbmlmaWNhbnQpIHtcbiAgICAgIC8vIEZpcnN0IGV2ZW50IGZvciB0aGlzIGRldmljZVxuICAgICAgc2lnbmlmaWNhbnRFdmVudHMucHVzaChldmVudCk7XG4gICAgICBsYXN0U2lnbmlmaWNhbnRCeURldmljZVtkZXZpY2VVaWRdID0gZXZlbnQ7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBDaGVjayBpZiBsb2NhdGlvbiBzb3VyY2UgY2hhbmdlZFxuICAgIGlmIChldmVudC5sb2NhdGlvbl9zb3VyY2UgIT09IGxhc3RTaWduaWZpY2FudC5sb2NhdGlvbl9zb3VyY2UpIHtcbiAgICAgIHNpZ25pZmljYW50RXZlbnRzLnB1c2goZXZlbnQpO1xuICAgICAgbGFzdFNpZ25pZmljYW50QnlEZXZpY2VbZGV2aWNlVWlkXSA9IGV2ZW50O1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgLy8gQ2hlY2sgaWYgbW92ZWQgbW9yZSB0aGFuIDEwMCBtZXRlcnNcbiAgICBjb25zdCBkaXN0YW5jZSA9IGhhdmVyc2luZURpc3RhbmNlKFxuICAgICAgbGFzdFNpZ25pZmljYW50LmxhdGl0dWRlLCBsYXN0U2lnbmlmaWNhbnQubG9uZ2l0dWRlLFxuICAgICAgZXZlbnQubGF0aXR1ZGUsIGV2ZW50LmxvbmdpdHVkZVxuICAgICk7XG5cbiAgICBpZiAoZGlzdGFuY2UgPiAxMDApIHtcbiAgICAgIHNpZ25pZmljYW50RXZlbnRzLnB1c2goZXZlbnQpO1xuICAgICAgbGFzdFNpZ25pZmljYW50QnlEZXZpY2VbZGV2aWNlVWlkXSA9IGV2ZW50O1xuICAgIH1cbiAgfVxuXG4gIC8vIEVuc3VyZSB0aGUgbW9zdCByZWNlbnQgZXZlbnQgZm9yIGVhY2ggZGV2aWNlIGlzIGluY2x1ZGVkXG4gIGZvciAoY29uc3QgZGV2aWNlVWlkIG9mIE9iamVjdC5rZXlzKG1vc3RSZWNlbnRCeURldmljZSkpIHtcbiAgICBjb25zdCBtb3N0UmVjZW50ID0gbW9zdFJlY2VudEJ5RGV2aWNlW2RldmljZVVpZF07XG4gICAgY29uc3QgYWxyZWFkeUluY2x1ZGVkID0gc2lnbmlmaWNhbnRFdmVudHMuc29tZShcbiAgICAgIChlKSA9PiBlLmRldmljZV91aWQgPT09IGRldmljZVVpZCAmJiBlLnRpbWVzdGFtcCA9PT0gbW9zdFJlY2VudC50aW1lc3RhbXBcbiAgICApO1xuICAgIGlmICghYWxyZWFkeUluY2x1ZGVkKSB7XG4gICAgICBzaWduaWZpY2FudEV2ZW50cy5wdXNoKG1vc3RSZWNlbnQpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBzaWduaWZpY2FudEV2ZW50cztcbn1cbiJdfQ==