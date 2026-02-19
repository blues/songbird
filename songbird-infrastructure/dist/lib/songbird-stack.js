"use strict";
/**
 * Songbird Main Stack
 *
 * Orchestrates all infrastructure constructs for the Songbird demo platform.
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
exports.SongbirdStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const sns = __importStar(require("aws-cdk-lib/aws-sns"));
const snsSubscriptions = __importStar(require("aws-cdk-lib/aws-sns-subscriptions"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const aws_lambda_nodejs_1 = require("aws-cdk-lib/aws-lambda-nodejs");
const path = __importStar(require("path"));
const route53 = __importStar(require("aws-cdk-lib/aws-route53"));
const storage_construct_1 = require("./storage-construct");
const api_construct_1 = require("./api-construct");
const dashboard_construct_1 = require("./dashboard-construct");
const auth_construct_1 = require("./auth-construct");
const analytics_construct_1 = require("./analytics-construct");
const observability_construct_1 = require("./observability-construct");
class SongbirdStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // ==========================================================================
        // Storage Layer (DynamoDB for devices and telemetry)
        // ==========================================================================
        const storage = new storage_construct_1.StorageConstruct(this, 'Storage', {
            dynamoTableName: 'songbird-devices',
            telemetryTableName: 'songbird-telemetry',
        });
        // ==========================================================================
        // Authentication (Cognito)
        // ==========================================================================
        const auth = new auth_construct_1.AuthConstruct(this, 'Auth', {
            userPoolName: 'songbird-users',
        });
        // ==========================================================================
        // SNS Topic for Alerts
        // ==========================================================================
        const alertTopic = new sns.Topic(this, 'AlertTopic', {
            topicName: 'songbird-alerts',
            displayName: 'Songbird Alert Notifications',
        });
        // ==========================================================================
        // Analytics Layer (Aurora Serverless + Bedrock)
        // ==========================================================================
        const analytics = new analytics_construct_1.AnalyticsConstruct(this, 'Analytics', {
            devicesTable: storage.devicesTable,
            telemetryTable: storage.telemetryTable,
            locationsTable: storage.locationsTable,
            alertsTable: storage.alertsTable,
            journeysTable: storage.journeysTable,
        });
        // ==========================================================================
        // Route53 Hosted Zone for songbird.live
        // ==========================================================================
        // Look up the existing hosted zone instead of creating a new one
        // This prevents creating duplicate zones on each deployment
        const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
            domainName: 'songbird.live',
        });
        // ==========================================================================
        // Observability Layer (Arize Phoenix on ECS Fargate)
        // ==========================================================================
        const observability = new observability_construct_1.ObservabilityConstruct(this, 'Observability', {
            vpc: analytics.vpc,
            domainName: 'phoenix.songbird.live',
            hostedZone: hostedZone,
        });
        // Configure analytics Lambda to send traces to Phoenix
        analytics.configurePhoenixTracing(observability.otlpEndpoint);
        observability.allowTracingFrom(analytics.chatQueryLambda);
        // ==========================================================================
        // API Layer (API Gateway + Lambda)
        // ==========================================================================
        const api = new api_construct_1.ApiConstruct(this, 'Api', {
            telemetryTable: storage.telemetryTable,
            devicesTable: storage.devicesTable,
            alertsTable: storage.alertsTable,
            settingsTable: storage.settingsTable,
            journeysTable: storage.journeysTable,
            locationsTable: storage.locationsTable,
            deviceAliasesTable: storage.deviceAliasesTable,
            auditTable: storage.auditTable,
            userPool: auth.userPool,
            userPoolClient: auth.userPoolClient,
            notehubProjectUid: props.notehubProjectUid,
            alertTopic,
        });
        // Add Analytics routes to API
        api.addAnalyticsRoutes(analytics.chatQueryLambda, analytics.chatHistoryLambda, analytics.listSessionsLambda, analytics.getSessionLambda, analytics.deleteSessionLambda, analytics.rerunQueryLambda);
        // ==========================================================================
        // Post-Confirmation Lambda Trigger (for self-signup with Viewer role)
        // Must be created after API construct to avoid circular dependencies
        // ==========================================================================
        new auth_construct_1.PostConfirmationTrigger(this, 'PostConfirmation', {
            userPool: auth.userPool,
        });
        // ==========================================================================
        // Dashboard Hosting (S3 + CloudFront)
        // ==========================================================================
        const dashboard = new dashboard_construct_1.DashboardConstruct(this, 'Dashboard', {
            apiUrl: api.apiUrl,
            userPoolId: auth.userPool.userPoolId,
            userPoolClientId: auth.userPoolClient.userPoolClientId,
            domainName: 'songbird.live',
            hostedZone: hostedZone,
        });
        // ==========================================================================
        // SES Email Identity (for alert emails)
        // ==========================================================================
        // Note: Email identity 'brandon@blues.com' must be verified in SES
        // The identity already exists and is managed outside of CDK
        // We just reference it here for documentation purposes
        // ==========================================================================
        // Alert Email Lambda
        // ==========================================================================
        const alertEmailLambda = new aws_lambda_nodejs_1.NodejsFunction(this, 'AlertEmailFunction', {
            functionName: 'songbird-alert-email',
            description: 'Sends email notifications for low battery alerts to device owners',
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'handler',
            entry: path.join(__dirname, '../lambda/alert-email/index.ts'),
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
            environment: {
                DEVICES_TABLE: storage.devicesTable.tableName,
                ALERTS_TABLE: storage.alertsTable.tableName,
                SENDER_EMAIL: 'brandon@blues.com',
                DASHBOARD_URL: 'https://songbird.live',
            },
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: ['@aws-sdk/*'],
            },
            logRetention: logs.RetentionDays.TWO_WEEKS,
        });
        // Grant permissions to the alert email Lambda
        storage.devicesTable.grantReadData(alertEmailLambda);
        storage.alertsTable.grantReadWriteData(alertEmailLambda);
        // Grant permission to send emails via SES
        alertEmailLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ses:SendEmail', 'ses:SendRawEmail'],
            resources: ['*'],
            conditions: {
                StringEquals: {
                    'ses:FromAddress': 'brandon@blues.com',
                },
            },
        }));
        // Subscribe the email Lambda to the SNS alert topic
        alertTopic.addSubscription(new snsSubscriptions.LambdaSubscription(alertEmailLambda, {
            filterPolicy: {
                alert_type: sns.SubscriptionFilter.stringFilter({
                    allowlist: ['low_battery'],
                }),
            },
        }));
        // ==========================================================================
        // Outputs
        // ==========================================================================
        new cdk.CfnOutput(this, 'ApiUrl', {
            value: api.apiUrl,
            description: 'Songbird API endpoint URL',
            exportName: 'SongbirdApiUrl',
        });
        new cdk.CfnOutput(this, 'IngestUrl', {
            value: api.ingestUrl,
            description: 'Event ingest URL for Notehub HTTP route',
            exportName: 'SongbirdIngestUrl',
        });
        new cdk.CfnOutput(this, 'DashboardUrl', {
            value: dashboard.distributionUrl,
            description: 'Songbird Dashboard URL',
            exportName: 'SongbirdDashboardUrl',
        });
        new cdk.CfnOutput(this, 'UserPoolId', {
            value: auth.userPool.userPoolId,
            description: 'Cognito User Pool ID',
            exportName: 'SongbirdUserPoolId',
        });
        new cdk.CfnOutput(this, 'UserPoolClientId', {
            value: auth.userPoolClient.userPoolClientId,
            description: 'Cognito User Pool Client ID',
            exportName: 'SongbirdUserPoolClientId',
        });
        new cdk.CfnOutput(this, 'DevicesTableName', {
            value: storage.devicesTable.tableName,
            description: 'DynamoDB devices table name',
            exportName: 'SongbirdDevicesTable',
        });
        new cdk.CfnOutput(this, 'TelemetryTableName', {
            value: storage.telemetryTable.tableName,
            description: 'DynamoDB telemetry table name',
            exportName: 'SongbirdTelemetryTable',
        });
        new cdk.CfnOutput(this, 'AnalyticsClusterEndpoint', {
            value: analytics.cluster.clusterEndpoint.hostname,
            description: 'Aurora Analytics cluster endpoint',
            exportName: 'SongbirdAnalyticsClusterEndpoint',
        });
        new cdk.CfnOutput(this, 'ChatHistoryTableName', {
            value: analytics.chatHistoryTable.tableName,
            description: 'Analytics chat history table name',
            exportName: 'SongbirdChatHistoryTable',
        });
        new cdk.CfnOutput(this, 'AlertEmailIdentity', {
            value: 'brandon@blues.com',
            description: 'SES email identity for alerts (must be verified)',
            exportName: 'SongbirdAlertEmailIdentity',
        });
        new cdk.CfnOutput(this, 'AlertEmailLambdaArn', {
            value: alertEmailLambda.functionArn,
            description: 'Alert email Lambda function ARN',
            exportName: 'SongbirdAlertEmailLambdaArn',
        });
    }
}
exports.SongbirdStack = SongbirdStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic29uZ2JpcmQtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvc29uZ2JpcmQtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7O0dBSUc7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBRUgsaURBQW1DO0FBQ25DLHlEQUEyQztBQUMzQyxvRkFBc0U7QUFDdEUsK0RBQWlEO0FBRWpELHlEQUEyQztBQUMzQywyREFBNkM7QUFFN0MscUVBQStEO0FBQy9ELDJDQUE2QjtBQUM3QixpRUFBbUQ7QUFDbkQsMkRBQXVEO0FBQ3ZELG1EQUErQztBQUMvQywrREFBMkQ7QUFDM0QscURBQTBFO0FBQzFFLCtEQUEyRDtBQUMzRCx1RUFBbUU7QUFNbkUsTUFBYSxhQUFjLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDMUMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUF5QjtRQUNqRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4Qiw2RUFBNkU7UUFDN0UscURBQXFEO1FBQ3JELDZFQUE2RTtRQUM3RSxNQUFNLE9BQU8sR0FBRyxJQUFJLG9DQUFnQixDQUFDLElBQUksRUFBRSxTQUFTLEVBQUU7WUFDcEQsZUFBZSxFQUFFLGtCQUFrQjtZQUNuQyxrQkFBa0IsRUFBRSxvQkFBb0I7U0FDekMsQ0FBQyxDQUFDO1FBRUgsNkVBQTZFO1FBQzdFLDJCQUEyQjtRQUMzQiw2RUFBNkU7UUFDN0UsTUFBTSxJQUFJLEdBQUcsSUFBSSw4QkFBYSxDQUFDLElBQUksRUFBRSxNQUFNLEVBQUU7WUFDM0MsWUFBWSxFQUFFLGdCQUFnQjtTQUMvQixDQUFDLENBQUM7UUFFSCw2RUFBNkU7UUFDN0UsdUJBQXVCO1FBQ3ZCLDZFQUE2RTtRQUM3RSxNQUFNLFVBQVUsR0FBRyxJQUFJLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUNuRCxTQUFTLEVBQUUsaUJBQWlC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QztZQUNoRCxVQUFVLEVBQUUsMEJBQTBCO1NBQ3ZDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsb0JBQW9CLEVBQUU7WUFDNUMsS0FBSyxFQUFFLG1CQUFtQjtZQUMxQixXQUFXLEVBQUUsa0RBQWtEO1lBQy9ELFVBQVUsRUFBRSw0QkFBNEI7U0FDekMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxxQkFBcUIsRUFBRTtZQUM3QyxLQUFLLEVBQUUsZ0JBQWdCLENBQUMsV0FBVztZQUNuQyxXQUFXLEVBQUUsaUNBQWlDO1lBQzlDLFVBQVUsRUFBRSw2QkFBNkI7U0FDMUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBeE9ELHNDQXdPQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU29uZ2JpcmQgTWFpbiBTdGFja1xuICpcbiAqIE9yY2hlc3RyYXRlcyBhbGwgaW5mcmFzdHJ1Y3R1cmUgY29uc3RydWN0cyBmb3IgdGhlIFNvbmdiaXJkIGRlbW8gcGxhdGZvcm0uXG4gKi9cblxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIHNucyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc25zJztcbmltcG9ydCAqIGFzIHNuc1N1YnNjcmlwdGlvbnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNucy1zdWJzY3JpcHRpb25zJztcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcbmltcG9ydCAqIGFzIHNlcyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc2VzJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxvZ3MnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgeyBOb2RlanNGdW5jdGlvbiB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEtbm9kZWpzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1yb3V0ZTUzJztcbmltcG9ydCB7IFN0b3JhZ2VDb25zdHJ1Y3QgfSBmcm9tICcuL3N0b3JhZ2UtY29uc3RydWN0JztcbmltcG9ydCB7IEFwaUNvbnN0cnVjdCB9IGZyb20gJy4vYXBpLWNvbnN0cnVjdCc7XG5pbXBvcnQgeyBEYXNoYm9hcmRDb25zdHJ1Y3QgfSBmcm9tICcuL2Rhc2hib2FyZC1jb25zdHJ1Y3QnO1xuaW1wb3J0IHsgQXV0aENvbnN0cnVjdCwgUG9zdENvbmZpcm1hdGlvblRyaWdnZXIgfSBmcm9tICcuL2F1dGgtY29uc3RydWN0JztcbmltcG9ydCB7IEFuYWx5dGljc0NvbnN0cnVjdCB9IGZyb20gJy4vYW5hbHl0aWNzLWNvbnN0cnVjdCc7XG5pbXBvcnQgeyBPYnNlcnZhYmlsaXR5Q29uc3RydWN0IH0gZnJvbSAnLi9vYnNlcnZhYmlsaXR5LWNvbnN0cnVjdCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU29uZ2JpcmRTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICBub3RlaHViUHJvamVjdFVpZDogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgU29uZ2JpcmRTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBTb25nYmlyZFN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gU3RvcmFnZSBMYXllciAoRHluYW1vREIgZm9yIGRldmljZXMgYW5kIHRlbGVtZXRyeSlcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IHN0b3JhZ2UgPSBuZXcgU3RvcmFnZUNvbnN0cnVjdCh0aGlzLCAnU3RvcmFnZScsIHtcbiAgICAgIGR5bmFtb1RhYmxlTmFtZTogJ3NvbmdiaXJkLWRldmljZXMnLFxuICAgICAgdGVsZW1ldHJ5VGFibGVOYW1lOiAnc29uZ2JpcmQtdGVsZW1ldHJ5JyxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQXV0aGVudGljYXRpb24gKENvZ25pdG8pXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBhdXRoID0gbmV3IEF1dGhDb25zdHJ1Y3QodGhpcywgJ0F1dGgnLCB7XG4gICAgICB1c2VyUG9vbE5hbWU6ICdzb25nYmlyZC11c2VycycsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFNOUyBUb3BpYyBmb3IgQWxlcnRzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBhbGVydFRvcGljID0gbmV3IHNucy5Ub3BpYyh0aGlzLCAnQWxlcnRUb3BpYycsIHtcbiAgICAgIHRvcGljTmFtZTogJ3NvbmdiaXJkLWFsZXJ0cycsXG4gICAgICBkaXNwbGF5TmFtZTogJ1NvbmdiaXJkIEFsZXJ0IE5vdGlmaWNhdGlvbnMnLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBBbmFseXRpY3MgTGF5ZXIgKEF1cm9yYSBTZXJ2ZXJsZXNzICsgQmVkcm9jaylcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGFuYWx5dGljcyA9IG5ldyBBbmFseXRpY3NDb25zdHJ1Y3QodGhpcywgJ0FuYWx5dGljcycsIHtcbiAgICAgIGRldmljZXNUYWJsZTogc3RvcmFnZS5kZXZpY2VzVGFibGUsXG4gICAgICB0ZWxlbWV0cnlUYWJsZTogc3RvcmFnZS50ZWxlbWV0cnlUYWJsZSxcbiAgICAgIGxvY2F0aW9uc1RhYmxlOiBzdG9yYWdlLmxvY2F0aW9uc1RhYmxlLFxuICAgICAgYWxlcnRzVGFibGU6IHN0b3JhZ2UuYWxlcnRzVGFibGUsXG4gICAgICBqb3VybmV5c1RhYmxlOiBzdG9yYWdlLmpvdXJuZXlzVGFibGUsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFJvdXRlNTMgSG9zdGVkIFpvbmUgZm9yIHNvbmdiaXJkLmxpdmVcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIExvb2sgdXAgdGhlIGV4aXN0aW5nIGhvc3RlZCB6b25lIGluc3RlYWQgb2YgY3JlYXRpbmcgYSBuZXcgb25lXG4gICAgLy8gVGhpcyBwcmV2ZW50cyBjcmVhdGluZyBkdXBsaWNhdGUgem9uZXMgb24gZWFjaCBkZXBsb3ltZW50XG4gICAgY29uc3QgaG9zdGVkWm9uZSA9IHJvdXRlNTMuSG9zdGVkWm9uZS5mcm9tTG9va3VwKHRoaXMsICdIb3N0ZWRab25lJywge1xuICAgICAgZG9tYWluTmFtZTogJ3NvbmdiaXJkLmxpdmUnLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBPYnNlcnZhYmlsaXR5IExheWVyIChBcml6ZSBQaG9lbml4IG9uIEVDUyBGYXJnYXRlKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3Qgb2JzZXJ2YWJpbGl0eSA9IG5ldyBPYnNlcnZhYmlsaXR5Q29uc3RydWN0KHRoaXMsICdPYnNlcnZhYmlsaXR5Jywge1xuICAgICAgdnBjOiBhbmFseXRpY3MudnBjLFxuICAgICAgZG9tYWluTmFtZTogJ3Bob2VuaXguc29uZ2JpcmQubGl2ZScsXG4gICAgICBob3N0ZWRab25lOiBob3N0ZWRab25lLFxuICAgIH0pO1xuXG4gICAgLy8gQ29uZmlndXJlIGFuYWx5dGljcyBMYW1iZGEgdG8gc2VuZCB0cmFjZXMgdG8gUGhvZW5peFxuICAgIGFuYWx5dGljcy5jb25maWd1cmVQaG9lbml4VHJhY2luZyhvYnNlcnZhYmlsaXR5Lm90bHBFbmRwb2ludCk7XG4gICAgb2JzZXJ2YWJpbGl0eS5hbGxvd1RyYWNpbmdGcm9tKGFuYWx5dGljcy5jaGF0UXVlcnlMYW1iZGEpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBBUEkgTGF5ZXIgKEFQSSBHYXRld2F5ICsgTGFtYmRhKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYXBpID0gbmV3IEFwaUNvbnN0cnVjdCh0aGlzLCAnQXBpJywge1xuICAgICAgdGVsZW1ldHJ5VGFibGU6IHN0b3JhZ2UudGVsZW1ldHJ5VGFibGUsXG4gICAgICBkZXZpY2VzVGFibGU6IHN0b3JhZ2UuZGV2aWNlc1RhYmxlLFxuICAgICAgYWxlcnRzVGFibGU6IHN0b3JhZ2UuYWxlcnRzVGFibGUsXG4gICAgICBzZXR0aW5nc1RhYmxlOiBzdG9yYWdlLnNldHRpbmdzVGFibGUsXG4gICAgICBqb3VybmV5c1RhYmxlOiBzdG9yYWdlLmpvdXJuZXlzVGFibGUsXG4gICAgICBsb2NhdGlvbnNUYWJsZTogc3RvcmFnZS5sb2NhdGlvbnNUYWJsZSxcbiAgICAgIGRldmljZUFsaWFzZXNUYWJsZTogc3RvcmFnZS5kZXZpY2VBbGlhc2VzVGFibGUsXG4gICAgICBhdWRpdFRhYmxlOiBzdG9yYWdlLmF1ZGl0VGFibGUsXG4gICAgICB1c2VyUG9vbDogYXV0aC51c2VyUG9vbCxcbiAgICAgIHVzZXJQb29sQ2xpZW50OiBhdXRoLnVzZXJQb29sQ2xpZW50LFxuICAgICAgbm90ZWh1YlByb2plY3RVaWQ6IHByb3BzLm5vdGVodWJQcm9qZWN0VWlkLFxuICAgICAgYWxlcnRUb3BpYyxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBBbmFseXRpY3Mgcm91dGVzIHRvIEFQSVxuICAgIGFwaS5hZGRBbmFseXRpY3NSb3V0ZXMoXG4gICAgICBhbmFseXRpY3MuY2hhdFF1ZXJ5TGFtYmRhLFxuICAgICAgYW5hbHl0aWNzLmNoYXRIaXN0b3J5TGFtYmRhLFxuICAgICAgYW5hbHl0aWNzLmxpc3RTZXNzaW9uc0xhbWJkYSxcbiAgICAgIGFuYWx5dGljcy5nZXRTZXNzaW9uTGFtYmRhLFxuICAgICAgYW5hbHl0aWNzLmRlbGV0ZVNlc3Npb25MYW1iZGEsXG4gICAgICBhbmFseXRpY3MucmVydW5RdWVyeUxhbWJkYVxuICAgICk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFBvc3QtQ29uZmlybWF0aW9uIExhbWJkYSBUcmlnZ2VyIChmb3Igc2VsZi1zaWdudXAgd2l0aCBWaWV3ZXIgcm9sZSlcbiAgICAvLyBNdXN0IGJlIGNyZWF0ZWQgYWZ0ZXIgQVBJIGNvbnN0cnVjdCB0byBhdm9pZCBjaXJjdWxhciBkZXBlbmRlbmNpZXNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIG5ldyBQb3N0Q29uZmlybWF0aW9uVHJpZ2dlcih0aGlzLCAnUG9zdENvbmZpcm1hdGlvbicsIHtcbiAgICAgIHVzZXJQb29sOiBhdXRoLnVzZXJQb29sLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBEYXNoYm9hcmQgSG9zdGluZyAoUzMgKyBDbG91ZEZyb250KVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgZGFzaGJvYXJkID0gbmV3IERhc2hib2FyZENvbnN0cnVjdCh0aGlzLCAnRGFzaGJvYXJkJywge1xuICAgICAgYXBpVXJsOiBhcGkuYXBpVXJsLFxuICAgICAgdXNlclBvb2xJZDogYXV0aC51c2VyUG9vbC51c2VyUG9vbElkLFxuICAgICAgdXNlclBvb2xDbGllbnRJZDogYXV0aC51c2VyUG9vbENsaWVudC51c2VyUG9vbENsaWVudElkLFxuICAgICAgZG9tYWluTmFtZTogJ3NvbmdiaXJkLmxpdmUnLFxuICAgICAgaG9zdGVkWm9uZTogaG9zdGVkWm9uZSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gU0VTIEVtYWlsIElkZW50aXR5IChmb3IgYWxlcnQgZW1haWxzKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTm90ZTogRW1haWwgaWRlbnRpdHkgJ2JyYW5kb25AYmx1ZXMuY29tJyBtdXN0IGJlIHZlcmlmaWVkIGluIFNFU1xuICAgIC8vIFRoZSBpZGVudGl0eSBhbHJlYWR5IGV4aXN0cyBhbmQgaXMgbWFuYWdlZCBvdXRzaWRlIG9mIENES1xuICAgIC8vIFdlIGp1c3QgcmVmZXJlbmNlIGl0IGhlcmUgZm9yIGRvY3VtZW50YXRpb24gcHVycG9zZXNcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQWxlcnQgRW1haWwgTGFtYmRhXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBhbGVydEVtYWlsTGFtYmRhID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdBbGVydEVtYWlsRnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hbGVydC1lbWFpbCcsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NlbmRzIGVtYWlsIG5vdGlmaWNhdGlvbnMgZm9yIGxvdyBiYXR0ZXJ5IGFsZXJ0cyB0byBkZXZpY2Ugb3duZXJzJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYWxlcnQtZW1haWwvaW5kZXgudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIERFVklDRVNfVEFCTEU6IHN0b3JhZ2UuZGV2aWNlc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgQUxFUlRTX1RBQkxFOiBzdG9yYWdlLmFsZXJ0c1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgU0VOREVSX0VNQUlMOiAnYnJhbmRvbkBibHVlcy5jb20nLFxuICAgICAgICBEQVNIQk9BUkRfVVJMOiAnaHR0cHM6Ly9zb25nYmlyZC5saXZlJyxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzoge1xuICAgICAgICBtaW5pZnk6IHRydWUsXG4gICAgICAgIHNvdXJjZU1hcDogdHJ1ZSxcbiAgICAgICAgZXh0ZXJuYWxNb2R1bGVzOiBbJ0Bhd3Mtc2RrLyonXSxcbiAgICAgIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG5cbiAgICAvLyBHcmFudCBwZXJtaXNzaW9ucyB0byB0aGUgYWxlcnQgZW1haWwgTGFtYmRhXG4gICAgc3RvcmFnZS5kZXZpY2VzVGFibGUuZ3JhbnRSZWFkRGF0YShhbGVydEVtYWlsTGFtYmRhKTtcbiAgICBzdG9yYWdlLmFsZXJ0c1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShhbGVydEVtYWlsTGFtYmRhKTtcblxuICAgIC8vIEdyYW50IHBlcm1pc3Npb24gdG8gc2VuZCBlbWFpbHMgdmlhIFNFU1xuICAgIGFsZXJ0RW1haWxMYW1iZGEuYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsnc2VzOlNlbmRFbWFpbCcsICdzZXM6U2VuZFJhd0VtYWlsJ10sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgY29uZGl0aW9uczoge1xuICAgICAgICBTdHJpbmdFcXVhbHM6IHtcbiAgICAgICAgICAnc2VzOkZyb21BZGRyZXNzJzogJ2JyYW5kb25AYmx1ZXMuY29tJyxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSkpO1xuXG4gICAgLy8gU3Vic2NyaWJlIHRoZSBlbWFpbCBMYW1iZGEgdG8gdGhlIFNOUyBhbGVydCB0b3BpY1xuICAgIGFsZXJ0VG9waWMuYWRkU3Vic2NyaXB0aW9uKG5ldyBzbnNTdWJzY3JpcHRpb25zLkxhbWJkYVN1YnNjcmlwdGlvbihhbGVydEVtYWlsTGFtYmRhLCB7XG4gICAgICBmaWx0ZXJQb2xpY3k6IHtcbiAgICAgICAgYWxlcnRfdHlwZTogc25zLlN1YnNjcmlwdGlvbkZpbHRlci5zdHJpbmdGaWx0ZXIoe1xuICAgICAgICAgIGFsbG93bGlzdDogWydsb3dfYmF0dGVyeSddLFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSkpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBPdXRwdXRzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQXBpVXJsJywge1xuICAgICAgdmFsdWU6IGFwaS5hcGlVcmwsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NvbmdiaXJkIEFQSSBlbmRwb2ludCBVUkwnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkQXBpVXJsJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdJbmdlc3RVcmwnLCB7XG4gICAgICB2YWx1ZTogYXBpLmluZ2VzdFVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRXZlbnQgaW5nZXN0IFVSTCBmb3IgTm90ZWh1YiBIVFRQIHJvdXRlJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZEluZ2VzdFVybCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRGFzaGJvYXJkVXJsJywge1xuICAgICAgdmFsdWU6IGRhc2hib2FyZC5kaXN0cmlidXRpb25VcmwsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NvbmdiaXJkIERhc2hib2FyZCBVUkwnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkRGFzaGJvYXJkVXJsJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdVc2VyUG9vbElkJywge1xuICAgICAgdmFsdWU6IGF1dGgudXNlclBvb2wudXNlclBvb2xJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byBVc2VyIFBvb2wgSUQnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkVXNlclBvb2xJZCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVXNlclBvb2xDbGllbnRJZCcsIHtcbiAgICAgIHZhbHVlOiBhdXRoLnVzZXJQb29sQ2xpZW50LnVzZXJQb29sQ2xpZW50SWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gVXNlciBQb29sIENsaWVudCBJRCcsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRVc2VyUG9vbENsaWVudElkJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEZXZpY2VzVGFibGVOYW1lJywge1xuICAgICAgdmFsdWU6IHN0b3JhZ2UuZGV2aWNlc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRHluYW1vREIgZGV2aWNlcyB0YWJsZSBuYW1lJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZERldmljZXNUYWJsZScsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVGVsZW1ldHJ5VGFibGVOYW1lJywge1xuICAgICAgdmFsdWU6IHN0b3JhZ2UudGVsZW1ldHJ5VGFibGUudGFibGVOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdEeW5hbW9EQiB0ZWxlbWV0cnkgdGFibGUgbmFtZScsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRUZWxlbWV0cnlUYWJsZScsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQW5hbHl0aWNzQ2x1c3RlckVuZHBvaW50Jywge1xuICAgICAgdmFsdWU6IGFuYWx5dGljcy5jbHVzdGVyLmNsdXN0ZXJFbmRwb2ludC5ob3N0bmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXVyb3JhIEFuYWx5dGljcyBjbHVzdGVyIGVuZHBvaW50JyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZEFuYWx5dGljc0NsdXN0ZXJFbmRwb2ludCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2hhdEhpc3RvcnlUYWJsZU5hbWUnLCB7XG4gICAgICB2YWx1ZTogYW5hbHl0aWNzLmNoYXRIaXN0b3J5VGFibGUudGFibGVOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdBbmFseXRpY3MgY2hhdCBoaXN0b3J5IHRhYmxlIG5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkQ2hhdEhpc3RvcnlUYWJsZScsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQWxlcnRFbWFpbElkZW50aXR5Jywge1xuICAgICAgdmFsdWU6ICdicmFuZG9uQGJsdWVzLmNvbScsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NFUyBlbWFpbCBpZGVudGl0eSBmb3IgYWxlcnRzIChtdXN0IGJlIHZlcmlmaWVkKScsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRBbGVydEVtYWlsSWRlbnRpdHknLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FsZXJ0RW1haWxMYW1iZGFBcm4nLCB7XG4gICAgICB2YWx1ZTogYWxlcnRFbWFpbExhbWJkYS5mdW5jdGlvbkFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQWxlcnQgZW1haWwgTGFtYmRhIGZ1bmN0aW9uIEFSTicsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRBbGVydEVtYWlsTGFtYmRhQXJuJyxcbiAgICB9KTtcbiAgfVxufVxuIl19