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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic29uZ2JpcmQtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvc29uZ2JpcmQtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7O0dBSUc7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBRUgsaURBQW1DO0FBQ25DLHlEQUEyQztBQUMzQyxvRkFBc0U7QUFDdEUsK0RBQWlEO0FBRWpELHlEQUEyQztBQUMzQywyREFBNkM7QUFFN0MscUVBQStEO0FBQy9ELDJDQUE2QjtBQUM3QiwyREFBdUQ7QUFDdkQsbURBQStDO0FBQy9DLCtEQUEyRDtBQUMzRCxxREFBMEU7QUFDMUUsK0RBQTJEO0FBTTNELE1BQWEsYUFBYyxTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBQzFDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBeUI7UUFDakUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsNkVBQTZFO1FBQzdFLHFEQUFxRDtRQUNyRCw2RUFBNkU7UUFDN0UsTUFBTSxPQUFPLEdBQUcsSUFBSSxvQ0FBZ0IsQ0FBQyxJQUFJLEVBQUUsU0FBUyxFQUFFO1lBQ3BELGVBQWUsRUFBRSxrQkFBa0I7WUFDbkMsa0JBQWtCLEVBQUUsb0JBQW9CO1NBQ3pDLENBQUMsQ0FBQztRQUVILDZFQUE2RTtRQUM3RSwyQkFBMkI7UUFDM0IsNkVBQTZFO1FBQzdFLE1BQU0sSUFBSSxHQUFHLElBQUksOEJBQWEsQ0FBQyxJQUFJLEVBQUUsTUFBTSxFQUFFO1lBQzNDLFlBQVksRUFBRSxnQkFBZ0I7U0FDL0IsQ0FBQyxDQUFDO1FBRUgsNkVBQTZFO1FBQzdFLHVCQUF1QjtRQUN2Qiw2RUFBNkU7UUFDN0UsTUFBTSxVQUFVLEdBQUcsSUFBSSxHQUFHLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7WUFDbkQsU0FBUyxFQUFFLGlCQUFpQjtZQUM1QixXQUFXLEVBQUUsOEJBQThCO1NB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LENBQUMsU0FBUztZQUN2QyxXQUFXLEVBQUUsK0JBQStCO1lBQzVDLFVBQVUsRUFBRSx3QkFBd0I7U0FDckMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSwwQkFBMEIsRUFBRTtZQUNsRCxLQUFLLEVBQUUsU0FBUyxDQUFDLE9BQU8sQ0FBQyxlQUFlLENBQUMsUUFBUTtZQUNqRCxXQUFXLEVBQUUsbUNBQW1DO1lBQ2hELFVBQVUsRUFBRSxrQ0FBa0M7U0FDL0MsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxzQkFBc0IsRUFBRTtZQUM5QyxLQUFLLEVBQUUsU0FBUyxDQUFDLGdCQUFnQixDQUFDLFNBQVM7WUFDM0MsV0FBVyxFQUFFLG1DQUFtQztZQUNoRCxVQUFVLEVBQUUsMEJBQTBCO1NBQ3ZDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsb0JBQW9CLEVBQUU7WUFDNUMsS0FBSyxFQUFFLG1CQUFtQjtZQUMxQixXQUFXLEVBQUUsa0RBQWtEO1lBQy9ELFVBQVUsRUFBRSw0QkFBNEI7U0FDekMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxxQkFBcUIsRUFBRTtZQUM3QyxLQUFLLEVBQUUsZ0JBQWdCLENBQUMsV0FBVztZQUNuQyxXQUFXLEVBQUUsaUNBQWlDO1lBQzlDLFVBQVUsRUFBRSw2QkFBNkI7U0FDMUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBaE5ELHNDQWdOQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU29uZ2JpcmQgTWFpbiBTdGFja1xuICpcbiAqIE9yY2hlc3RyYXRlcyBhbGwgaW5mcmFzdHJ1Y3R1cmUgY29uc3RydWN0cyBmb3IgdGhlIFNvbmdiaXJkIGRlbW8gcGxhdGZvcm0uXG4gKi9cblxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIHNucyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc25zJztcbmltcG9ydCAqIGFzIHNuc1N1YnNjcmlwdGlvbnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNucy1zdWJzY3JpcHRpb25zJztcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcbmltcG9ydCAqIGFzIHNlcyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc2VzJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxvZ3MnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgeyBOb2RlanNGdW5jdGlvbiB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEtbm9kZWpzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgeyBTdG9yYWdlQ29uc3RydWN0IH0gZnJvbSAnLi9zdG9yYWdlLWNvbnN0cnVjdCc7XG5pbXBvcnQgeyBBcGlDb25zdHJ1Y3QgfSBmcm9tICcuL2FwaS1jb25zdHJ1Y3QnO1xuaW1wb3J0IHsgRGFzaGJvYXJkQ29uc3RydWN0IH0gZnJvbSAnLi9kYXNoYm9hcmQtY29uc3RydWN0JztcbmltcG9ydCB7IEF1dGhDb25zdHJ1Y3QsIFBvc3RDb25maXJtYXRpb25UcmlnZ2VyIH0gZnJvbSAnLi9hdXRoLWNvbnN0cnVjdCc7XG5pbXBvcnQgeyBBbmFseXRpY3NDb25zdHJ1Y3QgfSBmcm9tICcuL2FuYWx5dGljcy1jb25zdHJ1Y3QnO1xuXG5leHBvcnQgaW50ZXJmYWNlIFNvbmdiaXJkU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgbm90ZWh1YlByb2plY3RVaWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIFNvbmdiaXJkU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogU29uZ2JpcmRTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFN0b3JhZ2UgTGF5ZXIgKER5bmFtb0RCIGZvciBkZXZpY2VzIGFuZCB0ZWxlbWV0cnkpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBzdG9yYWdlID0gbmV3IFN0b3JhZ2VDb25zdHJ1Y3QodGhpcywgJ1N0b3JhZ2UnLCB7XG4gICAgICBkeW5hbW9UYWJsZU5hbWU6ICdzb25nYmlyZC1kZXZpY2VzJyxcbiAgICAgIHRlbGVtZXRyeVRhYmxlTmFtZTogJ3NvbmdiaXJkLXRlbGVtZXRyeScsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEF1dGhlbnRpY2F0aW9uIChDb2duaXRvKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYXV0aCA9IG5ldyBBdXRoQ29uc3RydWN0KHRoaXMsICdBdXRoJywge1xuICAgICAgdXNlclBvb2xOYW1lOiAnc29uZ2JpcmQtdXNlcnMnLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBTTlMgVG9waWMgZm9yIEFsZXJ0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYWxlcnRUb3BpYyA9IG5ldyBzbnMuVG9waWModGhpcywgJ0FsZXJ0VG9waWMnLCB7XG4gICAgICB0b3BpY05hbWU6ICdzb25nYmlyZC1hbGVydHMnLFxuICAgICAgZGlzcGxheU5hbWU6ICdTb25nYmlyZCBBbGVydCBOb3RpZmljYXRpb25zJyxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQW5hbHl0aWNzIExheWVyIChBdXJvcmEgU2VydmVybGVzcyArIEJlZHJvY2spXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBhbmFseXRpY3MgPSBuZXcgQW5hbHl0aWNzQ29uc3RydWN0KHRoaXMsICdBbmFseXRpY3MnLCB7XG4gICAgICBkZXZpY2VzVGFibGU6IHN0b3JhZ2UuZGV2aWNlc1RhYmxlLFxuICAgICAgdGVsZW1ldHJ5VGFibGU6IHN0b3JhZ2UudGVsZW1ldHJ5VGFibGUsXG4gICAgICBsb2NhdGlvbnNUYWJsZTogc3RvcmFnZS5sb2NhdGlvbnNUYWJsZSxcbiAgICAgIGFsZXJ0c1RhYmxlOiBzdG9yYWdlLmFsZXJ0c1RhYmxlLFxuICAgICAgam91cm5leXNUYWJsZTogc3RvcmFnZS5qb3VybmV5c1RhYmxlLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBBUEkgTGF5ZXIgKEFQSSBHYXRld2F5ICsgTGFtYmRhKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYXBpID0gbmV3IEFwaUNvbnN0cnVjdCh0aGlzLCAnQXBpJywge1xuICAgICAgdGVsZW1ldHJ5VGFibGU6IHN0b3JhZ2UudGVsZW1ldHJ5VGFibGUsXG4gICAgICBkZXZpY2VzVGFibGU6IHN0b3JhZ2UuZGV2aWNlc1RhYmxlLFxuICAgICAgYWxlcnRzVGFibGU6IHN0b3JhZ2UuYWxlcnRzVGFibGUsXG4gICAgICBzZXR0aW5nc1RhYmxlOiBzdG9yYWdlLnNldHRpbmdzVGFibGUsXG4gICAgICBqb3VybmV5c1RhYmxlOiBzdG9yYWdlLmpvdXJuZXlzVGFibGUsXG4gICAgICBsb2NhdGlvbnNUYWJsZTogc3RvcmFnZS5sb2NhdGlvbnNUYWJsZSxcbiAgICAgIGRldmljZUFsaWFzZXNUYWJsZTogc3RvcmFnZS5kZXZpY2VBbGlhc2VzVGFibGUsXG4gICAgICBhdWRpdFRhYmxlOiBzdG9yYWdlLmF1ZGl0VGFibGUsXG4gICAgICB1c2VyUG9vbDogYXV0aC51c2VyUG9vbCxcbiAgICAgIHVzZXJQb29sQ2xpZW50OiBhdXRoLnVzZXJQb29sQ2xpZW50LFxuICAgICAgbm90ZWh1YlByb2plY3RVaWQ6IHByb3BzLm5vdGVodWJQcm9qZWN0VWlkLFxuICAgICAgYWxlcnRUb3BpYyxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBBbmFseXRpY3Mgcm91dGVzIHRvIEFQSVxuICAgIGFwaS5hZGRBbmFseXRpY3NSb3V0ZXMoXG4gICAgICBhbmFseXRpY3MuY2hhdFF1ZXJ5TGFtYmRhLFxuICAgICAgYW5hbHl0aWNzLmNoYXRIaXN0b3J5TGFtYmRhLFxuICAgICAgYW5hbHl0aWNzLmxpc3RTZXNzaW9uc0xhbWJkYSxcbiAgICAgIGFuYWx5dGljcy5nZXRTZXNzaW9uTGFtYmRhLFxuICAgICAgYW5hbHl0aWNzLmRlbGV0ZVNlc3Npb25MYW1iZGEsXG4gICAgICBhbmFseXRpY3MucmVydW5RdWVyeUxhbWJkYVxuICAgICk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFBvc3QtQ29uZmlybWF0aW9uIExhbWJkYSBUcmlnZ2VyIChmb3Igc2VsZi1zaWdudXAgd2l0aCBWaWV3ZXIgcm9sZSlcbiAgICAvLyBNdXN0IGJlIGNyZWF0ZWQgYWZ0ZXIgQVBJIGNvbnN0cnVjdCB0byBhdm9pZCBjaXJjdWxhciBkZXBlbmRlbmNpZXNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIG5ldyBQb3N0Q29uZmlybWF0aW9uVHJpZ2dlcih0aGlzLCAnUG9zdENvbmZpcm1hdGlvbicsIHtcbiAgICAgIHVzZXJQb29sOiBhdXRoLnVzZXJQb29sLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBEYXNoYm9hcmQgSG9zdGluZyAoUzMgKyBDbG91ZEZyb250KVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgZGFzaGJvYXJkID0gbmV3IERhc2hib2FyZENvbnN0cnVjdCh0aGlzLCAnRGFzaGJvYXJkJywge1xuICAgICAgYXBpVXJsOiBhcGkuYXBpVXJsLFxuICAgICAgdXNlclBvb2xJZDogYXV0aC51c2VyUG9vbC51c2VyUG9vbElkLFxuICAgICAgdXNlclBvb2xDbGllbnRJZDogYXV0aC51c2VyUG9vbENsaWVudC51c2VyUG9vbENsaWVudElkLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBTRVMgRW1haWwgSWRlbnRpdHkgKGZvciBhbGVydCBlbWFpbHMpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBOb3RlOiBFbWFpbCBpZGVudGl0eSAnYnJhbmRvbkBibHVlcy5jb20nIG11c3QgYmUgdmVyaWZpZWQgaW4gU0VTXG4gICAgLy8gVGhlIGlkZW50aXR5IGFscmVhZHkgZXhpc3RzIGFuZCBpcyBtYW5hZ2VkIG91dHNpZGUgb2YgQ0RLXG4gICAgLy8gV2UganVzdCByZWZlcmVuY2UgaXQgaGVyZSBmb3IgZG9jdW1lbnRhdGlvbiBwdXJwb3Nlc1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBBbGVydCBFbWFpbCBMYW1iZGFcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGFsZXJ0RW1haWxMYW1iZGEgPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0FsZXJ0RW1haWxGdW5jdGlvbicsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFsZXJ0LWVtYWlsJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU2VuZHMgZW1haWwgbm90aWZpY2F0aW9ucyBmb3IgbG93IGJhdHRlcnkgYWxlcnRzIHRvIGRldmljZSBvd25lcnMnLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hbGVydC1lbWFpbC9pbmRleC50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgREVWSUNFU19UQUJMRTogc3RvcmFnZS5kZXZpY2VzVGFibGUudGFibGVOYW1lLFxuICAgICAgICBBTEVSVFNfVEFCTEU6IHN0b3JhZ2UuYWxlcnRzVGFibGUudGFibGVOYW1lLFxuICAgICAgICBTRU5ERVJfRU1BSUw6ICdicmFuZG9uQGJsdWVzLmNvbScsXG4gICAgICAgIERBU0hCT0FSRF9VUkw6ICdodHRwczovL3NvbmdiaXJkLmxpdmUnLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7XG4gICAgICAgIG1pbmlmeTogdHJ1ZSxcbiAgICAgICAgc291cmNlTWFwOiB0cnVlLFxuICAgICAgICBleHRlcm5hbE1vZHVsZXM6IFsnQGF3cy1zZGsvKiddLFxuICAgICAgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcblxuICAgIC8vIEdyYW50IHBlcm1pc3Npb25zIHRvIHRoZSBhbGVydCBlbWFpbCBMYW1iZGFcbiAgICBzdG9yYWdlLmRldmljZXNUYWJsZS5ncmFudFJlYWREYXRhKGFsZXJ0RW1haWxMYW1iZGEpO1xuICAgIHN0b3JhZ2UuYWxlcnRzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGFsZXJ0RW1haWxMYW1iZGEpO1xuXG4gICAgLy8gR3JhbnQgcGVybWlzc2lvbiB0byBzZW5kIGVtYWlscyB2aWEgU0VTXG4gICAgYWxlcnRFbWFpbExhbWJkYS5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogWydzZXM6U2VuZEVtYWlsJywgJ3NlczpTZW5kUmF3RW1haWwnXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICBjb25kaXRpb25zOiB7XG4gICAgICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgICAgICdzZXM6RnJvbUFkZHJlc3MnOiAnYnJhbmRvbkBibHVlcy5jb20nLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KSk7XG5cbiAgICAvLyBTdWJzY3JpYmUgdGhlIGVtYWlsIExhbWJkYSB0byB0aGUgU05TIGFsZXJ0IHRvcGljXG4gICAgYWxlcnRUb3BpYy5hZGRTdWJzY3JpcHRpb24obmV3IHNuc1N1YnNjcmlwdGlvbnMuTGFtYmRhU3Vic2NyaXB0aW9uKGFsZXJ0RW1haWxMYW1iZGEsIHtcbiAgICAgIGZpbHRlclBvbGljeToge1xuICAgICAgICBhbGVydF90eXBlOiBzbnMuU3Vic2NyaXB0aW9uRmlsdGVyLnN0cmluZ0ZpbHRlcih7XG4gICAgICAgICAgYWxsb3dsaXN0OiBbJ2xvd19iYXR0ZXJ5J10sXG4gICAgICAgIH0pLFxuICAgICAgfSxcbiAgICB9KSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE91dHB1dHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBcGlVcmwnLCB7XG4gICAgICB2YWx1ZTogYXBpLmFwaVVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgQVBJIGVuZHBvaW50IFVSTCcsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRBcGlVcmwnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0luZ2VzdFVybCcsIHtcbiAgICAgIHZhbHVlOiBhcGkuaW5nZXN0VXJsLFxuICAgICAgZGVzY3JpcHRpb246ICdFdmVudCBpbmdlc3QgVVJMIGZvciBOb3RlaHViIEhUVFAgcm91dGUnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkSW5nZXN0VXJsJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEYXNoYm9hcmRVcmwnLCB7XG4gICAgICB2YWx1ZTogZGFzaGJvYXJkLmRpc3RyaWJ1dGlvblVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgRGFzaGJvYXJkIFVSTCcsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmREYXNoYm9hcmRVcmwnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1VzZXJQb29sSWQnLCB7XG4gICAgICB2YWx1ZTogYXV0aC51c2VyUG9vbC51c2VyUG9vbElkLFxuICAgICAgZGVzY3JpcHRpb246ICdDb2duaXRvIFVzZXIgUG9vbCBJRCcsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRVc2VyUG9vbElkJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdVc2VyUG9vbENsaWVudElkJywge1xuICAgICAgdmFsdWU6IGF1dGgudXNlclBvb2xDbGllbnQudXNlclBvb2xDbGllbnRJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byBVc2VyIFBvb2wgQ2xpZW50IElEJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZFVzZXJQb29sQ2xpZW50SWQnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0RldmljZXNUYWJsZU5hbWUnLCB7XG4gICAgICB2YWx1ZTogc3RvcmFnZS5kZXZpY2VzVGFibGUudGFibGVOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdEeW5hbW9EQiBkZXZpY2VzIHRhYmxlIG5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkRGV2aWNlc1RhYmxlJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdUZWxlbWV0cnlUYWJsZU5hbWUnLCB7XG4gICAgICB2YWx1ZTogc3RvcmFnZS50ZWxlbWV0cnlUYWJsZS50YWJsZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0R5bmFtb0RCIHRlbGVtZXRyeSB0YWJsZSBuYW1lJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZFRlbGVtZXRyeVRhYmxlJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBbmFseXRpY3NDbHVzdGVyRW5kcG9pbnQnLCB7XG4gICAgICB2YWx1ZTogYW5hbHl0aWNzLmNsdXN0ZXIuY2x1c3RlckVuZHBvaW50Lmhvc3RuYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdBdXJvcmEgQW5hbHl0aWNzIGNsdXN0ZXIgZW5kcG9pbnQnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkQW5hbHl0aWNzQ2x1c3RlckVuZHBvaW50JyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdDaGF0SGlzdG9yeVRhYmxlTmFtZScsIHtcbiAgICAgIHZhbHVlOiBhbmFseXRpY3MuY2hhdEhpc3RvcnlUYWJsZS50YWJsZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FuYWx5dGljcyBjaGF0IGhpc3RvcnkgdGFibGUgbmFtZScsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRDaGF0SGlzdG9yeVRhYmxlJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBbGVydEVtYWlsSWRlbnRpdHknLCB7XG4gICAgICB2YWx1ZTogJ2JyYW5kb25AYmx1ZXMuY29tJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU0VTIGVtYWlsIGlkZW50aXR5IGZvciBhbGVydHMgKG11c3QgYmUgdmVyaWZpZWQpJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZEFsZXJ0RW1haWxJZGVudGl0eScsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQWxlcnRFbWFpbExhbWJkYUFybicsIHtcbiAgICAgIHZhbHVlOiBhbGVydEVtYWlsTGFtYmRhLmZ1bmN0aW9uQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdBbGVydCBlbWFpbCBMYW1iZGEgZnVuY3Rpb24gQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZEFsZXJ0RW1haWxMYW1iZGFBcm4nLFxuICAgIH0pO1xuICB9XG59XG4iXX0=