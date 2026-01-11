/**
 * List Analytics Sessions Lambda
 *
 * Returns a list of unique chat sessions for a user with metadata.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
export declare const handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
