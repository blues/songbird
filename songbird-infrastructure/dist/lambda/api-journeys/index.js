"use strict";
/**
 * Journeys API Lambda
 *
 * Handles journey and location history queries:
 * - GET /devices/{device_uid}/journeys - List all journeys for a device
 * - GET /devices/{device_uid}/journeys/{journey_id} - Get journey details with points
 * - DELETE /devices/{device_uid}/journeys/{journey_id} - Delete a journey (admin/owner only)
 * - GET /devices/{device_uid}/locations - Get location history
 * - POST /devices/{device_uid}/journeys/{journey_id}/match - Trigger map matching
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
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
        const deviceUid = event.pathParameters?.device_uid;
        if (!deviceUid) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'device_uid required' }),
            };
        }
        const journeyId = event.pathParameters?.journey_id;
        const queryParams = event.queryStringParameters || {};
        // GET /devices/{device_uid}/locations - Location history
        if (path.endsWith('/locations')) {
            return await getLocationHistory(deviceUid, queryParams, corsHeaders);
        }
        // POST /devices/{device_uid}/journeys/{journey_id}/match - Map matching
        if (path.endsWith('/match') && method === 'POST' && journeyId) {
            return await matchJourney(deviceUid, parseInt(journeyId), corsHeaders);
        }
        // DELETE /devices/{device_uid}/journeys/{journey_id} - Delete journey (admin/owner only)
        if (method === 'DELETE' && journeyId) {
            return await deleteJourney(deviceUid, parseInt(journeyId), event, corsHeaders);
        }
        // GET /devices/{device_uid}/journeys/{journey_id} - Single journey with points
        if (journeyId) {
            return await getJourneyDetail(deviceUid, parseInt(journeyId), corsHeaders);
        }
        // GET /devices/{device_uid}/journeys - List journeys
        return await listJourneys(deviceUid, queryParams, corsHeaders);
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
 * List all journeys for a device
 */
async function listJourneys(deviceUid, queryParams, headers) {
    const status = queryParams.status; // 'active' | 'completed' | undefined (all)
    const limit = parseInt(queryParams.limit || '50');
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
        ScanIndexForward: false, // Most recent first
        Limit: limit,
    });
    const result = await docClient.send(command);
    const journeys = (result.Items || []).map((item) => ({
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
            device_uid: deviceUid,
            journeys,
            count: journeys.length,
        }),
    };
}
/**
 * Get a single journey with all its location points
 */
async function getJourneyDetail(deviceUid, journeyId, headers) {
    // Get the journey metadata
    const journeyCommand = new lib_dynamodb_1.QueryCommand({
        TableName: JOURNEYS_TABLE,
        KeyConditionExpression: 'device_uid = :device_uid AND journey_id = :journey_id',
        ExpressionAttributeValues: {
            ':device_uid': deviceUid,
            ':journey_id': journeyId,
        },
    });
    const journeyResult = await docClient.send(journeyCommand);
    if (!journeyResult.Items || journeyResult.Items.length === 0) {
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Journey not found' }),
        };
    }
    const journeyItem = journeyResult.Items[0];
    // Get all location points for this journey using the journey-index GSI
    const pointsCommand = new lib_dynamodb_1.QueryCommand({
        TableName: LOCATIONS_TABLE,
        IndexName: 'journey-index',
        KeyConditionExpression: 'device_uid = :device_uid AND journey_id = :journey_id',
        ExpressionAttributeValues: {
            ':device_uid': deviceUid,
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
 */
async function matchJourney(deviceUid, journeyId, headers) {
    if (!MAPBOX_TOKEN) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Map matching not configured' }),
        };
    }
    // Get the journey points
    const pointsCommand = new lib_dynamodb_1.QueryCommand({
        TableName: LOCATIONS_TABLE,
        IndexName: 'journey-index',
        KeyConditionExpression: 'device_uid = :device_uid AND journey_id = :journey_id',
        ExpressionAttributeValues: {
            ':device_uid': deviceUid,
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
                device_uid: deviceUid,
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
 * Get location history for a device
 */
async function getLocationHistory(deviceUid, queryParams, headers) {
    const hours = parseInt(queryParams.hours || '24');
    const source = queryParams.source; // 'gps' | 'cell' | 'triangulation' | undefined (all)
    const limit = parseInt(queryParams.limit || '1000');
    const cutoffTime = Date.now() - hours * 60 * 60 * 1000;
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
        ScanIndexForward: false, // Most recent first
        Limit: limit,
    });
    const result = await docClient.send(command);
    const locations = (result.Items || []).map((item) => ({
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
            device_uid: deviceUid,
            hours,
            count: locations.length,
            locations,
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
 */
async function deleteJourney(deviceUid, journeyId, event, headers) {
    // Authorization check: must be admin or device owner
    const userEmail = getUserEmail(event);
    const admin = isAdmin(event);
    if (!admin) {
        if (!userEmail) {
            return {
                statusCode: 401,
                headers,
                body: JSON.stringify({ error: 'Unauthorized' }),
            };
        }
        const owner = await isDeviceOwner(deviceUid, userEmail);
        if (!owner) {
            return {
                statusCode: 403,
                headers,
                body: JSON.stringify({ error: 'Admin or device owner access required' }),
            };
        }
    }
    // Verify the journey exists
    const journeyCommand = new lib_dynamodb_1.QueryCommand({
        TableName: JOURNEYS_TABLE,
        KeyConditionExpression: 'device_uid = :device_uid AND journey_id = :journey_id',
        ExpressionAttributeValues: {
            ':device_uid': deviceUid,
            ':journey_id': journeyId,
        },
    });
    const journeyResult = await docClient.send(journeyCommand);
    if (!journeyResult.Items || journeyResult.Items.length === 0) {
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Journey not found' }),
        };
    }
    // Get all location points for this journey to delete them
    const pointsCommand = new lib_dynamodb_1.QueryCommand({
        TableName: LOCATIONS_TABLE,
        IndexName: 'journey-index',
        KeyConditionExpression: 'device_uid = :device_uid AND journey_id = :journey_id',
        ExpressionAttributeValues: {
            ':device_uid': deviceUid,
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
            device_uid: deviceUid,
            journey_id: journeyId,
        },
    });
    await docClient.send(deleteCommand);
    console.log(`Deleted journey ${journeyId} for device ${deviceUid}`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWpvdXJuZXlzL2luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7O0dBU0c7OztBQUVILDhEQUEwRDtBQUMxRCx3REFBMEk7QUFHMUksTUFBTSxTQUFTLEdBQUcsSUFBSSxnQ0FBYyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQ3pDLE1BQU0sU0FBUyxHQUFHLHFDQUFzQixDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztBQUV6RCxNQUFNLGNBQWMsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGNBQWUsQ0FBQztBQUNuRCxNQUFNLGVBQWUsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGVBQWdCLENBQUM7QUFDckQsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxhQUFjLENBQUM7QUFDakQsTUFBTSxlQUFlLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxlQUFnQixDQUFDO0FBQ3JELE1BQU0sWUFBWSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsWUFBWSxDQUFDO0FBRXZDLE1BQU0sT0FBTyxHQUFHLEtBQUssRUFBRSxLQUEyQixFQUFrQyxFQUFFO0lBQzNGLE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUUvQyxNQUFNLFdBQVcsR0FBRztRQUNsQiw2QkFBNkIsRUFBRSxHQUFHO1FBQ2xDLDhCQUE4QixFQUFFLDRCQUE0QjtRQUM1RCw4QkFBOEIsRUFBRSx5QkFBeUI7S0FDMUQsQ0FBQztJQUVGLElBQUksQ0FBQztRQUNILE1BQU0sTUFBTSxHQUFJLEtBQUssQ0FBQyxjQUFzQixFQUFFLElBQUksRUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLFVBQVUsQ0FBQztRQUMvRSxNQUFNLElBQUksR0FBSSxLQUFLLENBQUMsY0FBc0IsRUFB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QyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDN0IsT0FBTyxJQUFJLENBQUM7SUFDZCxDQUFDO0lBRUQsTUFBTSxZQUFZLEdBQUcsYUFBYSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3RDLE1BQU0sV0FBVyxHQUFHLGFBQWEsQ0FBQyxhQUFhLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDO0lBRTVELE1BQU0sUUFBUSxHQUFHLFlBQVksQ0FBQyxjQUFjLENBQUM7SUFDN0MsTUFBTSxNQUFNLEdBQUcsV0FBVyxDQUFDLGNBQWMsQ0FBQztJQUUxQyx5REFBeUQ7SUFDekQsSUFBSSxXQUFXLEdBQUcsTUFBTSxHQUFHLFFBQVEsQ0FBQztJQUNwQyxJQUFJLFdBQVcsR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUNwQixnRUFBZ0U7UUFDaEUsT0FBTyxJQUFJLENBQUM7SUFDZCxDQUFDO0lBRUQsT0FBTztRQUNMLFNBQVMsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLFFBQVEsR0FBRyxHQUFHLENBQUMsR0FBRyxHQUFHO1FBQzNDLE9BQU8sRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sR0FBRyxHQUFHLENBQUMsR0FBRyxHQUFHO1FBQ3ZDLFlBQVksRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLFdBQVcsR0FBRyxHQUFHLENBQUMsR0FBRyxHQUFHO1FBQ2pELGFBQWEsRUFBRSxhQUFhLENBQUMsTUFBTTtLQUNwQyxDQUFDO0FBQ0osQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogSm91cm5leXMgQVBJIExhbWJkYVxuICpcbiAqIEhhbmRsZXMgam91cm5leSBhbmQgbG9jYXRpb24gaGlzdG9yeSBxdWVyaWVzOlxuICogLSBHRVQgL2RldmljZXMve2RldmljZV91aWR9L2pvdXJuZXlzIC0gTGlzdCBhbGwgam91cm5leXMgZm9yIGEgZGV2aWNlXG4gKiAtIEdFVCAvZGV2aWNlcy97ZGV2aWNlX3VpZH0vam91cm5leXMve2pvdXJuZXlfaWR9IC0gR2V0IGpvdXJuZXkgZGV0YWlscyB3aXRoIHBvaW50c1xuICogLSBERUxFVEUgL2RldmljZXMve2RldmljZV91aWR9L2pvdXJuZXlzL3tqb3VybmV5X2lkfSAtIERlbGV0ZSBhIGpvdXJuZXkgKGFkbWluL293bmVyIG9ubHkpXG4gKiAtIEdFVCAvZGV2aWNlcy97ZGV2aWNlX3VpZH0vbG9jYXRpb25zIC0gR2V0IGxvY2F0aW9uIGhpc3RvcnlcbiAqIC0gUE9TVCAvZGV2aWNlcy97ZGV2aWNlX3VpZH0vam91cm5leXMve2pvdXJuZXlfaWR9L21hdGNoIC0gVHJpZ2dlciBtYXAgbWF0Y2hpbmdcbiAqL1xuXG5pbXBvcnQgeyBEeW5hbW9EQkNsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYic7XG5pbXBvcnQgeyBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LCBRdWVyeUNvbW1hbmQsIFVwZGF0ZUNvbW1hbmQsIERlbGV0ZUNvbW1hbmQsIEdldENvbW1hbmQsIEJhdGNoV3JpdGVDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvbGliLWR5bmFtb2RiJztcbmltcG9ydCB7IEFQSUdhdGV3YXlQcm94eUV2ZW50LCBBUElHYXRld2F5UHJveHlFdmVudFYyLCBBUElHYXRld2F5UHJveHlSZXN1bHQgfSBmcm9tICdhd3MtbGFtYmRhJztcblxuY29uc3QgZGRiQ2xpZW50ID0gbmV3IER5bmFtb0RCQ2xpZW50KHt9KTtcbmNvbnN0IGRvY0NsaWVudCA9IER5bmFtb0RCRG9jdW1lbnRDbGllbnQuZnJvbShkZGJDbGllbnQpO1xuXG5jb25zdCBKT1VSTkVZU19UQUJMRSA9IHByb2Nlc3MuZW52LkpPVVJORVlTX1RBQkxFITtcbmNvbnN0IExPQ0FUSU9OU19UQUJMRSA9IHByb2Nlc3MuZW52LkxPQ0FUSU9OU19UQUJMRSE7XG5jb25zdCBERVZJQ0VTX1RBQkxFID0gcHJvY2Vzcy5lbnYuREVWSUNFU19UQUJMRSE7XG5jb25zdCBURUxFTUVUUllfVEFCTEUgPSBwcm9jZXNzLmVudi5URUxFTUVUUllfVEFCTEUhO1xuY29uc3QgTUFQQk9YX1RPS0VOID0gcHJvY2Vzcy5lbnYuTUFQQk9YX1RPS0VOO1xuXG5leHBvcnQgY29uc3QgaGFuZGxlciA9IGFzeW5jIChldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQpOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4gPT4ge1xuICBjb25zb2xlLmxvZygnUmVxdWVzdDonLCBKU09OLnN0cmluZ2lmeShldmVudCkpO1xuXG4gIGNvbnN0IGNvcnNIZWFkZXJzID0ge1xuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nOiAnKicsXG4gICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnMnOiAnQ29udGVudC1UeXBlLEF1dGhvcml6YXRpb24nLFxuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzJzogJ0dFVCxQT1NULERFTEVURSxPUFRJT05TJyxcbiAgfTtcblxuICB0cnkge1xuICAgIGNvbnN0IG1ldGhvZCA9IChldmVudC5yZXF1ZXN0Q29udGV4dCBhcyBhbnkpPy5odHRwPy5tZXRob2QgfHwgZXZlbnQuaHR0cE1ldGhvZDtcbiAgICBjb25zdCBwYXRoID0gKGV2ZW50LnJlcXVlc3RDb250ZXh0IGFzIGFueSk/Lmh0dHA/LnBhdGggfHwgZXZlbnQucGF0aDtcblxuICAgIGlmIChtZXRob2QgPT09ICdPUFRJT05TJykge1xuICAgICAgcmV0dXJuIHsgc3RhdHVzQ29kZTogMjAwLCBoZWFkZXJzOiBjb3JzSGVhZGVycywgYm9keTogJycgfTtcbiAgICB9XG5cbiAgICBjb25zdCBkZXZpY2VVaWQgPSBldmVudC5wYXRoUGFyYW1ldGVycz8uZGV2aWNlX3VpZDtcbiAgICBpZiAoIWRldmljZVVpZCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICBoZWFkZXJzOiBjb3JzSGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ2RldmljZV91aWQgcmVxdWlyZWQnIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCBqb3VybmV5SWQgPSBldmVudC5wYXRoUGFyYW1ldGVycz8uam91cm5leV9pZDtcbiAgICBjb25zdCBxdWVyeVBhcmFtcyA9IGV2ZW50LnF1ZXJ5U3RyaW5nUGFyYW1ldGVycyB8fCB7fTtcblxuICAgIC8vIEdFVCAvZGV2aWNlcy97ZGV2aWNlX3VpZH0vbG9jYXRpb25zIC0gTG9jYXRpb24gaGlzdG9yeVxuICAgIGlmIChwYXRoLmVuZHNXaXRoKCcvbG9jYXRpb25zJykpIHtcbiAgICAgIHJldHVybiBhd2FpdCBnZXRMb2NhdGlvbkhpc3RvcnkoZGV2aWNlVWlkLCBxdWVyeVBhcmFtcywgY29yc0hlYWRlcnMpO1xuICAgIH1cblxuICAgIC8vIFBPU1QgL2RldmljZXMve2RldmljZV91aWR9L2pvdXJuZXlzL3tqb3VybmV5X2lkfS9tYXRjaCAtIE1hcCBtYXRjaGluZ1xuICAgIGlmIChwYXRoLmVuZHNXaXRoKCcvbWF0Y2gnKSAmJiBtZXRob2QgPT09ICdQT1NUJyAmJiBqb3VybmV5SWQpIHtcbiAgICAgIHJldHVybiBhd2FpdCBtYXRjaEpvdXJuZXkoZGV2aWNlVWlkLCBwYXJzZUludChqb3VybmV5SWQpLCBjb3JzSGVhZGVycyk7XG4gICAgfVxuXG4gICAgLy8gREVMRVRFIC9kZXZpY2VzL3tkZXZpY2VfdWlkfS9qb3VybmV5cy97am91cm5leV9pZH0gLSBEZWxldGUgam91cm5leSAoYWRtaW4vb3duZXIgb25seSlcbiAgICBpZiAobWV0aG9kID09PSAnREVMRVRFJyAmJiBqb3VybmV5SWQpIHtcbiAgICAgIHJldHVybiBhd2FpdCBkZWxldGVKb3VybmV5KGRldmljZVVpZCwgcGFyc2VJbnQoam91cm5leUlkKSwgZXZlbnQsIGNvcnNIZWFkZXJzKTtcbiAgICB9XG5cbiAgICAvLyBHRVQgL2RldmljZXMve2RldmljZV91aWR9L2pvdXJuZXlzL3tqb3VybmV5X2lkfSAtIFNpbmdsZSBqb3VybmV5IHdpdGggcG9pbnRzXG4gICAgaWYgKGpvdXJuZXlJZCkge1xuICAgICAgcmV0dXJuIGF3YWl0IGdldEpvdXJuZXlEZXRhaWwoZGV2aWNlVWlkLCBwYXJzZUludChqb3VybmV5SWQpLCBjb3JzSGVhZGVycyk7XG4gICAgfVxuXG4gICAgLy8gR0VUIC9kZXZpY2VzL3tkZXZpY2VfdWlkfS9qb3VybmV5cyAtIExpc3Qgam91cm5leXNcbiAgICByZXR1cm4gYXdhaXQgbGlzdEpvdXJuZXlzKGRldmljZVVpZCwgcXVlcnlQYXJhbXMsIGNvcnNIZWFkZXJzKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvcjonLCBlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMCxcbiAgICAgIGhlYWRlcnM6IGNvcnNIZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0ludGVybmFsIHNlcnZlciBlcnJvcicgfSksXG4gICAgfTtcbiAgfVxufTtcblxuLyoqXG4gKiBMaXN0IGFsbCBqb3VybmV5cyBmb3IgYSBkZXZpY2VcbiAqL1xuYXN5bmMgZnVuY3Rpb24gbGlzdEpvdXJuZXlzKFxuICBkZXZpY2VVaWQ6IHN0cmluZyxcbiAgcXVlcnlQYXJhbXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD4sXG4gIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiB7XG4gIGNvbnN0IHN0YXR1cyA9IHF1ZXJ5UGFyYW1zLnN0YXR1czsgLy8gJ2FjdGl2ZScgfCAnY29tcGxldGVkJyB8IHVuZGVmaW5lZCAoYWxsKVxuICBjb25zdCBsaW1pdCA9IHBhcnNlSW50KHF1ZXJ5UGFyYW1zLmxpbWl0IHx8ICc1MCcpO1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IEpPVVJORVlTX1RBQkxFLFxuICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkID0gOmRldmljZV91aWQnLFxuICAgIC4uLihzdGF0dXMgJiYge1xuICAgICAgRmlsdGVyRXhwcmVzc2lvbjogJyNzdGF0dXMgPSA6c3RhdHVzJyxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczogeyAnI3N0YXR1cyc6ICdzdGF0dXMnIH0sXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICAgICAgJzpzdGF0dXMnOiBzdGF0dXMsXG4gICAgICB9LFxuICAgIH0pLFxuICAgIC4uLighc3RhdHVzICYmIHtcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgfSxcbiAgICB9KSxcbiAgICBTY2FuSW5kZXhGb3J3YXJkOiBmYWxzZSwgLy8gTW9zdCByZWNlbnQgZmlyc3RcbiAgICBMaW1pdDogbGltaXQsXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuXG4gIGNvbnN0IGpvdXJuZXlzID0gKHJlc3VsdC5JdGVtcyB8fCBbXSkubWFwKChpdGVtKSA9PiAoe1xuICAgIGpvdXJuZXlfaWQ6IGl0ZW0uam91cm5leV9pZCxcbiAgICBkZXZpY2VfdWlkOiBpdGVtLmRldmljZV91aWQsXG4gICAgc3RhcnRfdGltZTogbmV3IERhdGUoaXRlbS5zdGFydF90aW1lKS50b0lTT1N0cmluZygpLFxuICAgIGVuZF90aW1lOiBpdGVtLmVuZF90aW1lID8gbmV3IERhdGUoaXRlbS5lbmRfdGltZSkudG9JU09TdHJpbmcoKSA6IHVuZGVmaW5lZCxcbiAgICBwb2ludF9jb3VudDogaXRlbS5wb2ludF9jb3VudCB8fCAwLFxuICAgIHRvdGFsX2Rpc3RhbmNlOiBpdGVtLnRvdGFsX2Rpc3RhbmNlIHx8IDAsXG4gICAgc3RhdHVzOiBpdGVtLnN0YXR1cyxcbiAgfSkpO1xuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgZGV2aWNlX3VpZDogZGV2aWNlVWlkLFxuICAgICAgam91cm5leXMsXG4gICAgICBjb3VudDogam91cm5leXMubGVuZ3RoLFxuICAgIH0pLFxuICB9O1xufVxuXG4vKipcbiAqIEdldCBhIHNpbmdsZSBqb3VybmV5IHdpdGggYWxsIGl0cyBsb2NhdGlvbiBwb2ludHNcbiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2V0Sm91cm5leURldGFpbChcbiAgZGV2aWNlVWlkOiBzdHJpbmcsXG4gIGpvdXJuZXlJZDogbnVtYmVyLFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICAvLyBHZXQgdGhlIGpvdXJuZXkgbWV0YWRhdGFcbiAgY29uc3Qgam91cm5leUNvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IEpPVVJORVlTX1RBQkxFLFxuICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkID0gOmRldmljZV91aWQgQU5EIGpvdXJuZXlfaWQgPSA6am91cm5leV9pZCcsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgJzpqb3VybmV5X2lkJzogam91cm5leUlkLFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGpvdXJuZXlSZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChqb3VybmV5Q29tbWFuZCk7XG5cbiAgaWYgKCFqb3VybmV5UmVzdWx0Lkl0ZW1zIHx8IGpvdXJuZXlSZXN1bHQuSXRlbXMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDQwNCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnSm91cm5leSBub3QgZm91bmQnIH0pLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBqb3VybmV5SXRlbSA9IGpvdXJuZXlSZXN1bHQuSXRlbXNbMF07XG5cbiAgLy8gR2V0IGFsbCBsb2NhdGlvbiBwb2ludHMgZm9yIHRoaXMgam91cm5leSB1c2luZyB0aGUgam91cm5leS1pbmRleCBHU0lcbiAgY29uc3QgcG9pbnRzQ29tbWFuZCA9IG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogTE9DQVRJT05TX1RBQkxFLFxuICAgIEluZGV4TmFtZTogJ2pvdXJuZXktaW5kZXgnLFxuICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkID0gOmRldmljZV91aWQgQU5EIGpvdXJuZXlfaWQgPSA6am91cm5leV9pZCcsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgJzpqb3VybmV5X2lkJzogam91cm5leUlkLFxuICAgIH0sXG4gICAgU2NhbkluZGV4Rm9yd2FyZDogdHJ1ZSwgLy8gQ2hyb25vbG9naWNhbCBvcmRlclxuICB9KTtcblxuICBjb25zdCBwb2ludHNSZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChwb2ludHNDb21tYW5kKTtcblxuICBjb25zdCBzdGFydFRpbWUgPSBqb3VybmV5SXRlbS5zdGFydF90aW1lO1xuICBjb25zdCBlbmRUaW1lID0gam91cm5leUl0ZW0uZW5kX3RpbWUgfHwgRGF0ZS5ub3coKTtcblxuICBjb25zdCBqb3VybmV5ID0ge1xuICAgIGpvdXJuZXlfaWQ6IGpvdXJuZXlJdGVtLmpvdXJuZXlfaWQsXG4gICAgZGV2aWNlX3VpZDogam91cm5leUl0ZW0uZGV2aWNlX3VpZCxcbiAgICBzdGFydF90aW1lOiBuZXcgRGF0ZShzdGFydFRpbWUpLnRvSVNPU3RyaW5nKCksXG4gICAgZW5kX3RpbWU6IGpvdXJuZXlJdGVtLmVuZF90aW1lID8gbmV3IERhdGUoam91cm5leUl0ZW0uZW5kX3RpbWUpLnRvSVNPU3RyaW5nKCkgOiB1bmRlZmluZWQsXG4gICAgcG9pbnRfY291bnQ6IGpvdXJuZXlJdGVtLnBvaW50X2NvdW50IHx8IDAsXG4gICAgdG90YWxfZGlzdGFuY2U6IGpvdXJuZXlJdGVtLnRvdGFsX2Rpc3RhbmNlIHx8IDAsXG4gICAgc3RhdHVzOiBqb3VybmV5SXRlbS5zdGF0dXMsXG4gICAgbWF0Y2hlZF9yb3V0ZTogam91cm5leUl0ZW0ubWF0Y2hlZF9yb3V0ZSwgLy8gR2VvSlNPTiBMaW5lU3RyaW5nIGlmIG1hcC1tYXRjaGVkXG4gIH07XG5cbiAgLy8gU29ydCBwb2ludHMgYnkgdGltZXN0YW1wIChHU0kgZG9lc24ndCBndWFyYW50ZWUgb3JkZXIgd2l0aGluIHNhbWUgam91cm5leV9pZClcbiAgY29uc3Qgc29ydGVkSXRlbXMgPSAocG9pbnRzUmVzdWx0Lkl0ZW1zIHx8IFtdKS5zb3J0KChhLCBiKSA9PiBhLnRpbWVzdGFtcCAtIGIudGltZXN0YW1wKTtcblxuICBjb25zdCBwb2ludHMgPSBzb3J0ZWRJdGVtcy5tYXAoKGl0ZW0pID0+ICh7XG4gICAgdGltZTogbmV3IERhdGUoaXRlbS50aW1lc3RhbXApLnRvSVNPU3RyaW5nKCksXG4gICAgbGF0OiBpdGVtLmxhdGl0dWRlLFxuICAgIGxvbjogaXRlbS5sb25naXR1ZGUsXG4gICAgdmVsb2NpdHk6IGl0ZW0udmVsb2NpdHksXG4gICAgYmVhcmluZzogaXRlbS5iZWFyaW5nLFxuICAgIGRpc3RhbmNlOiBpdGVtLmRpc3RhbmNlLFxuICAgIGRvcDogaXRlbS5kb3AsXG4gICAgamNvdW50OiBpdGVtLmpjb3VudCxcbiAgfSkpO1xuXG4gIC8vIEdldCBwb3dlciBjb25zdW1wdGlvbiBmb3IgdGhpcyBqb3VybmV5XG4gIGNvbnN0IHBvd2VyID0gYXdhaXQgZ2V0Sm91cm5leVBvd2VyQ29uc3VtcHRpb24oZGV2aWNlVWlkLCBzdGFydFRpbWUsIGVuZFRpbWUpO1xuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgam91cm5leSxcbiAgICAgIHBvaW50cyxcbiAgICAgIHBvd2VyLFxuICAgIH0pLFxuICB9O1xufVxuXG4vKipcbiAqIENhbGwgTWFwYm94IE1hcCBNYXRjaGluZyBBUEkgYW5kIGNhY2hlIHRoZSByZXN1bHRcbiAqL1xuYXN5bmMgZnVuY3Rpb24gbWF0Y2hKb3VybmV5KFxuICBkZXZpY2VVaWQ6IHN0cmluZyxcbiAgam91cm5leUlkOiBudW1iZXIsXG4gIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiB7XG4gIGlmICghTUFQQk9YX1RPS0VOKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnTWFwIG1hdGNoaW5nIG5vdCBjb25maWd1cmVkJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gR2V0IHRoZSBqb3VybmV5IHBvaW50c1xuICBjb25zdCBwb2ludHNDb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBMT0NBVElPTlNfVEFCTEUsXG4gICAgSW5kZXhOYW1lOiAnam91cm5leS1pbmRleCcsXG4gICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQgPSA6ZGV2aWNlX3VpZCBBTkQgam91cm5leV9pZCA9IDpqb3VybmV5X2lkJyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAnOmRldmljZV91aWQnOiBkZXZpY2VVaWQsXG4gICAgICAnOmpvdXJuZXlfaWQnOiBqb3VybmV5SWQsXG4gICAgfSxcbiAgICBTY2FuSW5kZXhGb3J3YXJkOiB0cnVlLFxuICB9KTtcblxuICBjb25zdCBwb2ludHNSZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChwb2ludHNDb21tYW5kKTtcblxuICAvLyBTb3J0IHBvaW50cyBieSB0aW1lc3RhbXAgKEdTSSBkb2Vzbid0IGd1YXJhbnRlZSBvcmRlciB3aXRoaW4gc2FtZSBqb3VybmV5X2lkKVxuICBjb25zdCBwb2ludHMgPSAocG9pbnRzUmVzdWx0Lkl0ZW1zIHx8IFtdKS5zb3J0KChhLCBiKSA9PiBhLnRpbWVzdGFtcCAtIGIudGltZXN0YW1wKTtcblxuICBpZiAocG9pbnRzLmxlbmd0aCA8IDIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdKb3VybmV5IGhhcyBmZXdlciB0aGFuIDIgcG9pbnRzJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gTWFwYm94IE1hcCBNYXRjaGluZyBBUEkgaGFzIGEgbGltaXQgb2YgMTAwIGNvb3JkaW5hdGVzIHBlciByZXF1ZXN0XG4gIC8vIElmIHdlIGhhdmUgbW9yZSwgd2UgbmVlZCB0byBzYW1wbGUgb3IgYmF0Y2hcbiAgY29uc3QgbWF4UG9pbnRzID0gMTAwO1xuICBsZXQgc2FtcGxlZFBvaW50cyA9IHBvaW50cztcbiAgaWYgKHBvaW50cy5sZW5ndGggPiBtYXhQb2ludHMpIHtcbiAgICAvLyBTYW1wbGUgcG9pbnRzIGV2ZW5seVxuICAgIGNvbnN0IHN0ZXAgPSAocG9pbnRzLmxlbmd0aCAtIDEpIC8gKG1heFBvaW50cyAtIDEpO1xuICAgIHNhbXBsZWRQb2ludHMgPSBbXTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG1heFBvaW50czsgaSsrKSB7XG4gICAgICBjb25zdCBpZHggPSBNYXRoLnJvdW5kKGkgKiBzdGVwKTtcbiAgICAgIHNhbXBsZWRQb2ludHMucHVzaChwb2ludHNbaWR4XSk7XG4gICAgfVxuICB9XG5cbiAgLy8gRm9ybWF0IGNvb3JkaW5hdGVzIGZvciBNYXBib3ggQVBJOiBsb24sbGF0O2xvbixsYXQ7Li4uXG4gIGNvbnN0IGNvb3JkaW5hdGVzID0gc2FtcGxlZFBvaW50c1xuICAgIC5tYXAoKHApID0+IGAke3AubG9uZ2l0dWRlfSwke3AubGF0aXR1ZGV9YClcbiAgICAuam9pbignOycpO1xuXG4gIC8vIEJ1aWxkIHRoZSB0aW1lc3RhbXBzIHBhcmFtZXRlciAoVW5peCB0aW1lc3RhbXBzIGluIHNlY29uZHMpXG4gIGNvbnN0IHRpbWVzdGFtcHMgPSBzYW1wbGVkUG9pbnRzXG4gICAgLm1hcCgocCkgPT4gTWF0aC5mbG9vcihwLnRpbWVzdGFtcCAvIDEwMDApKVxuICAgIC5qb2luKCc7Jyk7XG5cbiAgLy8gQnVpbGQgdGhlIHJhZGl1c2VzIHBhcmFtZXRlciAoR1BTIGFjY3VyYWN5IGluIG1ldGVycywgZGVmYXVsdCAyNW0pXG4gIGNvbnN0IHJhZGl1c2VzID0gc2FtcGxlZFBvaW50c1xuICAgIC5tYXAoKHApID0+IChwLmRvcCA/IE1hdGgubWF4KDUsIHAuZG9wICogMTApIDogMjUpKVxuICAgIC5qb2luKCc7Jyk7XG5cbiAgLy8gQ2FsbCBNYXBib3ggTWFwIE1hdGNoaW5nIEFQSVxuICBjb25zdCBtYXBNYXRjaFVybCA9IGBodHRwczovL2FwaS5tYXBib3guY29tL21hdGNoaW5nL3Y1L21hcGJveC9kcml2aW5nLyR7Y29vcmRpbmF0ZXN9P2FjY2Vzc190b2tlbj0ke01BUEJPWF9UT0tFTn0mZ2VvbWV0cmllcz1nZW9qc29uJnJhZGl1c2VzPSR7cmFkaXVzZXN9JnRpbWVzdGFtcHM9JHt0aW1lc3RhbXBzfSZvdmVydmlldz1mdWxsJnN0ZXBzPWZhbHNlYDtcblxuICBjb25zb2xlLmxvZyhgQ2FsbGluZyBNYXBib3ggTWFwIE1hdGNoaW5nIEFQSSBmb3Igam91cm5leSAke2pvdXJuZXlJZH0gd2l0aCAke3NhbXBsZWRQb2ludHMubGVuZ3RofSBwb2ludHNgKTtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2gobWFwTWF0Y2hVcmwpO1xuICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XG5cbiAgICBpZiAoZGF0YS5jb2RlICE9PSAnT2snIHx8ICFkYXRhLm1hdGNoaW5ncyB8fCBkYXRhLm1hdGNoaW5ncy5sZW5ndGggPT09IDApIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ01hcCBtYXRjaGluZyBmYWlsZWQ6JywgZGF0YSk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICBlcnJvcjogJ01hcCBtYXRjaGluZyBmYWlsZWQnLFxuICAgICAgICAgIGNvZGU6IGRhdGEuY29kZSxcbiAgICAgICAgICBtZXNzYWdlOiBkYXRhLm1lc3NhZ2UsXG4gICAgICAgIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBHZXQgdGhlIG1hdGNoZWQgZ2VvbWV0cnkgKEdlb0pTT04gTGluZVN0cmluZylcbiAgICBjb25zdCBtYXRjaGVkUm91dGUgPSBkYXRhLm1hdGNoaW5nc1swXS5nZW9tZXRyeTtcbiAgICBjb25zdCBjb25maWRlbmNlID0gZGF0YS5tYXRjaGluZ3NbMF0uY29uZmlkZW5jZTtcblxuICAgIC8vIFN0b3JlIHRoZSBtYXRjaGVkIHJvdXRlIGluIER5bmFtb0RCXG4gICAgY29uc3QgdXBkYXRlQ29tbWFuZCA9IG5ldyBVcGRhdGVDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogSk9VUk5FWVNfVEFCTEUsXG4gICAgICBLZXk6IHtcbiAgICAgICAgZGV2aWNlX3VpZDogZGV2aWNlVWlkLFxuICAgICAgICBqb3VybmV5X2lkOiBqb3VybmV5SWQsXG4gICAgICB9LFxuICAgICAgVXBkYXRlRXhwcmVzc2lvbjogJ1NFVCBtYXRjaGVkX3JvdXRlID0gOnJvdXRlLCBtYXRjaF9jb25maWRlbmNlID0gOmNvbmZpZGVuY2UsIG1hdGNoZWRfYXQgPSA6dGltZScsXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICc6cm91dGUnOiBtYXRjaGVkUm91dGUsXG4gICAgICAgICc6Y29uZmlkZW5jZSc6IGNvbmZpZGVuY2UsXG4gICAgICAgICc6dGltZSc6IERhdGUubm93KCksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgYXdhaXQgZG9jQ2xpZW50LnNlbmQodXBkYXRlQ29tbWFuZCk7XG4gICAgY29uc29sZS5sb2coYFN0b3JlZCBtYXRjaGVkIHJvdXRlIGZvciBqb3VybmV5ICR7am91cm5leUlkfSB3aXRoIGNvbmZpZGVuY2UgJHtjb25maWRlbmNlfWApO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIG1hdGNoZWRfcm91dGU6IG1hdGNoZWRSb3V0ZSxcbiAgICAgICAgY29uZmlkZW5jZSxcbiAgICAgICAgb3JpZ2luYWxfcG9pbnRzOiBwb2ludHMubGVuZ3RoLFxuICAgICAgICBtYXRjaGVkX3BvaW50czogc2FtcGxlZFBvaW50cy5sZW5ndGgsXG4gICAgICB9KSxcbiAgICB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIGNhbGxpbmcgTWFwYm94IEFQSTonLCBlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRmFpbGVkIHRvIGNhbGwgbWFwIG1hdGNoaW5nIEFQSScgfSksXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIEdldCBsb2NhdGlvbiBoaXN0b3J5IGZvciBhIGRldmljZVxuICovXG5hc3luYyBmdW5jdGlvbiBnZXRMb2NhdGlvbkhpc3RvcnkoXG4gIGRldmljZVVpZDogc3RyaW5nLFxuICBxdWVyeVBhcmFtczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgdW5kZWZpbmVkPixcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgY29uc3QgaG91cnMgPSBwYXJzZUludChxdWVyeVBhcmFtcy5ob3VycyB8fCAnMjQnKTtcbiAgY29uc3Qgc291cmNlID0gcXVlcnlQYXJhbXMuc291cmNlOyAvLyAnZ3BzJyB8ICdjZWxsJyB8ICd0cmlhbmd1bGF0aW9uJyB8IHVuZGVmaW5lZCAoYWxsKVxuICBjb25zdCBsaW1pdCA9IHBhcnNlSW50KHF1ZXJ5UGFyYW1zLmxpbWl0IHx8ICcxMDAwJyk7XG5cbiAgY29uc3QgY3V0b2ZmVGltZSA9IERhdGUubm93KCkgLSBob3VycyAqIDYwICogNjAgKiAxMDAwO1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IExPQ0FUSU9OU19UQUJMRSxcbiAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCAjdGltZXN0YW1wID49IDpjdXRvZmYnLFxuICAgIC4uLihzb3VyY2UgJiYge1xuICAgICAgRmlsdGVyRXhwcmVzc2lvbjogJyNzb3VyY2UgPSA6c291cmNlJyxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczoge1xuICAgICAgICAnI3RpbWVzdGFtcCc6ICd0aW1lc3RhbXAnLFxuICAgICAgICAnI3NvdXJjZSc6ICdzb3VyY2UnLFxuICAgICAgfSxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgICAnOmN1dG9mZic6IGN1dG9mZlRpbWUsXG4gICAgICAgICc6c291cmNlJzogc291cmNlLFxuICAgICAgfSxcbiAgICB9KSxcbiAgICAuLi4oIXNvdXJjZSAmJiB7XG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICAgJyN0aW1lc3RhbXAnOiAndGltZXN0YW1wJyxcbiAgICAgIH0sXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICAgICAgJzpjdXRvZmYnOiBjdXRvZmZUaW1lLFxuICAgICAgfSxcbiAgICB9KSxcbiAgICBTY2FuSW5kZXhGb3J3YXJkOiBmYWxzZSwgLy8gTW9zdCByZWNlbnQgZmlyc3RcbiAgICBMaW1pdDogbGltaXQsXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuXG4gIGNvbnN0IGxvY2F0aW9ucyA9IChyZXN1bHQuSXRlbXMgfHwgW10pLm1hcCgoaXRlbSkgPT4gKHtcbiAgICB0aW1lOiBuZXcgRGF0ZShpdGVtLnRpbWVzdGFtcCkudG9JU09TdHJpbmcoKSxcbiAgICBsYXQ6IGl0ZW0ubGF0aXR1ZGUsXG4gICAgbG9uOiBpdGVtLmxvbmdpdHVkZSxcbiAgICBzb3VyY2U6IGl0ZW0uc291cmNlLFxuICAgIGxvY2F0aW9uX25hbWU6IGl0ZW0ubG9jYXRpb25fbmFtZSxcbiAgICBldmVudF90eXBlOiBpdGVtLmV2ZW50X3R5cGUsXG4gICAgam91cm5leV9pZDogaXRlbS5qb3VybmV5X2lkLFxuICAgIGpjb3VudDogaXRlbS5qY291bnQsXG4gICAgdmVsb2NpdHk6IGl0ZW0udmVsb2NpdHksXG4gICAgYmVhcmluZzogaXRlbS5iZWFyaW5nLFxuICB9KSk7XG5cbiAgcmV0dXJuIHtcbiAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgaGVhZGVycyxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBkZXZpY2VfdWlkOiBkZXZpY2VVaWQsXG4gICAgICBob3VycyxcbiAgICAgIGNvdW50OiBsb2NhdGlvbnMubGVuZ3RoLFxuICAgICAgbG9jYXRpb25zLFxuICAgIH0pLFxuICB9O1xufVxuXG4vKipcbiAqIENoZWNrIGlmIHRoZSB1c2VyIGlzIGFuIGFkbWluIChpbiAnQWRtaW4nIENvZ25pdG8gZ3JvdXApXG4gKi9cbmZ1bmN0aW9uIGlzQWRtaW4oZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50KTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgY29uc3QgY2xhaW1zID0gKGV2ZW50LnJlcXVlc3RDb250ZXh0IGFzIGFueSk/LmF1dGhvcml6ZXI/Lmp3dD8uY2xhaW1zO1xuICAgIGlmICghY2xhaW1zKSByZXR1cm4gZmFsc2U7XG5cbiAgICBjb25zdCBncm91cHMgPSBjbGFpbXNbJ2NvZ25pdG86Z3JvdXBzJ107XG4gICAgaWYgKEFycmF5LmlzQXJyYXkoZ3JvdXBzKSkge1xuICAgICAgcmV0dXJuIGdyb3Vwcy5pbmNsdWRlcygnQWRtaW4nKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBncm91cHMgPT09ICdzdHJpbmcnKSB7XG4gICAgICByZXR1cm4gZ3JvdXBzID09PSAnQWRtaW4nIHx8IGdyb3Vwcy5pbmNsdWRlcygnQWRtaW4nKTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqXG4gKiBHZXQgdGhlIHVzZXIncyBlbWFpbCBmcm9tIHRoZSBKV1QgY2xhaW1zXG4gKi9cbmZ1bmN0aW9uIGdldFVzZXJFbWFpbChldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICB0cnkge1xuICAgIGNvbnN0IGNsYWltcyA9IChldmVudC5yZXF1ZXN0Q29udGV4dCBhcyBhbnkpPy5hdXRob3JpemVyPy5qd3Q/LmNsYWltcztcbiAgICByZXR1cm4gY2xhaW1zPy5lbWFpbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxufVxuXG4vKipcbiAqIENoZWNrIGlmIHRoZSB1c2VyIG93bnMgdGhlIGRldmljZSAoaXMgYXNzaWduZWQgdG8gaXQpXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGlzRGV2aWNlT3duZXIoZGV2aWNlVWlkOiBzdHJpbmcsIHVzZXJFbWFpbDogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgR2V0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgIEtleTogeyBkZXZpY2VfdWlkOiBkZXZpY2VVaWQgfSxcbiAgICBQcm9qZWN0aW9uRXhwcmVzc2lvbjogJ2Fzc2lnbmVkX3RvJyxcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIHJldHVybiByZXN1bHQuSXRlbT8uYXNzaWduZWRfdG8gPT09IHVzZXJFbWFpbDtcbn1cblxuLyoqXG4gKiBEZWxldGUgYSBqb3VybmV5IGFuZCBhbGwgaXRzIGxvY2F0aW9uIHBvaW50cyAoYWRtaW4vb3duZXIgb25seSlcbiAqL1xuYXN5bmMgZnVuY3Rpb24gZGVsZXRlSm91cm5leShcbiAgZGV2aWNlVWlkOiBzdHJpbmcsXG4gIGpvdXJuZXlJZDogbnVtYmVyLFxuICBldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQsXG4gIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiB7XG4gIC8vIEF1dGhvcml6YXRpb24gY2hlY2s6IG11c3QgYmUgYWRtaW4gb3IgZGV2aWNlIG93bmVyXG4gIGNvbnN0IHVzZXJFbWFpbCA9IGdldFVzZXJFbWFpbChldmVudCk7XG4gIGNvbnN0IGFkbWluID0gaXNBZG1pbihldmVudCk7XG5cbiAgaWYgKCFhZG1pbikge1xuICAgIGlmICghdXNlckVtYWlsKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiA0MDEsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdVbmF1dGhvcml6ZWQnIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCBvd25lciA9IGF3YWl0IGlzRGV2aWNlT3duZXIoZGV2aWNlVWlkLCB1c2VyRW1haWwpO1xuICAgIGlmICghb3duZXIpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwMyxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0FkbWluIG9yIGRldmljZSBvd25lciBhY2Nlc3MgcmVxdWlyZWQnIH0pLFxuICAgICAgfTtcbiAgICB9XG4gIH1cblxuICAvLyBWZXJpZnkgdGhlIGpvdXJuZXkgZXhpc3RzXG4gIGNvbnN0IGpvdXJuZXlDb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCBqb3VybmV5X2lkID0gOmpvdXJuZXlfaWQnLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICAgICc6am91cm5leV9pZCc6IGpvdXJuZXlJZCxcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCBqb3VybmV5UmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoam91cm5leUNvbW1hbmQpO1xuXG4gIGlmICgham91cm5leVJlc3VsdC5JdGVtcyB8fCBqb3VybmV5UmVzdWx0Lkl0ZW1zLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDQsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0pvdXJuZXkgbm90IGZvdW5kJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gR2V0IGFsbCBsb2NhdGlvbiBwb2ludHMgZm9yIHRoaXMgam91cm5leSB0byBkZWxldGUgdGhlbVxuICBjb25zdCBwb2ludHNDb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBMT0NBVElPTlNfVEFCTEUsXG4gICAgSW5kZXhOYW1lOiAnam91cm5leS1pbmRleCcsXG4gICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQgPSA6ZGV2aWNlX3VpZCBBTkQgam91cm5leV9pZCA9IDpqb3VybmV5X2lkJyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAnOmRldmljZV91aWQnOiBkZXZpY2VVaWQsXG4gICAgICAnOmpvdXJuZXlfaWQnOiBqb3VybmV5SWQsXG4gICAgfSxcbiAgICBQcm9qZWN0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQsICN0cycsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAnI3RzJzogJ3RpbWVzdGFtcCcsXG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgcG9pbnRzUmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQocG9pbnRzQ29tbWFuZCk7XG4gIGNvbnN0IGxvY2F0aW9uUG9pbnRzID0gcG9pbnRzUmVzdWx0Lkl0ZW1zIHx8IFtdO1xuXG4gIC8vIERlbGV0ZSBsb2NhdGlvbiBwb2ludHMgaW4gYmF0Y2hlcyBvZiAyNSAoRHluYW1vREIgQmF0Y2hXcml0ZSBsaW1pdClcbiAgaWYgKGxvY2F0aW9uUG9pbnRzLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBiYXRjaGVzID0gW107XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBsb2NhdGlvblBvaW50cy5sZW5ndGg7IGkgKz0gMjUpIHtcbiAgICAgIGNvbnN0IGJhdGNoID0gbG9jYXRpb25Qb2ludHMuc2xpY2UoaSwgaSArIDI1KTtcbiAgICAgIGJhdGNoZXMucHVzaChiYXRjaCk7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBiYXRjaCBvZiBiYXRjaGVzKSB7XG4gICAgICBjb25zdCBkZWxldGVSZXF1ZXN0cyA9IGJhdGNoLm1hcCgocG9pbnQpID0+ICh7XG4gICAgICAgIERlbGV0ZVJlcXVlc3Q6IHtcbiAgICAgICAgICBLZXk6IHtcbiAgICAgICAgICAgIGRldmljZV91aWQ6IHBvaW50LmRldmljZV91aWQsXG4gICAgICAgICAgICB0aW1lc3RhbXA6IHBvaW50LnRpbWVzdGFtcCxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSkpO1xuXG4gICAgICBjb25zdCBiYXRjaENvbW1hbmQgPSBuZXcgQmF0Y2hXcml0ZUNvbW1hbmQoe1xuICAgICAgICBSZXF1ZXN0SXRlbXM6IHtcbiAgICAgICAgICBbTE9DQVRJT05TX1RBQkxFXTogZGVsZXRlUmVxdWVzdHMsXG4gICAgICAgIH0sXG4gICAgICB9KTtcblxuICAgICAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoYmF0Y2hDb21tYW5kKTtcbiAgICB9XG5cbiAgICBjb25zb2xlLmxvZyhgRGVsZXRlZCAke2xvY2F0aW9uUG9pbnRzLmxlbmd0aH0gbG9jYXRpb24gcG9pbnRzIGZvciBqb3VybmV5ICR7am91cm5leUlkfWApO1xuICB9XG5cbiAgLy8gRGVsZXRlIHRoZSBqb3VybmV5IHJlY29yZFxuICBjb25zdCBkZWxldGVDb21tYW5kID0gbmV3IERlbGV0ZUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogSk9VUk5FWVNfVEFCTEUsXG4gICAgS2V5OiB7XG4gICAgICBkZXZpY2VfdWlkOiBkZXZpY2VVaWQsXG4gICAgICBqb3VybmV5X2lkOiBqb3VybmV5SWQsXG4gICAgfSxcbiAgfSk7XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQoZGVsZXRlQ29tbWFuZCk7XG4gIGNvbnNvbGUubG9nKGBEZWxldGVkIGpvdXJuZXkgJHtqb3VybmV5SWR9IGZvciBkZXZpY2UgJHtkZXZpY2VVaWR9YCk7XG5cbiAgcmV0dXJuIHtcbiAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgaGVhZGVycyxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBtZXNzYWdlOiAnSm91cm5leSBkZWxldGVkJyxcbiAgICAgIGpvdXJuZXlfaWQ6IGpvdXJuZXlJZCxcbiAgICAgIHBvaW50c19kZWxldGVkOiBsb2NhdGlvblBvaW50cy5sZW5ndGgsXG4gICAgfSksXG4gIH07XG59XG5cbi8qKlxuICogR2V0IHBvd2VyIGNvbnN1bXB0aW9uIGR1cmluZyBhIGpvdXJuZXkgdGltZWZyYW1lXG4gKiBRdWVyaWVzIHBvd2VyIHRlbGVtZXRyeSBkYXRhIGFuZCBjYWxjdWxhdGVzIG1BaCBjb25zdW1lZFxuICovXG5hc3luYyBmdW5jdGlvbiBnZXRKb3VybmV5UG93ZXJDb25zdW1wdGlvbihcbiAgZGV2aWNlVWlkOiBzdHJpbmcsXG4gIHN0YXJ0VGltZTogbnVtYmVyLFxuICBlbmRUaW1lOiBudW1iZXJcbik6IFByb21pc2U8e1xuICBzdGFydF9tYWg6IG51bWJlcjtcbiAgZW5kX21haDogbnVtYmVyO1xuICBjb25zdW1lZF9tYWg6IG51bWJlcjtcbiAgcmVhZGluZ19jb3VudDogbnVtYmVyO1xufSB8IG51bGw+IHtcbiAgLy8gUXVlcnkgcG93ZXIgdGVsZW1ldHJ5IHVzaW5nIHRoZSBldmVudC10eXBlLWluZGV4IEdTSVxuICBjb25zdCBzdGFydEtleSA9IGBwb3dlciMke3N0YXJ0VGltZX1gO1xuICBjb25zdCBlbmRLZXkgPSBgcG93ZXIjJHtlbmRUaW1lfWA7XG5cbiAgY29uc3QgY29tbWFuZCA9IG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogVEVMRU1FVFJZX1RBQkxFLFxuICAgIEluZGV4TmFtZTogJ2V2ZW50LXR5cGUtaW5kZXgnLFxuICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkID0gOmRldmljZV91aWQgQU5EIGV2ZW50X3R5cGVfdGltZXN0YW1wIEJFVFdFRU4gOnN0YXJ0IEFORCA6ZW5kJyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAnOmRldmljZV91aWQnOiBkZXZpY2VVaWQsXG4gICAgICAnOnN0YXJ0Jzogc3RhcnRLZXksXG4gICAgICAnOmVuZCc6IGVuZEtleSxcbiAgICB9LFxuICAgIFNjYW5JbmRleEZvcndhcmQ6IHRydWUsIC8vIENocm9ub2xvZ2ljYWwgb3JkZXJcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnN0IHBvd2VyUmVhZGluZ3MgPSByZXN1bHQuSXRlbXMgfHwgW107XG5cbiAgLy8gTmVlZCBhdCBsZWFzdCAyIHJlYWRpbmdzIHRvIGNhbGN1bGF0ZSBjb25zdW1wdGlvblxuICBpZiAocG93ZXJSZWFkaW5ncy5sZW5ndGggPCAyKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICAvLyBGaWx0ZXIgZm9yIHJlYWRpbmdzIHRoYXQgaGF2ZSBtaWxsaWFtcF9ob3Vyc1xuICBjb25zdCB2YWxpZFJlYWRpbmdzID0gcG93ZXJSZWFkaW5ncy5maWx0ZXIoKHIpID0+IHR5cGVvZiByLm1pbGxpYW1wX2hvdXJzID09PSAnbnVtYmVyJyk7XG5cbiAgaWYgKHZhbGlkUmVhZGluZ3MubGVuZ3RoIDwgMikge1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgY29uc3QgZmlyc3RSZWFkaW5nID0gdmFsaWRSZWFkaW5nc1swXTtcbiAgY29uc3QgbGFzdFJlYWRpbmcgPSB2YWxpZFJlYWRpbmdzW3ZhbGlkUmVhZGluZ3MubGVuZ3RoIC0gMV07XG5cbiAgY29uc3Qgc3RhcnRNYWggPSBmaXJzdFJlYWRpbmcubWlsbGlhbXBfaG91cnM7XG4gIGNvbnN0IGVuZE1haCA9IGxhc3RSZWFkaW5nLm1pbGxpYW1wX2hvdXJzO1xuXG4gIC8vIENhbGN1bGF0ZSBjb25zdW1wdGlvbiAoaGFuZGxlIGNvdW50ZXIgcmVzZXQgZWRnZSBjYXNlKVxuICBsZXQgY29uc3VtZWRNYWggPSBlbmRNYWggLSBzdGFydE1haDtcbiAgaWYgKGNvbnN1bWVkTWFoIDwgMCkge1xuICAgIC8vIENvdW50ZXIgd2FzIHJlc2V0IGR1cmluZyBqb3VybmV5IC0gY2FuJ3QgY2FsY3VsYXRlIGFjY3VyYXRlbHlcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgc3RhcnRfbWFoOiBNYXRoLnJvdW5kKHN0YXJ0TWFoICogMTAwKSAvIDEwMCxcbiAgICBlbmRfbWFoOiBNYXRoLnJvdW5kKGVuZE1haCAqIDEwMCkgLyAxMDAsXG4gICAgY29uc3VtZWRfbWFoOiBNYXRoLnJvdW5kKGNvbnN1bWVkTWFoICogMTAwKSAvIDEwMCxcbiAgICByZWFkaW5nX2NvdW50OiB2YWxpZFJlYWRpbmdzLmxlbmd0aCxcbiAgfTtcbn1cbiJdfQ==