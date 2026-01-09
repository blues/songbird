/**
 * API Firmware Lambda
 *
 * Handles host firmware management operations via Notehub API.
 * All endpoints are admin-only.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
export declare function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2>;
