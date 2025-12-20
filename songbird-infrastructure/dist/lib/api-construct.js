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
            },
            bundling: { minify: true, sourceMap: true },
            logRetention: logs.RetentionDays.TWO_WEEKS,
        });
        props.devicesTable.grantReadWriteData(devicesFunction);
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
            },
            bundling: { minify: true, sourceMap: true },
            logRetention: logs.RetentionDays.TWO_WEEKS,
        });
        props.telemetryTable.grantReadData(telemetryFunction);
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
            },
            bundling: { minify: true, sourceMap: true },
            logRetention: logs.RetentionDays.TWO_WEEKS,
        });
        commandsTable.grantReadWriteData(commandsFunction);
        notehubSecret.grantRead(commandsFunction);
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
            },
            bundling: { minify: true, sourceMap: true },
            logRetention: logs.RetentionDays.TWO_WEEKS,
        });
        props.alertsTable.grantReadWriteData(alertsFunction);
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
            },
            bundling: { minify: true, sourceMap: true },
            logRetention: logs.RetentionDays.TWO_WEEKS,
        });
        props.telemetryTable.grantReadData(activityFunction);
        props.alertsTable.grantReadData(activityFunction);
        props.devicesTable.grantReadData(activityFunction);
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
            },
            bundling: { minify: true, sourceMap: true },
            logRetention: logs.RetentionDays.TWO_WEEKS,
        });
        props.settingsTable.grantReadWriteData(settingsFunction);
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
            },
            bundling: { minify: true, sourceMap: true },
            logRetention: logs.RetentionDays.TWO_WEEKS,
        });
        props.telemetryTable.grantReadWriteData(ingestFunction);
        props.devicesTable.grantReadWriteData(ingestFunction);
        commandsTable.grantReadWriteData(ingestFunction);
        props.alertsTable.grantReadWriteData(ingestFunction);
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
            path: '/v1/devices/{device_uid}',
            methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.PATCH],
            integration: devicesIntegration,
            authorizer,
        });
        // Telemetry endpoints
        const telemetryIntegration = new apigatewayIntegrations.HttpLambdaIntegration('TelemetryIntegration', telemetryFunction);
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
        this.api.addRoutes({
            path: '/v1/devices/{device_uid}/health',
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
            path: '/v1/devices/{device_uid}/commands',
            methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.POST],
            integration: commandsIntegration,
            authorizer,
        });
        // Config endpoints
        const configIntegration = new apigatewayIntegrations.HttpLambdaIntegration('ConfigIntegration', configFunction);
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
        // Store API URL
        this.apiUrl = this.api.url;
        this.ingestUrl = `${this.api.url}v1/ingest`;
    }
}
exports.ApiConstruct = ApiConstruct;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBpLWNvbnN0cnVjdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL2xpYi9hcGktY29uc3RydWN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7R0FRRzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFFSCxpREFBbUM7QUFDbkMseUVBQTJEO0FBQzNELGtHQUFvRjtBQUNwRixnR0FBa0Y7QUFDbEYsK0RBQWlEO0FBR2pELG1FQUFxRDtBQUNyRCwyREFBNkM7QUFDN0MsK0VBQWlFO0FBQ2pFLHFFQUErRDtBQUMvRCwyQ0FBdUM7QUFDdkMsMkNBQTZCO0FBYTdCLE1BQWEsWUFBYSxTQUFRLHNCQUFTO0lBQ3pCLEdBQUcsQ0FBcUI7SUFDeEIsTUFBTSxDQUFTO0lBQ2YsU0FBUyxDQUFTO0lBRWxDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBd0I7UUFDaEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQiw2RUFBNkU7UUFDN0UsdUNBQXVDO1FBQ3ZDLDZFQUE2RTtRQUM3RSxNQUFNLGFBQWEsR0FBRyxJQUFJLFFBQVEsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLGVBQWUsRUFBRTtZQUM5RCxTQUFTLEVBQUUsbUJBQW1CO1lBQzlCLFlBQVksRUFBRSxFQUFFLElBQUksRUFBRSxZQUFZLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFO1lBQ3pFLE9BQU8sRUFBRSxFQUFFLElBQUksRUFBRSxZQUFZLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFO1lBQ3BFLFdBQVcsRUFBRSxRQUFRLENBQUMsV0FBVyxDQUFDLGVBQWU7WUFDakQsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTztZQUN4QyxtQkFBbUIsRUFBRSxLQUFLO1NBQzNCLENBQUMsQ0FBQztRQUVILDZDQUE2QztRQUM3QyxhQUFhLENBQUMsdUJB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Q0FBQyxHQUFHLENBQUM7WUFDcEMsV0FBVyxFQUFFLGtCQUFrQjtZQUMvQixVQUFVO1NBQ1gsQ0FBQyxDQUFDO1FBRUgsc0RBQXNEO1FBQ3RELE1BQU0saUJBQWlCLEdBQUcsSUFBSSxzQkFBc0IsQ0FBQyxxQkFBcUIsQ0FDeEUsbUJBQW1CLEVBQ25CLGNBQWMsQ0FDZixDQUFDO1FBRUYsSUFBSSxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUM7WUFDakIsSUFBSSxFQUFFLFlBQVk7WUFDbEIsT0FBTyxFQUFFLENBQUMsVUFBVSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUM7WUFDckMsV0FBVyxFQUFFLGlCQUFpQjtZQUM5QixpRUFBaUU7U0FDbEUsQ0FBQyxDQUFDO1FBRUgsZ0JBQWdCO1FBQ2hCLElBQUksQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFJLENBQUM7UUFDNUIsSUFBSSxDQUFDLFNBQVMsR0FBRyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxXQUFXLENBQUM7SUFDOUMsQ0FBQztDQUNGO0FBN2dCRCxvQ0E2Z0JDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBBUEkgQ29uc3RydWN0XG4gKlxuICogRGVmaW5lcyBBUEkgR2F0ZXdheSBIVFRQIEFQSSBhbmQgTGFtYmRhIGludGVncmF0aW9ucyBmb3I6XG4gKiAtIERldmljZSBtYW5hZ2VtZW50XG4gKiAtIFRlbGVtZXRyeSBxdWVyaWVzXG4gKiAtIENvbmZpZ3VyYXRpb24gbWFuYWdlbWVudFxuICogLSBDb21tYW5kIHNlbmRpbmdcbiAqL1xuXG5pbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgYXBpZ2F0ZXdheSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyJztcbmltcG9ydCAqIGFzIGFwaWdhdGV3YXlJbnRlZ3JhdGlvbnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnMnO1xuaW1wb3J0ICogYXMgYXBpZ2F0ZXdheUF1dGhvcml6ZXJzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItYXV0aG9yaXplcnMnO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0ICogYXMgc25zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zbnMnO1xuaW1wb3J0ICogYXMgY29nbml0byBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY29nbml0byc7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGInO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgKiBhcyBzZWNyZXRzbWFuYWdlciBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc2VjcmV0c21hbmFnZXInO1xuaW1wb3J0IHsgTm9kZWpzRnVuY3Rpb24gfSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhLW5vZGVqcyc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBpQ29uc3RydWN0UHJvcHMge1xuICB0ZWxlbWV0cnlUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIGRldmljZXNUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIGFsZXJ0c1RhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbiAgc2V0dGluZ3NUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIHVzZXJQb29sOiBjb2duaXRvLlVzZXJQb29sO1xuICB1c2VyUG9vbENsaWVudDogY29nbml0by5Vc2VyUG9vbENsaWVudDtcbiAgbm90ZWh1YlByb2plY3RVaWQ6IHN0cmluZztcbiAgYWxlcnRUb3BpYzogc25zLklUb3BpYztcbn1cblxuZXhwb3J0IGNsYXNzIEFwaUNvbnN0cnVjdCBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBhcGk6IGFwaWdhdGV3YXkuSHR0cEFwaTtcbiAgcHVibGljIHJlYWRvbmx5IGFwaVVybDogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgaW5nZXN0VXJsOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwaUNvbnN0cnVjdFByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ29tbWFuZHMgVGFibGUgKGZvciBjb21tYW5kIGhpc3RvcnkpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBjb21tYW5kc1RhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdDb21tYW5kc1RhYmxlJywge1xuICAgICAgdGFibGVOYW1lOiAnc29uZ2JpcmQtY29tbWFuZHMnLFxuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6ICdkZXZpY2VfdWlkJywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHNvcnRLZXk6IHsgbmFtZTogJ2NvbW1hbmRfaWQnLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiAndHRsJyxcbiAgICB9KTtcblxuICAgIC8vIEdTSSBmb3IgcXVlcnlpbmcgY29tbWFuZHMgYnkgY3JlYXRpb24gdGltZVxuICAgIGNvbW1hbmRzVGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xuICAgICAgaW5kZXhOYW1lOiAnZGV2aWNlLWNyZWF0ZWQtaW5kZXgnLFxuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6ICdkZXZpY2VfdWlkJywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHNvcnRLZXk6IHsgbmFtZTogJ2NyZWF0ZWRfYXQnLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLk5VTUJFUiB9LFxuICAgICAgcHJvamVjdGlvblR5cGU6IGR5bmFtb2RiLlByb2plY3Rpb25UeXBlLkFMTCxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTm90ZWh1YiBBUEkgVG9rZW4gU2VjcmV0XG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBOb3RlOiBUaGlzIHNlY3JldCBzaG91bGQgYmUgY3JlYXRlZCBtYW51YWxseSB3aXRoIHRoZSBhY3R1YWwgdG9rZW5cbiAgICBjb25zdCBub3RlaHViU2VjcmV0ID0gbmV3IHNlY3JldHNtYW5hZ2VyLlNlY3JldCh0aGlzLCAnTm90ZWh1YkFwaVRva2VuJywge1xuICAgICAgc2VjcmV0TmFtZTogJ3NvbmdiaXJkL25vdGVodWItYXBpLXRva2VuJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnTm90ZWh1YiBBUEkgdG9rZW4gZm9yIFNvbmdiaXJkJyxcbiAgICAgIGdlbmVyYXRlU2VjcmV0U3RyaW5nOiB7XG4gICAgICAgIHNlY3JldFN0cmluZ1RlbXBsYXRlOiBKU09OLnN0cmluZ2lmeSh7IHBsYWNlaG9sZGVyOiAnUkVQTEFDRV9XSVRIX0FDVFVBTF9UT0tFTicgfSksXG4gICAgICAgIGdlbmVyYXRlU3RyaW5nS2V5OiAndG9rZW4nLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTGFtYmRhIEZ1bmN0aW9uc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvLyBEZXZpY2VzIEFQSVxuICAgIGNvbnN0IGRldmljZXNGdW5jdGlvbiA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnRGV2aWNlc0Z1bmN0aW9uJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYXBpLWRldmljZXMnLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBEZXZpY2VzIEFQSScsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FwaS1kZXZpY2VzL2luZGV4LnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBERVZJQ0VTX1RBQkxFOiBwcm9wcy5kZXZpY2VzVGFibGUudGFibGVOYW1lLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG4gICAgcHJvcHMuZGV2aWNlc1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShkZXZpY2VzRnVuY3Rpb24pO1xuXG4gICAgLy8gVGVsZW1ldHJ5IEFQSVxuICAgIGNvbnN0IHRlbGVtZXRyeUZ1bmN0aW9uID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdUZWxlbWV0cnlGdW5jdGlvbicsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFwaS10ZWxlbWV0cnknLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBUZWxlbWV0cnkgQVBJJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYXBpLXRlbGVtZXRyeS9pbmRleC50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgVEVMRU1FVFJZX1RBQkxFOiBwcm9wcy50ZWxlbWV0cnlUYWJsZS50YWJsZU5hbWUsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcbiAgICBwcm9wcy50ZWxlbWV0cnlUYWJsZS5ncmFudFJlYWREYXRhKHRlbGVtZXRyeUZ1bmN0aW9uKTtcblxuICAgIC8vIENvbW1hbmRzIEFQSVxuICAgIGNvbnN0IGNvbW1hbmRzRnVuY3Rpb24gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0NvbW1hbmRzRnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hcGktY29tbWFuZHMnLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBDb21tYW5kcyBBUEknLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hcGktY29tbWFuZHMvaW5kZXgudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIENPTU1BTkRTX1RBQkxFOiBjb21tYW5kc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgTk9URUhVQl9QUk9KRUNUX1VJRDogcHJvcHMubm90ZWh1YlByb2plY3RVaWQsXG4gICAgICAgIE5PVEVIVUJfU0VDUkVUX0FSTjogbm90ZWh1YlNlY3JldC5zZWNyZXRBcm4sXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcbiAgICBjb21tYW5kc1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShjb21tYW5kc0Z1bmN0aW9uKTtcbiAgICBub3RlaHViU2VjcmV0LmdyYW50UmVhZChjb21tYW5kc0Z1bmN0aW9uKTtcblxuICAgIC8vIENvbmZpZyBBUElcbiAgICBjb25zdCBjb25maWdGdW5jdGlvbiA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnQ29uZmlnRnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hcGktY29uZmlnJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgQ29uZmlnIEFQSScsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FwaS1jb25maWcvaW5kZXgudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIE5PVEVIVUJfUFJPSkVDVF9VSUQ6IHByb3BzLm5vdGVodWJQcm9qZWN0VWlkLFxuICAgICAgICBOT1RFSFVCX1NFQ1JFVF9BUk46IG5vdGVodWJTZWNyZXQuc2VjcmV0QXJuLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG4gICAgbm90ZWh1YlNlY3JldC5ncmFudFJlYWQoY29uZmlnRnVuY3Rpb24pO1xuXG4gICAgLy8gQWxlcnRzIEFQSVxuICAgIGNvbnN0IGFsZXJ0c0Z1bmN0aW9uID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdBbGVydHNGdW5jdGlvbicsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFwaS1hbGVydHMnLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBBbGVydHMgQVBJJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYXBpLWFsZXJ0cy9pbmRleC50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQUxFUlRTX1RBQkxFOiBwcm9wcy5hbGVydHNUYWJsZS50YWJsZU5hbWUsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcbiAgICBwcm9wcy5hbGVydHNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoYWxlcnRzRnVuY3Rpb24pO1xuXG4gICAgLy8gQWN0aXZpdHkgRmVlZCBBUElcbiAgICBjb25zdCBhY3Rpdml0eUZ1bmN0aW9uID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdBY3Rpdml0eUZ1bmN0aW9uJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYXBpLWFjdGl2aXR5JyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgQWN0aXZpdHkgRmVlZCBBUEknLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hcGktYWN0aXZpdHkvaW5kZXgudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFRFTEVNRVRSWV9UQUJMRTogcHJvcHMudGVsZW1ldHJ5VGFibGUudGFibGVOYW1lLFxuICAgICAgICBBTEVSVFNfVEFCTEU6IHByb3BzLmFsZXJ0c1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgREVWSUNFU19UQUJMRTogcHJvcHMuZGV2aWNlc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuICAgIHByb3BzLnRlbGVtZXRyeVRhYmxlLmdyYW50UmVhZERhdGEoYWN0aXZpdHlGdW5jdGlvbik7XG4gICAgcHJvcHMuYWxlcnRzVGFibGUuZ3JhbnRSZWFkRGF0YShhY3Rpdml0eUZ1bmN0aW9uKTtcbiAgICBwcm9wcy5kZXZpY2VzVGFibGUuZ3JhbnRSZWFkRGF0YShhY3Rpdml0eUZ1bmN0aW9uKTtcblxuICAgIC8vIFNldHRpbmdzIEFQSVxuICAgIGNvbnN0IHNldHRpbmdzRnVuY3Rpb24gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ1NldHRpbmdzRnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hcGktc2V0dGluZ3MnLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBTZXR0aW5ncyBBUEknLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hcGktc2V0dGluZ3MvaW5kZXgudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFNFVFRJTkdTX1RBQkxFOiBwcm9wcy5zZXR0aW5nc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuICAgIHByb3BzLnNldHRpbmdzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHNldHRpbmdzRnVuY3Rpb24pO1xuXG4gICAgLy8gVXNlcnMgQVBJIChBZG1pbiBvcGVyYXRpb25zKVxuICAgIGNvbnN0IHVzZXJzRnVuY3Rpb24gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ1VzZXJzRnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hcGktdXNlcnMnLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBVc2VycyBBUEknLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hcGktdXNlcnMvaW5kZXgudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFVTRVJfUE9PTF9JRDogcHJvcHMudXNlclBvb2wudXNlclBvb2xJZCxcbiAgICAgICAgREVWSUNFU19UQUJMRTogcHJvcHMuZGV2aWNlc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuICAgIHByb3BzLmRldmljZXNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEodXNlcnNGdW5jdGlvbik7XG4gICAgLy8gR3JhbnQgQ29nbml0byBhZG1pbiBwZXJtaXNzaW9uc1xuICAgIHVzZXJzRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KG5ldyBjZGsuYXdzX2lhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBjZGsuYXdzX2lhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdjb2duaXRvLWlkcDpMaXN0VXNlcnMnLFxuICAgICAgICAnY29nbml0by1pZHA6QWRtaW5DcmVhdGVVc2VyJyxcbiAgICAgICAgJ2NvZ25pdG8taWRwOkFkbWluR2V0VXNlcicsXG4gICAgICAgICdjb2duaXRvLWlkcDpBZG1pblVwZGF0ZVVzZXJBdHRyaWJ1dGVzJyxcbiAgICAgICAgJ2NvZ25pdG8taWRwOkFkbWluQWRkVXNlclRvR3JvdXAnLFxuICAgICAgICAnY29nbml0by1pZHA6QWRtaW5SZW1vdmVVc2VyRnJvbUdyb3VwJyxcbiAgICAgICAgJ2NvZ25pdG8taWRwOkFkbWluTGlzdEdyb3Vwc0ZvclVzZXInLFxuICAgICAgICAnY29nbml0by1pZHA6TGlzdEdyb3VwcycsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbcHJvcHMudXNlclBvb2wudXNlclBvb2xBcm5dLFxuICAgIH0pKTtcblxuICAgIC8vIE5vdGVodWIgU3RhdHVzIEFQSVxuICAgIGNvbnN0IG5vdGVodWJGdW5jdGlvbiA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnTm90ZWh1YkZ1bmN0aW9uJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYXBpLW5vdGVodWInLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBOb3RlaHViIFN0YXR1cyBBUEknLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hcGktbm90ZWh1Yi9pbmRleC50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgTk9URUhVQl9QUk9KRUNUX1VJRDogcHJvcHMubm90ZWh1YlByb2plY3RVaWQsXG4gICAgICAgIE5PVEVIVUJfU0VDUkVUX0FSTjogbm90ZWh1YlNlY3JldC5zZWNyZXRBcm4sXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcbiAgICBub3RlaHViU2VjcmV0LmdyYW50UmVhZChub3RlaHViRnVuY3Rpb24pO1xuXG4gICAgLy8gRXZlbnQgSW5nZXN0IEFQSSAoZm9yIE5vdGVodWIgSFRUUCByb3V0ZSAtIG5vIGF1dGhlbnRpY2F0aW9uKVxuICAgIGNvbnN0IGluZ2VzdEZ1bmN0aW9uID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdJbmdlc3RGdW5jdGlvbicsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFwaS1pbmdlc3QnLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBFdmVudCBJbmdlc3QgQVBJIGZvciBOb3RlaHViIEhUVFAgcm91dGVzJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYXBpLWluZ2VzdC9pbmRleC50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgVEVMRU1FVFJZX1RBQkxFOiBwcm9wcy50ZWxlbWV0cnlUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIERFVklDRVNfVEFCTEU6IHByb3BzLmRldmljZXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIENPTU1BTkRTX1RBQkxFOiBjb21tYW5kc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgQUxFUlRTX1RBQkxFOiBwcm9wcy5hbGVydHNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIEFMRVJUX1RPUElDX0FSTjogcHJvcHMuYWxlcnRUb3BpYy50b3BpY0FybixcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuICAgIHByb3BzLnRlbGVtZXRyeVRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShpbmdlc3RGdW5jdGlvbik7XG4gICAgcHJvcHMuZGV2aWNlc1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShpbmdlc3RGdW5jdGlvbik7XG4gICAgY29tbWFuZHNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoaW5nZXN0RnVuY3Rpb24pO1xuICAgIHByb3BzLmFsZXJ0c1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShpbmdlc3RGdW5jdGlvbik7XG4gICAgcHJvcHMuYWxlcnRUb3BpYy5ncmFudFB1Ymxpc2goaW5nZXN0RnVuY3Rpb24pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBIVFRQIEFQSSBHYXRld2F5XG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLmFwaSA9IG5ldyBhcGlnYXRld2F5Lkh0dHBBcGkodGhpcywgJ0FwaScsIHtcbiAgICAgIGFwaU5hbWU6ICdzb25nYmlyZC1hcGknLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBEZW1vIFBsYXRmb3JtIEFQSScsXG4gICAgICBjb3JzUHJlZmxpZ2h0OiB7XG4gICAgICAgIGFsbG93T3JpZ2luczogWycqJ10sXG4gICAgICAgIGFsbG93TWV0aG9kczogW1xuICAgICAgICAgIGFwaWdhdGV3YXkuQ29yc0h0dHBNZXRob2QuR0VULFxuICAgICAgICAgIGFwaWdhdGV3YXkuQ29yc0h0dHBNZXRob2QuUE9TVCxcbiAgICAgICAgICBhcGlnYXRld2F5LkNvcnNIdHRwTWV0aG9kLlBVVCxcbiAgICAgICAgICBhcGlnYXRld2F5LkNvcnNIdHRwTWV0aG9kLlBBVENILFxuICAgICAgICAgIGFwaWdhdGV3YXkuQ29yc0h0dHBNZXRob2QuREVMRVRFLFxuICAgICAgICAgIGFwaWdhdGV3YXkuQ29yc0h0dHBNZXRob2QuT1BUSU9OUyxcbiAgICAgICAgXSxcbiAgICAgICAgYWxsb3dIZWFkZXJzOiBbJ0NvbnRlbnQtVHlwZScsICdBdXRob3JpemF0aW9uJ10sXG4gICAgICAgIG1heEFnZTogY2RrLkR1cmF0aW9uLmRheXMoMSksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gQ29nbml0byBKV1QgQXV0aG9yaXplclxuICAgIGNvbnN0IGF1dGhvcml6ZXIgPSBuZXcgYXBpZ2F0ZXdheUF1dGhvcml6ZXJzLkh0dHBVc2VyUG9vbEF1dGhvcml6ZXIoXG4gICAgICAnQ29nbml0b0F1dGhvcml6ZXInLFxuICAgICAgcHJvcHMudXNlclBvb2wsXG4gICAgICB7XG4gICAgICAgIHVzZXJQb29sQ2xpZW50czogW3Byb3BzLnVzZXJQb29sQ2xpZW50XSxcbiAgICAgICAgaWRlbnRpdHlTb3VyY2U6IFsnJHJlcXVlc3QuaGVhZGVyLkF1dGhvcml6YXRpb24nXSxcbiAgICAgIH1cbiAgICApO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBBUEkgUm91dGVzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIERldmljZXMgZW5kcG9pbnRzXG4gICAgY29uc3QgZGV2aWNlc0ludGVncmF0aW9uID0gbmV3IGFwaWdhdGV3YXlJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFxuICAgICAgJ0RldmljZXNJbnRlZ3JhdGlvbicsXG4gICAgICBkZXZpY2VzRnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZGV2aWNlcycsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogZGV2aWNlc0ludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2RldmljZXMve2RldmljZV91aWR9JyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VULCBhcGlnYXRld2F5Lkh0dHBNZXRob2QuUEFUQ0hdLFxuICAgICAgaW50ZWdyYXRpb246IGRldmljZXNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBUZWxlbWV0cnkgZW5kcG9pbnRzXG4gICAgY29uc3QgdGVsZW1ldHJ5SW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheUludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAnVGVsZW1ldHJ5SW50ZWdyYXRpb24nLFxuICAgICAgdGVsZW1ldHJ5RnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZGV2aWNlcy97ZGV2aWNlX3VpZH0vdGVsZW1ldHJ5JyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiB0ZWxlbWV0cnlJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS9kZXZpY2VzL3tkZXZpY2VfdWlkfS9sb2NhdGlvbicsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogdGVsZW1ldHJ5SW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZGV2aWNlcy97ZGV2aWNlX3VpZH0vcG93ZXInLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5HRVRdLFxuICAgICAgaW50ZWdyYXRpb246IHRlbGVtZXRyeUludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2RldmljZXMve2RldmljZV91aWR9L2hlYWx0aCcsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogdGVsZW1ldHJ5SW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgLy8gQ29tbWFuZHMgZW5kcG9pbnRzXG4gICAgY29uc3QgY29tbWFuZHNJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnYXRld2F5SW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICdDb21tYW5kc0ludGVncmF0aW9uJyxcbiAgICAgIGNvbW1hbmRzRnVuY3Rpb25cbiAgICApO1xuXG4gICAgLy8gQWxsIGNvbW1hbmRzIGVuZHBvaW50IChmbGVldC13aWRlKVxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2NvbW1hbmRzJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiBjb21tYW5kc0ludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIC8vIERlbGV0ZSBjb21tYW5kIGVuZHBvaW50XG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvY29tbWFuZHMve2NvbW1hbmRfaWR9JyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuREVMRVRFXSxcbiAgICAgIGludGVncmF0aW9uOiBjb21tYW5kc0ludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIC8vIERldmljZS1zcGVjaWZpYyBjb21tYW5kc1xuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2RldmljZXMve2RldmljZV91aWR9L2NvbW1hbmRzJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VULCBhcGlnYXRld2F5Lkh0dHBNZXRob2QuUE9TVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogY29tbWFuZHNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBDb25maWcgZW5kcG9pbnRzXG4gICAgY29uc3QgY29uZmlnSW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheUludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAnQ29uZmlnSW50ZWdyYXRpb24nLFxuICAgICAgY29uZmlnRnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZGV2aWNlcy97ZGV2aWNlX3VpZH0vY29uZmlnJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VULCBhcGlnYXRld2F5Lkh0dHBNZXRob2QuUFVUXSxcbiAgICAgIGludGVncmF0aW9uOiBjb25maWdJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS9mbGVldHMve2ZsZWV0X3VpZH0vY29uZmlnJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuUFVUXSxcbiAgICAgIGludGVncmF0aW9uOiBjb25maWdJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBBbGVydHMgZW5kcG9pbnRzXG4gICAgY29uc3QgYWxlcnRzSW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheUludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAnQWxlcnRzSW50ZWdyYXRpb24nLFxuICAgICAgYWxlcnRzRnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvYWxlcnRzJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiBhbGVydHNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS9hbGVydHMve2FsZXJ0X2lkfScsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogYWxlcnRzSW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvYWxlcnRzL3thbGVydF9pZH0vYWNrbm93bGVkZ2UnLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5QT1NUXSxcbiAgICAgIGludGVncmF0aW9uOiBhbGVydHNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBBY3Rpdml0eSBmZWVkIGVuZHBvaW50XG4gICAgY29uc3QgYWN0aXZpdHlJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnYXRld2F5SW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICdBY3Rpdml0eUludGVncmF0aW9uJyxcbiAgICAgIGFjdGl2aXR5RnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvYWN0aXZpdHknLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5HRVRdLFxuICAgICAgaW50ZWdyYXRpb246IGFjdGl2aXR5SW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgLy8gU2V0dGluZ3MgZW5kcG9pbnRzXG4gICAgY29uc3Qgc2V0dGluZ3NJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnYXRld2F5SW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICdTZXR0aW5nc0ludGVncmF0aW9uJyxcbiAgICAgIHNldHRpbmdzRnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvc2V0dGluZ3MvZmxlZXQtZGVmYXVsdHMnLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5HRVRdLFxuICAgICAgaW50ZWdyYXRpb246IHNldHRpbmdzSW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvc2V0dGluZ3MvZmxlZXQtZGVmYXVsdHMve2ZsZWV0fScsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVCwgYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLlBVVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogc2V0dGluZ3NJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBVc2VycyBlbmRwb2ludHMgKGFkbWluIG9ubHkgLSBlbmZvcmNlZCBpbiBMYW1iZGEpXG4gICAgY29uc3QgdXNlcnNJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnYXRld2F5SW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICdVc2Vyc0ludGVncmF0aW9uJyxcbiAgICAgIHVzZXJzRnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvdXNlcnMnLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5HRVQsIGFwaWdhdGV3YXkuSHR0cE1ldGhvZC5QT1NUXSxcbiAgICAgIGludGVncmF0aW9uOiB1c2Vyc0ludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL3VzZXJzL2dyb3VwcycsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogdXNlcnNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS91c2Vycy97dXNlcklkfScsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogdXNlcnNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS91c2Vycy97dXNlcklkfS9ncm91cHMnLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5QVVRdLFxuICAgICAgaW50ZWdyYXRpb246IHVzZXJzSW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvdXNlcnMve3VzZXJJZH0vZGV2aWNlcycsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLlBVVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogdXNlcnNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBOb3RlaHViIHN0YXR1cyBlbmRwb2ludHNcbiAgICBjb25zdCBub3RlaHViSW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheUludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAnTm90ZWh1YkludGVncmF0aW9uJyxcbiAgICAgIG5vdGVodWJGdW5jdGlvblxuICAgICk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS9ub3RlaHViL3N0YXR1cycsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogbm90ZWh1YkludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL25vdGVodWIvZmxlZXRzJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiBub3RlaHViSW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgLy8gRXZlbnQgaW5nZXN0IGVuZHBvaW50IChubyBhdXRoIC0gY2FsbGVkIGJ5IE5vdGVodWIpXG4gICAgY29uc3QgaW5nZXN0SW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheUludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAnSW5nZXN0SW50ZWdyYXRpb24nLFxuICAgICAgaW5nZXN0RnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvaW5nZXN0JyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuUE9TVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogaW5nZXN0SW50ZWdyYXRpb24sXG4gICAgICAvLyBObyBhdXRob3JpemVyIC0gTm90ZWh1YiBIVFRQIHJvdXRlcyBkb24ndCBzdXBwb3J0IENvZ25pdG8gYXV0aFxuICAgIH0pO1xuXG4gICAgLy8gU3RvcmUgQVBJIFVSTFxuICAgIHRoaXMuYXBpVXJsID0gdGhpcy5hcGkudXJsITtcbiAgICB0aGlzLmluZ2VzdFVybCA9IGAke3RoaXMuYXBpLnVybH12MS9pbmdlc3RgO1xuICB9XG59XG4iXX0=