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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic29uZ2JpcmQtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvc29uZ2JpcmQtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7O0dBSUc7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBRUgsaURBQW1DO0FBQ25DLHlEQUEyQztBQUUzQywyREFBdUQ7QUFDdkQsbURBQStDO0FBQy9DLCtEQUEyRDtBQUMzRCxxREFBMEU7QUFDMUUsK0RBQTJEO0FBTTNELE1BQWEsYUFBYyxTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBQzFDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBeUI7UUFDakUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsNkVBQTZFO1FBQzdFLHFEQUFxRDtRQUNyRCw2RUFBNkU7UUFDN0UsTUFBTSxPQUFPLEdBQUcsSUFBSSxvQ0FBZ0IsQ0FBQyxJQUFJLEVBQUUsU0FBUyxFQUFFO1lBQ3BELGVBQWUsRUFBRSxrQkFBa0I7WUFDbkMsa0JBQWtCLEVBQUUsb0JBQW9CO1NBQ3pDLENBQUMsQ0FBQztRQUVILDZFQUE2RTtRQUM3RSwyQkFBMkI7UUFDM0IsNkVBQTZFO1FBQzdFLE1BQU0sSUFBSSxHQUFHLElBQUksOEJBQWEsQ0FBQyxJQUFJLEVBQUUsTUFBTSxFQUFFO1lBQzNDLFlBQVksRUFBRSxnQkFBZ0I7U0FDL0IsQ0FBQyxDQUFDO1FBRUgsNkVBQTZFO1FBQzdFLHVCQUF1QjtRQUN2Qiw2RUFBNkU7UUFDN0UsTUFBTSxVQUFVLEdBQUcsSUFBSSxHQUFHLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7WUFDbkQsU0FBUyxFQUFFLGlCQUFpQjtZQUM1QixXQUFXLEVBQUUsOEJBQThCO1NBQzVDLENBQUMsQ0FBQztRQUVILDZFQUE2RTtRQUM3RSxnREFBZ0Q7UUFDaEQsNkVBQTZFO1FBQzdFLE1BQU0sU0FBUyxHQUFHLElBQUks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YWluIFN0YWNrXG4gKlxuICogT3JjaGVzdHJhdGVzIGFsbCBpbmZyYXN0cnVjdHVyZSBjb25zdHJ1Y3RzIGZvciB0aGUgU29uZ2JpcmQgZGVtbyBwbGF0Zm9ybS5cbiAqL1xuXG5pbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgc25zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zbnMnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgeyBTdG9yYWdlQ29uc3RydWN0IH0gZnJvbSAnLi9zdG9yYWdlLWNvbnN0cnVjdCc7XG5pbXBvcnQgeyBBcGlDb25zdHJ1Y3QgfSBmcm9tICcuL2FwaS1jb25zdHJ1Y3QnO1xuaW1wb3J0IHsgRGFzaGJvYXJkQ29uc3RydWN0IH0gZnJvbSAnLi9kYXNoYm9hcmQtY29uc3RydWN0JztcbmltcG9ydCB7IEF1dGhDb25zdHJ1Y3QsIFBvc3RDb25maXJtYXRpb25UcmlnZ2VyIH0gZnJvbSAnLi9hdXRoLWNvbnN0cnVjdCc7XG5pbXBvcnQgeyBBbmFseXRpY3NDb25zdHJ1Y3QgfSBmcm9tICcuL2FuYWx5dGljcy1jb25zdHJ1Y3QnO1xuXG5leHBvcnQgaW50ZXJmYWNlIFNvbmdiaXJkU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgbm90ZWh1YlByb2plY3RVaWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIFNvbmdiaXJkU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogU29uZ2JpcmRTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFN0b3JhZ2UgTGF5ZXIgKER5bmFtb0RCIGZvciBkZXZpY2VzIGFuZCB0ZWxlbWV0cnkpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBzdG9yYWdlID0gbmV3IFN0b3JhZ2VDb25zdHJ1Y3QodGhpcywgJ1N0b3JhZ2UnLCB7XG4gICAgICBkeW5hbW9UYWJsZU5hbWU6ICdzb25nYmlyZC1kZXZpY2VzJyxcbiAgICAgIHRlbGVtZXRyeVRhYmxlTmFtZTogJ3NvbmdiaXJkLXRlbGVtZXRyeScsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEF1dGhlbnRpY2F0aW9uIChDb2duaXRvKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYXV0aCA9IG5ldyBBdXRoQ29uc3RydWN0KHRoaXMsICdBdXRoJywge1xuICAgICAgdXNlclBvb2xOYW1lOiAnc29uZ2JpcmQtdXNlcnMnLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBTTlMgVG9waWMgZm9yIEFsZXJ0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYWxlcnRUb3BpYyA9IG5ldyBzbnMuVG9waWModGhpcywgJ0FsZXJ0VG9waWMnLCB7XG4gICAgICB0b3BpY05hbWU6ICdzb25nYmlyZC1hbGVydHMnLFxuICAgICAgZGlzcGxheU5hbWU6ICdTb25nYmlyZCBBbGVydCBOb3RpZmljYXRpb25zJyxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQW5hbHl0aWNzIExheWVyIChBdXJvcmEgU2VydmVybGVzcyArIEJlZHJvY2spXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBhbmFseXRpY3MgPSBuZXcgQW5hbHl0aWNzQ29uc3RydWN0KHRoaXMsICdBbmFseXRpY3MnLCB7XG4gICAgICBkZXZpY2VzVGFibGU6IHN0b3JhZ2UuZGV2aWNlc1RhYmxlLFxuICAgICAgdGVsZW1ldHJ5VGFibGU6IHN0b3JhZ2UudGVsZW1ldHJ5VGFibGUsXG4gICAgICBsb2NhdGlvbnNUYWJsZTogc3RvcmFnZS5sb2NhdGlvbnNUYWJsZSxcbiAgICAgIGFsZXJ0c1RhYmxlOiBzdG9yYWdlLmFsZXJ0c1RhYmxlLFxuICAgICAgam91cm5leXNUYWJsZTogc3RvcmFnZS5qb3VybmV5c1RhYmxlLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBBUEkgTGF5ZXIgKEFQSSBHYXRld2F5ICsgTGFtYmRhKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYXBpID0gbmV3IEFwaUNvbnN0cnVjdCh0aGlzLCAnQXBpJywge1xuICAgICAgdGVsZW1ldHJ5VGFibGU6IHN0b3JhZ2UudGVsZW1ldHJ5VGFibGUsXG4gICAgICBkZXZpY2VzVGFibGU6IHN0b3JhZ2UuZGV2aWNlc1RhYmxlLFxuICAgICAgYWxlcnRzVGFibGU6IHN0b3JhZ2UuYWxlcnRzVGFibGUsXG4gICAgICBzZXR0aW5nc1RhYmxlOiBzdG9yYWdlLnNldHRpbmdzVGFibGUsXG4gICAgICBqb3VybmV5c1RhYmxlOiBzdG9yYWdlLmpvdXJuZXlzVGFibGUsXG4gICAgICBsb2NhdGlvbnNUYWJsZTogc3RvcmFnZS5sb2NhdGlvbnNUYWJsZSxcbiAgICAgIGRldmljZUFsaWFzZXNUYWJsZTogc3RvcmFnZS5kZXZpY2VBbGlhc2VzVGFibGUsXG4gICAgICBhdWRpdFRhYmxlOiBzdG9yYWdlLmF1ZGl0VGFibGUsXG4gICAgICB1c2VyUG9vbDogYXV0aC51c2VyUG9vbCxcbiAgICAgIHVzZXJQb29sQ2xpZW50OiBhdXRoLnVzZXJQb29sQ2xpZW50LFxuICAgICAgbm90ZWh1YlByb2plY3RVaWQ6IHByb3BzLm5vdGVodWJQcm9qZWN0VWlkLFxuICAgICAgYWxlcnRUb3BpYyxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBBbmFseXRpY3Mgcm91dGVzIHRvIEFQSVxuICAgIGFwaS5hZGRBbmFseXRpY3NSb3V0ZXMoXG4gICAgICBhbmFseXRpY3MuY2hhdFF1ZXJ5TGFtYmRhLFxuICAgICAgYW5hbHl0aWNzLmNoYXRIaXN0b3J5TGFtYmRhLFxuICAgICAgYW5hbHl0aWNzLmxpc3RTZXNzaW9uc0xhbWJkYSxcbiAgICAgIGFuYWx5dGljcy5nZXRTZXNzaW9uTGFtYmRhLFxuICAgICAgYW5hbHl0aWNzLmRlbGV0ZVNlc3Npb25MYW1iZGEsXG4gICAgICBhbmFseXRpY3MucmVydW5RdWVyeUxhbWJkYVxuICAgICk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFBvc3QtQ29uZmlybWF0aW9uIExhbWJkYSBUcmlnZ2VyIChmb3Igc2VsZi1zaWdudXAgd2l0aCBWaWV3ZXIgcm9sZSlcbiAgICAvLyBNdXN0IGJlIGNyZWF0ZWQgYWZ0ZXIgQVBJIGNvbnN0cnVjdCB0byBhdm9pZCBjaXJjdWxhciBkZXBlbmRlbmNpZXNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIG5ldyBQb3N0Q29uZmlybWF0aW9uVHJpZ2dlcih0aGlzLCAnUG9zdENvbmZpcm1hdGlvbicsIHtcbiAgICAgIHVzZXJQb29sOiBhdXRoLnVzZXJQb29sLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBEYXNoYm9hcmQgSG9zdGluZyAoUzMgKyBDbG91ZEZyb250KVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgZGFzaGJvYXJkID0gbmV3IERhc2hib2FyZENvbnN0cnVjdCh0aGlzLCAnRGFzaGJvYXJkJywge1xuICAgICAgYXBpVXJsOiBhcGkuYXBpVXJsLFxuICAgICAgdXNlclBvb2xJZDogYXV0aC51c2VyUG9vbC51c2VyUG9vbElkLFxuICAgICAgdXNlclBvb2xDbGllbnRJZDogYXV0aC51c2VyUG9vbENsaWVudC51c2VyUG9vbENsaWVudElkLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBPdXRwdXRzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQXBpVXJsJywge1xuICAgICAgdmFsdWU6IGFwaS5hcGlVcmwsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NvbmdiaXJkIEFQSSBlbmRwb2ludCBVUkwnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkQXBpVXJsJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdJbmdlc3RVcmwnLCB7XG4gICAgICB2YWx1ZTogYXBpLmluZ2VzdFVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRXZlbnQgaW5nZXN0IFVSTCBmb3IgTm90ZWh1YiBIVFRQIHJvdXRlJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZEluZ2VzdFVybCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRGFzaGJvYXJkVXJsJywge1xuICAgICAgdmFsdWU6IGRhc2hib2FyZC5kaXN0cmlidXRpb25VcmwsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NvbmdiaXJkIERhc2hib2FyZCBVUkwnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkRGFzaGJvYXJkVXJsJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdVc2VyUG9vbElkJywge1xuICAgICAgdmFsdWU6IGF1dGgudXNlclBvb2wudXNlclBvb2xJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byBVc2VyIFBvb2wgSUQnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkVXNlclBvb2xJZCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVXNlclBvb2xDbGllbnRJZCcsIHtcbiAgICAgIHZhbHVlOiBhdXRoLnVzZXJQb29sQ2xpZW50LnVzZXJQb29sQ2xpZW50SWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gVXNlciBQb29sIENsaWVudCBJRCcsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRVc2VyUG9vbENsaWVudElkJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEZXZpY2VzVGFibGVOYW1lJywge1xuICAgICAgdmFsdWU6IHN0b3JhZ2UuZGV2aWNlc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRHluYW1vREIgZGV2aWNlcyB0YWJsZSBuYW1lJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZERldmljZXNUYWJsZScsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVGVsZW1ldHJ5VGFibGVOYW1lJywge1xuICAgICAgdmFsdWU6IHN0b3JhZ2UudGVsZW1ldHJ5VGFibGUudGFibGVOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdEeW5hbW9EQiB0ZWxlbWV0cnkgdGFibGUgbmFtZScsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRUZWxlbWV0cnlUYWJsZScsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQW5hbHl0aWNzQ2x1c3RlckVuZHBvaW50Jywge1xuICAgICAgdmFsdWU6IGFuYWx5dGljcy5jbHVzdGVyLmNsdXN0ZXJFbmRwb2ludC5ob3N0bmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXVyb3JhIEFuYWx5dGljcyBjbHVzdGVyIGVuZHBvaW50JyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZEFuYWx5dGljc0NsdXN0ZXJFbmRwb2ludCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2hhdEhpc3RvcnlUYWJsZU5hbWUnLCB7XG4gICAgICB2YWx1ZTogYW5hbHl0aWNzLmNoYXRIaXN0b3J5VGFibGUudGFibGVOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdBbmFseXRpY3MgY2hhdCBoaXN0b3J5IHRhYmxlIG5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkQ2hhdEhpc3RvcnlUYWJsZScsXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==