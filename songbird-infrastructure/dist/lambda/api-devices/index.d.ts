/**
 * Devices API Lambda
 *
 * Handles device CRUD operations:
 * - GET /devices - List all devices
 * - GET /devices/{device_uid} - Get device details
 * - PATCH /devices/{device_uid} - Update device metadata
 */
import { APIGatewayProxyResult } from 'aws-lambda';
export declare const handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
