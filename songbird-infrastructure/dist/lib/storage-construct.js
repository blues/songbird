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
    }
}
exports.StorageConstruct = StorageConstruct;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RvcmFnZS1jb25zdHJ1Y3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvc3RvcmFnZS1jb25zdHJ1Y3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7OztHQUtHOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUVILGlEQUFtQztBQUNuQyxtRUFBcUQ7QUFDckQsMkNBQXVDO0FBT3ZDLE1BQWEsZ0JBQWlCLFNBQVEsc0JBQVM7SUFDN0IsWUFBWSxDQUFpQjtJQUM3QixjQUFjLENBQWlCO0lBQy9CLFdBQVcsQ0FBaUI7SUFDNUIsYUFBYSxDQUFpQjtJQUU5QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQTRCO1FBQ3BFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsNkVBQTZFO1FBQzdFLHFDQUFxQztRQUNyQyw2RUFBNkU7UUFDN0UsSUFBSSxDQUFDLFlBQVksR0FBRyxJQUFJLFFBQVEsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRTtZQUMzRCxTQUFTLEVBQUUsS0FBSyxDQUFDLGVBQWU7WUFFaEMsY0FBYztZQUNkLFlBQVksRUFBRTtnQkFDWixJQUFJLEVBQUUsWUFBWTtnQkFDbEIsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTTthQUNwQztZQUVELHdEQUF3RDtZQUN4RCxXQUFXLEVBQUUsUUFBUSxDQUFDLFdBQVcsQ0FBQyxlQUFlO1lBRWpELGdDQUFnQztZQUNoQyxtQkFBbUIsRUFBRSxJQUFJO1lBRXpCLG9EQUFvRDtZQUNwRCxhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBRXhDLGlEQUFpRDtZQUNqRCxNQUFNLEVBQUUsUUFBUSxDQUFDLGNBQWMsQ0FBQyxrQkFBa0I7U0FDbkQsQ0FBQyxDQUFDO1FBRUgsNEJBQTRCO1FBQzVCLElBQUksQ0FBQyxZQUFZLENBQUMsdUJBQXVCLENBQUM7WUFDeEMsU0FBUyxFQUFFLGFB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RyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1NBQ3pDLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQWhMRCw0Q0FnTEMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFN0b3JhZ2UgQ29uc3RydWN0XG4gKlxuICogRGVmaW5lcyBEeW5hbW9EQiB0YWJsZXMgZm9yIGRldmljZSBtZXRhZGF0YSBhbmQgdGVsZW1ldHJ5IGRhdGEuXG4gKiAoVGltZXN0cmVhbSBpcyBubyBsb25nZXIgYXZhaWxhYmxlIHRvIG5ldyBBV1MgY3VzdG9tZXJzKVxuICovXG5cbmltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGInO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3RvcmFnZUNvbnN0cnVjdFByb3BzIHtcbiAgZHluYW1vVGFibGVOYW1lOiBzdHJpbmc7XG4gIHRlbGVtZXRyeVRhYmxlTmFtZTogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgU3RvcmFnZUNvbnN0cnVjdCBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBkZXZpY2VzVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgdGVsZW1ldHJ5VGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgYWxlcnRzVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgc2V0dGluZ3NUYWJsZTogZHluYW1vZGIuVGFibGU7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IFN0b3JhZ2VDb25zdHJ1Y3RQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIER5bmFtb0RCIFRhYmxlIGZvciBEZXZpY2UgTWV0YWRhdGFcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuZGV2aWNlc1RhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdEZXZpY2VzVGFibGUnLCB7XG4gICAgICB0YWJsZU5hbWU6IHByb3BzLmR5bmFtb1RhYmxlTmFtZSxcblxuICAgICAgLy8gUHJpbWFyeSBrZXlcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnZGV2aWNlX3VpZCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcblxuICAgICAgLy8gQmlsbGluZyBtb2RlIC0gb24tZGVtYW5kIGZvciB1bnByZWRpY3RhYmxlIGRlbW8gdXNhZ2VcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG5cbiAgICAgIC8vIEVuYWJsZSBwb2ludC1pbi10aW1lIHJlY292ZXJ5XG4gICAgICBwb2ludEluVGltZVJlY292ZXJ5OiB0cnVlLFxuXG4gICAgICAvLyBSZW1vdmUgdGFibGUgb24gc3RhY2sgZGVsZXRpb24gKGRlbW8gZW52aXJvbm1lbnQpXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuXG4gICAgICAvLyBFbmFibGUgc3RyZWFtcyBmb3IgZnV0dXJlIGV2ZW50LWRyaXZlbiB1cGRhdGVzXG4gICAgICBzdHJlYW06IGR5bmFtb2RiLlN0cmVhbVZpZXdUeXBlLk5FV19BTkRfT0xEX0lNQUdFUyxcbiAgICB9KTtcblxuICAgIC8vIEdTSSBmb3IgcXVlcnlpbmcgYnkgZmxlZXRcbiAgICB0aGlzLmRldmljZXNUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6ICdmbGVldC1pbmRleCcsXG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogJ2ZsZWV0JyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnbGFzdF9zZWVuJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5OVU1CRVIsXG4gICAgICB9LFxuICAgICAgcHJvamVjdGlvblR5cGU6IGR5bmFtb2RiLlByb2plY3Rpb25UeXBlLkFMTCxcbiAgICB9KTtcblxuICAgIC8vIEdTSSBmb3IgcXVlcnlpbmcgYnkgc3RhdHVzXG4gICAgdGhpcy5kZXZpY2VzVGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xuICAgICAgaW5kZXhOYW1lOiAnc3RhdHVzLWluZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnc3RhdHVzJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnbGFzdF9zZWVuJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5OVU1CRVIsXG4gICAgICB9LFxuICAgICAgcHJvamVjdGlvblR5cGU6IGR5bmFtb2RiLlByb2plY3Rpb25UeXBlLkFMTCxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRHluYW1vREIgVGFibGUgZm9yIFRlbGVtZXRyeSBEYXRhXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLnRlbGVtZXRyeVRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdUZWxlbWV0cnlUYWJsZScsIHtcbiAgICAgIHRhYmxlTmFtZTogcHJvcHMudGVsZW1ldHJ5VGFibGVOYW1lLFxuXG4gICAgICAvLyBDb21wb3NpdGUgcHJpbWFyeSBrZXk6IGRldmljZV91aWQgKyB0aW1lc3RhbXBcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnZGV2aWNlX3VpZCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIHNvcnRLZXk6IHtcbiAgICAgICAgbmFtZTogJ3RpbWVzdGFtcCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSLFxuICAgICAgfSxcblxuICAgICAgLy8gQmlsbGluZyBtb2RlIC0gb24tZGVtYW5kIGZvciB1bnByZWRpY3RhYmxlIGRlbW8gdXNhZ2VcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG5cbiAgICAgIC8vIFJlbW92ZSB0YWJsZSBvbiBzdGFjayBkZWxldGlvbiAoZGVtbyBlbnZpcm9ubWVudClcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG5cbiAgICAgIC8vIFRUTCB0byBhdXRvbWF0aWNhbGx5IGRlbGV0ZSBvbGQgdGVsZW1ldHJ5ICg5MCBkYXlzKVxuICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogJ3R0bCcsXG4gICAgfSk7XG5cbiAgICAvLyBHU0kgZm9yIHF1ZXJ5aW5nIGJ5IGV2ZW50IHR5cGVcbiAgICB0aGlzLnRlbGVtZXRyeVRhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcbiAgICAgIGluZGV4TmFtZTogJ2V2ZW50LXR5cGUtaW5kZXgnLFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdkZXZpY2VfdWlkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnZXZlbnRfdHlwZV90aW1lc3RhbXAnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBEeW5hbW9EQiBUYWJsZSBmb3IgQWxlcnRzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLmFsZXJ0c1RhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdBbGVydHNUYWJsZScsIHtcbiAgICAgIHRhYmxlTmFtZTogJ3NvbmdiaXJkLWFsZXJ0cycsXG5cbiAgICAgIC8vIFByaW1hcnkga2V5OiBhbGVydF9pZCAoVVVJRClcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnYWxlcnRfaWQnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG5cbiAgICAgIC8vIEJpbGxpbmcgbW9kZSAtIG9uLWRlbWFuZCBmb3IgdW5wcmVkaWN0YWJsZSBkZW1vIHVzYWdlXG4gICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuXG4gICAgICAvLyBSZW1vdmUgdGFibGUgb24gc3RhY2sgZGVsZXRpb24gKGRlbW8gZW52aXJvbm1lbnQpXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuXG4gICAgICAvLyBUVEwgdG8gYXV0b21hdGljYWxseSBkZWxldGUgb2xkIGFsZXJ0cyAoOTAgZGF5cylcbiAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6ICd0dGwnLFxuICAgIH0pO1xuXG4gICAgLy8gR1NJIGZvciBxdWVyeWluZyBhbGVydHMgYnkgZGV2aWNlXG4gICAgdGhpcy5hbGVydHNUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6ICdkZXZpY2UtaW5kZXgnLFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdkZXZpY2VfdWlkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnY3JlYXRlZF9hdCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSLFxuICAgICAgfSxcbiAgICAgIHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgfSk7XG5cbiAgICAvLyBHU0kgZm9yIHF1ZXJ5aW5nIGFjdGl2ZSAodW5hY2tub3dsZWRnZWQpIGFsZXJ0c1xuICAgIHRoaXMuYWxlcnRzVGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xuICAgICAgaW5kZXhOYW1lOiAnc3RhdHVzLWluZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnYWNrbm93bGVkZ2VkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnY3JlYXRlZF9hdCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSLFxuICAgICAgfSxcbiAgICAgIHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIER5bmFtb0RCIFRhYmxlIGZvciBTZXR0aW5ncyAoRmxlZXQgRGVmYXVsdHMpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLnNldHRpbmdzVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgJ1NldHRpbmdzVGFibGUnLCB7XG4gICAgICB0YWJsZU5hbWU6ICdzb25nYmlyZC1zZXR0aW5ncycsXG5cbiAgICAgIC8vIENvbXBvc2l0ZSBwcmltYXJ5IGtleTogc2V0dGluZ190eXBlICsgc2V0dGluZ19pZFxuICAgICAgLy8gZS5nLiwgc2V0dGluZ190eXBlPVwiZmxlZXRfZGVmYXVsdHNcIiwgc2V0dGluZ19pZD08ZmxlZXRfdWlkPlxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdzZXR0aW5nX3R5cGUnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBzb3J0S2V5OiB7XG4gICAgICAgIG5hbWU6ICdzZXR0aW5nX2lkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuXG4gICAgICAvLyBCaWxsaW5nIG1vZGUgLSBvbi1kZW1hbmQgZm9yIHVucHJlZGljdGFibGUgdXNhZ2VcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG5cbiAgICAgIC8vIFJlbW92ZSB0YWJsZSBvbiBzdGFjayBkZWxldGlvbiAoZGVtbyBlbnZpcm9ubWVudClcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==