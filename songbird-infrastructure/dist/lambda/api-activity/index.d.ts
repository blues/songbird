/**
 * Activity Feed API Lambda
 *
 * Returns a unified activity feed combining:
 * - Alerts (from alerts table)
 * - Health events (from telemetry table)
 * - Location updates (from telemetry table)
 * - Device status changes (derived from device last_seen)
 */
import { APIGatewayProxyResult } from 'aws-lambda';
export declare const handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
