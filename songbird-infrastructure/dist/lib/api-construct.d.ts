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
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
export interface ApiConstructProps {
    telemetryTable: dynamodb.Table;
    devicesTable: dynamodb.Table;
    userPool: cognito.UserPool;
    userPoolClient: cognito.UserPoolClient;
    notehubProjectUid: string;
    alertTopic: sns.ITopic;
}
export declare class ApiConstruct extends Construct {
    readonly api: apigateway.HttpApi;
    readonly apiUrl: string;
    readonly ingestUrl: string;
    constructor(scope: Construct, id: string, props: ApiConstructProps);
}
