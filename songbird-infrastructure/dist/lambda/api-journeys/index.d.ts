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
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
export declare const handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
