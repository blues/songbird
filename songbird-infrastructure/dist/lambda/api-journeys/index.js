"use strict";
/**
 * Journeys API Lambda
 *
 * Handles journey and location history queries:
 * - GET /devices/{serial_number}/journeys - List all journeys for a device
 * - GET /devices/{serial_number}/journeys/{journey_id} - Get journey details with points
 * - DELETE /devices/{serial_number}/journeys/{journey_id} - Delete a journey (admin/owner only)
 * - GET /devices/{serial_number}/locations - Get location history
 * - POST /devices/{serial_number}/journeys/{journey_id}/match - Trigger map matching
 *
 * Note: When a Notecard is swapped, journeys from all device_uids are merged.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const device_lookup_1 = require("../shared/device-lookup");
const ddbClient = new client_dynamodb_1.DynamoDBClient({});
const docClient = lib_dynamodb_1.DynamoDBDocumentClient.from(ddbClient);
const JOURNEYS_TABLE = process.env.JOURNEYS_TABLE;
const LOCATIONS_TABLE = process.env.LOCATIONS_TABLE;
const DEVICES_TABLE = process.env.DEVICES_TABLE;
const TELEMETRY_TABLE = process.env.TELEMETRY_TABLE;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const handler = async (event) => {
    console.log('Request:', JSON.stringify(event));
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    };
    try {
        const method = event.requestContext?.http?.method || event.httpMethod;
        const path = event.requestContext?.http?.path || event.path;
        if (method === 'OPTIONS') {
            return { statusCode: 200, headers: corsHeaders, body: '' };
        }
        const serialNumber = event.pathParameters?.serial_number;
        if (!serialNumber) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'serial_number required' }),
            };
        }
        // Resolve serial_number to all associated device_uids
        const resolved = await (0, device_lookup_1.resolveDevice)(serialNumber);
        if (!resolved) {
            return {
                statusCode: 404,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Device not found' }),
            };
        }
        const journeyId = event.pathParameters?.journey_id;
        const queryParams = event.queryStringParameters || {};
        // GET /devices/{serial_number}/locations - Location history (merged from all Notecards)
        if (path.endsWith('/locations')) {
            return await getLocationHistory(resolved.serial_number, resolved.all_device_uids, queryParams, corsHeaders);
        }
        // POST /devices/{serial_number}/journeys/{journey_id}/match - Map matching
        // Note: For now, we need to find which device_uid owns this journey
        if (path.endsWith('/match') && method === 'POST' && journeyId) {
            return await matchJourney(resolved.all_device_uids, parseInt(journeyId), corsHeaders);
        }
        // DELETE /devices/{serial_number}/journeys/{journey_id} - Delete journey (admin/owner only)
        if (method === 'DELETE' && journeyId) {
            return await deleteJourney(resolved.serial_number, resolved.all_device_uids, parseInt(journeyId), event, corsHeaders);
        }
        // GET /devices/{serial_number}/journeys/{journey_id} - Single journey with points
        if (journeyId) {
            return await getJourneyDetail(resolved.all_device_uids, parseInt(journeyId), corsHeaders);
        }
        // GET /devices/{serial_number}/journeys - List journeys (merged from all Notecards)
        return await listJourneys(resolved.serial_number, resolved.all_device_uids, queryParams, corsHeaders);
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
/**
 * List all journeys for a device (merged from all Notecards)
 */
async function listJourneys(serialNumber, deviceUids, queryParams, headers) {
    const status = queryParams.status; // 'active' | 'completed' | undefined (all)
    const limit = parseInt(queryParams.limit || '50');
    // Query all device_uids in parallel
    const queryPromises = deviceUids.map(async (deviceUid) => {
        const command = new lib_dynamodb_1.QueryCommand({
            TableName: JOURNEYS_TABLE,
            KeyConditionExpression: 'device_uid = :device_uid',
            ...(status && {
                FilterExpression: '#status = :status',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                    ':device_uid': deviceUid,
                    ':status': status,
                },
            }),
            ...(!status && {
                ExpressionAttributeValues: {
                    ':device_uid': deviceUid,
                },
            }),
            ScanIndexForward: false,
            Limit: limit,
        });
        const result = await docClient.send(command);
        return result.Items || [];
    });
    const allResults = await Promise.all(queryPromises);
    // Merge and sort by journey_id (which is the start timestamp, descending)
    const mergedJourneys = allResults
        .flat()
        .sort((a, b) => b.journey_id - a.journey_id)
        .slice(0, limit)
        .map((item) => ({
        journey_id: item.journey_id,
        device_uid: item.device_uid,
        start_time: new Date(item.start_time).toISOString(),
        end_time: item.end_time ? new Date(item.end_time).toISOString() : undefined,
        point_count: item.point_count || 0,
        total_distance: item.total_distance || 0,
        status: item.status,
    }));
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            serial_number: serialNumber,
            journeys: mergedJourneys,
            count: mergedJourneys.length,
        }),
    };
}
/**
 * Get a single journey with all its location points
 * Searches across all device_uids to find the journey
 */
async function getJourneyDetail(deviceUids, journeyId, headers) {
    // Search for the journey across all device_uids
    let journeyItem = null;
    let ownerDeviceUid = null;
    for (const deviceUid of deviceUids) {
        const journeyCommand = new lib_dynamodb_1.QueryCommand({
            TableName: JOURNEYS_TABLE,
            KeyConditionExpression: 'device_uid = :device_uid AND journey_id = :journey_id',
            ExpressionAttributeValues: {
                ':device_uid': deviceUid,
                ':journey_id': journeyId,
            },
        });
        const journeyResult = await docClient.send(journeyCommand);
        if (journeyResult.Items && journeyResult.Items.length > 0) {
            journeyItem = journeyResult.Items[0];
            ownerDeviceUid = deviceUid;
            break;
        }
    }
    if (!journeyItem || !ownerDeviceUid) {
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Journey not found' }),
        };
    }
    // Get all location points for this journey using the journey-index GSI
    const pointsCommand = new lib_dynamodb_1.QueryCommand({
        TableName: LOCATIONS_TABLE,
        IndexName: 'journey-index',
        KeyConditionExpression: 'device_uid = :device_uid AND journey_id = :journey_id',
        ExpressionAttributeValues: {
            ':device_uid': ownerDeviceUid,
            ':journey_id': journeyId,
        },
        ScanIndexForward: true, // Chronological order
    });
    const pointsResult = await docClient.send(pointsCommand);
    const startTime = journeyItem.start_time;
    const endTime = journeyItem.end_time || Date.now();
    const journey = {
        journey_id: journeyItem.journey_id,
        device_uid: journeyItem.device_uid,
        start_time: new Date(startTime).toISOString(),
        end_time: journeyItem.end_time ? new Date(journeyItem.end_time).toISOString() : undefined,
        point_count: journeyItem.point_count || 0,
        total_distance: journeyItem.total_distance || 0,
        status: journeyItem.status,
        matched_route: journeyItem.matched_route, // GeoJSON LineString if map-matched
    };
    // Sort points by timestamp (GSI doesn't guarantee order within same journey_id)
    const sortedItems = (pointsResult.Items || []).sort((a, b) => a.timestamp - b.timestamp);
    const points = sortedItems.map((item) => ({
        time: new Date(item.timestamp).toISOString(),
        lat: item.latitude,
        lon: item.longitude,
        velocity: item.velocity,
        bearing: item.bearing,
        distance: item.distance,
        dop: item.dop,
        jcount: item.jcount,
    }));
    // Get power consumption for this journey
    const power = await getJourneyPowerConsumption(ownerDeviceUid, startTime, endTime);
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            journey,
            points,
            power,
        }),
    };
}
/**
 * Call Mapbox Map Matching API and cache the result
 * Searches across all device_uids to find the journey
 */
async function matchJourney(deviceUids, journeyId, headers) {
    if (!MAPBOX_TOKEN) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Map matching not configured' }),
        };
    }
    // Find which device_uid owns this journey
    let ownerDeviceUid = null;
    for (const deviceUid of deviceUids) {
        const journeyCommand = new lib_dynamodb_1.QueryCommand({
            TableName: JOURNEYS_TABLE,
            KeyConditionExpression: 'device_uid = :device_uid AND journey_id = :journey_id',
            ExpressionAttributeValues: {
                ':device_uid': deviceUid,
                ':journey_id': journeyId,
            },
        });
        const journeyResult = await docClient.send(journeyCommand);
        if (journeyResult.Items && journeyResult.Items.length > 0) {
            ownerDeviceUid = deviceUid;
            break;
        }
    }
    if (!ownerDeviceUid) {
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Journey not found' }),
        };
    }
    // Get the journey points
    const pointsCommand = new lib_dynamodb_1.QueryCommand({
        TableName: LOCATIONS_TABLE,
        IndexName: 'journey-index',
        KeyConditionExpression: 'device_uid = :device_uid AND journey_id = :journey_id',
        ExpressionAttributeValues: {
            ':device_uid': ownerDeviceUid,
            ':journey_id': journeyId,
        },
        ScanIndexForward: true,
    });
    const pointsResult = await docClient.send(pointsCommand);
    // Sort points by timestamp (GSI doesn't guarantee order within same journey_id)
    const points = (pointsResult.Items || []).sort((a, b) => a.timestamp - b.timestamp);
    if (points.length < 2) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Journey has fewer than 2 points' }),
        };
    }
    // Mapbox Map Matching API has a limit of 100 coordinates per request
    // If we have more, we need to sample or batch
    const maxPoints = 100;
    let sampledPoints = points;
    if (points.length > maxPoints) {
        // Sample points evenly
        const step = (points.length - 1) / (maxPoints - 1);
        sampledPoints = [];
        for (let i = 0; i < maxPoints; i++) {
            const idx = Math.round(i * step);
            sampledPoints.push(points[idx]);
        }
    }
    // Format coordinates for Mapbox API: lon,lat;lon,lat;...
    const coordinates = sampledPoints
        .map((p) => `${p.longitude},${p.latitude}`)
        .join(';');
    // Build the timestamps parameter (Unix timestamps in seconds)
    const timestamps = sampledPoints
        .map((p) => Math.floor(p.timestamp / 1000))
        .join(';');
    // Build the radiuses parameter (GPS accuracy in meters, default 25m)
    const radiuses = sampledPoints
        .map((p) => (p.dop ? Math.max(5, p.dop * 10) : 25))
        .join(';');
    // Call Mapbox Map Matching API
    const mapMatchUrl = `https://api.mapbox.com/matching/v5/mapbox/driving/${coordinates}?access_token=${MAPBOX_TOKEN}&geometries=geojson&radiuses=${radiuses}&timestamps=${timestamps}&overview=full&steps=false`;
    console.log(`Calling Mapbox Map Matching API for journey ${journeyId} with ${sampledPoints.length} points`);
    try {
        const response = await fetch(mapMatchUrl);
        const data = await response.json();
        if (data.code !== 'Ok' || !data.matchings || data.matchings.length === 0) {
            console.error('Map matching failed:', data);
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    error: 'Map matching failed',
                    code: data.code,
                    message: data.message,
                }),
            };
        }
        // Get the matched geometry (GeoJSON LineString)
        const matchedRoute = data.matchings[0].geometry;
        const confidence = data.matchings[0].confidence;
        // Store the matched route in DynamoDB (include point count for cache invalidation)
        const updateCommand = new lib_dynamodb_1.UpdateCommand({
            TableName: JOURNEYS_TABLE,
            Key: {
                device_uid: ownerDeviceUid,
                journey_id: journeyId,
            },
            UpdateExpression: 'SET matched_route = :route, match_confidence = :confidence, matched_at = :time, matched_points_count = :count',
            ExpressionAttributeValues: {
                ':route': matchedRoute,
                ':confidence': confidence,
                ':time': Date.now(),
                ':count': points.length,
            },
        });
        await docClient.send(updateCommand);
        console.log(`Stored matched route for journey ${journeyId} with confidence ${confidence}`);
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                matched_route: matchedRoute,
                confidence,
                original_points: points.length,
                matched_points: sampledPoints.length,
            }),
        };
    }
    catch (error) {
        console.error('Error calling Mapbox API:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to call map matching API' }),
        };
    }
}
/**
 * Get location history for a device (merged from all Notecards)
 */
async function getLocationHistory(serialNumber, deviceUids, queryParams, headers) {
    const hours = parseInt(queryParams.hours || '24');
    const source = queryParams.source; // 'gps' | 'cell' | 'triangulation' | undefined (all)
    const limit = parseInt(queryParams.limit || '1000');
    const cutoffTime = Date.now() - hours * 60 * 60 * 1000;
    // Query all device_uids in parallel
    const queryPromises = deviceUids.map(async (deviceUid) => {
        const command = new lib_dynamodb_1.QueryCommand({
            TableName: LOCATIONS_TABLE,
            KeyConditionExpression: 'device_uid = :device_uid AND #timestamp >= :cutoff',
            ...(source && {
                FilterExpression: '#source = :source',
                ExpressionAttributeNames: {
                    '#timestamp': 'timestamp',
                    '#source': 'source',
                },
                ExpressionAttributeValues: {
                    ':device_uid': deviceUid,
                    ':cutoff': cutoffTime,
                    ':source': source,
                },
            }),
            ...(!source && {
                ExpressionAttributeNames: {
                    '#timestamp': 'timestamp',
                },
                ExpressionAttributeValues: {
                    ':device_uid': deviceUid,
                    ':cutoff': cutoffTime,
                },
            }),
            ScanIndexForward: false,
            Limit: limit,
        });
        const result = await docClient.send(command);
        return result.Items || [];
    });
    const allResults = await Promise.all(queryPromises);
    // Merge and sort by timestamp (most recent first), then apply limit
    const mergedLocations = allResults
        .flat()
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit)
        .map((item) => ({
        time: new Date(item.timestamp).toISOString(),
        lat: item.latitude,
        lon: item.longitude,
        source: item.source,
        location_name: item.location_name,
        event_type: item.event_type,
        journey_id: item.journey_id,
        jcount: item.jcount,
        velocity: item.velocity,
        bearing: item.bearing,
    }));
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            serial_number: serialNumber,
            hours,
            count: mergedLocations.length,
            locations: mergedLocations,
        }),
    };
}
/**
 * Check if the user is an admin (in 'Admin' Cognito group)
 */
function isAdmin(event) {
    try {
        const claims = event.requestContext?.authorizer?.jwt?.claims;
        if (!claims)
            return false;
        const groups = claims['cognito:groups'];
        if (Array.isArray(groups)) {
            return groups.includes('Admin');
        }
        if (typeof groups === 'string') {
            return groups === 'Admin' || groups.includes('Admin');
        }
        return false;
    }
    catch {
        return false;
    }
}
/**
 * Get the user's email from the JWT claims
 */
function getUserEmail(event) {
    try {
        const claims = event.requestContext?.authorizer?.jwt?.claims;
        return claims?.email;
    }
    catch {
        return undefined;
    }
}
/**
 * Check if the user owns the device (is assigned to it)
 */
async function isDeviceOwner(deviceUid, userEmail) {
    const command = new lib_dynamodb_1.GetCommand({
        TableName: DEVICES_TABLE,
        Key: { device_uid: deviceUid },
        ProjectionExpression: 'assigned_to',
    });
    const result = await docClient.send(command);
    return result.Item?.assigned_to === userEmail;
}
/**
 * Delete a journey and all its location points (admin/owner only)
 * Searches across all device_uids to find and delete the journey
 */
async function deleteJourney(serialNumber, deviceUids, journeyId, event, headers) {
    // Authorization check: must be admin or device owner
    const userEmail = getUserEmail(event);
    const admin = isAdmin(event);
    // Find which device_uid owns this journey
    let ownerDeviceUid = null;
    for (const deviceUid of deviceUids) {
        const journeyCommand = new lib_dynamodb_1.QueryCommand({
            TableName: JOURNEYS_TABLE,
            KeyConditionExpression: 'device_uid = :device_uid AND journey_id = :journey_id',
            ExpressionAttributeValues: {
                ':device_uid': deviceUid,
                ':journey_id': journeyId,
            },
        });
        const journeyResult = await docClient.send(journeyCommand);
        if (journeyResult.Items && journeyResult.Items.length > 0) {
            ownerDeviceUid = deviceUid;
            break;
        }
    }
    if (!ownerDeviceUid) {
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Journey not found' }),
        };
    }
    if (!admin) {
        if (!userEmail) {
            return {
                statusCode: 401,
                headers,
                body: JSON.stringify({ error: 'Unauthorized' }),
            };
        }
        const owner = await isDeviceOwner(ownerDeviceUid, userEmail);
        if (!owner) {
            return {
                statusCode: 403,
                headers,
                body: JSON.stringify({ error: 'Admin or device owner access required' }),
            };
        }
    }
    // Get all location points for this journey to delete them
    const pointsCommand = new lib_dynamodb_1.QueryCommand({
        TableName: LOCATIONS_TABLE,
        IndexName: 'journey-index',
        KeyConditionExpression: 'device_uid = :device_uid AND journey_id = :journey_id',
        ExpressionAttributeValues: {
            ':device_uid': ownerDeviceUid,
            ':journey_id': journeyId,
        },
        ProjectionExpression: 'device_uid, #ts',
        ExpressionAttributeNames: {
            '#ts': 'timestamp',
        },
    });
    const pointsResult = await docClient.send(pointsCommand);
    const locationPoints = (pointsResult.Items || []);
    // Delete location points in batches of 25 (DynamoDB BatchWrite limit)
    if (locationPoints.length > 0) {
        const batches = [];
        for (let i = 0; i < locationPoints.length; i += 25) {
            const batch = locationPoints.slice(i, i + 25);
            batches.push(batch);
        }
        for (const batch of batches) {
            const deleteRequests = batch.map((point) => ({
                DeleteRequest: {
                    Key: {
                        device_uid: point.device_uid,
                        timestamp: point.timestamp,
                    },
                },
            }));
            const batchCommand = new lib_dynamodb_1.BatchWriteCommand({
                RequestItems: {
                    [LOCATIONS_TABLE]: deleteRequests,
                },
            });
            await docClient.send(batchCommand);
        }
        console.log(`Deleted ${locationPoints.length} location points for journey ${journeyId}`);
    }
    // Delete the journey record
    const deleteCommand = new lib_dynamodb_1.DeleteCommand({
        TableName: JOURNEYS_TABLE,
        Key: {
            device_uid: ownerDeviceUid,
            journey_id: journeyId,
        },
    });
    await docClient.send(deleteCommand);
    console.log(`Deleted journey ${journeyId} for device ${ownerDeviceUid} (serial: ${serialNumber})`);
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            message: 'Journey deleted',
            journey_id: journeyId,
            points_deleted: locationPoints.length,
        }),
    };
}
/**
 * Get power consumption during a journey timeframe
 * Queries power telemetry data and calculates mAh consumed
 */
async function getJourneyPowerConsumption(deviceUid, startTime, endTime) {
    // Query power telemetry using the event-type-index GSI
    const startKey = `power#${startTime}`;
    const endKey = `power#${endTime}`;
    const command = new lib_dynamodb_1.QueryCommand({
        TableName: TELEMETRY_TABLE,
        IndexName: 'event-type-index',
        KeyConditionExpression: 'device_uid = :device_uid AND event_type_timestamp BETWEEN :start AND :end',
        ExpressionAttributeValues: {
            ':device_uid': deviceUid,
            ':start': startKey,
            ':end': endKey,
        },
        ScanIndexForward: true, // Chronological order
    });
    const result = await docClient.send(command);
    const powerReadings = (result.Items || []);
    // Need at least 2 readings to calculate consumption
    if (powerReadings.length < 2) {
        return null;
    }
    // Filter for readings that have milliamp_hours
    const validReadings = powerReadings.filter((r) => typeof r.milliamp_hours === 'number');
    if (validReadings.length < 2) {
        return null;
    }
    const firstReading = validReadings[0];
    const lastReading = validReadings[validReadings.length - 1];
    // We know these are numbers since we filtered for them above
    const startMah = firstReading.milliamp_hours;
    const endMah = lastReading.milliamp_hours;
    // Calculate consumption (handle counter reset edge case)
    let consumedMah = endMah - startMah;
    if (consumedMah < 0) {
        // Counter was reset during journey - can't calculate accurately
        return null;
    }
    return {
        start_mah: Math.round(startMah * 100) / 100,
        end_mah: Math.round(endMah * 100) / 100,
        consumed_mah: Math.round(consumedMah * 100) / 100,
        reading_count: validReadings.length,
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWpvdXJuZXlzL2luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7R0FXRzs7O0FBRUgsOERBQTBEO0FBQzFELHdEQUEwSTtBQUUxSSwyREFBd0Q7QUF5Q3hELE1BQU0sU0FBUyxHQUFHLElBQUksZ0NBQWMsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN6QyxNQUFNLFNBQVMsR0FBRyxxQ0FBc0IsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7QUFFekQsTUFBTSxjQUFjLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFlLENBQUM7QUFDbkQsTUFBTSxlQUFlLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxlQUFnQixDQUFDO0FBQ3JELE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsYUFBYyxDQUFDO0FBQ2pELE1BQU0sZUFBZSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsZUFBZ0IsQ0FBQztBQUNyRCxNQUFNLFlBQVksR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLFlBQVksQ0FBQztBQUV2QyxNQUFNLE9BQU8sR0FBRyxLQUFLLEVBQUUsS0FBMkIsRUFBa0MsRUFBRTtJQUMzRixPQUFPLENBQUMsR0FBRyxDQUFDLFVBQVUsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFFL0MsTUFBTSxXQUFXLEdBQUc7UUFDbEIsNkJBQTZCLEVBQUUsR0FBRztRQUNsQyw4QkFBOEIsRUFBRSw0QkFBNEI7UUFDNUQsOEJBQThCLEVBQUUseUJBQXlCO0tBQzFELENBQUM7SUFFRixJQUFJLENBQUM7UUFDSCxNQUFNLE1BQU0sR0FBSSxLQUFLLENBQUMsY0FBc0IsRUFBRSxJQUFJLEVBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUM7UUFDL0UsTUFBTSxJQUFJLEdBQUksS0FB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RyxDQUFDLEdBQUcsR0FBRztRQUNqRCxhQUFhLEVBQUUsYUFBYSxDQUFDLE1BQU07S0FDcEMsQ0FBQztBQUNKLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEpvdXJuZXlzIEFQSSBMYW1iZGFcbiAqXG4gKiBIYW5kbGVzIGpvdXJuZXkgYW5kIGxvY2F0aW9uIGhpc3RvcnkgcXVlcmllczpcbiAqIC0gR0VUIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9qb3VybmV5cyAtIExpc3QgYWxsIGpvdXJuZXlzIGZvciBhIGRldmljZVxuICogLSBHRVQgL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2pvdXJuZXlzL3tqb3VybmV5X2lkfSAtIEdldCBqb3VybmV5IGRldGFpbHMgd2l0aCBwb2ludHNcbiAqIC0gREVMRVRFIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9qb3VybmV5cy97am91cm5leV9pZH0gLSBEZWxldGUgYSBqb3VybmV5IChhZG1pbi9vd25lciBvbmx5KVxuICogLSBHRVQgL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2xvY2F0aW9ucyAtIEdldCBsb2NhdGlvbiBoaXN0b3J5XG4gKiAtIFBPU1QgL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2pvdXJuZXlzL3tqb3VybmV5X2lkfS9tYXRjaCAtIFRyaWdnZXIgbWFwIG1hdGNoaW5nXG4gKlxuICogTm90ZTogV2hlbiBhIE5vdGVjYXJkIGlzIHN3YXBwZWQsIGpvdXJuZXlzIGZyb20gYWxsIGRldmljZV91aWRzIGFyZSBtZXJnZWQuXG4gKi9cblxuaW1wb3J0IHsgRHluYW1vREJDbGllbnQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtZHluYW1vZGInO1xuaW1wb3J0IHsgRHluYW1vREJEb2N1bWVudENsaWVudCwgUXVlcnlDb21tYW5kLCBVcGRhdGVDb21tYW5kLCBEZWxldGVDb21tYW5kLCBHZXRDb21tYW5kLCBCYXRjaFdyaXRlQ29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2xpYi1keW5hbW9kYic7XG5pbXBvcnQgeyBBUElHYXRld2F5UHJveHlFdmVudCwgQVBJR2F0ZXdheVByb3h5RXZlbnRWMiwgQVBJR2F0ZXdheVByb3h5UmVzdWx0IH0gZnJvbSAnYXdzLWxhbWJkYSc7XG5pbXBvcnQgeyByZXNvbHZlRGV2aWNlIH0gZnJvbSAnLi4vc2hhcmVkL2RldmljZS1sb29rdXAnO1xuXG4vLyBUeXBlIGZvciBsb2NhdGlvbiBwb2ludCBpdGVtcyBmcm9tIER5bmFtb0RCXG5pbnRlcmZhY2UgTG9jYXRpb25Qb2ludCB7XG4gIGRldmljZV91aWQ6IHN0cmluZztcbiAgdGltZXN0YW1wOiBudW1iZXI7XG4gIGxhdGl0dWRlOiBudW1iZXI7XG4gIGxvbmdpdHVkZTogbnVtYmVyO1xuICB2ZWxvY2l0eT86IG51bWJlcjtcbiAgYmVhcmluZz86IG51bWJlcjtcbiAgZGlzdGFuY2U/OiBudW1iZXI7XG4gIGRvcD86IG51bWJlcjtcbiAgamNvdW50PzogbnVtYmVyO1xuICBqb3VybmV5X2lkPzogbnVtYmVyO1xuICBzb3VyY2U/OiBzdHJpbmc7XG4gIGxvY2F0aW9uX25hbWU/OiBzdHJpbmc7XG4gIGV2ZW50X3R5cGU/OiBzdHJpbmc7XG59XG5cbi8vIFR5cGUgZm9yIHRlbGVtZXRyeSBpdGVtcyB3aXRoIHBvd2VyIHJlYWRpbmdzXG5pbnRlcmZhY2UgVGVsZW1ldHJ5SXRlbSB7XG4gIG1pbGxpYW1wX2hvdXJzPzogbnVtYmVyO1xuICBba2V5OiBzdHJpbmddOiB1bmtub3duO1xufVxuXG4vLyBHZW9KU09OIExpbmVTdHJpbmcgdHlwZVxuaW50ZXJmYWNlIEdlb0pTT05MaW5lU3RyaW5nIHtcbiAgdHlwZTogJ0xpbmVTdHJpbmcnO1xuICBjb29yZGluYXRlczogbnVtYmVyW11bXTtcbn1cblxuLy8gVHlwZSBmb3IgTWFwYm94IE1hcCBNYXRjaGluZyBBUEkgcmVzcG9uc2VcbmludGVyZmFjZSBNYXBib3hNYXRjaFJlc3BvbnNlIHtcbiAgY29kZTogc3RyaW5nO1xuICBtZXNzYWdlPzogc3RyaW5nO1xuICBtYXRjaGluZ3M/OiBBcnJheTx7XG4gICAgZ2VvbWV0cnk6IEdlb0pTT05MaW5lU3RyaW5nO1xuICAgIGNvbmZpZGVuY2U6IG51bWJlcjtcbiAgfT47XG59XG5cbmNvbnN0IGRkYkNsaWVudCA9IG5ldyBEeW5hbW9EQkNsaWVudCh7fSk7XG5jb25zdCBkb2NDbGllbnQgPSBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LmZyb20oZGRiQ2xpZW50KTtcblxuY29uc3QgSk9VUk5FWVNfVEFCTEUgPSBwcm9jZXNzLmVudi5KT1VSTkVZU19UQUJMRSE7XG5jb25zdCBMT0NBVElPTlNfVEFCTEUgPSBwcm9jZXNzLmVudi5MT0NBVElPTlNfVEFCTEUhO1xuY29uc3QgREVWSUNFU19UQUJMRSA9IHByb2Nlc3MuZW52LkRFVklDRVNfVEFCTEUhO1xuY29uc3QgVEVMRU1FVFJZX1RBQkxFID0gcHJvY2Vzcy5lbnYuVEVMRU1FVFJZX1RBQkxFITtcbmNvbnN0IE1BUEJPWF9UT0tFTiA9IHByb2Nlc3MuZW52Lk1BUEJPWF9UT0tFTjtcblxuZXhwb3J0IGNvbnN0IGhhbmRsZXIgPSBhc3luYyAoZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50KTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+ID0+IHtcbiAgY29uc29sZS5sb2coJ1JlcXVlc3Q6JywgSlNPTi5zdHJpbmdpZnkoZXZlbnQpKTtcblxuICBjb25zdCBjb3JzSGVhZGVycyA9IHtcbiAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJzogJyonLFxuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzJzogJ0NvbnRlbnQtVHlwZSxBdXRob3JpemF0aW9uJyxcbiAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kcyc6ICdHRVQsUE9TVCxERUxFVEUsT1BUSU9OUycsXG4gIH07XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBtZXRob2QgPSAoZXZlbnQucmVxdWVzdENvbnRleHQgYXMgYW55KT8uaHR0cD8ubWV0aG9kIHx8IGV2ZW50Lmh0dHBNZXRob2Q7XG4gICAgY29uc3QgcGF0aCA9IChldmVudC5yZXF1ZXN0Q29udGV4dCBhcyBhbnkpPy5odHRwPy5wYXRoIHx8IGV2ZW50LnBhdGg7XG5cbiAgICBpZiAobWV0aG9kID09PSAnT1BUSU9OUycpIHtcbiAgICAgIHJldHVybiB7IHN0YXR1c0NvZGU6IDIwMCwgaGVhZGVyczogY29yc0hlYWRlcnMsIGJvZHk6ICcnIH07XG4gICAgfVxuXG4gICAgY29uc3Qgc2VyaWFsTnVtYmVyID0gZXZlbnQucGF0aFBhcmFtZXRlcnM/LnNlcmlhbF9udW1iZXI7XG4gICAgaWYgKCFzZXJpYWxOdW1iZXIpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgaGVhZGVyczogY29yc0hlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdzZXJpYWxfbnVtYmVyIHJlcXVpcmVkJyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gUmVzb2x2ZSBzZXJpYWxfbnVtYmVyIHRvIGFsbCBhc3NvY2lhdGVkIGRldmljZV91aWRzXG4gICAgY29uc3QgcmVzb2x2ZWQgPSBhd2FpdCByZXNvbHZlRGV2aWNlKHNlcmlhbE51bWJlcik7XG4gICAgaWYgKCFyZXNvbHZlZCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgICBoZWFkZXJzOiBjb3JzSGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0RldmljZSBub3QgZm91bmQnIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCBqb3VybmV5SWQgPSBldmVudC5wYXRoUGFyYW1ldGVycz8uam91cm5leV9pZDtcbiAgICBjb25zdCBxdWVyeVBhcmFtcyA9IGV2ZW50LnF1ZXJ5U3RyaW5nUGFyYW1ldGVycyB8fCB7fTtcblxuICAgIC8vIEdFVCAvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vbG9jYXRpb25zIC0gTG9jYXRpb24gaGlzdG9yeSAobWVyZ2VkIGZyb20gYWxsIE5vdGVjYXJkcylcbiAgICBpZiAocGF0aC5lbmRzV2l0aCgnL2xvY2F0aW9ucycpKSB7XG4gICAgICByZXR1cm4gYXdhaXQgZ2V0TG9jYXRpb25IaXN0b3J5KHJlc29sdmVkLnNlcmlhbF9udW1iZXIsIHJlc29sdmVkLmFsbF9kZXZpY2VfdWlkcywgcXVlcnlQYXJhbXMsIGNvcnNIZWFkZXJzKTtcbiAgICB9XG5cbiAgICAvLyBQT1NUIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9qb3VybmV5cy97am91cm5leV9pZH0vbWF0Y2ggLSBNYXAgbWF0Y2hpbmdcbiAgICAvLyBOb3RlOiBGb3Igbm93LCB3ZSBuZWVkIHRvIGZpbmQgd2hpY2ggZGV2aWNlX3VpZCBvd25zIHRoaXMgam91cm5leVxuICAgIGlmIChwYXRoLmVuZHNXaXRoKCcvbWF0Y2gnKSAmJiBtZXRob2QgPT09ICdQT1NUJyAmJiBqb3VybmV5SWQpIHtcbiAgICAgIHJldHVybiBhd2FpdCBtYXRjaEpvdXJuZXkocmVzb2x2ZWQuYWxsX2RldmljZV91aWRzLCBwYXJzZUludChqb3VybmV5SWQpLCBjb3JzSGVhZGVycyk7XG4gICAgfVxuXG4gICAgLy8gREVMRVRFIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9qb3VybmV5cy97am91cm5leV9pZH0gLSBEZWxldGUgam91cm5leSAoYWRtaW4vb3duZXIgb25seSlcbiAgICBpZiAobWV0aG9kID09PSAnREVMRVRFJyAmJiBqb3VybmV5SWQpIHtcbiAgICAgIHJldHVybiBhd2FpdCBkZWxldGVKb3VybmV5KHJlc29sdmVkLnNlcmlhbF9udW1iZXIsIHJlc29sdmVkLmFsbF9kZXZpY2VfdWlkcywgcGFyc2VJbnQoam91cm5leUlkKSwgZXZlbnQsIGNvcnNIZWFkZXJzKTtcbiAgICB9XG5cbiAgICAvLyBHRVQgL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2pvdXJuZXlzL3tqb3VybmV5X2lkfSAtIFNpbmdsZSBqb3VybmV5IHdpdGggcG9pbnRzXG4gICAgaWYgKGpvdXJuZXlJZCkge1xuICAgICAgcmV0dXJuIGF3YWl0IGdldEpvdXJuZXlEZXRhaWwocmVzb2x2ZWQuYWxsX2RldmljZV91aWRzLCBwYXJzZUludChqb3VybmV5SWQpLCBjb3JzSGVhZGVycyk7XG4gICAgfVxuXG4gICAgLy8gR0VUIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9qb3VybmV5cyAtIExpc3Qgam91cm5leXMgKG1lcmdlZCBmcm9tIGFsbCBOb3RlY2FyZHMpXG4gICAgcmV0dXJuIGF3YWl0IGxpc3RKb3VybmV5cyhyZXNvbHZlZC5zZXJpYWxfbnVtYmVyLCByZXNvbHZlZC5hbGxfZGV2aWNlX3VpZHMsIHF1ZXJ5UGFyYW1zLCBjb3JzSGVhZGVycyk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3I6JywgZXJyb3IpO1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA1MDAsXG4gICAgICBoZWFkZXJzOiBjb3JzSGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnRlcm5hbCBzZXJ2ZXIgZXJyb3InIH0pLFxuICAgIH07XG4gIH1cbn07XG5cbi8qKlxuICogTGlzdCBhbGwgam91cm5leXMgZm9yIGEgZGV2aWNlIChtZXJnZWQgZnJvbSBhbGwgTm90ZWNhcmRzKVxuICovXG5hc3luYyBmdW5jdGlvbiBsaXN0Sm91cm5leXMoXG4gIHNlcmlhbE51bWJlcjogc3RyaW5nLFxuICBkZXZpY2VVaWRzOiBzdHJpbmdbXSxcbiAgcXVlcnlQYXJhbXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD4sXG4gIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiB7XG4gIGNvbnN0IHN0YXR1cyA9IHF1ZXJ5UGFyYW1zLnN0YXR1czsgLy8gJ2FjdGl2ZScgfCAnY29tcGxldGVkJyB8IHVuZGVmaW5lZCAoYWxsKVxuICBjb25zdCBsaW1pdCA9IHBhcnNlSW50KHF1ZXJ5UGFyYW1zLmxpbWl0IHx8ICc1MCcpO1xuXG4gIC8vIFF1ZXJ5IGFsbCBkZXZpY2VfdWlkcyBpbiBwYXJhbGxlbFxuICBjb25zdCBxdWVyeVByb21pc2VzID0gZGV2aWNlVWlkcy5tYXAoYXN5bmMgKGRldmljZVVpZCkgPT4ge1xuICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogSk9VUk5FWVNfVEFCTEUsXG4gICAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkJyxcbiAgICAgIC4uLihzdGF0dXMgJiYge1xuICAgICAgICBGaWx0ZXJFeHByZXNzaW9uOiAnI3N0YXR1cyA9IDpzdGF0dXMnLFxuICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHsgJyNzdGF0dXMnOiAnc3RhdHVzJyB9LFxuICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgICAgICc6c3RhdHVzJzogc3RhdHVzLFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgICAuLi4oIXN0YXR1cyAmJiB7XG4gICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgICAnOmRldmljZV91aWQnOiBkZXZpY2VVaWQsXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICAgIFNjYW5JbmRleEZvcndhcmQ6IGZhbHNlLFxuICAgICAgTGltaXQ6IGxpbWl0LFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gICAgcmV0dXJuIHJlc3VsdC5JdGVtcyB8fCBbXTtcbiAgfSk7XG5cbiAgY29uc3QgYWxsUmVzdWx0cyA9IGF3YWl0IFByb21pc2UuYWxsKHF1ZXJ5UHJvbWlzZXMpO1xuXG4gIC8vIE1lcmdlIGFuZCBzb3J0IGJ5IGpvdXJuZXlfaWQgKHdoaWNoIGlzIHRoZSBzdGFydCB0aW1lc3RhbXAsIGRlc2NlbmRpbmcpXG4gIGNvbnN0IG1lcmdlZEpvdXJuZXlzID0gYWxsUmVzdWx0c1xuICAgIC5mbGF0KClcbiAgICAuc29ydCgoYSwgYikgPT4gYi5qb3VybmV5X2lkIC0gYS5qb3VybmV5X2lkKVxuICAgIC5zbGljZSgwLCBsaW1pdClcbiAgICAubWFwKChpdGVtKSA9PiAoe1xuICAgICAgam91cm5leV9pZDogaXRlbS5qb3VybmV5X2lkLFxuICAgICAgZGV2aWNlX3VpZDogaXRlbS5kZXZpY2VfdWlkLFxuICAgICAgc3RhcnRfdGltZTogbmV3IERhdGUoaXRlbS5zdGFydF90aW1lKS50b0lTT1N0cmluZygpLFxuICAgICAgZW5kX3RpbWU6IGl0ZW0uZW5kX3RpbWUgPyBuZXcgRGF0ZShpdGVtLmVuZF90aW1lKS50b0lTT1N0cmluZygpIDogdW5kZWZpbmVkLFxuICAgICAgcG9pbnRfY291bnQ6IGl0ZW0ucG9pbnRfY291bnQgfHwgMCxcbiAgICAgIHRvdGFsX2Rpc3RhbmNlOiBpdGVtLnRvdGFsX2Rpc3RhbmNlIHx8IDAsXG4gICAgICBzdGF0dXM6IGl0ZW0uc3RhdHVzLFxuICAgIH0pKTtcblxuICByZXR1cm4ge1xuICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICBoZWFkZXJzLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIHNlcmlhbF9udW1iZXI6IHNlcmlhbE51bWJlcixcbiAgICAgIGpvdXJuZXlzOiBtZXJnZWRKb3VybmV5cyxcbiAgICAgIGNvdW50OiBtZXJnZWRKb3VybmV5cy5sZW5ndGgsXG4gICAgfSksXG4gIH07XG59XG5cbi8qKlxuICogR2V0IGEgc2luZ2xlIGpvdXJuZXkgd2l0aCBhbGwgaXRzIGxvY2F0aW9uIHBvaW50c1xuICogU2VhcmNoZXMgYWNyb3NzIGFsbCBkZXZpY2VfdWlkcyB0byBmaW5kIHRoZSBqb3VybmV5XG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGdldEpvdXJuZXlEZXRhaWwoXG4gIGRldmljZVVpZHM6IHN0cmluZ1tdLFxuICBqb3VybmV5SWQ6IG51bWJlcixcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgLy8gU2VhcmNoIGZvciB0aGUgam91cm5leSBhY3Jvc3MgYWxsIGRldmljZV91aWRzXG4gIGxldCBqb3VybmV5SXRlbTogYW55ID0gbnVsbDtcbiAgbGV0IG93bmVyRGV2aWNlVWlkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuICBmb3IgKGNvbnN0IGRldmljZVVpZCBvZiBkZXZpY2VVaWRzKSB7XG4gICAgY29uc3Qgam91cm5leUNvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogSk9VUk5FWVNfVEFCTEUsXG4gICAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCBqb3VybmV5X2lkID0gOmpvdXJuZXlfaWQnLFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAnOmRldmljZV91aWQnOiBkZXZpY2VVaWQsXG4gICAgICAgICc6am91cm5leV9pZCc6IGpvdXJuZXlJZCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBqb3VybmV5UmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoam91cm5leUNvbW1hbmQpO1xuXG4gICAgaWYgKGpvdXJuZXlSZXN1bHQuSXRlbXMgJiYgam91cm5leVJlc3VsdC5JdGVtcy5sZW5ndGggPiAwKSB7XG4gICAgICBqb3VybmV5SXRlbSA9IGpvdXJuZXlSZXN1bHQuSXRlbXNbMF07XG4gICAgICBvd25lckRldmljZVVpZCA9IGRldmljZVVpZDtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIGlmICgham91cm5leUl0ZW0gfHwgIW93bmVyRGV2aWNlVWlkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwNCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnSm91cm5leSBub3QgZm91bmQnIH0pLFxuICAgIH07XG4gIH1cblxuICAvLyBHZXQgYWxsIGxvY2F0aW9uIHBvaW50cyBmb3IgdGhpcyBqb3VybmV5IHVzaW5nIHRoZSBqb3VybmV5LWluZGV4IEdTSVxuICBjb25zdCBwb2ludHNDb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBMT0NBVElPTlNfVEFCTEUsXG4gICAgSW5kZXhOYW1lOiAnam91cm5leS1pbmRleCcsXG4gICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQgPSA6ZGV2aWNlX3VpZCBBTkQgam91cm5leV9pZCA9IDpqb3VybmV5X2lkJyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAnOmRldmljZV91aWQnOiBvd25lckRldmljZVVpZCxcbiAgICAgICc6am91cm5leV9pZCc6IGpvdXJuZXlJZCxcbiAgICB9LFxuICAgIFNjYW5JbmRleEZvcndhcmQ6IHRydWUsIC8vIENocm9ub2xvZ2ljYWwgb3JkZXJcbiAgfSk7XG5cbiAgY29uc3QgcG9pbnRzUmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQocG9pbnRzQ29tbWFuZCk7XG5cbiAgY29uc3Qgc3RhcnRUaW1lID0gam91cm5leUl0ZW0uc3RhcnRfdGltZTtcbiAgY29uc3QgZW5kVGltZSA9IGpvdXJuZXlJdGVtLmVuZF90aW1lIHx8IERhdGUubm93KCk7XG5cbiAgY29uc3Qgam91cm5leSA9IHtcbiAgICBqb3VybmV5X2lkOiBqb3VybmV5SXRlbS5qb3VybmV5X2lkLFxuICAgIGRldmljZV91aWQ6IGpvdXJuZXlJdGVtLmRldmljZV91aWQsXG4gICAgc3RhcnRfdGltZTogbmV3IERhdGUoc3RhcnRUaW1lKS50b0lTT1N0cmluZygpLFxuICAgIGVuZF90aW1lOiBqb3VybmV5SXRlbS5lbmRfdGltZSA/IG5ldyBEYXRlKGpvdXJuZXlJdGVtLmVuZF90aW1lKS50b0lTT1N0cmluZygpIDogdW5kZWZpbmVkLFxuICAgIHBvaW50X2NvdW50OiBqb3VybmV5SXRlbS5wb2ludF9jb3VudCB8fCAwLFxuICAgIHRvdGFsX2Rpc3RhbmNlOiBqb3VybmV5SXRlbS50b3RhbF9kaXN0YW5jZSB8fCAwLFxuICAgIHN0YXR1czogam91cm5leUl0ZW0uc3RhdHVzLFxuICAgIG1hdGNoZWRfcm91dGU6IGpvdXJuZXlJdGVtLm1hdGNoZWRfcm91dGUsIC8vIEdlb0pTT04gTGluZVN0cmluZyBpZiBtYXAtbWF0Y2hlZFxuICB9O1xuXG4gIC8vIFNvcnQgcG9pbnRzIGJ5IHRpbWVzdGFtcCAoR1NJIGRvZXNuJ3QgZ3VhcmFudGVlIG9yZGVyIHdpdGhpbiBzYW1lIGpvdXJuZXlfaWQpXG4gIGNvbnN0IHNvcnRlZEl0ZW1zID0gKChwb2ludHNSZXN1bHQuSXRlbXMgfHwgW10pIGFzIExvY2F0aW9uUG9pbnRbXSkuc29ydCgoYSwgYikgPT4gYS50aW1lc3RhbXAgLSBiLnRpbWVzdGFtcCk7XG5cbiAgY29uc3QgcG9pbnRzID0gc29ydGVkSXRlbXMubWFwKChpdGVtKSA9PiAoe1xuICAgIHRpbWU6IG5ldyBEYXRlKGl0ZW0udGltZXN0YW1wKS50b0lTT1N0cmluZygpLFxuICAgIGxhdDogaXRlbS5sYXRpdHVkZSxcbiAgICBsb246IGl0ZW0ubG9uZ2l0dWRlLFxuICAgIHZlbG9jaXR5OiBpdGVtLnZlbG9jaXR5LFxuICAgIGJlYXJpbmc6IGl0ZW0uYmVhcmluZyxcbiAgICBkaXN0YW5jZTogaXRlbS5kaXN0YW5jZSxcbiAgICBkb3A6IGl0ZW0uZG9wLFxuICAgIGpjb3VudDogaXRlbS5qY291bnQsXG4gIH0pKTtcblxuICAvLyBHZXQgcG93ZXIgY29uc3VtcHRpb24gZm9yIHRoaXMgam91cm5leVxuICBjb25zdCBwb3dlciA9IGF3YWl0IGdldEpvdXJuZXlQb3dlckNvbnN1bXB0aW9uKG93bmVyRGV2aWNlVWlkLCBzdGFydFRpbWUsIGVuZFRpbWUpO1xuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgam91cm5leSxcbiAgICAgIHBvaW50cyxcbiAgICAgIHBvd2VyLFxuICAgIH0pLFxuICB9O1xufVxuXG4vKipcbiAqIENhbGwgTWFwYm94IE1hcCBNYXRjaGluZyBBUEkgYW5kIGNhY2hlIHRoZSByZXN1bHRcbiAqIFNlYXJjaGVzIGFjcm9zcyBhbGwgZGV2aWNlX3VpZHMgdG8gZmluZCB0aGUgam91cm5leVxuICovXG5hc3luYyBmdW5jdGlvbiBtYXRjaEpvdXJuZXkoXG4gIGRldmljZVVpZHM6IHN0cmluZ1tdLFxuICBqb3VybmV5SWQ6IG51bWJlcixcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgaWYgKCFNQVBCT1hfVE9LRU4pIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNTAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdNYXAgbWF0Y2hpbmcgbm90IGNvbmZpZ3VyZWQnIH0pLFxuICAgIH07XG4gIH1cblxuICAvLyBGaW5kIHdoaWNoIGRldmljZV91aWQgb3ducyB0aGlzIGpvdXJuZXlcbiAgbGV0IG93bmVyRGV2aWNlVWlkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuICBmb3IgKGNvbnN0IGRldmljZVVpZCBvZiBkZXZpY2VVaWRzKSB7XG4gICAgY29uc3Qgam91cm5leUNvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogSk9VUk5FWVNfVEFCTEUsXG4gICAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCBqb3VybmV5X2lkID0gOmpvdXJuZXlfaWQnLFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAnOmRldmljZV91aWQnOiBkZXZpY2VVaWQsXG4gICAgICAgICc6am91cm5leV9pZCc6IGpvdXJuZXlJZCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBqb3VybmV5UmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoam91cm5leUNvbW1hbmQpO1xuXG4gICAgaWYgKGpvdXJuZXlSZXN1bHQuSXRlbXMgJiYgam91cm5leVJlc3VsdC5JdGVtcy5sZW5ndGggPiAwKSB7XG4gICAgICBvd25lckRldmljZVVpZCA9IGRldmljZVVpZDtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIGlmICghb3duZXJEZXZpY2VVaWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdKb3VybmV5IG5vdCBmb3VuZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8vIEdldCB0aGUgam91cm5leSBwb2ludHNcbiAgY29uc3QgcG9pbnRzQ29tbWFuZCA9IG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogTE9DQVRJT05TX1RBQkxFLFxuICAgIEluZGV4TmFtZTogJ2pvdXJuZXktaW5kZXgnLFxuICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkID0gOmRldmljZV91aWQgQU5EIGpvdXJuZXlfaWQgPSA6am91cm5leV9pZCcsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzpkZXZpY2VfdWlkJzogb3duZXJEZXZpY2VVaWQsXG4gICAgICAnOmpvdXJuZXlfaWQnOiBqb3VybmV5SWQsXG4gICAgfSxcbiAgICBTY2FuSW5kZXhGb3J3YXJkOiB0cnVlLFxuICB9KTtcblxuICBjb25zdCBwb2ludHNSZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChwb2ludHNDb21tYW5kKTtcblxuICAvLyBTb3J0IHBvaW50cyBieSB0aW1lc3RhbXAgKEdTSSBkb2Vzbid0IGd1YXJhbnRlZSBvcmRlciB3aXRoaW4gc2FtZSBqb3VybmV5X2lkKVxuICBjb25zdCBwb2ludHMgPSAoKHBvaW50c1Jlc3VsdC5JdGVtcyB8fCBbXSkgYXMgTG9jYXRpb25Qb2ludFtdKS5zb3J0KChhLCBiKSA9PiBhLnRpbWVzdGFtcCAtIGIudGltZXN0YW1wKTtcblxuICBpZiAocG9pbnRzLmxlbmd0aCA8IDIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdKb3VybmV5IGhhcyBmZXdlciB0aGFuIDIgcG9pbnRzJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gTWFwYm94IE1hcCBNYXRjaGluZyBBUEkgaGFzIGEgbGltaXQgb2YgMTAwIGNvb3JkaW5hdGVzIHBlciByZXF1ZXN0XG4gIC8vIElmIHdlIGhhdmUgbW9yZSwgd2UgbmVlZCB0byBzYW1wbGUgb3IgYmF0Y2hcbiAgY29uc3QgbWF4UG9pbnRzID0gMTAwO1xuICBsZXQgc2FtcGxlZFBvaW50czogTG9jYXRpb25Qb2ludFtdID0gcG9pbnRzO1xuICBpZiAocG9pbnRzLmxlbmd0aCA+IG1heFBvaW50cykge1xuICAgIC8vIFNhbXBsZSBwb2ludHMgZXZlbmx5XG4gICAgY29uc3Qgc3RlcCA9IChwb2ludHMubGVuZ3RoIC0gMSkgLyAobWF4UG9pbnRzIC0gMSk7XG4gICAgc2FtcGxlZFBvaW50cyA9IFtdO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgbWF4UG9pbnRzOyBpKyspIHtcbiAgICAgIGNvbnN0IGlkeCA9IE1hdGgucm91bmQoaSAqIHN0ZXApO1xuICAgICAgc2FtcGxlZFBvaW50cy5wdXNoKHBvaW50c1tpZHhdKTtcbiAgICB9XG4gIH1cblxuICAvLyBGb3JtYXQgY29vcmRpbmF0ZXMgZm9yIE1hcGJveCBBUEk6IGxvbixsYXQ7bG9uLGxhdDsuLi5cbiAgY29uc3QgY29vcmRpbmF0ZXMgPSBzYW1wbGVkUG9pbnRzXG4gICAgLm1hcCgocCkgPT4gYCR7cC5sb25naXR1ZGV9LCR7cC5sYXRpdHVkZX1gKVxuICAgIC5qb2luKCc7Jyk7XG5cbiAgLy8gQnVpbGQgdGhlIHRpbWVzdGFtcHMgcGFyYW1ldGVyIChVbml4IHRpbWVzdGFtcHMgaW4gc2Vjb25kcylcbiAgY29uc3QgdGltZXN0YW1wcyA9IHNhbXBsZWRQb2ludHNcbiAgICAubWFwKChwKSA9PiBNYXRoLmZsb29yKHAudGltZXN0YW1wIC8gMTAwMCkpXG4gICAgLmpvaW4oJzsnKTtcblxuICAvLyBCdWlsZCB0aGUgcmFkaXVzZXMgcGFyYW1ldGVyIChHUFMgYWNjdXJhY3kgaW4gbWV0ZXJzLCBkZWZhdWx0IDI1bSlcbiAgY29uc3QgcmFkaXVzZXMgPSBzYW1wbGVkUG9pbnRzXG4gICAgLm1hcCgocCkgPT4gKHAuZG9wID8gTWF0aC5tYXgoNSwgcC5kb3AgKiAxMCkgOiAyNSkpXG4gICAgLmpvaW4oJzsnKTtcblxuICAvLyBDYWxsIE1hcGJveCBNYXAgTWF0Y2hpbmcgQVBJXG4gIGNvbnN0IG1hcE1hdGNoVXJsID0gYGh0dHBzOi8vYXBpLm1hcGJveC5jb20vbWF0Y2hpbmcvdjUvbWFwYm94L2RyaXZpbmcvJHtjb29yZGluYXRlc30/YWNjZXNzX3Rva2VuPSR7TUFQQk9YX1RPS0VOfSZnZW9tZXRyaWVzPWdlb2pzb24mcmFkaXVzZXM9JHtyYWRpdXNlc30mdGltZXN0YW1wcz0ke3RpbWVzdGFtcHN9Jm92ZXJ2aWV3PWZ1bGwmc3RlcHM9ZmFsc2VgO1xuXG4gIGNvbnNvbGUubG9nKGBDYWxsaW5nIE1hcGJveCBNYXAgTWF0Y2hpbmcgQVBJIGZvciBqb3VybmV5ICR7am91cm5leUlkfSB3aXRoICR7c2FtcGxlZFBvaW50cy5sZW5ndGh9IHBvaW50c2ApO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChtYXBNYXRjaFVybCk7XG4gICAgY29uc3QgZGF0YSA9IGF3YWl0IHJlc3BvbnNlLmpzb24oKSBhcyBNYXBib3hNYXRjaFJlc3BvbnNlO1xuXG4gICAgaWYgKGRhdGEuY29kZSAhPT0gJ09rJyB8fCAhZGF0YS5tYXRjaGluZ3MgfHwgZGF0YS5tYXRjaGluZ3MubGVuZ3RoID09PSAwKSB7XG4gICAgICBjb25zb2xlLmVycm9yKCdNYXAgbWF0Y2hpbmcgZmFpbGVkOicsIGRhdGEpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgZXJyb3I6ICdNYXAgbWF0Y2hpbmcgZmFpbGVkJyxcbiAgICAgICAgICBjb2RlOiBkYXRhLmNvZGUsXG4gICAgICAgICAgbWVzc2FnZTogZGF0YS5tZXNzYWdlLFxuICAgICAgICB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gR2V0IHRoZSBtYXRjaGVkIGdlb21ldHJ5IChHZW9KU09OIExpbmVTdHJpbmcpXG4gICAgY29uc3QgbWF0Y2hlZFJvdXRlID0gZGF0YS5tYXRjaGluZ3NbMF0uZ2VvbWV0cnk7XG4gICAgY29uc3QgY29uZmlkZW5jZSA9IGRhdGEubWF0Y2hpbmdzWzBdLmNvbmZpZGVuY2U7XG5cbiAgICAvLyBTdG9yZSB0aGUgbWF0Y2hlZCByb3V0ZSBpbiBEeW5hbW9EQiAoaW5jbHVkZSBwb2ludCBjb3VudCBmb3IgY2FjaGUgaW52YWxpZGF0aW9uKVxuICAgIGNvbnN0IHVwZGF0ZUNvbW1hbmQgPSBuZXcgVXBkYXRlQ29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IEpPVVJORVlTX1RBQkxFLFxuICAgICAgS2V5OiB7XG4gICAgICAgIGRldmljZV91aWQ6IG93bmVyRGV2aWNlVWlkLFxuICAgICAgICBqb3VybmV5X2lkOiBqb3VybmV5SWQsXG4gICAgICB9LFxuICAgICAgVXBkYXRlRXhwcmVzc2lvbjogJ1NFVCBtYXRjaGVkX3JvdXRlID0gOnJvdXRlLCBtYXRjaF9jb25maWRlbmNlID0gOmNvbmZpZGVuY2UsIG1hdGNoZWRfYXQgPSA6dGltZSwgbWF0Y2hlZF9wb2ludHNfY291bnQgPSA6Y291bnQnLFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAnOnJvdXRlJzogbWF0Y2hlZFJvdXRlLFxuICAgICAgICAnOmNvbmZpZGVuY2UnOiBjb25maWRlbmNlLFxuICAgICAgICAnOnRpbWUnOiBEYXRlLm5vdygpLFxuICAgICAgICAnOmNvdW50JzogcG9pbnRzLmxlbmd0aCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBhd2FpdCBkb2NDbGllbnQuc2VuZCh1cGRhdGVDb21tYW5kKTtcbiAgICBjb25zb2xlLmxvZyhgU3RvcmVkIG1hdGNoZWQgcm91dGUgZm9yIGpvdXJuZXkgJHtqb3VybmV5SWR9IHdpdGggY29uZmlkZW5jZSAke2NvbmZpZGVuY2V9YCk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgbWF0Y2hlZF9yb3V0ZTogbWF0Y2hlZFJvdXRlLFxuICAgICAgICBjb25maWRlbmNlLFxuICAgICAgICBvcmlnaW5hbF9wb2ludHM6IHBvaW50cy5sZW5ndGgsXG4gICAgICAgIG1hdGNoZWRfcG9pbnRzOiBzYW1wbGVkUG9pbnRzLmxlbmd0aCxcbiAgICAgIH0pLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3IgY2FsbGluZyBNYXBib3ggQVBJOicsIGVycm9yKTtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNTAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdGYWlsZWQgdG8gY2FsbCBtYXAgbWF0Y2hpbmcgQVBJJyB9KSxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogR2V0IGxvY2F0aW9uIGhpc3RvcnkgZm9yIGEgZGV2aWNlIChtZXJnZWQgZnJvbSBhbGwgTm90ZWNhcmRzKVxuICovXG5hc3luYyBmdW5jdGlvbiBnZXRMb2NhdGlvbkhpc3RvcnkoXG4gIHNlcmlhbE51bWJlcjogc3RyaW5nLFxuICBkZXZpY2VVaWRzOiBzdHJpbmdbXSxcbiAgcXVlcnlQYXJhbXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD4sXG4gIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiB7XG4gIGNvbnN0IGhvdXJzID0gcGFyc2VJbnQocXVlcnlQYXJhbXMuaG91cnMgfHwgJzI0Jyk7XG4gIGNvbnN0IHNvdXJjZSA9IHF1ZXJ5UGFyYW1zLnNvdXJjZTsgLy8gJ2dwcycgfCAnY2VsbCcgfCAndHJpYW5ndWxhdGlvbicgfCB1bmRlZmluZWQgKGFsbClcbiAgY29uc3QgbGltaXQgPSBwYXJzZUludChxdWVyeVBhcmFtcy5saW1pdCB8fCAnMTAwMCcpO1xuXG4gIGNvbnN0IGN1dG9mZlRpbWUgPSBEYXRlLm5vdygpIC0gaG91cnMgKiA2MCAqIDYwICogMTAwMDtcblxuICAvLyBRdWVyeSBhbGwgZGV2aWNlX3VpZHMgaW4gcGFyYWxsZWxcbiAgY29uc3QgcXVlcnlQcm9taXNlcyA9IGRldmljZVVpZHMubWFwKGFzeW5jIChkZXZpY2VVaWQpID0+IHtcbiAgICBjb25zdCBjb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IExPQ0FUSU9OU19UQUJMRSxcbiAgICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkID0gOmRldmljZV91aWQgQU5EICN0aW1lc3RhbXAgPj0gOmN1dG9mZicsXG4gICAgICAuLi4oc291cmNlICYmIHtcbiAgICAgICAgRmlsdGVyRXhwcmVzc2lvbjogJyNzb3VyY2UgPSA6c291cmNlJyxcbiAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAgICAgJyN0aW1lc3RhbXAnOiAndGltZXN0YW1wJyxcbiAgICAgICAgICAnI3NvdXJjZSc6ICdzb3VyY2UnLFxuICAgICAgICB9LFxuICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgICAgICc6Y3V0b2ZmJzogY3V0b2ZmVGltZSxcbiAgICAgICAgICAnOnNvdXJjZSc6IHNvdXJjZSxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICAgLi4uKCFzb3VyY2UgJiYge1xuICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICAgICAnI3RpbWVzdGFtcCc6ICd0aW1lc3RhbXAnLFxuICAgICAgICB9LFxuICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgICAgICc6Y3V0b2ZmJzogY3V0b2ZmVGltZSxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICAgU2NhbkluZGV4Rm9yd2FyZDogZmFsc2UsXG4gICAgICBMaW1pdDogbGltaXQsXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgICByZXR1cm4gcmVzdWx0Lkl0ZW1zIHx8IFtdO1xuICB9KTtcblxuICBjb25zdCBhbGxSZXN1bHRzID0gYXdhaXQgUHJvbWlzZS5hbGwocXVlcnlQcm9taXNlcyk7XG5cbiAgLy8gTWVyZ2UgYW5kIHNvcnQgYnkgdGltZXN0YW1wIChtb3N0IHJlY2VudCBmaXJzdCksIHRoZW4gYXBwbHkgbGltaXRcbiAgY29uc3QgbWVyZ2VkTG9jYXRpb25zID0gYWxsUmVzdWx0c1xuICAgIC5mbGF0KClcbiAgICAuc29ydCgoYSwgYikgPT4gYi50aW1lc3RhbXAgLSBhLnRpbWVzdGFtcClcbiAgICAuc2xpY2UoMCwgbGltaXQpXG4gICAgLm1hcCgoaXRlbSkgPT4gKHtcbiAgICAgIHRpbWU6IG5ldyBEYXRlKGl0ZW0udGltZXN0YW1wKS50b0lTT1N0cmluZygpLFxuICAgICAgbGF0OiBpdGVtLmxhdGl0dWRlLFxuICAgICAgbG9uOiBpdGVtLmxvbmdpdHVkZSxcbiAgICAgIHNvdXJjZTogaXRlbS5zb3VyY2UsXG4gICAgICBsb2NhdGlvbl9uYW1lOiBpdGVtLmxvY2F0aW9uX25hbWUsXG4gICAgICBldmVudF90eXBlOiBpdGVtLmV2ZW50X3R5cGUsXG4gICAgICBqb3VybmV5X2lkOiBpdGVtLmpvdXJuZXlfaWQsXG4gICAgICBqY291bnQ6IGl0ZW0uamNvdW50LFxuICAgICAgdmVsb2NpdHk6IGl0ZW0udmVsb2NpdHksXG4gICAgICBiZWFyaW5nOiBpdGVtLmJlYXJpbmcsXG4gICAgfSkpO1xuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgc2VyaWFsX251bWJlcjogc2VyaWFsTnVtYmVyLFxuICAgICAgaG91cnMsXG4gICAgICBjb3VudDogbWVyZ2VkTG9jYXRpb25zLmxlbmd0aCxcbiAgICAgIGxvY2F0aW9uczogbWVyZ2VkTG9jYXRpb25zLFxuICAgIH0pLFxuICB9O1xufVxuXG4vKipcbiAqIENoZWNrIGlmIHRoZSB1c2VyIGlzIGFuIGFkbWluIChpbiAnQWRtaW4nIENvZ25pdG8gZ3JvdXApXG4gKi9cbmZ1bmN0aW9uIGlzQWRtaW4oZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50KTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgY29uc3QgY2xhaW1zID0gKGV2ZW50LnJlcXVlc3RDb250ZXh0IGFzIGFueSk/LmF1dGhvcml6ZXI/Lmp3dD8uY2xhaW1zO1xuICAgIGlmICghY2xhaW1zKSByZXR1cm4gZmFsc2U7XG5cbiAgICBjb25zdCBncm91cHMgPSBjbGFpbXNbJ2NvZ25pdG86Z3JvdXBzJ107XG4gICAgaWYgKEFycmF5LmlzQXJyYXkoZ3JvdXBzKSkge1xuICAgICAgcmV0dXJuIGdyb3Vwcy5pbmNsdWRlcygnQWRtaW4nKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBncm91cHMgPT09ICdzdHJpbmcnKSB7XG4gICAgICByZXR1cm4gZ3JvdXBzID09PSAnQWRtaW4nIHx8IGdyb3Vwcy5pbmNsdWRlcygnQWRtaW4nKTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqXG4gKiBHZXQgdGhlIHVzZXIncyBlbWFpbCBmcm9tIHRoZSBKV1QgY2xhaW1zXG4gKi9cbmZ1bmN0aW9uIGdldFVzZXJFbWFpbChldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICB0cnkge1xuICAgIGNvbnN0IGNsYWltcyA9IChldmVudC5yZXF1ZXN0Q29udGV4dCBhcyBhbnkpPy5hdXRob3JpemVyPy5qd3Q/LmNsYWltcztcbiAgICByZXR1cm4gY2xhaW1zPy5lbWFpbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxufVxuXG4vKipcbiAqIENoZWNrIGlmIHRoZSB1c2VyIG93bnMgdGhlIGRldmljZSAoaXMgYXNzaWduZWQgdG8gaXQpXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGlzRGV2aWNlT3duZXIoZGV2aWNlVWlkOiBzdHJpbmcsIHVzZXJFbWFpbDogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgR2V0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgIEtleTogeyBkZXZpY2VfdWlkOiBkZXZpY2VVaWQgfSxcbiAgICBQcm9qZWN0aW9uRXhwcmVzc2lvbjogJ2Fzc2lnbmVkX3RvJyxcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIHJldHVybiByZXN1bHQuSXRlbT8uYXNzaWduZWRfdG8gPT09IHVzZXJFbWFpbDtcbn1cblxuLyoqXG4gKiBEZWxldGUgYSBqb3VybmV5IGFuZCBhbGwgaXRzIGxvY2F0aW9uIHBvaW50cyAoYWRtaW4vb3duZXIgb25seSlcbiAqIFNlYXJjaGVzIGFjcm9zcyBhbGwgZGV2aWNlX3VpZHMgdG8gZmluZCBhbmQgZGVsZXRlIHRoZSBqb3VybmV5XG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGRlbGV0ZUpvdXJuZXkoXG4gIHNlcmlhbE51bWJlcjogc3RyaW5nLFxuICBkZXZpY2VVaWRzOiBzdHJpbmdbXSxcbiAgam91cm5leUlkOiBudW1iZXIsXG4gIGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudCxcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgLy8gQXV0aG9yaXphdGlvbiBjaGVjazogbXVzdCBiZSBhZG1pbiBvciBkZXZpY2Ugb3duZXJcbiAgY29uc3QgdXNlckVtYWlsID0gZ2V0VXNlckVtYWlsKGV2ZW50KTtcbiAgY29uc3QgYWRtaW4gPSBpc0FkbWluKGV2ZW50KTtcblxuICAvLyBGaW5kIHdoaWNoIGRldmljZV91aWQgb3ducyB0aGlzIGpvdXJuZXlcbiAgbGV0IG93bmVyRGV2aWNlVWlkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuICBmb3IgKGNvbnN0IGRldmljZVVpZCBvZiBkZXZpY2VVaWRzKSB7XG4gICAgY29uc3Qgam91cm5leUNvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogSk9VUk5FWVNfVEFCTEUsXG4gICAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCBqb3VybmV5X2lkID0gOmpvdXJuZXlfaWQnLFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAnOmRldmljZV91aWQnOiBkZXZpY2VVaWQsXG4gICAgICAgICc6am91cm5leV9pZCc6IGpvdXJuZXlJZCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBqb3VybmV5UmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoam91cm5leUNvbW1hbmQpO1xuXG4gICAgaWYgKGpvdXJuZXlSZXN1bHQuSXRlbXMgJiYgam91cm5leVJlc3VsdC5JdGVtcy5sZW5ndGggPiAwKSB7XG4gICAgICBvd25lckRldmljZVVpZCA9IGRldmljZVVpZDtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIGlmICghb3duZXJEZXZpY2VVaWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdKb3VybmV5IG5vdCBmb3VuZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIGlmICghYWRtaW4pIHtcbiAgICBpZiAoIXVzZXJFbWFpbCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDAxLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnVW5hdXRob3JpemVkJyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgY29uc3Qgb3duZXIgPSBhd2FpdCBpc0RldmljZU93bmVyKG93bmVyRGV2aWNlVWlkLCB1c2VyRW1haWwpO1xuICAgIGlmICghb3duZXIpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwMyxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0FkbWluIG9yIGRldmljZSBvd25lciBhY2Nlc3MgcmVxdWlyZWQnIH0pLFxuICAgICAgfTtcbiAgICB9XG4gIH1cblxuICAvLyBHZXQgYWxsIGxvY2F0aW9uIHBvaW50cyBmb3IgdGhpcyBqb3VybmV5IHRvIGRlbGV0ZSB0aGVtXG4gIGNvbnN0IHBvaW50c0NvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IExPQ0FUSU9OU19UQUJMRSxcbiAgICBJbmRleE5hbWU6ICdqb3VybmV5LWluZGV4JyxcbiAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCBqb3VybmV5X2lkID0gOmpvdXJuZXlfaWQnLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6ZGV2aWNlX3VpZCc6IG93bmVyRGV2aWNlVWlkLFxuICAgICAgJzpqb3VybmV5X2lkJzogam91cm5leUlkLFxuICAgIH0sXG4gICAgUHJvamVjdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkLCAjdHMnLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczoge1xuICAgICAgJyN0cyc6ICd0aW1lc3RhbXAnLFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IHBvaW50c1Jlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKHBvaW50c0NvbW1hbmQpO1xuICBjb25zdCBsb2NhdGlvblBvaW50cyA9IChwb2ludHNSZXN1bHQuSXRlbXMgfHwgW10pIGFzIExvY2F0aW9uUG9pbnRbXTtcblxuICAvLyBEZWxldGUgbG9jYXRpb24gcG9pbnRzIGluIGJhdGNoZXMgb2YgMjUgKER5bmFtb0RCIEJhdGNoV3JpdGUgbGltaXQpXG4gIGlmIChsb2NhdGlvblBvaW50cy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgYmF0Y2hlczogTG9jYXRpb25Qb2ludFtdW10gPSBbXTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGxvY2F0aW9uUG9pbnRzLmxlbmd0aDsgaSArPSAyNSkge1xuICAgICAgY29uc3QgYmF0Y2ggPSBsb2NhdGlvblBvaW50cy5zbGljZShpLCBpICsgMjUpO1xuICAgICAgYmF0Y2hlcy5wdXNoKGJhdGNoKTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IGJhdGNoIG9mIGJhdGNoZXMpIHtcbiAgICAgIGNvbnN0IGRlbGV0ZVJlcXVlc3RzID0gYmF0Y2gubWFwKChwb2ludDogTG9jYXRpb25Qb2ludCkgPT4gKHtcbiAgICAgICAgRGVsZXRlUmVxdWVzdDoge1xuICAgICAgICAgIEtleToge1xuICAgICAgICAgICAgZGV2aWNlX3VpZDogcG9pbnQuZGV2aWNlX3VpZCxcbiAgICAgICAgICAgIHRpbWVzdGFtcDogcG9pbnQudGltZXN0YW1wLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9KSk7XG5cbiAgICAgIGNvbnN0IGJhdGNoQ29tbWFuZCA9IG5ldyBCYXRjaFdyaXRlQ29tbWFuZCh7XG4gICAgICAgIFJlcXVlc3RJdGVtczoge1xuICAgICAgICAgIFtMT0NBVElPTlNfVEFCTEVdOiBkZWxldGVSZXF1ZXN0cyxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuXG4gICAgICBhd2FpdCBkb2NDbGllbnQuc2VuZChiYXRjaENvbW1hbmQpO1xuICAgIH1cblxuICAgIGNvbnNvbGUubG9nKGBEZWxldGVkICR7bG9jYXRpb25Qb2ludHMubGVuZ3RofSBsb2NhdGlvbiBwb2ludHMgZm9yIGpvdXJuZXkgJHtqb3VybmV5SWR9YCk7XG4gIH1cblxuICAvLyBEZWxldGUgdGhlIGpvdXJuZXkgcmVjb3JkXG4gIGNvbnN0IGRlbGV0ZUNvbW1hbmQgPSBuZXcgRGVsZXRlQ29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICBLZXk6IHtcbiAgICAgIGRldmljZV91aWQ6IG93bmVyRGV2aWNlVWlkLFxuICAgICAgam91cm5leV9pZDogam91cm5leUlkLFxuICAgIH0sXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGRlbGV0ZUNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgRGVsZXRlZCBqb3VybmV5ICR7am91cm5leUlkfSBmb3IgZGV2aWNlICR7b3duZXJEZXZpY2VVaWR9IChzZXJpYWw6ICR7c2VyaWFsTnVtYmVyfSlgKTtcblxuICByZXR1cm4ge1xuICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICBoZWFkZXJzLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIG1lc3NhZ2U6ICdKb3VybmV5IGRlbGV0ZWQnLFxuICAgICAgam91cm5leV9pZDogam91cm5leUlkLFxuICAgICAgcG9pbnRzX2RlbGV0ZWQ6IGxvY2F0aW9uUG9pbnRzLmxlbmd0aCxcbiAgICB9KSxcbiAgfTtcbn1cblxuLyoqXG4gKiBHZXQgcG93ZXIgY29uc3VtcHRpb24gZHVyaW5nIGEgam91cm5leSB0aW1lZnJhbWVcbiAqIFF1ZXJpZXMgcG93ZXIgdGVsZW1ldHJ5IGRhdGEgYW5kIGNhbGN1bGF0ZXMgbUFoIGNvbnN1bWVkXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGdldEpvdXJuZXlQb3dlckNvbnN1bXB0aW9uKFxuICBkZXZpY2VVaWQ6IHN0cmluZyxcbiAgc3RhcnRUaW1lOiBudW1iZXIsXG4gIGVuZFRpbWU6IG51bWJlclxuKTogUHJvbWlzZTx7XG4gIHN0YXJ0X21haDogbnVtYmVyO1xuICBlbmRfbWFoOiBudW1iZXI7XG4gIGNvbnN1bWVkX21haDogbnVtYmVyO1xuICByZWFkaW5nX2NvdW50OiBudW1iZXI7XG59IHwgbnVsbD4ge1xuICAvLyBRdWVyeSBwb3dlciB0ZWxlbWV0cnkgdXNpbmcgdGhlIGV2ZW50LXR5cGUtaW5kZXggR1NJXG4gIGNvbnN0IHN0YXJ0S2V5ID0gYHBvd2VyIyR7c3RhcnRUaW1lfWA7XG4gIGNvbnN0IGVuZEtleSA9IGBwb3dlciMke2VuZFRpbWV9YDtcblxuICBjb25zdCBjb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBURUxFTUVUUllfVEFCTEUsXG4gICAgSW5kZXhOYW1lOiAnZXZlbnQtdHlwZS1pbmRleCcsXG4gICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQgPSA6ZGV2aWNlX3VpZCBBTkQgZXZlbnRfdHlwZV90aW1lc3RhbXAgQkVUV0VFTiA6c3RhcnQgQU5EIDplbmQnLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICAgICc6c3RhcnQnOiBzdGFydEtleSxcbiAgICAgICc6ZW5kJzogZW5kS2V5LFxuICAgIH0sXG4gICAgU2NhbkluZGV4Rm9yd2FyZDogdHJ1ZSwgLy8gQ2hyb25vbG9naWNhbCBvcmRlclxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc3QgcG93ZXJSZWFkaW5ncyA9IChyZXN1bHQuSXRlbXMgfHwgW10pIGFzIFRlbGVtZXRyeUl0ZW1bXTtcblxuICAvLyBOZWVkIGF0IGxlYXN0IDIgcmVhZGluZ3MgdG8gY2FsY3VsYXRlIGNvbnN1bXB0aW9uXG4gIGlmIChwb3dlclJlYWRpbmdzLmxlbmd0aCA8IDIpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIC8vIEZpbHRlciBmb3IgcmVhZGluZ3MgdGhhdCBoYXZlIG1pbGxpYW1wX2hvdXJzXG4gIGNvbnN0IHZhbGlkUmVhZGluZ3MgPSBwb3dlclJlYWRpbmdzLmZpbHRlcigocikgPT4gdHlwZW9mIHIubWlsbGlhbXBfaG91cnMgPT09ICdudW1iZXInKTtcblxuICBpZiAodmFsaWRSZWFkaW5ncy5sZW5ndGggPCAyKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICBjb25zdCBmaXJzdFJlYWRpbmcgPSB2YWxpZFJlYWRpbmdzWzBdO1xuICBjb25zdCBsYXN0UmVhZGluZyA9IHZhbGlkUmVhZGluZ3NbdmFsaWRSZWFkaW5ncy5sZW5ndGggLSAxXTtcblxuICAvLyBXZSBrbm93IHRoZXNlIGFyZSBudW1iZXJzIHNpbmNlIHdlIGZpbHRlcmVkIGZvciB0aGVtIGFib3ZlXG4gIGNvbnN0IHN0YXJ0TWFoID0gZmlyc3RSZWFkaW5nLm1pbGxpYW1wX2hvdXJzITtcbiAgY29uc3QgZW5kTWFoID0gbGFzdFJlYWRpbmcubWlsbGlhbXBfaG91cnMhO1xuXG4gIC8vIENhbGN1bGF0ZSBjb25zdW1wdGlvbiAoaGFuZGxlIGNvdW50ZXIgcmVzZXQgZWRnZSBjYXNlKVxuICBsZXQgY29uc3VtZWRNYWggPSBlbmRNYWggLSBzdGFydE1haDtcbiAgaWYgKGNvbnN1bWVkTWFoIDwgMCkge1xuICAgIC8vIENvdW50ZXIgd2FzIHJlc2V0IGR1cmluZyBqb3VybmV5IC0gY2FuJ3QgY2FsY3VsYXRlIGFjY3VyYXRlbHlcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgc3RhcnRfbWFoOiBNYXRoLnJvdW5kKHN0YXJ0TWFoICogMTAwKSAvIDEwMCxcbiAgICBlbmRfbWFoOiBNYXRoLnJvdW5kKGVuZE1haCAqIDEwMCkgLyAxMDAsXG4gICAgY29uc3VtZWRfbWFoOiBNYXRoLnJvdW5kKGNvbnN1bWVkTWFoICogMTAwKSAvIDEwMCxcbiAgICByZWFkaW5nX2NvdW50OiB2YWxpZFJlYWRpbmdzLmxlbmd0aCxcbiAgfTtcbn1cbiJdfQ==