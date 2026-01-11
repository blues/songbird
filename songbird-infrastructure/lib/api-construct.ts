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

export class ApiConstruct extends Construct {
  public readonly api: apigateway.HttpApi;
  public readonly apiUrl: string;
  public readonly ingestUrl: string;
  private readonly authorizer: apigatewayAuthorizers.HttpUserPoolAuthorizer;

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

    // GSI for querying commands by creation time
    commandsTable.addGlobalSecondaryIndex({
      indexName: 'device-created-index',
      partitionKey: { name: 'device_uid', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
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
        DEVICE_ALIASES_TABLE: props.deviceAliasesTable.tableName,
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });
    props.devicesTable.grantReadWriteData(devicesFunction);
    props.deviceAliasesTable.grantReadData(devicesFunction);

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
        DEVICE_ALIASES_TABLE: props.deviceAliasesTable.tableName,
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });
    props.telemetryTable.grantReadData(telemetryFunction);
    props.deviceAliasesTable.grantReadData(telemetryFunction);

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
        NOTEHUB_SECRET_ARN: notehubSecret.secretArn,
        DEVICE_ALIASES_TABLE: props.deviceAliasesTable.tableName,
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });
    commandsTable.grantReadWriteData(commandsFunction);
    notehubSecret.grantRead(commandsFunction);
    props.deviceAliasesTable.grantReadData(commandsFunction);

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
        NOTEHUB_SECRET_ARN: notehubSecret.secretArn,
        DEVICE_ALIASES_TABLE: props.deviceAliasesTable.tableName,
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });
    notehubSecret.grantRead(configFunction);
    props.deviceAliasesTable.grantReadData(configFunction);

    // Alerts API
    const alertsFunction = new NodejsFunction(this, 'AlertsFunction', {
      functionName: 'songbird-api-alerts',
      description: 'Songbird Alerts API',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/api-alerts/index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ALERTS_TABLE: props.alertsTable.tableName,
        DEVICE_ALIASES_TABLE: props.deviceAliasesTable.tableName,
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });
    props.alertsTable.grantReadWriteData(alertsFunction);
    props.deviceAliasesTable.grantReadData(alertsFunction);

    // Activity Feed API
    const activityFunction = new NodejsFunction(this, 'ActivityFunction', {
      functionName: 'songbird-api-activity',
      description: 'Songbird Activity Feed API',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/api-activity/index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        TELEMETRY_TABLE: props.telemetryTable.tableName,
        ALERTS_TABLE: props.alertsTable.tableName,
        DEVICES_TABLE: props.devicesTable.tableName,
        COMMANDS_TABLE: commandsTable.tableName,
        JOURNEYS_TABLE: props.journeysTable.tableName,
        DEVICE_ALIASES_TABLE: props.deviceAliasesTable.tableName,
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });
    props.telemetryTable.grantReadData(activityFunction);
    props.alertsTable.grantReadData(activityFunction);
    props.devicesTable.grantReadData(activityFunction);
    commandsTable.grantReadData(activityFunction);
    props.journeysTable.grantReadData(activityFunction);
    props.deviceAliasesTable.grantReadData(activityFunction);

    // Settings API
    const settingsFunction = new NodejsFunction(this, 'SettingsFunction', {
      functionName: 'songbird-api-settings',
      description: 'Songbird Settings API',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/api-settings/index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        SETTINGS_TABLE: props.settingsTable.tableName,
        NOTEHUB_PROJECT_UID: props.notehubProjectUid,
        NOTEHUB_SECRET_ARN: notehubSecret.secretArn,
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });
    props.settingsTable.grantReadWriteData(settingsFunction);
    notehubSecret.grantRead(settingsFunction);

    // Users API (Admin operations)
    const usersFunction = new NodejsFunction(this, 'UsersFunction', {
      functionName: 'songbird-api-users',
      description: 'Songbird Users API',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/api-users/index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        USER_POOL_ID: props.userPool.userPoolId,
        DEVICES_TABLE: props.devicesTable.tableName,
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });
    props.devicesTable.grantReadWriteData(usersFunction);
    // Grant Cognito admin permissions
    usersFunction.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      effect: cdk.aws_iam.Effect.ALLOW,
      actions: [
        'cognito-idp:ListUsers',
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminUpdateUserAttributes',
        'cognito-idp:AdminAddUserToGroup',
        'cognito-idp:AdminRemoveUserFromGroup',
        'cognito-idp:AdminListGroupsForUser',
        'cognito-idp:AdminDeleteUser',
        'cognito-idp:ListGroups',
      ],
      resources: [props.userPool.userPoolArn],
    }));

    // Notehub Status API
    const notehubFunction = new NodejsFunction(this, 'NotehubFunction', {
      functionName: 'songbird-api-notehub',
      description: 'Songbird Notehub Status API',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/api-notehub/index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        NOTEHUB_PROJECT_UID: props.notehubProjectUid,
        NOTEHUB_SECRET_ARN: notehubSecret.secretArn,
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });
    notehubSecret.grantRead(notehubFunction);

    // Firmware API (Admin only - for host firmware management)
    const firmwareFunction = new NodejsFunction(this, 'FirmwareFunction', {
      functionName: 'songbird-api-firmware',
      description: 'Songbird Firmware Management API',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/api-firmware/index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        NOTEHUB_PROJECT_UID: props.notehubProjectUid,
        NOTEHUB_SECRET_ARN: notehubSecret.secretArn,
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });
    notehubSecret.grantRead(firmwareFunction);

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
        COMMANDS_TABLE: commandsTable.tableName,
        ALERTS_TABLE: props.alertsTable.tableName,
        ALERT_TOPIC_ARN: props.alertTopic.topicArn,
        JOURNEYS_TABLE: props.journeysTable.tableName,
        LOCATIONS_TABLE: props.locationsTable.tableName,
        DEVICE_ALIASES_TABLE: props.deviceAliasesTable.tableName,
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });
    props.telemetryTable.grantReadWriteData(ingestFunction);
    props.devicesTable.grantReadWriteData(ingestFunction);
    commandsTable.grantReadWriteData(ingestFunction);
    props.alertsTable.grantReadWriteData(ingestFunction);
    props.alertTopic.grantPublish(ingestFunction);
    props.journeysTable.grantReadWriteData(ingestFunction);
    props.locationsTable.grantReadWriteData(ingestFunction);
    props.deviceAliasesTable.grantReadWriteData(ingestFunction);

    // Mapbox API Token Secret (for map matching)
    const mapboxSecret = new secretsmanager.Secret(this, 'MapboxApiToken', {
      secretName: 'songbird/mapbox-api-token',
      description: 'Mapbox API token for Songbird map matching',
    });

    // Journeys API (with map matching support)
    const journeysFunction = new NodejsFunction(this, 'JourneysFunction', {
      functionName: 'songbird-api-journeys',
      description: 'Songbird Journeys API',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/api-journeys/index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        JOURNEYS_TABLE: props.journeysTable.tableName,
        LOCATIONS_TABLE: props.locationsTable.tableName,
        DEVICES_TABLE: props.devicesTable.tableName,
        TELEMETRY_TABLE: props.telemetryTable.tableName,
        DEVICE_ALIASES_TABLE: props.deviceAliasesTable.tableName,
        MAPBOX_TOKEN: 'pk.eyJ1IjoiYnJhbmRvbnNhdHJvbSIsImEiOiJjbWphb2oyaW8wN2k3M3Bwd3lrdnpjOHhtIn0.Syc0GM_ia3Dz7HreQ6-ImQ',
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });
    props.journeysTable.grantReadWriteData(journeysFunction); // Need write for matched_route and delete
    props.locationsTable.grantReadWriteData(journeysFunction); // Need write for cascade delete
    props.devicesTable.grantReadData(journeysFunction); // Need read for owner check
    props.telemetryTable.grantReadData(journeysFunction); // Need read for power consumption
    props.deviceAliasesTable.grantReadData(journeysFunction);

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
    this.authorizer = new apigatewayAuthorizers.HttpUserPoolAuthorizer(
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
      authorizer: this.authorizer,
    });

    this.api.addRoutes({
      path: '/v1/devices/{serial_number}',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.PATCH],
      integration: devicesIntegration,
      authorizer: this.authorizer,
    });

    // Device merge endpoint (Admin only)
    this.api.addRoutes({
      path: '/v1/devices/merge',
      methods: [apigateway.HttpMethod.POST],
      integration: devicesIntegration,
      authorizer: this.authorizer,
    });

    // Telemetry endpoints
    const telemetryIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'TelemetryIntegration',
      telemetryFunction
    );

    this.api.addRoutes({
      path: '/v1/devices/{serial_number}/telemetry',
      methods: [apigateway.HttpMethod.GET],
      integration: telemetryIntegration,
      authorizer: this.authorizer,
    });

    this.api.addRoutes({
      path: '/v1/devices/{serial_number}/location',
      methods: [apigateway.HttpMethod.GET],
      integration: telemetryIntegration,
      authorizer: this.authorizer,
    });

    this.api.addRoutes({
      path: '/v1/devices/{serial_number}/power',
      methods: [apigateway.HttpMethod.GET],
      integration: telemetryIntegration,
      authorizer: this.authorizer,
    });

    this.api.addRoutes({
      path: '/v1/devices/{serial_number}/health',
      methods: [apigateway.HttpMethod.GET],
      integration: telemetryIntegration,
      authorizer: this.authorizer,
    });

    // Commands endpoints
    const commandsIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'CommandsIntegration',
      commandsFunction
    );

    // All commands endpoint (fleet-wide)
    this.api.addRoutes({
      path: '/v1/commands',
      methods: [apigateway.HttpMethod.GET],
      integration: commandsIntegration,
      authorizer: this.authorizer,
    });

    // Delete command endpoint
    this.api.addRoutes({
      path: '/v1/commands/{command_id}',
      methods: [apigateway.HttpMethod.DELETE],
      integration: commandsIntegration,
      authorizer: this.authorizer,
    });

    // Device-specific commands
    this.api.addRoutes({
      path: '/v1/devices/{serial_number}/commands',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.POST],
      integration: commandsIntegration,
      authorizer: this.authorizer,
    });

    // Config endpoints
    const configIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'ConfigIntegration',
      configFunction
    );

    this.api.addRoutes({
      path: '/v1/devices/{serial_number}/config',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.PUT],
      integration: configIntegration,
      authorizer: this.authorizer,
    });

    this.api.addRoutes({
      path: '/v1/fleets/{fleet_uid}/config',
      methods: [apigateway.HttpMethod.PUT],
      integration: configIntegration,
      authorizer: this.authorizer,
    });

    // Alerts endpoints
    const alertsIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'AlertsIntegration',
      alertsFunction
    );

    this.api.addRoutes({
      path: '/v1/alerts',
      methods: [apigateway.HttpMethod.GET],
      integration: alertsIntegration,
      authorizer: this.authorizer,
    });

    this.api.addRoutes({
      path: '/v1/alerts/{alert_id}',
      methods: [apigateway.HttpMethod.GET],
      integration: alertsIntegration,
      authorizer: this.authorizer,
    });

    this.api.addRoutes({
      path: '/v1/alerts/{alert_id}/acknowledge',
      methods: [apigateway.HttpMethod.POST],
      integration: alertsIntegration,
      authorizer: this.authorizer,
    });

    // Activity feed endpoint
    const activityIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'ActivityIntegration',
      activityFunction
    );

    this.api.addRoutes({
      path: '/v1/activity',
      methods: [apigateway.HttpMethod.GET],
      integration: activityIntegration,
      authorizer: this.authorizer,
    });

    // Settings endpoints
    const settingsIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'SettingsIntegration',
      settingsFunction
    );

    this.api.addRoutes({
      path: '/v1/settings/fleet-defaults',
      methods: [apigateway.HttpMethod.GET],
      integration: settingsIntegration,
      authorizer: this.authorizer,
    });

    this.api.addRoutes({
      path: '/v1/settings/fleet-defaults/{fleet}',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.PUT],
      integration: settingsIntegration,
      authorizer: this.authorizer,
    });

    // Users endpoints (admin only - enforced in Lambda)
    const usersIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'UsersIntegration',
      usersFunction
    );

    this.api.addRoutes({
      path: '/v1/users',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.POST],
      integration: usersIntegration,
      authorizer: this.authorizer,
    });

    this.api.addRoutes({
      path: '/v1/users/groups',
      methods: [apigateway.HttpMethod.GET],
      integration: usersIntegration,
      authorizer: this.authorizer,
    });

    this.api.addRoutes({
      path: '/v1/users/{userId}',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.DELETE],
      integration: usersIntegration,
      authorizer: this.authorizer,
    });

    this.api.addRoutes({
      path: '/v1/users/{userId}/groups',
      methods: [apigateway.HttpMethod.PUT],
      integration: usersIntegration,
      authorizer: this.authorizer,
    });

    this.api.addRoutes({
      path: '/v1/users/{userId}/devices',
      methods: [apigateway.HttpMethod.PUT],
      integration: usersIntegration,
      authorizer: this.authorizer,
    });

    // Single device assignment (each user can only have one device)
    this.api.addRoutes({
      path: '/v1/users/{userId}/device',
      methods: [apigateway.HttpMethod.PUT],
      integration: usersIntegration,
      authorizer: this.authorizer,
    });

    // Unassigned devices endpoint (for device assignment dropdown)
    this.api.addRoutes({
      path: '/v1/devices/unassigned',
      methods: [apigateway.HttpMethod.GET],
      integration: usersIntegration,
      authorizer: this.authorizer,
    });

    // Notehub status endpoints
    const notehubIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'NotehubIntegration',
      notehubFunction
    );

    this.api.addRoutes({
      path: '/v1/notehub/status',
      methods: [apigateway.HttpMethod.GET],
      integration: notehubIntegration,
      authorizer: this.authorizer,
    });

    this.api.addRoutes({
      path: '/v1/notehub/fleets',
      methods: [apigateway.HttpMethod.GET],
      integration: notehubIntegration,
      authorizer: this.authorizer,
    });

    // Firmware endpoints (admin only - enforced in Lambda)
    const firmwareIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'FirmwareIntegration',
      firmwareFunction
    );

    this.api.addRoutes({
      path: '/v1/firmware',
      methods: [apigateway.HttpMethod.GET],
      integration: firmwareIntegration,
      authorizer: this.authorizer,
    });

    this.api.addRoutes({
      path: '/v1/firmware/status',
      methods: [apigateway.HttpMethod.GET],
      integration: firmwareIntegration,
      authorizer: this.authorizer,
    });

    this.api.addRoutes({
      path: '/v1/firmware/update',
      methods: [apigateway.HttpMethod.POST],
      integration: firmwareIntegration,
      authorizer: this.authorizer,
    });

    this.api.addRoutes({
      path: '/v1/firmware/cancel',
      methods: [apigateway.HttpMethod.POST],
      integration: firmwareIntegration,
      authorizer: this.authorizer,
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

    // ==========================================================================
    // Public Device API (no auth - for shareable device links)
    // ==========================================================================
    const publicDeviceFunction = new NodejsFunction(this, 'PublicDeviceFunction', {
      functionName: 'songbird-api-public-device',
      description: 'Songbird Public Device API (unauthenticated)',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/api-public-device/index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        DEVICES_TABLE: props.devicesTable.tableName,
        TELEMETRY_TABLE: props.telemetryTable.tableName,
        DEVICE_ALIASES_TABLE: props.deviceAliasesTable.tableName,
        AUDIT_TABLE: props.auditTable.tableName,
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });
    props.devicesTable.grantReadData(publicDeviceFunction);
    props.telemetryTable.grantReadData(publicDeviceFunction);
    props.deviceAliasesTable.grantReadData(publicDeviceFunction);
    props.auditTable.grantWriteData(publicDeviceFunction);

    const publicDeviceIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'PublicDeviceIntegration',
      publicDeviceFunction
    );

    this.api.addRoutes({
      path: '/v1/public/devices/{serial_number}',
      methods: [apigateway.HttpMethod.GET],
      integration: publicDeviceIntegration,
      // No authorizer - public endpoint for shareable device links
    });

    // Journeys endpoints
    const journeysIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'JourneysIntegration',
      journeysFunction
    );

    this.api.addRoutes({
      path: '/v1/devices/{serial_number}/journeys',
      methods: [apigateway.HttpMethod.GET],
      integration: journeysIntegration,
      authorizer: this.authorizer,
    });

    this.api.addRoutes({
      path: '/v1/devices/{serial_number}/journeys/{journey_id}',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.DELETE],
      integration: journeysIntegration,
      authorizer: this.authorizer,
    });

    // Map matching endpoint for journeys
    this.api.addRoutes({
      path: '/v1/devices/{serial_number}/journeys/{journey_id}/match',
      methods: [apigateway.HttpMethod.POST],
      integration: journeysIntegration,
      authorizer: this.authorizer,
    });

    this.api.addRoutes({
      path: '/v1/devices/{serial_number}/locations',
      methods: [apigateway.HttpMethod.GET],
      integration: journeysIntegration,
      authorizer: this.authorizer,
    });

    // Store API URL
    this.apiUrl = this.api.url!;
    this.ingestUrl = `${this.api.url}v1/ingest`;
  }

  /**
   * Add Analytics routes to the API
   * This method should be called from the main stack after creating the Analytics construct
   */
  public addAnalyticsRoutes(
    chatQueryLambda: lambda.Function,
    chatHistoryLambda: lambda.Function,
    listSessionsLambda?: lambda.Function,
    getSessionLambda?: lambda.Function,
    deleteSessionLambda?: lambda.Function,
    rerunQueryLambda?: lambda.Function
  ) {
    const chatQueryIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'ChatQueryIntegration',
      chatQueryLambda
    );

    const chatHistoryIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'ChatHistoryIntegration',
      chatHistoryLambda
    );

    // POST /analytics/chat - Execute analytics query
    this.api.addRoutes({
      path: '/analytics/chat',
      methods: [apigateway.HttpMethod.POST],
      integration: chatQueryIntegration,
      authorizer: this.authorizer,
    });

    // GET /analytics/history - Get chat history
    this.api.addRoutes({
      path: '/analytics/history',
      methods: [apigateway.HttpMethod.GET],
      integration: chatHistoryIntegration,
      authorizer: this.authorizer,
    });

    // Session management routes
    if (listSessionsLambda) {
      const listSessionsIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
        'ListSessionsIntegration',
        listSessionsLambda
      );

      // GET /analytics/sessions - List all sessions
      this.api.addRoutes({
        path: '/analytics/sessions',
        methods: [apigateway.HttpMethod.GET],
        integration: listSessionsIntegration,
        authorizer: this.authorizer,
      });
    }

    if (getSessionLambda) {
      const getSessionIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
        'GetSessionIntegration',
        getSessionLambda
      );

      // GET /analytics/sessions/{sessionId} - Get session details
      this.api.addRoutes({
        path: '/analytics/sessions/{sessionId}',
        methods: [apigateway.HttpMethod.GET],
        integration: getSessionIntegration,
        authorizer: this.authorizer,
      });
    }

    if (deleteSessionLambda) {
      const deleteSessionIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
        'DeleteSessionIntegration',
        deleteSessionLambda
      );

      // DELETE /analytics/sessions/{sessionId} - Delete session
      this.api.addRoutes({
        path: '/analytics/sessions/{sessionId}',
        methods: [apigateway.HttpMethod.DELETE],
        integration: deleteSessionIntegration,
        authorizer: this.authorizer,
      });
    }

    if (rerunQueryLambda) {
      const rerunQueryIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
        'RerunQueryIntegration',
        rerunQueryLambda
      );

      // POST /analytics/rerun - Re-execute stored SQL query for visualization
      this.api.addRoutes({
        path: '/analytics/rerun',
        methods: [apigateway.HttpMethod.POST],
        integration: rerunQueryIntegration,
        authorizer: this.authorizer,
      });
    }
  }
}
