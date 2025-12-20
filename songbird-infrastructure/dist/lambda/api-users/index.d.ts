/**
 * API Users Lambda
 *
 * Handles user management operations using Cognito Admin APIs.
 * All endpoints are admin-only.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
export declare function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2>;
