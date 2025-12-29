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
    }
}
exports.SongbirdStack = SongbirdStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic29uZ2JpcmQtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvc29uZ2JpcmQtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7O0dBSUc7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBRUgsaURBQW1DO0FBQ25DLHlEQUEyQztBQUUzQywyREFBdUQ7QUFDdkQsbURBQStDO0FBQy9DLCtEQUEyRDtBQUMzRCxxREFBaUQ7QUFNakQsTUFBYSxhQUFjLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDMUMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUF5QjtRQUNqRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4Qiw2RUFBNkU7UUFDN0UscURBQXFEO1FBQ3JELDZFQUE2RTtRQUM3RSxNQUFNLE9BQU8sR0FBRyxJQUFJLG9DQUFnQixDQUFDLElBQUksRUFBRSxTQUFTLEVBQUU7WUFDcEQsZUFBZSxFQUFFLGtCQUFrQjtZQUNuQyxrQkFBa0IsRUFBRSxvQkFBb0I7U0FDekMsQ0FBQyxDQUFDO1FBRUgsNkVBQTZFO1FBQzdFLDJCQUEyQjtRQUMzQiw2RUFBNkU7UUFDN0UsTUFBTSxJQUFJLEdBQUcsSUFBSSw4QkFBYSxDQUFDLElBQUksRUFBRSxNQUFNLEVBQUU7WUFDM0MsWUFBWSxFQUFFLGdCQUFnQjtTQUMvQixDQUFDLENBQUM7UUFFSCw2RUFBNkU7UUFDN0UsdUJBQXVCO1FBQ3ZCLDZFQUE2RTtRQUM3RSxNQUFNLFVBQVUsR0FBRyxJQUFJLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUNuRCxTQUFTLEVBQUUsaUJBQWlCO1lBQzVCLFdBQVcsRUFBRSw4QkFBOEI7U0FDNUMsQ0FBQyxDQUFDO1FBRUgsNkVBQTZFO1FBQzdFLG1DQUFtQztRQUNuQyw2RUFBNkU7UUFDN0UsTUFBTSxHQUFHLEdBQUcsSUFBSSw0QkFBWSxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUU7WUFDeEMsY0FBYyxFQUFFLE9BQU8sQ0FBQyxjQUFjO1lBQ3RDLFlBQVksRUFBRSxPQUFPLENBQUMsWUFBWTtZQUNsQyxXQUFXLEVBQUUsT0FBTyxDQUFDLFdBQVc7WUFDaEMsYUFBYSxFQUFFLE9BQU8sQ0FBQyxhQUFhO1lBQ3BDLGFBQWEsRUFBRSxPQUFPLENBQUMsYUFBYTtZQUNwQyxjQUFjLEVBQUUsT0FBTyxDQUFDLGNBQWM7WUFDdEMsa0JBQWtCLEVBQUUsT0FBTyxDQUFDLGtCQUFrQjtZQUM5QyxRQUFRLEVBQUUsSUFBSSxDQUFDLFFBQVE7WUFDdkIsY0FBYyxFQUFFLElBQUksQ0FBQyxjQUFjO1lBQ25DLGlCQUFpQixFQUFFLEtBQUssQ0FBQyxpQkFBaUI7WUFDMUMsVUFBVTtTQUNYLENBQUMsQ0FBQztRQUVILDZFQUE2RTtRQUM3RSxzQ0FBc0M7UUFDdEMsNkVBQTZFO1FBQzdFLE1BQU0sU0FBUyxHQUFHLElBQUksd0NBQWtCLENBQUMsSUFBSSxFQUFFLFdBQVcsRUFBRTtZQUMxRCxNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU07WUFDbEIsVUFBVSxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsVUFBVTtZQUNwQyxnQkFBZ0IsRUFBRSxJQUFJLENBQUMsY0FBYyxDQUFDLGdCQUFnQjtTQUN2RCxDQUFDLENBQUM7UUFFSCw2RUFBNkU7UUFDN0UsVUFBVTtRQUNWLDZFQUE2RTtRQUM3RSxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLFFBQVEsRUFBRTtZQUNoQyxLQUFLLEVBQUUsR0FBRyxDQUFDLE1BQU07WUFDakIsV0FBVyxFQUFFLDJCQUEyQjtZQUN4QyxVQUFVLEVBQUUsZ0JBQWdCO1NBQzdCLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsV0FBVyxFQUFFO1lBQ25DLEtBQUssRUFBRSxHQUFHLENBQUMsU0FBUztZQUNwQixXQUFXLEVBQUUseUNBQXlDO1lBQ3RELFVBQVUsRUFBRSxtQkFBbUI7U0FDaEMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUU7WUFDdEMsS0FBSyxFQUFFLFNBQVMsQ0FBQyxlQUFlO1lBQ2hDLFdBQVcsRUFBRSx3QkFBd0I7WUFDckMsVUFBVSxFQUFFLHNCQUFzQjtTQUNuQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUNwQyxLQUFLLEVBQUUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxVQUFVO1lBQy9CLFdBQVcsRUFBRSxzQkFBc0I7WUFDbkMsVUFBVSxFQUFFLG9CQUFvQjtTQUNqQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGtCQUFrQixFQUFFO1lBQzFDLEtBQUssRUFBRSxJQUFJLENBQUMsY0FBYyxDQUFDLGdCQUFnQjtZQUMzQyxXQUFXLEVBQUUsNkJBQTZCO1lBQzFDLFVBQVUsRUFBRSwwQkFBMEI7U0FDdkMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRTtZQUMxQyxLQUFLLEVBQUUsT0FBTyxDQUFDLFlBQVksQ0FBQyxTQUFTO1lBQ3JDLFdBQVcsRUFBRSw2QkFBNkI7WUFDMUMsVUFBVSxFQUFFLHNCQUFzQjtTQUNuQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLG9CQUFvQixFQUFFO1lBQzVDLEtBQUssRUFBRSxPQUFPLENBQUMsY0FBYyxDQUFDLFNBQVM7WUFDdkMsV0FBVyxFQUFFLCtCQUErQjtZQUM1QyxVQUFVLEVBQUUsd0JBQXdCO1NBQ3JDLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQWxHRCxzQ0FrR0MiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFNvbmdiaXJkIE1haW4gU3RhY2tcbiAqXG4gKiBPcmNoZXN0cmF0ZXMgYWxsIGluZnJhc3RydWN0dXJlIGNvbnN0cnVjdHMgZm9yIHRoZSBTb25nYmlyZCBkZW1vIHBsYXRmb3JtLlxuICovXG5cbmltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBzbnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNucyc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCB7IFN0b3JhZ2VDb25zdHJ1Y3QgfSBmcm9tICcuL3N0b3JhZ2UtY29uc3RydWN0JztcbmltcG9ydCB7IEFwaUNvbnN0cnVjdCB9IGZyb20gJy4vYXBpLWNvbnN0cnVjdCc7XG5pbXBvcnQgeyBEYXNoYm9hcmRDb25zdHJ1Y3QgfSBmcm9tICcuL2Rhc2hib2FyZC1jb25zdHJ1Y3QnO1xuaW1wb3J0IHsgQXV0aENvbnN0cnVjdCB9IGZyb20gJy4vYXV0aC1jb25zdHJ1Y3QnO1xuXG5leHBvcnQgaW50ZXJmYWNlIFNvbmdiaXJkU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgbm90ZWh1YlByb2plY3RVaWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIFNvbmdiaXJkU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogU29uZ2JpcmRTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFN0b3JhZ2UgTGF5ZXIgKER5bmFtb0RCIGZvciBkZXZpY2VzIGFuZCB0ZWxlbWV0cnkpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBzdG9yYWdlID0gbmV3IFN0b3JhZ2VDb25zdHJ1Y3QodGhpcywgJ1N0b3JhZ2UnLCB7XG4gICAgICBkeW5hbW9UYWJsZU5hbWU6ICdzb25nYmlyZC1kZXZpY2VzJyxcbiAgICAgIHRlbGVtZXRyeVRhYmxlTmFtZTogJ3NvbmdiaXJkLXRlbGVtZXRyeScsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEF1dGhlbnRpY2F0aW9uIChDb2duaXRvKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYXV0aCA9IG5ldyBBdXRoQ29uc3RydWN0KHRoaXMsICdBdXRoJywge1xuICAgICAgdXNlclBvb2xOYW1lOiAnc29uZ2JpcmQtdXNlcnMnLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBTTlMgVG9waWMgZm9yIEFsZXJ0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYWxlcnRUb3BpYyA9IG5ldyBzbnMuVG9waWModGhpcywgJ0FsZXJ0VG9waWMnLCB7XG4gICAgICB0b3BpY05hbWU6ICdzb25nYmlyZC1hbGVydHMnLFxuICAgICAgZGlzcGxheU5hbWU6ICdTb25nYmlyZCBBbGVydCBOb3RpZmljYXRpb25zJyxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQVBJIExheWVyIChBUEkgR2F0ZXdheSArIExhbWJkYSlcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGFwaSA9IG5ldyBBcGlDb25zdHJ1Y3QodGhpcywgJ0FwaScsIHtcbiAgICAgIHRlbGVtZXRyeVRhYmxlOiBzdG9yYWdlLnRlbGVtZXRyeVRhYmxlLFxuICAgICAgZGV2aWNlc1RhYmxlOiBzdG9yYWdlLmRldmljZXNUYWJsZSxcbiAgICAgIGFsZXJ0c1RhYmxlOiBzdG9yYWdlLmFsZXJ0c1RhYmxlLFxuICAgICAgc2V0dGluZ3NUYWJsZTogc3RvcmFnZS5zZXR0aW5nc1RhYmxlLFxuICAgICAgam91cm5leXNUYWJsZTogc3RvcmFnZS5qb3VybmV5c1RhYmxlLFxuICAgICAgbG9jYXRpb25zVGFibGU6IHN0b3JhZ2UubG9jYXRpb25zVGFibGUsXG4gICAgICBkZXZpY2VBbGlhc2VzVGFibGU6IHN0b3JhZ2UuZGV2aWNlQWxpYXNlc1RhYmxlLFxuICAgICAgdXNlclBvb2w6IGF1dGgudXNlclBvb2wsXG4gICAgICB1c2VyUG9vbENsaWVudDogYXV0aC51c2VyUG9vbENsaWVudCxcbiAgICAgIG5vdGVodWJQcm9qZWN0VWlkOiBwcm9wcy5ub3RlaHViUHJvamVjdFVpZCxcbiAgICAgIGFsZXJ0VG9waWMsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIERhc2hib2FyZCBIb3N0aW5nIChTMyArIENsb3VkRnJvbnQpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBkYXNoYm9hcmQgPSBuZXcgRGFzaGJvYXJkQ29uc3RydWN0KHRoaXMsICdEYXNoYm9hcmQnLCB7XG4gICAgICBhcGlVcmw6IGFwaS5hcGlVcmwsXG4gICAgICB1c2VyUG9vbElkOiBhdXRoLnVzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICB1c2VyUG9vbENsaWVudElkOiBhdXRoLnVzZXJQb29sQ2xpZW50LnVzZXJQb29sQ2xpZW50SWQsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE91dHB1dHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBcGlVcmwnLCB7XG4gICAgICB2YWx1ZTogYXBpLmFwaVVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgQVBJIGVuZHBvaW50IFVSTCcsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRBcGlVcmwnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0luZ2VzdFVybCcsIHtcbiAgICAgIHZhbHVlOiBhcGkuaW5nZXN0VXJsLFxuICAgICAgZGVzY3JpcHRpb246ICdFdmVudCBpbmdlc3QgVVJMIGZvciBOb3RlaHViIEhUVFAgcm91dGUnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkSW5nZXN0VXJsJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEYXNoYm9hcmRVcmwnLCB7XG4gICAgICB2YWx1ZTogZGFzaGJvYXJkLmRpc3RyaWJ1dGlvblVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgRGFzaGJvYXJkIFVSTCcsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmREYXNoYm9hcmRVcmwnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1VzZXJQb29sSWQnLCB7XG4gICAgICB2YWx1ZTogYXV0aC51c2VyUG9vbC51c2VyUG9vbElkLFxuICAgICAgZGVzY3JpcHRpb246ICdDb2duaXRvIFVzZXIgUG9vbCBJRCcsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRVc2VyUG9vbElkJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdVc2VyUG9vbENsaWVudElkJywge1xuICAgICAgdmFsdWU6IGF1dGgudXNlclBvb2xDbGllbnQudXNlclBvb2xDbGllbnRJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byBVc2VyIFBvb2wgQ2xpZW50IElEJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZFVzZXJQb29sQ2xpZW50SWQnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0RldmljZXNUYWJsZU5hbWUnLCB7XG4gICAgICB2YWx1ZTogc3RvcmFnZS5kZXZpY2VzVGFibGUudGFibGVOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdEeW5hbW9EQiBkZXZpY2VzIHRhYmxlIG5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkRGV2aWNlc1RhYmxlJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdUZWxlbWV0cnlUYWJsZU5hbWUnLCB7XG4gICAgICB2YWx1ZTogc3RvcmFnZS50ZWxlbWV0cnlUYWJsZS50YWJsZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0R5bmFtb0RCIHRlbGVtZXRyeSB0YWJsZSBuYW1lJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZFRlbGVtZXRyeVRhYmxlJyxcbiAgICB9KTtcbiAgfVxufVxuIl19