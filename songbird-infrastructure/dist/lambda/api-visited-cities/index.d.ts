/**
 * Visited Cities API Lambda
 *
 * Aggregates location history to show unique cities a device has visited.
 * - GET /devices/{serial_number}/visited-cities - Get all unique cities visited
 *
 * Note: When a Notecard is swapped, locations from all device_uids are merged.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
export declare const handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
