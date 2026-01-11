"use strict";
/**
 * API Construct
 *
 * Defines API Gateway HTTP API and Lambda integrations for:
 * - Device management
 * - Telemetry queries
 * - Configuration management
 * - Command sending
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiConstruct = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const apigateway = __importStar(require("aws-cdk-lib/aws-apigatewayv2"));
const apigatewayIntegrations = __importStar(require("aws-cdk-lib/aws-apigatewayv2-integrations"));
const apigatewayAuthorizers = __importStar(require("aws-cdk-lib/aws-apigatewayv2-authorizers"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const secretsmanager = __importStar(require("aws-cdk-lib/aws-secretsmanager"));
const aws_lambda_nodejs_1 = require("aws-cdk-lib/aws-lambda-nodejs");
const constructs_1 = require("constructs");
const path = __importStar(require("path"));
class ApiConstruct extends constructs_1.Construct {
    api;
    apiUrl;
    ingestUrl;
    authorizer;
    constructor(scope, id, props) {
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
        const devicesFunction = new aws_lambda_nodejs_1.NodejsFunction(this, 'DevicesFunction', {
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
        const telemetryFunction = new aws_lambda_nodejs_1.NodejsFunction(this, 'TelemetryFunction', {
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
        const commandsFunction = new aws_lambda_nodejs_1.NodejsFunction(this, 'CommandsFunction', {
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
        const configFunction = new aws_lambda_nodejs_1.NodejsFunction(this, 'ConfigFunction', {
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
        const alertsFunction = new aws_lambda_nodejs_1.NodejsFunction(this, 'AlertsFunction', {
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
        const activityFunction = new aws_lambda_nodejs_1.NodejsFunction(this, 'ActivityFunction', {
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
        const settingsFunction = new aws_lambda_nodejs_1.NodejsFunction(this, 'SettingsFunction', {
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
        const usersFunction = new aws_lambda_nodejs_1.NodejsFunction(this, 'UsersFunction', {
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
        const notehubFunction = new aws_lambda_nodejs_1.NodejsFunction(this, 'NotehubFunction', {
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
        const firmwareFunction = new aws_lambda_nodejs_1.NodejsFunction(this, 'FirmwareFunction', {
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
        const ingestFunction = new aws_lambda_nodejs_1.NodejsFunction(this, 'IngestFunction', {
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
        const journeysFunction = new aws_lambda_nodejs_1.NodejsFunction(this, 'JourneysFunction', {
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
        this.authorizer = new apigatewayAuthorizers.HttpUserPoolAuthorizer('CognitoAuthorizer', props.userPool, {
            userPoolClients: [props.userPoolClient],
            identitySource: ['$request.header.Authorization'],
        });
        // ==========================================================================
        // API Routes
        // ==========================================================================
        // Devices endpoints
        const devicesIntegration = new apigatewayIntegrations.HttpLambdaIntegration('DevicesIntegration', devicesFunction);
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
        const telemetryIntegration = new apigatewayIntegrations.HttpLambdaIntegration('TelemetryIntegration', telemetryFunction);
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
        const commandsIntegration = new apigatewayIntegrations.HttpLambdaIntegration('CommandsIntegration', commandsFunction);
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
        const configIntegration = new apigatewayIntegrations.HttpLambdaIntegration('ConfigIntegration', configFunction);
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
        const alertsIntegration = new apigatewayIntegrations.HttpLambdaIntegration('AlertsIntegration', alertsFunction);
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
        const activityIntegration = new apigatewayIntegrations.HttpLambdaIntegration('ActivityIntegration', activityFunction);
        this.api.addRoutes({
            path: '/v1/activity',
            methods: [apigateway.HttpMethod.GET],
            integration: activityIntegration,
            authorizer: this.authorizer,
        });
        // Settings endpoints
        const settingsIntegration = new apigatewayIntegrations.HttpLambdaIntegration('SettingsIntegration', settingsFunction);
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
        const usersIntegration = new apigatewayIntegrations.HttpLambdaIntegration('UsersIntegration', usersFunction);
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
        const notehubIntegration = new apigatewayIntegrations.HttpLambdaIntegration('NotehubIntegration', notehubFunction);
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
        const firmwareIntegration = new apigatewayIntegrations.HttpLambdaIntegration('FirmwareIntegration', firmwareFunction);
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
        const ingestIntegration = new apigatewayIntegrations.HttpLambdaIntegration('IngestIntegration', ingestFunction);
        this.api.addRoutes({
            path: '/v1/ingest',
            methods: [apigateway.HttpMethod.POST],
            integration: ingestIntegration,
            // No authorizer - Notehub HTTP routes don't support Cognito auth
        });
        // ==========================================================================
        // Public Device API (no auth - for shareable device links)
        // ==========================================================================
        const publicDeviceFunction = new aws_lambda_nodejs_1.NodejsFunction(this, 'PublicDeviceFunction', {
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
        const publicDeviceIntegration = new apigatewayIntegrations.HttpLambdaIntegration('PublicDeviceIntegration', publicDeviceFunction);
        this.api.addRoutes({
            path: '/v1/public/devices/{serial_number}',
            methods: [apigateway.HttpMethod.GET],
            integration: publicDeviceIntegration,
            // No authorizer - public endpoint for shareable device links
        });
        // Journeys endpoints
        const journeysIntegration = new apigatewayIntegrations.HttpLambdaIntegration('JourneysIntegration', journeysFunction);
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
        this.apiUrl = this.api.url;
        this.ingestUrl = `${this.api.url}v1/ingest`;
    }
    /**
     * Add Analytics routes to the API
     * This method should be called from the main stack after creating the Analytics construct
     */
    addAnalyticsRoutes(chatQueryLambda, chatHistoryLambda, listSessionsLambda, getSessionLambda, deleteSessionLambda, rerunQueryLambda) {
        const chatQueryIntegration = new apigatewayIntegrations.HttpLambdaIntegration('ChatQueryIntegration', chatQueryLambda);
        const chatHistoryIntegration = new apigatewayIntegrations.HttpLambdaIntegration('ChatHistoryIntegration', chatHistoryLambda);
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
            const listSessionsIntegration = new apigatewayIntegrations.HttpLambdaIntegration('ListSessionsIntegration', listSessionsLambda);
            // GET /analytics/sessions - List all sessions
            this.api.addRoutes({
                path: '/analytics/sessions',
                methods: [apigateway.HttpMethod.GET],
                integration: listSessionsIntegration,
                authorizer: this.authorizer,
            });
        }
        if (getSessionLambda) {
            const getSessionIntegration = new apigatewayIntegrations.HttpLambdaIntegration('GetSessionIntegration', getSessionLambda);
            // GET /analytics/sessions/{sessionId} - Get session details
            this.api.addRoutes({
                path: '/analytics/sessions/{sessionId}',
                methods: [apigateway.HttpMethod.GET],
                integration: getSessionIntegration,
                authorizer: this.authorizer,
            });
        }
        if (deleteSessionLambda) {
            const deleteSessionIntegration = new apigatewayIntegrations.HttpLambdaIntegration('DeleteSessionIntegration', deleteSessionLambda);
            // DELETE /analytics/sessions/{sessionId} - Delete session
            this.api.addRoutes({
                path: '/analytics/sessions/{sessionId}',
                methods: [apigateway.HttpMethod.DELETE],
                integration: deleteSessionIntegration,
                authorizer: this.authorizer,
            });
        }
        if (rerunQueryLambda) {
            const rerunQueryIntegration = new apigatewayIntegrations.HttpLambdaIntegration('RerunQueryIntegration', rerunQueryLambda);
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
exports.ApiConstruct = ApiConstruct;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBpLWNvbnN0cnVjdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL2xpYi9hcGktY29uc3RydWN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7R0FRRzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFFSCxpREFBbUM7QUFDbkMseUVBQTJEO0FBQzNELGtHQUFvRjtBQUNwRixnR0FBa0Y7QUFDbEYsK0RBQWlEO0FBR2pELG1FQUFxRDtBQUNyRCwyREFBNkM7QUFDN0MsK0VBQWlFO0FBQ2pFLHFFQUErRDtBQUMvRCwyQ0FBdUM7QUFDdkMsMkNBQTZCO0FBaUI3QixNQUFhLFlBQWEsU0FBUSxzQkFBUztJQUN6QixHQUFHLENBQXFCO0lBQ3hCLE1BQU0sQ0FBUztJQUNmLFNBQVMsQ0FBUztJQUNqQixVQUFVLENBQStDO0lBRTFFLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBd0I7UUFDaEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQiw2RUFBNkU7UUFDN0UsdUNBQXVDO1FBQ3ZDLDZFQUE2RTtRQUM3RSxNQUFNLGFBQWEsR0FBRyxJQUFJLFFBQVEsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLGVBQWUsRUFBRTtZQUM5RCxTQUFTLEVBQUUsbUJBQW1CO1lBQzlCLFlBQVksRUFBRSxFQUFFLElBQUksRUFBRSxZQUFZLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFO1lBQ3pFLE9BQU8sRUFBRSxFQUFFLElBQUksRUFBRSxZQUFZLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFO1lBQ3BFLFdBQVcsRUFBRSxRQUFRLENBQUMsV0FBVyxDQUFDLGVBQWU7WUFDakQsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTztZQUN4QyxtQkFBbUIsRUFBRSxLQUFLO1NBQzNCLENBQUMsQ0FBQztRQUVILDZDQUE2QztR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QUVGLHdFQUF3RTtZQUN4RSxJQUFJLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQztnQkFDakIsSUFBSSxFQUFFLGtCQUFrQjtnQkFDeEIsT0FBTyxFQUFFLENBQUMsVUFBVSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUM7Z0JBQ3JDLFdBQVcsRUFBRSxxQkFBcUI7Z0JBQ2xDLFVBQVUsRUFBRSxJQUFJLENBQUMsVUFBVTthQUM1QixDQUFDLENBQUM7UUFDTCxDQUFDO0lBQ0gsQ0FBQztDQUNGO0FBaDBCRCxvQ0FnMEJDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBBUEkgQ29uc3RydWN0XG4gKlxuICogRGVmaW5lcyBBUEkgR2F0ZXdheSBIVFRQIEFQSSBhbmQgTGFtYmRhIGludGVncmF0aW9ucyBmb3I6XG4gKiAtIERldmljZSBtYW5hZ2VtZW50XG4gKiAtIFRlbGVtZXRyeSBxdWVyaWVzXG4gKiAtIENvbmZpZ3VyYXRpb24gbWFuYWdlbWVudFxuICogLSBDb21tYW5kIHNlbmRpbmdcbiAqL1xuXG5pbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgYXBpZ2F0ZXdheSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyJztcbmltcG9ydCAqIGFzIGFwaWdhdGV3YXlJbnRlZ3JhdGlvbnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnMnO1xuaW1wb3J0ICogYXMgYXBpZ2F0ZXdheUF1dGhvcml6ZXJzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItYXV0aG9yaXplcnMnO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0ICogYXMgc25zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zbnMnO1xuaW1wb3J0ICogYXMgY29nbml0byBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY29nbml0byc7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGInO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgKiBhcyBzZWNyZXRzbWFuYWdlciBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc2VjcmV0c21hbmFnZXInO1xuaW1wb3J0IHsgTm9kZWpzRnVuY3Rpb24gfSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhLW5vZGVqcyc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBpQ29uc3RydWN0UHJvcHMge1xuICB0ZWxlbWV0cnlUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIGRldmljZXNUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIGFsZXJ0c1RhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbiAgc2V0dGluZ3NUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIGpvdXJuZXlzVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBsb2NhdGlvbnNUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIGRldmljZUFsaWFzZXNUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIGF1ZGl0VGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICB1c2VyUG9vbDogY29nbml0by5Vc2VyUG9vbDtcbiAgdXNlclBvb2xDbGllbnQ6IGNvZ25pdG8uVXNlclBvb2xDbGllbnQ7XG4gIG5vdGVodWJQcm9qZWN0VWlkOiBzdHJpbmc7XG4gIGFsZXJ0VG9waWM6IHNucy5JVG9waWM7XG59XG5cbmV4cG9ydCBjbGFzcyBBcGlDb25zdHJ1Y3QgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlnYXRld2F5Lkh0dHBBcGk7XG4gIHB1YmxpYyByZWFkb25seSBhcGlVcmw6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGluZ2VzdFVybDogc3RyaW5nO1xuICBwcml2YXRlIHJlYWRvbmx5IGF1dGhvcml6ZXI6IGFwaWdhdGV3YXlBdXRob3JpemVycy5IdHRwVXNlclBvb2xBdXRob3JpemVyO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcGlDb25zdHJ1Y3RQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIENvbW1hbmRzIFRhYmxlIChmb3IgY29tbWFuZCBoaXN0b3J5KVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgY29tbWFuZHNUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCAnQ29tbWFuZHNUYWJsZScsIHtcbiAgICAgIHRhYmxlTmFtZTogJ3NvbmdiaXJkLWNvbW1hbmRzJyxcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiAnZGV2aWNlX3VpZCcsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBzb3J0S2V5OiB7IG5hbWU6ICdjb21tYW5kX2lkJywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogJ3R0bCcsXG4gICAgfSk7XG5cbiAgICAvLyBHU0kgZm9yIHF1ZXJ5aW5nIGNvbW1hbmRzIGJ5IGNyZWF0aW9uIHRpbWVcbiAgICBjb21tYW5kc1RhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcbiAgICAgIGluZGV4TmFtZTogJ2RldmljZS1jcmVhdGVkLWluZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiAnZGV2aWNlX3VpZCcsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBzb3J0S2V5OiB7IG5hbWU6ICdjcmVhdGVkX2F0JywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5OVU1CRVIgfSxcbiAgICAgIHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE5vdGVodWIgQVBJIFRva2VuIFNlY3JldFxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTm90ZTogVGhpcyBzZWNyZXQgc2hvdWxkIGJlIGNyZWF0ZWQgbWFudWFsbHkgd2l0aCB0aGUgYWN0dWFsIHRva2VuXG4gICAgY29uc3Qgbm90ZWh1YlNlY3JldCA9IG5ldyBzZWNyZXRzbWFuYWdlci5TZWNyZXQodGhpcywgJ05vdGVodWJBcGlUb2tlbicsIHtcbiAgICAgIHNlY3JldE5hbWU6ICdzb25nYmlyZC9ub3RlaHViLWFwaS10b2tlbicsXG4gICAgICBkZXNjcmlwdGlvbjogJ05vdGVodWIgQVBJIHRva2VuIGZvciBTb25nYmlyZCcsXG4gICAgICBnZW5lcmF0ZVNlY3JldFN0cmluZzoge1xuICAgICAgICBzZWNyZXRTdHJpbmdUZW1wbGF0ZTogSlNPTi5zdHJpbmdpZnkoeyBwbGFjZWhvbGRlcjogJ1JFUExBQ0VfV0lUSF9BQ1RVQUxfVE9LRU4nIH0pLFxuICAgICAgICBnZW5lcmF0ZVN0cmluZ0tleTogJ3Rva2VuJyxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIExhbWJkYSBGdW5jdGlvbnNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgLy8gRGV2aWNlcyBBUElcbiAgICBjb25zdCBkZXZpY2VzRnVuY3Rpb24gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0RldmljZXNGdW5jdGlvbicsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFwaS1kZXZpY2VzJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgRGV2aWNlcyBBUEknLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hcGktZGV2aWNlcy9pbmRleC50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgREVWSUNFU19UQUJMRTogcHJvcHMuZGV2aWNlc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgREVWSUNFX0FMSUFTRVNfVEFCTEU6IHByb3BzLmRldmljZUFsaWFzZXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcbiAgICBwcm9wcy5kZXZpY2VzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGRldmljZXNGdW5jdGlvbik7XG4gICAgcHJvcHMuZGV2aWNlQWxpYXNlc1RhYmxlLmdyYW50UmVhZERhdGEoZGV2aWNlc0Z1bmN0aW9uKTtcblxuICAgIC8vIFRlbGVtZXRyeSBBUElcbiAgICBjb25zdCB0ZWxlbWV0cnlGdW5jdGlvbiA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnVGVsZW1ldHJ5RnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hcGktdGVsZW1ldHJ5JyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgVGVsZW1ldHJ5IEFQSScsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FwaS10ZWxlbWV0cnkvaW5kZXgudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFRFTEVNRVRSWV9UQUJMRTogcHJvcHMudGVsZW1ldHJ5VGFibGUudGFibGVOYW1lLFxuICAgICAgICBERVZJQ0VfQUxJQVNFU19UQUJMRTogcHJvcHMuZGV2aWNlQWxpYXNlc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuICAgIHByb3BzLnRlbGVtZXRyeVRhYmxlLmdyYW50UmVhZERhdGEodGVsZW1ldHJ5RnVuY3Rpb24pO1xuICAgIHByb3BzLmRldmljZUFsaWFzZXNUYWJsZS5ncmFudFJlYWREYXRhKHRlbGVtZXRyeUZ1bmN0aW9uKTtcblxuICAgIC8vIENvbW1hbmRzIEFQSVxuICAgIGNvbnN0IGNvbW1hbmRzRnVuY3Rpb24gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0NvbW1hbmRzRnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hcGktY29tbWFuZHMnLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBDb21tYW5kcyBBUEknLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hcGktY29tbWFuZHMvaW5kZXgudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIENPTU1BTkRTX1RBQkxFOiBjb21tYW5kc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgTk9URUhVQl9QUk9KRUNUX1VJRDogcHJvcHMubm90ZWh1YlByb2plY3RVaWQsXG4gICAgICAgIE5PVEVIVUJfU0VDUkVUX0FSTjogbm90ZWh1YlNlY3JldC5zZWNyZXRBcm4sXG4gICAgICAgIERFVklDRV9BTElBU0VTX1RBQkxFOiBwcm9wcy5kZXZpY2VBbGlhc2VzVGFibGUudGFibGVOYW1lLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG4gICAgY29tbWFuZHNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoY29tbWFuZHNGdW5jdGlvbik7XG4gICAgbm90ZWh1YlNlY3JldC5ncmFudFJlYWQoY29tbWFuZHNGdW5jdGlvbik7XG4gICAgcHJvcHMuZGV2aWNlQWxpYXNlc1RhYmxlLmdyYW50UmVhZERhdGEoY29tbWFuZHNGdW5jdGlvbik7XG5cbiAgICAvLyBDb25maWcgQVBJXG4gICAgY29uc3QgY29uZmlnRnVuY3Rpb24gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0NvbmZpZ0Z1bmN0aW9uJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYXBpLWNvbmZpZycsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NvbmdiaXJkIENvbmZpZyBBUEknLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hcGktY29uZmlnL2luZGV4LnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBOT1RFSFVCX1BST0pFQ1RfVUlEOiBwcm9wcy5ub3RlaHViUHJvamVjdFVpZCxcbiAgICAgICAgTk9URUhVQl9TRUNSRVRfQVJOOiBub3RlaHViU2VjcmV0LnNlY3JldEFybixcbiAgICAgICAgREVWSUNFX0FMSUFTRVNfVEFCTEU6IHByb3BzLmRldmljZUFsaWFzZXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcbiAgICBub3RlaHViU2VjcmV0LmdyYW50UmVhZChjb25maWdGdW5jdGlvbik7XG4gICAgcHJvcHMuZGV2aWNlQWxpYXNlc1RhYmxlLmdyYW50UmVhZERhdGEoY29uZmlnRnVuY3Rpb24pO1xuXG4gICAgLy8gQWxlcnRzIEFQSVxuICAgIGNvbnN0IGFsZXJ0c0Z1bmN0aW9uID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdBbGVydHNGdW5jdGlvbicsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFwaS1hbGVydHMnLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBBbGVydHMgQVBJJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYXBpLWFsZXJ0cy9pbmRleC50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQUxFUlRTX1RBQkxFOiBwcm9wcy5hbGVydHNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIERFVklDRV9BTElBU0VTX1RBQkxFOiBwcm9wcy5kZXZpY2VBbGlhc2VzVGFibGUudGFibGVOYW1lLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG4gICAgcHJvcHMuYWxlcnRzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGFsZXJ0c0Z1bmN0aW9uKTtcbiAgICBwcm9wcy5kZXZpY2VBbGlhc2VzVGFibGUuZ3JhbnRSZWFkRGF0YShhbGVydHNGdW5jdGlvbik7XG5cbiAgICAvLyBBY3Rpdml0eSBGZWVkIEFQSVxuICAgIGNvbnN0IGFjdGl2aXR5RnVuY3Rpb24gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0FjdGl2aXR5RnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hcGktYWN0aXZpdHknLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBBY3Rpdml0eSBGZWVkIEFQSScsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FwaS1hY3Rpdml0eS9pbmRleC50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgVEVMRU1FVFJZX1RBQkxFOiBwcm9wcy50ZWxlbWV0cnlUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIEFMRVJUU19UQUJMRTogcHJvcHMuYWxlcnRzVGFibGUudGFibGVOYW1lLFxuICAgICAgICBERVZJQ0VTX1RBQkxFOiBwcm9wcy5kZXZpY2VzVGFibGUudGFibGVOYW1lLFxuICAgICAgICBDT01NQU5EU19UQUJMRTogY29tbWFuZHNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIEpPVVJORVlTX1RBQkxFOiBwcm9wcy5qb3VybmV5c1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgREVWSUNFX0FMSUFTRVNfVEFCTEU6IHByb3BzLmRldmljZUFsaWFzZXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcbiAgICBwcm9wcy50ZWxlbWV0cnlUYWJsZS5ncmFudFJlYWREYXRhKGFjdGl2aXR5RnVuY3Rpb24pO1xuICAgIHByb3BzLmFsZXJ0c1RhYmxlLmdyYW50UmVhZERhdGEoYWN0aXZpdHlGdW5jdGlvbik7XG4gICAgcHJvcHMuZGV2aWNlc1RhYmxlLmdyYW50UmVhZERhdGEoYWN0aXZpdHlGdW5jdGlvbik7XG4gICAgY29tbWFuZHNUYWJsZS5ncmFudFJlYWREYXRhKGFjdGl2aXR5RnVuY3Rpb24pO1xuICAgIHByb3BzLmpvdXJuZXlzVGFibGUuZ3JhbnRSZWFkRGF0YShhY3Rpdml0eUZ1bmN0aW9uKTtcbiAgICBwcm9wcy5kZXZpY2VBbGlhc2VzVGFibGUuZ3JhbnRSZWFkRGF0YShhY3Rpdml0eUZ1bmN0aW9uKTtcblxuICAgIC8vIFNldHRpbmdzIEFQSVxuICAgIGNvbnN0IHNldHRpbmdzRnVuY3Rpb24gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ1NldHRpbmdzRnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hcGktc2V0dGluZ3MnLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBTZXR0aW5ncyBBUEknLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hcGktc2V0dGluZ3MvaW5kZXgudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFNFVFRJTkdTX1RBQkxFOiBwcm9wcy5zZXR0aW5nc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgTk9URUhVQl9QUk9KRUNUX1VJRDogcHJvcHMubm90ZWh1YlByb2plY3RVaWQsXG4gICAgICAgIE5PVEVIVUJfU0VDUkVUX0FSTjogbm90ZWh1YlNlY3JldC5zZWNyZXRBcm4sXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcbiAgICBwcm9wcy5zZXR0aW5nc1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShzZXR0aW5nc0Z1bmN0aW9uKTtcbiAgICBub3RlaHViU2VjcmV0LmdyYW50UmVhZChzZXR0aW5nc0Z1bmN0aW9uKTtcblxuICAgIC8vIFVzZXJzIEFQSSAoQWRtaW4gb3BlcmF0aW9ucylcbiAgICBjb25zdCB1c2Vyc0Z1bmN0aW9uID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdVc2Vyc0Z1bmN0aW9uJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYXBpLXVzZXJzJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgVXNlcnMgQVBJJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYXBpLXVzZXJzL2luZGV4LnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBVU0VSX1BPT0xfSUQ6IHByb3BzLnVzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICAgIERFVklDRVNfVEFCTEU6IHByb3BzLmRldmljZXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcbiAgICBwcm9wcy5kZXZpY2VzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHVzZXJzRnVuY3Rpb24pO1xuICAgIC8vIEdyYW50IENvZ25pdG8gYWRtaW4gcGVybWlzc2lvbnNcbiAgICB1c2Vyc0Z1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShuZXcgY2RrLmF3c19pYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogY2RrLmF3c19pYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnY29nbml0by1pZHA6TGlzdFVzZXJzJyxcbiAgICAgICAgJ2NvZ25pdG8taWRwOkFkbWluQ3JlYXRlVXNlcicsXG4gICAgICAgICdjb2duaXRvLWlkcDpBZG1pbkdldFVzZXInLFxuICAgICAgICAnY29nbml0by1pZHA6QWRtaW5VcGRhdGVVc2VyQXR0cmlidXRlcycsXG4gICAgICAgICdjb2duaXRvLWlkcDpBZG1pbkFkZFVzZXJUb0dyb3VwJyxcbiAgICAgICAgJ2NvZ25pdG8taWRwOkFkbWluUmVtb3ZlVXNlckZyb21Hcm91cCcsXG4gICAgICAgICdjb2duaXRvLWlkcDpBZG1pbkxpc3RHcm91cHNGb3JVc2VyJyxcbiAgICAgICAgJ2NvZ25pdG8taWRwOkFkbWluRGVsZXRlVXNlcicsXG4gICAgICAgICdjb2duaXRvLWlkcDpMaXN0R3JvdXBzJyxcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFtwcm9wcy51c2VyUG9vbC51c2VyUG9vbEFybl0sXG4gICAgfSkpO1xuXG4gICAgLy8gTm90ZWh1YiBTdGF0dXMgQVBJXG4gICAgY29uc3Qgbm90ZWh1YkZ1bmN0aW9uID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdOb3RlaHViRnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hcGktbm90ZWh1YicsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NvbmdiaXJkIE5vdGVodWIgU3RhdHVzIEFQSScsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FwaS1ub3RlaHViL2luZGV4LnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBOT1RFSFVCX1BST0pFQ1RfVUlEOiBwcm9wcy5ub3RlaHViUHJvamVjdFVpZCxcbiAgICAgICAgTk9URUhVQl9TRUNSRVRfQVJOOiBub3RlaHViU2VjcmV0LnNlY3JldEFybixcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuICAgIG5vdGVodWJTZWNyZXQuZ3JhbnRSZWFkKG5vdGVodWJGdW5jdGlvbik7XG5cbiAgICAvLyBGaXJtd2FyZSBBUEkgKEFkbWluIG9ubHkgLSBmb3IgaG9zdCBmaXJtd2FyZSBtYW5hZ2VtZW50KVxuICAgIGNvbnN0IGZpcm13YXJlRnVuY3Rpb24gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0Zpcm13YXJlRnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hcGktZmlybXdhcmUnLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBGaXJtd2FyZSBNYW5hZ2VtZW50IEFQSScsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FwaS1maXJtd2FyZS9pbmRleC50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgTk9URUhVQl9QUk9KRUNUX1VJRDogcHJvcHMubm90ZWh1YlByb2plY3RVaWQsXG4gICAgICAgIE5PVEVIVUJfU0VDUkVUX0FSTjogbm90ZWh1YlNlY3JldC5zZWNyZXRBcm4sXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcbiAgICBub3RlaHViU2VjcmV0LmdyYW50UmVhZChmaXJtd2FyZUZ1bmN0aW9uKTtcblxuICAgIC8vIEV2ZW50IEluZ2VzdCBBUEkgKGZvciBOb3RlaHViIEhUVFAgcm91dGUgLSBubyBhdXRoZW50aWNhdGlvbilcbiAgICBjb25zdCBpbmdlc3RGdW5jdGlvbiA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnSW5nZXN0RnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hcGktaW5nZXN0JyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgRXZlbnQgSW5nZXN0IEFQSSBmb3IgTm90ZWh1YiBIVFRQIHJvdXRlcycsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FwaS1pbmdlc3QvaW5kZXgudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFRFTEVNRVRSWV9UQUJMRTogcHJvcHMudGVsZW1ldHJ5VGFibGUudGFibGVOYW1lLFxuICAgICAgICBERVZJQ0VTX1RBQkxFOiBwcm9wcy5kZXZpY2VzVGFibGUudGFibGVOYW1lLFxuICAgICAgICBDT01NQU5EU19UQUJMRTogY29tbWFuZHNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIEFMRVJUU19UQUJMRTogcHJvcHMuYWxlcnRzVGFibGUudGFibGVOYW1lLFxuICAgICAgICBBTEVSVF9UT1BJQ19BUk46IHByb3BzLmFsZXJ0VG9waWMudG9waWNBcm4sXG4gICAgICAgIEpPVVJORVlTX1RBQkxFOiBwcm9wcy5qb3VybmV5c1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgTE9DQVRJT05TX1RBQkxFOiBwcm9wcy5sb2NhdGlvbnNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIERFVklDRV9BTElBU0VTX1RBQkxFOiBwcm9wcy5kZXZpY2VBbGlhc2VzVGFibGUudGFibGVOYW1lLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG4gICAgcHJvcHMudGVsZW1ldHJ5VGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGluZ2VzdEZ1bmN0aW9uKTtcbiAgICBwcm9wcy5kZXZpY2VzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGluZ2VzdEZ1bmN0aW9uKTtcbiAgICBjb21tYW5kc1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShpbmdlc3RGdW5jdGlvbik7XG4gICAgcHJvcHMuYWxlcnRzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGluZ2VzdEZ1bmN0aW9uKTtcbiAgICBwcm9wcy5hbGVydFRvcGljLmdyYW50UHVibGlzaChpbmdlc3RGdW5jdGlvbik7XG4gICAgcHJvcHMuam91cm5leXNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoaW5nZXN0RnVuY3Rpb24pO1xuICAgIHByb3BzLmxvY2F0aW9uc1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShpbmdlc3RGdW5jdGlvbik7XG4gICAgcHJvcHMuZGV2aWNlQWxpYXNlc1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShpbmdlc3RGdW5jdGlvbik7XG5cbiAgICAvLyBNYXBib3ggQVBJIFRva2VuIFNlY3JldCAoZm9yIG1hcCBtYXRjaGluZylcbiAgICBjb25zdCBtYXBib3hTZWNyZXQgPSBuZXcgc2VjcmV0c21hbmFnZXIuU2VjcmV0KHRoaXMsICdNYXBib3hBcGlUb2tlbicsIHtcbiAgICAgIHNlY3JldE5hbWU6ICdzb25nYmlyZC9tYXBib3gtYXBpLXRva2VuJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnTWFwYm94IEFQSSB0b2tlbiBmb3IgU29uZ2JpcmQgbWFwIG1hdGNoaW5nJyxcbiAgICB9KTtcblxuICAgIC8vIEpvdXJuZXlzIEFQSSAod2l0aCBtYXAgbWF0Y2hpbmcgc3VwcG9ydClcbiAgICBjb25zdCBqb3VybmV5c0Z1bmN0aW9uID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdKb3VybmV5c0Z1bmN0aW9uJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYXBpLWpvdXJuZXlzJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgSm91cm5leXMgQVBJJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYXBpLWpvdXJuZXlzL2luZGV4LnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBKT1VSTkVZU19UQUJMRTogcHJvcHMuam91cm5leXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIExPQ0FUSU9OU19UQUJMRTogcHJvcHMubG9jYXRpb25zVGFibGUudGFibGVOYW1lLFxuICAgICAgICBERVZJQ0VTX1RBQkxFOiBwcm9wcy5kZXZpY2VzVGFibGUudGFibGVOYW1lLFxuICAgICAgICBURUxFTUVUUllfVEFCTEU6IHByb3BzLnRlbGVtZXRyeVRhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgREVWSUNFX0FMSUFTRVNfVEFCTEU6IHByb3BzLmRldmljZUFsaWFzZXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIE1BUEJPWF9UT0tFTjogJ3BrLmV5SjFJam9pWW5KaGJtUnZibk5oZEhKdmJTSXNJbUVpT2lKamJXcGhiMm95YVc4d04yazNNM0J3ZDNscmRucGpPSGh0SW4wLlN5YzBHTV9pYTNEejdIcmVRNi1JbVEnLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG4gICAgcHJvcHMuam91cm5leXNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoam91cm5leXNGdW5jdGlvbik7IC8vIE5lZWQgd3JpdGUgZm9yIG1hdGNoZWRfcm91dGUgYW5kIGRlbGV0ZVxuICAgIHByb3BzLmxvY2F0aW9uc1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShqb3VybmV5c0Z1bmN0aW9uKTsgLy8gTmVlZCB3cml0ZSBmb3IgY2FzY2FkZSBkZWxldGVcbiAgICBwcm9wcy5kZXZpY2VzVGFibGUuZ3JhbnRSZWFkRGF0YShqb3VybmV5c0Z1bmN0aW9uKTsgLy8gTmVlZCByZWFkIGZvciBvd25lciBjaGVja1xuICAgIHByb3BzLnRlbGVtZXRyeVRhYmxlLmdyYW50UmVhZERhdGEoam91cm5leXNGdW5jdGlvbik7IC8vIE5lZWQgcmVhZCBmb3IgcG93ZXIgY29uc3VtcHRpb25cbiAgICBwcm9wcy5kZXZpY2VBbGlhc2VzVGFibGUuZ3JhbnRSZWFkRGF0YShqb3VybmV5c0Z1bmN0aW9uKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gSFRUUCBBUEkgR2F0ZXdheVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5hcGkgPSBuZXcgYXBpZ2F0ZXdheS5IdHRwQXBpKHRoaXMsICdBcGknLCB7XG4gICAgICBhcGlOYW1lOiAnc29uZ2JpcmQtYXBpJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgRGVtbyBQbGF0Zm9ybSBBUEknLFxuICAgICAgY29yc1ByZWZsaWdodDoge1xuICAgICAgICBhbGxvd09yaWdpbnM6IFsnKiddLFxuICAgICAgICBhbGxvd01ldGhvZHM6IFtcbiAgICAgICAgICBhcGlnYXRld2F5LkNvcnNIdHRwTWV0aG9kLkdFVCxcbiAgICAgICAgICBhcGlnYXRld2F5LkNvcnNIdHRwTWV0aG9kLlBPU1QsXG4gICAgICAgICAgYXBpZ2F0ZXdheS5Db3JzSHR0cE1ldGhvZC5QVVQsXG4gICAgICAgICAgYXBpZ2F0ZXdheS5Db3JzSHR0cE1ldGhvZC5QQVRDSCxcbiAgICAgICAgICBhcGlnYXRld2F5LkNvcnNIdHRwTWV0aG9kLkRFTEVURSxcbiAgICAgICAgICBhcGlnYXRld2F5LkNvcnNIdHRwTWV0aG9kLk9QVElPTlMsXG4gICAgICAgIF0sXG4gICAgICAgIGFsbG93SGVhZGVyczogWydDb250ZW50LVR5cGUnLCAnQXV0aG9yaXphdGlvbiddLFxuICAgICAgICBtYXhBZ2U6IGNkay5EdXJhdGlvbi5kYXlzKDEpLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIENvZ25pdG8gSldUIEF1dGhvcml6ZXJcbiAgICB0aGlzLmF1dGhvcml6ZXIgPSBuZXcgYXBpZ2F0ZXdheUF1dGhvcml6ZXJzLkh0dHBVc2VyUG9vbEF1dGhvcml6ZXIoXG4gICAgICAnQ29nbml0b0F1dGhvcml6ZXInLFxuICAgICAgcHJvcHMudXNlclBvb2wsXG4gICAgICB7XG4gICAgICAgIHVzZXJQb29sQ2xpZW50czogW3Byb3BzLnVzZXJQb29sQ2xpZW50XSxcbiAgICAgICAgaWRlbnRpdHlTb3VyY2U6IFsnJHJlcXVlc3QuaGVhZGVyLkF1dGhvcml6YXRpb24nXSxcbiAgICAgIH1cbiAgICApO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBBUEkgUm91dGVzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIERldmljZXMgZW5kcG9pbnRzXG4gICAgY29uc3QgZGV2aWNlc0ludGVncmF0aW9uID0gbmV3IGFwaWdhdGV3YXlJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFxuICAgICAgJ0RldmljZXNJbnRlZ3JhdGlvbicsXG4gICAgICBkZXZpY2VzRnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZGV2aWNlcycsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogZGV2aWNlc0ludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcjogdGhpcy5hdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZGV2aWNlcy97c2VyaWFsX251bWJlcn0nLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5HRVQsIGFwaWdhdGV3YXkuSHR0cE1ldGhvZC5QQVRDSF0sXG4gICAgICBpbnRlZ3JhdGlvbjogZGV2aWNlc0ludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcjogdGhpcy5hdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgLy8gRGV2aWNlIG1lcmdlIGVuZHBvaW50IChBZG1pbiBvbmx5KVxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2RldmljZXMvbWVyZ2UnLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5QT1NUXSxcbiAgICAgIGludGVncmF0aW9uOiBkZXZpY2VzSW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyOiB0aGlzLmF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBUZWxlbWV0cnkgZW5kcG9pbnRzXG4gICAgY29uc3QgdGVsZW1ldHJ5SW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheUludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAnVGVsZW1ldHJ5SW50ZWdyYXRpb24nLFxuICAgICAgdGVsZW1ldHJ5RnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vdGVsZW1ldHJ5JyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiB0ZWxlbWV0cnlJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXI6IHRoaXMuYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2xvY2F0aW9uJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiB0ZWxlbWV0cnlJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXI6IHRoaXMuYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L3Bvd2VyJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiB0ZWxlbWV0cnlJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXI6IHRoaXMuYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2hlYWx0aCcsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogdGVsZW1ldHJ5SW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyOiB0aGlzLmF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBDb21tYW5kcyBlbmRwb2ludHNcbiAgICBjb25zdCBjb21tYW5kc0ludGVncmF0aW9uID0gbmV3IGFwaWdhdGV3YXlJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFxuICAgICAgJ0NvbW1hbmRzSW50ZWdyYXRpb24nLFxuICAgICAgY29tbWFuZHNGdW5jdGlvblxuICAgICk7XG5cbiAgICAvLyBBbGwgY29tbWFuZHMgZW5kcG9pbnQgKGZsZWV0LXdpZGUpXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvY29tbWFuZHMnLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5HRVRdLFxuICAgICAgaW50ZWdyYXRpb246IGNvbW1hbmRzSW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyOiB0aGlzLmF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBEZWxldGUgY29tbWFuZCBlbmRwb2ludFxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2NvbW1hbmRzL3tjb21tYW5kX2lkfScsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkRFTEVURV0sXG4gICAgICBpbnRlZ3JhdGlvbjogY29tbWFuZHNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXI6IHRoaXMuYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIC8vIERldmljZS1zcGVjaWZpYyBjb21tYW5kc1xuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2NvbW1hbmRzJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VULCBhcGlnYXRld2F5Lkh0dHBNZXRob2QuUE9TVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogY29tbWFuZHNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXI6IHRoaXMuYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIC8vIENvbmZpZyBlbmRwb2ludHNcbiAgICBjb25zdCBjb25maWdJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnYXRld2F5SW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICdDb25maWdJbnRlZ3JhdGlvbicsXG4gICAgICBjb25maWdGdW5jdGlvblxuICAgICk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9jb25maWcnLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5HRVQsIGFwaWdhdGV3YXkuSHR0cE1ldGhvZC5QVVRdLFxuICAgICAgaW50ZWdyYXRpb246IGNvbmZpZ0ludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcjogdGhpcy5hdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZmxlZXRzL3tmbGVldF91aWR9L2NvbmZpZycsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLlBVVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogY29uZmlnSW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyOiB0aGlzLmF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBBbGVydHMgZW5kcG9pbnRzXG4gICAgY29uc3QgYWxlcnRzSW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheUludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAnQWxlcnRzSW50ZWdyYXRpb24nLFxuICAgICAgYWxlcnRzRnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvYWxlcnRzJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiBhbGVydHNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXI6IHRoaXMuYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2FsZXJ0cy97YWxlcnRfaWR9JyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiBhbGVydHNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXI6IHRoaXMuYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2FsZXJ0cy97YWxlcnRfaWR9L2Fja25vd2xlZGdlJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuUE9TVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogYWxlcnRzSW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyOiB0aGlzLmF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBBY3Rpdml0eSBmZWVkIGVuZHBvaW50XG4gICAgY29uc3QgYWN0aXZpdHlJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnYXRld2F5SW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICdBY3Rpdml0eUludGVncmF0aW9uJyxcbiAgICAgIGFjdGl2aXR5RnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvYWN0aXZpdHknLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5HRVRdLFxuICAgICAgaW50ZWdyYXRpb246IGFjdGl2aXR5SW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyOiB0aGlzLmF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBTZXR0aW5ncyBlbmRwb2ludHNcbiAgICBjb25zdCBzZXR0aW5nc0ludGVncmF0aW9uID0gbmV3IGFwaWdhdGV3YXlJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFxuICAgICAgJ1NldHRpbmdzSW50ZWdyYXRpb24nLFxuICAgICAgc2V0dGluZ3NGdW5jdGlvblxuICAgICk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS9zZXR0aW5ncy9mbGVldC1kZWZhdWx0cycsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogc2V0dGluZ3NJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXI6IHRoaXMuYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL3NldHRpbmdzL2ZsZWV0LWRlZmF1bHRzL3tmbGVldH0nLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5HRVQsIGFwaWdhdGV3YXkuSHR0cE1ldGhvZC5QVVRdLFxuICAgICAgaW50ZWdyYXRpb246IHNldHRpbmdzSW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyOiB0aGlzLmF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBVc2VycyBlbmRwb2ludHMgKGFkbWluIG9ubHkgLSBlbmZvcmNlZCBpbiBMYW1iZGEpXG4gICAgY29uc3QgdXNlcnNJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnYXRld2F5SW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICdVc2Vyc0ludGVncmF0aW9uJyxcbiAgICAgIHVzZXJzRnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvdXNlcnMnLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5HRVQsIGFwaWdhdGV3YXkuSHR0cE1ldGhvZC5QT1NUXSxcbiAgICAgIGludGVncmF0aW9uOiB1c2Vyc0ludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcjogdGhpcy5hdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvdXNlcnMvZ3JvdXBzJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiB1c2Vyc0ludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcjogdGhpcy5hdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvdXNlcnMve3VzZXJJZH0nLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5HRVQsIGFwaWdhdGV3YXkuSHR0cE1ldGhvZC5ERUxFVEVdLFxuICAgICAgaW50ZWdyYXRpb246IHVzZXJzSW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyOiB0aGlzLmF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS91c2Vycy97dXNlcklkfS9ncm91cHMnLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5QVVRdLFxuICAgICAgaW50ZWdyYXRpb246IHVzZXJzSW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyOiB0aGlzLmF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS91c2Vycy97dXNlcklkfS9kZXZpY2VzJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuUFVUXSxcbiAgICAgIGludGVncmF0aW9uOiB1c2Vyc0ludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcjogdGhpcy5hdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgLy8gU2luZ2xlIGRldmljZSBhc3NpZ25tZW50IChlYWNoIHVzZXIgY2FuIG9ubHkgaGF2ZSBvbmUgZGV2aWNlKVxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL3VzZXJzL3t1c2VySWR9L2RldmljZScsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLlBVVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogdXNlcnNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXI6IHRoaXMuYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIC8vIFVuYXNzaWduZWQgZGV2aWNlcyBlbmRwb2ludCAoZm9yIGRldmljZSBhc3NpZ25tZW50IGRyb3Bkb3duKVxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2RldmljZXMvdW5hc3NpZ25lZCcsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogdXNlcnNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXI6IHRoaXMuYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIC8vIE5vdGVodWIgc3RhdHVzIGVuZHBvaW50c1xuICAgIGNvbnN0IG5vdGVodWJJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnYXRld2F5SW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICdOb3RlaHViSW50ZWdyYXRpb24nLFxuICAgICAgbm90ZWh1YkZ1bmN0aW9uXG4gICAgKTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL25vdGVodWIvc3RhdHVzJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiBub3RlaHViSW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyOiB0aGlzLmF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS9ub3RlaHViL2ZsZWV0cycsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogbm90ZWh1YkludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcjogdGhpcy5hdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgLy8gRmlybXdhcmUgZW5kcG9pbnRzIChhZG1pbiBvbmx5IC0gZW5mb3JjZWQgaW4gTGFtYmRhKVxuICAgIGNvbnN0IGZpcm13YXJlSW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheUludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAnRmlybXdhcmVJbnRlZ3JhdGlvbicsXG4gICAgICBmaXJtd2FyZUZ1bmN0aW9uXG4gICAgKTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2Zpcm13YXJlJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiBmaXJtd2FyZUludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcjogdGhpcy5hdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZmlybXdhcmUvc3RhdHVzJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiBmaXJtd2FyZUludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcjogdGhpcy5hdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZmlybXdhcmUvdXBkYXRlJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuUE9TVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogZmlybXdhcmVJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXI6IHRoaXMuYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2Zpcm13YXJlL2NhbmNlbCcsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLlBPU1RdLFxuICAgICAgaW50ZWdyYXRpb246IGZpcm13YXJlSW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyOiB0aGlzLmF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBFdmVudCBpbmdlc3QgZW5kcG9pbnQgKG5vIGF1dGggLSBjYWxsZWQgYnkgTm90ZWh1YilcbiAgICBjb25zdCBpbmdlc3RJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnYXRld2F5SW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICdJbmdlc3RJbnRlZ3JhdGlvbicsXG4gICAgICBpbmdlc3RGdW5jdGlvblxuICAgICk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS9pbmdlc3QnLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5QT1NUXSxcbiAgICAgIGludGVncmF0aW9uOiBpbmdlc3RJbnRlZ3JhdGlvbixcbiAgICAgIC8vIE5vIGF1dGhvcml6ZXIgLSBOb3RlaHViIEhUVFAgcm91dGVzIGRvbid0IHN1cHBvcnQgQ29nbml0byBhdXRoXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFB1YmxpYyBEZXZpY2UgQVBJIChubyBhdXRoIC0gZm9yIHNoYXJlYWJsZSBkZXZpY2UgbGlua3MpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBwdWJsaWNEZXZpY2VGdW5jdGlvbiA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnUHVibGljRGV2aWNlRnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hcGktcHVibGljLWRldmljZScsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NvbmdiaXJkIFB1YmxpYyBEZXZpY2UgQVBJICh1bmF1dGhlbnRpY2F0ZWQpJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYXBpLXB1YmxpYy1kZXZpY2UvaW5kZXgudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIERFVklDRVNfVEFCTEU6IHByb3BzLmRldmljZXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIFRFTEVNRVRSWV9UQUJMRTogcHJvcHMudGVsZW1ldHJ5VGFibGUudGFibGVOYW1lLFxuICAgICAgICBERVZJQ0VfQUxJQVNFU19UQUJMRTogcHJvcHMuZGV2aWNlQWxpYXNlc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgQVVESVRfVEFCTEU6IHByb3BzLmF1ZGl0VGFibGUudGFibGVOYW1lLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG4gICAgcHJvcHMuZGV2aWNlc1RhYmxlLmdyYW50UmVhZERhdGEocHVibGljRGV2aWNlRnVuY3Rpb24pO1xuICAgIHByb3BzLnRlbGVtZXRyeVRhYmxlLmdyYW50UmVhZERhdGEocHVibGljRGV2aWNlRnVuY3Rpb24pO1xuICAgIHByb3BzLmRldmljZUFsaWFzZXNUYWJsZS5ncmFudFJlYWREYXRhKHB1YmxpY0RldmljZUZ1bmN0aW9uKTtcbiAgICBwcm9wcy5hdWRpdFRhYmxlLmdyYW50V3JpdGVEYXRhKHB1YmxpY0RldmljZUZ1bmN0aW9uKTtcblxuICAgIGNvbnN0IHB1YmxpY0RldmljZUludGVncmF0aW9uID0gbmV3IGFwaWdhdGV3YXlJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFxuICAgICAgJ1B1YmxpY0RldmljZUludGVncmF0aW9uJyxcbiAgICAgIHB1YmxpY0RldmljZUZ1bmN0aW9uXG4gICAgKTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL3B1YmxpYy9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfScsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogcHVibGljRGV2aWNlSW50ZWdyYXRpb24sXG4gICAgICAvLyBObyBhdXRob3JpemVyIC0gcHVibGljIGVuZHBvaW50IGZvciBzaGFyZWFibGUgZGV2aWNlIGxpbmtzXG4gICAgfSk7XG5cbiAgICAvLyBKb3VybmV5cyBlbmRwb2ludHNcbiAgICBjb25zdCBqb3VybmV5c0ludGVncmF0aW9uID0gbmV3IGFwaWdhdGV3YXlJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFxuICAgICAgJ0pvdXJuZXlzSW50ZWdyYXRpb24nLFxuICAgICAgam91cm5leXNGdW5jdGlvblxuICAgICk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9qb3VybmV5cycsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogam91cm5leXNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXI6IHRoaXMuYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2pvdXJuZXlzL3tqb3VybmV5X2lkfScsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVCwgYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkRFTEVURV0sXG4gICAgICBpbnRlZ3JhdGlvbjogam91cm5leXNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXI6IHRoaXMuYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIC8vIE1hcCBtYXRjaGluZyBlbmRwb2ludCBmb3Igam91cm5leXNcbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9qb3VybmV5cy97am91cm5leV9pZH0vbWF0Y2gnLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5QT1NUXSxcbiAgICAgIGludGVncmF0aW9uOiBqb3VybmV5c0ludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcjogdGhpcy5hdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vbG9jYXRpb25zJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiBqb3VybmV5c0ludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcjogdGhpcy5hdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgLy8gU3RvcmUgQVBJIFVSTFxuICAgIHRoaXMuYXBpVXJsID0gdGhpcy5hcGkudXJsITtcbiAgICB0aGlzLmluZ2VzdFVybCA9IGAke3RoaXMuYXBpLnVybH12MS9pbmdlc3RgO1xuICB9XG5cbiAgLyoqXG4gICAqIEFkZCBBbmFseXRpY3Mgcm91dGVzIHRvIHRoZSBBUElcbiAgICogVGhpcyBtZXRob2Qgc2hvdWxkIGJlIGNhbGxlZCBmcm9tIHRoZSBtYWluIHN0YWNrIGFmdGVyIGNyZWF0aW5nIHRoZSBBbmFseXRpY3MgY29uc3RydWN0XG4gICAqL1xuICBwdWJsaWMgYWRkQW5hbHl0aWNzUm91dGVzKFxuICAgIGNoYXRRdWVyeUxhbWJkYTogbGFtYmRhLkZ1bmN0aW9uLFxuICAgIGNoYXRIaXN0b3J5TGFtYmRhOiBsYW1iZGEuRnVuY3Rpb24sXG4gICAgbGlzdFNlc3Npb25zTGFtYmRhPzogbGFtYmRhLkZ1bmN0aW9uLFxuICAgIGdldFNlc3Npb25MYW1iZGE/OiBsYW1iZGEuRnVuY3Rpb24sXG4gICAgZGVsZXRlU2Vzc2lvbkxhbWJkYT86IGxhbWJkYS5GdW5jdGlvbixcbiAgICByZXJ1blF1ZXJ5TGFtYmRhPzogbGFtYmRhLkZ1bmN0aW9uXG4gICkge1xuICAgIGNvbnN0IGNoYXRRdWVyeUludGVncmF0aW9uID0gbmV3IGFwaWdhdGV3YXlJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFxuICAgICAgJ0NoYXRRdWVyeUludGVncmF0aW9uJyxcbiAgICAgIGNoYXRRdWVyeUxhbWJkYVxuICAgICk7XG5cbiAgICBjb25zdCBjaGF0SGlzdG9yeUludGVncmF0aW9uID0gbmV3IGFwaWdhdGV3YXlJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFxuICAgICAgJ0NoYXRIaXN0b3J5SW50ZWdyYXRpb24nLFxuICAgICAgY2hhdEhpc3RvcnlMYW1iZGFcbiAgICApO1xuXG4gICAgLy8gUE9TVCAvYW5hbHl0aWNzL2NoYXQgLSBFeGVjdXRlIGFuYWx5dGljcyBxdWVyeVxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL2FuYWx5dGljcy9jaGF0JyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuUE9TVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogY2hhdFF1ZXJ5SW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyOiB0aGlzLmF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBHRVQgL2FuYWx5dGljcy9oaXN0b3J5IC0gR2V0IGNoYXQgaGlzdG9yeVxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL2FuYWx5dGljcy9oaXN0b3J5JyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiBjaGF0SGlzdG9yeUludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcjogdGhpcy5hdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgLy8gU2Vzc2lvbiBtYW5hZ2VtZW50IHJvdXRlc1xuICAgIGlmIChsaXN0U2Vzc2lvbnNMYW1iZGEpIHtcbiAgICAgIGNvbnN0IGxpc3RTZXNzaW9uc0ludGVncmF0aW9uID0gbmV3IGFwaWdhdGV3YXlJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFxuICAgICAgICAnTGlzdFNlc3Npb25zSW50ZWdyYXRpb24nLFxuICAgICAgICBsaXN0U2Vzc2lvbnNMYW1iZGFcbiAgICAgICk7XG5cbiAgICAgIC8vIEdFVCAvYW5hbHl0aWNzL3Nlc3Npb25zIC0gTGlzdCBhbGwgc2Vzc2lvbnNcbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICAgIHBhdGg6ICcvYW5hbHl0aWNzL3Nlc3Npb25zJyxcbiAgICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5HRVRdLFxuICAgICAgICBpbnRlZ3JhdGlvbjogbGlzdFNlc3Npb25zSW50ZWdyYXRpb24sXG4gICAgICAgIGF1dGhvcml6ZXI6IHRoaXMuYXV0aG9yaXplcixcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmIChnZXRTZXNzaW9uTGFtYmRhKSB7XG4gICAgICBjb25zdCBnZXRTZXNzaW9uSW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheUludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAgICdHZXRTZXNzaW9uSW50ZWdyYXRpb24nLFxuICAgICAgICBnZXRTZXNzaW9uTGFtYmRhXG4gICAgICApO1xuXG4gICAgICAvLyBHRVQgL2FuYWx5dGljcy9zZXNzaW9ucy97c2Vzc2lvbklkfSAtIEdldCBzZXNzaW9uIGRldGFpbHNcbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICAgIHBhdGg6ICcvYW5hbHl0aWNzL3Nlc3Npb25zL3tzZXNzaW9uSWR9JyxcbiAgICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5HRVRdLFxuICAgICAgICBpbnRlZ3JhdGlvbjogZ2V0U2Vzc2lvbkludGVncmF0aW9uLFxuICAgICAgICBhdXRob3JpemVyOiB0aGlzLmF1dGhvcml6ZXIsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAoZGVsZXRlU2Vzc2lvbkxhbWJkYSkge1xuICAgICAgY29uc3QgZGVsZXRlU2Vzc2lvbkludGVncmF0aW9uID0gbmV3IGFwaWdhdGV3YXlJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFxuICAgICAgICAnRGVsZXRlU2Vzc2lvbkludGVncmF0aW9uJyxcbiAgICAgICAgZGVsZXRlU2Vzc2lvbkxhbWJkYVxuICAgICAgKTtcblxuICAgICAgLy8gREVMRVRFIC9hbmFseXRpY3Mvc2Vzc2lvbnMve3Nlc3Npb25JZH0gLSBEZWxldGUgc2Vzc2lvblxuICAgICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgICAgcGF0aDogJy9hbmFseXRpY3Mvc2Vzc2lvbnMve3Nlc3Npb25JZH0nLFxuICAgICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkRFTEVURV0sXG4gICAgICAgIGludGVncmF0aW9uOiBkZWxldGVTZXNzaW9uSW50ZWdyYXRpb24sXG4gICAgICAgIGF1dGhvcml6ZXI6IHRoaXMuYXV0aG9yaXplcixcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmIChyZXJ1blF1ZXJ5TGFtYmRhKSB7XG4gICAgICBjb25zdCByZXJ1blF1ZXJ5SW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheUludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAgICdSZXJ1blF1ZXJ5SW50ZWdyYXRpb24nLFxuICAgICAgICByZXJ1blF1ZXJ5TGFtYmRhXG4gICAgICApO1xuXG4gICAgICAvLyBQT1NUIC9hbmFseXRpY3MvcmVydW4gLSBSZS1leGVjdXRlIHN0b3JlZCBTUUwgcXVlcnkgZm9yIHZpc3VhbGl6YXRpb25cbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICAgIHBhdGg6ICcvYW5hbHl0aWNzL3JlcnVuJyxcbiAgICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5QT1NUXSxcbiAgICAgICAgaW50ZWdyYXRpb246IHJlcnVuUXVlcnlJbnRlZ3JhdGlvbixcbiAgICAgICAgYXV0aG9yaXplcjogdGhpcy5hdXRob3JpemVyLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG59XG4iXX0=