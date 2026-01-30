/**
 * Config API Lambda
 *
 * Manages device configuration via Notehub environment variables:
 * - GET /devices/{serial_number}/config - Get current config
 * - PUT /devices/{serial_number}/config - Update config
 * - PUT /devices/{serial_number}/wifi - Set device Wi-Fi credentials
 * - PUT /fleets/{fleet_uid}/config - Update fleet-wide config
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
export declare const handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
