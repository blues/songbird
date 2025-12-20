/**
 * API Settings Lambda
 *
 * Handles fleet defaults settings CRUD operations.
 * Admin-only endpoints are protected by checking JWT cognito:groups claim.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
export declare function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2>;
