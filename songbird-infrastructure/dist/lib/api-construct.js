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
                NOTEHUB_API_TOKEN: notehubSecret.secretValueFromJson('token').unsafeUnwrap(),
            },
            bundling: { minify: true, sourceMap: true },
            logRetention: logs.RetentionDays.TWO_WEEKS,
        });
        commandsTable.grantReadWriteData(commandsFunction);
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
                NOTEHUB_API_TOKEN: notehubSecret.secretValueFromJson('token').unsafeUnwrap(),
            },
            bundling: { minify: true, sourceMap: true },
            logRetention: logs.RetentionDays.TWO_WEEKS,
        });
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
        // Commands endpoints
        const commandsIntegration = new apigatewayIntegrations.HttpLambdaIntegration('CommandsIntegration', commandsFunction);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBpLWNvbnN0cnVjdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL2xpYi9hcGktY29uc3RydWN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7R0FRRzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFFSCxpREFBbUM7QUFDbkMseUVBQTJEO0FBQzNELGtHQUFvRjtBQUNwRixnR0FBa0Y7QUFDbEYsK0RBQWlEO0FBR2pELG1FQUFxRDtBQUNyRCwyREFBNkM7QUFDN0MsK0VBQWlFO0FBQ2pFLHFFQUErRDtBQUMvRCwyQ0FBdUM7QUFDdkMsMkNBQTZCO0FBVzdCLE1BQWEsWUFBYSxTQUFRLHNCQUFTO0lBQ3pCLEdBQUcsQ0FBcUI7SUFDeEIsTUFBTSxDQUFTO0lBQ2YsU0FBUyxDQUFTO0lBRWxDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBd0I7UUFDaEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQiw2RUFBNkU7UUFDN0UsdUNBQXVDO1FBQ3ZDLDZFQUE2RTtRQUM3RSxNQUFNLGFBQWEsR0FBRyxJQUFJLFFBQVEsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLGVBQWUsRUFBRTtZQUM5RCxTQUFTLEVBQUUsbUJBQW1CO1lBQzlCLFlBQVksRUFBRSxFQUFFLElBQUksRUFBRSxZQUFZLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFO1lBQ3pFLE9BQU8sRUFBRSxFQUFFLElBQUksRUFBRSxZQUFZLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFO1lBQ3BFLFdBQVcsRUFBRSxRQUFRLENBQUMsV0FBVyxDQUFDLGVBQWU7WUFDakQsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTztZQUN4QyxtQkFBbUIsRUFBRSxLQUFLO1NBQzNCLENBQUMsQ0FBQztRQUVILDZFQUE2RTtRQUM3RSwyQkFBMkI7UUFDM0Is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QUFzQixDQUFDLHFCQUFxQixDQUN4RSxtQkFBbUIsRUFDbkIsY0FBYyxDQUNmLENBQUM7UUFFRixJQUFJLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQztZQUNqQixJQUFJLEVBQUUsaUNBQWlDO1lBQ3ZDLE9BQU8sRUFBRSxDQUFDLFVBQVUsQ0FBQyxVQUFVLENBQUMsR0FBRyxFQUFFLFVBQVUsQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDO1lBQy9ELFdBQVcsRUFBRSxpQkFBaUI7WUFDOUIsVUFBVTtTQUNYLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDO1lBQ2pCLElBQUksRUFBRSwrQkFBK0I7WUFDckMsT0FBTyxFQUFFLENBQUMsVUFBVSxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUM7WUFDcEMsV0FBVyxFQUFFLGlCQUFpQjtZQUM5QixVQUFVO1NBQ1gsQ0FBQyxDQUFDO1FBRUgsc0RBQXNEO1FBQ3RELE1BQU0saUJBQWlCLEdBQUcsSUFBSSxzQkFBc0IsQ0FBQyxxQkFBcUIsQ0FDeEUsbUJBQW1CLEVBQ25CLGNBQWMsQ0FDZixDQUFDO1FBRUYsSUFBSSxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUM7WUFDakIsSUFBSSxFQUFFLFlBQVk7WUFDbEIsT0FBTyxFQUFFLENBQUMsVUFBVSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUM7WUFDckMsV0FBVyxFQUFFLGlCQUFpQjtZQUM5QixpRUFBaUU7U0FDbEUsQ0FBQyxDQUFDO1FBRUgsZ0JBQWdCO1FBQ2hCLElBQUksQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFJLENBQUM7UUFDNUIsSUFBSSxDQUFDLFNBQVMsR0FBRyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxXQUFXLENBQUM7SUFDOUMsQ0FBQztDQUNGO0FBcFFELG9DQW9RQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQVBJIENvbnN0cnVjdFxuICpcbiAqIERlZmluZXMgQVBJIEdhdGV3YXkgSFRUUCBBUEkgYW5kIExhbWJkYSBpbnRlZ3JhdGlvbnMgZm9yOlxuICogLSBEZXZpY2UgbWFuYWdlbWVudFxuICogLSBUZWxlbWV0cnkgcXVlcmllc1xuICogLSBDb25maWd1cmF0aW9uIG1hbmFnZW1lbnRcbiAqIC0gQ29tbWFuZCBzZW5kaW5nXG4gKi9cblxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGFwaWdhdGV3YXkgZnJvbSAnYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mic7XG5pbXBvcnQgKiBhcyBhcGlnYXRld2F5SW50ZWdyYXRpb25zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItaW50ZWdyYXRpb25zJztcbmltcG9ydCAqIGFzIGFwaWdhdGV3YXlBdXRob3JpemVycyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWF1dGhvcml6ZXJzJztcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcbmltcG9ydCAqIGFzIHNucyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc25zJztcbmltcG9ydCAqIGFzIGNvZ25pdG8gZnJvbSAnYXdzLWNkay1saWIvYXdzLWNvZ25pdG8nO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiJztcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxvZ3MnO1xuaW1wb3J0ICogYXMgc2VjcmV0c21hbmFnZXIgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNlY3JldHNtYW5hZ2VyJztcbmltcG9ydCB7IE5vZGVqc0Z1bmN0aW9uIH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYS1ub2RlanMnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFwaUNvbnN0cnVjdFByb3BzIHtcbiAgdGVsZW1ldHJ5VGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBkZXZpY2VzVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICB1c2VyUG9vbDogY29nbml0by5Vc2VyUG9vbDtcbiAgdXNlclBvb2xDbGllbnQ6IGNvZ25pdG8uVXNlclBvb2xDbGllbnQ7XG4gIG5vdGVodWJQcm9qZWN0VWlkOiBzdHJpbmc7XG4gIGFsZXJ0VG9waWM6IHNucy5JVG9waWM7XG59XG5cbmV4cG9ydCBjbGFzcyBBcGlDb25zdHJ1Y3QgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlnYXRld2F5Lkh0dHBBcGk7XG4gIHB1YmxpYyByZWFkb25seSBhcGlVcmw6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGluZ2VzdFVybDogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcGlDb25zdHJ1Y3RQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIENvbW1hbmRzIFRhYmxlIChmb3IgY29tbWFuZCBoaXN0b3J5KVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgY29tbWFuZHNUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCAnQ29tbWFuZHNUYWJsZScsIHtcbiAgICAgIHRhYmxlTmFtZTogJ3NvbmdiaXJkLWNvbW1hbmRzJyxcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiAnZGV2aWNlX3VpZCcsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBzb3J0S2V5OiB7IG5hbWU6ICdjb21tYW5kX2lkJywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogJ3R0bCcsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE5vdGVodWIgQVBJIFRva2VuIFNlY3JldFxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTm90ZTogVGhpcyBzZWNyZXQgc2hvdWxkIGJlIGNyZWF0ZWQgbWFudWFsbHkgd2l0aCB0aGUgYWN0dWFsIHRva2VuXG4gICAgY29uc3Qgbm90ZWh1YlNlY3JldCA9IG5ldyBzZWNyZXRzbWFuYWdlci5TZWNyZXQodGhpcywgJ05vdGVodWJBcGlUb2tlbicsIHtcbiAgICAgIHNlY3JldE5hbWU6ICdzb25nYmlyZC9ub3RlaHViLWFwaS10b2tlbicsXG4gICAgICBkZXNjcmlwdGlvbjogJ05vdGVodWIgQVBJIHRva2VuIGZvciBTb25nYmlyZCcsXG4gICAgICBnZW5lcmF0ZVNlY3JldFN0cmluZzoge1xuICAgICAgICBzZWNyZXRTdHJpbmdUZW1wbGF0ZTogSlNPTi5zdHJpbmdpZnkoeyBwbGFjZWhvbGRlcjogJ1JFUExBQ0VfV0lUSF9BQ1RVQUxfVE9LRU4nIH0pLFxuICAgICAgICBnZW5lcmF0ZVN0cmluZ0tleTogJ3Rva2VuJyxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIExhbWJkYSBGdW5jdGlvbnNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgLy8gRGV2aWNlcyBBUElcbiAgICBjb25zdCBkZXZpY2VzRnVuY3Rpb24gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0RldmljZXNGdW5jdGlvbicsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFwaS1kZXZpY2VzJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgRGV2aWNlcyBBUEknLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hcGktZGV2aWNlcy9pbmRleC50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgREVWSUNFU19UQUJMRTogcHJvcHMuZGV2aWNlc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuICAgIHByb3BzLmRldmljZXNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoZGV2aWNlc0Z1bmN0aW9uKTtcblxuICAgIC8vIFRlbGVtZXRyeSBBUElcbiAgICBjb25zdCB0ZWxlbWV0cnlGdW5jdGlvbiA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnVGVsZW1ldHJ5RnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hcGktdGVsZW1ldHJ5JyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgVGVsZW1ldHJ5IEFQSScsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FwaS10ZWxlbWV0cnkvaW5kZXgudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFRFTEVNRVRSWV9UQUJMRTogcHJvcHMudGVsZW1ldHJ5VGFibGUudGFibGVOYW1lLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG4gICAgcHJvcHMudGVsZW1ldHJ5VGFibGUuZ3JhbnRSZWFkRGF0YSh0ZWxlbWV0cnlGdW5jdGlvbik7XG5cbiAgICAvLyBDb21tYW5kcyBBUElcbiAgICBjb25zdCBjb21tYW5kc0Z1bmN0aW9uID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdDb21tYW5kc0Z1bmN0aW9uJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYXBpLWNvbW1hbmRzJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgQ29tbWFuZHMgQVBJJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYXBpLWNvbW1hbmRzL2luZGV4LnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBDT01NQU5EU19UQUJMRTogY29tbWFuZHNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIE5PVEVIVUJfUFJPSkVDVF9VSUQ6IHByb3BzLm5vdGVodWJQcm9qZWN0VWlkLFxuICAgICAgICBOT1RFSFVCX0FQSV9UT0tFTjogbm90ZWh1YlNlY3JldC5zZWNyZXRWYWx1ZUZyb21Kc29uKCd0b2tlbicpLnVuc2FmZVVud3JhcCgpLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG4gICAgY29tbWFuZHNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoY29tbWFuZHNGdW5jdGlvbik7XG5cbiAgICAvLyBDb25maWcgQVBJXG4gICAgY29uc3QgY29uZmlnRnVuY3Rpb24gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0NvbmZpZ0Z1bmN0aW9uJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYXBpLWNvbmZpZycsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NvbmdiaXJkIENvbmZpZyBBUEknLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hcGktY29uZmlnL2luZGV4LnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBOT1RFSFVCX1BST0pFQ1RfVUlEOiBwcm9wcy5ub3RlaHViUHJvamVjdFVpZCxcbiAgICAgICAgTk9URUhVQl9BUElfVE9LRU46IG5vdGVodWJTZWNyZXQuc2VjcmV0VmFsdWVGcm9tSnNvbigndG9rZW4nKS51bnNhZmVVbndyYXAoKSxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuXG4gICAgLy8gRXZlbnQgSW5nZXN0IEFQSSAoZm9yIE5vdGVodWIgSFRUUCByb3V0ZSAtIG5vIGF1dGhlbnRpY2F0aW9uKVxuICAgIGNvbnN0IGluZ2VzdEZ1bmN0aW9uID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdJbmdlc3RGdW5jdGlvbicsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFwaS1pbmdlc3QnLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBFdmVudCBJbmdlc3QgQVBJIGZvciBOb3RlaHViIEhUVFAgcm91dGVzJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYXBpLWluZ2VzdC9pbmRleC50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgVEVMRU1FVFJZX1RBQkxFOiBwcm9wcy50ZWxlbWV0cnlUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIERFVklDRVNfVEFCTEU6IHByb3BzLmRldmljZXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIEFMRVJUX1RPUElDX0FSTjogcHJvcHMuYWxlcnRUb3BpYy50b3BpY0FybixcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuICAgIHByb3BzLnRlbGVtZXRyeVRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShpbmdlc3RGdW5jdGlvbik7XG4gICAgcHJvcHMuZGV2aWNlc1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShpbmdlc3RGdW5jdGlvbik7XG4gICAgcHJvcHMuYWxlcnRUb3BpYy5ncmFudFB1Ymxpc2goaW5nZXN0RnVuY3Rpb24pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBIVFRQIEFQSSBHYXRld2F5XG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLmFwaSA9IG5ldyBhcGlnYXRld2F5Lkh0dHBBcGkodGhpcywgJ0FwaScsIHtcbiAgICAgIGFwaU5hbWU6ICdzb25nYmlyZC1hcGknLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBEZW1vIFBsYXRmb3JtIEFQSScsXG4gICAgICBjb3JzUHJlZmxpZ2h0OiB7XG4gICAgICAgIGFsbG93T3JpZ2luczogWycqJ10sXG4gICAgICAgIGFsbG93TWV0aG9kczogW1xuICAgICAgICAgIGFwaWdhdGV3YXkuQ29yc0h0dHBNZXRob2QuR0VULFxuICAgICAgICAgIGFwaWdhdGV3YXkuQ29yc0h0dHBNZXRob2QuUE9TVCxcbiAgICAgICAgICBhcGlnYXRld2F5LkNvcnNIdHRwTWV0aG9kLlBVVCxcbiAgICAgICAgICBhcGlnYXRld2F5LkNvcnNIdHRwTWV0aG9kLlBBVENILFxuICAgICAgICAgIGFwaWdhdGV3YXkuQ29yc0h0dHBNZXRob2QuREVMRVRFLFxuICAgICAgICAgIGFwaWdhdGV3YXkuQ29yc0h0dHBNZXRob2QuT1BUSU9OUyxcbiAgICAgICAgXSxcbiAgICAgICAgYWxsb3dIZWFkZXJzOiBbJ0NvbnRlbnQtVHlwZScsICdBdXRob3JpemF0aW9uJ10sXG4gICAgICAgIG1heEFnZTogY2RrLkR1cmF0aW9uLmRheXMoMSksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gQ29nbml0byBKV1QgQXV0aG9yaXplclxuICAgIGNvbnN0IGF1dGhvcml6ZXIgPSBuZXcgYXBpZ2F0ZXdheUF1dGhvcml6ZXJzLkh0dHBVc2VyUG9vbEF1dGhvcml6ZXIoXG4gICAgICAnQ29nbml0b0F1dGhvcml6ZXInLFxuICAgICAgcHJvcHMudXNlclBvb2wsXG4gICAgICB7XG4gICAgICAgIHVzZXJQb29sQ2xpZW50czogW3Byb3BzLnVzZXJQb29sQ2xpZW50XSxcbiAgICAgICAgaWRlbnRpdHlTb3VyY2U6IFsnJHJlcXVlc3QuaGVhZGVyLkF1dGhvcml6YXRpb24nXSxcbiAgICAgIH1cbiAgICApO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBBUEkgUm91dGVzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIERldmljZXMgZW5kcG9pbnRzXG4gICAgY29uc3QgZGV2aWNlc0ludGVncmF0aW9uID0gbmV3IGFwaWdhdGV3YXlJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFxuICAgICAgJ0RldmljZXNJbnRlZ3JhdGlvbicsXG4gICAgICBkZXZpY2VzRnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZGV2aWNlcycsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogZGV2aWNlc0ludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2RldmljZXMve2RldmljZV91aWR9JyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VULCBhcGlnYXRld2F5Lkh0dHBNZXRob2QuUEFUQ0hdLFxuICAgICAgaW50ZWdyYXRpb246IGRldmljZXNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBUZWxlbWV0cnkgZW5kcG9pbnRzXG4gICAgY29uc3QgdGVsZW1ldHJ5SW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheUludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAnVGVsZW1ldHJ5SW50ZWdyYXRpb24nLFxuICAgICAgdGVsZW1ldHJ5RnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZGV2aWNlcy97ZGV2aWNlX3VpZH0vdGVsZW1ldHJ5JyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VUXSxcbiAgICAgIGludGVncmF0aW9uOiB0ZWxlbWV0cnlJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS9kZXZpY2VzL3tkZXZpY2VfdWlkfS9sb2NhdGlvbicsXG4gICAgICBtZXRob2RzOiBbYXBpZ2F0ZXdheS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogdGVsZW1ldHJ5SW50ZWdyYXRpb24sXG4gICAgICBhdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZGV2aWNlcy97ZGV2aWNlX3VpZH0vcG93ZXInLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5HRVRdLFxuICAgICAgaW50ZWdyYXRpb246IHRlbGVtZXRyeUludGVncmF0aW9uLFxuICAgICAgYXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIC8vIENvbW1hbmRzIGVuZHBvaW50c1xuICAgIGNvbnN0IGNvbW1hbmRzSW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheUludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAnQ29tbWFuZHNJbnRlZ3JhdGlvbicsXG4gICAgICBjb21tYW5kc0Z1bmN0aW9uXG4gICAgKTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiAnL3YxL2RldmljZXMve2RldmljZV91aWR9L2NvbW1hbmRzJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VULCBhcGlnYXRld2F5Lkh0dHBNZXRob2QuUE9TVF0sXG4gICAgICBpbnRlZ3JhdGlvbjogY29tbWFuZHNJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBDb25maWcgZW5kcG9pbnRzXG4gICAgY29uc3QgY29uZmlnSW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheUludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAnQ29uZmlnSW50ZWdyYXRpb24nLFxuICAgICAgY29uZmlnRnVuY3Rpb25cbiAgICApO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6ICcvdjEvZGV2aWNlcy97ZGV2aWNlX3VpZH0vY29uZmlnJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuR0VULCBhcGlnYXRld2F5Lkh0dHBNZXRob2QuUFVUXSxcbiAgICAgIGludGVncmF0aW9uOiBjb25maWdJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS9mbGVldHMve2ZsZWV0X3VpZH0vY29uZmlnJyxcbiAgICAgIG1ldGhvZHM6IFthcGlnYXRld2F5Lkh0dHBNZXRob2QuUFVUXSxcbiAgICAgIGludGVncmF0aW9uOiBjb25maWdJbnRlZ3JhdGlvbixcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvLyBFdmVudCBpbmdlc3QgZW5kcG9pbnQgKG5vIGF1dGggLSBjYWxsZWQgYnkgTm90ZWh1YilcbiAgICBjb25zdCBpbmdlc3RJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnYXRld2F5SW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICdJbmdlc3RJbnRlZ3JhdGlvbicsXG4gICAgICBpbmdlc3RGdW5jdGlvblxuICAgICk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogJy92MS9pbmdlc3QnLFxuICAgICAgbWV0aG9kczogW2FwaWdhdGV3YXkuSHR0cE1ldGhvZC5QT1NUXSxcbiAgICAgIGludGVncmF0aW9uOiBpbmdlc3RJbnRlZ3JhdGlvbixcbiAgICAgIC8vIE5vIGF1dGhvcml6ZXIgLSBOb3RlaHViIEhUVFAgcm91dGVzIGRvbid0IHN1cHBvcnQgQ29nbml0byBhdXRoXG4gICAgfSk7XG5cbiAgICAvLyBTdG9yZSBBUEkgVVJMXG4gICAgdGhpcy5hcGlVcmwgPSB0aGlzLmFwaS51cmwhO1xuICAgIHRoaXMuaW5nZXN0VXJsID0gYCR7dGhpcy5hcGkudXJsfXYxL2luZ2VzdGA7XG4gIH1cbn1cbiJdfQ==