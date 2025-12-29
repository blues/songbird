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
    const power = await getJourneyPowerConsumption(deviceUid, startTime, endTime);
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
    const locationPoints = pointsResult.Items || [];
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
    const powerReadings = result.Items || [];
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWpvdXJuZXlzL2luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7R0FXRzs7O0FBRUgsOERBQTBEO0FBQzFELHdEQUEwSTtBQUUxSSwyREFBd0Q7QUFFeEQsTUFBTSxTQUFTLEdBQUcsSUFBSSxnQ0FBYyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQ3pDLE1BQU0sU0FBUyxHQUFHLHFDQUFzQixDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztBQUV6RCxNQUFNLGNBQWMsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGNBQWUsQ0FBQztBQUNuRCxNQUFNLGVBQWUsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGVBQWdCLENBQUM7QUFDckQsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxhQUFjLENBQUM7QUFDakQsTUFBTSxlQUFlLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxlQUFnQixDQUFDO0FBQ3JELE1BQU0sWUFBWSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsWUFBWSxDQUFDO0FBRXZDLE1BQU0sT0FBTyxHQUFHLEtBQUssRUFBRSxLQUEyQixFQUFrQyxFQUFFO0lBQzNGLE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUUvQyxNQUFNLFdBQVcsR0FBRztRQUNsQiw2QkFBNkIsRUFBRSxHQUFHO1FBQ2xDLDhCQUE4QixFQUFFLDRCQUE0QjtRQUM1RCw4QkFBOEIsRUFBRSx5QkFBeUI7S0FDMUQsQ0FBQztJQUVGLElBQUksQ0FBQztRQUNILE1BQU0sTUFBTSxHQUFJLEtBQUssQ0FBQyxjQUFzQixFQUFFLElBQUksRUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLFVBQVUsQ0FBQztRQUMvRSxNQUFNLElBQUksR0FBSSxLQUFL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cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBKb3VybmV5cyBBUEkgTGFtYmRhXG4gKlxuICogSGFuZGxlcyBqb3VybmV5IGFuZCBsb2NhdGlvbiBoaXN0b3J5IHF1ZXJpZXM6XG4gKiAtIEdFVCAvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vam91cm5leXMgLSBMaXN0IGFsbCBqb3VybmV5cyBmb3IgYSBkZXZpY2VcbiAqIC0gR0VUIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9qb3VybmV5cy97am91cm5leV9pZH0gLSBHZXQgam91cm5leSBkZXRhaWxzIHdpdGggcG9pbnRzXG4gKiAtIERFTEVURSAvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vam91cm5leXMve2pvdXJuZXlfaWR9IC0gRGVsZXRlIGEgam91cm5leSAoYWRtaW4vb3duZXIgb25seSlcbiAqIC0gR0VUIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9sb2NhdGlvbnMgLSBHZXQgbG9jYXRpb24gaGlzdG9yeVxuICogLSBQT1NUIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9qb3VybmV5cy97am91cm5leV9pZH0vbWF0Y2ggLSBUcmlnZ2VyIG1hcCBtYXRjaGluZ1xuICpcbiAqIE5vdGU6IFdoZW4gYSBOb3RlY2FyZCBpcyBzd2FwcGVkLCBqb3VybmV5cyBmcm9tIGFsbCBkZXZpY2VfdWlkcyBhcmUgbWVyZ2VkLlxuICovXG5cbmltcG9ydCB7IER5bmFtb0RCQ2xpZW50IH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LWR5bmFtb2RiJztcbmltcG9ydCB7IER5bmFtb0RCRG9jdW1lbnRDbGllbnQsIFF1ZXJ5Q29tbWFuZCwgVXBkYXRlQ29tbWFuZCwgRGVsZXRlQ29tbWFuZCwgR2V0Q29tbWFuZCwgQmF0Y2hXcml0ZUNvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9saWItZHluYW1vZGInO1xuaW1wb3J0IHsgQVBJR2F0ZXdheVByb3h5RXZlbnQsIEFQSUdhdGV3YXlQcm94eUV2ZW50VjIsIEFQSUdhdGV3YXlQcm94eVJlc3VsdCB9IGZyb20gJ2F3cy1sYW1iZGEnO1xuaW1wb3J0IHsgcmVzb2x2ZURldmljZSB9IGZyb20gJy4uL3NoYXJlZC9kZXZpY2UtbG9va3VwJztcblxuY29uc3QgZGRiQ2xpZW50ID0gbmV3IER5bmFtb0RCQ2xpZW50KHt9KTtcbmNvbnN0IGRvY0NsaWVudCA9IER5bmFtb0RCRG9jdW1lbnRDbGllbnQuZnJvbShkZGJDbGllbnQpO1xuXG5jb25zdCBKT1VSTkVZU19UQUJMRSA9IHByb2Nlc3MuZW52LkpPVVJORVlTX1RBQkxFITtcbmNvbnN0IExPQ0FUSU9OU19UQUJMRSA9IHByb2Nlc3MuZW52LkxPQ0FUSU9OU19UQUJMRSE7XG5jb25zdCBERVZJQ0VTX1RBQkxFID0gcHJvY2Vzcy5lbnYuREVWSUNFU19UQUJMRSE7XG5jb25zdCBURUxFTUVUUllfVEFCTEUgPSBwcm9jZXNzLmVudi5URUxFTUVUUllfVEFCTEUhO1xuY29uc3QgTUFQQk9YX1RPS0VOID0gcHJvY2Vzcy5lbnYuTUFQQk9YX1RPS0VOO1xuXG5leHBvcnQgY29uc3QgaGFuZGxlciA9IGFzeW5jIChldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQpOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4gPT4ge1xuICBjb25zb2xlLmxvZygnUmVxdWVzdDonLCBKU09OLnN0cmluZ2lmeShldmVudCkpO1xuXG4gIGNvbnN0IGNvcnNIZWFkZXJzID0ge1xuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nOiAnKicsXG4gICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnMnOiAnQ29udGVudC1UeXBlLEF1dGhvcml6YXRpb24nLFxuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzJzogJ0dFVCxQT1NULERFTEVURSxPUFRJT05TJyxcbiAgfTtcblxuICB0cnkge1xuICAgIGNvbnN0IG1ldGhvZCA9IChldmVudC5yZXF1ZXN0Q29udGV4dCBhcyBhbnkpPy5odHRwPy5tZXRob2QgfHwgZXZlbnQuaHR0cE1ldGhvZDtcbiAgICBjb25zdCBwYXRoID0gKGV2ZW50LnJlcXVlc3RDb250ZXh0IGFzIGFueSk/Lmh0dHA/LnBhdGggfHwgZXZlbnQucGF0aDtcblxuICAgIGlmIChtZXRob2QgPT09ICdPUFRJT05TJykge1xuICAgICAgcmV0dXJuIHsgc3RhdHVzQ29kZTogMjAwLCBoZWFkZXJzOiBjb3JzSGVhZGVycywgYm9keTogJycgfTtcbiAgICB9XG5cbiAgICBjb25zdCBzZXJpYWxOdW1iZXIgPSBldmVudC5wYXRoUGFyYW1ldGVycz8uc2VyaWFsX251bWJlcjtcbiAgICBpZiAoIXNlcmlhbE51bWJlcikge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICBoZWFkZXJzOiBjb3JzSGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ3NlcmlhbF9udW1iZXIgcmVxdWlyZWQnIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBSZXNvbHZlIHNlcmlhbF9udW1iZXIgdG8gYWxsIGFzc29jaWF0ZWQgZGV2aWNlX3VpZHNcbiAgICBjb25zdCByZXNvbHZlZCA9IGF3YWl0IHJlc29sdmVEZXZpY2Uoc2VyaWFsTnVtYmVyKTtcbiAgICBpZiAoIXJlc29sdmVkKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiA0MDQsXG4gICAgICAgIGhlYWRlcnM6IGNvcnNIZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRGV2aWNlIG5vdCBmb3VuZCcgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIGNvbnN0IGpvdXJuZXlJZCA9IGV2ZW50LnBhdGhQYXJhbWV0ZXJzPy5qb3VybmV5X2lkO1xuICAgIGNvbnN0IHF1ZXJ5UGFyYW1zID0gZXZlbnQucXVlcnlTdHJpbmdQYXJhbWV0ZXJzIHx8IHt9O1xuXG4gICAgLy8gR0VUIC9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9sb2NhdGlvbnMgLSBMb2NhdGlvbiBoaXN0b3J5IChtZXJnZWQgZnJvbSBhbGwgTm90ZWNhcmRzKVxuICAgIGlmIChwYXRoLmVuZHNXaXRoKCcvbG9jYXRpb25zJykpIHtcbiAgICAgIHJldHVybiBhd2FpdCBnZXRMb2NhdGlvbkhpc3RvcnkocmVzb2x2ZWQuc2VyaWFsX251bWJlciwgcmVzb2x2ZWQuYWxsX2RldmljZV91aWRzLCBxdWVyeVBhcmFtcywgY29yc0hlYWRlcnMpO1xuICAgIH1cblxuICAgIC8vIFBPU1QgL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2pvdXJuZXlzL3tqb3VybmV5X2lkfS9tYXRjaCAtIE1hcCBtYXRjaGluZ1xuICAgIC8vIE5vdGU6IEZvciBub3csIHdlIG5lZWQgdG8gZmluZCB3aGljaCBkZXZpY2VfdWlkIG93bnMgdGhpcyBqb3VybmV5XG4gICAgaWYgKHBhdGguZW5kc1dpdGgoJy9tYXRjaCcpICYmIG1ldGhvZCA9PT0gJ1BPU1QnICYmIGpvdXJuZXlJZCkge1xuICAgICAgcmV0dXJuIGF3YWl0IG1hdGNoSm91cm5leShyZXNvbHZlZC5hbGxfZGV2aWNlX3VpZHMsIHBhcnNlSW50KGpvdXJuZXlJZCksIGNvcnNIZWFkZXJzKTtcbiAgICB9XG5cbiAgICAvLyBERUxFVEUgL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2pvdXJuZXlzL3tqb3VybmV5X2lkfSAtIERlbGV0ZSBqb3VybmV5IChhZG1pbi9vd25lciBvbmx5KVxuICAgIGlmIChtZXRob2QgPT09ICdERUxFVEUnICYmIGpvdXJuZXlJZCkge1xuICAgICAgcmV0dXJuIGF3YWl0IGRlbGV0ZUpvdXJuZXkocmVzb2x2ZWQuc2VyaWFsX251bWJlciwgcmVzb2x2ZWQuYWxsX2RldmljZV91aWRzLCBwYXJzZUludChqb3VybmV5SWQpLCBldmVudCwgY29yc0hlYWRlcnMpO1xuICAgIH1cblxuICAgIC8vIEdFVCAvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vam91cm5leXMve2pvdXJuZXlfaWR9IC0gU2luZ2xlIGpvdXJuZXkgd2l0aCBwb2ludHNcbiAgICBpZiAoam91cm5leUlkKSB7XG4gICAgICByZXR1cm4gYXdhaXQgZ2V0Sm91cm5leURldGFpbChyZXNvbHZlZC5hbGxfZGV2aWNlX3VpZHMsIHBhcnNlSW50KGpvdXJuZXlJZCksIGNvcnNIZWFkZXJzKTtcbiAgICB9XG5cbiAgICAvLyBHRVQgL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2pvdXJuZXlzIC0gTGlzdCBqb3VybmV5cyAobWVyZ2VkIGZyb20gYWxsIE5vdGVjYXJkcylcbiAgICByZXR1cm4gYXdhaXQgbGlzdEpvdXJuZXlzKHJlc29sdmVkLnNlcmlhbF9udW1iZXIsIHJlc29sdmVkLmFsbF9kZXZpY2VfdWlkcywgcXVlcnlQYXJhbXMsIGNvcnNIZWFkZXJzKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvcjonLCBlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMCxcbiAgICAgIGhlYWRlcnM6IGNvcnNIZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0ludGVybmFsIHNlcnZlciBlcnJvcicgfSksXG4gICAgfTtcbiAgfVxufTtcblxuLyoqXG4gKiBMaXN0IGFsbCBqb3VybmV5cyBmb3IgYSBkZXZpY2UgKG1lcmdlZCBmcm9tIGFsbCBOb3RlY2FyZHMpXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGxpc3RKb3VybmV5cyhcbiAgc2VyaWFsTnVtYmVyOiBzdHJpbmcsXG4gIGRldmljZVVpZHM6IHN0cmluZ1tdLFxuICBxdWVyeVBhcmFtczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgdW5kZWZpbmVkPixcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgY29uc3Qgc3RhdHVzID0gcXVlcnlQYXJhbXMuc3RhdHVzOyAvLyAnYWN0aXZlJyB8ICdjb21wbGV0ZWQnIHwgdW5kZWZpbmVkIChhbGwpXG4gIGNvbnN0IGxpbWl0ID0gcGFyc2VJbnQocXVlcnlQYXJhbXMubGltaXQgfHwgJzUwJyk7XG5cbiAgLy8gUXVlcnkgYWxsIGRldmljZV91aWRzIGluIHBhcmFsbGVsXG4gIGNvbnN0IHF1ZXJ5UHJvbWlzZXMgPSBkZXZpY2VVaWRzLm1hcChhc3luYyAoZGV2aWNlVWlkKSA9PiB7XG4gICAgY29uc3QgY29tbWFuZCA9IG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkID0gOmRldmljZV91aWQnLFxuICAgICAgLi4uKHN0YXR1cyAmJiB7XG4gICAgICAgIEZpbHRlckV4cHJlc3Npb246ICcjc3RhdHVzID0gOnN0YXR1cycsXG4gICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczogeyAnI3N0YXR1cyc6ICdzdGF0dXMnIH0sXG4gICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgICAnOmRldmljZV91aWQnOiBkZXZpY2VVaWQsXG4gICAgICAgICAgJzpzdGF0dXMnOiBzdGF0dXMsXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICAgIC4uLighc3RhdHVzICYmIHtcbiAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICAgU2NhbkluZGV4Rm9yd2FyZDogZmFsc2UsXG4gICAgICBMaW1pdDogbGltaXQsXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgICByZXR1cm4gcmVzdWx0Lkl0ZW1zIHx8IFtdO1xuICB9KTtcblxuICBjb25zdCBhbGxSZXN1bHRzID0gYXdhaXQgUHJvbWlzZS5hbGwocXVlcnlQcm9taXNlcyk7XG5cbiAgLy8gTWVyZ2UgYW5kIHNvcnQgYnkgam91cm5leV9pZCAod2hpY2ggaXMgdGhlIHN0YXJ0IHRpbWVzdGFtcCwgZGVzY2VuZGluZylcbiAgY29uc3QgbWVyZ2VkSm91cm5leXMgPSBhbGxSZXN1bHRzXG4gICAgLmZsYXQoKVxuICAgIC5zb3J0KChhLCBiKSA9PiBiLmpvdXJuZXlfaWQgLSBhLmpvdXJuZXlfaWQpXG4gICAgLnNsaWNlKDAsIGxpbWl0KVxuICAgIC5tYXAoKGl0ZW0pID0+ICh7XG4gICAgICBqb3VybmV5X2lkOiBpdGVtLmpvdXJuZXlfaWQsXG4gICAgICBkZXZpY2VfdWlkOiBpdGVtLmRldmljZV91aWQsXG4gICAgICBzdGFydF90aW1lOiBuZXcgRGF0ZShpdGVtLnN0YXJ0X3RpbWUpLnRvSVNPU3RyaW5nKCksXG4gICAgICBlbmRfdGltZTogaXRlbS5lbmRfdGltZSA/IG5ldyBEYXRlKGl0ZW0uZW5kX3RpbWUpLnRvSVNPU3RyaW5nKCkgOiB1bmRlZmluZWQsXG4gICAgICBwb2ludF9jb3VudDogaXRlbS5wb2ludF9jb3VudCB8fCAwLFxuICAgICAgdG90YWxfZGlzdGFuY2U6IGl0ZW0udG90YWxfZGlzdGFuY2UgfHwgMCxcbiAgICAgIHN0YXR1czogaXRlbS5zdGF0dXMsXG4gICAgfSkpO1xuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgc2VyaWFsX251bWJlcjogc2VyaWFsTnVtYmVyLFxuICAgICAgam91cm5leXM6IG1lcmdlZEpvdXJuZXlzLFxuICAgICAgY291bnQ6IG1lcmdlZEpvdXJuZXlzLmxlbmd0aCxcbiAgICB9KSxcbiAgfTtcbn1cblxuLyoqXG4gKiBHZXQgYSBzaW5nbGUgam91cm5leSB3aXRoIGFsbCBpdHMgbG9jYXRpb24gcG9pbnRzXG4gKiBTZWFyY2hlcyBhY3Jvc3MgYWxsIGRldmljZV91aWRzIHRvIGZpbmQgdGhlIGpvdXJuZXlcbiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2V0Sm91cm5leURldGFpbChcbiAgZGV2aWNlVWlkczogc3RyaW5nW10sXG4gIGpvdXJuZXlJZDogbnVtYmVyLFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICAvLyBTZWFyY2ggZm9yIHRoZSBqb3VybmV5IGFjcm9zcyBhbGwgZGV2aWNlX3VpZHNcbiAgbGV0IGpvdXJuZXlJdGVtOiBhbnkgPSBudWxsO1xuICBsZXQgb3duZXJEZXZpY2VVaWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4gIGZvciAoY29uc3QgZGV2aWNlVWlkIG9mIGRldmljZVVpZHMpIHtcbiAgICBjb25zdCBqb3VybmV5Q29tbWFuZCA9IG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkID0gOmRldmljZV91aWQgQU5EIGpvdXJuZXlfaWQgPSA6am91cm5leV9pZCcsXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICAgICAgJzpqb3VybmV5X2lkJzogam91cm5leUlkLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGpvdXJuZXlSZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChqb3VybmV5Q29tbWFuZCk7XG5cbiAgICBpZiAoam91cm5leVJlc3VsdC5JdGVtcyAmJiBqb3VybmV5UmVzdWx0Lkl0ZW1zLmxlbmd0aCA+IDApIHtcbiAgICAgIGpvdXJuZXlJdGVtID0gam91cm5leVJlc3VsdC5JdGVtc1swXTtcbiAgICAgIG93bmVyRGV2aWNlVWlkID0gZGV2aWNlVWlkO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG5cbiAgaWYgKCFqb3VybmV5SXRlbSB8fCAhb3duZXJEZXZpY2VVaWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdKb3VybmV5IG5vdCBmb3VuZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8vIEdldCBhbGwgbG9jYXRpb24gcG9pbnRzIGZvciB0aGlzIGpvdXJuZXkgdXNpbmcgdGhlIGpvdXJuZXktaW5kZXggR1NJXG4gIGNvbnN0IHBvaW50c0NvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IExPQ0FUSU9OU19UQUJMRSxcbiAgICBJbmRleE5hbWU6ICdqb3VybmV5LWluZGV4JyxcbiAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCBqb3VybmV5X2lkID0gOmpvdXJuZXlfaWQnLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6ZGV2aWNlX3VpZCc6IG93bmVyRGV2aWNlVWlkLFxuICAgICAgJzpqb3VybmV5X2lkJzogam91cm5leUlkLFxuICAgIH0sXG4gICAgU2NhbkluZGV4Rm9yd2FyZDogdHJ1ZSwgLy8gQ2hyb25vbG9naWNhbCBvcmRlclxuICB9KTtcblxuICBjb25zdCBwb2ludHNSZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChwb2ludHNDb21tYW5kKTtcblxuICBjb25zdCBzdGFydFRpbWUgPSBqb3VybmV5SXRlbS5zdGFydF90aW1lO1xuICBjb25zdCBlbmRUaW1lID0gam91cm5leUl0ZW0uZW5kX3RpbWUgfHwgRGF0ZS5ub3coKTtcblxuICBjb25zdCBqb3VybmV5ID0ge1xuICAgIGpvdXJuZXlfaWQ6IGpvdXJuZXlJdGVtLmpvdXJuZXlfaWQsXG4gICAgZGV2aWNlX3VpZDogam91cm5leUl0ZW0uZGV2aWNlX3VpZCxcbiAgICBzdGFydF90aW1lOiBuZXcgRGF0ZShzdGFydFRpbWUpLnRvSVNPU3RyaW5nKCksXG4gICAgZW5kX3RpbWU6IGpvdXJuZXlJdGVtLmVuZF90aW1lID8gbmV3IERhdGUoam91cm5leUl0ZW0uZW5kX3RpbWUpLnRvSVNPU3RyaW5nKCkgOiB1bmRlZmluZWQsXG4gICAgcG9pbnRfY291bnQ6IGpvdXJuZXlJdGVtLnBvaW50X2NvdW50IHx8IDAsXG4gICAgdG90YWxfZGlzdGFuY2U6IGpvdXJuZXlJdGVtLnRvdGFsX2Rpc3RhbmNlIHx8IDAsXG4gICAgc3RhdHVzOiBqb3VybmV5SXRlbS5zdGF0dXMsXG4gICAgbWF0Y2hlZF9yb3V0ZTogam91cm5leUl0ZW0ubWF0Y2hlZF9yb3V0ZSwgLy8gR2VvSlNPTiBMaW5lU3RyaW5nIGlmIG1hcC1tYXRjaGVkXG4gIH07XG5cbiAgLy8gU29ydCBwb2ludHMgYnkgdGltZXN0YW1wIChHU0kgZG9lc24ndCBndWFyYW50ZWUgb3JkZXIgd2l0aGluIHNhbWUgam91cm5leV9pZClcbiAgY29uc3Qgc29ydGVkSXRlbXMgPSAocG9pbnRzUmVzdWx0Lkl0ZW1zIHx8IFtdKS5zb3J0KChhLCBiKSA9PiBhLnRpbWVzdGFtcCAtIGIudGltZXN0YW1wKTtcblxuICBjb25zdCBwb2ludHMgPSBzb3J0ZWRJdGVtcy5tYXAoKGl0ZW0pID0+ICh7XG4gICAgdGltZTogbmV3IERhdGUoaXRlbS50aW1lc3RhbXApLnRvSVNPU3RyaW5nKCksXG4gICAgbGF0OiBpdGVtLmxhdGl0dWRlLFxuICAgIGxvbjogaXRlbS5sb25naXR1ZGUsXG4gICAgdmVsb2NpdHk6IGl0ZW0udmVsb2NpdHksXG4gICAgYmVhcmluZzogaXRlbS5iZWFyaW5nLFxuICAgIGRpc3RhbmNlOiBpdGVtLmRpc3RhbmNlLFxuICAgIGRvcDogaXRlbS5kb3AsXG4gICAgamNvdW50OiBpdGVtLmpjb3VudCxcbiAgfSkpO1xuXG4gIC8vIEdldCBwb3dlciBjb25zdW1wdGlvbiBmb3IgdGhpcyBqb3VybmV5XG4gIGNvbnN0IHBvd2VyID0gYXdhaXQgZ2V0Sm91cm5leVBvd2VyQ29uc3VtcHRpb24oZGV2aWNlVWlkLCBzdGFydFRpbWUsIGVuZFRpbWUpO1xuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgam91cm5leSxcbiAgICAgIHBvaW50cyxcbiAgICAgIHBvd2VyLFxuICAgIH0pLFxuICB9O1xufVxuXG4vKipcbiAqIENhbGwgTWFwYm94IE1hcCBNYXRjaGluZyBBUEkgYW5kIGNhY2hlIHRoZSByZXN1bHRcbiAqIFNlYXJjaGVzIGFjcm9zcyBhbGwgZGV2aWNlX3VpZHMgdG8gZmluZCB0aGUgam91cm5leVxuICovXG5hc3luYyBmdW5jdGlvbiBtYXRjaEpvdXJuZXkoXG4gIGRldmljZVVpZHM6IHN0cmluZ1tdLFxuICBqb3VybmV5SWQ6IG51bWJlcixcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgaWYgKCFNQVBCT1hfVE9LRU4pIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNTAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdNYXAgbWF0Y2hpbmcgbm90IGNvbmZpZ3VyZWQnIH0pLFxuICAgIH07XG4gIH1cblxuICAvLyBGaW5kIHdoaWNoIGRldmljZV91aWQgb3ducyB0aGlzIGpvdXJuZXlcbiAgbGV0IG93bmVyRGV2aWNlVWlkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuICBmb3IgKGNvbnN0IGRldmljZVVpZCBvZiBkZXZpY2VVaWRzKSB7XG4gICAgY29uc3Qgam91cm5leUNvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogSk9VUk5FWVNfVEFCTEUsXG4gICAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCBqb3VybmV5X2lkID0gOmpvdXJuZXlfaWQnLFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAnOmRldmljZV91aWQnOiBkZXZpY2VVaWQsXG4gICAgICAgICc6am91cm5leV9pZCc6IGpvdXJuZXlJZCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBqb3VybmV5UmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoam91cm5leUNvbW1hbmQpO1xuXG4gICAgaWYgKGpvdXJuZXlSZXN1bHQuSXRlbXMgJiYgam91cm5leVJlc3VsdC5JdGVtcy5sZW5ndGggPiAwKSB7XG4gICAgICBvd25lckRldmljZVVpZCA9IGRldmljZVVpZDtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIGlmICghb3duZXJEZXZpY2VVaWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdKb3VybmV5IG5vdCBmb3VuZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8vIEdldCB0aGUgam91cm5leSBwb2ludHNcbiAgY29uc3QgcG9pbnRzQ29tbWFuZCA9IG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogTE9DQVRJT05TX1RBQkxFLFxuICAgIEluZGV4TmFtZTogJ2pvdXJuZXktaW5kZXgnLFxuICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkID0gOmRldmljZV91aWQgQU5EIGpvdXJuZXlfaWQgPSA6am91cm5leV9pZCcsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzpkZXZpY2VfdWlkJzogb3duZXJEZXZpY2VVaWQsXG4gICAgICAnOmpvdXJuZXlfaWQnOiBqb3VybmV5SWQsXG4gICAgfSxcbiAgICBTY2FuSW5kZXhGb3J3YXJkOiB0cnVlLFxuICB9KTtcblxuICBjb25zdCBwb2ludHNSZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChwb2ludHNDb21tYW5kKTtcblxuICAvLyBTb3J0IHBvaW50cyBieSB0aW1lc3RhbXAgKEdTSSBkb2Vzbid0IGd1YXJhbnRlZSBvcmRlciB3aXRoaW4gc2FtZSBqb3VybmV5X2lkKVxuICBjb25zdCBwb2ludHMgPSAocG9pbnRzUmVzdWx0Lkl0ZW1zIHx8IFtdKS5zb3J0KChhLCBiKSA9PiBhLnRpbWVzdGFtcCAtIGIudGltZXN0YW1wKTtcblxuICBpZiAocG9pbnRzLmxlbmd0aCA8IDIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdKb3VybmV5IGhhcyBmZXdlciB0aGFuIDIgcG9pbnRzJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gTWFwYm94IE1hcCBNYXRjaGluZyBBUEkgaGFzIGEgbGltaXQgb2YgMTAwIGNvb3JkaW5hdGVzIHBlciByZXF1ZXN0XG4gIC8vIElmIHdlIGhhdmUgbW9yZSwgd2UgbmVlZCB0byBzYW1wbGUgb3IgYmF0Y2hcbiAgY29uc3QgbWF4UG9pbnRzID0gMTAwO1xuICBsZXQgc2FtcGxlZFBvaW50cyA9IHBvaW50cztcbiAgaWYgKHBvaW50cy5sZW5ndGggPiBtYXhQb2ludHMpIHtcbiAgICAvLyBTYW1wbGUgcG9pbnRzIGV2ZW5seVxuICAgIGNvbnN0IHN0ZXAgPSAocG9pbnRzLmxlbmd0aCAtIDEpIC8gKG1heFBvaW50cyAtIDEpO1xuICAgIHNhbXBsZWRQb2ludHMgPSBbXTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG1heFBvaW50czsgaSsrKSB7XG4gICAgICBjb25zdCBpZHggPSBNYXRoLnJvdW5kKGkgKiBzdGVwKTtcbiAgICAgIHNhbXBsZWRQb2ludHMucHVzaChwb2ludHNbaWR4XSk7XG4gICAgfVxuICB9XG5cbiAgLy8gRm9ybWF0IGNvb3JkaW5hdGVzIGZvciBNYXBib3ggQVBJOiBsb24sbGF0O2xvbixsYXQ7Li4uXG4gIGNvbnN0IGNvb3JkaW5hdGVzID0gc2FtcGxlZFBvaW50c1xuICAgIC5tYXAoKHApID0+IGAke3AubG9uZ2l0dWRlfSwke3AubGF0aXR1ZGV9YClcbiAgICAuam9pbignOycpO1xuXG4gIC8vIEJ1aWxkIHRoZSB0aW1lc3RhbXBzIHBhcmFtZXRlciAoVW5peCB0aW1lc3RhbXBzIGluIHNlY29uZHMpXG4gIGNvbnN0IHRpbWVzdGFtcHMgPSBzYW1wbGVkUG9pbnRzXG4gICAgLm1hcCgocCkgPT4gTWF0aC5mbG9vcihwLnRpbWVzdGFtcCAvIDEwMDApKVxuICAgIC5qb2luKCc7Jyk7XG5cbiAgLy8gQnVpbGQgdGhlIHJhZGl1c2VzIHBhcmFtZXRlciAoR1BTIGFjY3VyYWN5IGluIG1ldGVycywgZGVmYXVsdCAyNW0pXG4gIGNvbnN0IHJhZGl1c2VzID0gc2FtcGxlZFBvaW50c1xuICAgIC5tYXAoKHApID0+IChwLmRvcCA/IE1hdGgubWF4KDUsIHAuZG9wICogMTApIDogMjUpKVxuICAgIC5qb2luKCc7Jyk7XG5cbiAgLy8gQ2FsbCBNYXBib3ggTWFwIE1hdGNoaW5nIEFQSVxuICBjb25zdCBtYXBNYXRjaFVybCA9IGBodHRwczovL2FwaS5tYXBib3guY29tL21hdGNoaW5nL3Y1L21hcGJveC9kcml2aW5nLyR7Y29vcmRpbmF0ZXN9P2FjY2Vzc190b2tlbj0ke01BUEJPWF9UT0tFTn0mZ2VvbWV0cmllcz1nZW9qc29uJnJhZGl1c2VzPSR7cmFkaXVzZXN9JnRpbWVzdGFtcHM9JHt0aW1lc3RhbXBzfSZvdmVydmlldz1mdWxsJnN0ZXBzPWZhbHNlYDtcblxuICBjb25zb2xlLmxvZyhgQ2FsbGluZyBNYXBib3ggTWFwIE1hdGNoaW5nIEFQSSBmb3Igam91cm5leSAke2pvdXJuZXlJZH0gd2l0aCAke3NhbXBsZWRQb2ludHMubGVuZ3RofSBwb2ludHNgKTtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2gobWFwTWF0Y2hVcmwpO1xuICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XG5cbiAgICBpZiAoZGF0YS5jb2RlICE9PSAnT2snIHx8ICFkYXRhLm1hdGNoaW5ncyB8fCBkYXRhLm1hdGNoaW5ncy5sZW5ndGggPT09IDApIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ01hcCBtYXRjaGluZyBmYWlsZWQ6JywgZGF0YSk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICBlcnJvcjogJ01hcCBtYXRjaGluZyBmYWlsZWQnLFxuICAgICAgICAgIGNvZGU6IGRhdGEuY29kZSxcbiAgICAgICAgICBtZXNzYWdlOiBkYXRhLm1lc3NhZ2UsXG4gICAgICAgIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBHZXQgdGhlIG1hdGNoZWQgZ2VvbWV0cnkgKEdlb0pTT04gTGluZVN0cmluZylcbiAgICBjb25zdCBtYXRjaGVkUm91dGUgPSBkYXRhLm1hdGNoaW5nc1swXS5nZW9tZXRyeTtcbiAgICBjb25zdCBjb25maWRlbmNlID0gZGF0YS5tYXRjaGluZ3NbMF0uY29uZmlkZW5jZTtcblxuICAgIC8vIFN0b3JlIHRoZSBtYXRjaGVkIHJvdXRlIGluIER5bmFtb0RCXG4gICAgY29uc3QgdXBkYXRlQ29tbWFuZCA9IG5ldyBVcGRhdGVDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogSk9VUk5FWVNfVEFCTEUsXG4gICAgICBLZXk6IHtcbiAgICAgICAgZGV2aWNlX3VpZDogb3duZXJEZXZpY2VVaWQsXG4gICAgICAgIGpvdXJuZXlfaWQ6IGpvdXJuZXlJZCxcbiAgICAgIH0sXG4gICAgICBVcGRhdGVFeHByZXNzaW9uOiAnU0VUIG1hdGNoZWRfcm91dGUgPSA6cm91dGUsIG1hdGNoX2NvbmZpZGVuY2UgPSA6Y29uZmlkZW5jZSwgbWF0Y2hlZF9hdCA9IDp0aW1lJyxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgJzpyb3V0ZSc6IG1hdGNoZWRSb3V0ZSxcbiAgICAgICAgJzpjb25maWRlbmNlJzogY29uZmlkZW5jZSxcbiAgICAgICAgJzp0aW1lJzogRGF0ZS5ub3coKSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBhd2FpdCBkb2NDbGllbnQuc2VuZCh1cGRhdGVDb21tYW5kKTtcbiAgICBjb25zb2xlLmxvZyhgU3RvcmVkIG1hdGNoZWQgcm91dGUgZm9yIGpvdXJuZXkgJHtqb3VybmV5SWR9IHdpdGggY29uZmlkZW5jZSAke2NvbmZpZGVuY2V9YCk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgbWF0Y2hlZF9yb3V0ZTogbWF0Y2hlZFJvdXRlLFxuICAgICAgICBjb25maWRlbmNlLFxuICAgICAgICBvcmlnaW5hbF9wb2ludHM6IHBvaW50cy5sZW5ndGgsXG4gICAgICAgIG1hdGNoZWRfcG9pbnRzOiBzYW1wbGVkUG9pbnRzLmxlbmd0aCxcbiAgICAgIH0pLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3IgY2FsbGluZyBNYXBib3ggQVBJOicsIGVycm9yKTtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNTAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdGYWlsZWQgdG8gY2FsbCBtYXAgbWF0Y2hpbmcgQVBJJyB9KSxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogR2V0IGxvY2F0aW9uIGhpc3RvcnkgZm9yIGEgZGV2aWNlIChtZXJnZWQgZnJvbSBhbGwgTm90ZWNhcmRzKVxuICovXG5hc3luYyBmdW5jdGlvbiBnZXRMb2NhdGlvbkhpc3RvcnkoXG4gIHNlcmlhbE51bWJlcjogc3RyaW5nLFxuICBkZXZpY2VVaWRzOiBzdHJpbmdbXSxcbiAgcXVlcnlQYXJhbXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD4sXG4gIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiB7XG4gIGNvbnN0IGhvdXJzID0gcGFyc2VJbnQocXVlcnlQYXJhbXMuaG91cnMgfHwgJzI0Jyk7XG4gIGNvbnN0IHNvdXJjZSA9IHF1ZXJ5UGFyYW1zLnNvdXJjZTsgLy8gJ2dwcycgfCAnY2VsbCcgfCAndHJpYW5ndWxhdGlvbicgfCB1bmRlZmluZWQgKGFsbClcbiAgY29uc3QgbGltaXQgPSBwYXJzZUludChxdWVyeVBhcmFtcy5saW1pdCB8fCAnMTAwMCcpO1xuXG4gIGNvbnN0IGN1dG9mZlRpbWUgPSBEYXRlLm5vdygpIC0gaG91cnMgKiA2MCAqIDYwICogMTAwMDtcblxuICAvLyBRdWVyeSBhbGwgZGV2aWNlX3VpZHMgaW4gcGFyYWxsZWxcbiAgY29uc3QgcXVlcnlQcm9taXNlcyA9IGRldmljZVVpZHMubWFwKGFzeW5jIChkZXZpY2VVaWQpID0+IHtcbiAgICBjb25zdCBjb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IExPQ0FUSU9OU19UQUJMRSxcbiAgICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkID0gOmRldmljZV91aWQgQU5EICN0aW1lc3RhbXAgPj0gOmN1dG9mZicsXG4gICAgICAuLi4oc291cmNlICYmIHtcbiAgICAgICAgRmlsdGVyRXhwcmVzc2lvbjogJyNzb3VyY2UgPSA6c291cmNlJyxcbiAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAgICAgJyN0aW1lc3RhbXAnOiAndGltZXN0YW1wJyxcbiAgICAgICAgICAnI3NvdXJjZSc6ICdzb3VyY2UnLFxuICAgICAgICB9LFxuICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgICAgICc6Y3V0b2ZmJzogY3V0b2ZmVGltZSxcbiAgICAgICAgICAnOnNvdXJjZSc6IHNvdXJjZSxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICAgLi4uKCFzb3VyY2UgJiYge1xuICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICAgICAnI3RpbWVzdGFtcCc6ICd0aW1lc3RhbXAnLFxuICAgICAgICB9LFxuICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgICAgICc6Y3V0b2ZmJzogY3V0b2ZmVGltZSxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICAgU2NhbkluZGV4Rm9yd2FyZDogZmFsc2UsXG4gICAgICBMaW1pdDogbGltaXQsXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgICByZXR1cm4gcmVzdWx0Lkl0ZW1zIHx8IFtdO1xuICB9KTtcblxuICBjb25zdCBhbGxSZXN1bHRzID0gYXdhaXQgUHJvbWlzZS5hbGwocXVlcnlQcm9taXNlcyk7XG5cbiAgLy8gTWVyZ2UgYW5kIHNvcnQgYnkgdGltZXN0YW1wIChtb3N0IHJlY2VudCBmaXJzdCksIHRoZW4gYXBwbHkgbGltaXRcbiAgY29uc3QgbWVyZ2VkTG9jYXRpb25zID0gYWxsUmVzdWx0c1xuICAgIC5mbGF0KClcbiAgICAuc29ydCgoYSwgYikgPT4gYi50aW1lc3RhbXAgLSBhLnRpbWVzdGFtcClcbiAgICAuc2xpY2UoMCwgbGltaXQpXG4gICAgLm1hcCgoaXRlbSkgPT4gKHtcbiAgICAgIHRpbWU6IG5ldyBEYXRlKGl0ZW0udGltZXN0YW1wKS50b0lTT1N0cmluZygpLFxuICAgICAgbGF0OiBpdGVtLmxhdGl0dWRlLFxuICAgICAgbG9uOiBpdGVtLmxvbmdpdHVkZSxcbiAgICAgIHNvdXJjZTogaXRlbS5zb3VyY2UsXG4gICAgICBsb2NhdGlvbl9uYW1lOiBpdGVtLmxvY2F0aW9uX25hbWUsXG4gICAgICBldmVudF90eXBlOiBpdGVtLmV2ZW50X3R5cGUsXG4gICAgICBqb3VybmV5X2lkOiBpdGVtLmpvdXJuZXlfaWQsXG4gICAgICBqY291bnQ6IGl0ZW0uamNvdW50LFxuICAgICAgdmVsb2NpdHk6IGl0ZW0udmVsb2NpdHksXG4gICAgICBiZWFyaW5nOiBpdGVtLmJlYXJpbmcsXG4gICAgfSkpO1xuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgc2VyaWFsX251bWJlcjogc2VyaWFsTnVtYmVyLFxuICAgICAgaG91cnMsXG4gICAgICBjb3VudDogbWVyZ2VkTG9jYXRpb25zLmxlbmd0aCxcbiAgICAgIGxvY2F0aW9uczogbWVyZ2VkTG9jYXRpb25zLFxuICAgIH0pLFxuICB9O1xufVxuXG4vKipcbiAqIENoZWNrIGlmIHRoZSB1c2VyIGlzIGFuIGFkbWluIChpbiAnQWRtaW4nIENvZ25pdG8gZ3JvdXApXG4gKi9cbmZ1bmN0aW9uIGlzQWRtaW4oZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50KTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgY29uc3QgY2xhaW1zID0gKGV2ZW50LnJlcXVlc3RDb250ZXh0IGFzIGFueSk/LmF1dGhvcml6ZXI/Lmp3dD8uY2xhaW1zO1xuICAgIGlmICghY2xhaW1zKSByZXR1cm4gZmFsc2U7XG5cbiAgICBjb25zdCBncm91cHMgPSBjbGFpbXNbJ2NvZ25pdG86Z3JvdXBzJ107XG4gICAgaWYgKEFycmF5LmlzQXJyYXkoZ3JvdXBzKSkge1xuICAgICAgcmV0dXJuIGdyb3Vwcy5pbmNsdWRlcygnQWRtaW4nKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBncm91cHMgPT09ICdzdHJpbmcnKSB7XG4gICAgICByZXR1cm4gZ3JvdXBzID09PSAnQWRtaW4nIHx8IGdyb3Vwcy5pbmNsdWRlcygnQWRtaW4nKTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqXG4gKiBHZXQgdGhlIHVzZXIncyBlbWFpbCBmcm9tIHRoZSBKV1QgY2xhaW1zXG4gKi9cbmZ1bmN0aW9uIGdldFVzZXJFbWFpbChldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICB0cnkge1xuICAgIGNvbnN0IGNsYWltcyA9IChldmVudC5yZXF1ZXN0Q29udGV4dCBhcyBhbnkpPy5hdXRob3JpemVyPy5qd3Q/LmNsYWltcztcbiAgICByZXR1cm4gY2xhaW1zPy5lbWFpbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxufVxuXG4vKipcbiAqIENoZWNrIGlmIHRoZSB1c2VyIG93bnMgdGhlIGRldmljZSAoaXMgYXNzaWduZWQgdG8gaXQpXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGlzRGV2aWNlT3duZXIoZGV2aWNlVWlkOiBzdHJpbmcsIHVzZXJFbWFpbDogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgR2V0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgIEtleTogeyBkZXZpY2VfdWlkOiBkZXZpY2VVaWQgfSxcbiAgICBQcm9qZWN0aW9uRXhwcmVzc2lvbjogJ2Fzc2lnbmVkX3RvJyxcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIHJldHVybiByZXN1bHQuSXRlbT8uYXNzaWduZWRfdG8gPT09IHVzZXJFbWFpbDtcbn1cblxuLyoqXG4gKiBEZWxldGUgYSBqb3VybmV5IGFuZCBhbGwgaXRzIGxvY2F0aW9uIHBvaW50cyAoYWRtaW4vb3duZXIgb25seSlcbiAqIFNlYXJjaGVzIGFjcm9zcyBhbGwgZGV2aWNlX3VpZHMgdG8gZmluZCBhbmQgZGVsZXRlIHRoZSBqb3VybmV5XG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGRlbGV0ZUpvdXJuZXkoXG4gIHNlcmlhbE51bWJlcjogc3RyaW5nLFxuICBkZXZpY2VVaWRzOiBzdHJpbmdbXSxcbiAgam91cm5leUlkOiBudW1iZXIsXG4gIGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudCxcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgLy8gQXV0aG9yaXphdGlvbiBjaGVjazogbXVzdCBiZSBhZG1pbiBvciBkZXZpY2Ugb3duZXJcbiAgY29uc3QgdXNlckVtYWlsID0gZ2V0VXNlckVtYWlsKGV2ZW50KTtcbiAgY29uc3QgYWRtaW4gPSBpc0FkbWluKGV2ZW50KTtcblxuICAvLyBGaW5kIHdoaWNoIGRldmljZV91aWQgb3ducyB0aGlzIGpvdXJuZXlcbiAgbGV0IG93bmVyRGV2aWNlVWlkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuICBmb3IgKGNvbnN0IGRldmljZVVpZCBvZiBkZXZpY2VVaWRzKSB7XG4gICAgY29uc3Qgam91cm5leUNvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogSk9VUk5FWVNfVEFCTEUsXG4gICAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCBqb3VybmV5X2lkID0gOmpvdXJuZXlfaWQnLFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAnOmRldmljZV91aWQnOiBkZXZpY2VVaWQsXG4gICAgICAgICc6am91cm5leV9pZCc6IGpvdXJuZXlJZCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBqb3VybmV5UmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoam91cm5leUNvbW1hbmQpO1xuXG4gICAgaWYgKGpvdXJuZXlSZXN1bHQuSXRlbXMgJiYgam91cm5leVJlc3VsdC5JdGVtcy5sZW5ndGggPiAwKSB7XG4gICAgICBvd25lckRldmljZVVpZCA9IGRldmljZVVpZDtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIGlmICghb3duZXJEZXZpY2VVaWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdKb3VybmV5IG5vdCBmb3VuZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIGlmICghYWRtaW4pIHtcbiAgICBpZiAoIXVzZXJFbWFpbCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDAxLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnVW5hdXRob3JpemVkJyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgY29uc3Qgb3duZXIgPSBhd2FpdCBpc0RldmljZU93bmVyKG93bmVyRGV2aWNlVWlkLCB1c2VyRW1haWwpO1xuICAgIGlmICghb3duZXIpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwMyxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0FkbWluIG9yIGRldmljZSBvd25lciBhY2Nlc3MgcmVxdWlyZWQnIH0pLFxuICAgICAgfTtcbiAgICB9XG4gIH1cblxuICAvLyBHZXQgYWxsIGxvY2F0aW9uIHBvaW50cyBmb3IgdGhpcyBqb3VybmV5IHRvIGRlbGV0ZSB0aGVtXG4gIGNvbnN0IHBvaW50c0NvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IExPQ0FUSU9OU19UQUJMRSxcbiAgICBJbmRleE5hbWU6ICdqb3VybmV5LWluZGV4JyxcbiAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCBqb3VybmV5X2lkID0gOmpvdXJuZXlfaWQnLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6ZGV2aWNlX3VpZCc6IG93bmVyRGV2aWNlVWlkLFxuICAgICAgJzpqb3VybmV5X2lkJzogam91cm5leUlkLFxuICAgIH0sXG4gICAgUHJvamVjdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkLCAjdHMnLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczoge1xuICAgICAgJyN0cyc6ICd0aW1lc3RhbXAnLFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IHBvaW50c1Jlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKHBvaW50c0NvbW1hbmQpO1xuICBjb25zdCBsb2NhdGlvblBvaW50cyA9IHBvaW50c1Jlc3VsdC5JdGVtcyB8fCBbXTtcblxuICAvLyBEZWxldGUgbG9jYXRpb24gcG9pbnRzIGluIGJhdGNoZXMgb2YgMjUgKER5bmFtb0RCIEJhdGNoV3JpdGUgbGltaXQpXG4gIGlmIChsb2NhdGlvblBvaW50cy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgYmF0Y2hlcyA9IFtdO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgbG9jYXRpb25Qb2ludHMubGVuZ3RoOyBpICs9IDI1KSB7XG4gICAgICBjb25zdCBiYXRjaCA9IGxvY2F0aW9uUG9pbnRzLnNsaWNlKGksIGkgKyAyNSk7XG4gICAgICBiYXRjaGVzLnB1c2goYmF0Y2gpO1xuICAgIH1cblxuICAgIGZvciAoY29uc3QgYmF0Y2ggb2YgYmF0Y2hlcykge1xuICAgICAgY29uc3QgZGVsZXRlUmVxdWVzdHMgPSBiYXRjaC5tYXAoKHBvaW50KSA9PiAoe1xuICAgICAgICBEZWxldGVSZXF1ZXN0OiB7XG4gICAgICAgICAgS2V5OiB7XG4gICAgICAgICAgICBkZXZpY2VfdWlkOiBwb2ludC5kZXZpY2VfdWlkLFxuICAgICAgICAgICAgdGltZXN0YW1wOiBwb2ludC50aW1lc3RhbXAsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0pKTtcblxuICAgICAgY29uc3QgYmF0Y2hDb21tYW5kID0gbmV3IEJhdGNoV3JpdGVDb21tYW5kKHtcbiAgICAgICAgUmVxdWVzdEl0ZW1zOiB7XG4gICAgICAgICAgW0xPQ0FUSU9OU19UQUJMRV06IGRlbGV0ZVJlcXVlc3RzLFxuICAgICAgICB9LFxuICAgICAgfSk7XG5cbiAgICAgIGF3YWl0IGRvY0NsaWVudC5zZW5kKGJhdGNoQ29tbWFuZCk7XG4gICAgfVxuXG4gICAgY29uc29sZS5sb2coYERlbGV0ZWQgJHtsb2NhdGlvblBvaW50cy5sZW5ndGh9IGxvY2F0aW9uIHBvaW50cyBmb3Igam91cm5leSAke2pvdXJuZXlJZH1gKTtcbiAgfVxuXG4gIC8vIERlbGV0ZSB0aGUgam91cm5leSByZWNvcmRcbiAgY29uc3QgZGVsZXRlQ29tbWFuZCA9IG5ldyBEZWxldGVDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IEpPVVJORVlTX1RBQkxFLFxuICAgIEtleToge1xuICAgICAgZGV2aWNlX3VpZDogb3duZXJEZXZpY2VVaWQsXG4gICAgICBqb3VybmV5X2lkOiBqb3VybmV5SWQsXG4gICAgfSxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoZGVsZXRlQ29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBEZWxldGVkIGpvdXJuZXkgJHtqb3VybmV5SWR9IGZvciBkZXZpY2UgJHtvd25lckRldmljZVVpZH0gKHNlcmlhbDogJHtzZXJpYWxOdW1iZXJ9KWApO1xuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgbWVzc2FnZTogJ0pvdXJuZXkgZGVsZXRlZCcsXG4gICAgICBqb3VybmV5X2lkOiBqb3VybmV5SWQsXG4gICAgICBwb2ludHNfZGVsZXRlZDogbG9jYXRpb25Qb2ludHMubGVuZ3RoLFxuICAgIH0pLFxuICB9O1xufVxuXG4vKipcbiAqIEdldCBwb3dlciBjb25zdW1wdGlvbiBkdXJpbmcgYSBqb3VybmV5IHRpbWVmcmFtZVxuICogUXVlcmllcyBwb3dlciB0ZWxlbWV0cnkgZGF0YSBhbmQgY2FsY3VsYXRlcyBtQWggY29uc3VtZWRcbiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2V0Sm91cm5leVBvd2VyQ29uc3VtcHRpb24oXG4gIGRldmljZVVpZDogc3RyaW5nLFxuICBzdGFydFRpbWU6IG51bWJlcixcbiAgZW5kVGltZTogbnVtYmVyXG4pOiBQcm9taXNlPHtcbiAgc3RhcnRfbWFoOiBudW1iZXI7XG4gIGVuZF9tYWg6IG51bWJlcjtcbiAgY29uc3VtZWRfbWFoOiBudW1iZXI7XG4gIHJlYWRpbmdfY291bnQ6IG51bWJlcjtcbn0gfCBudWxsPiB7XG4gIC8vIFF1ZXJ5IHBvd2VyIHRlbGVtZXRyeSB1c2luZyB0aGUgZXZlbnQtdHlwZS1pbmRleCBHU0lcbiAgY29uc3Qgc3RhcnRLZXkgPSBgcG93ZXIjJHtzdGFydFRpbWV9YDtcbiAgY29uc3QgZW5kS2V5ID0gYHBvd2VyIyR7ZW5kVGltZX1gO1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IFRFTEVNRVRSWV9UQUJMRSxcbiAgICBJbmRleE5hbWU6ICdldmVudC10eXBlLWluZGV4JyxcbiAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCBldmVudF90eXBlX3RpbWVzdGFtcCBCRVRXRUVOIDpzdGFydCBBTkQgOmVuZCcsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgJzpzdGFydCc6IHN0YXJ0S2V5LFxuICAgICAgJzplbmQnOiBlbmRLZXksXG4gICAgfSxcbiAgICBTY2FuSW5kZXhGb3J3YXJkOiB0cnVlLCAvLyBDaHJvbm9sb2dpY2FsIG9yZGVyXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zdCBwb3dlclJlYWRpbmdzID0gcmVzdWx0Lkl0ZW1zIHx8IFtdO1xuXG4gIC8vIE5lZWQgYXQgbGVhc3QgMiByZWFkaW5ncyB0byBjYWxjdWxhdGUgY29uc3VtcHRpb25cbiAgaWYgKHBvd2VyUmVhZGluZ3MubGVuZ3RoIDwgMikge1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgLy8gRmlsdGVyIGZvciByZWFkaW5ncyB0aGF0IGhhdmUgbWlsbGlhbXBfaG91cnNcbiAgY29uc3QgdmFsaWRSZWFkaW5ncyA9IHBvd2VyUmVhZGluZ3MuZmlsdGVyKChyKSA9PiB0eXBlb2Ygci5taWxsaWFtcF9ob3VycyA9PT0gJ251bWJlcicpO1xuXG4gIGlmICh2YWxpZFJlYWRpbmdzLmxlbmd0aCA8IDIpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIGNvbnN0IGZpcnN0UmVhZGluZyA9IHZhbGlkUmVhZGluZ3NbMF07XG4gIGNvbnN0IGxhc3RSZWFkaW5nID0gdmFsaWRSZWFkaW5nc1t2YWxpZFJlYWRpbmdzLmxlbmd0aCAtIDFdO1xuXG4gIGNvbnN0IHN0YXJ0TWFoID0gZmlyc3RSZWFkaW5nLm1pbGxpYW1wX2hvdXJzO1xuICBjb25zdCBlbmRNYWggPSBsYXN0UmVhZGluZy5taWxsaWFtcF9ob3VycztcblxuICAvLyBDYWxjdWxhdGUgY29uc3VtcHRpb24gKGhhbmRsZSBjb3VudGVyIHJlc2V0IGVkZ2UgY2FzZSlcbiAgbGV0IGNvbnN1bWVkTWFoID0gZW5kTWFoIC0gc3RhcnRNYWg7XG4gIGlmIChjb25zdW1lZE1haCA8IDApIHtcbiAgICAvLyBDb3VudGVyIHdhcyByZXNldCBkdXJpbmcgam91cm5leSAtIGNhbid0IGNhbGN1bGF0ZSBhY2N1cmF0ZWx5XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIHN0YXJ0X21haDogTWF0aC5yb3VuZChzdGFydE1haCAqIDEwMCkgLyAxMDAsXG4gICAgZW5kX21haDogTWF0aC5yb3VuZChlbmRNYWggKiAxMDApIC8gMTAwLFxuICAgIGNvbnN1bWVkX21haDogTWF0aC5yb3VuZChjb25zdW1lZE1haCAqIDEwMCkgLyAxMDAsXG4gICAgcmVhZGluZ19jb3VudDogdmFsaWRSZWFkaW5ncy5sZW5ndGgsXG4gIH07XG59XG4iXX0=