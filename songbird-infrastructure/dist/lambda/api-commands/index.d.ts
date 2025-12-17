/**
 * Commands API Lambda
 *
 * Sends commands to devices via Notehub API:
 * - POST /devices/{device_uid}/commands - Send command to device
 * - GET /devices/{device_uid}/commands - Get command history
 */
import { APIGatewayProxyResult } from 'aws-lambda';
export declare const handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
