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
        const hostedZone = new route53.PublicHostedZone(this, 'HostedZone', {
            zoneName: 'songbird.live',
            comment: 'Hosted zone for Songbird demo platform',
        });
        // Output nameservers for updating at your domain registrar
        new cdk.CfnOutput(this, 'NameServers', {
            value: cdk.Fn.join(', ', hostedZone.hostedZoneNameServers),
            description: 'Nameservers to configure at your domain registrar',
            exportName: 'SongbirdNameServers',
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic29uZ2JpcmQtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvc29uZ2JpcmQtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7O0dBSUc7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBRUgsaURBQW1DO0FBQ25DLHlEQUEyQztBQUMzQyxvRkFBc0U7QUFDdEUsK0RBQWlEO0FBRWpELHlEQUEyQztBQUMzQywyREFBNkM7QUFFN0MscUVBQStEO0FBQy9ELDJDQUE2QjtBQUM3QixpRUFBbUQ7QUFDbkQsMkRBQXVEO0FBQ3ZELG1EQUErQztBQUMvQywrREFBMkQ7QUFDM0QscURBQTBFO0FBQzFFLCtEQUEyRDtBQUMzRCx1RUFBbUU7QUFNbkUsTUFBYSxhQUFjLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDMUMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUF5QjtRQUNqRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4Qiw2RUFBNkU7UUFDN0UscURBQXFEO1FBQ3JELDZFQUE2RTtRQUM3RSxNQUFNLE9BQU8sR0FBRyxJQUFJLG9DQUFnQixDQUFDLElBQUksRUFBRSxTQUFTLEVBQUU7WUFDcEQsZUFBZSxFQUFFLGtCQUFrQjtZQUNuQyxrQkFBa0IsRUFBRSxvQkFBb0I7U0FDekMsQ0FBQyxDQUFDO1FBRUgsNkVBQTZFO1FBQzdFLDJCQUEyQjtRQUMzQiw2RUFBNkU7UUFDN0UsTUFBTSxJQUFJLEdBQUcsSUFBSSw4QkFBYSxDQUFDLElBQUksRUFBRSxNQUFNLEVBQUU7WUFDM0MsWUFBWSxFQUFFLGdCQUFnQjtTQUMvQixDQUFDLENBQUM7UUFFSCw2RUFBNkU7UUFDN0UsdUJBQXVCO1FBQ3ZCLDZFQUE2RTtRQUM3RSxNQUFNLFVBQVUsR0FBRyxJQUFJLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUNuRCxTQUFTLEVBQUUsaUJBQWlC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WUFDaEQsVUFBVSxFQUFFLGtDQUFrQztTQUMvQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHNCQUFzQixFQUFFO1lBQzlDLEtBQUssRUFBRSxTQUFTLENBQUMsZ0JBQWdCLENBQUMsU0FBUztZQUMzQyxXQUFXLEVBQUUsbUNBQW1DO1lBQ2hELFVBQVUsRUFBRSwwQkFBMEI7U0FDdkMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxvQkFBb0IsRUFBRTtZQUM1QyxLQUFLLEVBQUUsbUJBQW1CO1lBQzFCLFdBQVcsRUFBRSxrREFBa0Q7WUFDL0QsVUFBVSxFQUFFLDRCQUE0QjtTQUN6QyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHFCQUFxQixFQUFFO1lBQzdDLEtBQUssRUFBRSxnQkFBZ0IsQ0FBQyxXQUFXO1lBQ25DLFdBQVcsRUFBRSxpQ0FBaUM7WUFDOUMsVUFBVSxFQUFFLDZCQUE2QjtTQUMxQyxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUE1T0Qsc0NBNE9DIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBTb25nYmlyZCBNYWluIFN0YWNrXG4gKlxuICogT3JjaGVzdHJhdGVzIGFsbCBpbmZyYXN0cnVjdHVyZSBjb25zdHJ1Y3RzIGZvciB0aGUgU29uZ2JpcmQgZGVtbyBwbGF0Zm9ybS5cbiAqL1xuXG5pbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgc25zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zbnMnO1xuaW1wb3J0ICogYXMgc25zU3Vic2NyaXB0aW9ucyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc25zLXN1YnNjcmlwdGlvbnMnO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0ICogYXMgc2VzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zZXMnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCB7IE5vZGVqc0Z1bmN0aW9uIH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYS1ub2RlanMnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXJvdXRlNTMnO1xuaW1wb3J0IHsgU3RvcmFnZUNvbnN0cnVjdCB9IGZyb20gJy4vc3RvcmFnZS1jb25zdHJ1Y3QnO1xuaW1wb3J0IHsgQXBpQ29uc3RydWN0IH0gZnJvbSAnLi9hcGktY29uc3RydWN0JztcbmltcG9ydCB7IERhc2hib2FyZENvbnN0cnVjdCB9IGZyb20gJy4vZGFzaGJvYXJkLWNvbnN0cnVjdCc7XG5pbXBvcnQgeyBBdXRoQ29uc3RydWN0LCBQb3N0Q29uZmlybWF0aW9uVHJpZ2dlciB9IGZyb20gJy4vYXV0aC1jb25zdHJ1Y3QnO1xuaW1wb3J0IHsgQW5hbHl0aWNzQ29uc3RydWN0IH0gZnJvbSAnLi9hbmFseXRpY3MtY29uc3RydWN0JztcbmltcG9ydCB7IE9ic2VydmFiaWxpdHlDb25zdHJ1Y3QgfSBmcm9tICcuL29ic2VydmFiaWxpdHktY29uc3RydWN0JztcblxuZXhwb3J0IGludGVyZmFjZSBTb25nYmlyZFN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIG5vdGVodWJQcm9qZWN0VWlkOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBTb25nYmlyZFN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IFNvbmdiaXJkU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBTdG9yYWdlIExheWVyIChEeW5hbW9EQiBmb3IgZGV2aWNlcyBhbmQgdGVsZW1ldHJ5KVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3Qgc3RvcmFnZSA9IG5ldyBTdG9yYWdlQ29uc3RydWN0KHRoaXMsICdTdG9yYWdlJywge1xuICAgICAgZHluYW1vVGFibGVOYW1lOiAnc29uZ2JpcmQtZGV2aWNlcycsXG4gICAgICB0ZWxlbWV0cnlUYWJsZU5hbWU6ICdzb25nYmlyZC10ZWxlbWV0cnknLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBBdXRoZW50aWNhdGlvbiAoQ29nbml0bylcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGF1dGggPSBuZXcgQXV0aENvbnN0cnVjdCh0aGlzLCAnQXV0aCcsIHtcbiAgICAgIHVzZXJQb29sTmFtZTogJ3NvbmdiaXJkLXVzZXJzJyxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gU05TIFRvcGljIGZvciBBbGVydHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGFsZXJ0VG9waWMgPSBuZXcgc25zLlRvcGljKHRoaXMsICdBbGVydFRvcGljJywge1xuICAgICAgdG9waWNOYW1lOiAnc29uZ2JpcmQtYWxlcnRzJyxcbiAgICAgIGRpc3BsYXlOYW1lOiAnU29uZ2JpcmQgQWxlcnQgTm90aWZpY2F0aW9ucycsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEFuYWx5dGljcyBMYXllciAoQXVyb3JhIFNlcnZlcmxlc3MgKyBCZWRyb2NrKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYW5hbHl0aWNzID0gbmV3IEFuYWx5dGljc0NvbnN0cnVjdCh0aGlzLCAnQW5hbHl0aWNzJywge1xuICAgICAgZGV2aWNlc1RhYmxlOiBzdG9yYWdlLmRldmljZXNUYWJsZSxcbiAgICAgIHRlbGVtZXRyeVRhYmxlOiBzdG9yYWdlLnRlbGVtZXRyeVRhYmxlLFxuICAgICAgbG9jYXRpb25zVGFibGU6IHN0b3JhZ2UubG9jYXRpb25zVGFibGUsXG4gICAgICBhbGVydHNUYWJsZTogc3RvcmFnZS5hbGVydHNUYWJsZSxcbiAgICAgIGpvdXJuZXlzVGFibGU6IHN0b3JhZ2Uuam91cm5leXNUYWJsZSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gUm91dGU1MyBIb3N0ZWQgWm9uZSBmb3Igc29uZ2JpcmQubGl2ZVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgaG9zdGVkWm9uZSA9IG5ldyByb3V0ZTUzLlB1YmxpY0hvc3RlZFpvbmUodGhpcywgJ0hvc3RlZFpvbmUnLCB7XG4gICAgICB6b25lTmFtZTogJ3NvbmdiaXJkLmxpdmUnLFxuICAgICAgY29tbWVudDogJ0hvc3RlZCB6b25lIGZvciBTb25nYmlyZCBkZW1vIHBsYXRmb3JtJyxcbiAgICB9KTtcblxuICAgIC8vIE91dHB1dCBuYW1lc2VydmVycyBmb3IgdXBkYXRpbmcgYXQgeW91ciBkb21haW4gcmVnaXN0cmFyXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ05hbWVTZXJ2ZXJzJywge1xuICAgICAgdmFsdWU6IGNkay5Gbi5qb2luKCcsICcsIGhvc3RlZFpvbmUuaG9zdGVkWm9uZU5hbWVTZXJ2ZXJzISksXG4gICAgICBkZXNjcmlwdGlvbjogJ05hbWVzZXJ2ZXJzIHRvIGNvbmZpZ3VyZSBhdCB5b3VyIGRvbWFpbiByZWdpc3RyYXInLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkTmFtZVNlcnZlcnMnLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBPYnNlcnZhYmlsaXR5IExheWVyIChBcml6ZSBQaG9lbml4IG9uIEVDUyBGYXJnYXRlKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3Qgb2JzZXJ2YWJpbGl0eSA9IG5ldyBPYnNlcnZhYmlsaXR5Q29uc3RydWN0KHRoaXMsICdPYnNlcnZhYmlsaXR5Jywge1xuICAgICAgdnBjOiBhbmFseXRpY3MudnBjLFxuICAgICAgZG9tYWluTmFtZTogJ3Bob2VuaXguc29uZ2JpcmQubGl2ZScsXG4gICAgICBob3N0ZWRab25lOiBob3N0ZWRab25lLFxuICAgIH0pO1xuXG4gICAgLy8gQ29uZmlndXJlIGFuYWx5dGljcyBMYW1iZGEgdG8gc2VuZCB0cmFjZXMgdG8gUGhvZW5peFxuICAgIGFuYWx5dGljcy5jb25maWd1cmVQaG9lbml4VHJhY2luZyhvYnNlcnZhYmlsaXR5Lm90bHBFbmRwb2ludCk7XG4gICAgb2JzZXJ2YWJpbGl0eS5hbGxvd1RyYWNpbmdGcm9tKGFuYWx5dGljcy5jaGF0UXVlcnlMYW1iZGEpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBBUEkgTGF5ZXIgKEFQSSBHYXRld2F5ICsgTGFtYmRhKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYXBpID0gbmV3IEFwaUNvbnN0cnVjdCh0aGlzLCAnQXBpJywge1xuICAgICAgdGVsZW1ldHJ5VGFibGU6IHN0b3JhZ2UudGVsZW1ldHJ5VGFibGUsXG4gICAgICBkZXZpY2VzVGFibGU6IHN0b3JhZ2UuZGV2aWNlc1RhYmxlLFxuICAgICAgYWxlcnRzVGFibGU6IHN0b3JhZ2UuYWxlcnRzVGFibGUsXG4gICAgICBzZXR0aW5nc1RhYmxlOiBzdG9yYWdlLnNldHRpbmdzVGFibGUsXG4gICAgICBqb3VybmV5c1RhYmxlOiBzdG9yYWdlLmpvdXJuZXlzVGFibGUsXG4gICAgICBsb2NhdGlvbnNUYWJsZTogc3RvcmFnZS5sb2NhdGlvbnNUYWJsZSxcbiAgICAgIGRldmljZUFsaWFzZXNUYWJsZTogc3RvcmFnZS5kZXZpY2VBbGlhc2VzVGFibGUsXG4gICAgICBhdWRpdFRhYmxlOiBzdG9yYWdlLmF1ZGl0VGFibGUsXG4gICAgICB1c2VyUG9vbDogYXV0aC51c2VyUG9vbCxcbiAgICAgIHVzZXJQb29sQ2xpZW50OiBhdXRoLnVzZXJQb29sQ2xpZW50LFxuICAgICAgbm90ZWh1YlByb2plY3RVaWQ6IHByb3BzLm5vdGVodWJQcm9qZWN0VWlkLFxuICAgICAgYWxlcnRUb3BpYyxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBBbmFseXRpY3Mgcm91dGVzIHRvIEFQSVxuICAgIGFwaS5hZGRBbmFseXRpY3NSb3V0ZXMoXG4gICAgICBhbmFseXRpY3MuY2hhdFF1ZXJ5TGFtYmRhLFxuICAgICAgYW5hbHl0aWNzLmNoYXRIaXN0b3J5TGFtYmRhLFxuICAgICAgYW5hbHl0aWNzLmxpc3RTZXNzaW9uc0xhbWJkYSxcbiAgICAgIGFuYWx5dGljcy5nZXRTZXNzaW9uTGFtYmRhLFxuICAgICAgYW5hbHl0aWNzLmRlbGV0ZVNlc3Npb25MYW1iZGEsXG4gICAgICBhbmFseXRpY3MucmVydW5RdWVyeUxhbWJkYVxuICAgICk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFBvc3QtQ29uZmlybWF0aW9uIExhbWJkYSBUcmlnZ2VyIChmb3Igc2VsZi1zaWdudXAgd2l0aCBWaWV3ZXIgcm9sZSlcbiAgICAvLyBNdXN0IGJlIGNyZWF0ZWQgYWZ0ZXIgQVBJIGNvbnN0cnVjdCB0byBhdm9pZCBjaXJjdWxhciBkZXBlbmRlbmNpZXNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIG5ldyBQb3N0Q29uZmlybWF0aW9uVHJpZ2dlcih0aGlzLCAnUG9zdENvbmZpcm1hdGlvbicsIHtcbiAgICAgIHVzZXJQb29sOiBhdXRoLnVzZXJQb29sLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBEYXNoYm9hcmQgSG9zdGluZyAoUzMgKyBDbG91ZEZyb250KVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgZGFzaGJvYXJkID0gbmV3IERhc2hib2FyZENvbnN0cnVjdCh0aGlzLCAnRGFzaGJvYXJkJywge1xuICAgICAgYXBpVXJsOiBhcGkuYXBpVXJsLFxuICAgICAgdXNlclBvb2xJZDogYXV0aC51c2VyUG9vbC51c2VyUG9vbElkLFxuICAgICAgdXNlclBvb2xDbGllbnRJZDogYXV0aC51c2VyUG9vbENsaWVudC51c2VyUG9vbENsaWVudElkLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBTRVMgRW1haWwgSWRlbnRpdHkgKGZvciBhbGVydCBlbWFpbHMpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBOb3RlOiBFbWFpbCBpZGVudGl0eSAnYnJhbmRvbkBibHVlcy5jb20nIG11c3QgYmUgdmVyaWZpZWQgaW4gU0VTXG4gICAgLy8gVGhlIGlkZW50aXR5IGFscmVhZHkgZXhpc3RzIGFuZCBpcyBtYW5hZ2VkIG91dHNpZGUgb2YgQ0RLXG4gICAgLy8gV2UganVzdCByZWZlcmVuY2UgaXQgaGVyZSBmb3IgZG9jdW1lbnRhdGlvbiBwdXJwb3Nlc1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBBbGVydCBFbWFpbCBMYW1iZGFcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGFsZXJ0RW1haWxMYW1iZGEgPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0FsZXJ0RW1haWxGdW5jdGlvbicsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFsZXJ0LWVtYWlsJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU2VuZHMgZW1haWwgbm90aWZpY2F0aW9ucyBmb3IgbG93IGJhdHRlcnkgYWxlcnRzIHRvIGRldmljZSBvd25lcnMnLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hbGVydC1lbWFpbC9pbmRleC50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgREVWSUNFU19UQUJMRTogc3RvcmFnZS5kZXZpY2VzVGFibGUudGFibGVOYW1lLFxuICAgICAgICBBTEVSVFNfVEFCTEU6IHN0b3JhZ2UuYWxlcnRzVGFibGUudGFibGVOYW1lLFxuICAgICAgICBTRU5ERVJfRU1BSUw6ICdicmFuZG9uQGJsdWVzLmNvbScsXG4gICAgICAgIERBU0hCT0FSRF9VUkw6ICdodHRwczovL3NvbmdiaXJkLmxpdmUnLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7XG4gICAgICAgIG1pbmlmeTogdHJ1ZSxcbiAgICAgICAgc291cmNlTWFwOiB0cnVlLFxuICAgICAgICBleHRlcm5hbE1vZHVsZXM6IFsnQGF3cy1zZGsvKiddLFxuICAgICAgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcblxuICAgIC8vIEdyYW50IHBlcm1pc3Npb25zIHRvIHRoZSBhbGVydCBlbWFpbCBMYW1iZGFcbiAgICBzdG9yYWdlLmRldmljZXNUYWJsZS5ncmFudFJlYWREYXRhKGFsZXJ0RW1haWxMYW1iZGEpO1xuICAgIHN0b3JhZ2UuYWxlcnRzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGFsZXJ0RW1haWxMYW1iZGEpO1xuXG4gICAgLy8gR3JhbnQgcGVybWlzc2lvbiB0byBzZW5kIGVtYWlscyB2aWEgU0VTXG4gICAgYWxlcnRFbWFpbExhbWJkYS5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogWydzZXM6U2VuZEVtYWlsJywgJ3NlczpTZW5kUmF3RW1haWwnXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICBjb25kaXRpb25zOiB7XG4gICAgICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgICAgICdzZXM6RnJvbUFkZHJlc3MnOiAnYnJhbmRvbkBibHVlcy5jb20nLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KSk7XG5cbiAgICAvLyBTdWJzY3JpYmUgdGhlIGVtYWlsIExhbWJkYSB0byB0aGUgU05TIGFsZXJ0IHRvcGljXG4gICAgYWxlcnRUb3BpYy5hZGRTdWJzY3JpcHRpb24obmV3IHNuc1N1YnNjcmlwdGlvbnMuTGFtYmRhU3Vic2NyaXB0aW9uKGFsZXJ0RW1haWxMYW1iZGEsIHtcbiAgICAgIGZpbHRlclBvbGljeToge1xuICAgICAgICBhbGVydF90eXBlOiBzbnMuU3Vic2NyaXB0aW9uRmlsdGVyLnN0cmluZ0ZpbHRlcih7XG4gICAgICAgICAgYWxsb3dsaXN0OiBbJ2xvd19iYXR0ZXJ5J10sXG4gICAgICAgIH0pLFxuICAgICAgfSxcbiAgICB9KSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE91dHB1dHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBcGlVcmwnLCB7XG4gICAgICB2YWx1ZTogYXBpLmFwaVVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgQVBJIGVuZHBvaW50IFVSTCcsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRBcGlVcmwnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0luZ2VzdFVybCcsIHtcbiAgICAgIHZhbHVlOiBhcGkuaW5nZXN0VXJsLFxuICAgICAgZGVzY3JpcHRpb246ICdFdmVudCBpbmdlc3QgVVJMIGZvciBOb3RlaHViIEhUVFAgcm91dGUnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkSW5nZXN0VXJsJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEYXNoYm9hcmRVcmwnLCB7XG4gICAgICB2YWx1ZTogZGFzaGJvYXJkLmRpc3RyaWJ1dGlvblVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgRGFzaGJvYXJkIFVSTCcsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmREYXNoYm9hcmRVcmwnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1VzZXJQb29sSWQnLCB7XG4gICAgICB2YWx1ZTogYXV0aC51c2VyUG9vbC51c2VyUG9vbElkLFxuICAgICAgZGVzY3JpcHRpb246ICdDb2duaXRvIFVzZXIgUG9vbCBJRCcsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRVc2VyUG9vbElkJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdVc2VyUG9vbENsaWVudElkJywge1xuICAgICAgdmFsdWU6IGF1dGgudXNlclBvb2xDbGllbnQudXNlclBvb2xDbGllbnRJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byBVc2VyIFBvb2wgQ2xpZW50IElEJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZFVzZXJQb29sQ2xpZW50SWQnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0RldmljZXNUYWJsZU5hbWUnLCB7XG4gICAgICB2YWx1ZTogc3RvcmFnZS5kZXZpY2VzVGFibGUudGFibGVOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdEeW5hbW9EQiBkZXZpY2VzIHRhYmxlIG5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkRGV2aWNlc1RhYmxlJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdUZWxlbWV0cnlUYWJsZU5hbWUnLCB7XG4gICAgICB2YWx1ZTogc3RvcmFnZS50ZWxlbWV0cnlUYWJsZS50YWJsZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0R5bmFtb0RCIHRlbGVtZXRyeSB0YWJsZSBuYW1lJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZFRlbGVtZXRyeVRhYmxlJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBbmFseXRpY3NDbHVzdGVyRW5kcG9pbnQnLCB7XG4gICAgICB2YWx1ZTogYW5hbHl0aWNzLmNsdXN0ZXIuY2x1c3RlckVuZHBvaW50Lmhvc3RuYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdBdXJvcmEgQW5hbHl0aWNzIGNsdXN0ZXIgZW5kcG9pbnQnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkQW5hbHl0aWNzQ2x1c3RlckVuZHBvaW50JyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdDaGF0SGlzdG9yeVRhYmxlTmFtZScsIHtcbiAgICAgIHZhbHVlOiBhbmFseXRpY3MuY2hhdEhpc3RvcnlUYWJsZS50YWJsZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FuYWx5dGljcyBjaGF0IGhpc3RvcnkgdGFibGUgbmFtZScsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRDaGF0SGlzdG9yeVRhYmxlJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBbGVydEVtYWlsSWRlbnRpdHknLCB7XG4gICAgICB2YWx1ZTogJ2JyYW5kb25AYmx1ZXMuY29tJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU0VTIGVtYWlsIGlkZW50aXR5IGZvciBhbGVydHMgKG11c3QgYmUgdmVyaWZpZWQpJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZEFsZXJ0RW1haWxJZGVudGl0eScsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQWxlcnRFbWFpbExhbWJkYUFybicsIHtcbiAgICAgIHZhbHVlOiBhbGVydEVtYWlsTGFtYmRhLmZ1bmN0aW9uQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdBbGVydCBlbWFpbCBMYW1iZGEgZnVuY3Rpb24gQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZEFsZXJ0RW1haWxMYW1iZGFBcm4nLFxuICAgIH0pO1xuICB9XG59XG4iXX0=