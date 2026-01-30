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
        matched_points_count: journeyItem.matched_points_count, // Points count when route was matched
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWpvdXJuZXlzL2luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7R0FXRzs7O0FBRUgsOERBQTBEO0FBQzFELHdEQUEwSTtBQUUxSSwyREFBd0Q7QUF5Q3hELE1BQU0sU0FBUyxHQUFHLElBQUksZ0NBQWMsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN6QyxNQUFNLFNBQVMsR0FBRyxxQ0FBc0IsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7QUFFekQsTUFBTSxjQUFjLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFlLENBQUM7QUFDbkQsTUFBTSxlQUFlLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxlQUFnQixDQUFDO0FBQ3JELE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsYUFBYyxDQUFDO0FBQ2pELE1BQU0sZUFBZSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsZUFBZ0IsQ0FBQztBQUNyRCxNQUFNLFlBQVksR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLFlBQVksQ0FBQztBQUV2QyxNQUFNLE9BQU8sR0FBRyxLQUFLLEVBQUUsS0FBMkIsRUFBa0MsRUFBRTtJQUMzRixPQUFPLENBQUMsR0FBRyxDQUFDLFVBQVUsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFFL0MsTUFBTSxXQUFXLEdBQUc7UUFDbEIsNkJBQTZCLEVBQUUsR0FBRztRQUNsQyw4QkFBOEIsRUFBRSw0QkFBNEI7UUFDNUQsOEJBQThCLEVBQUUseUJBQXlCO0tBQzFELENBQUM7SUFFRixJQUFJLENBQUM7UUFDSCxNQUFNLE1BQU0sR0FBSSxLQUFLLENBQUMsY0FBc0IsRUFBRSxJQUFJLEVBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUM7UUFDL0UsTUFBTSxJQUFJLEdBQUksS0FB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Q3ZDLFlBQVksRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLFdBQVcsR0FBRyxHQUFHLENBQUMsR0FBRyxHQUFHO1FBQ2pELGFBQWEsRUFBRSxhQUFhLENBQUMsTUFBTTtLQUNwQyxDQUFDO0FBQ0osQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogSm91cm5leXMgQVBJIExhbWJkYVxuICpcbiAqIEhhbmRsZXMgam91cm5leSBhbmQgbG9jYXRpb24gaGlzdG9yeSBxdWVyaWVzOlxuICogLSBHRVQgL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2pvdXJuZXlzIC0gTGlzdCBhbGwgam91cm5leXMgZm9yIGEgZGV2aWNlXG4gKiAtIEdFVCAvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vam91cm5leXMve2pvdXJuZXlfaWR9IC0gR2V0IGpvdXJuZXkgZGV0YWlscyB3aXRoIHBvaW50c1xuICogLSBERUxFVEUgL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2pvdXJuZXlzL3tqb3VybmV5X2lkfSAtIERlbGV0ZSBhIGpvdXJuZXkgKGFkbWluL293bmVyIG9ubHkpXG4gKiAtIEdFVCAvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vbG9jYXRpb25zIC0gR2V0IGxvY2F0aW9uIGhpc3RvcnlcbiAqIC0gUE9TVCAvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vam91cm5leXMve2pvdXJuZXlfaWR9L21hdGNoIC0gVHJpZ2dlciBtYXAgbWF0Y2hpbmdcbiAqXG4gKiBOb3RlOiBXaGVuIGEgTm90ZWNhcmQgaXMgc3dhcHBlZCwgam91cm5leXMgZnJvbSBhbGwgZGV2aWNlX3VpZHMgYXJlIG1lcmdlZC5cbiAqL1xuXG5pbXBvcnQgeyBEeW5hbW9EQkNsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYic7XG5pbXBvcnQgeyBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LCBRdWVyeUNvbW1hbmQsIFVwZGF0ZUNvbW1hbmQsIERlbGV0ZUNvbW1hbmQsIEdldENvbW1hbmQsIEJhdGNoV3JpdGVDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvbGliLWR5bmFtb2RiJztcbmltcG9ydCB7IEFQSUdhdGV3YXlQcm94eUV2ZW50LCBBUElHYXRld2F5UHJveHlFdmVudFYyLCBBUElHYXRld2F5UHJveHlSZXN1bHQgfSBmcm9tICdhd3MtbGFtYmRhJztcbmltcG9ydCB7IHJlc29sdmVEZXZpY2UgfSBmcm9tICcuLi9zaGFyZWQvZGV2aWNlLWxvb2t1cCc7XG5cbi8vIFR5cGUgZm9yIGxvY2F0aW9uIHBvaW50IGl0ZW1zIGZyb20gRHluYW1vREJcbmludGVyZmFjZSBMb2NhdGlvblBvaW50IHtcbiAgZGV2aWNlX3VpZDogc3RyaW5nO1xuICB0aW1lc3RhbXA6IG51bWJlcjtcbiAgbGF0aXR1ZGU6IG51bWJlcjtcbiAgbG9uZ2l0dWRlOiBudW1iZXI7XG4gIHZlbG9jaXR5PzogbnVtYmVyO1xuICBiZWFyaW5nPzogbnVtYmVyO1xuICBkaXN0YW5jZT86IG51bWJlcjtcbiAgZG9wPzogbnVtYmVyO1xuICBqY291bnQ/OiBudW1iZXI7XG4gIGpvdXJuZXlfaWQ/OiBudW1iZXI7XG4gIHNvdXJjZT86IHN0cmluZztcbiAgbG9jYXRpb25fbmFtZT86IHN0cmluZztcbiAgZXZlbnRfdHlwZT86IHN0cmluZztcbn1cblxuLy8gVHlwZSBmb3IgdGVsZW1ldHJ5IGl0ZW1zIHdpdGggcG93ZXIgcmVhZGluZ3NcbmludGVyZmFjZSBUZWxlbWV0cnlJdGVtIHtcbiAgbWlsbGlhbXBfaG91cnM/OiBudW1iZXI7XG4gIFtrZXk6IHN0cmluZ106IHVua25vd247XG59XG5cbi8vIEdlb0pTT04gTGluZVN0cmluZyB0eXBlXG5pbnRlcmZhY2UgR2VvSlNPTkxpbmVTdHJpbmcge1xuICB0eXBlOiAnTGluZVN0cmluZyc7XG4gIGNvb3JkaW5hdGVzOiBudW1iZXJbXVtdO1xufVxuXG4vLyBUeXBlIGZvciBNYXBib3ggTWFwIE1hdGNoaW5nIEFQSSByZXNwb25zZVxuaW50ZXJmYWNlIE1hcGJveE1hdGNoUmVzcG9uc2Uge1xuICBjb2RlOiBzdHJpbmc7XG4gIG1lc3NhZ2U/OiBzdHJpbmc7XG4gIG1hdGNoaW5ncz86IEFycmF5PHtcbiAgICBnZW9tZXRyeTogR2VvSlNPTkxpbmVTdHJpbmc7XG4gICAgY29uZmlkZW5jZTogbnVtYmVyO1xuICB9Pjtcbn1cblxuY29uc3QgZGRiQ2xpZW50ID0gbmV3IER5bmFtb0RCQ2xpZW50KHt9KTtcbmNvbnN0IGRvY0NsaWVudCA9IER5bmFtb0RCRG9jdW1lbnRDbGllbnQuZnJvbShkZGJDbGllbnQpO1xuXG5jb25zdCBKT1VSTkVZU19UQUJMRSA9IHByb2Nlc3MuZW52LkpPVVJORVlTX1RBQkxFITtcbmNvbnN0IExPQ0FUSU9OU19UQUJMRSA9IHByb2Nlc3MuZW52LkxPQ0FUSU9OU19UQUJMRSE7XG5jb25zdCBERVZJQ0VTX1RBQkxFID0gcHJvY2Vzcy5lbnYuREVWSUNFU19UQUJMRSE7XG5jb25zdCBURUxFTUVUUllfVEFCTEUgPSBwcm9jZXNzLmVudi5URUxFTUVUUllfVEFCTEUhO1xuY29uc3QgTUFQQk9YX1RPS0VOID0gcHJvY2Vzcy5lbnYuTUFQQk9YX1RPS0VOO1xuXG5leHBvcnQgY29uc3QgaGFuZGxlciA9IGFzeW5jIChldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQpOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4gPT4ge1xuICBjb25zb2xlLmxvZygnUmVxdWVzdDonLCBKU09OLnN0cmluZ2lmeShldmVudCkpO1xuXG4gIGNvbnN0IGNvcnNIZWFkZXJzID0ge1xuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nOiAnKicsXG4gICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnMnOiAnQ29udGVudC1UeXBlLEF1dGhvcml6YXRpb24nLFxuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzJzogJ0dFVCxQT1NULERFTEVURSxPUFRJT05TJyxcbiAgfTtcblxuICB0cnkge1xuICAgIGNvbnN0IG1ldGhvZCA9IChldmVudC5yZXF1ZXN0Q29udGV4dCBhcyBhbnkpPy5odHRwPy5tZXRob2QgfHwgZXZlbnQuaHR0cE1ldGhvZDtcbiAgICBjb25zdCBwYXRoID0gKGV2ZW50LnJlcXVlc3RDb250ZXh0IGFzIGFueSk/Lmh0dHA/LnBhdGggfHwgZXZlbnQucGF0aDtcblxuICAgIGlmIChtZXRob2QgPT09ICdPUFRJT05TJykge1xuICAgICAgcmV0dXJuIHsgc3RhdHVzQ29kZTogMjAwLCBoZWFkZXJzOiBjb3JzSGVhZGVycywgYm9keTogJycgfTtcbiAgICB9XG5cbiAgICBjb25zdCBzZXJpYWxOdW1iZXIgPSBldmVudC5wYXRoUGFyYW1ldGVycz8uc2VyaWFsX251bWJlcjtcbiAgICBpZiAoIXNlcmlhbE51bWJlcikge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICBoZWFkZXJzOiBjb3JzSGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ3NlcmlhbF9udW1iZXIgcmVxdWlyZWQnIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBSZXNvbHZlIHNlcmlhbF9udW1iZXIgdG8gYWxsIGFzc29jaWF0ZWQgZGV2aWNlX3VpZHNcbiAgICBjb25zdCByZXNvbHZlZCA9IGF3YWl0IHJlc29sdmVEZXZpY2Uoc2VyaWFsTnVtYmVyKTtcbiAgICBpZiAoIXJlc29sdmVkKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiA0MDQsXG4gICAgICAgIGhlYWRlcnM6IGNvcnNIZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRGV2aWNlIG5vdCBmb3VuZCcgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIGNvbnN0IGpvdXJuZXlJZCA9IGV2ZW50LnBhdGhQYXJhbWV0ZXJzPy5qb3VybmV5X2lkO1xuICAgIGNvbnN0IHF1ZXJ5UGFyYW1zID0gZXZlbnQucXVlcnlTdHJpbmdQYXJhbWV0ZXJzIHx8IHt9O1xuXG4gICAgLy8gR0VUIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9sb2NhdGlvbnMgLSBMb2NhdGlvbiBoaXN0b3J5IChtZXJnZWQgZnJvbSBhbGwgTm90ZWNhcmRzKVxuICAgIGlmIChwYXRoLmVuZHNXaXRoKCcvbG9jYXRpb25zJykpIHtcbiAgICAgIHJldHVybiBhd2FpdCBnZXRMb2NhdGlvbkhpc3RvcnkocmVzb2x2ZWQuc2VyaWFsX251bWJlciwgcmVzb2x2ZWQuYWxsX2RldmljZV91aWRzLCBxdWVyeVBhcmFtcywgY29yc0hlYWRlcnMpO1xuICAgIH1cblxuICAgIC8vIFBPU1QgL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2pvdXJuZXlzL3tqb3VybmV5X2lkfS9tYXRjaCAtIE1hcCBtYXRjaGluZ1xuICAgIC8vIE5vdGU6IEZvciBub3csIHdlIG5lZWQgdG8gZmluZCB3aGljaCBkZXZpY2VfdWlkIG93bnMgdGhpcyBqb3VybmV5XG4gICAgaWYgKHBhdGguZW5kc1dpdGgoJy9tYXRjaCcpICYmIG1ldGhvZCA9PT0gJ1BPU1QnICYmIGpvdXJuZXlJZCkge1xuICAgICAgcmV0dXJuIGF3YWl0IG1hdGNoSm91cm5leShyZXNvbHZlZC5hbGxfZGV2aWNlX3VpZHMsIHBhcnNlSW50KGpvdXJuZXlJZCksIGNvcnNIZWFkZXJzKTtcbiAgICB9XG5cbiAgICAvLyBERUxFVEUgL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2pvdXJuZXlzL3tqb3VybmV5X2lkfSAtIERlbGV0ZSBqb3VybmV5IChhZG1pbi9vd25lciBvbmx5KVxuICAgIGlmIChtZXRob2QgPT09ICdERUxFVEUnICYmIGpvdXJuZXlJZCkge1xuICAgICAgcmV0dXJuIGF3YWl0IGRlbGV0ZUpvdXJuZXkocmVzb2x2ZWQuc2VyaWFsX251bWJlciwgcmVzb2x2ZWQuYWxsX2RldmljZV91aWRzLCBwYXJzZUludChqb3VybmV5SWQpLCBldmVudCwgY29yc0hlYWRlcnMpO1xuICAgIH1cblxuICAgIC8vIEdFVCAvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vam91cm5leXMve2pvdXJuZXlfaWR9IC0gU2luZ2xlIGpvdXJuZXkgd2l0aCBwb2ludHNcbiAgICBpZiAoam91cm5leUlkKSB7XG4gICAgICByZXR1cm4gYXdhaXQgZ2V0Sm91cm5leURldGFpbChyZXNvbHZlZC5hbGxfZGV2aWNlX3VpZHMsIHBhcnNlSW50KGpvdXJuZXlJZCksIGNvcnNIZWFkZXJzKTtcbiAgICB9XG5cbiAgICAvLyBHRVQgL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2pvdXJuZXlzIC0gTGlzdCBqb3VybmV5cyAobWVyZ2VkIGZyb20gYWxsIE5vdGVjYXJkcylcbiAgICByZXR1cm4gYXdhaXQgbGlzdEpvdXJuZXlzKHJlc29sdmVkLnNlcmlhbF9udW1iZXIsIHJlc29sdmVkLmFsbF9kZXZpY2VfdWlkcywgcXVlcnlQYXJhbXMsIGNvcnNIZWFkZXJzKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvcjonLCBlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMCxcbiAgICAgIGhlYWRlcnM6IGNvcnNIZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0ludGVybmFsIHNlcnZlciBlcnJvcicgfSksXG4gICAgfTtcbiAgfVxufTtcblxuLyoqXG4gKiBMaXN0IGFsbCBqb3VybmV5cyBmb3IgYSBkZXZpY2UgKG1lcmdlZCBmcm9tIGFsbCBOb3RlY2FyZHMpXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGxpc3RKb3VybmV5cyhcbiAgc2VyaWFsTnVtYmVyOiBzdHJpbmcsXG4gIGRldmljZVVpZHM6IHN0cmluZ1tdLFxuICBxdWVyeVBhcmFtczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgdW5kZWZpbmVkPixcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgY29uc3Qgc3RhdHVzID0gcXVlcnlQYXJhbXMuc3RhdHVzOyAvLyAnYWN0aXZlJyB8ICdjb21wbGV0ZWQnIHwgdW5kZWZpbmVkIChhbGwpXG4gIGNvbnN0IGxpbWl0ID0gcGFyc2VJbnQocXVlcnlQYXJhbXMubGltaXQgfHwgJzUwJyk7XG5cbiAgLy8gUXVlcnkgYWxsIGRldmljZV91aWRzIGluIHBhcmFsbGVsXG4gIGNvbnN0IHF1ZXJ5UHJvbWlzZXMgPSBkZXZpY2VVaWRzLm1hcChhc3luYyAoZGV2aWNlVWlkKSA9PiB7XG4gICAgY29uc3QgY29tbWFuZCA9IG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkID0gOmRldmljZV91aWQnLFxuICAgICAgLi4uKHN0YXR1cyAmJiB7XG4gICAgICAgIEZpbHRlckV4cHJlc3Npb246ICcjc3RhdHVzID0gOnN0YXR1cycsXG4gICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczogeyAnI3N0YXR1cyc6ICdzdGF0dXMnIH0sXG4gICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgICAnOmRldmljZV91aWQnOiBkZXZpY2VVaWQsXG4gICAgICAgICAgJzpzdGF0dXMnOiBzdGF0dXMsXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICAgIC4uLighc3RhdHVzICYmIHtcbiAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICAgU2NhbkluZGV4Rm9yd2FyZDogZmFsc2UsXG4gICAgICBMaW1pdDogbGltaXQsXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgICByZXR1cm4gcmVzdWx0Lkl0ZW1zIHx8IFtdO1xuICB9KTtcblxuICBjb25zdCBhbGxSZXN1bHRzID0gYXdhaXQgUHJvbWlzZS5hbGwocXVlcnlQcm9taXNlcyk7XG5cbiAgLy8gTWVyZ2UgYW5kIHNvcnQgYnkgam91cm5leV9pZCAod2hpY2ggaXMgdGhlIHN0YXJ0IHRpbWVzdGFtcCwgZGVzY2VuZGluZylcbiAgY29uc3QgbWVyZ2VkSm91cm5leXMgPSBhbGxSZXN1bHRzXG4gICAgLmZsYXQoKVxuICAgIC5zb3J0KChhLCBiKSA9PiBiLmpvdXJuZXlfaWQgLSBhLmpvdXJuZXlfaWQpXG4gICAgLnNsaWNlKDAsIGxpbWl0KVxuICAgIC5tYXAoKGl0ZW0pID0+ICh7XG4gICAgICBqb3VybmV5X2lkOiBpdGVtLmpvdXJuZXlfaWQsXG4gICAgICBkZXZpY2VfdWlkOiBpdGVtLmRldmljZV91aWQsXG4gICAgICBzdGFydF90aW1lOiBuZXcgRGF0ZShpdGVtLnN0YXJ0X3RpbWUpLnRvSVNPU3RyaW5nKCksXG4gICAgICBlbmRfdGltZTogaXRlbS5lbmRfdGltZSA/IG5ldyBEYXRlKGl0ZW0uZW5kX3RpbWUpLnRvSVNPU3RyaW5nKCkgOiB1bmRlZmluZWQsXG4gICAgICBwb2ludF9jb3VudDogaXRlbS5wb2ludF9jb3VudCB8fCAwLFxuICAgICAgdG90YWxfZGlzdGFuY2U6IGl0ZW0udG90YWxfZGlzdGFuY2UgfHwgMCxcbiAgICAgIHN0YXR1czogaXRlbS5zdGF0dXMsXG4gICAgfSkpO1xuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgc2VyaWFsX251bWJlcjogc2VyaWFsTnVtYmVyLFxuICAgICAgam91cm5leXM6IG1lcmdlZEpvdXJuZXlzLFxuICAgICAgY291bnQ6IG1lcmdlZEpvdXJuZXlzLmxlbmd0aCxcbiAgICB9KSxcbiAgfTtcbn1cblxuLyoqXG4gKiBHZXQgYSBzaW5nbGUgam91cm5leSB3aXRoIGFsbCBpdHMgbG9jYXRpb24gcG9pbnRzXG4gKiBTZWFyY2hlcyBhY3Jvc3MgYWxsIGRldmljZV91aWRzIHRvIGZpbmQgdGhlIGpvdXJuZXlcbiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2V0Sm91cm5leURldGFpbChcbiAgZGV2aWNlVWlkczogc3RyaW5nW10sXG4gIGpvdXJuZXlJZDogbnVtYmVyLFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICAvLyBTZWFyY2ggZm9yIHRoZSBqb3VybmV5IGFjcm9zcyBhbGwgZGV2aWNlX3VpZHNcbiAgbGV0IGpvdXJuZXlJdGVtOiBhbnkgPSBudWxsO1xuICBsZXQgb3duZXJEZXZpY2VVaWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4gIGZvciAoY29uc3QgZGV2aWNlVWlkIG9mIGRldmljZVVpZHMpIHtcbiAgICBjb25zdCBqb3VybmV5Q29tbWFuZCA9IG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkID0gOmRldmljZV91aWQgQU5EIGpvdXJuZXlfaWQgPSA6am91cm5leV9pZCcsXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICAgICAgJzpqb3VybmV5X2lkJzogam91cm5leUlkLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGpvdXJuZXlSZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChqb3VybmV5Q29tbWFuZCk7XG5cbiAgICBpZiAoam91cm5leVJlc3VsdC5JdGVtcyAmJiBqb3VybmV5UmVzdWx0Lkl0ZW1zLmxlbmd0aCA+IDApIHtcbiAgICAgIGpvdXJuZXlJdGVtID0gam91cm5leVJlc3VsdC5JdGVtc1swXTtcbiAgICAgIG93bmVyRGV2aWNlVWlkID0gZGV2aWNlVWlkO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG5cbiAgaWYgKCFqb3VybmV5SXRlbSB8fCAhb3duZXJEZXZpY2VVaWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdKb3VybmV5IG5vdCBmb3VuZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8vIEdldCBhbGwgbG9jYXRpb24gcG9pbnRzIGZvciB0aGlzIGpvdXJuZXkgdXNpbmcgdGhlIGpvdXJuZXktaW5kZXggR1NJXG4gIGNvbnN0IHBvaW50c0NvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IExPQ0FUSU9OU19UQUJMRSxcbiAgICBJbmRleE5hbWU6ICdqb3VybmV5LWluZGV4JyxcbiAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCBqb3VybmV5X2lkID0gOmpvdXJuZXlfaWQnLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6ZGV2aWNlX3VpZCc6IG93bmVyRGV2aWNlVWlkLFxuICAgICAgJzpqb3VybmV5X2lkJzogam91cm5leUlkLFxuICAgIH0sXG4gICAgU2NhbkluZGV4Rm9yd2FyZDogdHJ1ZSwgLy8gQ2hyb25vbG9naWNhbCBvcmRlclxuICB9KTtcblxuICBjb25zdCBwb2ludHNSZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChwb2ludHNDb21tYW5kKTtcblxuICBjb25zdCBzdGFydFRpbWUgPSBqb3VybmV5SXRlbS5zdGFydF90aW1lO1xuICBjb25zdCBlbmRUaW1lID0gam91cm5leUl0ZW0uZW5kX3RpbWUgfHwgRGF0ZS5ub3coKTtcblxuICBjb25zdCBqb3VybmV5ID0ge1xuICAgIGpvdXJuZXlfaWQ6IGpvdXJuZXlJdGVtLmpvdXJuZXlfaWQsXG4gICAgZGV2aWNlX3VpZDogam91cm5leUl0ZW0uZGV2aWNlX3VpZCxcbiAgICBzdGFydF90aW1lOiBuZXcgRGF0ZShzdGFydFRpbWUpLnRvSVNPU3RyaW5nKCksXG4gICAgZW5kX3RpbWU6IGpvdXJuZXlJdGVtLmVuZF90aW1lID8gbmV3IERhdGUoam91cm5leUl0ZW0uZW5kX3RpbWUpLnRvSVNPU3RyaW5nKCkgOiB1bmRlZmluZWQsXG4gICAgcG9pbnRfY291bnQ6IGpvdXJuZXlJdGVtLnBvaW50X2NvdW50IHx8IDAsXG4gICAgdG90YWxfZGlzdGFuY2U6IGpvdXJuZXlJdGVtLnRvdGFsX2Rpc3RhbmNlIHx8IDAsXG4gICAgc3RhdHVzOiBqb3VybmV5SXRlbS5zdGF0dXMsXG4gICAgbWF0Y2hlZF9yb3V0ZTogam91cm5leUl0ZW0ubWF0Y2hlZF9yb3V0ZSwgLy8gR2VvSlNPTiBMaW5lU3RyaW5nIGlmIG1hcC1tYXRjaGVkXG4gICAgbWF0Y2hlZF9wb2ludHNfY291bnQ6IGpvdXJuZXlJdGVtLm1hdGNoZWRfcG9pbnRzX2NvdW50LCAvLyBQb2ludHMgY291bnQgd2hlbiByb3V0ZSB3YXMgbWF0Y2hlZFxuICB9O1xuXG4gIC8vIFNvcnQgcG9pbnRzIGJ5IHRpbWVzdGFtcCAoR1NJIGRvZXNuJ3QgZ3VhcmFudGVlIG9yZGVyIHdpdGhpbiBzYW1lIGpvdXJuZXlfaWQpXG4gIGNvbnN0IHNvcnRlZEl0ZW1zID0gKChwb2ludHNSZXN1bHQuSXRlbXMgfHwgW10pIGFzIExvY2F0aW9uUG9pbnRbXSkuc29ydCgoYSwgYikgPT4gYS50aW1lc3RhbXAgLSBiLnRpbWVzdGFtcCk7XG5cbiAgY29uc3QgcG9pbnRzID0gc29ydGVkSXRlbXMubWFwKChpdGVtKSA9PiAoe1xuICAgIHRpbWU6IG5ldyBEYXRlKGl0ZW0udGltZXN0YW1wKS50b0lTT1N0cmluZygpLFxuICAgIGxhdDogaXRlbS5sYXRpdHVkZSxcbiAgICBsb246IGl0ZW0ubG9uZ2l0dWRlLFxuICAgIHZlbG9jaXR5OiBpdGVtLnZlbG9jaXR5LFxuICAgIGJlYXJpbmc6IGl0ZW0uYmVhcmluZyxcbiAgICBkaXN0YW5jZTogaXRlbS5kaXN0YW5jZSxcbiAgICBkb3A6IGl0ZW0uZG9wLFxuICAgIGpjb3VudDogaXRlbS5qY291bnQsXG4gIH0pKTtcblxuICAvLyBHZXQgcG93ZXIgY29uc3VtcHRpb24gZm9yIHRoaXMgam91cm5leVxuICBjb25zdCBwb3dlciA9IGF3YWl0IGdldEpvdXJuZXlQb3dlckNvbnN1bXB0aW9uKG93bmVyRGV2aWNlVWlkLCBzdGFydFRpbWUsIGVuZFRpbWUpO1xuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgam91cm5leSxcbiAgICAgIHBvaW50cyxcbiAgICAgIHBvd2VyLFxuICAgIH0pLFxuICB9O1xufVxuXG4vKipcbiAqIENhbGwgTWFwYm94IE1hcCBNYXRjaGluZyBBUEkgYW5kIGNhY2hlIHRoZSByZXN1bHRcbiAqIFNlYXJjaGVzIGFjcm9zcyBhbGwgZGV2aWNlX3VpZHMgdG8gZmluZCB0aGUgam91cm5leVxuICovXG5hc3luYyBmdW5jdGlvbiBtYXRjaEpvdXJuZXkoXG4gIGRldmljZVVpZHM6IHN0cmluZ1tdLFxuICBqb3VybmV5SWQ6IG51bWJlcixcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgaWYgKCFNQVBCT1hfVE9LRU4pIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNTAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdNYXAgbWF0Y2hpbmcgbm90IGNvbmZpZ3VyZWQnIH0pLFxuICAgIH07XG4gIH1cblxuICAvLyBGaW5kIHdoaWNoIGRldmljZV91aWQgb3ducyB0aGlzIGpvdXJuZXlcbiAgbGV0IG93bmVyRGV2aWNlVWlkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuICBmb3IgKGNvbnN0IGRldmljZVVpZCBvZiBkZXZpY2VVaWRzKSB7XG4gICAgY29uc3Qgam91cm5leUNvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogSk9VUk5FWVNfVEFCTEUsXG4gICAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCBqb3VybmV5X2lkID0gOmpvdXJuZXlfaWQnLFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAnOmRldmljZV91aWQnOiBkZXZpY2VVaWQsXG4gICAgICAgICc6am91cm5leV9pZCc6IGpvdXJuZXlJZCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBqb3VybmV5UmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoam91cm5leUNvbW1hbmQpO1xuXG4gICAgaWYgKGpvdXJuZXlSZXN1bHQuSXRlbXMgJiYgam91cm5leVJlc3VsdC5JdGVtcy5sZW5ndGggPiAwKSB7XG4gICAgICBvd25lckRldmljZVVpZCA9IGRldmljZVVpZDtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIGlmICghb3duZXJEZXZpY2VVaWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdKb3VybmV5IG5vdCBmb3VuZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8vIEdldCB0aGUgam91cm5leSBwb2ludHNcbiAgY29uc3QgcG9pbnRzQ29tbWFuZCA9IG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogTE9DQVRJT05TX1RBQkxFLFxuICAgIEluZGV4TmFtZTogJ2pvdXJuZXktaW5kZXgnLFxuICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkID0gOmRldmljZV91aWQgQU5EIGpvdXJuZXlfaWQgPSA6am91cm5leV9pZCcsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzpkZXZpY2VfdWlkJzogb3duZXJEZXZpY2VVaWQsXG4gICAgICAnOmpvdXJuZXlfaWQnOiBqb3VybmV5SWQsXG4gICAgfSxcbiAgICBTY2FuSW5kZXhGb3J3YXJkOiB0cnVlLFxuICB9KTtcblxuICBjb25zdCBwb2ludHNSZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChwb2ludHNDb21tYW5kKTtcblxuICAvLyBTb3J0IHBvaW50cyBieSB0aW1lc3RhbXAgKEdTSSBkb2Vzbid0IGd1YXJhbnRlZSBvcmRlciB3aXRoaW4gc2FtZSBqb3VybmV5X2lkKVxuICBjb25zdCBwb2ludHMgPSAoKHBvaW50c1Jlc3VsdC5JdGVtcyB8fCBbXSkgYXMgTG9jYXRpb25Qb2ludFtdKS5zb3J0KChhLCBiKSA9PiBhLnRpbWVzdGFtcCAtIGIudGltZXN0YW1wKTtcblxuICBpZiAocG9pbnRzLmxlbmd0aCA8IDIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdKb3VybmV5IGhhcyBmZXdlciB0aGFuIDIgcG9pbnRzJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gTWFwYm94IE1hcCBNYXRjaGluZyBBUEkgaGFzIGEgbGltaXQgb2YgMTAwIGNvb3JkaW5hdGVzIHBlciByZXF1ZXN0XG4gIC8vIElmIHdlIGhhdmUgbW9yZSwgd2UgbmVlZCB0byBzYW1wbGUgb3IgYmF0Y2hcbiAgY29uc3QgbWF4UG9pbnRzID0gMTAwO1xuICBsZXQgc2FtcGxlZFBvaW50czogTG9jYXRpb25Qb2ludFtdID0gcG9pbnRzO1xuICBpZiAocG9pbnRzLmxlbmd0aCA+IG1heFBvaW50cykge1xuICAgIC8vIFNhbXBsZSBwb2ludHMgZXZlbmx5XG4gICAgY29uc3Qgc3RlcCA9IChwb2ludHMubGVuZ3RoIC0gMSkgLyAobWF4UG9pbnRzIC0gMSk7XG4gICAgc2FtcGxlZFBvaW50cyA9IFtdO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgbWF4UG9pbnRzOyBpKyspIHtcbiAgICAgIGNvbnN0IGlkeCA9IE1hdGgucm91bmQoaSAqIHN0ZXApO1xuICAgICAgc2FtcGxlZFBvaW50cy5wdXNoKHBvaW50c1tpZHhdKTtcbiAgICB9XG4gIH1cblxuICAvLyBGb3JtYXQgY29vcmRpbmF0ZXMgZm9yIE1hcGJveCBBUEk6IGxvbixsYXQ7bG9uLGxhdDsuLi5cbiAgY29uc3QgY29vcmRpbmF0ZXMgPSBzYW1wbGVkUG9pbnRzXG4gICAgLm1hcCgocCkgPT4gYCR7cC5sb25naXR1ZGV9LCR7cC5sYXRpdHVkZX1gKVxuICAgIC5qb2luKCc7Jyk7XG5cbiAgLy8gQnVpbGQgdGhlIHRpbWVzdGFtcHMgcGFyYW1ldGVyIChVbml4IHRpbWVzdGFtcHMgaW4gc2Vjb25kcylcbiAgY29uc3QgdGltZXN0YW1wcyA9IHNhbXBsZWRQb2ludHNcbiAgICAubWFwKChwKSA9PiBNYXRoLmZsb29yKHAudGltZXN0YW1wIC8gMTAwMCkpXG4gICAgLmpvaW4oJzsnKTtcblxuICAvLyBCdWlsZCB0aGUgcmFkaXVzZXMgcGFyYW1ldGVyIChHUFMgYWNjdXJhY3kgaW4gbWV0ZXJzLCBkZWZhdWx0IDI1bSlcbiAgY29uc3QgcmFkaXVzZXMgPSBzYW1wbGVkUG9pbnRzXG4gICAgLm1hcCgocCkgPT4gKHAuZG9wID8gTWF0aC5tYXgoNSwgcC5kb3AgKiAxMCkgOiAyNSkpXG4gICAgLmpvaW4oJzsnKTtcblxuICAvLyBDYWxsIE1hcGJveCBNYXAgTWF0Y2hpbmcgQVBJXG4gIGNvbnN0IG1hcE1hdGNoVXJsID0gYGh0dHBzOi8vYXBpLm1hcGJveC5jb20vbWF0Y2hpbmcvdjUvbWFwYm94L2RyaXZpbmcvJHtjb29yZGluYXRlc30/YWNjZXNzX3Rva2VuPSR7TUFQQk9YX1RPS0VOfSZnZW9tZXRyaWVzPWdlb2pzb24mcmFkaXVzZXM9JHtyYWRpdXNlc30mdGltZXN0YW1wcz0ke3RpbWVzdGFtcHN9Jm92ZXJ2aWV3PWZ1bGwmc3RlcHM9ZmFsc2VgO1xuXG4gIGNvbnNvbGUubG9nKGBDYWxsaW5nIE1hcGJveCBNYXAgTWF0Y2hpbmcgQVBJIGZvciBqb3VybmV5ICR7am91cm5leUlkfSB3aXRoICR7c2FtcGxlZFBvaW50cy5sZW5ndGh9IHBvaW50c2ApO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChtYXBNYXRjaFVybCk7XG4gICAgY29uc3QgZGF0YSA9IGF3YWl0IHJlc3BvbnNlLmpzb24oKSBhcyBNYXBib3hNYXRjaFJlc3BvbnNlO1xuXG4gICAgaWYgKGRhdGEuY29kZSAhPT0gJ09rJyB8fCAhZGF0YS5tYXRjaGluZ3MgfHwgZGF0YS5tYXRjaGluZ3MubGVuZ3RoID09PSAwKSB7XG4gICAgICBjb25zb2xlLmVycm9yKCdNYXAgbWF0Y2hpbmcgZmFpbGVkOicsIGRhdGEpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgZXJyb3I6ICdNYXAgbWF0Y2hpbmcgZmFpbGVkJyxcbiAgICAgICAgICBjb2RlOiBkYXRhLmNvZGUsXG4gICAgICAgICAgbWVzc2FnZTogZGF0YS5tZXNzYWdlLFxuICAgICAgICB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gR2V0IHRoZSBtYXRjaGVkIGdlb21ldHJ5IChHZW9KU09OIExpbmVTdHJpbmcpXG4gICAgY29uc3QgbWF0Y2hlZFJvdXRlID0gZGF0YS5tYXRjaGluZ3NbMF0uZ2VvbWV0cnk7XG4gICAgY29uc3QgY29uZmlkZW5jZSA9IGRhdGEubWF0Y2hpbmdzWzBdLmNvbmZpZGVuY2U7XG5cbiAgICAvLyBTdG9yZSB0aGUgbWF0Y2hlZCByb3V0ZSBpbiBEeW5hbW9EQiAoaW5jbHVkZSBwb2ludCBjb3VudCBmb3IgY2FjaGUgaW52YWxpZGF0aW9uKVxuICAgIGNvbnN0IHVwZGF0ZUNvbW1hbmQgPSBuZXcgVXBkYXRlQ29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IEpPVVJORVlTX1RBQkxFLFxuICAgICAgS2V5OiB7XG4gICAgICAgIGRldmljZV91aWQ6IG93bmVyRGV2aWNlVWlkLFxuICAgICAgICBqb3VybmV5X2lkOiBqb3VybmV5SWQsXG4gICAgICB9LFxuICAgICAgVXBkYXRlRXhwcmVzc2lvbjogJ1NFVCBtYXRjaGVkX3JvdXRlID0gOnJvdXRlLCBtYXRjaF9jb25maWRlbmNlID0gOmNvbmZpZGVuY2UsIG1hdGNoZWRfYXQgPSA6dGltZSwgbWF0Y2hlZF9wb2ludHNfY291bnQgPSA6Y291bnQnLFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAnOnJvdXRlJzogbWF0Y2hlZFJvdXRlLFxuICAgICAgICAnOmNvbmZpZGVuY2UnOiBjb25maWRlbmNlLFxuICAgICAgICAnOnRpbWUnOiBEYXRlLm5vdygpLFxuICAgICAgICAnOmNvdW50JzogcG9pbnRzLmxlbmd0aCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBhd2FpdCBkb2NDbGllbnQuc2VuZCh1cGRhdGVDb21tYW5kKTtcbiAgICBjb25zb2xlLmxvZyhgU3RvcmVkIG1hdGNoZWQgcm91dGUgZm9yIGpvdXJuZXkgJHtqb3VybmV5SWR9IHdpdGggY29uZmlkZW5jZSAke2NvbmZpZGVuY2V9YCk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgbWF0Y2hlZF9yb3V0ZTogbWF0Y2hlZFJvdXRlLFxuICAgICAgICBjb25maWRlbmNlLFxuICAgICAgICBvcmlnaW5hbF9wb2ludHM6IHBvaW50cy5sZW5ndGgsXG4gICAgICAgIG1hdGNoZWRfcG9pbnRzOiBzYW1wbGVkUG9pbnRzLmxlbmd0aCxcbiAgICAgIH0pLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3IgY2FsbGluZyBNYXBib3ggQVBJOicsIGVycm9yKTtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNTAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdGYWlsZWQgdG8gY2FsbCBtYXAgbWF0Y2hpbmcgQVBJJyB9KSxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogR2V0IGxvY2F0aW9uIGhpc3RvcnkgZm9yIGEgZGV2aWNlIChtZXJnZWQgZnJvbSBhbGwgTm90ZWNhcmRzKVxuICovXG5hc3luYyBmdW5jdGlvbiBnZXRMb2NhdGlvbkhpc3RvcnkoXG4gIHNlcmlhbE51bWJlcjogc3RyaW5nLFxuICBkZXZpY2VVaWRzOiBzdHJpbmdbXSxcbiAgcXVlcnlQYXJhbXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD4sXG4gIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiB7XG4gIGNvbnN0IGhvdXJzID0gcGFyc2VJbnQocXVlcnlQYXJhbXMuaG91cnMgfHwgJzI0Jyk7XG4gIGNvbnN0IHNvdXJjZSA9IHF1ZXJ5UGFyYW1zLnNvdXJjZTsgLy8gJ2dwcycgfCAnY2VsbCcgfCAndHJpYW5ndWxhdGlvbicgfCB1bmRlZmluZWQgKGFsbClcbiAgY29uc3QgbGltaXQgPSBwYXJzZUludChxdWVyeVBhcmFtcy5saW1pdCB8fCAnMTAwMCcpO1xuXG4gIGNvbnN0IGN1dG9mZlRpbWUgPSBEYXRlLm5vdygpIC0gaG91cnMgKiA2MCAqIDYwICogMTAwMDtcblxuICAvLyBRdWVyeSBhbGwgZGV2aWNlX3VpZHMgaW4gcGFyYWxsZWxcbiAgY29uc3QgcXVlcnlQcm9taXNlcyA9IGRldmljZVVpZHMubWFwKGFzeW5jIChkZXZpY2VVaWQpID0+IHtcbiAgICBjb25zdCBjb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IExPQ0FUSU9OU19UQUJMRSxcbiAgICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkID0gOmRldmljZV91aWQgQU5EICN0aW1lc3RhbXAgPj0gOmN1dG9mZicsXG4gICAgICAuLi4oc291cmNlICYmIHtcbiAgICAgICAgRmlsdGVyRXhwcmVzc2lvbjogJyNzb3VyY2UgPSA6c291cmNlJyxcbiAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAgICAgJyN0aW1lc3RhbXAnOiAndGltZXN0YW1wJyxcbiAgICAgICAgICAnI3NvdXJjZSc6ICdzb3VyY2UnLFxuICAgICAgICB9LFxuICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgICAgICc6Y3V0b2ZmJzogY3V0b2ZmVGltZSxcbiAgICAgICAgICAnOnNvdXJjZSc6IHNvdXJjZSxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICAgLi4uKCFzb3VyY2UgJiYge1xuICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICAgICAnI3RpbWVzdGFtcCc6ICd0aW1lc3RhbXAnLFxuICAgICAgICB9LFxuICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgICAgICc6Y3V0b2ZmJzogY3V0b2ZmVGltZSxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICAgU2NhbkluZGV4Rm9yd2FyZDogZmFsc2UsXG4gICAgICBMaW1pdDogbGltaXQsXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgICByZXR1cm4gcmVzdWx0Lkl0ZW1zIHx8IFtdO1xuICB9KTtcblxuICBjb25zdCBhbGxSZXN1bHRzID0gYXdhaXQgUHJvbWlzZS5hbGwocXVlcnlQcm9taXNlcyk7XG5cbiAgLy8gTWVyZ2UgYW5kIHNvcnQgYnkgdGltZXN0YW1wIChtb3N0IHJlY2VudCBmaXJzdCksIHRoZW4gYXBwbHkgbGltaXRcbiAgY29uc3QgbWVyZ2VkTG9jYXRpb25zID0gYWxsUmVzdWx0c1xuICAgIC5mbGF0KClcbiAgICAuc29ydCgoYSwgYikgPT4gYi50aW1lc3RhbXAgLSBhLnRpbWVzdGFtcClcbiAgICAuc2xpY2UoMCwgbGltaXQpXG4gICAgLm1hcCgoaXRlbSkgPT4gKHtcbiAgICAgIHRpbWU6IG5ldyBEYXRlKGl0ZW0udGltZXN0YW1wKS50b0lTT1N0cmluZygpLFxuICAgICAgbGF0OiBpdGVtLmxhdGl0dWRlLFxuICAgICAgbG9uOiBpdGVtLmxvbmdpdHVkZSxcbiAgICAgIHNvdXJjZTogaXRlbS5zb3VyY2UsXG4gICAgICBsb2NhdGlvbl9uYW1lOiBpdGVtLmxvY2F0aW9uX25hbWUsXG4gICAgICBldmVudF90eXBlOiBpdGVtLmV2ZW50X3R5cGUsXG4gICAgICBqb3VybmV5X2lkOiBpdGVtLmpvdXJuZXlfaWQsXG4gICAgICBqY291bnQ6IGl0ZW0uamNvdW50LFxuICAgICAgdmVsb2NpdHk6IGl0ZW0udmVsb2NpdHksXG4gICAgICBiZWFyaW5nOiBpdGVtLmJlYXJpbmcsXG4gICAgfSkpO1xuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgc2VyaWFsX251bWJlcjogc2VyaWFsTnVtYmVyLFxuICAgICAgaG91cnMsXG4gICAgICBjb3VudDogbWVyZ2VkTG9jYXRpb25zLmxlbmd0aCxcbiAgICAgIGxvY2F0aW9uczogbWVyZ2VkTG9jYXRpb25zLFxuICAgIH0pLFxuICB9O1xufVxuXG4vKipcbiAqIENoZWNrIGlmIHRoZSB1c2VyIGlzIGFuIGFkbWluIChpbiAnQWRtaW4nIENvZ25pdG8gZ3JvdXApXG4gKi9cbmZ1bmN0aW9uIGlzQWRtaW4oZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50KTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgY29uc3QgY2xhaW1zID0gKGV2ZW50LnJlcXVlc3RDb250ZXh0IGFzIGFueSk/LmF1dGhvcml6ZXI/Lmp3dD8uY2xhaW1zO1xuICAgIGlmICghY2xhaW1zKSByZXR1cm4gZmFsc2U7XG5cbiAgICBjb25zdCBncm91cHMgPSBjbGFpbXNbJ2NvZ25pdG86Z3JvdXBzJ107XG4gICAgaWYgKEFycmF5LmlzQXJyYXkoZ3JvdXBzKSkge1xuICAgICAgcmV0dXJuIGdyb3Vwcy5pbmNsdWRlcygnQWRtaW4nKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBncm91cHMgPT09ICdzdHJpbmcnKSB7XG4gICAgICByZXR1cm4gZ3JvdXBzID09PSAnQWRtaW4nIHx8IGdyb3Vwcy5pbmNsdWRlcygnQWRtaW4nKTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqXG4gKiBHZXQgdGhlIHVzZXIncyBlbWFpbCBmcm9tIHRoZSBKV1QgY2xhaW1zXG4gKi9cbmZ1bmN0aW9uIGdldFVzZXJFbWFpbChldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICB0cnkge1xuICAgIGNvbnN0IGNsYWltcyA9IChldmVudC5yZXF1ZXN0Q29udGV4dCBhcyBhbnkpPy5hdXRob3JpemVyPy5qd3Q/LmNsYWltcztcbiAgICByZXR1cm4gY2xhaW1zPy5lbWFpbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxufVxuXG4vKipcbiAqIENoZWNrIGlmIHRoZSB1c2VyIG93bnMgdGhlIGRldmljZSAoaXMgYXNzaWduZWQgdG8gaXQpXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGlzRGV2aWNlT3duZXIoZGV2aWNlVWlkOiBzdHJpbmcsIHVzZXJFbWFpbDogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgR2V0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgIEtleTogeyBkZXZpY2VfdWlkOiBkZXZpY2VVaWQgfSxcbiAgICBQcm9qZWN0aW9uRXhwcmVzc2lvbjogJ2Fzc2lnbmVkX3RvJyxcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIHJldHVybiByZXN1bHQuSXRlbT8uYXNzaWduZWRfdG8gPT09IHVzZXJFbWFpbDtcbn1cblxuLyoqXG4gKiBEZWxldGUgYSBqb3VybmV5IGFuZCBhbGwgaXRzIGxvY2F0aW9uIHBvaW50cyAoYWRtaW4vb3duZXIgb25seSlcbiAqIFNlYXJjaGVzIGFjcm9zcyBhbGwgZGV2aWNlX3VpZHMgdG8gZmluZCBhbmQgZGVsZXRlIHRoZSBqb3VybmV5XG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGRlbGV0ZUpvdXJuZXkoXG4gIHNlcmlhbE51bWJlcjogc3RyaW5nLFxuICBkZXZpY2VVaWRzOiBzdHJpbmdbXSxcbiAgam91cm5leUlkOiBudW1iZXIsXG4gIGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudCxcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgLy8gQXV0aG9yaXphdGlvbiBjaGVjazogbXVzdCBiZSBhZG1pbiBvciBkZXZpY2Ugb3duZXJcbiAgY29uc3QgdXNlckVtYWlsID0gZ2V0VXNlckVtYWlsKGV2ZW50KTtcbiAgY29uc3QgYWRtaW4gPSBpc0FkbWluKGV2ZW50KTtcblxuICAvLyBGaW5kIHdoaWNoIGRldmljZV91aWQgb3ducyB0aGlzIGpvdXJuZXlcbiAgbGV0IG93bmVyRGV2aWNlVWlkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuICBmb3IgKGNvbnN0IGRldmljZVVpZCBvZiBkZXZpY2VVaWRzKSB7XG4gICAgY29uc3Qgam91cm5leUNvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogSk9VUk5FWVNfVEFCTEUsXG4gICAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCBqb3VybmV5X2lkID0gOmpvdXJuZXlfaWQnLFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAnOmRldmljZV91aWQnOiBkZXZpY2VVaWQsXG4gICAgICAgICc6am91cm5leV9pZCc6IGpvdXJuZXlJZCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBqb3VybmV5UmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoam91cm5leUNvbW1hbmQpO1xuXG4gICAgaWYgKGpvdXJuZXlSZXN1bHQuSXRlbXMgJiYgam91cm5leVJlc3VsdC5JdGVtcy5sZW5ndGggPiAwKSB7XG4gICAgICBvd25lckRldmljZVVpZCA9IGRldmljZVVpZDtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIGlmICghb3duZXJEZXZpY2VVaWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdKb3VybmV5IG5vdCBmb3VuZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIGlmICghYWRtaW4pIHtcbiAgICBpZiAoIXVzZXJFbWFpbCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDAxLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnVW5hdXRob3JpemVkJyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgY29uc3Qgb3duZXIgPSBhd2FpdCBpc0RldmljZU93bmVyKG93bmVyRGV2aWNlVWlkLCB1c2VyRW1haWwpO1xuICAgIGlmICghb3duZXIpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwMyxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0FkbWluIG9yIGRldmljZSBvd25lciBhY2Nlc3MgcmVxdWlyZWQnIH0pLFxuICAgICAgfTtcbiAgICB9XG4gIH1cblxuICAvLyBHZXQgYWxsIGxvY2F0aW9uIHBvaW50cyBmb3IgdGhpcyBqb3VybmV5IHRvIGRlbGV0ZSB0aGVtXG4gIGNvbnN0IHBvaW50c0NvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IExPQ0FUSU9OU19UQUJMRSxcbiAgICBJbmRleE5hbWU6ICdqb3VybmV5LWluZGV4JyxcbiAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCBqb3VybmV5X2lkID0gOmpvdXJuZXlfaWQnLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6ZGV2aWNlX3VpZCc6IG93bmVyRGV2aWNlVWlkLFxuICAgICAgJzpqb3VybmV5X2lkJzogam91cm5leUlkLFxuICAgIH0sXG4gICAgUHJvamVjdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkLCAjdHMnLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczoge1xuICAgICAgJyN0cyc6ICd0aW1lc3RhbXAnLFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IHBvaW50c1Jlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKHBvaW50c0NvbW1hbmQpO1xuICBjb25zdCBsb2NhdGlvblBvaW50cyA9IChwb2ludHNSZXN1bHQuSXRlbXMgfHwgW10pIGFzIExvY2F0aW9uUG9pbnRbXTtcblxuICAvLyBEZWxldGUgbG9jYXRpb24gcG9pbnRzIGluIGJhdGNoZXMgb2YgMjUgKER5bmFtb0RCIEJhdGNoV3JpdGUgbGltaXQpXG4gIGlmIChsb2NhdGlvblBvaW50cy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgYmF0Y2hlczogTG9jYXRpb25Qb2ludFtdW10gPSBbXTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGxvY2F0aW9uUG9pbnRzLmxlbmd0aDsgaSArPSAyNSkge1xuICAgICAgY29uc3QgYmF0Y2ggPSBsb2NhdGlvblBvaW50cy5zbGljZShpLCBpICsgMjUpO1xuICAgICAgYmF0Y2hlcy5wdXNoKGJhdGNoKTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IGJhdGNoIG9mIGJhdGNoZXMpIHtcbiAgICAgIGNvbnN0IGRlbGV0ZVJlcXVlc3RzID0gYmF0Y2gubWFwKChwb2ludDogTG9jYXRpb25Qb2ludCkgPT4gKHtcbiAgICAgICAgRGVsZXRlUmVxdWVzdDoge1xuICAgICAgICAgIEtleToge1xuICAgICAgICAgICAgZGV2aWNlX3VpZDogcG9pbnQuZGV2aWNlX3VpZCxcbiAgICAgICAgICAgIHRpbWVzdGFtcDogcG9pbnQudGltZXN0YW1wLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9KSk7XG5cbiAgICAgIGNvbnN0IGJhdGNoQ29tbWFuZCA9IG5ldyBCYXRjaFdyaXRlQ29tbWFuZCh7XG4gICAgICAgIFJlcXVlc3RJdGVtczoge1xuICAgICAgICAgIFtMT0NBVElPTlNfVEFCTEVdOiBkZWxldGVSZXF1ZXN0cyxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuXG4gICAgICBhd2FpdCBkb2NDbGllbnQuc2VuZChiYXRjaENvbW1hbmQpO1xuICAgIH1cblxuICAgIGNvbnNvbGUubG9nKGBEZWxldGVkICR7bG9jYXRpb25Qb2ludHMubGVuZ3RofSBsb2NhdGlvbiBwb2ludHMgZm9yIGpvdXJuZXkgJHtqb3VybmV5SWR9YCk7XG4gIH1cblxuICAvLyBEZWxldGUgdGhlIGpvdXJuZXkgcmVjb3JkXG4gIGNvbnN0IGRlbGV0ZUNvbW1hbmQgPSBuZXcgRGVsZXRlQ29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICBLZXk6IHtcbiAgICAgIGRldmljZV91aWQ6IG93bmVyRGV2aWNlVWlkLFxuICAgICAgam91cm5leV9pZDogam91cm5leUlkLFxuICAgIH0sXG4gIH0pO1xuXG4gIGF3YWl0IGRvY0NsaWVudC5zZW5kKGRlbGV0ZUNvbW1hbmQpO1xuICBjb25zb2xlLmxvZyhgRGVsZXRlZCBqb3VybmV5ICR7am91cm5leUlkfSBmb3IgZGV2aWNlICR7b3duZXJEZXZpY2VVaWR9IChzZXJpYWw6ICR7c2VyaWFsTnVtYmVyfSlgKTtcblxuICByZXR1cm4ge1xuICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICBoZWFkZXJzLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIG1lc3NhZ2U6ICdKb3VybmV5IGRlbGV0ZWQnLFxuICAgICAgam91cm5leV9pZDogam91cm5leUlkLFxuICAgICAgcG9pbnRzX2RlbGV0ZWQ6IGxvY2F0aW9uUG9pbnRzLmxlbmd0aCxcbiAgICB9KSxcbiAgfTtcbn1cblxuLyoqXG4gKiBHZXQgcG93ZXIgY29uc3VtcHRpb24gZHVyaW5nIGEgam91cm5leSB0aW1lZnJhbWVcbiAqIFF1ZXJpZXMgcG93ZXIgdGVsZW1ldHJ5IGRhdGEgYW5kIGNhbGN1bGF0ZXMgbUFoIGNvbnN1bWVkXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGdldEpvdXJuZXlQb3dlckNvbnN1bXB0aW9uKFxuICBkZXZpY2VVaWQ6IHN0cmluZyxcbiAgc3RhcnRUaW1lOiBudW1iZXIsXG4gIGVuZFRpbWU6IG51bWJlclxuKTogUHJvbWlzZTx7XG4gIHN0YXJ0X21haDogbnVtYmVyO1xuICBlbmRfbWFoOiBudW1iZXI7XG4gIGNvbnN1bWVkX21haDogbnVtYmVyO1xuICByZWFkaW5nX2NvdW50OiBudW1iZXI7XG59IHwgbnVsbD4ge1xuICAvLyBRdWVyeSBwb3dlciB0ZWxlbWV0cnkgdXNpbmcgdGhlIGV2ZW50LXR5cGUtaW5kZXggR1NJXG4gIGNvbnN0IHN0YXJ0S2V5ID0gYHBvd2VyIyR7c3RhcnRUaW1lfWA7XG4gIGNvbnN0IGVuZEtleSA9IGBwb3dlciMke2VuZFRpbWV9YDtcblxuICBjb25zdCBjb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBURUxFTUVUUllfVEFCTEUsXG4gICAgSW5kZXhOYW1lOiAnZXZlbnQtdHlwZS1pbmRleCcsXG4gICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQgPSA6ZGV2aWNlX3VpZCBBTkQgZXZlbnRfdHlwZV90aW1lc3RhbXAgQkVUV0VFTiA6c3RhcnQgQU5EIDplbmQnLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICAgICc6c3RhcnQnOiBzdGFydEtleSxcbiAgICAgICc6ZW5kJzogZW5kS2V5LFxuICAgIH0sXG4gICAgU2NhbkluZGV4Rm9yd2FyZDogdHJ1ZSwgLy8gQ2hyb25vbG9naWNhbCBvcmRlclxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgY29uc3QgcG93ZXJSZWFkaW5ncyA9IChyZXN1bHQuSXRlbXMgfHwgW10pIGFzIFRlbGVtZXRyeUl0ZW1bXTtcblxuICAvLyBOZWVkIGF0IGxlYXN0IDIgcmVhZGluZ3MgdG8gY2FsY3VsYXRlIGNvbnN1bXB0aW9uXG4gIGlmIChwb3dlclJlYWRpbmdzLmxlbmd0aCA8IDIpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIC8vIEZpbHRlciBmb3IgcmVhZGluZ3MgdGhhdCBoYXZlIG1pbGxpYW1wX2hvdXJzXG4gIGNvbnN0IHZhbGlkUmVhZGluZ3MgPSBwb3dlclJlYWRpbmdzLmZpbHRlcigocikgPT4gdHlwZW9mIHIubWlsbGlhbXBfaG91cnMgPT09ICdudW1iZXInKTtcblxuICBpZiAodmFsaWRSZWFkaW5ncy5sZW5ndGggPCAyKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICBjb25zdCBmaXJzdFJlYWRpbmcgPSB2YWxpZFJlYWRpbmdzWzBdO1xuICBjb25zdCBsYXN0UmVhZGluZyA9IHZhbGlkUmVhZGluZ3NbdmFsaWRSZWFkaW5ncy5sZW5ndGggLSAxXTtcblxuICAvLyBXZSBrbm93IHRoZXNlIGFyZSBudW1iZXJzIHNpbmNlIHdlIGZpbHRlcmVkIGZvciB0aGVtIGFib3ZlXG4gIGNvbnN0IHN0YXJ0TWFoID0gZmlyc3RSZWFkaW5nLm1pbGxpYW1wX2hvdXJzITtcbiAgY29uc3QgZW5kTWFoID0gbGFzdFJlYWRpbmcubWlsbGlhbXBfaG91cnMhO1xuXG4gIC8vIENhbGN1bGF0ZSBjb25zdW1wdGlvbiAoaGFuZGxlIGNvdW50ZXIgcmVzZXQgZWRnZSBjYXNlKVxuICBsZXQgY29uc3VtZWRNYWggPSBlbmRNYWggLSBzdGFydE1haDtcbiAgaWYgKGNvbnN1bWVkTWFoIDwgMCkge1xuICAgIC8vIENvdW50ZXIgd2FzIHJlc2V0IGR1cmluZyBqb3VybmV5IC0gY2FuJ3QgY2FsY3VsYXRlIGFjY3VyYXRlbHlcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgc3RhcnRfbWFoOiBNYXRoLnJvdW5kKHN0YXJ0TWFoICogMTAwKSAvIDEwMCxcbiAgICBlbmRfbWFoOiBNYXRoLnJvdW5kKGVuZE1haCAqIDEwMCkgLyAxMDAsXG4gICAgY29uc3VtZWRfbWFoOiBNYXRoLnJvdW5kKGNvbnN1bWVkTWFoICogMTAwKSAvIDEwMCxcbiAgICByZWFkaW5nX2NvdW50OiB2YWxpZFJlYWRpbmdzLmxlbmd0aCxcbiAgfTtcbn1cbiJdfQ==