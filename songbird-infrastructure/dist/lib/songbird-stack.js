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
        // API Layer (API Gateway + Lambda)
        // ==========================================================================
        const api = new api_construct_1.ApiConstruct(this, 'Api', {
            telemetryTable: storage.telemetryTable,
            devicesTable: storage.devicesTable,
            userPool: auth.userPool,
            notehubProjectUid: props.notehubProjectUid,
        });
        // ==========================================================================
        // IoT Layer (IoT Core Rules + Lambda)
        // ==========================================================================
        const iot = new iot_construct_1.IotConstruct(this, 'Iot', {
            telemetryTable: storage.telemetryTable,
            devicesTable: storage.devicesTable,
            alertTopic: api.alertTopic,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic29uZ2JpcmQtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvc29uZ2JpcmQtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7O0dBSUc7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBRUgsaURBQW1DO0FBRW5DLDJEQUF1RDtBQUN2RCxtREFBK0M7QUFDL0MsbURBQStDO0FBQy9DLCtEQUEyRDtBQUMzRCxxREFBaUQ7QUFNakQsTUFBYSxhQUFjLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDMUMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUF5QjtRQUNqRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4Qiw2RUFBNkU7UUFDN0UscURBQXFEO1FBQ3JELDZFQUE2RTtRQUM3RSxNQUFNLE9BQU8sR0FBRyxJQUFJLG9DQUFnQixDQUFDLElBQUksRUFBRSxTQUFTLEVBQUU7WUFDcEQsZUFBZSxFQUFFLGtCQUFrQjtZQUNuQyxrQkFBa0IsRUFBRSxvQkFBb0I7U0FDekMsQ0FBQyxDQUFDO1FBRUgsNkVBQTZFO1FBQzdFLDJCQUEyQjtRQUMzQiw2RUFBNkU7UUFDN0UsTUFBTSxJQUFJLEdBQUcsSUFBSSw4QkFBYSxDQUFDLElBQUksRUFBRSxNQUFNLEVBQUU7WUFDM0MsWUFBWSxFQUFFLGdCQUFnQjtTQUMvQixDQUFDLENBQUM7UUFFSCw2RUFBNkU7UUFDN0UsbUNBQW1DO1FBQ25DLDZFQUE2RTtRQUM3RSxNQUFNLEdBQUcsR0FBRyxJQUFJLDRCQUFZLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRTtZQUN4QyxjQUFjLEVBQUUsT0FBTyxDQUFDLGNBQWM7WUFDdEMsWUFBWSxFQUFFLE9BQU8sQ0FBQyxZQUFZO1lBQ2xDLFFBQVEsRUFBRSxJQUFJLENBQUMsUUFBUTtZQUN2QixpQkFBaUIsRUFBRSxLQUFLLENBQUMsaUJBQWlCO1NBQzNDLENBQUMsQ0FBQztRQUVILDZFQUE2RTtRQUM3RSxzQ0FBc0M7UUFDdEMsNkVBQTZFO1FBQzdFLE1BQU0sR0FBRyxHQUFHLElBQUksNEJBQVksQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFO1lBQ3hDLGNBQWMsRUFBRSxPQUFPLENBQUMsY0FBYztZQUN0QyxZQUFZLEVBQUUsT0FBTyxDQUFDLFlBQVk7WUFDbEMsVUFBVSxFQUFFLEdBQUcsQ0FBQyxVQUFVO1NBQzNCLENBQUMsQ0FBQztRQUVILDZFQUE2RTtRQUM3RSxzQ0FBc0M7UUFDdEMsNkVBQTZFO1FBQzdFLE1BQU0sU0FBUyxHQUFHLElBQUksd0NBQWtCLENBQUMsSUFBSSxFQUFFLFdBQVcsRUFBRTtZQUMxRCxNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU07WUFDbEIsVUFBVSxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsVUFBVTtZQUNwQyxnQkFBZ0IsRUFBRSxJQUFJLENBQUMsY0FBYyxDQUFDLGdCQUFnQjtTQUN2RCxDQUFDLENBQUM7UUFFSCw2RUFBNkU7UUFDN0UsVUFBVTtRQUNWLDZFQUE2RTtRQUM3RSxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLFFBQVEsRUFBRTtZQUNoQyxLQUFLLEVBQUUsR0FBRyxDQUFDLE1BQU07WUFDakIsV0FBVyxFQUFFLDJCQUEyQjtZQUN4QyxVQUFVLEVBQUUsZ0JBQWdCO1NBQzdCLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFO1lBQ3RDLEtBQUssRUFBRSxTQUFTLENBQUMsZUFBZTtZQUNoQyxXQUFXLEVBQUUsd0JBQXdCO1lBQ3JDLFVBQVUsRUFBRSxzQkFBc0I7U0FDbkMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7WUFDcEMsS0FBSyxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsVUFBVTtZQUMvQixXQUFXLEVBQUUsc0JBQXNCO1lBQ25DLFVBQVUsRUFBRSxvQkFBb0I7U0FDakMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRTtZQUMxQyxLQUFLLEVBQUUsSUFBSSxDQUFDLGNBQWMsQ0FBQyxnQkFBZ0I7WUFDM0MsV0FBVyxFQUFFLDZCQUE2QjtZQUMxQyxVQUFVLEVBQUUsMEJBQTBCO1NBQ3ZDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO1lBQ3JDLEtBQUssRUFBRSxHQUFHLENBQUMsbUJBQW1CLENBQUMsUUFBUztZQUN4QyxXQUFXLEVBQUUsb0RBQW9EO1lBQ2pFLFVBQVUsRUFBRSxxQkFBcUI7U0FDbEMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRTtZQUMxQyxLQUFLLEVBQUUsT0FBTyxDQUFDLFlBQVksQ0FBQyxTQUFTO1lBQ3JDLFdBQVcsRUFBRSw2QkFBNkI7WUFDMUMsVUFBVSxFQUFFLHNCQUFzQjtTQUNuQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLG9CQUFvQixFQUFFO1lBQzVDLEtBQUssRUFBRSxPQUFPLENBQUMsY0FBYyxDQUFDLFNBQVM7WUFDdkMsV0FBVyxFQUFFLCtCQUErQjtZQUM1QyxVQUFVLEVBQUUsd0JBQXdCO1NBQ3JDLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQTVGRCxzQ0E0RkMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFNvbmdiaXJkIE1haW4gU3RhY2tcbiAqXG4gKiBPcmNoZXN0cmF0ZXMgYWxsIGluZnJhc3RydWN0dXJlIGNvbnN0cnVjdHMgZm9yIHRoZSBTb25nYmlyZCBkZW1vIHBsYXRmb3JtLlxuICovXG5cbmltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCB7IFN0b3JhZ2VDb25zdHJ1Y3QgfSBmcm9tICcuL3N0b3JhZ2UtY29uc3RydWN0JztcbmltcG9ydCB7IElvdENvbnN0cnVjdCB9IGZyb20gJy4vaW90LWNvbnN0cnVjdCc7XG5pbXBvcnQgeyBBcGlDb25zdHJ1Y3QgfSBmcm9tICcuL2FwaS1jb25zdHJ1Y3QnO1xuaW1wb3J0IHsgRGFzaGJvYXJkQ29uc3RydWN0IH0gZnJvbSAnLi9kYXNoYm9hcmQtY29uc3RydWN0JztcbmltcG9ydCB7IEF1dGhDb25zdHJ1Y3QgfSBmcm9tICcuL2F1dGgtY29uc3RydWN0JztcblxuZXhwb3J0IGludGVyZmFjZSBTb25nYmlyZFN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIG5vdGVodWJQcm9qZWN0VWlkOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBTb25nYmlyZFN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IFNvbmdiaXJkU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBTdG9yYWdlIExheWVyIChEeW5hbW9EQiBmb3IgZGV2aWNlcyBhbmQgdGVsZW1ldHJ5KVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3Qgc3RvcmFnZSA9IG5ldyBTdG9yYWdlQ29uc3RydWN0KHRoaXMsICdTdG9yYWdlJywge1xuICAgICAgZHluYW1vVGFibGVOYW1lOiAnc29uZ2JpcmQtZGV2aWNlcycsXG4gICAgICB0ZWxlbWV0cnlUYWJsZU5hbWU6ICdzb25nYmlyZC10ZWxlbWV0cnknLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBBdXRoZW50aWNhdGlvbiAoQ29nbml0bylcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGF1dGggPSBuZXcgQXV0aENvbnN0cnVjdCh0aGlzLCAnQXV0aCcsIHtcbiAgICAgIHVzZXJQb29sTmFtZTogJ3NvbmdiaXJkLXVzZXJzJyxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQVBJIExheWVyIChBUEkgR2F0ZXdheSArIExhbWJkYSlcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGFwaSA9IG5ldyBBcGlDb25zdHJ1Y3QodGhpcywgJ0FwaScsIHtcbiAgICAgIHRlbGVtZXRyeVRhYmxlOiBzdG9yYWdlLnRlbGVtZXRyeVRhYmxlLFxuICAgICAgZGV2aWNlc1RhYmxlOiBzdG9yYWdlLmRldmljZXNUYWJsZSxcbiAgICAgIHVzZXJQb29sOiBhdXRoLnVzZXJQb29sLFxuICAgICAgbm90ZWh1YlByb2plY3RVaWQ6IHByb3BzLm5vdGVodWJQcm9qZWN0VWlkLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBJb1QgTGF5ZXIgKElvVCBDb3JlIFJ1bGVzICsgTGFtYmRhKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgaW90ID0gbmV3IElvdENvbnN0cnVjdCh0aGlzLCAnSW90Jywge1xuICAgICAgdGVsZW1ldHJ5VGFibGU6IHN0b3JhZ2UudGVsZW1ldHJ5VGFibGUsXG4gICAgICBkZXZpY2VzVGFibGU6IHN0b3JhZ2UuZGV2aWNlc1RhYmxlLFxuICAgICAgYWxlcnRUb3BpYzogYXBpLmFsZXJ0VG9waWMsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIERhc2hib2FyZCBIb3N0aW5nIChTMyArIENsb3VkRnJvbnQpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBkYXNoYm9hcmQgPSBuZXcgRGFzaGJvYXJkQ29uc3RydWN0KHRoaXMsICdEYXNoYm9hcmQnLCB7XG4gICAgICBhcGlVcmw6IGFwaS5hcGlVcmwsXG4gICAgICB1c2VyUG9vbElkOiBhdXRoLnVzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICB1c2VyUG9vbENsaWVudElkOiBhdXRoLnVzZXJQb29sQ2xpZW50LnVzZXJQb29sQ2xpZW50SWQsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE91dHB1dHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBcGlVcmwnLCB7XG4gICAgICB2YWx1ZTogYXBpLmFwaVVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgQVBJIGVuZHBvaW50IFVSTCcsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRBcGlVcmwnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0Rhc2hib2FyZFVybCcsIHtcbiAgICAgIHZhbHVlOiBkYXNoYm9hcmQuZGlzdHJpYnV0aW9uVXJsLFxuICAgICAgZGVzY3JpcHRpb246ICdTb25nYmlyZCBEYXNoYm9hcmQgVVJMJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZERhc2hib2FyZFVybCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVXNlclBvb2xJZCcsIHtcbiAgICAgIHZhbHVlOiBhdXRoLnVzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gVXNlciBQb29sIElEJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZFVzZXJQb29sSWQnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1VzZXJQb29sQ2xpZW50SWQnLCB7XG4gICAgICB2YWx1ZTogYXV0aC51c2VyUG9vbENsaWVudC51c2VyUG9vbENsaWVudElkLFxuICAgICAgZGVzY3JpcHRpb246ICdDb2duaXRvIFVzZXIgUG9vbCBDbGllbnQgSUQnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkVXNlclBvb2xDbGllbnRJZCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnSW9UUnVsZU5hbWUnLCB7XG4gICAgICB2YWx1ZTogaW90LmV2ZW50UHJvY2Vzc2luZ1J1bGUucnVsZU5hbWUhLFxuICAgICAgZGVzY3JpcHRpb246ICdJb1QgQ29yZSBydWxlIG5hbWUgZm9yIE5vdGVodWIgcm91dGUgY29uZmlndXJhdGlvbicsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRJb1RSdWxlTmFtZScsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRGV2aWNlc1RhYmxlTmFtZScsIHtcbiAgICAgIHZhbHVlOiBzdG9yYWdlLmRldmljZXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0R5bmFtb0RCIGRldmljZXMgdGFibGUgbmFtZScsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmREZXZpY2VzVGFibGUnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1RlbGVtZXRyeVRhYmxlTmFtZScsIHtcbiAgICAgIHZhbHVlOiBzdG9yYWdlLnRlbGVtZXRyeVRhYmxlLnRhYmxlTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRHluYW1vREIgdGVsZW1ldHJ5IHRhYmxlIG5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkVGVsZW1ldHJ5VGFibGUnLFxuICAgIH0pO1xuICB9XG59XG4iXX0=