/**
 * Re-run Query Lambda
 *
 * Re-executes a stored SQL query from chat history to regenerate visualization data.
 * Used when loading historical conversations to render charts/maps.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
export declare const handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
