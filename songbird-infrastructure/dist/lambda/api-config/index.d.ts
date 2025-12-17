/**
 * Config API Lambda
 *
 * Manages device configuration via Notehub environment variables:
 * - GET /devices/{device_uid}/config - Get current config
 * - PUT /devices/{device_uid}/config - Update config
 * - PUT /fleets/{fleet_uid}/config - Update fleet-wide config
 */
import { APIGatewayProxyResult } from 'aws-lambda';
export declare const handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
