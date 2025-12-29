/**
 * Telemetry API Lambda
 *
 * Queries DynamoDB for device telemetry data:
 * - GET /devices/{serial_number}/telemetry - Get telemetry history
 * - GET /devices/{serial_number}/location - Get location history
 * - GET /devices/{serial_number}/power - Get Mojo power history
 * - GET /devices/{serial_number}/health - Get health event history
 *
 * Note: When a Notecard is swapped, historical data is merged from all device_uids
 * associated with the serial_number.
 */
import { APIGatewayProxyResult } from 'aws-lambda';
export declare const handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
