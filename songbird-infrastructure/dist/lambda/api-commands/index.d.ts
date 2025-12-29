/**
 * Commands API Lambda
 *
 * Sends commands to devices via Notehub API:
 * - GET /v1/commands - Get all commands across devices
 * - DELETE /v1/commands/{command_id} - Delete a command
 * - POST /devices/{serial_number}/commands - Send command to device (routes to current Notecard)
 * - GET /devices/{serial_number}/commands - Get command history for a device (merged from all Notecards)
 */
import { APIGatewayProxyResult } from 'aws-lambda';
export declare const handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
