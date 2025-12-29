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
            },
            bundling: { minify: true, sourceMap: true },
            logRetention: logs.RetentionDays.TWO_WEEKS,
        });
        notehubSecret.grantRead(configFunction);
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
        const authorizer = new apigatewayAuthorizers.HttpUserPoolAuthorizer('CognitoAuthorizer', props.userPool, {
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
            authorizer,
        });
        this.api.addRoutes({
            path: '/v1/devices/{serial_number}',
            methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.PATCH],
            integration: devicesIntegration,
            authorizer,
        });
        // Telemetry endpoints
        const telemetryIntegration = new apigatewayIntegrations.HttpLambdaIntegration('TelemetryIntegration', telemetryFunction);
        this.api.addRoutes({
            path: '/v1/devices/{serial_number}/telemetry',
            methods: [apigateway.HttpMethod.GET],
            integration: telemetryIntegration,
            authorizer,
        });
        this.api.addRoutes({
            path: '/v1/devices/{serial_number}/location',
            methods: [apigateway.HttpMethod.GET],
            integration: telemetryIntegration,
            authorizer,
        });
        this.api.addRoutes({
            path: '/v1/devices/{serial_number}/power',
            methods: [apigateway.HttpMethod.GET],
            integration: telemetryIntegration,
            authorizer,
        });
        this.api.addRoutes({
            path: '/v1/devices/{serial_number}/health',
            methods: [apigateway.HttpMethod.GET],
            integration: telemetryIntegration,
            authorizer,
        });
        // Commands endpoints
        const commandsIntegration = new apigatewayIntegrations.HttpLambdaIntegration('CommandsIntegration', commandsFunction);
        // All commands endpoint (fleet-wide)
        this.api.addRoutes({
            path: '/v1/commands',
            methods: [apigateway.HttpMethod.GET],
            integration: commandsIntegration,
            authorizer,
        });
        // Delete command endpoint
        this.api.addRoutes({
            path: '/v1/commands/{command_id}',
            methods: [apigateway.HttpMethod.DELETE],
            integration: commandsIntegration,
            authorizer,
        });
        // Device-specific commands
        this.api.addRoutes({
            path: '/v1/devices/{serial_number}/commands',
            methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.POST],
            integration: commandsIntegration,
            authorizer,
        });
        // Config endpoints
        const configIntegration = new apigatewayIntegrations.HttpLambdaIntegration('ConfigIntegration', configFunction);
        this.api.addRoutes({
            path: '/v1/devices/{serial_number}/config',
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
        // Alerts endpoints
        const alertsIntegration = new apigatewayIntegrations.HttpLambdaIntegration('AlertsIntegration', alertsFunction);
        this.api.addRoutes({
            path: '/v1/alerts',
            methods: [apigateway.HttpMethod.GET],
            integration: alertsIntegration,
            authorizer,
        });
        this.api.addRoutes({
            path: '/v1/alerts/{alert_id}',
            methods: [apigateway.HttpMethod.GET],
            integration: alertsIntegration,
            authorizer,
        });
        this.api.addRoutes({
            path: '/v1/alerts/{alert_id}/acknowledge',
            methods: [apigateway.HttpMethod.POST],
            integration: alertsIntegration,
            authorizer,
        });
        // Activity feed endpoint
        const activityIntegration = new apigatewayIntegrations.HttpLambdaIntegration('ActivityIntegration', activityFunction);
        this.api.addRoutes({
            path: '/v1/activity',
            methods: [apigateway.HttpMethod.GET],
            integration: activityIntegration,
            authorizer,
        });
        // Settings endpoints
        const settingsIntegration = new apigatewayIntegrations.HttpLambdaIntegration('SettingsIntegration', settingsFunction);
        this.api.addRoutes({
            path: '/v1/settings/fleet-defaults',
            methods: [apigateway.HttpMethod.GET],
            integration: settingsIntegration,
            authorizer,
        });
        this.api.addRoutes({
            path: '/v1/settings/fleet-defaults/{fleet}',
            methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.PUT],
            integration: settingsIntegration,
            authorizer,
        });
        // Users endpoints (admin only - enforced in Lambda)
        const usersIntegration = new apigatewayIntegrations.HttpLambdaIntegration('UsersIntegration', usersFunction);
        this.api.addRoutes({
            path: '/v1/users',
            methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.POST],
            integration: usersIntegration,
            authorizer,
        });
        this.api.addRoutes({
            path: '/v1/users/groups',
            methods: [apigateway.HttpMethod.GET],
            integration: usersIntegration,
            authorizer,
        });
        this.api.addRoutes({
            path: '/v1/users/{userId}',
            methods: [apigateway.HttpMethod.GET],
            integration: usersIntegration,
            authorizer,
        });
        this.api.addRoutes({
            path: '/v1/users/{userId}/groups',
            methods: [apigateway.HttpMethod.PUT],
            integration: usersIntegration,
            authorizer,
        });
        this.api.addRoutes({
            path: '/v1/users/{userId}/devices',
            methods: [apigateway.HttpMethod.PUT],
            integration: usersIntegration,
            authorizer,
        });
        // Single device assignment (each user can only have one device)
        this.api.addRoutes({
            path: '/v1/users/{userId}/device',
            methods: [apigateway.HttpMethod.PUT],
            integration: usersIntegration,
            authorizer,
        });
        // Unassigned devices endpoint (for device assignment dropdown)
        this.api.addRoutes({
            path: '/v1/devices/unassigned',
            methods: [apigateway.HttpMethod.GET],
            integration: usersIntegration,
            authorizer,
        });
        // Notehub status endpoints
        const notehubIntegration = new apigatewayIntegrations.HttpLambdaIntegration('NotehubIntegration', notehubFunction);
        this.api.addRoutes({
            path: '/v1/notehub/status',
            methods: [apigateway.HttpMethod.GET],
            integration: notehubIntegration,
            authorizer,
        });
        this.api.addRoutes({
            path: '/v1/notehub/fleets',
            methods: [apigateway.HttpMethod.GET],
            integration: notehubIntegration,
            authorizer,
        });
        // Event ingest endpoint (no auth - called by Notehub)
        const ingestIntegration = new apigatewayIntegrations.HttpLambdaIntegration('IngestIntegration', ingestFunction);
        this.api.addRoutes({
            path: '/v1/ingest',
            methods: [apigateway.HttpMethod.POST],
            integration: ingestIntegration,
            // No authorizer - Notehub HTTP routes don't support Cognito auth
        });
        // Journeys endpoints
        const journeysIntegration = new apigatewayIntegrations.HttpLambdaIntegration('JourneysIntegration', journeysFunction);
        this.api.addRoutes({
            path: '/v1/devices/{serial_number}/journeys',
            methods: [apigateway.HttpMethod.GET],
            integration: journeysIntegration,
            authorizer,
        });
        this.api.addRoutes({
            path: '/v1/devices/{serial_number}/journeys/{journey_id}',
            methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.DELETE],
            integration: journeysIntegration,
            authorizer,
        });
        // Map matching endpoint for journeys
        this.api.addRoutes({
            path: '/v1/devices/{serial_number}/journeys/{journey_id}/match',
            methods: [apigateway.HttpMethod.POST],
            integration: journeysIntegration,
            authorizer,
        });
        this.api.addRoutes({
            path: '/v1/devices/{serial_number}/locations',
            methods: [apigateway.HttpMethod.GET],
            integration: journeysIntegration,
            authorizer,
        });
        // Store API URL
        this.apiUrl = this.api.url;
        this.ingestUrl = `${this.api.url}v1/ingest`;
    }
}
exports.ApiConstruct = ApiConstruct;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBpLWNvbnN0cnVjdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL2xpYi9hcGktY29uc3RydWN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7R0FRRzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFFSCxpREFBbUM7QUFDbkMseUVBQTJEO0FBQzNELGtHQUFvRjtBQUNwRixnR0FBa0Y7QUFDbEYsK0RBQWlEO0FBR2pELG1FQUFxRDtBQUNyRCwyREFBNkM7QUFDN0MsK0VBQWlFO0FBQ2pFLHFFQUErRDtBQUMvRCwyQ0FBdUM7QUFDdkMsMkNBQTZCO0FBZ0I3QixNQUFhLFlBQWEsU0FBUSxzQkFBUztJQUN6QixHQUFHLENBQXFCO0lBQ3hCLE1BQU0sQ0FBUztJQUNmLFNBQVMsQ0FBUztJQUVsQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXdCO1FBQ2hFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsNkVBQTZFO1FBQzdFLHVDQUF1QztRQUN2Qyw2RUFBNkU7UUFDN0UsTUFBTSxhQUFhLEdBQUcsSUFBSSxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxlQUFlLEVBQUU7WUFDOUQsU0FBUyxFQUFFLG1CQUFtQjtZQUM5QixZQUFZLEVBQUUsRUFBRSxJQUFJLEVBQUUsWUFBWSxFQUFFLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU0sRUFBRTtZQUN6RSxPQUFPLEVBQUUsRUFBRSxJQUFJLEVBQUUsWUFBWSxFQUFFLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU0sRUFBRTtZQUNwRSxXQUFXLEVBQUUsUUFBUSxDQUFDLFdBQVcsQ0FBQyxlQUFlO1lBQ2pELGFBQWEsRUFBRSxHQUFHLENBQUMsYUFBYSxDQUFDLE9BQU87WUFDeEMsbUJBQW1CLEVBQUUsS0FBSztTQUMzQixDQUFDLENBQUM7UUFFSCw2Q0FBNkM7UUFDN0MsYUFBYSxDQUFDLHVC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QUcsQ0FBQztZQUNwQyxXQUFXLEVBQUUsbUJBQW1CO1lBQ2hDLFVBQVU7U0FDWCxDQUFDLENBQUM7UUFFSCxnQkFBZ0I7UUFDaEIsSUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUksQ0FBQztRQUM1QixJQUFJLENBQUMsU0FBUyxHQUFHLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLFdBQVcsQ0FBQztJQUM5QyxDQUFDO0NBQ0Y7QUF2bkJELG9DQXVuQkMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEFQSSBDb25zdHJ1Y3RcbiAqXG4gKiBEZWZpbmVzIEFQSSBHYXRld2F5IEhUVFAgQVBJIGFuZCBMYW1iZGEgaW50ZWdyYXRpb25zIGZvcjpcbiAqIC0gRGV2aWNlIG1hbmFnZW1lbnRcbiAqIC0gVGVsZW1ldHJ5IHF1ZXJpZXNcbiAqIC0gQ29uZmlndXJhdGlvbiBtYW5hZ2VtZW50XG4gKiAtIENvbW1hbmQgc2VuZGluZ1xuICovXG5cbmltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBhcGlnYXRld2F5IGZyb20gJ2F3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djInO1xuaW1wb3J0ICogYXMgYXBpZ2F0ZXdheUludGVncmF0aW9ucyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9ucyc7XG5pbXBvcnQgKiBhcyBhcGlnYXRld2F5QXV0aG9yaXplcnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1hdXRob3JpemVycyc7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYSc7XG5pbXBvcnQgKiBhcyBzbnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNucyc7XG5pbXBvcnQgKiBhcyBjb2duaXRvIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jb2duaXRvJztcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gJ2F3cy1jZGstbGliL2F3cy1keW5hbW9kYic7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCAqIGFzIHNlY3JldHNtYW5hZ2VyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zZWNyZXRzbWFuYWdlcic7XG5pbXBvcnQgeyBOb2RlanNGdW5jdGlvbiB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEtbm9kZWpzJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcblxuZXhwb3J0IGludGVyZmFjZSBBcGlDb25zdHJ1Y3RQcm9wcyB7XG4gIHRlbGVtZXRyeVRhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbiAgZGV2aWNlc1RhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbiAgYWxlcnRzVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBzZXR0aW5nc1RhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbiAgam91cm5leXNUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIGxvY2F0aW9uc1RhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbiAgZGV2aWNlQWxpYXNlc1RhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbiAgdXNlclBvb2w6IGNvZ25pdG8uVXNlclBvb2w7XG4gIHVzZXJQb29sQ2xpZW50OiBjb2duaXRvLlVzZXJQb29sQ2xpZW50O1xuICBub3RlaHViUHJvamVjdFVpZDogc3RyaW5nO1xuICBhbGVydFRvcGljOiBzbnMuSVRvcGljO1xufVxuXG5leHBvcnQgY2xhc3MgQXBpQ29uc3RydWN0IGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ2F0ZXdheS5IdHRwQXBpO1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpVXJsOiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBpbmdlc3RVcmw6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBpQ29uc3RydWN0UHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDb21tYW5kcyBUYWJsZSAoZm9yIGNvbW1hbmQgaGlzdG9yeSlcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGNvbW1hbmRzVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgJ0NvbW1hbmRzVGFibGUnLCB7XG4gICAgICB0YWJsZU5hbWU6ICdzb25nYmlyZC1jb21tYW5kcycsXG4gICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogJ2RldmljZV91aWQnLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgc29ydEtleTogeyBuYW1lOiAnY29tbWFuZF9pZCcsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6ICd0dGwnLFxuICAgIH0pO1xuXG4gICAgLy8gR1NJIGZvciBxdWVyeWluZyBjb21tYW5kcyBieSBjcmVhdGlvbiB0aW1lXG4gICAgY29tbWFuZHNUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6ICdkZXZpY2UtY3JlYXRlZC1pbmRleCcsXG4gICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogJ2RldmljZV91aWQnLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgc29ydEtleTogeyBuYW1lOiAnY3JlYXRlZF9hdCcsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBOb3RlaHViIEFQSSBUb2tlbiBTZWNyZXRcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE5vdGU6IFRoaXMgc2VjcmV0IHNob3VsZCBiZSBjcmVhdGVkIG1hbnVhbGx5IHdpdGggdGhlIGFjdHVhbCB0b2tlblxuICAgIGNvbnN0IG5vdGVodWJTZWNyZXQgPSBuZXcgc2VjcmV0c21hbmFnZXIuU2VjcmV0KHRoaXMsICdOb3RlaHViQXBpVG9rZW4nLCB7XG4gICAgICBzZWNyZXROYW1lOiAnc29uZ2JpcmQvbm90ZWh1Yi1hcGktdG9rZW4nLFxuICAgICAgZGVzY3JpcHRpb246ICdOb3RlaHViIEFQSSB0b2tlbiBmb3IgU29uZ2JpcmQnLFxuICAgICAgZ2VuZXJhdGVTZWNyZXRTdHJpbmc6IHtcbiAgICAgICAgc2VjcmV0U3RyaW5nVGVtcGxhdGU6IEpTT04uc3RyaW5naWZ5KHsgcGxhY2Vob2xkZXI6ICdSRVBMQUNFX1dJVEhfQUNUVUFMX1RPS0VOJyB9KSxcbiAgICAgICAgZ2VuZXJhdGVTdHJpbmdLZXk6ICd0b2tlbicsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBMYW1iZGEgRnVuY3Rpb25zXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIERldmljZXMgQVBJXG4gICAgY29uc3QgZGV2aWNlc0Z1bmN0aW9uID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdEZXZpY2VzRnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hcGktZGV2aWNlcycsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NvbmdiaXJkIERldmljZXMgQVBJJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYXBpLWRldmljZXMvaW5kZXgudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIERFVklDRVNfVEFCTEU6IHByb3BzLmRldmljZXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIERFVklDRV9BTElBU0VTX1RBQkxFOiBwcm9wcy5kZXZpY2VBbGlhc2VzVGFibGUudGFibGVOYW1lLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG4gICAgcHJvcHMuZGV2aWNlc1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShkZXZpY2VzRnVuY3Rpb24pO1xuICAgIHByb3BzLmRldmljZUFsaWFzZXNUYWJsZS5ncmFudFJlYWREYXRhKGRldmljZXNGdW5jdGlvbik7XG5cbiAgICAvLyBUZWxlbWV0cnkgQVBJXG4gICAgY29uc3QgdGVsZW1ldHJ5RnVuY3Rpb24gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ1RlbGVtZXRyeUZ1bmN0aW9uJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYXBpLXRlbGVtZXRyeScsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NvbmdiaXJkIFRlbGVtZXRyeSBBUEknLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hcGktdGVsZW1ldHJ5L2luZGV4LnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBURUxFTUVUUllfVEFCTEU6IHByb3BzLnRlbGVtZXRyeVRhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgREVWSUNFX0FMSUFTRVNfVEFCTEU6IHByb3BzLmRldmljZUFsaWFzZXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcbiAgICBwcm9wcy50ZWxlbWV0cnlUYWJsZS5ncmFudFJlYWREYXRhKHRlbGVtZXRyeUZ1bmN0aW9uKTtcbiAgICBwcm9wcy5kZXZpY2VBbGlhc2VzVGFibGUuZ3JhbnRSZWFkRGF0YSh0ZWxlbWV0cnlGdW5jdGlvbik7XG5cbiAgICAvLyBDb21tYW5kcyBBUElcbiAgICBjb25zdCBjb21tYW5kc0Z1bmN0aW9uID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdDb21tYW5kc0Z1bmN0aW9uJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYXBpLWNvbW1hbmRzJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgQ29tbWFuZHMgQVBJJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYXBpLWNvbW1hbmRzL2luZGV4LnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBDT01NQU5EU19UQUJMRTogY29tbWFuZHNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIE5PVEVIVUJfUFJPSkVDVF9VSUQ6IHByb3BzLm5vdGVodWJQcm9qZWN0VWlkLFxuICAgICAgICBOT1RFSFVCX1NFQ1JFVF9BUk46IG5vdGVodWJTZWNyZXQuc2VjcmV0QXJuLFxuICAgICAgICBERVZJQ0VfQUxJQVNFU19UQUJMRTogcHJvcHMuZGV2aWNlQWxpYXNlc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuICAgIGNvbW1hbmRzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGNvbW1hbmRzRnVuY3Rpb24pO1xuICAgIG5vdGVodWJTZWNyZXQuZ3JhbnRSZWFkKGNvbW1hbmRzRnVuY3Rpb24pO1xuICAgIHByb3BzLmRldmljZUFsaWFzZXNUYWJsZS5ncmFudFJlYWREYXRhKGNvbW1hbmRzRnVuY3Rpb24pO1xuXG4gICAgLy8gQ29uZmlnIEFQSVxuICAgIGNvbnN0IGNvbmZpZ0Z1bmN0aW9uID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdDb25maWdGdW5jdGlvbicsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFwaS1jb25maWcnLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBDb25maWcgQVBJJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYXBpLWNvbmZpZy9pbmRleC50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgTk9URUhVQl9QUk9KRUNUX1VJRDogcHJvcHMubm90ZWh1YlByb2plY3RVaWQsXG4gICAgICAgIE5PVEVIVUJfU0VDUkVUX0FSTjogbm90ZWh1YlNlY3JldC5zZWNyZXRBcm4sXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcbiAgICBub3RlaHViU2VjcmV0LmdyYW50UmVhZChjb25maWdGdW5jdGlvbik7XG5cbiAgICAvLyBBbGVydHMgQVBJXG4gICAgY29uc3QgYWxlcnRzRnVuY3Rpb24gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0FsZXJ0c0Z1bmN0aW9uJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYXBpLWFsZXJ0cycsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NvbmdiaXJkIEFsZXJ0cyBBUEknLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hcGktYWxlcnRzL2luZGV4LnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBBTEVSVFNfVEFCTEU6IHByb3BzLmFsZXJ0c1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgREVWSUNFX0FMSUFTRVNfVEFCTEU6IHByb3BzLmRldmljZUFsaWFzZXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcbiAgICBwcm9wcy5hbGVydHNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoYWxlcnRzRnVuY3Rpb24pO1xuICAgIHByb3BzLmRldmljZUFsaWFzZXNUYWJsZS5ncmFudFJlYWREYXRhKGFsZXJ0c0Z1bmN0aW9uKTtcblxuICAgIC8vIEFjdGl2aXR5IEZlZWQgQVBJXG4gICAgY29uc3QgYWN0aXZpdHlGdW5jdGlvbiA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnQWN0aXZpdHlGdW5jdGlvbicsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFwaS1hY3Rpdml0eScsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NvbmdiaXJkIEFjdGl2aXR5IEZlZWQgQVBJJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYXBpLWFjdGl2aXR5L2luZGV4LnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBURUxFTUVUUllfVEFCTEU6IHByb3BzLnRlbGVtZXRyeVRhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgQUxFUlRTX1RBQkxFOiBwcm9wcy5hbGVydHNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIERFVklDRVNfVEFCTEU6IHByb3BzLmRldmljZXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIENPTU1BTkRTX1RBQkxFOiBjb21tYW5kc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgSk9VUk5FWVNfVEFCTEU6IHByb3BzLmpvdXJuZXlzVGFibGUudGFibGVOYW1lLFxuICAgICAgICBERVZJQ0VfQUxJQVNFU19UQUJMRTogcHJvcHMuZGV2aWNlQWxpYXNlc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuICAgIHByb3BzLnRlbGVtZXRyeVRhYmxlLmdyYW50UmVhZERhdGEoYWN0aXZpdHlGdW5jdGlvbik7XG4gICAgcHJvcHMuYWxlcnRzVGFibGUuZ3JhbnRSZWFkRGF0YShhY3Rpdml0eUZ1bmN0aW9uKTtcbiAgICBwcm9wcy5kZXZpY2VzVGFibGUuZ3JhbnRSZWFkRGF0YShhY3Rpdml0eUZ1bmN0aW9uKTtcbiAgICBjb21tYW5kc1RhYmxlLmdyYW50UmVhZERhdGEoYWN0aXZpdHlGdW5jdGlvbik7XG4gICAgcHJvcHMuam91cm5leXNUYWJsZS5ncmFudFJlYWREYXRhKGFjdGl2aXR5RnVuY3Rpb24pO1xuICAgIHByb3BzLmRldmljZUFsaWFzZXNUYWJsZS5ncmFudFJlYWREYXRhKGFjdGl2aXR5RnVuY3Rpb24pO1xuXG4gICAgLy8gU2V0dGluZ3MgQVBJXG4gICAgY29uc3Qgc2V0dGluZ3NGdW5jdGlvbiA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnU2V0dGluZ3NGdW5jdGlvbicsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFwaS1zZXR0aW5ncycsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NvbmdiaXJkIFNldHRpbmdzIEFQSScsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FwaS1zZXR0aW5ncy9pbmRleC50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgU0VUVElOR1NfVEFCTEU6IHByb3BzLnNldHRpbmdzVGFibGUudGFibGVOYW1lLFxuICAgICAgICBOT1RFSFVCX1BST0pFQ1RfVUlEOiBwcm9wcy5ub3RlaHViUHJvamVjdFVpZCxcbiAgICAgICAgTk9URUhVQl9TRUNSRVRfQVJOOiBub3RlaHViU2VjcmV0LnNlY3JldEFybixcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuICAgIHByb3BzLnNldHRpbmdzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHNldHRpbmdzRnVuY3Rpb24pO1xuICAgIG5vdGVodWJTZWNyZXQuZ3JhbnRSZWFkKHNldHRpbmdzRnVuY3Rpb24pO1xuXG4gICAgLy8gVXNlcnMgQVBJIChBZG1pbiBvcGVyYXRpb25zKVxuICAgIGNvbnN0IHVzZXJzRnVuY3Rpb24gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ1VzZXJzRnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hcGktdXNlcnMnLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBVc2VycyBBUEknLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hcGktdXNlcnMvaW5kZXgudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFVTRVJfUE9PTF9JRDogcHJvcHMudXNlclBvb2wudXNlclBvb2xJZCxcbiAgICAgICAgREVWSUNFU19UQUJMRTogcHJvcHMuZGV2aWNlc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuICAgIHByb3BzLmRldmljZXNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEodXNlcnNGdW5jdGlvbik7XG4gICAgLy8gR3JhbnQgQ29nbml0byBhZG1pbiBwZXJtaXNzaW9uc1xuICAgIHVzZXJzRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KG5ldyBjZGsuYXdzX2lhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBjZGsuYXdzX2lhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdjb2duaXRvLWlkcDpMaXN0VXNlcnMnLFxuICAgICAgICAnY29nbml0by1pZHA6QWRtaW5DcmVhdGVVc2VyJyxcbiAgICAgICAgJ2NvZ25pdG8taWRwOkFkbWluR2V0VXNlcicsXG4gICAgICAgICdjb2duaXRvLWlkcDpBZG1pblVwZGF0ZVVzZXJBdHRyaWJ1dGVzJyxcbiAgICAgICAgJ2NvZ25pdG8taWRwOkFkbWluQWRkVXNlclRvR3JvdXAnLFxuICAgICAgICAnY29nbml0by1pZHA6QWRtaW5SZW1vdmVVc2VyRnJvbUdyb3VwJyxcbiAgICAgICAgJ2NvZ25pdG8taWRwOkFkbWluTGlzdEdyb3Vwc0ZvclVzZXInLFxuICAgICAgICAnY29nbml0by1pZHA6TGlzdEdyb3VwcycsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbcHJvcHMudXNlclBvb2wudXNlclBvb2xBcm5dLFxuICAgIH0pKTtcblxuICAgIC8vIE5vdGVodWIgU3RhdHVzIEFQSVxuICAgIGNvbnN0IG5vdGVodWJGdW5jdGlvbiA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnTm90ZWh1YkZ1bmN0aW9uJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYXBpLW5vdGVodWInLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBOb3RlaHViIFN0YXR1cyBBUEknLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hcGktbm90ZWh1Yi9pbmRleC50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgTk9URUhVQl9QUk9KRUNUX1VJRDogcHJvcHMubm90ZWh1YlByb2plY3RVaWQsXG4gICAgICAgIE5PVEVIVUJfU0VDUkVUX0FSTjogbm90ZWh1YlNlY3JldC5zZWNyZXRBcm4sXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcbiAgICBub3RlaHViU2VjcmV0LmdyYW50UmVhZChub3RlaHViRnVuY3Rpb24pO1xuXG4gICAgLy8gRXZlbnQgSW5nZXN0IEFQSSAoZm9yIE5vdGVodWIgSFRUUCByb3V0ZSAtIG5vIGF1dGhlbnRpY2F0aW9uKVxuICAgIGNvbnN0IGluZ2VzdEZ1bmN0aW9uID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdJbmdlc3RGdW5jdGlvbicsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFwaS1pbmdlc3QnLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBFdmVudCBJbmdlc3QgQVBJIGZvciBOb3RlaHViIEhUVFAgcm91dGVzJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYXBpLWluZ2VzdC9pbmRleC50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgVEVMRU1FVFJZX1RBQkxFOiBwcm9wcy50ZWxlbWV0cnlUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIERFVklDRVNfVEFCTEU6IHByb3BzLmRldmljZXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIENPTU1BTkRTX1RBQkxFOiBjb21tYW5kc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgQUxFUlRTX1RBQkxFOiBwcm9wcy5hbGVydHNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIEFMRVJUX1RPUElDX0FSTjogcHJvcHMuYWxlcnRUb3BpYy50b3BpY0FybixcbiAgICAgICAgSk9VUk5FWVNfVEFCTEU6IHByb3BzLmpvdXJuZXlzVGFibGUudGFibGVOYW1lLFxuICAgICAgICBMT0NBVElPTlNfVEFCTEU6IHByb3BzLmxvY2F0aW9uc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgREVWSUNFX0FMSUFTRVNfVEFCTEU6IHByb3BzLmRldmljZUFsaWFzZXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcbiAgICBwcm9wcy50ZWxlbWV0cnlUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoaW5nZXN0RnVuY3Rpb24pO1xuICAgIHByb3BzLmRldmljZXNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoaW5nZXN0RnVuY3Rpb24pO1xuICAgIGNvbW1hbmRzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGluZ2VzdEZ1bmN0aW9uKTtcbiAgICBwcm9wcy5hbGVydHNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoaW5nZXN0RnVuY3Rpb24pO1xuICAgIHByb3BzLmFsZXJ0VG9waWMuZ3JhbnRQdWJsaXNoKGluZ2VzdEZ1bmN0aW9uKTtcbiAgICBwcm9wcy5qb3VybmV5c1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShpbmdlc3RGdW5jdGlvbik7XG4gICAgcHJvcHMubG9jYXRpb25zVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGluZ2VzdEZ1bmN0aW9uKTtcbiAgICBwcm9wcy5kZXZpY2VBbGlhc2VzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGluZ2VzdEZ1bmN0aW9uKTtcblxuICAgIC8vIE1hcGJveCBBUEkgVG9rZW4gU2VjcmV0IChmb3IgbWFwIG1hdGNoaW5nKVxuICAgIGNvbnN0IG1hcGJveFNlY3JldCA9IG5ldyBzZWNyZXRzbWFuYWdlci5TZWNyZXQodGhpcywgJ01hcGJveEFwaVRva2VuJywge1xuICAgICAgc2VjcmV0TmFtZTogJ3NvbmdiaXJkL21hcGJveC1hcGktdG9rZW4nLFxuICAgICAgZGVzY3JpcHRpb246ICdNYXBib3ggQVBJIHRva2VuIGZvciBTb25nYmlyZCBtYXAgbWF0Y2hpbmcnLFxuICAgIH0pO1xuXG4gICAgLy8gSm91cm5leXMgQVBJICh3aXRoIG1hcCBtYXRjaGluZyBzdXBwb3J0KVxuICAgIGNvbnN0IGpvdXJuZXlzRnVuY3Rpb24gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0pvdXJuZXlzRnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hcGktam91cm5leXMnLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBKb3VybmV5cyBBUEknLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hcGktam91cm5leXMvaW5kZXgudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIEpPVVJORVlTX1RBQkxFOiBwcm9wcy5qb3VybmV5c1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgTE9DQVRJT05TX1RBQkxFOiBwcm9wcy5sb2NhdGlvbnNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIERFVklDRVNfVEFCTEU6IHByb3BzLmRldmljZXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIFRFTEVNRVRSWV9UQUJMRTogcHJvcHMudGVsZW1ldHJ5VGFibGUudGFibGVOYW1lLFxuICAgICAgICBERVZJQ0VfQUxJQVNFU19UQUJMRTogcHJvcHMuZGV2aWNlQWxpYXNlc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgTUFQQk9YX1RPS0VOOiAncGsuZXlKMUlqb2lZbkpoYm1SdmJuTmhkSEp2YlNJc0ltRWlPaUpqYldwaGIyb3lhVzh3TjJrM00zQndkM2xyZG5wak9IaHRJbjAuU3ljMEdNX2lhM0R6N0hyZVE2LUltUScsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcbiAgICBwcm9wcy5qb3VybmV5c1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShqb3VybmV5c0Z1bmN0aW9uKTsgLy8gTmVlZCB3cml0ZSBmb3IgbWF0Y2hlZF9yb3V0ZSBhbmQgZGVsZXRlXG4gICAgcHJvcHMubG9jYXRpb25zVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGpvdXJuZXlzRnVuY3Rpb24pOyAvLyBOZWVkIHdyaXRlIGZvciBjYXNjYWRlIGRlbGV0ZVxuICAgIHByb3BzLmRldmljZXNUYWJsZS5ncmFudFJlYWREYXRhKGpvdXJuZXlzRnVuY3Rpb24pOyAvLyBOZWVkIHJlYWQgZm9yIG93bmVyIGNoZWNrXG4gICAgcHJvcHMudGVsZW1ldHJ5VGFibGUuZ3JhbnRSZWFkRGF0YShqb3VybmV5c0Z1bmN0aW9uKTsgLy8gTmVlZCByZWFkIGZvciBwb3dlciBjb25zdW1wdGlvblxuICAgIHByb3BzLmRldmljZUFsaWFzZXNUYWJsZS5ncmFudFJlYWREYXRhKGpvdXJuZXlzRnVuY3Rpb24pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBIVFRQIEFQSSBHYXRld2F5XG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLmFwaSA9IG5ldyBhcGlnYXRld2F5Lkh0dHBBcGkodGhpcywgJ0FwaScsIHtcbiAgICAgIGFwaU5hbWU6ICdzb25nYmlyZC1hcGknLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBEZW1vIFBsYXRmb3JtIEFQSScsXG4gICAgICBjb3JzUHJlZmxpZ2h0OiB7XG4gICAgICAgIGFsbG93T3JpZ2luczogWycqJ10sXG4gICAgICAgIGFsbG93TWV0aG9kczogW1xuICAgICAgICAgIGFwaWdhdGV3YXkuQ29yc0h0dHBNZXRob2QuR0VULFxuICAgICAgICAgIGFwaWdhdGV3YXkuQ29yc0h0dHBNZXRob2QuUE9TVCxcbiAgICAgICAgICBhcGlnYXRld2F5LkNvcnNIdHRwTWV0aG9kLlBVVCxcbiAgICAgICAgICBhcGlnYXRld2F5LkNvcnNIdHRwTWV0aG9kLlBBVENILFxuICAgICAgICAgIGFwaWdhdGV3YXkuQ29yc0h0dHBNZXRob2QuREVMRVRFLFxuICAgICAgICAgIGFwaWdhdGV3YXkuQ29yc0h0dHBNZXRob2QuT1BUSU9OUyxcbiAgICAgICAgXSxcbiAgICAgICAgYWxsb3dIZWFkZXJzOiBbJ0NvbnRlbnQtVHlwZScsICdBdXRob3JpemF0aW9uJ10sXG4gICAgICAgIG1heEFnZTogY2RrLkR1cmF0aW9uLmRheXMoMSksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gQ29nbml0byBKV1QgQXV0aG9yaXplclxuICAgIGNvbnN0IGF1dGhvcml6ZXIgPSBuZXcgYXBpZ2F0ZXdheUF1dGhvcml6ZXJzLkh0dHBVc2VyUG9vbEF1dGhvcml6ZXIoXG4gICAgICAnQ29nbml0b0F1dGhvcml6ZXInLFxuICAgICAgcHJvcHMudXNlclBvb2wsXG4gICAgICB7XG4gICAgICAgIHVzZXJQb29sQ2xpZW50czogW3Byb3BzLnVzZXJQb29sQ2xpZW50XSxcbiAgICAgICAgaWRlbnRpdHlTb3VyY2U6IFsnJHJlcXVlc3QuaGVhZGVyLkF1dGhvcml6YXRpb24nXSxcbiAgICAgIH1cbiAgICApO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBBUEkgUm91dGVzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIERldmljZXMgZW5kcG9pbnRzXG4gICAgY29uc3QgZGV2aWNlc0ludGVncmF0aW9uID0gbmV3IGFwaWdhdGV3YXlJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFxuICAgICAgJ0RldmljZXNJbnRlZ3JhdGlvbicsXG4gICAgICBkZXZpY2VzRnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZGV2aWNlcycsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogZGV2aWNlc0ludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2RldmljZXMve3NlcmlhbF9udW1iZXJ9JyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VULCBhcGlnYXRld2F5Lkh0dHBNZXRob2QuUEFUQ0hdLFxuICAgICAgaW50ZWdyYXRpb246IGRldmljZXNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBUZWxlbWV0cnkgZW5kcG9pbnRzXG4gICAgY29uc3QgdGVsZW1ldHJ5SW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheUludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAnVGVsZW1ldHJ5SW50ZWdyYXRpb24nLFxuICAgICAgdGVsZW1ldHJ5RnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vdGVsZW1ldHJ5JyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiB0ZWxlbWV0cnlJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9sb2NhdGlvbicsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogdGVsZW1ldHJ5SW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vcG93ZXInLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5HRVRdLFxuICAgICAgaW50ZWdyYXRpb246IHRlbGVtZXRyeUludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2hlYWx0aCcsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogdGVsZW1ldHJ5SW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgLy8gQ29tbWFuZHMgZW5kcG9pbnRzXG4gICAgY29uc3QgY29tbWFuZHNJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnYXRld2F5SW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICdDb21tYW5kc0ludGVncmF0aW9uJyxcbiAgICAgIGNvbW1hbmRzRnVuY3Rpb25cbiAgICApO1xuXG4gICAgLy8gQWxsIGNvbW1hbmRzIGVuZHBvaW50IChmbGVldC13aWRlKVxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2NvbW1hbmRzJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiBjb21tYW5kc0ludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIC8vIERlbGV0ZSBjb21tYW5kIGVuZHBvaW50XG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvY29tbWFuZHMve2NvbW1hbmRfaWR9JyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuREVMRVRFXSxcbiAgICAgIGludGVncmF0aW9uOiBjb21tYW5kc0ludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIC8vIERldmljZS1zcGVjaWZpYyBjb21tYW5kc1xuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2NvbW1hbmRzJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VULCBhcGlnYXRld2F5Lkh0dHBNZXRob2QuUE9TVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogY29tbWFuZHNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBDb25maWcgZW5kcG9pbnRzXG4gICAgY29uc3QgY29uZmlnSW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheUludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAnQ29uZmlnSW50ZWdyYXRpb24nLFxuICAgICAgY29uZmlnRnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vY29uZmlnJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VULCBhcGlnYXRld2F5Lkh0dHBNZXRob2QuUFVUXSxcbiAgICAgIGludGVncmF0aW9uOiBjb25maWdJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS9mbGVldHMve2ZsZWV0X3VpZH0vY29uZmlnJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuUFVUXSxcbiAgICAgIGludGVncmF0aW9uOiBjb25maWdJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBBbGVydHMgZW5kcG9pbnRzXG4gICAgY29uc3QgYWxlcnRzSW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheUludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAnQWxlcnRzSW50ZWdyYXRpb24nLFxuICAgICAgYWxlcnRzRnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvYWxlcnRzJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiBhbGVydHNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS9hbGVydHMve2FsZXJ0X2lkfScsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogYWxlcnRzSW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvYWxlcnRzL3thbGVydF9pZH0vYWNrbm93bGVkZ2UnLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5QT1NUXSxcbiAgICAgIGludGVncmF0aW9uOiBhbGVydHNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBBY3Rpdml0eSBmZWVkIGVuZHBvaW50XG4gICAgY29uc3QgYWN0aXZpdHlJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnYXRld2F5SW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICdBY3Rpdml0eUludGVncmF0aW9uJyxcbiAgICAgIGFjdGl2aXR5RnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvYWN0aXZpdHknLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5HRVRdLFxuICAgICAgaW50ZWdyYXRpb246IGFjdGl2aXR5SW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgLy8gU2V0dGluZ3MgZW5kcG9pbnRzXG4gICAgY29uc3Qgc2V0dGluZ3NJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnYXRld2F5SW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICdTZXR0aW5nc0ludGVncmF0aW9uJyxcbiAgICAgIHNldHRpbmdzRnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvc2V0dGluZ3MvZmxlZXQtZGVmYXVsdHMnLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5HRVRdLFxuICAgICAgaW50ZWdyYXRpb246IHNldHRpbmdzSW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvc2V0dGluZ3MvZmxlZXQtZGVmYXVsdHMve2ZsZWV0fScsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVCwgYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLlBVVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogc2V0dGluZ3NJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBVc2VycyBlbmRwb2ludHMgKGFkbWluIG9ubHkgLSBlbmZvcmNlZCBpbiBMYW1iZGEpXG4gICAgY29uc3QgdXNlcnNJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnYXRld2F5SW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICdVc2Vyc0ludGVncmF0aW9uJyxcbiAgICAgIHVzZXJzRnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvdXNlcnMnLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5HRVQsIGFwaWdhdGV3YXkuSHR0cE1ldGhvZC5QT1NUXSxcbiAgICAgIGludGVncmF0aW9uOiB1c2Vyc0ludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL3VzZXJzL2dyb3VwcycsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogdXNlcnNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS91c2Vycy97dXNlcklkfScsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogdXNlcnNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS91c2Vycy97dXNlcklkfS9ncm91cHMnLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5QVVRdLFxuICAgICAgaW50ZWdyYXRpb246IHVzZXJzSW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvdXNlcnMve3VzZXJJZH0vZGV2aWNlcycsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLlBVVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogdXNlcnNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBTaW5nbGUgZGV2aWNlIGFzc2lnbm1lbnQgKGVhY2ggdXNlciBjYW4gb25seSBoYXZlIG9uZSBkZXZpY2UpXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvdXNlcnMve3VzZXJJZH0vZGV2aWNlJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuUFVUXSxcbiAgICAgIGludGVncmF0aW9uOiB1c2Vyc0ludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIC8vIFVuYXNzaWduZWQgZGV2aWNlcyBlbmRwb2ludCAoZm9yIGRldmljZSBhc3NpZ25tZW50IGRyb3Bkb3duKVxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2RldmljZXMvdW5hc3NpZ25lZCcsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogdXNlcnNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBOb3RlaHViIHN0YXR1cyBlbmRwb2ludHNcbiAgICBjb25zdCBub3RlaHViSW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheUludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAnTm90ZWh1YkludGVncmF0aW9uJyxcbiAgICAgIG5vdGVodWJGdW5jdGlvblxuICAgICk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS9ub3RlaHViL3N0YXR1cycsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogbm90ZWh1YkludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL25vdGVodWIvZmxlZXRzJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiBub3RlaHViSW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgLy8gRXZlbnQgaW5nZXN0IGVuZHBvaW50IChubyBhdXRoIC0gY2FsbGVkIGJ5IE5vdGVodWIpXG4gICAgY29uc3QgaW5nZXN0SW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheUludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAnSW5nZXN0SW50ZWdyYXRpb24nLFxuICAgICAgaW5nZXN0RnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvaW5nZXN0JyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuUE9TVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogaW5nZXN0SW50ZWdyYXRpb24sXG4gICAgICAvLyBObyBhdXRob3JpemVyIC0gTm90ZWh1YiBIVFRQIHJvdXRlcyBkb24ndCBzdXBwb3J0IENvZ25pdG8gYXV0aFxuICAgIH0pO1xuXG4gICAgLy8gSm91cm5leXMgZW5kcG9pbnRzXG4gICAgY29uc3Qgam91cm5leXNJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnYXRld2F5SW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICdKb3VybmV5c0ludGVncmF0aW9uJyxcbiAgICAgIGpvdXJuZXlzRnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vam91cm5leXMnLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5HRVRdLFxuICAgICAgaW50ZWdyYXRpb246IGpvdXJuZXlzSW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZGV2aWNlcy97c2VyaWFsX251bWJlcn0vam91cm5leXMve2pvdXJuZXlfaWR9JyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VULCBhcGlnYXRld2F5Lkh0dHBNZXRob2QuREVMRVRFXSxcbiAgICAgIGludGVncmF0aW9uOiBqb3VybmV5c0ludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIC8vIE1hcCBtYXRjaGluZyBlbmRwb2ludCBmb3Igam91cm5leXNcbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS9kZXZpY2VzL3tzZXJpYWxfbnVtYmVyfS9qb3VybmV5cy97am91cm5leV9pZH0vbWF0Y2gnLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5QT1NUXSxcbiAgICAgIGludGVncmF0aW9uOiBqb3VybmV5c0ludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2RldmljZXMve3NlcmlhbF9udW1iZXJ9L2xvY2F0aW9ucycsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogam91cm5leXNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBTdG9yZSBBUEkgVVJMXG4gICAgdGhpcy5hcGlVcmwgPSB0aGlzLmFwaS51cmwhO1xuICAgIHRoaXMuaW5nZXN0VXJsID0gYCR7dGhpcy5hcGkudXJsfXYxL2luZ2VzdGA7XG4gIH1cbn1cbiJdfQ==