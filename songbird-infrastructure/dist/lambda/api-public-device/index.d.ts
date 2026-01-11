/**
 * Public Device API Lambda
 *
 * Provides unauthenticated read-only access to device information.
 * All requests are audit logged.
 *
 * Endpoints:
 * - GET /public/devices/{serial_number} - Get device details (no auth required)
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
export declare const handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
