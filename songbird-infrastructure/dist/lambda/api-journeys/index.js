"use strict";
/**
 * Journeys API Lambda
 *
 * Handles journey and location history queries:
 * - GET /devices/{device_uid}/journeys - List all journeys for a device
 * - GET /devices/{device_uid}/journeys/{journey_id} - Get journey details with points
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
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const handler = async (event) => {
    console.log('Request:', JSON.stringify(event));
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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
    const journey = {
        journey_id: journeyItem.journey_id,
        device_uid: journeyItem.device_uid,
        start_time: new Date(journeyItem.start_time).toISOString(),
        end_time: journeyItem.end_time ? new Date(journeyItem.end_time).toISOString() : undefined,
        point_count: journeyItem.point_count || 0,
        total_distance: journeyItem.total_distance || 0,
        status: journeyItem.status,
        matched_route: journeyItem.matched_route, // GeoJSON LineString if map-matched
    };
    const points = (pointsResult.Items || []).map((item) => ({
        time: new Date(item.timestamp).toISOString(),
        lat: item.latitude,
        lon: item.longitude,
        velocity: item.velocity,
        bearing: item.bearing,
        distance: item.distance,
        dop: item.dop,
        jcount: item.jcount,
    }));
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            journey,
            points,
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
    const points = pointsResult.Items || [];
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLWpvdXJuZXlzL2luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7R0FRRzs7O0FBRUgsOERBQTBEO0FBQzFELHdEQUE0RjtBQUc1RixNQUFNLFNBQVMsR0FBRyxJQUFJLGdDQUFjLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDekMsTUFBTSxTQUFTLEdBQUcscUNBQXNCLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBRXpELE1BQU0sY0FBYyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsY0FBZSxDQUFDO0FBQ25ELE1BQU0sZUFBZSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsZUFBZ0IsQ0FBQztBQUNyRCxNQUFNLFlBQVksR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLFlBQVksQ0FBQztBQUV2QyxNQUFNLE9BQU8sR0FBRyxLQUFLLEVBQUUsS0FBMkIsRUFBa0MsRUFBRTtJQUMzRixPQUFPLENBQUMsR0FBRyxDQUFDLFVBQVUsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFFL0MsTUFBTSxXQUFXLEdBQUc7UUFDbEIsNkJBQTZCLEVBQUUsR0FBRztRQUNsQyw4QkFBOEIsRUFBRSw0QkFBNEI7UUFDNUQsOEJBQThCLEVBQUUsa0JBQWtCO0tBQ25ELENBQUM7SUFFRixJQUFJLENBQUM7UUFDSCxNQUFNLE1BQU0sR0FBSSxLQUFLLENBQUMsY0FBc0IsRUFBRSxJQUFJLEVBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUM7UUFDL0UsTUFBTSxJQUFJLEdBQUksS0FBSyxDQUFDLGNBQXNCLEVBQUUsSUFBSSxFQUFFLElBQUksSUFBSSxLQUFLLENBQUMsSUFBSSxDQUFDO1FBRXJFLElBQUksTUFBTSxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQ3pCLE9BQU8sRUFBRSxVQUFVLEVBQUUs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QUMsUUFBUTtRQUN2QixPQUFPLEVBQUUsSUFBSSxDQUFDLE9BQU87S0FDdEIsQ0FBQyxDQUFDLENBQUM7SUFFSixPQUFPO1FBQ0wsVUFBVSxFQUFFLEdBQUc7UUFDZixPQUFPO1FBQ1AsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUM7WUFDbkIsVUFBVSxFQUFFLFNBQVM7WUFDckIsS0FBSztZQUNMLEtBQUssRUFBRSxTQUFTLENBQUMsTUFBTTtZQUN2QixTQUFTO1NBQ1YsQ0FBQztLQUNILENBQUM7QUFDSixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBKb3VybmV5cyBBUEkgTGFtYmRhXG4gKlxuICogSGFuZGxlcyBqb3VybmV5IGFuZCBsb2NhdGlvbiBoaXN0b3J5IHF1ZXJpZXM6XG4gKiAtIEdFVCAvZGV2aWNlcy97ZGV2aWNlX3VpZH0vam91cm5leXMgLSBMaXN0IGFsbCBqb3VybmV5cyBmb3IgYSBkZXZpY2VcbiAqIC0gR0VUIC9kZXZpY2VzL3tkZXZpY2VfdWlkfS9qb3VybmV5cy97am91cm5leV9pZH0gLSBHZXQgam91cm5leSBkZXRhaWxzIHdpdGggcG9pbnRzXG4gKiAtIEdFVCAvZGV2aWNlcy97ZGV2aWNlX3VpZH0vbG9jYXRpb25zIC0gR2V0IGxvY2F0aW9uIGhpc3RvcnlcbiAqIC0gUE9TVCAvZGV2aWNlcy97ZGV2aWNlX3VpZH0vam91cm5leXMve2pvdXJuZXlfaWR9L21hdGNoIC0gVHJpZ2dlciBtYXAgbWF0Y2hpbmdcbiAqL1xuXG5pbXBvcnQgeyBEeW5hbW9EQkNsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYic7XG5pbXBvcnQgeyBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LCBRdWVyeUNvbW1hbmQsIFVwZGF0ZUNvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9saWItZHluYW1vZGInO1xuaW1wb3J0IHsgQVBJR2F0ZXdheVByb3h5RXZlbnQsIEFQSUdhdGV3YXlQcm94eVJlc3VsdCB9IGZyb20gJ2F3cy1sYW1iZGEnO1xuXG5jb25zdCBkZGJDbGllbnQgPSBuZXcgRHluYW1vREJDbGllbnQoe30pO1xuY29uc3QgZG9jQ2xpZW50ID0gRHluYW1vREJEb2N1bWVudENsaWVudC5mcm9tKGRkYkNsaWVudCk7XG5cbmNvbnN0IEpPVVJORVlTX1RBQkxFID0gcHJvY2Vzcy5lbnYuSk9VUk5FWVNfVEFCTEUhO1xuY29uc3QgTE9DQVRJT05TX1RBQkxFID0gcHJvY2Vzcy5lbnYuTE9DQVRJT05TX1RBQkxFITtcbmNvbnN0IE1BUEJPWF9UT0tFTiA9IHByb2Nlc3MuZW52Lk1BUEJPWF9UT0tFTjtcblxuZXhwb3J0IGNvbnN0IGhhbmRsZXIgPSBhc3luYyAoZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50KTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+ID0+IHtcbiAgY29uc29sZS5sb2coJ1JlcXVlc3Q6JywgSlNPTi5zdHJpbmdpZnkoZXZlbnQpKTtcblxuICBjb25zdCBjb3JzSGVhZGVycyA9IHtcbiAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJzogJyonLFxuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzJzogJ0NvbnRlbnQtVHlwZSxBdXRob3JpemF0aW9uJyxcbiAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kcyc6ICdHRVQsUE9TVCxPUFRJT05TJyxcbiAgfTtcblxuICB0cnkge1xuICAgIGNvbnN0IG1ldGhvZCA9IChldmVudC5yZXF1ZXN0Q29udGV4dCBhcyBhbnkpPy5odHRwPy5tZXRob2QgfHwgZXZlbnQuaHR0cE1ldGhvZDtcbiAgICBjb25zdCBwYXRoID0gKGV2ZW50LnJlcXVlc3RDb250ZXh0IGFzIGFueSk/Lmh0dHA/LnBhdGggfHwgZXZlbnQucGF0aDtcblxuICAgIGlmIChtZXRob2QgPT09ICdPUFRJT05TJykge1xuICAgICAgcmV0dXJuIHsgc3RhdHVzQ29kZTogMjAwLCBoZWFkZXJzOiBjb3JzSGVhZGVycywgYm9keTogJycgfTtcbiAgICB9XG5cbiAgICBjb25zdCBkZXZpY2VVaWQgPSBldmVudC5wYXRoUGFyYW1ldGVycz8uZGV2aWNlX3VpZDtcbiAgICBpZiAoIWRldmljZVVpZCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICBoZWFkZXJzOiBjb3JzSGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ2RldmljZV91aWQgcmVxdWlyZWQnIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCBqb3VybmV5SWQgPSBldmVudC5wYXRoUGFyYW1ldGVycz8uam91cm5leV9pZDtcbiAgICBjb25zdCBxdWVyeVBhcmFtcyA9IGV2ZW50LnF1ZXJ5U3RyaW5nUGFyYW1ldGVycyB8fCB7fTtcblxuICAgIC8vIEdFVCAvZGV2aWNlcy97ZGV2aWNlX3VpZH0vbG9jYXRpb25zIC0gTG9jYXRpb24gaGlzdG9yeVxuICAgIGlmIChwYXRoLmVuZHNXaXRoKCcvbG9jYXRpb25zJykpIHtcbiAgICAgIHJldHVybiBhd2FpdCBnZXRMb2NhdGlvbkhpc3RvcnkoZGV2aWNlVWlkLCBxdWVyeVBhcmFtcywgY29yc0hlYWRlcnMpO1xuICAgIH1cblxuICAgIC8vIFBPU1QgL2RldmljZXMve2RldmljZV91aWR9L2pvdXJuZXlzL3tqb3VybmV5X2lkfS9tYXRjaCAtIE1hcCBtYXRjaGluZ1xuICAgIGlmIChwYXRoLmVuZHNXaXRoKCcvbWF0Y2gnKSAmJiBtZXRob2QgPT09ICdQT1NUJyAmJiBqb3VybmV5SWQpIHtcbiAgICAgIHJldHVybiBhd2FpdCBtYXRjaEpvdXJuZXkoZGV2aWNlVWlkLCBwYXJzZUludChqb3VybmV5SWQpLCBjb3JzSGVhZGVycyk7XG4gICAgfVxuXG4gICAgLy8gR0VUIC9kZXZpY2VzL3tkZXZpY2VfdWlkfS9qb3VybmV5cy97am91cm5leV9pZH0gLSBTaW5nbGUgam91cm5leSB3aXRoIHBvaW50c1xuICAgIGlmIChqb3VybmV5SWQpIHtcbiAgICAgIHJldHVybiBhd2FpdCBnZXRKb3VybmV5RGV0YWlsKGRldmljZVVpZCwgcGFyc2VJbnQoam91cm5leUlkKSwgY29yc0hlYWRlcnMpO1xuICAgIH1cblxuICAgIC8vIEdFVCAvZGV2aWNlcy97ZGV2aWNlX3VpZH0vam91cm5leXMgLSBMaXN0IGpvdXJuZXlzXG4gICAgcmV0dXJuIGF3YWl0IGxpc3RKb3VybmV5cyhkZXZpY2VVaWQsIHF1ZXJ5UGFyYW1zLCBjb3JzSGVhZGVycyk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3I6JywgZXJyb3IpO1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA1MDAsXG4gICAgICBoZWFkZXJzOiBjb3JzSGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnRlcm5hbCBzZXJ2ZXIgZXJyb3InIH0pLFxuICAgIH07XG4gIH1cbn07XG5cbi8qKlxuICogTGlzdCBhbGwgam91cm5leXMgZm9yIGEgZGV2aWNlXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGxpc3RKb3VybmV5cyhcbiAgZGV2aWNlVWlkOiBzdHJpbmcsXG4gIHF1ZXJ5UGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCB1bmRlZmluZWQ+LFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICBjb25zdCBzdGF0dXMgPSBxdWVyeVBhcmFtcy5zdGF0dXM7IC8vICdhY3RpdmUnIHwgJ2NvbXBsZXRlZCcgfCB1bmRlZmluZWQgKGFsbClcbiAgY29uc3QgbGltaXQgPSBwYXJzZUludChxdWVyeVBhcmFtcy5saW1pdCB8fCAnNTAnKTtcblxuICBjb25zdCBjb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkJyxcbiAgICAuLi4oc3RhdHVzICYmIHtcbiAgICAgIEZpbHRlckV4cHJlc3Npb246ICcjc3RhdHVzID0gOnN0YXR1cycsXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHsgJyNzdGF0dXMnOiAnc3RhdHVzJyB9LFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAnOmRldmljZV91aWQnOiBkZXZpY2VVaWQsXG4gICAgICAgICc6c3RhdHVzJzogc3RhdHVzLFxuICAgICAgfSxcbiAgICB9KSxcbiAgICAuLi4oIXN0YXR1cyAmJiB7XG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICAgIH0sXG4gICAgfSksXG4gICAgU2NhbkluZGV4Rm9yd2FyZDogZmFsc2UsIC8vIE1vc3QgcmVjZW50IGZpcnN0XG4gICAgTGltaXQ6IGxpbWl0LFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChjb21tYW5kKTtcblxuICBjb25zdCBqb3VybmV5cyA9IChyZXN1bHQuSXRlbXMgfHwgW10pLm1hcCgoaXRlbSkgPT4gKHtcbiAgICBqb3VybmV5X2lkOiBpdGVtLmpvdXJuZXlfaWQsXG4gICAgZGV2aWNlX3VpZDogaXRlbS5kZXZpY2VfdWlkLFxuICAgIHN0YXJ0X3RpbWU6IG5ldyBEYXRlKGl0ZW0uc3RhcnRfdGltZSkudG9JU09TdHJpbmcoKSxcbiAgICBlbmRfdGltZTogaXRlbS5lbmRfdGltZSA/IG5ldyBEYXRlKGl0ZW0uZW5kX3RpbWUpLnRvSVNPU3RyaW5nKCkgOiB1bmRlZmluZWQsXG4gICAgcG9pbnRfY291bnQ6IGl0ZW0ucG9pbnRfY291bnQgfHwgMCxcbiAgICB0b3RhbF9kaXN0YW5jZTogaXRlbS50b3RhbF9kaXN0YW5jZSB8fCAwLFxuICAgIHN0YXR1czogaXRlbS5zdGF0dXMsXG4gIH0pKTtcblxuICByZXR1cm4ge1xuICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICBoZWFkZXJzLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIGRldmljZV91aWQ6IGRldmljZVVpZCxcbiAgICAgIGpvdXJuZXlzLFxuICAgICAgY291bnQ6IGpvdXJuZXlzLmxlbmd0aCxcbiAgICB9KSxcbiAgfTtcbn1cblxuLyoqXG4gKiBHZXQgYSBzaW5nbGUgam91cm5leSB3aXRoIGFsbCBpdHMgbG9jYXRpb24gcG9pbnRzXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGdldEpvdXJuZXlEZXRhaWwoXG4gIGRldmljZVVpZDogc3RyaW5nLFxuICBqb3VybmV5SWQ6IG51bWJlcixcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgLy8gR2V0IHRoZSBqb3VybmV5IG1ldGFkYXRhXG4gIGNvbnN0IGpvdXJuZXlDb21tYW5kID0gbmV3IFF1ZXJ5Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBKT1VSTkVZU19UQUJMRSxcbiAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCBqb3VybmV5X2lkID0gOmpvdXJuZXlfaWQnLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICAgICc6am91cm5leV9pZCc6IGpvdXJuZXlJZCxcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCBqb3VybmV5UmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQoam91cm5leUNvbW1hbmQpO1xuXG4gIGlmICgham91cm5leVJlc3VsdC5JdGVtcyB8fCBqb3VybmV5UmVzdWx0Lkl0ZW1zLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDQsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0pvdXJuZXkgbm90IGZvdW5kJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3Qgam91cm5leUl0ZW0gPSBqb3VybmV5UmVzdWx0Lkl0ZW1zWzBdO1xuXG4gIC8vIEdldCBhbGwgbG9jYXRpb24gcG9pbnRzIGZvciB0aGlzIGpvdXJuZXkgdXNpbmcgdGhlIGpvdXJuZXktaW5kZXggR1NJXG4gIGNvbnN0IHBvaW50c0NvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IExPQ0FUSU9OU19UQUJMRSxcbiAgICBJbmRleE5hbWU6ICdqb3VybmV5LWluZGV4JyxcbiAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCBqb3VybmV5X2lkID0gOmpvdXJuZXlfaWQnLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICAgICc6am91cm5leV9pZCc6IGpvdXJuZXlJZCxcbiAgICB9LFxuICAgIFNjYW5JbmRleEZvcndhcmQ6IHRydWUsIC8vIENocm9ub2xvZ2ljYWwgb3JkZXJcbiAgfSk7XG5cbiAgY29uc3QgcG9pbnRzUmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQocG9pbnRzQ29tbWFuZCk7XG5cbiAgY29uc3Qgam91cm5leSA9IHtcbiAgICBqb3VybmV5X2lkOiBqb3VybmV5SXRlbS5qb3VybmV5X2lkLFxuICAgIGRldmljZV91aWQ6IGpvdXJuZXlJdGVtLmRldmljZV91aWQsXG4gICAgc3RhcnRfdGltZTogbmV3IERhdGUoam91cm5leUl0ZW0uc3RhcnRfdGltZSkudG9JU09TdHJpbmcoKSxcbiAgICBlbmRfdGltZTogam91cm5leUl0ZW0uZW5kX3RpbWUgPyBuZXcgRGF0ZShqb3VybmV5SXRlbS5lbmRfdGltZSkudG9JU09TdHJpbmcoKSA6IHVuZGVmaW5lZCxcbiAgICBwb2ludF9jb3VudDogam91cm5leUl0ZW0ucG9pbnRfY291bnQgfHwgMCxcbiAgICB0b3RhbF9kaXN0YW5jZTogam91cm5leUl0ZW0udG90YWxfZGlzdGFuY2UgfHwgMCxcbiAgICBzdGF0dXM6IGpvdXJuZXlJdGVtLnN0YXR1cyxcbiAgICBtYXRjaGVkX3JvdXRlOiBqb3VybmV5SXRlbS5tYXRjaGVkX3JvdXRlLCAvLyBHZW9KU09OIExpbmVTdHJpbmcgaWYgbWFwLW1hdGNoZWRcbiAgfTtcblxuICBjb25zdCBwb2ludHMgPSAocG9pbnRzUmVzdWx0Lkl0ZW1zIHx8IFtdKS5tYXAoKGl0ZW0pID0+ICh7XG4gICAgdGltZTogbmV3IERhdGUoaXRlbS50aW1lc3RhbXApLnRvSVNPU3RyaW5nKCksXG4gICAgbGF0OiBpdGVtLmxhdGl0dWRlLFxuICAgIGxvbjogaXRlbS5sb25naXR1ZGUsXG4gICAgdmVsb2NpdHk6IGl0ZW0udmVsb2NpdHksXG4gICAgYmVhcmluZzogaXRlbS5iZWFyaW5nLFxuICAgIGRpc3RhbmNlOiBpdGVtLmRpc3RhbmNlLFxuICAgIGRvcDogaXRlbS5kb3AsXG4gICAgamNvdW50OiBpdGVtLmpjb3VudCxcbiAgfSkpO1xuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzQ29kZTogMjAwLFxuICAgIGhlYWRlcnMsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgam91cm5leSxcbiAgICAgIHBvaW50cyxcbiAgICB9KSxcbiAgfTtcbn1cblxuLyoqXG4gKiBDYWxsIE1hcGJveCBNYXAgTWF0Y2hpbmcgQVBJIGFuZCBjYWNoZSB0aGUgcmVzdWx0XG4gKi9cbmFzeW5jIGZ1bmN0aW9uIG1hdGNoSm91cm5leShcbiAgZGV2aWNlVWlkOiBzdHJpbmcsXG4gIGpvdXJuZXlJZDogbnVtYmVyLFxuICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4pOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4ge1xuICBpZiAoIU1BUEJPWF9UT0tFTikge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA1MDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ01hcCBtYXRjaGluZyBub3QgY29uZmlndXJlZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIC8vIEdldCB0aGUgam91cm5leSBwb2ludHNcbiAgY29uc3QgcG9pbnRzQ29tbWFuZCA9IG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogTE9DQVRJT05TX1RBQkxFLFxuICAgIEluZGV4TmFtZTogJ2pvdXJuZXktaW5kZXgnLFxuICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkID0gOmRldmljZV91aWQgQU5EIGpvdXJuZXlfaWQgPSA6am91cm5leV9pZCcsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgJzpqb3VybmV5X2lkJzogam91cm5leUlkLFxuICAgIH0sXG4gICAgU2NhbkluZGV4Rm9yd2FyZDogdHJ1ZSxcbiAgfSk7XG5cbiAgY29uc3QgcG9pbnRzUmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQocG9pbnRzQ29tbWFuZCk7XG4gIGNvbnN0IHBvaW50cyA9IHBvaW50c1Jlc3VsdC5JdGVtcyB8fCBbXTtcblxuICBpZiAocG9pbnRzLmxlbmd0aCA8IDIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdKb3VybmV5IGhhcyBmZXdlciB0aGFuIDIgcG9pbnRzJyB9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gTWFwYm94IE1hcCBNYXRjaGluZyBBUEkgaGFzIGEgbGltaXQgb2YgMTAwIGNvb3JkaW5hdGVzIHBlciByZXF1ZXN0XG4gIC8vIElmIHdlIGhhdmUgbW9yZSwgd2UgbmVlZCB0byBzYW1wbGUgb3IgYmF0Y2hcbiAgY29uc3QgbWF4UG9pbnRzID0gMTAwO1xuICBsZXQgc2FtcGxlZFBvaW50cyA9IHBvaW50cztcbiAgaWYgKHBvaW50cy5sZW5ndGggPiBtYXhQb2ludHMpIHtcbiAgICAvLyBTYW1wbGUgcG9pbnRzIGV2ZW5seVxuICAgIGNvbnN0IHN0ZXAgPSAocG9pbnRzLmxlbmd0aCAtIDEpIC8gKG1heFBvaW50cyAtIDEpO1xuICAgIHNhbXBsZWRQb2ludHMgPSBbXTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG1heFBvaW50czsgaSsrKSB7XG4gICAgICBjb25zdCBpZHggPSBNYXRoLnJvdW5kKGkgKiBzdGVwKTtcbiAgICAgIHNhbXBsZWRQb2ludHMucHVzaChwb2ludHNbaWR4XSk7XG4gICAgfVxuICB9XG5cbiAgLy8gRm9ybWF0IGNvb3JkaW5hdGVzIGZvciBNYXBib3ggQVBJOiBsb24sbGF0O2xvbixsYXQ7Li4uXG4gIGNvbnN0IGNvb3JkaW5hdGVzID0gc2FtcGxlZFBvaW50c1xuICAgIC5tYXAoKHApID0+IGAke3AubG9uZ2l0dWRlfSwke3AubGF0aXR1ZGV9YClcbiAgICAuam9pbignOycpO1xuXG4gIC8vIEJ1aWxkIHRoZSB0aW1lc3RhbXBzIHBhcmFtZXRlciAoVW5peCB0aW1lc3RhbXBzIGluIHNlY29uZHMpXG4gIGNvbnN0IHRpbWVzdGFtcHMgPSBzYW1wbGVkUG9pbnRzXG4gICAgLm1hcCgocCkgPT4gTWF0aC5mbG9vcihwLnRpbWVzdGFtcCAvIDEwMDApKVxuICAgIC5qb2luKCc7Jyk7XG5cbiAgLy8gQnVpbGQgdGhlIHJhZGl1c2VzIHBhcmFtZXRlciAoR1BTIGFjY3VyYWN5IGluIG1ldGVycywgZGVmYXVsdCAyNW0pXG4gIGNvbnN0IHJhZGl1c2VzID0gc2FtcGxlZFBvaW50c1xuICAgIC5tYXAoKHApID0+IChwLmRvcCA/IE1hdGgubWF4KDUsIHAuZG9wICogMTApIDogMjUpKVxuICAgIC5qb2luKCc7Jyk7XG5cbiAgLy8gQ2FsbCBNYXBib3ggTWFwIE1hdGNoaW5nIEFQSVxuICBjb25zdCBtYXBNYXRjaFVybCA9IGBodHRwczovL2FwaS5tYXBib3guY29tL21hdGNoaW5nL3Y1L21hcGJveC9kcml2aW5nLyR7Y29vcmRpbmF0ZXN9P2FjY2Vzc190b2tlbj0ke01BUEJPWF9UT0tFTn0mZ2VvbWV0cmllcz1nZW9qc29uJnJhZGl1c2VzPSR7cmFkaXVzZXN9JnRpbWVzdGFtcHM9JHt0aW1lc3RhbXBzfSZvdmVydmlldz1mdWxsJnN0ZXBzPWZhbHNlYDtcblxuICBjb25zb2xlLmxvZyhgQ2FsbGluZyBNYXBib3ggTWFwIE1hdGNoaW5nIEFQSSBmb3Igam91cm5leSAke2pvdXJuZXlJZH0gd2l0aCAke3NhbXBsZWRQb2ludHMubGVuZ3RofSBwb2ludHNgKTtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2gobWFwTWF0Y2hVcmwpO1xuICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XG5cbiAgICBpZiAoZGF0YS5jb2RlICE9PSAnT2snIHx8ICFkYXRhLm1hdGNoaW5ncyB8fCBkYXRhLm1hdGNoaW5ncy5sZW5ndGggPT09IDApIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ01hcCBtYXRjaGluZyBmYWlsZWQ6JywgZGF0YSk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICBlcnJvcjogJ01hcCBtYXRjaGluZyBmYWlsZWQnLFxuICAgICAgICAgIGNvZGU6IGRhdGEuY29kZSxcbiAgICAgICAgICBtZXNzYWdlOiBkYXRhLm1lc3NhZ2UsXG4gICAgICAgIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBHZXQgdGhlIG1hdGNoZWQgZ2VvbWV0cnkgKEdlb0pTT04gTGluZVN0cmluZylcbiAgICBjb25zdCBtYXRjaGVkUm91dGUgPSBkYXRhLm1hdGNoaW5nc1swXS5nZW9tZXRyeTtcbiAgICBjb25zdCBjb25maWRlbmNlID0gZGF0YS5tYXRjaGluZ3NbMF0uY29uZmlkZW5jZTtcblxuICAgIC8vIFN0b3JlIHRoZSBtYXRjaGVkIHJvdXRlIGluIER5bmFtb0RCXG4gICAgY29uc3QgdXBkYXRlQ29tbWFuZCA9IG5ldyBVcGRhdGVDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogSk9VUk5FWVNfVEFCTEUsXG4gICAgICBLZXk6IHtcbiAgICAgICAgZGV2aWNlX3VpZDogZGV2aWNlVWlkLFxuICAgICAgICBqb3VybmV5X2lkOiBqb3VybmV5SWQsXG4gICAgICB9LFxuICAgICAgVXBkYXRlRXhwcmVzc2lvbjogJ1NFVCBtYXRjaGVkX3JvdXRlID0gOnJvdXRlLCBtYXRjaF9jb25maWRlbmNlID0gOmNvbmZpZGVuY2UsIG1hdGNoZWRfYXQgPSA6dGltZScsXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICc6cm91dGUnOiBtYXRjaGVkUm91dGUsXG4gICAgICAgICc6Y29uZmlkZW5jZSc6IGNvbmZpZGVuY2UsXG4gICAgICAgICc6dGltZSc6IERhdGUubm93KCksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgYXdhaXQgZG9jQ2xpZW50LnNlbmQodXBkYXRlQ29tbWFuZCk7XG4gICAgY29uc29sZS5sb2coYFN0b3JlZCBtYXRjaGVkIHJvdXRlIGZvciBqb3VybmV5ICR7am91cm5leUlkfSB3aXRoIGNvbmZpZGVuY2UgJHtjb25maWRlbmNlfWApO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIG1hdGNoZWRfcm91dGU6IG1hdGNoZWRSb3V0ZSxcbiAgICAgICAgY29uZmlkZW5jZSxcbiAgICAgICAgb3JpZ2luYWxfcG9pbnRzOiBwb2ludHMubGVuZ3RoLFxuICAgICAgICBtYXRjaGVkX3BvaW50czogc2FtcGxlZFBvaW50cy5sZW5ndGgsXG4gICAgICB9KSxcbiAgICB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIGNhbGxpbmcgTWFwYm94IEFQSTonLCBlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRmFpbGVkIHRvIGNhbGwgbWFwIG1hdGNoaW5nIEFQSScgfSksXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIEdldCBsb2NhdGlvbiBoaXN0b3J5IGZvciBhIGRldmljZVxuICovXG5hc3luYyBmdW5jdGlvbiBnZXRMb2NhdGlvbkhpc3RvcnkoXG4gIGRldmljZVVpZDogc3RyaW5nLFxuICBxdWVyeVBhcmFtczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgdW5kZWZpbmVkPixcbiAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuKTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+IHtcbiAgY29uc3QgaG91cnMgPSBwYXJzZUludChxdWVyeVBhcmFtcy5ob3VycyB8fCAnMjQnKTtcbiAgY29uc3Qgc291cmNlID0gcXVlcnlQYXJhbXMuc291cmNlOyAvLyAnZ3BzJyB8ICdjZWxsJyB8ICd0cmlhbmd1bGF0aW9uJyB8IHVuZGVmaW5lZCAoYWxsKVxuICBjb25zdCBsaW1pdCA9IHBhcnNlSW50KHF1ZXJ5UGFyYW1zLmxpbWl0IHx8ICcxMDAwJyk7XG5cbiAgY29uc3QgY3V0b2ZmVGltZSA9IERhdGUubm93KCkgLSBob3VycyAqIDYwICogNjAgKiAxMDAwO1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgUXVlcnlDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IExPQ0FUSU9OU19UQUJMRSxcbiAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCA9IDpkZXZpY2VfdWlkIEFORCAjdGltZXN0YW1wID49IDpjdXRvZmYnLFxuICAgIC4uLihzb3VyY2UgJiYge1xuICAgICAgRmlsdGVyRXhwcmVzc2lvbjogJyNzb3VyY2UgPSA6c291cmNlJyxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczoge1xuICAgICAgICAnI3RpbWVzdGFtcCc6ICd0aW1lc3RhbXAnLFxuICAgICAgICAnI3NvdXJjZSc6ICdzb3VyY2UnLFxuICAgICAgfSxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgICAnOmN1dG9mZic6IGN1dG9mZlRpbWUsXG4gICAgICAgICc6c291cmNlJzogc291cmNlLFxuICAgICAgfSxcbiAgICB9KSxcbiAgICAuLi4oIXNvdXJjZSAmJiB7XG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICAgJyN0aW1lc3RhbXAnOiAndGltZXN0YW1wJyxcbiAgICAgIH0sXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICAgICAgJzpjdXRvZmYnOiBjdXRvZmZUaW1lLFxuICAgICAgfSxcbiAgICB9KSxcbiAgICBTY2FuSW5kZXhGb3J3YXJkOiBmYWxzZSwgLy8gTW9zdCByZWNlbnQgZmlyc3RcbiAgICBMaW1pdDogbGltaXQsXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuXG4gIGNvbnN0IGxvY2F0aW9ucyA9IChyZXN1bHQuSXRlbXMgfHwgW10pLm1hcCgoaXRlbSkgPT4gKHtcbiAgICB0aW1lOiBuZXcgRGF0ZShpdGVtLnRpbWVzdGFtcCkudG9JU09TdHJpbmcoKSxcbiAgICBsYXQ6IGl0ZW0ubGF0aXR1ZGUsXG4gICAgbG9uOiBpdGVtLmxvbmdpdHVkZSxcbiAgICBzb3VyY2U6IGl0ZW0uc291cmNlLFxuICAgIGxvY2F0aW9uX25hbWU6IGl0ZW0ubG9jYXRpb25fbmFtZSxcbiAgICBldmVudF90eXBlOiBpdGVtLmV2ZW50X3R5cGUsXG4gICAgam91cm5leV9pZDogaXRlbS5qb3VybmV5X2lkLFxuICAgIGpjb3VudDogaXRlbS5qY291bnQsXG4gICAgdmVsb2NpdHk6IGl0ZW0udmVsb2NpdHksXG4gICAgYmVhcmluZzogaXRlbS5iZWFyaW5nLFxuICB9KSk7XG5cbiAgcmV0dXJuIHtcbiAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgaGVhZGVycyxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBkZXZpY2VfdWlkOiBkZXZpY2VVaWQsXG4gICAgICBob3VycyxcbiAgICAgIGNvdW50OiBsb2NhdGlvbnMubGVuZ3RoLFxuICAgICAgbG9jYXRpb25zLFxuICAgIH0pLFxuICB9O1xufVxuIl19