/**
 * Telemetry API Lambda
 *
 * Queries DynamoDB for device telemetry data:
 * - GET /devices/{device_uid}/telemetry - Get telemetry history
 * - GET /devices/{device_uid}/location - Get location history
 * - GET /devices/{device_uid}/power - Get Mojo power history
 * - GET /devices/{device_uid}/health - Get health event history
 */
import { APIGatewayProxyResult } from 'aws-lambda';
export declare const handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
