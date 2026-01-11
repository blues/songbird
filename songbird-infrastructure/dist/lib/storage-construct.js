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
    auditTable;
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
            // Enable streams for real-time sync to Aurora Analytics
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
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
            // Enable streams for real-time sync to Aurora Analytics
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
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
            // Enable streams for real-time sync to Aurora Analytics
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
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
            // Enable streams for real-time sync to Aurora Analytics
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
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
        // ==========================================================================
        // DynamoDB Table for Audit Logs
        // ==========================================================================
        // Tracks public device access and other auditable events
        this.auditTable = new dynamodb.Table(this, 'AuditTable', {
            tableName: 'songbird-audit',
            // Primary key: audit_id (UUID with timestamp prefix)
            partitionKey: {
                name: 'audit_id',
                type: dynamodb.AttributeType.STRING,
            },
            // Billing mode - on-demand for unpredictable usage
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            // Remove table on stack deletion (demo environment)
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            // TTL to automatically delete old audit records (90 days)
            timeToLiveAttribute: 'ttl',
        });
        // GSI for querying audits by action type
        this.auditTable.addGlobalSecondaryIndex({
            indexName: 'action-index',
            partitionKey: {
                name: 'action',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'timestamp',
                type: dynamodb.AttributeType.NUMBER,
            },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        // GSI for querying audits by serial_number
        this.auditTable.addGlobalSecondaryIndex({
            indexName: 'serial-number-index',
            partitionKey: {
                name: 'serial_number',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'timestamp',
                type: dynamodb.AttributeType.NUMBER,
            },
            projectionType: dynamodb.ProjectionType.ALL,
        });
    }
}
exports.StorageConstruct = StorageConstruct;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RvcmFnZS1jb25zdHJ1Y3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvc3RvcmFnZS1jb25zdHJ1Y3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7OztHQUtHOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUVILGlEQUFtQztBQUNuQyxtRUFBcUQ7QUFDckQsMkNBQXVDO0FBT3ZDLE1BQWEsZ0JBQWlCLFNBQVEsc0JBQVM7SUFDN0IsWUFBWSxDQUFpQjtJQUM3QixjQUFjLENBQWlCO0lBQy9CLFdBQVcsQ0FBaUI7SUFDNUIsYUFBYSxDQUFpQjtJQUM5QixhQUFhLENBQWlCO0lBQzlCLGNBQWMsQ0FBaUI7SUFDL0Isa0JBQWtCLENBQWlCO0lBQ25DLFVBQVUsQ0FBaUI7SUFFM0MsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUE0QjtRQUNwRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLDZFQUE2RTtRQUM3RSxxQ0FBcUM7UUFDckMsNkVBQTZFO1FBQzdFLElBQUksQ0FBQyxZQUFZLEdBQUcsSUFBSSxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUU7WUFDM0QsU0FBUyxFQUFFLEtBQUssQ0FBQyxlQUFlO1lBRWhDLGNBQWM7WUFDZCxZQUFZLEVBQUU7Z0JBQ1osSUFBSSxFQUFFLFlBQVk7Z0JBQ2xCLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU07YUFDcEM7WUFFRCx3REFBd0Q7WUFDeEQsV0FBVyxFQUFFLFFBQVEsQ0FBQyxXQUFXLENBQUMsZUFBZTtZQUVqRCxnQ0FBZ0M7WUFDaEMsbUJBQW1CLEVBQUUsSUFBSTtZQUV6QixvREFBb0Q7WUFDcEQsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTztZQUV4QyxpREFBaUQ7WUFDakQsTUFBTSxFQUFFLFFBQVEsQ0FBQyxjQUFjLENBQUMsa0JBQWtCO1NBQ25ELENBQUMsQ0FB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QUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU07YUFDcEM7WUFFRCxtREFBbUQ7WUFDbkQsV0FBVyxFQUFFLFFBQVEsQ0FBQyxXQUFXLENBQUMsZUFBZTtZQUVqRCxvREFBb0Q7WUFDcEQsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTztZQUV4QywwREFBMEQ7WUFDMUQsbUJBQW1CLEVBQUUsS0FBSztTQUMzQixDQUFDLENBQUM7UUFFSCx5Q0FBeUM7UUFDekMsSUFBSSxDQUFDLFVBQVUsQ0FBQyx1QkFBdUIsQ0FBQztZQUN0QyxTQUFTLEVBQUUsY0FBYztZQUN6QixZQUFZLEVBQUU7Z0JBQ1osSUFBSSxFQUFFLFFBQVE7Z0JBQ2QsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTTthQUNwQztZQUNELE9BQU8sRUFBRTtnQkFDUCxJQUFJLEVBQUUsV0FBVztnQkFDakIsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTTthQUNwQztZQUNELGNBQWMsRUFBRSxRQUFRLENBQUMsY0FBYyxDQUFDLEdBQUc7U0FDNUMsQ0FBQyxDQUFDO1FBRUgsMkNBQTJDO1FBQzNDLElBQUksQ0FBQyxVQUFVLENBQUMsdUJBQXVCLENBQUM7WUFDdEMsU0FBUyxFQUFFLHFCQUFxQjtZQUNoQyxZQUFZLEVBQUU7Z0JBQ1osSUFBSSxFQUFFLGVBQWU7Z0JBQ3JCLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU07YUFDcEM7WUFDRCxPQUFPLEVBQUU7Z0JBQ1AsSUFBSSxFQUFFLFdBQVc7Z0JBQ2pCLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU07YUFDcEM7WUFDRCxjQUFjLEVBQUUsUUFBUSxDQUFDLGNBQWMsQ0FBQyxHQUFHO1NBQzVDLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQXBXRCw0Q0FvV0MiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFN0b3JhZ2UgQ29uc3RydWN0XG4gKlxuICogRGVmaW5lcyBEeW5hbW9EQiB0YWJsZXMgZm9yIGRldmljZSBtZXRhZGF0YSBhbmQgdGVsZW1ldHJ5IGRhdGEuXG4gKiAoVGltZXN0cmVhbSBpcyBubyBsb25nZXIgYXZhaWxhYmxlIHRvIG5ldyBBV1MgY3VzdG9tZXJzKVxuICovXG5cbmltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGInO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3RvcmFnZUNvbnN0cnVjdFByb3BzIHtcbiAgZHluYW1vVGFibGVOYW1lOiBzdHJpbmc7XG4gIHRlbGVtZXRyeVRhYmxlTmFtZTogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgU3RvcmFnZUNvbnN0cnVjdCBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBkZXZpY2VzVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgdGVsZW1ldHJ5VGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgYWxlcnRzVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgc2V0dGluZ3NUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSBqb3VybmV5c1RhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbiAgcHVibGljIHJlYWRvbmx5IGxvY2F0aW9uc1RhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbiAgcHVibGljIHJlYWRvbmx5IGRldmljZUFsaWFzZXNUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSBhdWRpdFRhYmxlOiBkeW5hbW9kYi5UYWJsZTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogU3RvcmFnZUNvbnN0cnVjdFByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRHluYW1vREIgVGFibGUgZm9yIERldmljZSBNZXRhZGF0YVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5kZXZpY2VzVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgJ0RldmljZXNUYWJsZScsIHtcbiAgICAgIHRhYmxlTmFtZTogcHJvcHMuZHluYW1vVGFibGVOYW1lLFxuXG4gICAgICAvLyBQcmltYXJ5IGtleVxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdkZXZpY2VfdWlkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuXG4gICAgICAvLyBCaWxsaW5nIG1vZGUgLSBvbi1kZW1hbmQgZm9yIHVucHJlZGljdGFibGUgZGVtbyB1c2FnZVxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcblxuICAgICAgLy8gRW5hYmxlIHBvaW50LWluLXRpbWUgcmVjb3ZlcnlcbiAgICAgIHBvaW50SW5UaW1lUmVjb3Zlcnk6IHRydWUsXG5cbiAgICAgIC8vIFJlbW92ZSB0YWJsZSBvbiBzdGFjayBkZWxldGlvbiAoZGVtbyBlbnZpcm9ubWVudClcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG5cbiAgICAgIC8vIEVuYWJsZSBzdHJlYW1zIGZvciBmdXR1cmUgZXZlbnQtZHJpdmVuIHVwZGF0ZXNcbiAgICAgIHN0cmVhbTogZHluYW1vZGIuU3RyZWFtVmlld1R5cGUuTkVXX0FORF9PTERfSU1BR0VTLFxuICAgIH0pO1xuXG4gICAgLy8gR1NJIGZvciBxdWVyeWluZyBieSBmbGVldFxuICAgIHRoaXMuZGV2aWNlc1RhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcbiAgICAgIGluZGV4TmFtZTogJ2ZsZWV0LWluZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnZmxlZXQnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBzb3J0S2V5OiB7XG4gICAgICAgIG5hbWU6ICdsYXN0X3NlZW4nLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLk5VTUJFUixcbiAgICAgIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgIH0pO1xuXG4gICAgLy8gR1NJIGZvciBxdWVyeWluZyBieSBzdGF0dXNcbiAgICB0aGlzLmRldmljZXNUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6ICdzdGF0dXMtaW5kZXgnLFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdzdGF0dXMnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBzb3J0S2V5OiB7XG4gICAgICAgIG5hbWU6ICdsYXN0X3NlZW4nLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLk5VTUJFUixcbiAgICAgIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBEeW5hbW9EQiBUYWJsZSBmb3IgVGVsZW1ldHJ5IERhdGFcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMudGVsZW1ldHJ5VGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgJ1RlbGVtZXRyeVRhYmxlJywge1xuICAgICAgdGFibGVOYW1lOiBwcm9wcy50ZWxlbWV0cnlUYWJsZU5hbWUsXG5cbiAgICAgIC8vIENvbXBvc2l0ZSBwcmltYXJ5IGtleTogZGV2aWNlX3VpZCArIHRpbWVzdGFtcFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdkZXZpY2VfdWlkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAndGltZXN0YW1wJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5OVU1CRVIsXG4gICAgICB9LFxuXG4gICAgICAvLyBCaWxsaW5nIG1vZGUgLSBvbi1kZW1hbmQgZm9yIHVucHJlZGljdGFibGUgZGVtbyB1c2FnZVxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcblxuICAgICAgLy8gUmVtb3ZlIHRhYmxlIG9uIHN0YWNrIGRlbGV0aW9uIChkZW1vIGVudmlyb25tZW50KVxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcblxuICAgICAgLy8gVFRMIHRvIGF1dG9tYXRpY2FsbHkgZGVsZXRlIG9sZCB0ZWxlbWV0cnkgKDkwIGRheXMpXG4gICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiAndHRsJyxcblxuICAgICAgLy8gRW5hYmxlIHN0cmVhbXMgZm9yIHJlYWwtdGltZSBzeW5jIHRvIEF1cm9yYSBBbmFseXRpY3NcbiAgICAgIHN0cmVhbTogZHluYW1vZGIuU3RyZWFtVmlld1R5cGUuTkVXX0FORF9PTERfSU1BR0VTLFxuICAgIH0pO1xuXG4gICAgLy8gR1NJIGZvciBxdWVyeWluZyBieSBldmVudCB0eXBlXG4gICAgdGhpcy50ZWxlbWV0cnlUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6ICdldmVudC10eXBlLWluZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnZGV2aWNlX3VpZCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIHNvcnRLZXk6IHtcbiAgICAgICAgbmFtZTogJ2V2ZW50X3R5cGVfdGltZXN0YW1wJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgcHJvamVjdGlvblR5cGU6IGR5bmFtb2RiLlByb2plY3Rpb25UeXBlLkFMTCxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRHluYW1vREIgVGFibGUgZm9yIEFsZXJ0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5hbGVydHNUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCAnQWxlcnRzVGFibGUnLCB7XG4gICAgICB0YWJsZU5hbWU6ICdzb25nYmlyZC1hbGVydHMnLFxuXG4gICAgICAvLyBQcmltYXJ5IGtleTogYWxlcnRfaWQgKFVVSUQpXG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogJ2FsZXJ0X2lkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuXG4gICAgICAvLyBCaWxsaW5nIG1vZGUgLSBvbi1kZW1hbmQgZm9yIHVucHJlZGljdGFibGUgZGVtbyB1c2FnZVxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcblxuICAgICAgLy8gUmVtb3ZlIHRhYmxlIG9uIHN0YWNrIGRlbGV0aW9uIChkZW1vIGVudmlyb25tZW50KVxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcblxuICAgICAgLy8gVFRMIHRvIGF1dG9tYXRpY2FsbHkgZGVsZXRlIG9sZCBhbGVydHMgKDkwIGRheXMpXG4gICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiAndHRsJyxcblxuICAgICAgLy8gRW5hYmxlIHN0cmVhbXMgZm9yIHJlYWwtdGltZSBzeW5jIHRvIEF1cm9yYSBBbmFseXRpY3NcbiAgICAgIHN0cmVhbTogZHluYW1vZGIuU3RyZWFtVmlld1R5cGUuTkVXX0FORF9PTERfSU1BR0VTLFxuICAgIH0pO1xuXG4gICAgLy8gR1NJIGZvciBxdWVyeWluZyBhbGVydHMgYnkgZGV2aWNlXG4gICAgdGhpcy5hbGVydHNUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6ICdkZXZpY2UtaW5kZXgnLFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdkZXZpY2VfdWlkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnY3JlYXRlZF9hdCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSLFxuICAgICAgfSxcbiAgICAgIHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgfSk7XG5cbiAgICAvLyBHU0kgZm9yIHF1ZXJ5aW5nIGFjdGl2ZSAodW5hY2tub3dsZWRnZWQpIGFsZXJ0c1xuICAgIHRoaXMuYWxlcnRzVGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xuICAgICAgaW5kZXhOYW1lOiAnc3RhdHVzLWluZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnYWNrbm93bGVkZ2VkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnY3JlYXRlZF9hdCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSLFxuICAgICAgfSxcbiAgICAgIHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIER5bmFtb0RCIFRhYmxlIGZvciBTZXR0aW5ncyAoRmxlZXQgRGVmYXVsdHMpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLnNldHRpbmdzVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgJ1NldHRpbmdzVGFibGUnLCB7XG4gICAgICB0YWJsZU5hbWU6ICdzb25nYmlyZC1zZXR0aW5ncycsXG5cbiAgICAgIC8vIENvbXBvc2l0ZSBwcmltYXJ5IGtleTogc2V0dGluZ190eXBlICsgc2V0dGluZ19pZFxuICAgICAgLy8gZS5nLiwgc2V0dGluZ190eXBlPVwiZmxlZXRfZGVmYXVsdHNcIiwgc2V0dGluZ19pZD08ZmxlZXRfdWlkPlxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdzZXR0aW5nX3R5cGUnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBzb3J0S2V5OiB7XG4gICAgICAgIG5hbWU6ICdzZXR0aW5nX2lkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuXG4gICAgICAvLyBCaWxsaW5nIG1vZGUgLSBvbi1kZW1hbmQgZm9yIHVucHJlZGljdGFibGUgdXNhZ2VcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG5cbiAgICAgIC8vIFJlbW92ZSB0YWJsZSBvbiBzdGFjayBkZWxldGlvbiAoZGVtbyBlbnZpcm9ubWVudClcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIER5bmFtb0RCIFRhYmxlIGZvciBKb3VybmV5cyAoR1BTIHRyYWNraW5nIGpvdXJuZXlzKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5qb3VybmV5c1RhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdKb3VybmV5c1RhYmxlJywge1xuICAgICAgdGFibGVOYW1lOiAnc29uZ2JpcmQtam91cm5leXMnLFxuXG4gICAgICAvLyBDb21wb3NpdGUgcHJpbWFyeSBrZXk6IGRldmljZV91aWQgKyBqb3VybmV5X2lkIChVbml4IHRpbWVzdGFtcClcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnZGV2aWNlX3VpZCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIHNvcnRLZXk6IHtcbiAgICAgICAgbmFtZTogJ2pvdXJuZXlfaWQnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLk5VTUJFUixcbiAgICAgIH0sXG5cbiAgICAgIC8vIEJpbGxpbmcgbW9kZSAtIG9uLWRlbWFuZCBmb3IgdW5wcmVkaWN0YWJsZSB1c2FnZVxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcblxuICAgICAgLy8gUmVtb3ZlIHRhYmxlIG9uIHN0YWNrIGRlbGV0aW9uIChkZW1vIGVudmlyb25tZW50KVxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcblxuICAgICAgLy8gVFRMIHRvIGF1dG9tYXRpY2FsbHkgZGVsZXRlIG9sZCBqb3VybmV5cyAoOTAgZGF5cylcbiAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6ICd0dGwnLFxuXG4gICAgICAvLyBFbmFibGUgc3RyZWFtcyBmb3IgcmVhbC10aW1lIHN5bmMgdG8gQXVyb3JhIEFuYWx5dGljc1xuICAgICAgc3RyZWFtOiBkeW5hbW9kYi5TdHJlYW1WaWV3VHlwZS5ORVdfQU5EX09MRF9JTUFHRVMsXG4gICAgfSk7XG5cbiAgICAvLyBHU0kgZm9yIHF1ZXJ5aW5nIGFjdGl2ZSBqb3VybmV5cyBhY3Jvc3MgYWxsIGRldmljZXNcbiAgICB0aGlzLmpvdXJuZXlzVGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xuICAgICAgaW5kZXhOYW1lOiAnc3RhdHVzLWluZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnc3RhdHVzJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnc3RhcnRfdGltZScsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSLFxuICAgICAgfSxcbiAgICAgIHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIER5bmFtb0RCIFRhYmxlIGZvciBMb2NhdGlvbiBIaXN0b3J5IChhbGwgbG9jYXRpb24gc291cmNlcylcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMubG9jYXRpb25zVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgJ0xvY2F0aW9uc1RhYmxlJywge1xuICAgICAgdGFibGVOYW1lOiAnc29uZ2JpcmQtbG9jYXRpb25zJyxcblxuICAgICAgLy8gQ29tcG9zaXRlIHByaW1hcnkga2V5OiBkZXZpY2VfdWlkICsgdGltZXN0YW1wXG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogJ2RldmljZV91aWQnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBzb3J0S2V5OiB7XG4gICAgICAgIG5hbWU6ICd0aW1lc3RhbXAnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLk5VTUJFUixcbiAgICAgIH0sXG5cbiAgICAgIC8vIEJpbGxpbmcgbW9kZSAtIG9uLWRlbWFuZCBmb3IgdW5wcmVkaWN0YWJsZSB1c2FnZVxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcblxuICAgICAgLy8gUmVtb3ZlIHRhYmxlIG9uIHN0YWNrIGRlbGV0aW9uIChkZW1vIGVudmlyb25tZW50KVxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcblxuICAgICAgLy8gVFRMIHRvIGF1dG9tYXRpY2FsbHkgZGVsZXRlIG9sZCBsb2NhdGlvbnMgKDkwIGRheXMpXG4gICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiAndHRsJyxcblxuICAgICAgLy8gRW5hYmxlIHN0cmVhbXMgZm9yIHJlYWwtdGltZSBzeW5jIHRvIEF1cm9yYSBBbmFseXRpY3NcbiAgICAgIHN0cmVhbTogZHluYW1vZGIuU3RyZWFtVmlld1R5cGUuTkVXX0FORF9PTERfSU1BR0VTLFxuICAgIH0pO1xuXG4gICAgLy8gR1NJIGZvciBxdWVyeWluZyBsb2NhdGlvbnMgYnkgam91cm5leVxuICAgIHRoaXMubG9jYXRpb25zVGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xuICAgICAgaW5kZXhOYW1lOiAnam91cm5leS1pbmRleCcsXG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogJ2RldmljZV91aWQnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBzb3J0S2V5OiB7XG4gICAgICAgIG5hbWU6ICdqb3VybmV5X2lkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5OVU1CRVIsXG4gICAgICB9LFxuICAgICAgcHJvamVjdGlvblR5cGU6IGR5bmFtb2RiLlByb2plY3Rpb25UeXBlLkFMTCxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRHluYW1vREIgVGFibGUgZm9yIERldmljZSBBbGlhc2VzIChzZXJpYWxfbnVtYmVyIC0+IGRldmljZV91aWQgbWFwcGluZylcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFRoaXMgdGFibGUgZW5hYmxlcyBOb3RlY2FyZCBzd2FwcGluZzogd2hlbiBhIE5vdGVjYXJkIGlzIHJlcGxhY2VkLFxuICAgIC8vIHRoZSBzZXJpYWxfbnVtYmVyIHJlbWFpbnMgc3RhYmxlIHdoaWxlIGRldmljZV91aWQgY2hhbmdlcy5cbiAgICAvLyBBbGwgaGlzdG9yaWNhbCBkYXRhIGlzIHByZXNlcnZlZCBhbmQgbWVyZ2VkIHVzaW5nIHRoaXMgbWFwcGluZy5cbiAgICB0aGlzLmRldmljZUFsaWFzZXNUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCAnRGV2aWNlQWxpYXNlc1RhYmxlJywge1xuICAgICAgdGFibGVOYW1lOiAnc29uZ2JpcmQtZGV2aWNlLWFsaWFzZXMnLFxuXG4gICAgICAvLyBQcmltYXJ5IGtleTogc2VyaWFsX251bWJlciAodGhlIHN0YWJsZSBkZXZpY2UgaWRlbnRpZmllcilcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnc2VyaWFsX251bWJlcicsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcblxuICAgICAgLy8gQmlsbGluZyBtb2RlIC0gb24tZGVtYW5kIGZvciB1bnByZWRpY3RhYmxlIHVzYWdlXG4gICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuXG4gICAgICAvLyBSZW1vdmUgdGFibGUgb24gc3RhY2sgZGVsZXRpb24gKGRlbW8gZW52aXJvbm1lbnQpXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIH0pO1xuXG4gICAgLy8gR1NJIGZvciBsb29raW5nIHVwIHNlcmlhbF9udW1iZXIgYnkgZGV2aWNlX3VpZFxuICAgIC8vIFVzZWQgd2hlbiB3ZSByZWNlaXZlIGFuIGV2ZW50IGFuZCBuZWVkIHRvIGZpbmQgdGhlIGFzc29jaWF0ZWQgc2VyaWFsX251bWJlclxuICAgIHRoaXMuZGV2aWNlQWxpYXNlc1RhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcbiAgICAgIGluZGV4TmFtZTogJ2RldmljZS11aWQtaW5kZXgnLFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdkZXZpY2VfdWlkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgcHJvamVjdGlvblR5cGU6IGR5bmFtb2RiLlByb2plY3Rpb25UeXBlLkFMTCxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRHluYW1vREIgVGFibGUgZm9yIEF1ZGl0IExvZ3NcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFRyYWNrcyBwdWJsaWMgZGV2aWNlIGFjY2VzcyBhbmQgb3RoZXIgYXVkaXRhYmxlIGV2ZW50c1xuICAgIHRoaXMuYXVkaXRUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCAnQXVkaXRUYWJsZScsIHtcbiAgICAgIHRhYmxlTmFtZTogJ3NvbmdiaXJkLWF1ZGl0JyxcblxuICAgICAgLy8gUHJpbWFyeSBrZXk6IGF1ZGl0X2lkIChVVUlEIHdpdGggdGltZXN0YW1wIHByZWZpeClcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnYXVkaXRfaWQnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG5cbiAgICAgIC8vIEJpbGxpbmcgbW9kZSAtIG9uLWRlbWFuZCBmb3IgdW5wcmVkaWN0YWJsZSB1c2FnZVxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcblxuICAgICAgLy8gUmVtb3ZlIHRhYmxlIG9uIHN0YWNrIGRlbGV0aW9uIChkZW1vIGVudmlyb25tZW50KVxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcblxuICAgICAgLy8gVFRMIHRvIGF1dG9tYXRpY2FsbHkgZGVsZXRlIG9sZCBhdWRpdCByZWNvcmRzICg5MCBkYXlzKVxuICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogJ3R0bCcsXG4gICAgfSk7XG5cbiAgICAvLyBHU0kgZm9yIHF1ZXJ5aW5nIGF1ZGl0cyBieSBhY3Rpb24gdHlwZVxuICAgIHRoaXMuYXVkaXRUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6ICdhY3Rpb24taW5kZXgnLFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdhY3Rpb24nLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBzb3J0S2V5OiB7XG4gICAgICAgIG5hbWU6ICd0aW1lc3RhbXAnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLk5VTUJFUixcbiAgICAgIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgIH0pO1xuXG4gICAgLy8gR1NJIGZvciBxdWVyeWluZyBhdWRpdHMgYnkgc2VyaWFsX251bWJlclxuICAgIHRoaXMuYXVkaXRUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6ICdzZXJpYWwtbnVtYmVyLWluZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnc2VyaWFsX251bWJlcicsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIHNvcnRLZXk6IHtcbiAgICAgICAgbmFtZTogJ3RpbWVzdGFtcCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSLFxuICAgICAgfSxcbiAgICAgIHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==