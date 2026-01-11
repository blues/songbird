/**
 * Delete Analytics Session Lambda
 *
 * Deletes all chat history items for a given session.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
export declare const handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
