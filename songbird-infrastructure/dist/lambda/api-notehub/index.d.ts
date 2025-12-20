/**
 * API Notehub Lambda
 *
 * Fetches Notehub project status and route information.
 * Available to all authenticated users.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
export declare function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2>;
