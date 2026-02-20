/**
 * Analytics Construct
 *
 * Provides Text-to-SQL analytics powered by AWS Bedrock (Claude) and Aurora Serverless v2.
 * Includes real-time DynamoDB → Aurora sync via streams.
 */
import * as ec2 from 'aws-cdk-lib/aws-ec2';
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
    readonly listSessionsLambda: lambda.Function;
    readonly getSessionLambda: lambda.Function;
    readonly deleteSessionLambda: lambda.Function;
    readonly rerunQueryLambda: lambda.Function;
    readonly vpc: ec2.Vpc;
    private syncLambda?;
    constructor(scope: Construct, id: string, props: AnalyticsConstructProps);
    /**
     * Configure Phoenix OTLP endpoint for tracing
     */
    configurePhoenixTracing(httpEndpoint: string): void;
    /**
     * Configure Phoenix Prompt Hub for runtime prompt fetching.
     * Sets PHOENIX_HOST (used by @arizeai/phoenix-client SDK) and PHOENIX_PROMPT_TAG.
     */
    configurePhoenixPrompts(phoenixEndpoint: string, promptTag?: string): void;
}
