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
        // Store the matched route in DynamoDB
        const updateCommand = new lib_dynamodb_1.UpdateCommand({
            TableName: JOURNEYS_TABLE,
            Key: {
                device_uid: ownerDeviceUid,
                journey_id: journeyId,
            },
            UpdateExpression: 'SET matched_route = :route, match_confidence = :confidence, matched_at = :time',
            ExpressionAttributeValues: {
                ':route': matchedRoute,
                ':confidence': confidence,
                ':time': Date.now(),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWpvdXJuZXlzL2luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7R0FXRzs7O0FBRUgsOERBQTBEO0FBQzFELHdEQUEwSTtBQUUxSSwyREFBd0Q7QUF5Q3hELE1BQU0sU0FBUyxHQUFHLElBQUksZ0NBQWMsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN6QyxNQUFNLFNBQVMsR0FBRyxxQ0FBc0IsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7QUFFekQsTUFBTSxjQUFjLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFlLENBQUM7QUFDbkQsTUFBTSxlQUFlLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxlQUFnQixDQUFDO0FBQ3JELE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsYUFBYyxDQUFDO0FBQ2pELE1BQU0sZUFBZSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsZUFBZ0IsQ0FBQztBQUNyRCxNQUFNLFlBQVksR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLFlBQVksQ0FBQztBQUV2QyxNQUFNLE9BQU8sR0FBRyxLQUFLLEVBQUUsS0FBMkIsRUFBa0MsRUFBRTtJQUMzRixPQUFPLENBQUMsR0FBRyxDQUFDLFVBQVUsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFFL0MsTUFBTSxXQUFXLEdBQUc7UUFDbEIsNkJBQTZCLEVBQUUsR0FBRztRQUNsQyw4QkFBOEIsRUFBRSw0QkFBNEI7UUFDNUQsOEJBQThCLEVBQUUseUJBQXlCO0tBQzFELENBQUM7SUFFRixJQUFJLENBQUM7UUFDSCxNQUFNLE1BQU0sR0FBSSxLQUFLLENBQUMsY0FBc0IsRUFBRSxJQUFJLEVBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUM7UUFDL0UsTUFBTSxJQUFJLEdBQUksS0FB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LGFBQWEsQ0FBQyxNQUFNO0tBQ3BDLENBQUM7QUFDSixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBKb3VybmV5cyBBUEkgTGFtYmRhXG4gKlxuICogSGFuZGxlcyBqb3VybmV5IGFuZCBsb2NhdGlvbiBoaXN0b3J5IHF1ZXJpZXM6XG4gKiAtIEdFVCAvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vam91cm5leXMgLSBMaXN0IGFsbCBqb3VybmV5cyBmb3IgYSBkZXZpY2VcbiAqIC0gR0VUIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9qb3VybmV5cy97am91cm5leV9pZH0gLSBHZXQgam91cm5leSBkZXRhaWxzIHdpdGggcG9pbnRzXG4gKiAtIERFTEVURSAvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vam91cm5leXMve2pvdXJuZXlfaWR9IC0gRGVsZXRlIGEgam91cm5leSAoYWRtaW4vb3duZXIgb25seSlcbiAqIC0gR0VUIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9sb2NhdGlvbnMgLSBHZXQgbG9jYXRpb24gaGlzdG9yeVxuICogLSBQT1NUIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9qb3VybmV5cy97am91cm5leV9pZH0vbWF0Y2ggLSBUcmlnZ2VyIG1hcCBtYXRjaGluZ1xuICpcbiAqIE5vdGU6IFdoZW4gYSBOb3RlY2FyZCBpcyBzd2FwcGVkLCBqb3VybmV5cyBmcm9tIGFsbCBkZXZpY2VfdWlkcyBhcmUgbWVyZ2VkLlxuICovXG5cbmltcG9ydCB7IER5bmFtb0RCQ2xpZW50IH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LWR5bmFtb2RiJztcbmltcG9ydCB7IER5bmFtb0RCRG9jdW1lbnRDbGllbnQsIFF1ZXJ5Q29tbWFuZCwgVXBkYXRlQ29tbWFuZCwgRGVsZXRlQ29tbWFuZCwgR2V0Q29tbWFuZCwgQmF0Y2hXcml0ZUNvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9saWItZHluYW1vZGInO1xuaW1wb3J0IHsgQVBJR2F0ZXdheVByb3h5RXZlbnQsIEFQSUdhdGV3YXlQcm94eUV2ZW50VjIsIEFQSUdhdGV3YXlQcm94eVJlc3VsdCB9IGZyb20gJ2F3cy1sYW1iZGEnO1xuaW1wb3J0IHsgcmVzb2x2ZURldmljZSB9IGZyb20gJy4uL3NoYXJlZC9kZXZpY2UtbG9va3VwJztcblxuLy8gVHlwZSBmb3IgbG9jYXRpb24gcG9pbnQgaXRlbXMgZnJvbSBEeW5hbW9EQlxuaW50ZXJmYWNlIExvY2F0aW9uUG9pbnQge1xuICBkZXZpY2VfdWlkOiBzdHJpbmc7XG4gIHRpbWVzdGFtcDogbnVtYmVyO1xuICBsYXRpdHVkZTogbnVtYmVyO1xuICBsb25naXR1ZGU6IG51bWJlcjtcbiAgdmVsb2NpdHk/OiBudW1iZXI7XG4gIGJlYXJpbmc/OiBudW1iZXI7XG4gIGRpc3RhbmNlPzogbnVtYmVyO1xuICBkb3A/OiBudW1iZXI7XG4gIGpjb3VudD86IG51bWJlcjtcbiAgam91cm5leV9pZD86IG51bWJlcjtcbiAgc291cmNlPzogc3RyaW5nO1xuICBsb2NhdGlvbl9uYW1lPzogc3RyaW5nO1xuICBldmVudF90eXBlPzogc3RyaW5nO1xufVxuXG4vLyBUeXBlIGZvciB0ZWxlbWV0cnkgaXRlbXMgd2l0aCBwb3dlciByZWFkaW5nc1xuaW50ZXJmYWNlIFRlbGVtZXRyeUl0ZW0ge1xuICBtaWxsaWFtcF9ob3Vycz86IG51bWJlcjtcbiAgW2tleTogc3RyaW5nXTogdW5rbm93bjtcbn1cblxuLy8gR2VvSlNPTiBMaW5lU3RyaW5nIHR5cGVcbmludGVyZmFjZSBHZW9KU09OTGluZVN0cmluZyB7XG4gIHR5cGU6ICdMaW5lU3RyaW5nJztcbiAgY29vcmRpbmF0ZXM6IG51bWJlcltdW107XG59XG5cbi8vIFR5cGUgZm9yIE1hcGJveCBNYXAgTWF0Y2hpbmcgQVBJIHJlc3BvbnNlXG5pbnRlcmZhY2UgTWFwYm94TWF0Y2hSZXNwb25zZSB7XG4gIGNvZGU6IHN0cmluZztcbiAgbWVzc2FnZT86IHN0cmluZztcbiAgbWF0Y2hpbmdzPzogQXJyYXk8e1xuICAgIGdlb21ldHJ5OiBHZW9KU09OTGluZVN0cmluZztcbiAgICBjb25maWRlbmNlOiBudW1iZXI7XG4gIH0+O1xufVxuXG5jb25zdCBkZGJDbGllbnQgPSBuZXcgRHluYW1vREJDbGllbnQoe30pO1xuY29uc3QgZG9jQ2xpZW50ID0gRHluYW1vREJEb2N1bWVudENsaWVudC5mcm9tKGRkYkNsaWVudCk7XG5cbmNvbnN0IEpPVVJORVlTX1RBQkxFID0gcHJvY2Vzcy5lbnYuSk9VUk5FWVNfVEFCTEUhO1xuY29uc3QgTE9DQVRJT05TX1RBQkxFID0gcHJvY2Vzcy5lbnYuTE9DQVRJT05TX1RBQkxFITtcbmNvbnN0IERFVklDRVNfVEFCTEUgPSBwcm9jZXNzLmVudi5ERVZJQ0VTX1RBQkxFITtcbmNvbnN0IFRFTEVNRVRSWV9UQUJMRSA9IHByb2Nlc3MuZW52LlRFTEVNRVRSWV9UQUJMRSE7XG5jb25zdCBNQVBCT1hfVE9LRU4gPSBwcm9jZXNzLmVudi5NQVBCT1hfVE9LRU47XG5cbmV4cG9ydCBjb25zdCBoYW5kbGVyID0gYXN5bmMgKGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudCk6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiA9PiB7XG4gIGNvbnNvbGUubG9nKCdSZXF1ZXN0OicsIEpTT04uc3RyaW5naWZ5KGV2ZW50KSk7XG5cbiAgY29uc3QgY29yc0hlYWRlcnMgPSB7XG4gICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbic6ICcqJyxcbiAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctSGVhZGVycyc6ICdDb250ZW50LVR5cGUsQXV0aG9yaXphdGlvbicsXG4gICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHMnOiAnR0VULFBPU1QsREVMRVRFLE9QVElPTlMnLFxuICB9O1xuXG4gIHRyeSB7XG4gICAgY29uc3QgbWV0aG9kID0gKGV2ZW50LnJlcXVlc3RDb250ZXh0IGFzIGFueSk/Lmh0dHA/Lm1ldGhvZCB8fCBldmVudC5odHRwTWV0aG9kO1xuICAgIGNvbnN0IHBhdGggPSAoZXZlbnQucmVxdWVzdENvbnRleHQgYXMgYW55KT8uaHR0cD8ucGF0aCB8fCBldmVudC5wYXRoO1xuXG4gICAgaWYgKG1ldGhvZCA9PT0gJ09QVElPTlMnKSB7XG4gICAgICByZXR1cm4geyBzdGF0dXNDb2RlOiAyMDAsIGhlYWRlcnM6IGNvcnNIZWFkZXJzLCBib2R5OiAnJyB9O1xuICAgIH1cblxuICAgIGNvbnN0IHNlcmlhbE51bWJlciA9IGV2ZW50LnBhdGhQYXJhbWV0ZXJzPy5zZXJpYWxfbnVtYmVyO1xuICAgIGlmICghc2VyaWFsTnVtYmVyKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgIGhlYWRlcnM6IGNvcnNIZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnc2VyaWFsX251bWJlciByZXF1aXJlZCcgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIFJlc29sdmUgc2VyaWFsX251bWJlciB0byBhbGwgYXNzb2NpYXRlZCBkZXZpY2VfdWlkc1xuICAgIGNvbnN0IHJlc29sdmVkID0gYXdhaXQgcmVzb2x2ZURldmljZShzZXJpYWxOdW1iZXIpO1xuICAgIGlmICghcmVzb2x2ZWQpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwNCxcbiAgICAgICAgaGVhZGVyczogY29yc0hlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdEZXZpY2Ugbm90IGZvdW5kJyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgY29uc3Qgam91cm5leUlkID0gZXZlbnQucGF0aFBhcmFtZXRlcnM/LmpvdXJuZXlfaWQ7XG4gICAgY29uc3QgcXVlcnlQYXJhbXMgPSBldmVudC5xdWVyeVN0cmluZ1BhcmFtZXRlcnMgfHwge307XG5cbiAgICAvLyBHRVQgL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2xvY2F0aW9ucyAtIExvY2F0aW9uIGhpc3RvcnkgKG1lcmdlZCBmcm9tIGFsbCBOb3RlY2FyZHMpXG4gICAgaWYgKHBhdGguZW5kc1dpdGgoJy9sb2NhdGlvbnMnKSkge1xuICAgICAgcmV0dXJuIGF3YWl0IGdldExvY2F0aW9uSGlzdG9yeShyZXNvbHZlZC5zZXJpYWxfbnVtYmVyLCByZXNvbHZlZC5hbGxfZGV2aWNlX3VpZHMsIHF1ZXJ5UGFyYW1zLCBjb3JzSGVhZGVycyk7XG4gICAgfVxuXG4gICAgLy8gUE9TVCAvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vam91cm5leXMve2pvdXJuZXlfaWR9L21hdGNoIC0gTWFwIG1hdGNoaW5nXG4gICAgLy8gTm90ZTogRm9yIG5vdywgd2UgbmVlZCB0byBmaW5kIHdoaWNoIGRldmljZV91aWQgb3ducyB0aGlzIGpvdXJuZXlcbiAgICBpZiAocGF0aC5lbmRzV2l0aCgnL21hdGNoJykgJiYgbWV0aG9kID09PSAnUE9TVCcgJiYgam91cm5leUlkKSB7XG4gICAgICByZXR1cm4gYXdhaXQgbWF0Y2hKb3VybmV5KHJlc29sdmVkLmFsbF9kZXZpY2VfdWlkcywgcGFyc2VJbnQoam91cm5leUlkKSwgY29yc0hlYWRlcnMpO1xuICAgIH1cblxuICAgIC8vIERFTEVURSAvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vam91cm5leXMve2pvdXJuZXlfaWR9IC0gRGVsZXRlIGpvdXJuZXkgKGFkbWluL293bmVyIG9ubHkpXG4gICAgaWYgKG1ldGhvZCA9PT0gJ0RFTEVURScgJiYgam91cm5leUlkKSB7XG4gICAgICByZXR1cm4gYXdhaXQgZGVsZXRlSm91cm5leShyZXNvbHZlZC5zZXJpYWxfbnVtYmVyLCByZXNvbHZlZC5hbGxfZGV2aWNlX3VpZHMsIHBhcnNlSW50KGpvdXJuZXlJZCksIGV2ZW50LCBjb3JzSGVhZGVycyk7XG4gICAgfVxuXG4gICAgLy8gR0VUIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9qb3VybmV5cy97am91cm5leV9pZH0gLSBTaW5nbGUgam91cm5leSB3aXRoIHBvaW50c1xuICAgIGlmIChqb3VybmV5SWQpIHtcbiAgICAgIHJldHVybiBhd2FpdCBnZXRKb3VybmV5RGV0YWlsKHJlc29sdmVkLmFsbF9kZXZpY2VfdWlkcywgcGFyc2VJbnQoam91cm5leUlkKSwgY29yc0hlYWRlcnMpO1xuICAgIH1cblxuICAgIC8vIEdFVCAvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vam91cm5leXMgLSBMaXN0IGpvdXJuZXlzIChtZXJnZWQgZnJvbSBhbGwgTm90ZWNhcmRzKVxuICAgIHJldHVybiBhd2FpdCBsaXN0Sm91cm5leXMocmVzb2x2ZWQuc2VyaWFsX251bWJlciwgcmVzb2x2ZWQuYWxsX2RldmljZV91aWRzLCBxdWVyeVBhcmFtcywgY29yc0hlYWRlcnMpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yOicsIGVycm9yKTtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNTAwLFxuICAgICAgaGVhZGVyczogY29yc0hlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnSW50ZXJuYWwgc2VydmVyIGVycm9yJyB9KSxcbiAgICB9O1xuICB9XG59O1xuXG4vKipcbiAqIExpc3QgYWxsIGpvdXJuZXlzIGZvciBhIGRldmljZSAobWVyZ2VkIGZyb20gYWxsIE5vdGVjYXJkcylcbiAqL1xuYXN5bmMgZnVuY3Rpb24gbGlzdEpvdXJuZXlzKFxuICBzZXJpYWxOdW1iZXI6IHN0cmluZyxcbiAgZGV2aWNlVWlkczogc3RyaW5nW10sXG4gIHF1ZXJ5UGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCB1bmRlZmluZWQ+LFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICBjb25zdCBzdGF0dXMgPSBxdWVyeVBhcmFtcy5zdGF0dXM7IC8vICdhY3RpdmUnIHwgJ2NvbXBsZXRlZCcgfCB1bmRlZmluZWQgKGFsbClcbiAgY29uc3QgbGltaXQgPSBwYXJzZUludChxdWVyeVBhcmFtcy5saW1pdCB8fCAnNTAnKTtcblxuICAvLyBRdWVyeSBhbGwgZGV2aWNlX3VpZHMgaW4gcGFyYWxsZWxcbiAgY29uc3QgcXVlcnlQcm9taXNlcyA9IGRldmljZVVpZHMubWFwKGFzeW5jIChkZXZpY2VVaWQpID0+IHtcbiAgICBjb25zdCBjb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IEpPVVJORVlTX1RBQkxFLFxuICAgICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQgPSA6ZGV2aWNlX3VpZCcsXG4gICAgICAuLi4oc3RhdHVzICYmIHtcbiAgICAgICAgRmlsdGVyRXhwcmVzc2lvbjogJyNzdGF0dXMgPSA6c3RhdHVzJyxcbiAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7ICcjc3RhdHVzJzogJ3N0YXR1cycgfSxcbiAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICAgICAgICAnOnN0YXR1cyc6IHN0YXR1cyxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICAgLi4uKCFzdGF0dXMgJiYge1xuICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgICBTY2FuSW5kZXhGb3J3YXJkOiBmYWxzZSxcbiAgICAgIExpbWl0OiBsaW1pdCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICAgIHJldHVybiByZXN1bHQuSXRlbXMgfHwgW107XG4gIH0pO1xuXG4gIGNvbnN0IGFsbFJlc3VsdHMgPSBhd2FpdCBQcm9taXNlLmFsbChxdWVyeVByb21pc2VzKTtcblxuICAvLyBNZXJnZSBhbmQgc29ydCBieSBqb3VybmV5X2lkICh3aGljaCBpcyB0aGUgc3RhcnQgdGltZXN0YW1wLCBkZXNjZW5kaW5nKVxuICBjb25zdCBtZXJnZWRKb3VybmV5cyA9IGFsbFJlc3VsdHNcbiAgICAuZmxhdCgpXG4gICAgLnNvcnQoKGEsIGIpID0+IGIuam91cm5leV9pZCAtIGEuam91cm5leV9pZClcbiAgICAuc2xpY2UoMCwgbGltaXQpXG4gICAgLm1hcCgoaXRlbSkgPT4gKHtcbiAgICAgIGpvdXJuZXlfaWQ6IGl0ZW0uam91cm5leV9pZCxcbiAgICAgIGRldmljZV91aWQ6IGl0ZW0uZGV2aWNlX3VpZCxcbiAgICAgIHN0YXJ0X3RpbWU6IG5ldyBEYXRlKGl0ZW0uc3RhcnRfdGltZSkudG9JU09TdHJpbmcoKSxcbiAgICAgIGVuZF90aW1lOiBpdGVtLmVuZF90aW1lID8gbmV3IERhdGUoaXRlbS5lbmRfdGltZSkudG9JU09TdHJpbmcoKSA6IHVuZGVmaW5lZCxcbiAgICAgIHBvaW50X2NvdW50OiBpdGVtLnBvaW50X2NvdW50IHx8IDAsXG4gICAgICB0b3RhbF9kaXN0YW5jZTogaXRlbS50b3RhbF9kaXN0YW5jZSB8fCAwLFxuICAgICAgc3RhdHVzOiBpdGVtLnN0YXR1cyxcbiAgICB9KSk7XG5cbiAgcmV0dXJuIHtcbiAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgaGVhZGVycyxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBzZXJpYWxfbnVtYmVyOiBzZXJpYWxOdW1iZXIsXG4gICAgICBqb3VybmV5czogbWVyZ2VkSm91cm5leXMsXG4gICAgICBjb3VudDogbWVyZ2VkSm91cm5leXMubGVuZ3RoLFxuICAgIH0pLFxuICB9O1xufVxuXG4vKipcbiAqIEdldCBhIHNpbmdsZSBqb3VybmV5IHdpdGggYWxsIGl0cyBsb2NhdGlvbiBwb2ludHNcbiAqIFNlYXJjaGVzIGFjcm9zcyBhbGwgZGV2aWNlX3VpZHMgdG8gZmluZCB0aGUgam91cm5leVxuICovXG5hc3luYyBmdW5jdGlvbiBnZXRKb3VybmV5RGV0YWlsKFxuICBkZXZpY2VVaWRzOiBzdHJpbmdbXSxcbiAgam91cm5leUlkOiBudW1iZXIsXG4gIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiB7XG4gIC8vIFNlYXJjaCBmb3IgdGhlIGpvdXJuZXkgYWNyb3NzIGFsbCBkZXZpY2VfdWlkc1xuICBsZXQgam91cm5leUl0ZW06IGFueSA9IG51bGw7XG4gIGxldCBvd25lckRldmljZVVpZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbiAgZm9yIChjb25zdCBkZXZpY2VVaWQgb2YgZGV2aWNlVWlkcykge1xuICAgIGNvbnN0IGpvdXJuZXlDb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IEpPVVJORVlTX1RBQkxFLFxuICAgICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQgPSA6ZGV2aWNlX3VpZCBBTkQgam91cm5leV9pZCA9IDpqb3VybmV5X2lkJyxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgICAnOmpvdXJuZXlfaWQnOiBqb3VybmV5SWQsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3Qgam91cm5leVJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGpvdXJuZXlDb21tYW5kKTtcblxuICAgIGlmIChqb3VybmV5UmVzdWx0Lkl0ZW1zICYmIGpvdXJuZXlSZXN1bHQuSXRlbXMubGVuZ3RoID4gMCkge1xuICAgICAgam91cm5leUl0ZW0gPSBqb3VybmV5UmVzdWx0Lkl0ZW1zWzBdO1xuICAgICAgb3duZXJEZXZpY2VVaWQgPSBkZXZpY2VVaWQ7XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cblxuICBpZiAoIWpvdXJuZXlJdGVtIHx8ICFvd25lckRldmljZVVpZCkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDQsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0pvdXJuZXkgbm90IGZvdW5kJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gR2V0IGFsbCBsb2NhdGlvbiBwb2ludHMgZm9yIHRoaXMgam91cm5leSB1c2luZyB0aGUgam91cm5leS1pbmRleCBHU0lcbiAgY29uc3QgcG9pbnRzQ29tbWFuZCA9IG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogTE9DQVRJT05TX1RBQkxFLFxuICAgIEluZGV4TmFtZTogJ2pvdXJuZXktaW5kZXgnLFxuICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkID0gOmRldmljZV91aWQgQU5EIGpvdXJuZXlfaWQgPSA6am91cm5leV9pZCcsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzpkZXZpY2VfdWlkJzogb3duZXJEZXZpY2VVaWQsXG4gICAgICAnOmpvdXJuZXlfaWQnOiBqb3VybmV5SWQsXG4gICAgfSxcbiAgICBTY2FuSW5kZXhGb3J3YXJkOiB0cnVlLCAvLyBDaHJvbm9sb2dpY2FsIG9yZGVyXG4gIH0pO1xuXG4gIGNvbnN0IHBvaW50c1Jlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKHBvaW50c0NvbW1hbmQpO1xuXG4gIGNvbnN0IHN0YXJ0VGltZSA9IGpvdXJuZXlJdGVtLnN0YXJ0X3RpbWU7XG4gIGNvbnN0IGVuZFRpbWUgPSBqb3VybmV5SXRlbS5lbmRfdGltZSB8fCBEYXRlLm5vdygpO1xuXG4gIGNvbnN0IGpvdXJuZXkgPSB7XG4gICAgam91cm5leV9pZDogam91cm5leUl0ZW0uam91cm5leV9pZCxcbiAgICBkZXZpY2VfdWlkOiBqb3VybmV5SXRlbS5kZXZpY2VfdWlkLFxuICAgIHN0YXJ0X3RpbWU6IG5ldyBEYXRlKHN0YXJ0VGltZSkudG9JU09TdHJpbmcoKSxcbiAgICBlbmRfdGltZTogam91cm5leUl0ZW0uZW5kX3RpbWUgPyBuZXcgRGF0ZShqb3VybmV5SXRlbS5lbmRfdGltZSkudG9JU09TdHJpbmcoKSA6IHVuZGVmaW5lZCxcbiAgICBwb2ludF9jb3VudDogam91cm5leUl0ZW0ucG9pbnRfY291bnQgfHwgMCxcbiAgICB0b3RhbF9kaXN0YW5jZTogam91cm5leUl0ZW0udG90YWxfZGlzdGFuY2UgfHwgMCxcbiAgICBzdGF0dXM6IGpvdXJuZXlJdGVtLnN0YXR1cyxcbiAgICBtYXRjaGVkX3JvdXRlOiBqb3VybmV5SXRlbS5tYXRjaGVkX3JvdXRlLCAvLyBHZW9KU09OIExpbmVTdHJpbmcgaWYgbWFwLW1hdGNoZWRcbiAgfTtcblxuICAvLyBTb3J0IHBvaW50cyBieSB0aW1lc3RhbXAgKEdTSSBkb2Vzbid0IGd1YXJhbnRlZSBvcmRlciB3aXRoaW4gc2FtZSBqb3VybmV5X2lkKVxuICBjb25zdCBzb3J0ZWRJdGVtcyA9ICgocG9pbnRzUmVzdWx0Lkl0ZW1zIHx8IFtdKSBhcyBMb2NhdGlvblBvaW50W10pLnNvcnQoKGEsIGIpID0+IGEudGltZXN0YW1wIC0gYi50aW1lc3RhbXApO1xuXG4gIGNvbnN0IHBvaW50cyA9IHNvcnRlZEl0ZW1zLm1hcCgoaXRlbSkgPT4gKHtcbiAgICB0aW1lOiBuZXcgRGF0ZShpdGVtLnRpbWVzdGFtcCkudG9JU09TdHJpbmcoKSxcbiAgICBsYXQ6IGl0ZW0ubGF0aXR1ZGUsXG4gICAgbG9uOiBpdGVtLmxvbmdpdHVkZSxcbiAgICB2ZWxvY2l0eTogaXRlbS52ZWxvY2l0eSxcbiAgICBiZWFyaW5nOiBpdGVtLmJlYXJpbmcsXG4gICAgZGlzdGFuY2U6IGl0ZW0uZGlzdGFuY2UsXG4gICAgZG9wOiBpdGVtLmRvcCxcbiAgICBqY291bnQ6IGl0ZW0uamNvdW50LFxuICB9KSk7XG5cbiAgLy8gR2V0IHBvd2VyIGNvbnN1bXB0aW9uIGZvciB0aGlzIGpvdXJuZXlcbiAgY29uc3QgcG93ZXIgPSBhd2FpdCBnZXRKb3VybmV5UG93ZXJDb25zdW1wdGlvbihvd25lckRldmljZVVpZCwgc3RhcnRUaW1lLCBlbmRUaW1lKTtcblxuICByZXR1cm4ge1xuICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICBoZWFkZXJzLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIGpvdXJuZXksXG4gICAgICBwb2ludHMsXG4gICAgICBwb3dlcixcbiAgICB9KSxcbiAgfTtcbn1cblxuLyoqXG4gKiBDYWxsIE1hcGJveCBNYXAgTWF0Y2hpbmcgQVBJIGFuZCBjYWNoZSB0aGUgcmVzdWx0XG4gKiBTZWFyY2hlcyBhY3Jvc3MgYWxsIGRldmljZV91aWRzIHRvIGZpbmQgdGhlIGpvdXJuZXlcbiAqL1xuYXN5bmMgZnVuY3Rpb24gbWF0Y2hKb3VybmV5KFxuICBkZXZpY2VVaWRzOiBzdHJpbmdbXSxcbiAgam91cm5leUlkOiBudW1iZXIsXG4gIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiB7XG4gIGlmICghTUFQQk9YX1RPS0VOKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnTWFwIG1hdGNoaW5nIG5vdCBjb25maWd1cmVkJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gRmluZCB3aGljaCBkZXZpY2VfdWlkIG93bnMgdGhpcyBqb3VybmV5XG4gIGxldCBvd25lckRldmljZVVpZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbiAgZm9yIChjb25zdCBkZXZpY2VVaWQgb2YgZGV2aWNlVWlkcykge1xuICAgIGNvbnN0IGpvdXJuZXlDb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IEpPVVJORVlTX1RBQkxFLFxuICAgICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQgPSA6ZGV2aWNlX3VpZCBBTkQgam91cm5leV9pZCA9IDpqb3VybmV5X2lkJyxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgICAnOmpvdXJuZXlfaWQnOiBqb3VybmV5SWQsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3Qgam91cm5leVJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGpvdXJuZXlDb21tYW5kKTtcblxuICAgIGlmIChqb3VybmV5UmVzdWx0Lkl0ZW1zICYmIGpvdXJuZXlSZXN1bHQuSXRlbXMubGVuZ3RoID4gMCkge1xuICAgICAgb3duZXJEZXZpY2VVaWQgPSBkZXZpY2VVaWQ7XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cblxuICBpZiAoIW93bmVyRGV2aWNlVWlkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwNCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnSm91cm5leSBub3QgZm91bmQnIH0pLFxuICAgIH07XG4gIH1cblxuICAvLyBHZXQgdGhlIGpvdXJuZXkgcG9pbnRzXG4gIGNvbnN0IHBvaW50c0NvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IExPQ0FUSU9OU19UQUJMRSxcbiAgICBJbmRleE5hbWU6ICdqb3VybmV5LWluZGV4JyxcbiAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCBqb3VybmV5X2lkID0gOmpvdXJuZXlfaWQnLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6ZGV2aWNlX3VpZCc6IG93bmVyRGV2aWNlVWlkLFxuICAgICAgJzpqb3VybmV5X2lkJzogam91cm5leUlkLFxuICAgIH0sXG4gICAgU2NhbkluZGV4Rm9yd2FyZDogdHJ1ZSxcbiAgfSk7XG5cbiAgY29uc3QgcG9pbnRzUmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQocG9pbnRzQ29tbWFuZCk7XG5cbiAgLy8gU29ydCBwb2ludHMgYnkgdGltZXN0YW1wIChHU0kgZG9lc24ndCBndWFyYW50ZWUgb3JkZXIgd2l0aGluIHNhbWUgam91cm5leV9pZClcbiAgY29uc3QgcG9pbnRzID0gKChwb2ludHNSZXN1bHQuSXRlbXMgfHwgW10pIGFzIExvY2F0aW9uUG9pbnRbXSkuc29ydCgoYSwgYikgPT4gYS50aW1lc3RhbXAgLSBiLnRpbWVzdGFtcCk7XG5cbiAgaWYgKHBvaW50cy5sZW5ndGggPCAyKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnSm91cm5leSBoYXMgZmV3ZXIgdGhhbiAyIHBvaW50cycgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8vIE1hcGJveCBNYXAgTWF0Y2hpbmcgQVBJIGhhcyBhIGxpbWl0IG9mIDEwMCBjb29yZGluYXRlcyBwZXIgcmVxdWVzdFxuICAvLyBJZiB3ZSBoYXZlIG1vcmUsIHdlIG5lZWQgdG8gc2FtcGxlIG9yIGJhdGNoXG4gIGNvbnN0IG1heFBvaW50cyA9IDEwMDtcbiAgbGV0IHNhbXBsZWRQb2ludHM6IExvY2F0aW9uUG9pbnRbXSA9IHBvaW50cztcbiAgaWYgKHBvaW50cy5sZW5ndGggPiBtYXhQb2ludHMpIHtcbiAgICAvLyBTYW1wbGUgcG9pbnRzIGV2ZW5seVxuICAgIGNvbnN0IHN0ZXAgPSAocG9pbnRzLmxlbmd0aCAtIDEpIC8gKG1heFBvaW50cyAtIDEpO1xuICAgIHNhbXBsZWRQb2ludHMgPSBbXTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG1heFBvaW50czsgaSsrKSB7XG4gICAgICBjb25zdCBpZHggPSBNYXRoLnJvdW5kKGkgKiBzdGVwKTtcbiAgICAgIHNhbXBsZWRQb2ludHMucHVzaChwb2ludHNbaWR4XSk7XG4gICAgfVxuICB9XG5cbiAgLy8gRm9ybWF0IGNvb3JkaW5hdGVzIGZvciBNYXBib3ggQVBJOiBsb24sbGF0O2xvbixsYXQ7Li4uXG4gIGNvbnN0IGNvb3JkaW5hdGVzID0gc2FtcGxlZFBvaW50c1xuICAgIC5tYXAoKHApID0+IGAke3AubG9uZ2l0dWRlfSwke3AubGF0aXR1ZGV9YClcbiAgICAuam9pbignOycpO1xuXG4gIC8vIEJ1aWxkIHRoZSB0aW1lc3RhbXBzIHBhcmFtZXRlciAoVW5peCB0aW1lc3RhbXBzIGluIHNlY29uZHMpXG4gIGNvbnN0IHRpbWVzdGFtcHMgPSBzYW1wbGVkUG9pbnRzXG4gICAgLm1hcCgocCkgPT4gTWF0aC5mbG9vcihwLnRpbWVzdGFtcCAvIDEwMDApKVxuICAgIC5qb2luKCc7Jyk7XG5cbiAgLy8gQnVpbGQgdGhlIHJhZGl1c2VzIHBhcmFtZXRlciAoR1BTIGFjY3VyYWN5IGluIG1ldGVycywgZGVmYXVsdCAyNW0pXG4gIGNvbnN0IHJhZGl1c2VzID0gc2FtcGxlZFBvaW50c1xuICAgIC5tYXAoKHApID0+IChwLmRvcCA/IE1hdGgubWF4KDUsIHAuZG9wICogMTApIDogMjUpKVxuICAgIC5qb2luKCc7Jyk7XG5cbiAgLy8gQ2FsbCBNYXBib3ggTWFwIE1hdGNoaW5nIEFQSVxuICBjb25zdCBtYXBNYXRjaFVybCA9IGBodHRwczovL2FwaS5tYXBib3guY29tL21hdGNoaW5nL3Y1L21hcGJveC9kcml2aW5nLyR7Y29vcmRpbmF0ZXN9P2FjY2Vzc190b2tlbj0ke01BUEJPWF9UT0tFTn0mZ2VvbWV0cmllcz1nZW9qc29uJnJhZGl1c2VzPSR7cmFkaXVzZXN9JnRpbWVzdGFtcHM9JHt0aW1lc3RhbXBzfSZvdmVydmlldz1mdWxsJnN0ZXBzPWZhbHNlYDtcblxuICBjb25zb2xlLmxvZyhgQ2FsbGluZyBNYXBib3ggTWFwIE1hdGNoaW5nIEFQSSBmb3Igam91cm5leSAke2pvdXJuZXlJZH0gd2l0aCAke3NhbXBsZWRQb2ludHMubGVuZ3RofSBwb2ludHNgKTtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2gobWFwTWF0Y2hVcmwpO1xuICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZXNwb25zZS5qc29uKCkgYXMgTWFwYm94TWF0Y2hSZXNwb25zZTtcblxuICAgIGlmIChkYXRhLmNvZGUgIT09ICdPaycgfHwgIWRhdGEubWF0Y2hpbmdzIHx8IGRhdGEubWF0Y2hpbmdzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgY29uc29sZS5lcnJvcignTWFwIG1hdGNoaW5nIGZhaWxlZDonLCBkYXRhKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIGVycm9yOiAnTWFwIG1hdGNoaW5nIGZhaWxlZCcsXG4gICAgICAgICAgY29kZTogZGF0YS5jb2RlLFxuICAgICAgICAgIG1lc3NhZ2U6IGRhdGEubWVzc2FnZSxcbiAgICAgICAgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIEdldCB0aGUgbWF0Y2hlZCBnZW9tZXRyeSAoR2VvSlNPTiBMaW5lU3RyaW5nKVxuICAgIGNvbnN0IG1hdGNoZWRSb3V0ZSA9IGRhdGEubWF0Y2hpbmdzWzBdLmdlb21ldHJ5O1xuICAgIGNvbnN0IGNvbmZpZGVuY2UgPSBkYXRhLm1hdGNoaW5nc1swXS5jb25maWRlbmNlO1xuXG4gICAgLy8gU3RvcmUgdGhlIG1hdGNoZWQgcm91dGUgaW4gRHluYW1vREJcbiAgICBjb25zdCB1cGRhdGVDb21tYW5kID0gbmV3IFVwZGF0ZUNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICAgIEtleToge1xuICAgICAgICBkZXZpY2VfdWlkOiBvd25lckRldmljZVVpZCxcbiAgICAgICAgam91cm5leV9pZDogam91cm5leUlkLFxuICAgICAgfSxcbiAgICAgIFVwZGF0ZUV4cHJlc3Npb246ICdTRVQgbWF0Y2hlZF9yb3V0ZSA9IDpyb3V0ZSwgbWF0Y2hfY29uZmlkZW5jZSA9IDpjb25maWRlbmNlLCBtYXRjaGVkX2F0ID0gOnRpbWUnLFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAnOnJvdXRlJzogbWF0Y2hlZFJvdXRlLFxuICAgICAgICAnOmNvbmZpZGVuY2UnOiBjb25maWRlbmNlLFxuICAgICAgICAnOnRpbWUnOiBEYXRlLm5vdygpLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGF3YWl0IGRvY0NsaWVudC5zZW5kKHVwZGF0ZUNvbW1hbmQpO1xuICAgIGNvbnNvbGUubG9nKGBTdG9yZWQgbWF0Y2hlZCByb3V0ZSBmb3Igam91cm5leSAke2pvdXJuZXlJZH0gd2l0aCBjb25maWRlbmNlICR7Y29uZmlkZW5jZX1gKTtcblxuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBtYXRjaGVkX3JvdXRlOiBtYXRjaGVkUm91dGUsXG4gICAgICAgIGNvbmZpZGVuY2UsXG4gICAgICAgIG9yaWdpbmFsX3BvaW50czogcG9pbnRzLmxlbmd0aCxcbiAgICAgICAgbWF0Y2hlZF9wb2ludHM6IHNhbXBsZWRQb2ludHMubGVuZ3RoLFxuICAgICAgfSksXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvciBjYWxsaW5nIE1hcGJveCBBUEk6JywgZXJyb3IpO1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA1MDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0ZhaWxlZCB0byBjYWxsIG1hcCBtYXRjaGluZyBBUEknIH0pLFxuICAgIH07XG4gIH1cbn1cblxuLyoqXG4gKiBHZXQgbG9jYXRpb24gaGlzdG9yeSBmb3IgYSBkZXZpY2UgKG1lcmdlZCBmcm9tIGFsbCBOb3RlY2FyZHMpXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGdldExvY2F0aW9uSGlzdG9yeShcbiAgc2VyaWFsTnVtYmVyOiBzdHJpbmcsXG4gIGRldmljZVVpZHM6IHN0cmluZ1tdLFxuICBxdWVyeVBhcmFtczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgdW5kZWZpbmVkPixcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgY29uc3QgaG91cnMgPSBwYXJzZUludChxdWVyeVBhcmFtcy5ob3VycyB8fCAnMjQnKTtcbiAgY29uc3Qgc291cmNlID0gcXVlcnlQYXJhbXMuc291cmNlOyAvLyAnZ3BzJyB8ICdjZWxsJyB8ICd0cmlhbmd1bGF0aW9uJyB8IHVuZGVmaW5lZCAoYWxsKVxuICBjb25zdCBsaW1pdCA9IHBhcnNlSW50KHF1ZXJ5UGFyYW1zLmxpbWl0IHx8ICcxMDAwJyk7XG5cbiAgY29uc3QgY3V0b2ZmVGltZSA9IERhdGUubm93KCkgLSBob3VycyAqIDYwICogNjAgKiAxMDAwO1xuXG4gIC8vIFF1ZXJ5IGFsbCBkZXZpY2VfdWlkcyBpbiBwYXJhbGxlbFxuICBjb25zdCBxdWVyeVByb21pc2VzID0gZGV2aWNlVWlkcy5tYXAoYXN5bmMgKGRldmljZVVpZCkgPT4ge1xuICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogTE9DQVRJT05TX1RBQkxFLFxuICAgICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQgPSA6ZGV2aWNlX3VpZCBBTkQgI3RpbWVzdGFtcCA+PSA6Y3V0b2ZmJyxcbiAgICAgIC4uLihzb3VyY2UgJiYge1xuICAgICAgICBGaWx0ZXJFeHByZXNzaW9uOiAnI3NvdXJjZSA9IDpzb3VyY2UnLFxuICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICAgICAnI3RpbWVzdGFtcCc6ICd0aW1lc3RhbXAnLFxuICAgICAgICAgICcjc291cmNlJzogJ3NvdXJjZScsXG4gICAgICAgIH0sXG4gICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgICAnOmRldmljZV91aWQnOiBkZXZpY2VVaWQsXG4gICAgICAgICAgJzpjdXRvZmYnOiBjdXRvZmZUaW1lLFxuICAgICAgICAgICc6c291cmNlJzogc291cmNlLFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgICAuLi4oIXNvdXJjZSAmJiB7XG4gICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczoge1xuICAgICAgICAgICcjdGltZXN0YW1wJzogJ3RpbWVzdGFtcCcsXG4gICAgICAgIH0sXG4gICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgICAnOmRldmljZV91aWQnOiBkZXZpY2VVaWQsXG4gICAgICAgICAgJzpjdXRvZmYnOiBjdXRvZmZUaW1lLFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgICBTY2FuSW5kZXhGb3J3YXJkOiBmYWxzZSxcbiAgICAgIExpbWl0OiBsaW1pdCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICAgIHJldHVybiByZXN1bHQuSXRlbXMgfHwgW107XG4gIH0pO1xuXG4gIGNvbnN0IGFsbFJlc3VsdHMgPSBhd2FpdCBQcm9taXNlLmFsbChxdWVyeVByb21pc2VzKTtcblxuICAvLyBNZXJnZSBhbmQgc29ydCBieSB0aW1lc3RhbXAgKG1vc3QgcmVjZW50IGZpcnN0KSwgdGhlbiBhcHBseSBsaW1pdFxuICBjb25zdCBtZXJnZWRMb2NhdGlvbnMgPSBhbGxSZXN1bHRzXG4gICAgLmZsYXQoKVxuICAgIC5zb3J0KChhLCBiKSA9PiBiLnRpbWVzdGFtcCAtIGEudGltZXN0YW1wKVxuICAgIC5zbGljZSgwLCBsaW1pdClcbiAgICAubWFwKChpdGVtKSA9PiAoe1xuICAgICAgdGltZTogbmV3IERhdGUoaXRlbS50aW1lc3RhbXApLnRvSVNPU3RyaW5nKCksXG4gICAgICBsYXQ6IGl0ZW0ubGF0aXR1ZGUsXG4gICAgICBsb246IGl0ZW0ubG9uZ2l0dWRlLFxuICAgICAgc291cmNlOiBpdGVtLnNvdXJjZSxcbiAgICAgIGxvY2F0aW9uX25hbWU6IGl0ZW0ubG9jYXRpb25fbmFtZSxcbiAgICAgIGV2ZW50X3R5cGU6IGl0ZW0uZXZlbnRfdHlwZSxcbiAgICAgIGpvdXJuZXlfaWQ6IGl0ZW0uam91cm5leV9pZCxcbiAgICAgIGpjb3VudDogaXRlbS5qY291bnQsXG4gICAgICB2ZWxvY2l0eTogaXRlbS52ZWxvY2l0eSxcbiAgICAgIGJlYXJpbmc6IGl0ZW0uYmVhcmluZyxcbiAgICB9KSk7XG5cbiAgcmV0dXJuIHtcbiAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgaGVhZGVycyxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBzZXJpYWxfbnVtYmVyOiBzZXJpYWxOdW1iZXIsXG4gICAgICBob3VycyxcbiAgICAgIGNvdW50OiBtZXJnZWRMb2NhdGlvbnMubGVuZ3RoLFxuICAgICAgbG9jYXRpb25zOiBtZXJnZWRMb2NhdGlvbnMsXG4gICAgfSksXG4gIH07XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgdGhlIHVzZXIgaXMgYW4gYWRtaW4gKGluICdBZG1pbicgQ29nbml0byBncm91cClcbiAqL1xuZnVuY3Rpb24gaXNBZG1pbihldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBjbGFpbXMgPSAoZXZlbnQucmVxdWVzdENvbnRleHQgYXMgYW55KT8uYXV0aG9yaXplcj8uand0Py5jbGFpbXM7XG4gICAgaWYgKCFjbGFpbXMpIHJldHVybiBmYWxzZTtcblxuICAgIGNvbnN0IGdyb3VwcyA9IGNsYWltc1snY29nbml0bzpncm91cHMnXTtcbiAgICBpZiAoQXJyYXkuaXNBcnJheShncm91cHMpKSB7XG4gICAgICByZXR1cm4gZ3JvdXBzLmluY2x1ZGVzKCdBZG1pbicpO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGdyb3VwcyA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHJldHVybiBncm91cHMgPT09ICdBZG1pbicgfHwgZ3JvdXBzLmluY2x1ZGVzKCdBZG1pbicpO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKipcbiAqIEdldCB0aGUgdXNlcidzIGVtYWlsIGZyb20gdGhlIEpXVCBjbGFpbXNcbiAqL1xuZnVuY3Rpb24gZ2V0VXNlckVtYWlsKGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIHRyeSB7XG4gICAgY29uc3QgY2xhaW1zID0gKGV2ZW50LnJlcXVlc3RDb250ZXh0IGFzIGFueSk/LmF1dGhvcml6ZXI/Lmp3dD8uY2xhaW1zO1xuICAgIHJldHVybiBjbGFpbXM/LmVtYWlsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgdGhlIHVzZXIgb3ducyB0aGUgZGV2aWNlIChpcyBhc3NpZ25lZCB0byBpdClcbiAqL1xuYXN5bmMgZnVuY3Rpb24gaXNEZXZpY2VPd25lcihkZXZpY2VVaWQ6IHN0cmluZywgdXNlckVtYWlsOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3QgY29tbWFuZCA9IG5ldyBHZXRDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IERFVklDRVNfVEFCTEUsXG4gICAgS2V5OiB7IGRldmljZV91aWQ6IGRldmljZVVpZCB9LFxuICAgIFByb2plY3Rpb25FeHByZXNzaW9uOiAnYXNzaWduZWRfdG8nLFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgcmV0dXJuIHJlc3VsdC5JdGVtPy5hc3NpZ25lZF90byA9PT0gdXNlckVtYWlsO1xufVxuXG4vKipcbiAqIERlbGV0ZSBhIGpvdXJuZXkgYW5kIGFsbCBpdHMgbG9jYXRpb24gcG9pbnRzIChhZG1pbi9vd25lciBvbmx5KVxuICogU2VhcmNoZXMgYWNyb3NzIGFsbCBkZXZpY2VfdWlkcyB0byBmaW5kIGFuZCBkZWxldGUgdGhlIGpvdXJuZXlcbiAqL1xuYXN5bmMgZnVuY3Rpb24gZGVsZXRlSm91cm5leShcbiAgc2VyaWFsTnVtYmVyOiBzdHJpbmcsXG4gIGRldmljZVVpZHM6IHN0cmluZ1tdLFxuICBqb3VybmV5SWQ6IG51bWJlcixcbiAgZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50LFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICAvLyBBdXRob3JpemF0aW9uIGNoZWNrOiBtdXN0IGJlIGFkbWluIG9yIGRldmljZSBvd25lclxuICBjb25zdCB1c2VyRW1haWwgPSBnZXRVc2VyRW1haWwoZXZlbnQpO1xuICBjb25zdCBhZG1pbiA9IGlzQWRtaW4oZXZlbnQpO1xuXG4gIC8vIEZpbmQgd2hpY2ggZGV2aWNlX3VpZCBvd25zIHRoaXMgam91cm5leVxuICBsZXQgb3duZXJEZXZpY2VVaWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4gIGZvciAoY29uc3QgZGV2aWNlVWlkIG9mIGRldmljZVVpZHMpIHtcbiAgICBjb25zdCBqb3VybmV5Q29tbWFuZCA9IG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkID0gOmRldmljZV91aWQgQU5EIGpvdXJuZXlfaWQgPSA6am91cm5leV9pZCcsXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICAgICAgJzpqb3VybmV5X2lkJzogam91cm5leUlkLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGpvdXJuZXlSZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChqb3VybmV5Q29tbWFuZCk7XG5cbiAgICBpZiAoam91cm5leVJlc3VsdC5JdGVtcyAmJiBqb3VybmV5UmVzdWx0Lkl0ZW1zLmxlbmd0aCA+IDApIHtcbiAgICAgIG93bmVyRGV2aWNlVWlkID0gZGV2aWNlVWlkO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG5cbiAgaWYgKCFvd25lckRldmljZVVpZCkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDQsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0pvdXJuZXkgbm90IGZvdW5kJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgaWYgKCFhZG1pbikge1xuICAgIGlmICghdXNlckVtYWlsKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiA0MDEsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdVbmF1dGhvcml6ZWQnIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCBvd25lciA9IGF3YWl0IGlzRGV2aWNlT3duZXIob3duZXJEZXZpY2VVaWQsIHVzZXJFbWFpbCk7XG4gICAgaWYgKCFvd25lcikge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDAzLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnQWRtaW4gb3IgZGV2aWNlIG93bmVyIGFjY2VzcyByZXF1aXJlZCcgfSksXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIC8vIEdldCBhbGwgbG9jYXRpb24gcG9pbnRzIGZvciB0aGlzIGpvdXJuZXkgdG8gZGVsZXRlIHRoZW1cbiAgY29uc3QgcG9pbnRzQ29tbWFuZCA9IG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogTE9DQVRJT05TX1RBQkxFLFxuICAgIEluZGV4TmFtZTogJ2pvdXJuZXktaW5kZXgnLFxuICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkID0gOmRldmljZV91aWQgQU5EIGpvdXJuZXlfaWQgPSA6am91cm5leV9pZCcsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzpkZXZpY2VfdWlkJzogb3duZXJEZXZpY2VVaWQsXG4gICAgICAnOmpvdXJuZXlfaWQnOiBqb3VybmV5SWQsXG4gICAgfSxcbiAgICBQcm9qZWN0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQsICN0cycsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAnI3RzJzogJ3RpbWVzdGFtcCcsXG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgcG9pbnRzUmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQocG9pbnRzQ29tbWFuZCk7XG4gIGNvbnN0IGxvY2F0aW9uUG9pbnRzID0gKHBvaW50c1Jlc3VsdC5JdGVtcyB8fCBbXSkgYXMgTG9jYXRpb25Qb2ludFtdO1xuXG4gIC8vIERlbGV0ZSBsb2NhdGlvbiBwb2ludHMgaW4gYmF0Y2hlcyBvZiAyNSAoRHluYW1vREIgQmF0Y2hXcml0ZSBsaW1pdClcbiAgaWYgKGxvY2F0aW9uUG9pbnRzLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBiYXRjaGVzOiBMb2NhdGlvblBvaW50W11bXSA9IFtdO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgbG9jYXRpb25Qb2ludHMubGVuZ3RoOyBpICs9IDI1KSB7XG4gICAgICBjb25zdCBiYXRjaCA9IGxvY2F0aW9uUG9pbnRzLnNsaWNlKGksIGkgKyAyNSk7XG4gICAgICBiYXRjaGVzLnB1c2goYmF0Y2gpO1xuICAgIH1cblxuICAgIGZvciAoY29uc3QgYmF0Y2ggb2YgYmF0Y2hlcykge1xuICAgICAgY29uc3QgZGVsZXRlUmVxdWVzdHMgPSBiYXRjaC5tYXAoKHBvaW50OiBMb2NhdGlvblBvaW50KSA9PiAoe1xuICAgICAgICBEZWxldGVSZXF1ZXN0OiB7XG4gICAgICAgICAgS2V5OiB7XG4gICAgICAgICAgICBkZXZpY2VfdWlkOiBwb2ludC5kZXZpY2VfdWlkLFxuICAgICAgICAgICAgdGltZXN0YW1wOiBwb2ludC50aW1lc3RhbXAsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0pKTtcblxuICAgICAgY29uc3QgYmF0Y2hDb21tYW5kID0gbmV3IEJhdGNoV3JpdGVDb21tYW5kKHtcbiAgICAgICAgUmVxdWVzdEl0ZW1zOiB7XG4gICAgICAgICAgW0xPQ0FUSU9OU19UQUJMRV06IGRlbGV0ZVJlcXVlc3RzLFxuICAgICAgICB9LFxuICAgICAgfSk7XG5cbiAgICAgIGF3YWl0IGRvY0NsaWVudC5zZW5kKGJhdGNoQ29tbWFuZCk7XG4gICAgfVxuXG4gICAgY29uc29sZS5sb2coYERlbGV0ZWQgJHtsb2NhdGlvblBvaW50cy5sZW5ndGh9IGxvY2F0aW9uIHBvaW50cyBmb3Igam91cm5leSAke2pvdXJuZXlJZH1gKTtcbiAgfVxuXG4gIC8vIERlbGV0ZSB0aGUgam91cm5leSByZWNvcmRcbiAgY29uc3QgZGVsZXRlQ29tbWFuZCA9IG5ldyBEZWxldGVDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IEpPVVJORVlTX1RBQkxFLFxuICAgIEtleToge1xuICAgICAgZGV2aWNlX3VpZDogb3duZXJEZXZpY2VVaWQsXG4gICAgICBqb3VybmV5X2lkOiBqb3VybmV5SWQsXG4gICAgfSxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoZGVsZXRlQ29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBEZWxldGVkIGpvdXJuZXkgJHtqb3VybmV5SWR9IGZvciBkZXZpY2UgJHtvd25lckRldmljZVVpZH0gKHNlcmlhbDogJHtzZXJpYWxOdW1iZXJ9KWApO1xuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgbWVzc2FnZTogJ0pvdXJuZXkgZGVsZXRlZCcsXG4gICAgICBqb3VybmV5X2lkOiBqb3VybmV5SWQsXG4gICAgICBwb2ludHNfZGVsZXRlZDogbG9jYXRpb25Qb2ludHMubGVuZ3RoLFxuICAgIH0pLFxuICB9O1xufVxuXG4vKipcbiAqIEdldCBwb3dlciBjb25zdW1wdGlvbiBkdXJpbmcgYSBqb3VybmV5IHRpbWVmcmFtZVxuICogUXVlcmllcyBwb3dlciB0ZWxlbWV0cnkgZGF0YSBhbmQgY2FsY3VsYXRlcyBtQWggY29uc3VtZWRcbiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2V0Sm91cm5leVBvd2VyQ29uc3VtcHRpb24oXG4gIGRldmljZVVpZDogc3RyaW5nLFxuICBzdGFydFRpbWU6IG51bWJlcixcbiAgZW5kVGltZTogbnVtYmVyXG4pOiBQcm9taXNlPHtcbiAgc3RhcnRfbWFoOiBudW1iZXI7XG4gIGVuZF9tYWg6IG51bWJlcjtcbiAgY29uc3VtZWRfbWFoOiBudW1iZXI7XG4gIHJlYWRpbmdfY291bnQ6IG51bWJlcjtcbn0gfCBudWxsPiB7XG4gIC8vIFF1ZXJ5IHBvd2VyIHRlbGVtZXRyeSB1c2luZyB0aGUgZXZlbnQtdHlwZS1pbmRleCBHU0lcbiAgY29uc3Qgc3RhcnRLZXkgPSBgcG93ZXIjJHtzdGFydFRpbWV9YDtcbiAgY29uc3QgZW5kS2V5ID0gYHBvd2VyIyR7ZW5kVGltZX1gO1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IFRFTEVNRVRSWV9UQUJMRSxcbiAgICBJbmRleE5hbWU6ICdldmVudC10eXBlLWluZGV4JyxcbiAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCBldmVudF90eXBlX3RpbWVzdGFtcCBCRVRXRUVOIDpzdGFydCBBTkQgOmVuZCcsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgJzpzdGFydCc6IHN0YXJ0S2V5LFxuICAgICAgJzplbmQnOiBlbmRLZXksXG4gICAgfSxcbiAgICBTY2FuSW5kZXhGb3J3YXJkOiB0cnVlLCAvLyBDaHJvbm9sb2dpY2FsIG9yZGVyXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zdCBwb3dlclJlYWRpbmdzID0gKHJlc3VsdC5JdGVtcyB8fCBbXSkgYXMgVGVsZW1ldHJ5SXRlbVtdO1xuXG4gIC8vIE5lZWQgYXQgbGVhc3QgMiByZWFkaW5ncyB0byBjYWxjdWxhdGUgY29uc3VtcHRpb25cbiAgaWYgKHBvd2VyUmVhZGluZ3MubGVuZ3RoIDwgMikge1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgLy8gRmlsdGVyIGZvciByZWFkaW5ncyB0aGF0IGhhdmUgbWlsbGlhbXBfaG91cnNcbiAgY29uc3QgdmFsaWRSZWFkaW5ncyA9IHBvd2VyUmVhZGluZ3MuZmlsdGVyKChyKSA9PiB0eXBlb2Ygci5taWxsaWFtcF9ob3VycyA9PT0gJ251bWJlcicpO1xuXG4gIGlmICh2YWxpZFJlYWRpbmdzLmxlbmd0aCA8IDIpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIGNvbnN0IGZpcnN0UmVhZGluZyA9IHZhbGlkUmVhZGluZ3NbMF07XG4gIGNvbnN0IGxhc3RSZWFkaW5nID0gdmFsaWRSZWFkaW5nc1t2YWxpZFJlYWRpbmdzLmxlbmd0aCAtIDFdO1xuXG4gIC8vIFdlIGtub3cgdGhlc2UgYXJlIG51bWJlcnMgc2luY2Ugd2UgZmlsdGVyZWQgZm9yIHRoZW0gYWJvdmVcbiAgY29uc3Qgc3RhcnRNYWggPSBmaXJzdFJlYWRpbmcubWlsbGlhbXBfaG91cnMhO1xuICBjb25zdCBlbmRNYWggPSBsYXN0UmVhZGluZy5taWxsaWFtcF9ob3VycyE7XG5cbiAgLy8gQ2FsY3VsYXRlIGNvbnN1bXB0aW9uIChoYW5kbGUgY291bnRlciByZXNldCBlZGdlIGNhc2UpXG4gIGxldCBjb25zdW1lZE1haCA9IGVuZE1haCAtIHN0YXJ0TWFoO1xuICBpZiAoY29uc3VtZWRNYWggPCAwKSB7XG4gICAgLy8gQ291bnRlciB3YXMgcmVzZXQgZHVyaW5nIGpvdXJuZXkgLSBjYW4ndCBjYWxjdWxhdGUgYWNjdXJhdGVseVxuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBzdGFydF9tYWg6IE1hdGgucm91bmQoc3RhcnRNYWggKiAxMDApIC8gMTAwLFxuICAgIGVuZF9tYWg6IE1hdGgucm91bmQoZW5kTWFoICogMTAwKSAvIDEwMCxcbiAgICBjb25zdW1lZF9tYWg6IE1hdGgucm91bmQoY29uc3VtZWRNYWggKiAxMDApIC8gMTAwLFxuICAgIHJlYWRpbmdfY291bnQ6IHZhbGlkUmVhZGluZ3MubGVuZ3RoLFxuICB9O1xufVxuIl19