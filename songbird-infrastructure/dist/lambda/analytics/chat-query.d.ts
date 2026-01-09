/**
 * Analytics Chat Query Lambda
 *
 * Text-to-SQL powered by AWS Bedrock (Claude 3.5 Sonnet).
 * Converts natural language questions into SQL queries, executes them on Aurora,
 * and generates insights and visualizations.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
export declare const handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
