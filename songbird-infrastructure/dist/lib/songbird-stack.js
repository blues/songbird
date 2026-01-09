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
            userPool: auth.userPool,
            userPoolClient: auth.userPoolClient,
            notehubProjectUid: props.notehubProjectUid,
            alertTopic,
        });
        // Add Analytics routes to API
        api.addAnalyticsRoutes(analytics.chatQueryLambda, analytics.chatHistoryLambda);
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
    }
}
exports.SongbirdStack = SongbirdStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic29uZ2JpcmQtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvc29uZ2JpcmQtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7O0dBSUc7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBRUgsaURBQW1DO0FBQ25DLHlEQUEyQztBQUUzQywyREFBdUQ7QUFDdkQsbURBQStDO0FBQy9DLCtEQUEyRDtBQUMzRCxxREFBMEU7QUFDMUUsK0RBQTJEO0FBTTNELE1BQWEsYUFBYyxTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBQzFDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBeUI7UUFDakUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsNkVBQTZFO1FBQzdFLHFEQUFxRDtRQUNyRCw2RUFBNkU7UUFDN0UsTUFBTSxPQUFPLEdBQUcsSUFBSSxvQ0FBZ0IsQ0FBQyxJQUFJLEVBQUUsU0FBUyxFQUFFO1lBQ3BELGVBQWUsRUFBRSxrQkFBa0I7WUFDbkMsa0JBQWtCLEVBQUUsb0JBQW9CO1NBQ3pDLENBQUMsQ0FBQztRQUVILDZFQUE2RTtRQUM3RSwyQkFBMkI7UUFDM0IsNkVBQTZFO1FBQzdFLE1BQU0sSUFBSSxHQUFHLElBQUksOEJBQWEsQ0FBQyxJQUFJLEVBQUUsTUFBTSxFQUFFO1lBQzNDLFlBQVksRUFBRSxnQkFBZ0I7U0FDL0IsQ0FBQyxDQUFDO1FBRUgsNkVBQTZFO1FBQzdFLHVCQUF1QjtRQUN2Qiw2RUFBNkU7UUFDN0UsTUFBTSxVQUFVLEdBQUcsSUFBSSxHQUFHLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7WUFDbkQsU0FBUyxFQUFFLGlCQUFpQjtZQUM1QixXQUFXLEVBQUUsOEJBQThCO1NBQzVDLENBQUMsQ0FBQztRQUVILDZFQUE2RTtRQUM3RSxnREFBZ0Q7UUFDaEQsNkVBQTZFO1FBQzdFLE1BQU0sU0FBUyxHQUFHLElBQUks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QWMsQ0FBQyxnQkFBZ0I7WUFDM0MsV0FBVyxFQUFFLDZCQUE2QjtZQUMxQyxVQUFVLEVBQUUsMEJBQTBCO1NBQ3ZDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsa0JBQWtCLEVBQUU7WUFDMUMsS0FBSyxFQUFFLE9BQU8sQ0FBQyxZQUFZLENBQUMsU0FBUztZQUNyQyxXQUFXLEVBQUUsNkJBQTZCO1lBQzFDLFVBQVUsRUFBRSxzQkFBc0I7U0FDbkMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxvQkFBb0IsRUFBRTtZQUM1QyxLQUFLLEVBQUUsT0FBTyxDQUFDLGNBQWMsQ0FBQyxTQUFTO1lBQ3ZDLFdBQVcsRUFBRSwrQkFBK0I7WUFDNUMsVUFBVSxFQUFFLHdCQUF3QjtTQUNyQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLDBCQUEwQixFQUFFO1lBQ2xELEtBQUssRUFBRSxTQUFTLENBQUMsT0FBTyxDQUFDLGVBQWUsQ0FBQyxRQUFRO1lBQ2pELFdBQVcsRUFBRSxtQ0FBbUM7WUFDaEQsVUFBVSxFQUFFLGtDQUFrQztTQUMvQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHNCQUFzQixFQUFFO1lBQzlDLEtBQUssRUFBRSxTQUFTLENBQUMsZ0JBQWdCLENBQUMsU0FBUztZQUMzQyxXQUFXLEVBQUUsbUNBQW1DO1lBQ2hELFVBQVUsRUFBRSwwQkFBMEI7U0FDdkMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBcElELHNDQW9JQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU29uZ2JpcmQgTWFpbiBTdGFja1xuICpcbiAqIE9yY2hlc3RyYXRlcyBhbGwgaW5mcmFzdHJ1Y3R1cmUgY29uc3RydWN0cyBmb3IgdGhlIFNvbmdiaXJkIGRlbW8gcGxhdGZvcm0uXG4gKi9cblxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIHNucyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc25zJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0IHsgU3RvcmFnZUNvbnN0cnVjdCB9IGZyb20gJy4vc3RvcmFnZS1jb25zdHJ1Y3QnO1xuaW1wb3J0IHsgQXBpQ29uc3RydWN0IH0gZnJvbSAnLi9hcGktY29uc3RydWN0JztcbmltcG9ydCB7IERhc2hib2FyZENvbnN0cnVjdCB9IGZyb20gJy4vZGFzaGJvYXJkLWNvbnN0cnVjdCc7XG5pbXBvcnQgeyBBdXRoQ29uc3RydWN0LCBQb3N0Q29uZmlybWF0aW9uVHJpZ2dlciB9IGZyb20gJy4vYXV0aC1jb25zdHJ1Y3QnO1xuaW1wb3J0IHsgQW5hbHl0aWNzQ29uc3RydWN0IH0gZnJvbSAnLi9hbmFseXRpY3MtY29uc3RydWN0JztcblxuZXhwb3J0IGludGVyZmFjZSBTb25nYmlyZFN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIG5vdGVodWJQcm9qZWN0VWlkOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBTb25nYmlyZFN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IFNvbmdiaXJkU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBTdG9yYWdlIExheWVyIChEeW5hbW9EQiBmb3IgZGV2aWNlcyBhbmQgdGVsZW1ldHJ5KVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3Qgc3RvcmFnZSA9IG5ldyBTdG9yYWdlQ29uc3RydWN0KHRoaXMsICdTdG9yYWdlJywge1xuICAgICAgZHluYW1vVGFibGVOYW1lOiAnc29uZ2JpcmQtZGV2aWNlcycsXG4gICAgICB0ZWxlbWV0cnlUYWJsZU5hbWU6ICdzb25nYmlyZC10ZWxlbWV0cnknLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBBdXRoZW50aWNhdGlvbiAoQ29nbml0bylcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGF1dGggPSBuZXcgQXV0aENvbnN0cnVjdCh0aGlzLCAnQXV0aCcsIHtcbiAgICAgIHVzZXJQb29sTmFtZTogJ3NvbmdiaXJkLXVzZXJzJyxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gU05TIFRvcGljIGZvciBBbGVydHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGFsZXJ0VG9waWMgPSBuZXcgc25zLlRvcGljKHRoaXMsICdBbGVydFRvcGljJywge1xuICAgICAgdG9waWNOYW1lOiAnc29uZ2JpcmQtYWxlcnRzJyxcbiAgICAgIGRpc3BsYXlOYW1lOiAnU29uZ2JpcmQgQWxlcnQgTm90aWZpY2F0aW9ucycsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEFuYWx5dGljcyBMYXllciAoQXVyb3JhIFNlcnZlcmxlc3MgKyBCZWRyb2NrKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYW5hbHl0aWNzID0gbmV3IEFuYWx5dGljc0NvbnN0cnVjdCh0aGlzLCAnQW5hbHl0aWNzJywge1xuICAgICAgZGV2aWNlc1RhYmxlOiBzdG9yYWdlLmRldmljZXNUYWJsZSxcbiAgICAgIHRlbGVtZXRyeVRhYmxlOiBzdG9yYWdlLnRlbGVtZXRyeVRhYmxlLFxuICAgICAgbG9jYXRpb25zVGFibGU6IHN0b3JhZ2UubG9jYXRpb25zVGFibGUsXG4gICAgICBhbGVydHNUYWJsZTogc3RvcmFnZS5hbGVydHNUYWJsZSxcbiAgICAgIGpvdXJuZXlzVGFibGU6IHN0b3JhZ2Uuam91cm5leXNUYWJsZSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQVBJIExheWVyIChBUEkgR2F0ZXdheSArIExhbWJkYSlcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGFwaSA9IG5ldyBBcGlDb25zdHJ1Y3QodGhpcywgJ0FwaScsIHtcbiAgICAgIHRlbGVtZXRyeVRhYmxlOiBzdG9yYWdlLnRlbGVtZXRyeVRhYmxlLFxuICAgICAgZGV2aWNlc1RhYmxlOiBzdG9yYWdlLmRldmljZXNUYWJsZSxcbiAgICAgIGFsZXJ0c1RhYmxlOiBzdG9yYWdlLmFsZXJ0c1RhYmxlLFxuICAgICAgc2V0dGluZ3NUYWJsZTogc3RvcmFnZS5zZXR0aW5nc1RhYmxlLFxuICAgICAgam91cm5leXNUYWJsZTogc3RvcmFnZS5qb3VybmV5c1RhYmxlLFxuICAgICAgbG9jYXRpb25zVGFibGU6IHN0b3JhZ2UubG9jYXRpb25zVGFibGUsXG4gICAgICBkZXZpY2VBbGlhc2VzVGFibGU6IHN0b3JhZ2UuZGV2aWNlQWxpYXNlc1RhYmxlLFxuICAgICAgdXNlclBvb2w6IGF1dGgudXNlclBvb2wsXG4gICAgICB1c2VyUG9vbENsaWVudDogYXV0aC51c2VyUG9vbENsaWVudCxcbiAgICAgIG5vdGVodWJQcm9qZWN0VWlkOiBwcm9wcy5ub3RlaHViUHJvamVjdFVpZCxcbiAgICAgIGFsZXJ0VG9waWMsXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgQW5hbHl0aWNzIHJvdXRlcyB0byBBUElcbiAgICBhcGkuYWRkQW5hbHl0aWNzUm91dGVzKGFuYWx5dGljcy5jaGF0UXVlcnlMYW1iZGEsIGFuYWx5dGljcy5jaGF0SGlzdG9yeUxhbWJkYSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFBvc3QtQ29uZmlybWF0aW9uIExhbWJkYSBUcmlnZ2VyIChmb3Igc2VsZi1zaWdudXAgd2l0aCBWaWV3ZXIgcm9sZSlcbiAgICAvLyBNdXN0IGJlIGNyZWF0ZWQgYWZ0ZXIgQVBJIGNvbnN0cnVjdCB0byBhdm9pZCBjaXJjdWxhciBkZXBlbmRlbmNpZXNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIG5ldyBQb3N0Q29uZmlybWF0aW9uVHJpZ2dlcih0aGlzLCAnUG9zdENvbmZpcm1hdGlvbicsIHtcbiAgICAgIHVzZXJQb29sOiBhdXRoLnVzZXJQb29sLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBEYXNoYm9hcmQgSG9zdGluZyAoUzMgKyBDbG91ZEZyb250KVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgZGFzaGJvYXJkID0gbmV3IERhc2hib2FyZENvbnN0cnVjdCh0aGlzLCAnRGFzaGJvYXJkJywge1xuICAgICAgYXBpVXJsOiBhcGkuYXBpVXJsLFxuICAgICAgdXNlclBvb2xJZDogYXV0aC51c2VyUG9vbC51c2VyUG9vbElkLFxuICAgICAgdXNlclBvb2xDbGllbnRJZDogYXV0aC51c2VyUG9vbENsaWVudC51c2VyUG9vbENsaWVudElkLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBPdXRwdXRzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQXBpVXJsJywge1xuICAgICAgdmFsdWU6IGFwaS5hcGlVcmwsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NvbmdiaXJkIEFQSSBlbmRwb2ludCBVUkwnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkQXBpVXJsJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdJbmdlc3RVcmwnLCB7XG4gICAgICB2YWx1ZTogYXBpLmluZ2VzdFVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRXZlbnQgaW5nZXN0IFVSTCBmb3IgTm90ZWh1YiBIVFRQIHJvdXRlJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZEluZ2VzdFVybCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRGFzaGJvYXJkVXJsJywge1xuICAgICAgdmFsdWU6IGRhc2hib2FyZC5kaXN0cmlidXRpb25VcmwsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NvbmdiaXJkIERhc2hib2FyZCBVUkwnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkRGFzaGJvYXJkVXJsJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdVc2VyUG9vbElkJywge1xuICAgICAgdmFsdWU6IGF1dGgudXNlclBvb2wudXNlclBvb2xJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byBVc2VyIFBvb2wgSUQnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkVXNlclBvb2xJZCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVXNlclBvb2xDbGllbnRJZCcsIHtcbiAgICAgIHZhbHVlOiBhdXRoLnVzZXJQb29sQ2xpZW50LnVzZXJQb29sQ2xpZW50SWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gVXNlciBQb29sIENsaWVudCBJRCcsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRVc2VyUG9vbENsaWVudElkJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEZXZpY2VzVGFibGVOYW1lJywge1xuICAgICAgdmFsdWU6IHN0b3JhZ2UuZGV2aWNlc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRHluYW1vREIgZGV2aWNlcyB0YWJsZSBuYW1lJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZERldmljZXNUYWJsZScsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVGVsZW1ldHJ5VGFibGVOYW1lJywge1xuICAgICAgdmFsdWU6IHN0b3JhZ2UudGVsZW1ldHJ5VGFibGUudGFibGVOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdEeW5hbW9EQiB0ZWxlbWV0cnkgdGFibGUgbmFtZScsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRUZWxlbWV0cnlUYWJsZScsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQW5hbHl0aWNzQ2x1c3RlckVuZHBvaW50Jywge1xuICAgICAgdmFsdWU6IGFuYWx5dGljcy5jbHVzdGVyLmNsdXN0ZXJFbmRwb2ludC5ob3N0bmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXVyb3JhIEFuYWx5dGljcyBjbHVzdGVyIGVuZHBvaW50JyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZEFuYWx5dGljc0NsdXN0ZXJFbmRwb2ludCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2hhdEhpc3RvcnlUYWJsZU5hbWUnLCB7XG4gICAgICB2YWx1ZTogYW5hbHl0aWNzLmNoYXRIaXN0b3J5VGFibGUudGFibGVOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdBbmFseXRpY3MgY2hhdCBoaXN0b3J5IHRhYmxlIG5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkQ2hhdEhpc3RvcnlUYWJsZScsXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==