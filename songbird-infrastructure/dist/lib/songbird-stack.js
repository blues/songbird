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
        // Observability Layer (Arize Phoenix on ECS Fargate)
        // ==========================================================================
        // Note: DNS/certificate setup skipped for now - will use ALB DNS directly
        // To enable custom domain, create Route53 hosted zone and pass it here
        const observability = new observability_construct_1.ObservabilityConstruct(this, 'Observability', {
            vpc: analytics.vpc,
            // domainName: 'phoenix.songbird.live',  // Uncomment when hosted zone exists
            // hostedZone: route53.HostedZone.fromLookup(this, 'HostedZone', { domainName: 'songbird.live' }),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic29uZ2JpcmQtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvc29uZ2JpcmQtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7O0dBSUc7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBRUgsaURBQW1DO0FBQ25DLHlEQUEyQztBQUMzQyxvRkFBc0U7QUFDdEUsK0RBQWlEO0FBRWpELHlEQUEyQztBQUMzQywyREFBNkM7QUFFN0MscUVBQStEO0FBQy9ELDJDQUE2QjtBQUU3QiwyREFBdUQ7QUFDdkQsbURBQStDO0FBQy9DLCtEQUEyRDtBQUMzRCxxREFBMEU7QUFDMUUsK0RBQTJEO0FBQzNELHVFQUFtRTtBQU1uRSxNQUFhLGFBQWMsU0FBUSxHQUFHLENBQUMsS0FBSztJQUMxQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXlCO1FBQ2pFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLDZFQUE2RTtRQUM3RSxxREFBcUQ7UUFDckQsNkVBQTZFO1FBQzdFLE1BQU0sT0FBTyxHQUFHLElBQUksb0NBQWdCLENBQUMsSUFBSSxFQUFFLFNBQVMsRUFBRTtZQUNwRCxlQUFlLEVBQUUsa0JBQWtCO1lBQ25DLGtCQUFrQixFQUFFLG9CQUFvQjtTQUN6QyxDQUFDLENBQUM7UUFFSCw2RUFBNkU7UUFDN0UsMkJBQTJCO1FBQzNCLDZFQUE2RTtRQUM3RSxNQUFNLElBQUksR0FBRyxJQUFJLDhCQUFhLENBQUMsSUFBSSxFQUFFLE1BQU0sRUFBRTtZQUMzQyxZQUFZLEVBQUUsZ0JBQWdCO1NBQy9CLENBQUMsQ0FBQztRQUVILDZFQUE2RTtRQUM3RSx1QkFBdUI7UUFDdkIsNkVBQTZFO1FBQzdFLE1BQU0sVUFBVSxHQUFHLElBQUksR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO1lBQ25ELFNBQVMsRUFBRSxpQkFBaUI7WUFDNUIsV0FBVyxF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QkFBcUIsRUFBRTtZQUM3QyxLQUFLLEVBQUUsZ0JBQWdCLENBQUMsV0FBVztZQUNuQyxXQUFXLEVBQUUsaUNBQWlDO1lBQzlDLFVBQVUsRUFBRSw2QkFBNkI7U0FDMUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBL05ELHNDQStOQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU29uZ2JpcmQgTWFpbiBTdGFja1xuICpcbiAqIE9yY2hlc3RyYXRlcyBhbGwgaW5mcmFzdHJ1Y3R1cmUgY29uc3RydWN0cyBmb3IgdGhlIFNvbmdiaXJkIGRlbW8gcGxhdGZvcm0uXG4gKi9cblxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIHNucyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc25zJztcbmltcG9ydCAqIGFzIHNuc1N1YnNjcmlwdGlvbnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNucy1zdWJzY3JpcHRpb25zJztcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcbmltcG9ydCAqIGFzIHNlcyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc2VzJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxvZ3MnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgeyBOb2RlanNGdW5jdGlvbiB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEtbm9kZWpzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1yb3V0ZTUzJztcbmltcG9ydCB7IFN0b3JhZ2VDb25zdHJ1Y3QgfSBmcm9tICcuL3N0b3JhZ2UtY29uc3RydWN0JztcbmltcG9ydCB7IEFwaUNvbnN0cnVjdCB9IGZyb20gJy4vYXBpLWNvbnN0cnVjdCc7XG5pbXBvcnQgeyBEYXNoYm9hcmRDb25zdHJ1Y3QgfSBmcm9tICcuL2Rhc2hib2FyZC1jb25zdHJ1Y3QnO1xuaW1wb3J0IHsgQXV0aENvbnN0cnVjdCwgUG9zdENvbmZpcm1hdGlvblRyaWdnZXIgfSBmcm9tICcuL2F1dGgtY29uc3RydWN0JztcbmltcG9ydCB7IEFuYWx5dGljc0NvbnN0cnVjdCB9IGZyb20gJy4vYW5hbHl0aWNzLWNvbnN0cnVjdCc7XG5pbXBvcnQgeyBPYnNlcnZhYmlsaXR5Q29uc3RydWN0IH0gZnJvbSAnLi9vYnNlcnZhYmlsaXR5LWNvbnN0cnVjdCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU29uZ2JpcmRTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICBub3RlaHViUHJvamVjdFVpZDogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgU29uZ2JpcmRTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBTb25nYmlyZFN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gU3RvcmFnZSBMYXllciAoRHluYW1vREIgZm9yIGRldmljZXMgYW5kIHRlbGVtZXRyeSlcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IHN0b3JhZ2UgPSBuZXcgU3RvcmFnZUNvbnN0cnVjdCh0aGlzLCAnU3RvcmFnZScsIHtcbiAgICAgIGR5bmFtb1RhYmxlTmFtZTogJ3NvbmdiaXJkLWRldmljZXMnLFxuICAgICAgdGVsZW1ldHJ5VGFibGVOYW1lOiAnc29uZ2JpcmQtdGVsZW1ldHJ5JyxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQXV0aGVudGljYXRpb24gKENvZ25pdG8pXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBhdXRoID0gbmV3IEF1dGhDb25zdHJ1Y3QodGhpcywgJ0F1dGgnLCB7XG4gICAgICB1c2VyUG9vbE5hbWU6ICdzb25nYmlyZC11c2VycycsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFNOUyBUb3BpYyBmb3IgQWxlcnRzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBhbGVydFRvcGljID0gbmV3IHNucy5Ub3BpYyh0aGlzLCAnQWxlcnRUb3BpYycsIHtcbiAgICAgIHRvcGljTmFtZTogJ3NvbmdiaXJkLWFsZXJ0cycsXG4gICAgICBkaXNwbGF5TmFtZTogJ1NvbmdiaXJkIEFsZXJ0IE5vdGlmaWNhdGlvbnMnLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBBbmFseXRpY3MgTGF5ZXIgKEF1cm9yYSBTZXJ2ZXJsZXNzICsgQmVkcm9jaylcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGFuYWx5dGljcyA9IG5ldyBBbmFseXRpY3NDb25zdHJ1Y3QodGhpcywgJ0FuYWx5dGljcycsIHtcbiAgICAgIGRldmljZXNUYWJsZTogc3RvcmFnZS5kZXZpY2VzVGFibGUsXG4gICAgICB0ZWxlbWV0cnlUYWJsZTogc3RvcmFnZS50ZWxlbWV0cnlUYWJsZSxcbiAgICAgIGxvY2F0aW9uc1RhYmxlOiBzdG9yYWdlLmxvY2F0aW9uc1RhYmxlLFxuICAgICAgYWxlcnRzVGFibGU6IHN0b3JhZ2UuYWxlcnRzVGFibGUsXG4gICAgICBqb3VybmV5c1RhYmxlOiBzdG9yYWdlLmpvdXJuZXlzVGFibGUsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE9ic2VydmFiaWxpdHkgTGF5ZXIgKEFyaXplIFBob2VuaXggb24gRUNTIEZhcmdhdGUpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBOb3RlOiBETlMvY2VydGlmaWNhdGUgc2V0dXAgc2tpcHBlZCBmb3Igbm93IC0gd2lsbCB1c2UgQUxCIEROUyBkaXJlY3RseVxuICAgIC8vIFRvIGVuYWJsZSBjdXN0b20gZG9tYWluLCBjcmVhdGUgUm91dGU1MyBob3N0ZWQgem9uZSBhbmQgcGFzcyBpdCBoZXJlXG4gICAgY29uc3Qgb2JzZXJ2YWJpbGl0eSA9IG5ldyBPYnNlcnZhYmlsaXR5Q29uc3RydWN0KHRoaXMsICdPYnNlcnZhYmlsaXR5Jywge1xuICAgICAgdnBjOiBhbmFseXRpY3MudnBjLFxuICAgICAgLy8gZG9tYWluTmFtZTogJ3Bob2VuaXguc29uZ2JpcmQubGl2ZScsICAvLyBVbmNvbW1lbnQgd2hlbiBob3N0ZWQgem9uZSBleGlzdHNcbiAgICAgIC8vIGhvc3RlZFpvbmU6IHJvdXRlNTMuSG9zdGVkWm9uZS5mcm9tTG9va3VwKHRoaXMsICdIb3N0ZWRab25lJywgeyBkb21haW5OYW1lOiAnc29uZ2JpcmQubGl2ZScgfSksXG4gICAgfSk7XG5cbiAgICAvLyBDb25maWd1cmUgYW5hbHl0aWNzIExhbWJkYSB0byBzZW5kIHRyYWNlcyB0byBQaG9lbml4XG4gICAgYW5hbHl0aWNzLmNvbmZpZ3VyZVBob2VuaXhUcmFjaW5nKG9ic2VydmFiaWxpdHkub3RscEVuZHBvaW50KTtcbiAgICBvYnNlcnZhYmlsaXR5LmFsbG93VHJhY2luZ0Zyb20oYW5hbHl0aWNzLmNoYXRRdWVyeUxhbWJkYSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEFQSSBMYXllciAoQVBJIEdhdGV3YXkgKyBMYW1iZGEpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBhcGkgPSBuZXcgQXBpQ29uc3RydWN0KHRoaXMsICdBcGknLCB7XG4gICAgICB0ZWxlbWV0cnlUYWJsZTogc3RvcmFnZS50ZWxlbWV0cnlUYWJsZSxcbiAgICAgIGRldmljZXNUYWJsZTogc3RvcmFnZS5kZXZpY2VzVGFibGUsXG4gICAgICBhbGVydHNUYWJsZTogc3RvcmFnZS5hbGVydHNUYWJsZSxcbiAgICAgIHNldHRpbmdzVGFibGU6IHN0b3JhZ2Uuc2V0dGluZ3NUYWJsZSxcbiAgICAgIGpvdXJuZXlzVGFibGU6IHN0b3JhZ2Uuam91cm5leXNUYWJsZSxcbiAgICAgIGxvY2F0aW9uc1RhYmxlOiBzdG9yYWdlLmxvY2F0aW9uc1RhYmxlLFxuICAgICAgZGV2aWNlQWxpYXNlc1RhYmxlOiBzdG9yYWdlLmRldmljZUFsaWFzZXNUYWJsZSxcbiAgICAgIGF1ZGl0VGFibGU6IHN0b3JhZ2UuYXVkaXRUYWJsZSxcbiAgICAgIHVzZXJQb29sOiBhdXRoLnVzZXJQb29sLFxuICAgICAgdXNlclBvb2xDbGllbnQ6IGF1dGgudXNlclBvb2xDbGllbnQsXG4gICAgICBub3RlaHViUHJvamVjdFVpZDogcHJvcHMubm90ZWh1YlByb2plY3RVaWQsXG4gICAgICBhbGVydFRvcGljLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIEFuYWx5dGljcyByb3V0ZXMgdG8gQVBJXG4gICAgYXBpLmFkZEFuYWx5dGljc1JvdXRlcyhcbiAgICAgIGFuYWx5dGljcy5jaGF0UXVlcnlMYW1iZGEsXG4gICAgICBhbmFseXRpY3MuY2hhdEhpc3RvcnlMYW1iZGEsXG4gICAgICBhbmFseXRpY3MubGlzdFNlc3Npb25zTGFtYmRhLFxuICAgICAgYW5hbHl0aWNzLmdldFNlc3Npb25MYW1iZGEsXG4gICAgICBhbmFseXRpY3MuZGVsZXRlU2Vzc2lvbkxhbWJkYSxcbiAgICAgIGFuYWx5dGljcy5yZXJ1blF1ZXJ5TGFtYmRhXG4gICAgKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gUG9zdC1Db25maXJtYXRpb24gTGFtYmRhIFRyaWdnZXIgKGZvciBzZWxmLXNpZ251cCB3aXRoIFZpZXdlciByb2xlKVxuICAgIC8vIE11c3QgYmUgY3JlYXRlZCBhZnRlciBBUEkgY29uc3RydWN0IHRvIGF2b2lkIGNpcmN1bGFyIGRlcGVuZGVuY2llc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgbmV3IFBvc3RDb25maXJtYXRpb25UcmlnZ2VyKHRoaXMsICdQb3N0Q29uZmlybWF0aW9uJywge1xuICAgICAgdXNlclBvb2w6IGF1dGgudXNlclBvb2wsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIERhc2hib2FyZCBIb3N0aW5nIChTMyArIENsb3VkRnJvbnQpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBkYXNoYm9hcmQgPSBuZXcgRGFzaGJvYXJkQ29uc3RydWN0KHRoaXMsICdEYXNoYm9hcmQnLCB7XG4gICAgICBhcGlVcmw6IGFwaS5hcGlVcmwsXG4gICAgICB1c2VyUG9vbElkOiBhdXRoLnVzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICB1c2VyUG9vbENsaWVudElkOiBhdXRoLnVzZXJQb29sQ2xpZW50LnVzZXJQb29sQ2xpZW50SWQsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFNFUyBFbWFpbCBJZGVudGl0eSAoZm9yIGFsZXJ0IGVtYWlscylcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE5vdGU6IEVtYWlsIGlkZW50aXR5ICdicmFuZG9uQGJsdWVzLmNvbScgbXVzdCBiZSB2ZXJpZmllZCBpbiBTRVNcbiAgICAvLyBUaGUgaWRlbnRpdHkgYWxyZWFkeSBleGlzdHMgYW5kIGlzIG1hbmFnZWQgb3V0c2lkZSBvZiBDREtcbiAgICAvLyBXZSBqdXN0IHJlZmVyZW5jZSBpdCBoZXJlIGZvciBkb2N1bWVudGF0aW9uIHB1cnBvc2VzXG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEFsZXJ0IEVtYWlsIExhbWJkYVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYWxlcnRFbWFpbExhbWJkYSA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnQWxlcnRFbWFpbEZ1bmN0aW9uJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYWxlcnQtZW1haWwnLFxuICAgICAgZGVzY3JpcHRpb246ICdTZW5kcyBlbWFpbCBub3RpZmljYXRpb25zIGZvciBsb3cgYmF0dGVyeSBhbGVydHMgdG8gZGV2aWNlIG93bmVycycsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FsZXJ0LWVtYWlsL2luZGV4LnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBERVZJQ0VTX1RBQkxFOiBzdG9yYWdlLmRldmljZXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIEFMRVJUU19UQUJMRTogc3RvcmFnZS5hbGVydHNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIFNFTkRFUl9FTUFJTDogJ2JyYW5kb25AYmx1ZXMuY29tJyxcbiAgICAgICAgREFTSEJPQVJEX1VSTDogJ2h0dHBzOi8vc29uZ2JpcmQubGl2ZScsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHtcbiAgICAgICAgbWluaWZ5OiB0cnVlLFxuICAgICAgICBzb3VyY2VNYXA6IHRydWUsXG4gICAgICAgIGV4dGVybmFsTW9kdWxlczogWydAYXdzLXNkay8qJ10sXG4gICAgICB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuXG4gICAgLy8gR3JhbnQgcGVybWlzc2lvbnMgdG8gdGhlIGFsZXJ0IGVtYWlsIExhbWJkYVxuICAgIHN0b3JhZ2UuZGV2aWNlc1RhYmxlLmdyYW50UmVhZERhdGEoYWxlcnRFbWFpbExhbWJkYSk7XG4gICAgc3RvcmFnZS5hbGVydHNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoYWxlcnRFbWFpbExhbWJkYSk7XG5cbiAgICAvLyBHcmFudCBwZXJtaXNzaW9uIHRvIHNlbmQgZW1haWxzIHZpYSBTRVNcbiAgICBhbGVydEVtYWlsTGFtYmRhLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ3NlczpTZW5kRW1haWwnLCAnc2VzOlNlbmRSYXdFbWFpbCddLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgIGNvbmRpdGlvbnM6IHtcbiAgICAgICAgU3RyaW5nRXF1YWxzOiB7XG4gICAgICAgICAgJ3NlczpGcm9tQWRkcmVzcyc6ICdicmFuZG9uQGJsdWVzLmNvbScsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pKTtcblxuICAgIC8vIFN1YnNjcmliZSB0aGUgZW1haWwgTGFtYmRhIHRvIHRoZSBTTlMgYWxlcnQgdG9waWNcbiAgICBhbGVydFRvcGljLmFkZFN1YnNjcmlwdGlvbihuZXcgc25zU3Vic2NyaXB0aW9ucy5MYW1iZGFTdWJzY3JpcHRpb24oYWxlcnRFbWFpbExhbWJkYSwge1xuICAgICAgZmlsdGVyUG9saWN5OiB7XG4gICAgICAgIGFsZXJ0X3R5cGU6IHNucy5TdWJzY3JpcHRpb25GaWx0ZXIuc3RyaW5nRmlsdGVyKHtcbiAgICAgICAgICBhbGxvd2xpc3Q6IFsnbG93X2JhdHRlcnknXSxcbiAgICAgICAgfSksXG4gICAgICB9LFxuICAgIH0pKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gT3V0cHV0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FwaVVybCcsIHtcbiAgICAgIHZhbHVlOiBhcGkuYXBpVXJsLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBBUEkgZW5kcG9pbnQgVVJMJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZEFwaVVybCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnSW5nZXN0VXJsJywge1xuICAgICAgdmFsdWU6IGFwaS5pbmdlc3RVcmwsXG4gICAgICBkZXNjcmlwdGlvbjogJ0V2ZW50IGluZ2VzdCBVUkwgZm9yIE5vdGVodWIgSFRUUCByb3V0ZScsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRJbmdlc3RVcmwnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0Rhc2hib2FyZFVybCcsIHtcbiAgICAgIHZhbHVlOiBkYXNoYm9hcmQuZGlzdHJpYnV0aW9uVXJsLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBEYXNoYm9hcmQgVVJMJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZERhc2hib2FyZFVybCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVXNlclBvb2xJZCcsIHtcbiAgICAgIHZhbHVlOiBhdXRoLnVzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gVXNlciBQb29sIElEJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZFVzZXJQb29sSWQnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1VzZXJQb29sQ2xpZW50SWQnLCB7XG4gICAgICB2YWx1ZTogYXV0aC51c2VyUG9vbENsaWVudC51c2VyUG9vbENsaWVudElkLFxuICAgICAgZGVzY3JpcHRpb246ICdDb2duaXRvIFVzZXIgUG9vbCBDbGllbnQgSUQnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkVXNlclBvb2xDbGllbnRJZCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRGV2aWNlc1RhYmxlTmFtZScsIHtcbiAgICAgIHZhbHVlOiBzdG9yYWdlLmRldmljZXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0R5bmFtb0RCIGRldmljZXMgdGFibGUgbmFtZScsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmREZXZpY2VzVGFibGUnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1RlbGVtZXRyeVRhYmxlTmFtZScsIHtcbiAgICAgIHZhbHVlOiBzdG9yYWdlLnRlbGVtZXRyeVRhYmxlLnRhYmxlTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRHluYW1vREIgdGVsZW1ldHJ5IHRhYmxlIG5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkVGVsZW1ldHJ5VGFibGUnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FuYWx5dGljc0NsdXN0ZXJFbmRwb2ludCcsIHtcbiAgICAgIHZhbHVlOiBhbmFseXRpY3MuY2x1c3Rlci5jbHVzdGVyRW5kcG9pbnQuaG9zdG5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0F1cm9yYSBBbmFseXRpY3MgY2x1c3RlciBlbmRwb2ludCcsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRBbmFseXRpY3NDbHVzdGVyRW5kcG9pbnQnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0NoYXRIaXN0b3J5VGFibGVOYW1lJywge1xuICAgICAgdmFsdWU6IGFuYWx5dGljcy5jaGF0SGlzdG9yeVRhYmxlLnRhYmxlTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQW5hbHl0aWNzIGNoYXQgaGlzdG9yeSB0YWJsZSBuYW1lJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZENoYXRIaXN0b3J5VGFibGUnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FsZXJ0RW1haWxJZGVudGl0eScsIHtcbiAgICAgIHZhbHVlOiAnYnJhbmRvbkBibHVlcy5jb20nLFxuICAgICAgZGVzY3JpcHRpb246ICdTRVMgZW1haWwgaWRlbnRpdHkgZm9yIGFsZXJ0cyAobXVzdCBiZSB2ZXJpZmllZCknLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkQWxlcnRFbWFpbElkZW50aXR5JyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBbGVydEVtYWlsTGFtYmRhQXJuJywge1xuICAgICAgdmFsdWU6IGFsZXJ0RW1haWxMYW1iZGEuZnVuY3Rpb25Bcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FsZXJ0IGVtYWlsIExhbWJkYSBmdW5jdGlvbiBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkQWxlcnRFbWFpbExhbWJkYUFybicsXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==