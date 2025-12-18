/**
 * API Construct
 *
 * Defines API Gateway HTTP API and Lambda integrations for:
 * - Device management
 * - Telemetry queries
 * - Configuration management
 * - Command sending
 */

import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayIntegrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigatewayAuthorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface ApiConstructProps {
  telemetryTable: dynamodb.Table;
  devicesTable: dynamodb.Table;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  notehubProjectUid: string;
  alertTopic: sns.ITopic;
}

export class ApiConstruct extends Construct {
  public readonly api: apigateway.HttpApi;
  public readonly apiUrl: string;
  public readonly ingestUrl: string;

  constructor(scope: Construct, id: string, props: ApiConstructProps) {
    super(scope, id);

    // ==========================================================================
    // Commands Table (for command history)
    // ==========================================================================
    const commandsTable = new dynamodb.Table(this, 'CommandsTable', {
      tableName: 'songbird-commands',
      partitionKey: { name: 'device_uid', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'command_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    // ==========================================================================
    // Notehub API Token Secret
    // ==========================================================================
    // Note: This secret should be created manually with the actual token
    const notehubSecret = new secretsmanager.Secret(this, 'NotehubApiToken', {
      secretName: 'songbird/notehub-api-token',
      description: 'Notehub API token for Songbird',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ placeholder: 'REPLACE_WITH_ACTUAL_TOKEN' }),
        generateStringKey: 'token',
      },
    });

    // ==========================================================================
    // Lambda Functions
    // ==========================================================================

    // Devices API
    const devicesFunction = new NodejsFunction(this, 'DevicesFunction', {
      functionName: 'songbird-api-devices',
      description: 'Songbird Devices API',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/api-devices/index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        DEVICES_TABLE: props.devicesTable.tableName,
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });
    props.devicesTable.grantReadWriteData(devicesFunction);

    // Telemetry API
    const telemetryFunction = new NodejsFunction(this, 'TelemetryFunction', {
      functionName: 'songbird-api-telemetry',
      description: 'Songbird Telemetry API',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/api-telemetry/index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        TELEMETRY_TABLE: props.telemetryTable.tableName,
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });
    props.telemetryTable.grantReadData(telemetryFunction);

    // Commands API
    const commandsFunction = new NodejsFunction(this, 'CommandsFunction', {
      functionName: 'songbird-api-commands',
      description: 'Songbird Commands API',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/api-commands/index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        COMMANDS_TABLE: commandsTable.tableName,
        NOTEHUB_PROJECT_UID: props.notehubProjectUid,
        NOTEHUB_API_TOKEN: notehubSecret.secretValueFromJson('token').unsafeUnwrap(),
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });
    commandsTable.grantReadWriteData(commandsFunction);

    // Config API
    const configFunction = new NodejsFunction(this, 'ConfigFunction', {
      functionName: 'songbird-api-config',
      description: 'Songbird Config API',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/api-config/index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        NOTEHUB_PROJECT_UID: props.notehubProjectUid,
        NOTEHUB_API_TOKEN: notehubSecret.secretValueFromJson('token').unsafeUnwrap(),
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });

    // Event Ingest API (for Notehub HTTP route - no authentication)
    const ingestFunction = new NodejsFunction(this, 'IngestFunction', {
      functionName: 'songbird-api-ingest',
      description: 'Songbird Event Ingest API for Notehub HTTP routes',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/api-ingest/index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        TELEMETRY_TABLE: props.telemetryTable.tableName,
        DEVICES_TABLE: props.devicesTable.tableName,
        ALERT_TOPIC_ARN: props.alertTopic.topicArn,
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });
    props.telemetryTable.grantReadWriteData(ingestFunction);
    props.devicesTable.grantReadWriteData(ingestFunction);
    props.alertTopic.grantPublish(ingestFunction);

    // ==========================================================================
    // HTTP API Gateway
    // ==========================================================================
    this.api = new apigateway.HttpApi(this, 'Api', {
      apiName: 'songbird-api',
      description: 'Songbird Demo Platform API',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigateway.CorsHttpMethod.GET,
          apigateway.CorsHttpMethod.POST,
          apigateway.CorsHttpMethod.PUT,
          apigateway.CorsHttpMethod.PATCH,
          apigateway.CorsHttpMethod.DELETE,
          apigateway.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Content-Type', 'Authorization'],
        maxAge: cdk.Duration.days(1),
      },
    });

    // Cognito JWT Authorizer
    const authorizer = new apigatewayAuthorizers.HttpUserPoolAuthorizer(
      'CognitoAuthorizer',
      props.userPool,
      {
        userPoolClients: [props.userPoolClient],
        identitySource: ['$request.header.Authorization'],
      }
    );

    // ==========================================================================
    // API Routes
    // ==========================================================================

    // Devices endpoints
    const devicesIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'DevicesIntegration',
      devicesFunction
    );

    this.api.addRoutes({
      path: '/v1/devices',
      methods: [apigateway.HttpMethod.GET],
      integration: devicesIntegration,
      authorizer,
    });

    this.api.addRoutes({
      path: '/v1/devices/{device_uid}',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.PATCH],
      integration: devicesIntegration,
      authorizer,
    });

    // Telemetry endpoints
    const telemetryIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'TelemetryIntegration',
      telemetryFunction
    );

    this.api.addRoutes({
      path: '/v1/devices/{device_uid}/telemetry',
      methods: [apigateway.HttpMethod.GET],
      integration: telemetryIntegration,
      authorizer,
    });

    this.api.addRoutes({
      path: '/v1/devices/{device_uid}/location',
      methods: [apigateway.HttpMethod.GET],
      integration: telemetryIntegration,
      authorizer,
    });

    this.api.addRoutes({
      path: '/v1/devices/{device_uid}/power',
      methods: [apigateway.HttpMethod.GET],
      integration: telemetryIntegration,
      authorizer,
    });

    // Commands endpoints
    const commandsIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'CommandsIntegration',
      commandsFunction
    );

    this.api.addRoutes({
      path: '/v1/devices/{device_uid}/commands',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.POST],
      integration: commandsIntegration,
      authorizer,
    });

    // Config endpoints
    const configIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'ConfigIntegration',
      configFunction
    );

    this.api.addRoutes({
      path: '/v1/devices/{device_uid}/config',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.PUT],
      integration: configIntegration,
      authorizer,
    });

    this.api.addRoutes({
      path: '/v1/fleets/{fleet_uid}/config',
      methods: [apigateway.HttpMethod.PUT],
      integration: configIntegration,
      authorizer,
    });

    // Event ingest endpoint (no auth - called by Notehub)
    const ingestIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'IngestIntegration',
      ingestFunction
    );

    this.api.addRoutes({
      path: '/v1/ingest',
      methods: [apigateway.HttpMethod.POST],
      integration: ingestIntegration,
      // No authorizer - Notehub HTTP routes don't support Cognito auth
    });

    // Store API URL
    this.apiUrl = this.api.url!;
    this.ingestUrl = `${this.api.url}v1/ingest`;
  }
}
