/**
 * Alerts API Lambda
 *
 * Handles alert operations:
 * - GET /alerts - List all alerts (with optional filters)
 * - GET /alerts/{alert_id} - Get single alert
 * - POST /alerts/{alert_id}/acknowledge - Acknowledge an alert
 */
import { APIGatewayProxyResult } from 'aws-lambda';
export declare const handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
