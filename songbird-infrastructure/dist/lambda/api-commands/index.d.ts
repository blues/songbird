/**
 * Commands API Lambda
 *
 * Sends commands to devices via Notehub API:
 * - GET /v1/commands - Get all commands across devices
 * - DELETE /v1/commands/{command_id} - Delete a command
 * - POST /devices/{device_uid}/commands - Send command to device
 * - GET /devices/{device_uid}/commands - Get command history for a device
 */
import { APIGatewayProxyResult } from 'aws-lambda';
export declare const handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
