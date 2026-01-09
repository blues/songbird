/**
 * API Settings Lambda
 *
 * Handles fleet defaults settings CRUD operations.
 * Admin-only endpoints are protected by checking JWT cognito:groups claim.
 *
 * Fleet defaults are saved to:
 * 1. DynamoDB (for dashboard UI)
 * 2. Notehub fleet environment variables (so devices receive the config)
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
export declare function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2>;
