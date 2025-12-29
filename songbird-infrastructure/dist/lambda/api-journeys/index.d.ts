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
import { APIGatewayProxyResult } from 'aws-lambda';
export declare const handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
