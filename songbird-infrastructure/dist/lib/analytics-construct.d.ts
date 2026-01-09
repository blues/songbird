/**
 * Analytics Construct
 *
 * Provides Text-to-SQL analytics powered by AWS Bedrock (Claude) and Aurora Serverless v2.
 * Includes real-time DynamoDB → Aurora sync via streams.
 */
import * as rds from 'aws-cdk-lib/aws-rds';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
export interface AnalyticsConstructProps {
    devicesTable: dynamodb.Table;
    telemetryTable: dynamodb.Table;
    locationsTable: dynamodb.Table;
    alertsTable: dynamodb.Table;
    journeysTable: dynamodb.Table;
}
export declare class AnalyticsConstruct extends Construct {
    readonly cluster: rds.DatabaseCluster;
    readonly chatHistoryTable: dynamodb.Table;
    readonly chatQueryLambda: lambda.Function;
    readonly chatHistoryLambda: lambda.Function;
    constructor(scope: Construct, id: string, props: AnalyticsConstructProps);
}
