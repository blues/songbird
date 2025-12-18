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
const iot_construct_1 = require("./iot-construct");
const api_construct_1 = require("./api-construct");
const dashboard_construct_1 = require("./dashboard-construct");
const auth_construct_1 = require("./auth-construct");
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
        // SNS Topic for Alerts (shared between API and IoT constructs)
        // ==========================================================================
        // Note: We import the existing topic created by the previous ApiConstruct deployment
        // rather than creating a new one to avoid name conflicts
        const alertTopic = sns.Topic.fromTopicArn(this, 'AlertTopic', `arn:aws:sns:${this.region}:${this.account}:songbird-alerts`);
        // ==========================================================================
        // API Layer (API Gateway + Lambda)
        // ==========================================================================
        const api = new api_construct_1.ApiConstruct(this, 'Api', {
            telemetryTable: storage.telemetryTable,
            devicesTable: storage.devicesTable,
            userPool: auth.userPool,
            userPoolClient: auth.userPoolClient,
            notehubProjectUid: props.notehubProjectUid,
            alertTopic,
        });
        // ==========================================================================
        // IoT Layer (IoT Core Rules + Lambda)
        // ==========================================================================
        const iot = new iot_construct_1.IotConstruct(this, 'Iot', {
            telemetryTable: storage.telemetryTable,
            devicesTable: storage.devicesTable,
            alertTopic,
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
        new cdk.CfnOutput(this, 'IoTRuleName', {
            value: iot.eventProcessingRule.ruleName,
            description: 'IoT Core rule name for Notehub route configuration',
            exportName: 'SongbirdIoTRuleName',
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
    }
}
exports.SongbirdStack = SongbirdStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic29uZ2JpcmQtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvc29uZ2JpcmQtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7O0dBSUc7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBRUgsaURBQW1DO0FBQ25DLHlEQUEyQztBQUUzQywyREFBdUQ7QUFDdkQsbURBQStDO0FBQy9DLG1EQUErQztBQUMvQywrREFBMkQ7QUFDM0QscURBQWlEO0FBTWpELE1BQWEsYUFBYyxTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBQzFDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBeUI7UUFDakUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsNkVBQTZFO1FBQzdFLHFEQUFxRDtRQUNyRCw2RUFBNkU7UUFDN0UsTUFBTSxPQUFPLEdBQUcsSUFBSSxvQ0FBZ0IsQ0FBQyxJQUFJLEVBQUUsU0FBUyxFQUFFO1lBQ3BELGVBQWUsRUFBRSxrQkFBa0I7WUFDbkMsa0JBQWtCLEVBQUUsb0JBQW9CO1NBQ3pDLENBQUMsQ0FBQztRQUVILDZFQUE2RTtRQUM3RSwyQkFBMkI7UUFDM0IsNkVBQTZFO1FBQzdFLE1BQU0sSUFBSSxHQUFHLElBQUksOEJBQWEsQ0FBQyxJQUFJLEVBQUUsTUFBTSxFQUFFO1lBQzNDLFlBQVksRUFBRSxnQkFBZ0I7U0FDL0IsQ0FBQyxDQUFDO1FBRUgsNkVBQTZFO1FBQzdFLCtEQUErRDtRQUMvRCw2RUFBNkU7UUFDN0UscUZBQXFGO1FBQ3JGLHlEQUF5RDtRQUN6RCxNQUFNLFVBQVUsR0FBRyxHQUFHLENBQUMsS0FBSyxDQUFDLFlBQVksQ0FDdkMsSUFBSSxFQUNKLFlBQVksRUFDWixlQUFlLElBQUksQ0FBQyxNQUFNLElBQUksSUFBSSxDQUFDLE9BQU8sa0JBQWtCLENBQzdELENBQUM7UUFFRiw2RUFBNkU7UUFDN0UsbUNBQW1DO1FBQ25DLDZFQUE2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QUFLLEVBQUUsT0FBTyxDQUFDLGNBQWMsQ0FBQyxTQUFTO1lBQ3ZDLFdBQVcsRUFBRSwrQkFBK0I7WUFDNUMsVUFBVSxFQUFFLHdCQUF3QjtTQUNyQyxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUEvR0Qsc0NBK0dDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBTb25nYmlyZCBNYWluIFN0YWNrXG4gKlxuICogT3JjaGVzdHJhdGVzIGFsbCBpbmZyYXN0cnVjdHVyZSBjb25zdHJ1Y3RzIGZvciB0aGUgU29uZ2JpcmQgZGVtbyBwbGF0Zm9ybS5cbiAqL1xuXG5pbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgc25zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zbnMnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgeyBTdG9yYWdlQ29uc3RydWN0IH0gZnJvbSAnLi9zdG9yYWdlLWNvbnN0cnVjdCc7XG5pbXBvcnQgeyBJb3RDb25zdHJ1Y3QgfSBmcm9tICcuL2lvdC1jb25zdHJ1Y3QnO1xuaW1wb3J0IHsgQXBpQ29uc3RydWN0IH0gZnJvbSAnLi9hcGktY29uc3RydWN0JztcbmltcG9ydCB7IERhc2hib2FyZENvbnN0cnVjdCB9IGZyb20gJy4vZGFzaGJvYXJkLWNvbnN0cnVjdCc7XG5pbXBvcnQgeyBBdXRoQ29uc3RydWN0IH0gZnJvbSAnLi9hdXRoLWNvbnN0cnVjdCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU29uZ2JpcmRTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICBub3RlaHViUHJvamVjdFVpZDogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgU29uZ2JpcmRTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBTb25nYmlyZFN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gU3RvcmFnZSBMYXllciAoRHluYW1vREIgZm9yIGRldmljZXMgYW5kIHRlbGVtZXRyeSlcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IHN0b3JhZ2UgPSBuZXcgU3RvcmFnZUNvbnN0cnVjdCh0aGlzLCAnU3RvcmFnZScsIHtcbiAgICAgIGR5bmFtb1RhYmxlTmFtZTogJ3NvbmdiaXJkLWRldmljZXMnLFxuICAgICAgdGVsZW1ldHJ5VGFibGVOYW1lOiAnc29uZ2JpcmQtdGVsZW1ldHJ5JyxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQXV0aGVudGljYXRpb24gKENvZ25pdG8pXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBhdXRoID0gbmV3IEF1dGhDb25zdHJ1Y3QodGhpcywgJ0F1dGgnLCB7XG4gICAgICB1c2VyUG9vbE5hbWU6ICdzb25nYmlyZC11c2VycycsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFNOUyBUb3BpYyBmb3IgQWxlcnRzIChzaGFyZWQgYmV0d2VlbiBBUEkgYW5kIElvVCBjb25zdHJ1Y3RzKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTm90ZTogV2UgaW1wb3J0IHRoZSBleGlzdGluZyB0b3BpYyBjcmVhdGVkIGJ5IHRoZSBwcmV2aW91cyBBcGlDb25zdHJ1Y3QgZGVwbG95bWVudFxuICAgIC8vIHJhdGhlciB0aGFuIGNyZWF0aW5nIGEgbmV3IG9uZSB0byBhdm9pZCBuYW1lIGNvbmZsaWN0c1xuICAgIGNvbnN0IGFsZXJ0VG9waWMgPSBzbnMuVG9waWMuZnJvbVRvcGljQXJuKFxuICAgICAgdGhpcyxcbiAgICAgICdBbGVydFRvcGljJyxcbiAgICAgIGBhcm46YXdzOnNuczoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06c29uZ2JpcmQtYWxlcnRzYFxuICAgICk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEFQSSBMYXllciAoQVBJIEdhdGV3YXkgKyBMYW1iZGEpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBhcGkgPSBuZXcgQXBpQ29uc3RydWN0KHRoaXMsICdBcGknLCB7XG4gICAgICB0ZWxlbWV0cnlUYWJsZTogc3RvcmFnZS50ZWxlbWV0cnlUYWJsZSxcbiAgICAgIGRldmljZXNUYWJsZTogc3RvcmFnZS5kZXZpY2VzVGFibGUsXG4gICAgICB1c2VyUG9vbDogYXV0aC51c2VyUG9vbCxcbiAgICAgIHVzZXJQb29sQ2xpZW50OiBhdXRoLnVzZXJQb29sQ2xpZW50LFxuICAgICAgbm90ZWh1YlByb2plY3RVaWQ6IHByb3BzLm5vdGVodWJQcm9qZWN0VWlkLFxuICAgICAgYWxlcnRUb3BpYyxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gSW9UIExheWVyIChJb1QgQ29yZSBSdWxlcyArIExhbWJkYSlcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGlvdCA9IG5ldyBJb3RDb25zdHJ1Y3QodGhpcywgJ0lvdCcsIHtcbiAgICAgIHRlbGVtZXRyeVRhYmxlOiBzdG9yYWdlLnRlbGVtZXRyeVRhYmxlLFxuICAgICAgZGV2aWNlc1RhYmxlOiBzdG9yYWdlLmRldmljZXNUYWJsZSxcbiAgICAgIGFsZXJ0VG9waWMsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIERhc2hib2FyZCBIb3N0aW5nIChTMyArIENsb3VkRnJvbnQpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBkYXNoYm9hcmQgPSBuZXcgRGFzaGJvYXJkQ29uc3RydWN0KHRoaXMsICdEYXNoYm9hcmQnLCB7XG4gICAgICBhcGlVcmw6IGFwaS5hcGlVcmwsXG4gICAgICB1c2VyUG9vbElkOiBhdXRoLnVzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICB1c2VyUG9vbENsaWVudElkOiBhdXRoLnVzZXJQb29sQ2xpZW50LnVzZXJQb29sQ2xpZW50SWQsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE91dHB1dHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBcGlVcmwnLCB7XG4gICAgICB2YWx1ZTogYXBpLmFwaVVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgQVBJIGVuZHBvaW50IFVSTCcsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRBcGlVcmwnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0luZ2VzdFVybCcsIHtcbiAgICAgIHZhbHVlOiBhcGkuaW5nZXN0VXJsLFxuICAgICAgZGVzY3JpcHRpb246ICdFdmVudCBpbmdlc3QgVVJMIGZvciBOb3RlaHViIEhUVFAgcm91dGUnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkSW5nZXN0VXJsJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEYXNoYm9hcmRVcmwnLCB7XG4gICAgICB2YWx1ZTogZGFzaGJvYXJkLmRpc3RyaWJ1dGlvblVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgRGFzaGJvYXJkIFVSTCcsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmREYXNoYm9hcmRVcmwnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1VzZXJQb29sSWQnLCB7XG4gICAgICB2YWx1ZTogYXV0aC51c2VyUG9vbC51c2VyUG9vbElkLFxuICAgICAgZGVzY3JpcHRpb246ICdDb2duaXRvIFVzZXIgUG9vbCBJRCcsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRVc2VyUG9vbElkJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdVc2VyUG9vbENsaWVudElkJywge1xuICAgICAgdmFsdWU6IGF1dGgudXNlclBvb2xDbGllbnQudXNlclBvb2xDbGllbnRJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byBVc2VyIFBvb2wgQ2xpZW50IElEJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZFVzZXJQb29sQ2xpZW50SWQnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0lvVFJ1bGVOYW1lJywge1xuICAgICAgdmFsdWU6IGlvdC5ldmVudFByb2Nlc3NpbmdSdWxlLnJ1bGVOYW1lISxcbiAgICAgIGRlc2NyaXB0aW9uOiAnSW9UIENvcmUgcnVsZSBuYW1lIGZvciBOb3RlaHViIHJvdXRlIGNvbmZpZ3VyYXRpb24nLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkSW9UUnVsZU5hbWUnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0RldmljZXNUYWJsZU5hbWUnLCB7XG4gICAgICB2YWx1ZTogc3RvcmFnZS5kZXZpY2VzVGFibGUudGFibGVOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdEeW5hbW9EQiBkZXZpY2VzIHRhYmxlIG5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkRGV2aWNlc1RhYmxlJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdUZWxlbWV0cnlUYWJsZU5hbWUnLCB7XG4gICAgICB2YWx1ZTogc3RvcmFnZS50ZWxlbWV0cnlUYWJsZS50YWJsZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0R5bmFtb0RCIHRlbGVtZXRyeSB0YWJsZSBuYW1lJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZFRlbGVtZXRyeVRhYmxlJyxcbiAgICB9KTtcbiAgfVxufVxuIl19