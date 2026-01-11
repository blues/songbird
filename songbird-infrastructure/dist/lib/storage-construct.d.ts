/**
 * Storage Construct
 *
 * Defines DynamoDB tables for device metadata and telemetry data.
 * (Timestream is no longer available to new AWS customers)
 */
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
export interface StorageConstructProps {
    dynamoTableName: string;
    telemetryTableName: string;
}
export declare class StorageConstruct extends Construct {
    readonly devicesTable: dynamodb.Table;
    readonly telemetryTable: dynamodb.Table;
    readonly alertsTable: dynamodb.Table;
    readonly settingsTable: dynamodb.Table;
    readonly journeysTable: dynamodb.Table;
    readonly locationsTable: dynamodb.Table;
    readonly deviceAliasesTable: dynamodb.Table;
    readonly auditTable: dynamodb.Table;
    constructor(scope: Construct, id: string, props: StorageConstructProps);
}
