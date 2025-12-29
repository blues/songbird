"use strict";
/**
 * Storage Construct
 *
 * Defines DynamoDB tables for device metadata and telemetry data.
 * (Timestream is no longer available to new AWS customers)
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
exports.StorageConstruct = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const constructs_1 = require("constructs");
class StorageConstruct extends constructs_1.Construct {
    devicesTable;
    telemetryTable;
    alertsTable;
    settingsTable;
    journeysTable;
    locationsTable;
    deviceAliasesTable;
    constructor(scope, id, props) {
        super(scope, id);
        // ==========================================================================
        // DynamoDB Table for Device Metadata
        // ==========================================================================
        this.devicesTable = new dynamodb.Table(this, 'DevicesTable', {
            tableName: props.dynamoTableName,
            // Primary key
            partitionKey: {
                name: 'device_uid',
                type: dynamodb.AttributeType.STRING,
            },
            // Billing mode - on-demand for unpredictable demo usage
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            // Enable point-in-time recovery
            pointInTimeRecovery: true,
            // Remove table on stack deletion (demo environment)
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            // Enable streams for future event-driven updates
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
        });
        // GSI for querying by fleet
        this.devicesTable.addGlobalSecondaryIndex({
            indexName: 'fleet-index',
            partitionKey: {
                name: 'fleet',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'last_seen',
                type: dynamodb.AttributeType.NUMBER,
            },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        // GSI for querying by status
        this.devicesTable.addGlobalSecondaryIndex({
            indexName: 'status-index',
            partitionKey: {
                name: 'status',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'last_seen',
                type: dynamodb.AttributeType.NUMBER,
            },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        // ==========================================================================
        // DynamoDB Table for Telemetry Data
        // ==========================================================================
        this.telemetryTable = new dynamodb.Table(this, 'TelemetryTable', {
            tableName: props.telemetryTableName,
            // Composite primary key: device_uid + timestamp
            partitionKey: {
                name: 'device_uid',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'timestamp',
                type: dynamodb.AttributeType.NUMBER,
            },
            // Billing mode - on-demand for unpredictable demo usage
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            // Remove table on stack deletion (demo environment)
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            // TTL to automatically delete old telemetry (90 days)
            timeToLiveAttribute: 'ttl',
        });
        // GSI for querying by event type
        this.telemetryTable.addGlobalSecondaryIndex({
            indexName: 'event-type-index',
            partitionKey: {
                name: 'device_uid',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'event_type_timestamp',
                type: dynamodb.AttributeType.STRING,
            },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        // ==========================================================================
        // DynamoDB Table for Alerts
        // ==========================================================================
        this.alertsTable = new dynamodb.Table(this, 'AlertsTable', {
            tableName: 'songbird-alerts',
            // Primary key: alert_id (UUID)
            partitionKey: {
                name: 'alert_id',
                type: dynamodb.AttributeType.STRING,
            },
            // Billing mode - on-demand for unpredictable demo usage
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            // Remove table on stack deletion (demo environment)
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            // TTL to automatically delete old alerts (90 days)
            timeToLiveAttribute: 'ttl',
        });
        // GSI for querying alerts by device
        this.alertsTable.addGlobalSecondaryIndex({
            indexName: 'device-index',
            partitionKey: {
                name: 'device_uid',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'created_at',
                type: dynamodb.AttributeType.NUMBER,
            },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        // GSI for querying active (unacknowledged) alerts
        this.alertsTable.addGlobalSecondaryIndex({
            indexName: 'status-index',
            partitionKey: {
                name: 'acknowledged',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'created_at',
                type: dynamodb.AttributeType.NUMBER,
            },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        // ==========================================================================
        // DynamoDB Table for Settings (Fleet Defaults)
        // ==========================================================================
        this.settingsTable = new dynamodb.Table(this, 'SettingsTable', {
            tableName: 'songbird-settings',
            // Composite primary key: setting_type + setting_id
            // e.g., setting_type="fleet_defaults", setting_id=<fleet_uid>
            partitionKey: {
                name: 'setting_type',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'setting_id',
                type: dynamodb.AttributeType.STRING,
            },
            // Billing mode - on-demand for unpredictable usage
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            // Remove table on stack deletion (demo environment)
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        // ==========================================================================
        // DynamoDB Table for Journeys (GPS tracking journeys)
        // ==========================================================================
        this.journeysTable = new dynamodb.Table(this, 'JourneysTable', {
            tableName: 'songbird-journeys',
            // Composite primary key: device_uid + journey_id (Unix timestamp)
            partitionKey: {
                name: 'device_uid',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'journey_id',
                type: dynamodb.AttributeType.NUMBER,
            },
            // Billing mode - on-demand for unpredictable usage
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            // Remove table on stack deletion (demo environment)
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            // TTL to automatically delete old journeys (90 days)
            timeToLiveAttribute: 'ttl',
        });
        // GSI for querying active journeys across all devices
        this.journeysTable.addGlobalSecondaryIndex({
            indexName: 'status-index',
            partitionKey: {
                name: 'status',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'start_time',
                type: dynamodb.AttributeType.NUMBER,
            },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        // ==========================================================================
        // DynamoDB Table for Location History (all location sources)
        // ==========================================================================
        this.locationsTable = new dynamodb.Table(this, 'LocationsTable', {
            tableName: 'songbird-locations',
            // Composite primary key: device_uid + timestamp
            partitionKey: {
                name: 'device_uid',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'timestamp',
                type: dynamodb.AttributeType.NUMBER,
            },
            // Billing mode - on-demand for unpredictable usage
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            // Remove table on stack deletion (demo environment)
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            // TTL to automatically delete old locations (90 days)
            timeToLiveAttribute: 'ttl',
        });
        // GSI for querying locations by journey
        this.locationsTable.addGlobalSecondaryIndex({
            indexName: 'journey-index',
            partitionKey: {
                name: 'device_uid',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'journey_id',
                type: dynamodb.AttributeType.NUMBER,
            },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        // ==========================================================================
        // DynamoDB Table for Device Aliases (serial_number -> device_uid mapping)
        // ==========================================================================
        // This table enables Notecard swapping: when a Notecard is replaced,
        // the serial_number remains stable while device_uid changes.
        // All historical data is preserved and merged using this mapping.
        this.deviceAliasesTable = new dynamodb.Table(this, 'DeviceAliasesTable', {
            tableName: 'songbird-device-aliases',
            // Primary key: serial_number (the stable device identifier)
            partitionKey: {
                name: 'serial_number',
                type: dynamodb.AttributeType.STRING,
            },
            // Billing mode - on-demand for unpredictable usage
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            // Remove table on stack deletion (demo environment)
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        // GSI for looking up serial_number by device_uid
        // Used when we receive an event and need to find the associated serial_number
        this.deviceAliasesTable.addGlobalSecondaryIndex({
            indexName: 'device-uid-index',
            partitionKey: {
                name: 'device_uid',
                type: dynamodb.AttributeType.STRING,
            },
            projectionType: dynamodb.ProjectionType.ALL,
        });
    }
}
exports.StorageConstruct = StorageConstruct;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RvcmFnZS1jb25zdHJ1Y3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvc3RvcmFnZS1jb25zdHJ1Y3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7OztHQUtHOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUVILGlEQUFtQztBQUNuQyxtRUFBcUQ7QUFDckQsMkNBQXVDO0FBT3ZDLE1BQWEsZ0JBQWlCLFNBQVEsc0JBQVM7SUFDN0IsWUFBWSxDQUFpQjtJQUM3QixjQUFjLENBQWlCO0lBQy9CLFdBQVcsQ0FBaUI7SUFDNUIsYUFBYSxDQUFpQjtJQUM5QixhQUFhLENBQWlCO0lBQzlCLGNBQWMsQ0FBaUI7SUFDL0Isa0JBQWtCLENBQWlCO0lBRW5ELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBNEI7UUFDcEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQiw2RUFBNkU7UUFDN0UscUNBQXFDO1FBQ3JDLDZFQUE2RTtRQUM3RSxJQUFJLENBQUMsWUFBWSxHQUFHLElBQUksUUFBUSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFO1lBQzNELFNBQVMsRUFBRSxLQUFLLENBQUMsZUFBZTtZQUVoQyxjQUFjO1lBQ2QsWUFBWSxFQUFFO2dCQUNaLElBQUksRUFBRSxZQUFZO2dCQUNsQixJQUFJLEVBQUUsUUFBUSxDQUFDLGFBQWEsQ0FBQyxNQUFNO2FBQ3BDO1lBRUQsd0RBQXdEO1lBQ3hELFdBQVcsRUFBRSxRQUFRLENBQUMsV0FBVyxDQUFDLGVBQWU7WUFFakQsZ0NBQWdDO1lBQ2hDLG1CQUFtQixFQUFFLElBQUk7WUFFekIsb0RBQW9EO1lBQ3BELGFBQWEsRUFBRSxHQUFHLENBQUMsYUFBYSxDQUFDLE9BQU87WUFFeEMsaURBQWlEO1lBQ2pELE1BQU0sRUFBRSxRQUFRLENBQUMsY0FBYyxDQUFDLGtCQUFrQjtTQUNuRCxDQUFDLENBQUM7UUFFSCw0QkFBNEI7UUFD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QUF5QjtZQUVwQyw0REFBNEQ7WUFDNUQsWUFBWSxFQUFFO2dCQUNaLElBQUksRUFBRSxlQUFlO2dCQUNyQixJQUFJLEVBQUUsUUFBUSxDQUFDLGFBQWEsQ0FBQyxNQUFNO2FBQ3BDO1lBRUQsbURBQW1EO1lBQ25ELFdBQVcsRUFBRSxRQUFRLENBQUMsV0FBVyxDQUFDLGVBQWU7WUFFakQsb0RBQW9EO1lBQ3BELGFBQWEsRUFBRSxHQUFHLENBQUMsYUFBYSxDQUFDLE9BQU87U0FDekMsQ0FBQyxDQUFDO1FBRUgsaURBQWlEO1FBQ2pELDhFQUE4RTtRQUM5RSxJQUFJLENBQUMsa0JBQWtCLENBQUMsdUJBQXVCLENBQUM7WUFDOUMsU0FBUyxFQUFFLGtCQUFrQjtZQUM3QixZQUFZLEVBQUU7Z0JBQ1osSUFBSSxFQUFFLFlBQVk7Z0JBQ2xCLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU07YUFDcEM7WUFDRCxjQUFjLEVBQUUsUUFBUSxDQUFDLGNBQWMsQ0FBQyxHQUFHO1NBQzVDLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQXBTRCw0Q0FvU0MiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFN0b3JhZ2UgQ29uc3RydWN0XG4gKlxuICogRGVmaW5lcyBEeW5hbW9EQiB0YWJsZXMgZm9yIGRldmljZSBtZXRhZGF0YSBhbmQgdGVsZW1ldHJ5IGRhdGEuXG4gKiAoVGltZXN0cmVhbSBpcyBubyBsb25nZXIgYXZhaWxhYmxlIHRvIG5ldyBBV1MgY3VzdG9tZXJzKVxuICovXG5cbmltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGInO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3RvcmFnZUNvbnN0cnVjdFByb3BzIHtcbiAgZHluYW1vVGFibGVOYW1lOiBzdHJpbmc7XG4gIHRlbGVtZXRyeVRhYmxlTmFtZTogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgU3RvcmFnZUNvbnN0cnVjdCBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBkZXZpY2VzVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgdGVsZW1ldHJ5VGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgYWxlcnRzVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgc2V0dGluZ3NUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSBqb3VybmV5c1RhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbiAgcHVibGljIHJlYWRvbmx5IGxvY2F0aW9uc1RhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbiAgcHVibGljIHJlYWRvbmx5IGRldmljZUFsaWFzZXNUYWJsZTogZHluYW1vZGIuVGFibGU7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IFN0b3JhZ2VDb25zdHJ1Y3RQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIER5bmFtb0RCIFRhYmxlIGZvciBEZXZpY2UgTWV0YWRhdGFcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuZGV2aWNlc1RhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdEZXZpY2VzVGFibGUnLCB7XG4gICAgICB0YWJsZU5hbWU6IHByb3BzLmR5bmFtb1RhYmxlTmFtZSxcblxuICAgICAgLy8gUHJpbWFyeSBrZXlcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnZGV2aWNlX3VpZCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcblxuICAgICAgLy8gQmlsbGluZyBtb2RlIC0gb24tZGVtYW5kIGZvciB1bnByZWRpY3RhYmxlIGRlbW8gdXNhZ2VcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG5cbiAgICAgIC8vIEVuYWJsZSBwb2ludC1pbi10aW1lIHJlY292ZXJ5XG4gICAgICBwb2ludEluVGltZVJlY292ZXJ5OiB0cnVlLFxuXG4gICAgICAvLyBSZW1vdmUgdGFibGUgb24gc3RhY2sgZGVsZXRpb24gKGRlbW8gZW52aXJvbm1lbnQpXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuXG4gICAgICAvLyBFbmFibGUgc3RyZWFtcyBmb3IgZnV0dXJlIGV2ZW50LWRyaXZlbiB1cGRhdGVzXG4gICAgICBzdHJlYW06IGR5bmFtb2RiLlN0cmVhbVZpZXdUeXBlLk5FV19BTkRfT0xEX0lNQUdFUyxcbiAgICB9KTtcblxuICAgIC8vIEdTSSBmb3IgcXVlcnlpbmcgYnkgZmxlZXRcbiAgICB0aGlzLmRldmljZXNUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6ICdmbGVldC1pbmRleCcsXG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogJ2ZsZWV0JyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnbGFzdF9zZWVuJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5OVU1CRVIsXG4gICAgICB9LFxuICAgICAgcHJvamVjdGlvblR5cGU6IGR5bmFtb2RiLlByb2plY3Rpb25UeXBlLkFMTCxcbiAgICB9KTtcblxuICAgIC8vIEdTSSBmb3IgcXVlcnlpbmcgYnkgc3RhdHVzXG4gICAgdGhpcy5kZXZpY2VzVGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xuICAgICAgaW5kZXhOYW1lOiAnc3RhdHVzLWluZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnc3RhdHVzJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnbGFzdF9zZWVuJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5OVU1CRVIsXG4gICAgICB9LFxuICAgICAgcHJvamVjdGlvblR5cGU6IGR5bmFtb2RiLlByb2plY3Rpb25UeXBlLkFMTCxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRHluYW1vREIgVGFibGUgZm9yIFRlbGVtZXRyeSBEYXRhXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLnRlbGVtZXRyeVRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdUZWxlbWV0cnlUYWJsZScsIHtcbiAgICAgIHRhYmxlTmFtZTogcHJvcHMudGVsZW1ldHJ5VGFibGVOYW1lLFxuXG4gICAgICAvLyBDb21wb3NpdGUgcHJpbWFyeSBrZXk6IGRldmljZV91aWQgKyB0aW1lc3RhbXBcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnZGV2aWNlX3VpZCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIHNvcnRLZXk6IHtcbiAgICAgICAgbmFtZTogJ3RpbWVzdGFtcCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSLFxuICAgICAgfSxcblxuICAgICAgLy8gQmlsbGluZyBtb2RlIC0gb24tZGVtYW5kIGZvciB1bnByZWRpY3RhYmxlIGRlbW8gdXNhZ2VcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG5cbiAgICAgIC8vIFJlbW92ZSB0YWJsZSBvbiBzdGFjayBkZWxldGlvbiAoZGVtbyBlbnZpcm9ubWVudClcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG5cbiAgICAgIC8vIFRUTCB0byBhdXRvbWF0aWNhbGx5IGRlbGV0ZSBvbGQgdGVsZW1ldHJ5ICg5MCBkYXlzKVxuICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogJ3R0bCcsXG4gICAgfSk7XG5cbiAgICAvLyBHU0kgZm9yIHF1ZXJ5aW5nIGJ5IGV2ZW50IHR5cGVcbiAgICB0aGlzLnRlbGVtZXRyeVRhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcbiAgICAgIGluZGV4TmFtZTogJ2V2ZW50LXR5cGUtaW5kZXgnLFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdkZXZpY2VfdWlkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnZXZlbnRfdHlwZV90aW1lc3RhbXAnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBEeW5hbW9EQiBUYWJsZSBmb3IgQWxlcnRzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLmFsZXJ0c1RhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdBbGVydHNUYWJsZScsIHtcbiAgICAgIHRhYmxlTmFtZTogJ3NvbmdiaXJkLWFsZXJ0cycsXG5cbiAgICAgIC8vIFByaW1hcnkga2V5OiBhbGVydF9pZCAoVVVJRClcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnYWxlcnRfaWQnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG5cbiAgICAgIC8vIEJpbGxpbmcgbW9kZSAtIG9uLWRlbWFuZCBmb3IgdW5wcmVkaWN0YWJsZSBkZW1vIHVzYWdlXG4gICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuXG4gICAgICAvLyBSZW1vdmUgdGFibGUgb24gc3RhY2sgZGVsZXRpb24gKGRlbW8gZW52aXJvbm1lbnQpXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuXG4gICAgICAvLyBUVEwgdG8gYXV0b21hdGljYWxseSBkZWxldGUgb2xkIGFsZXJ0cyAoOTAgZGF5cylcbiAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6ICd0dGwnLFxuICAgIH0pO1xuXG4gICAgLy8gR1NJIGZvciBxdWVyeWluZyBhbGVydHMgYnkgZGV2aWNlXG4gICAgdGhpcy5hbGVydHNUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6ICdkZXZpY2UtaW5kZXgnLFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdkZXZpY2VfdWlkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnY3JlYXRlZF9hdCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSLFxuICAgICAgfSxcbiAgICAgIHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgfSk7XG5cbiAgICAvLyBHU0kgZm9yIHF1ZXJ5aW5nIGFjdGl2ZSAodW5hY2tub3dsZWRnZWQpIGFsZXJ0c1xuICAgIHRoaXMuYWxlcnRzVGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xuICAgICAgaW5kZXhOYW1lOiAnc3RhdHVzLWluZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnYWNrbm93bGVkZ2VkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnY3JlYXRlZF9hdCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSLFxuICAgICAgfSxcbiAgICAgIHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIER5bmFtb0RCIFRhYmxlIGZvciBTZXR0aW5ncyAoRmxlZXQgRGVmYXVsdHMpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLnNldHRpbmdzVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgJ1NldHRpbmdzVGFibGUnLCB7XG4gICAgICB0YWJsZU5hbWU6ICdzb25nYmlyZC1zZXR0aW5ncycsXG5cbiAgICAgIC8vIENvbXBvc2l0ZSBwcmltYXJ5IGtleTogc2V0dGluZ190eXBlICsgc2V0dGluZ19pZFxuICAgICAgLy8gZS5nLiwgc2V0dGluZ190eXBlPVwiZmxlZXRfZGVmYXVsdHNcIiwgc2V0dGluZ19pZD08ZmxlZXRfdWlkPlxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdzZXR0aW5nX3R5cGUnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBzb3J0S2V5OiB7XG4gICAgICAgIG5hbWU6ICdzZXR0aW5nX2lkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuXG4gICAgICAvLyBCaWxsaW5nIG1vZGUgLSBvbi1kZW1hbmQgZm9yIHVucHJlZGljdGFibGUgdXNhZ2VcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG5cbiAgICAgIC8vIFJlbW92ZSB0YWJsZSBvbiBzdGFjayBkZWxldGlvbiAoZGVtbyBlbnZpcm9ubWVudClcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIER5bmFtb0RCIFRhYmxlIGZvciBKb3VybmV5cyAoR1BTIHRyYWNraW5nIGpvdXJuZXlzKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5qb3VybmV5c1RhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdKb3VybmV5c1RhYmxlJywge1xuICAgICAgdGFibGVOYW1lOiAnc29uZ2JpcmQtam91cm5leXMnLFxuXG4gICAgICAvLyBDb21wb3NpdGUgcHJpbWFyeSBrZXk6IGRldmljZV91aWQgKyBqb3VybmV5X2lkIChVbml4IHRpbWVzdGFtcClcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnZGV2aWNlX3VpZCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIHNvcnRLZXk6IHtcbiAgICAgICAgbmFtZTogJ2pvdXJuZXlfaWQnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLk5VTUJFUixcbiAgICAgIH0sXG5cbiAgICAgIC8vIEJpbGxpbmcgbW9kZSAtIG9uLWRlbWFuZCBmb3IgdW5wcmVkaWN0YWJsZSB1c2FnZVxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcblxuICAgICAgLy8gUmVtb3ZlIHRhYmxlIG9uIHN0YWNrIGRlbGV0aW9uIChkZW1vIGVudmlyb25tZW50KVxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcblxuICAgICAgLy8gVFRMIHRvIGF1dG9tYXRpY2FsbHkgZGVsZXRlIG9sZCBqb3VybmV5cyAoOTAgZGF5cylcbiAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6ICd0dGwnLFxuICAgIH0pO1xuXG4gICAgLy8gR1NJIGZvciBxdWVyeWluZyBhY3RpdmUgam91cm5leXMgYWNyb3NzIGFsbCBkZXZpY2VzXG4gICAgdGhpcy5qb3VybmV5c1RhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcbiAgICAgIGluZGV4TmFtZTogJ3N0YXR1cy1pbmRleCcsXG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogJ3N0YXR1cycsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIHNvcnRLZXk6IHtcbiAgICAgICAgbmFtZTogJ3N0YXJ0X3RpbWUnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLk5VTUJFUixcbiAgICAgIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBEeW5hbW9EQiBUYWJsZSBmb3IgTG9jYXRpb24gSGlzdG9yeSAoYWxsIGxvY2F0aW9uIHNvdXJjZXMpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLmxvY2F0aW9uc1RhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdMb2NhdGlvbnNUYWJsZScsIHtcbiAgICAgIHRhYmxlTmFtZTogJ3NvbmdiaXJkLWxvY2F0aW9ucycsXG5cbiAgICAgIC8vIENvbXBvc2l0ZSBwcmltYXJ5IGtleTogZGV2aWNlX3VpZCArIHRpbWVzdGFtcFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdkZXZpY2VfdWlkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAndGltZXN0YW1wJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5OVU1CRVIsXG4gICAgICB9LFxuXG4gICAgICAvLyBCaWxsaW5nIG1vZGUgLSBvbi1kZW1hbmQgZm9yIHVucHJlZGljdGFibGUgdXNhZ2VcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG5cbiAgICAgIC8vIFJlbW92ZSB0YWJsZSBvbiBzdGFjayBkZWxldGlvbiAoZGVtbyBlbnZpcm9ubWVudClcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG5cbiAgICAgIC8vIFRUTCB0byBhdXRvbWF0aWNhbGx5IGRlbGV0ZSBvbGQgbG9jYXRpb25zICg5MCBkYXlzKVxuICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogJ3R0bCcsXG4gICAgfSk7XG5cbiAgICAvLyBHU0kgZm9yIHF1ZXJ5aW5nIGxvY2F0aW9ucyBieSBqb3VybmV5XG4gICAgdGhpcy5sb2NhdGlvbnNUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6ICdqb3VybmV5LWluZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnZGV2aWNlX3VpZCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIHNvcnRLZXk6IHtcbiAgICAgICAgbmFtZTogJ2pvdXJuZXlfaWQnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLk5VTUJFUixcbiAgICAgIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBEeW5hbW9EQiBUYWJsZSBmb3IgRGV2aWNlIEFsaWFzZXMgKHNlcmlhbF9udW1iZXIgLT4gZGV2aWNlX3VpZCBtYXBwaW5nKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gVGhpcyB0YWJsZSBlbmFibGVzIE5vdGVjYXJkIHN3YXBwaW5nOiB3aGVuIGEgTm90ZWNhcmQgaXMgcmVwbGFjZWQsXG4gICAgLy8gdGhlIHNlcmlhbF9udW1iZXIgcmVtYWlucyBzdGFibGUgd2hpbGUgZGV2aWNlX3VpZCBjaGFuZ2VzLlxuICAgIC8vIEFsbCBoaXN0b3JpY2FsIGRhdGEgaXMgcHJlc2VydmVkIGFuZCBtZXJnZWQgdXNpbmcgdGhpcyBtYXBwaW5nLlxuICAgIHRoaXMuZGV2aWNlQWxpYXNlc1RhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdEZXZpY2VBbGlhc2VzVGFibGUnLCB7XG4gICAgICB0YWJsZU5hbWU6ICdzb25nYmlyZC1kZXZpY2UtYWxpYXNlcycsXG5cbiAgICAgIC8vIFByaW1hcnkga2V5OiBzZXJpYWxfbnVtYmVyICh0aGUgc3RhYmxlIGRldmljZSBpZGVudGlmaWVyKVxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdzZXJpYWxfbnVtYmVyJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuXG4gICAgICAvLyBCaWxsaW5nIG1vZGUgLSBvbi1kZW1hbmQgZm9yIHVucHJlZGljdGFibGUgdXNhZ2VcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG5cbiAgICAgIC8vIFJlbW92ZSB0YWJsZSBvbiBzdGFjayBkZWxldGlvbiAoZGVtbyBlbnZpcm9ubWVudClcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICAvLyBHU0kgZm9yIGxvb2tpbmcgdXAgc2VyaWFsX251bWJlciBieSBkZXZpY2VfdWlkXG4gICAgLy8gVXNlZCB3aGVuIHdlIHJlY2VpdmUgYW4gZXZlbnQgYW5kIG5lZWQgdG8gZmluZCB0aGUgYXNzb2NpYXRlZCBzZXJpYWxfbnVtYmVyXG4gICAgdGhpcy5kZXZpY2VBbGlhc2VzVGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xuICAgICAgaW5kZXhOYW1lOiAnZGV2aWNlLXVpZC1pbmRleCcsXG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogJ2RldmljZV91aWQnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgIH0pO1xuICB9XG59XG4iXX0=