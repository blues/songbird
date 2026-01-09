/**
 * DynamoDB → Aurora Real-Time Sync
 *
 * Processes DynamoDB Stream events and syncs data to Aurora analytics database.
 */
import { DynamoDBStreamEvent } from 'aws-lambda';
export declare const handler: (event: DynamoDBStreamEvent) => Promise<void>;
