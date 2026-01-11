/**
 * API Construct
 *
 * Defines API Gateway HTTP API and Lambda integrations for:
 * - Device management
 * - Telemetry queries
 * - Configuration management
 * - Command sending
 */
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
export interface ApiConstructProps {
    telemetryTable: dynamodb.Table;
    devicesTable: dynamodb.Table;
    alertsTable: dynamodb.Table;
    settingsTable: dynamodb.Table;
    journeysTable: dynamodb.Table;
    locationsTable: dynamodb.Table;
    deviceAliasesTable: dynamodb.Table;
    auditTable: dynamodb.Table;
    userPool: cognito.UserPool;
    userPoolClient: cognito.UserPoolClient;
    notehubProjectUid: string;
    alertTopic: sns.ITopic;
}
export declare class ApiConstruct extends Construct {
    readonly api: apigateway.HttpApi;
    readonly apiUrl: string;
    readonly ingestUrl: string;
    private readonly authorizer;
    constructor(scope: Construct, id: string, props: ApiConstructProps);
    /**
     * Add Analytics routes to the API
     * This method should be called from the main stack after creating the Analytics construct
     */
    addAnalyticsRoutes(chatQueryLambda: lambda.Function, chatHistoryLambda: lambda.Function, listSessionsLambda?: lambda.Function, getSessionLambda?: lambda.Function, deleteSessionLambda?: lambda.Function, rerunQueryLambda?: lambda.Function): void;
}
