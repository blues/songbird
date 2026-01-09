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
    }
}
exports.StorageConstruct = StorageConstruct;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RvcmFnZS1jb25zdHJ1Y3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvc3RvcmFnZS1jb25zdHJ1Y3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7OztHQUtHOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUVILGlEQUFtQztBQUNuQyxtRUFBcUQ7QUFDckQsMkNBQXVDO0FBT3ZDLE1BQWEsZ0JBQWlCLFNBQVEsc0JBQVM7SUFDN0IsWUFBWSxDQUFpQjtJQUM3QixjQUFjLENBQWlCO0lBQy9CLFdBQVcsQ0FBaUI7SUFDNUIsYUFBYSxDQUFpQjtJQUM5QixhQUFhLENBQWlCO0lBQzlCLGNBQWMsQ0FBaUI7SUFDL0Isa0JBQWtCLENBQWlCO0lBRW5ELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBNEI7UUFDcEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQiw2RUFBNkU7UUFDN0UscUNBQXFDO1FBQ3JDLDZFQUE2RTtRQUM3RSxJQUFJLENBQUMsWUFBWSxHQUFHLElBQUksUUFBUSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFO1lBQzNELFNBQVMsRUFBRSxLQUFLLENBQUMsZUFBZTtZQUVoQyxjQUFjO1lBQ2QsWUFBWSxFQUFFO2dCQUNaLElBQUksRUFBRSxZQUFZO2dCQUNsQixJQUFJLEVBQUUsUUFBUSxDQUFDLGFBQWEsQ0FBQyxNQUFNO2FBQ3BDO1lBRUQsd0RBQXdEO1lBQ3hELFdBQVcsRUFBRSxRQUFRLENBQUMsV0FBVyxDQUFDLGVBQWU7WUFFakQsZ0NBQWdDO1lBQ2hDLG1CQUFtQixFQUFFLElBQUk7WUFFekIsb0RBQW9EO1lBQ3BELGFBQWEsRUFBRSxHQUFHLENBQUMsYUFBYSxDQUFDLE9BQU87WUFFeEMsaURBQWlEO1lBQ2pELE1BQU0sRUFBRSxRQUFRLENBQUMsY0FBYyxDQUFDLGtCQUFrQjtTQUNuRCxDQUFDLENBQUM7UUFFSCw0QkFBNEI7UUFD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Q0QsY0FBYyxFQUFFLFFBQVEsQ0FBQyxjQUFjLENBQUMsR0FBRztTQUM1QyxDQUFDLENBQUM7UUFFSCw2RUFBNkU7UUFDN0UsMEVBQTBFO1FBQzFFLDZFQUE2RTtRQUM3RSxxRUFBcUU7UUFDckUsNkRBQTZEO1FBQzdELGtFQUFrRTtRQUNsRSxJQUFJLENBQUMsa0JBQWtCLEdBQUcsSUFBSSxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxvQkFBb0IsRUFBRTtZQUN2RSxTQUFTLEVBQUUseUJBQXlCO1lBRXBDLDREQUE0RDtZQUM1RCxZQUFZLEVBQUU7Z0JBQ1osSUFBSSxFQUFFLGVBQWU7Z0JBQ3JCLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU07YUFDcEM7WUFFRCxtREFBbUQ7WUFDbkQsV0FBVyxFQUFFLFFBQVEsQ0FBQyxXQUFXLENBQUMsZUFBZTtZQUVqRCxvREFBb0Q7WUFDcEQsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTztTQUN6QyxDQUFDLENBQUM7UUFFSCxpREFBaUQ7UUFDakQsOEVBQThFO1FBQzlFLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyx1QkFBdUIsQ0FBQztZQUM5QyxTQUFTLEVBQUUsa0JBQWtCO1lBQzdCLFlBQVksRUFBRTtnQkFDWixJQUFJLEVBQUUsWUFBWTtnQkFDbEIsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTTthQUNwQztZQUNELGNBQWMsRUFBRSxRQUFRLENBQUMsY0FBYyxDQUFDLEdBQUc7U0FDNUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBaFRELDRDQWdUQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU3RvcmFnZSBDb25zdHJ1Y3RcbiAqXG4gKiBEZWZpbmVzIER5bmFtb0RCIHRhYmxlcyBmb3IgZGV2aWNlIG1ldGFkYXRhIGFuZCB0ZWxlbWV0cnkgZGF0YS5cbiAqIChUaW1lc3RyZWFtIGlzIG5vIGxvbmdlciBhdmFpbGFibGUgdG8gbmV3IEFXUyBjdXN0b21lcnMpXG4gKi9cblxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gJ2F3cy1jZGstbGliL2F3cy1keW5hbW9kYic7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcblxuZXhwb3J0IGludGVyZmFjZSBTdG9yYWdlQ29uc3RydWN0UHJvcHMge1xuICBkeW5hbW9UYWJsZU5hbWU6IHN0cmluZztcbiAgdGVsZW1ldHJ5VGFibGVOYW1lOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBTdG9yYWdlQ29uc3RydWN0IGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGRldmljZXNUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSB0ZWxlbWV0cnlUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSBhbGVydHNUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSBzZXR0aW5nc1RhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbiAgcHVibGljIHJlYWRvbmx5IGpvdXJuZXlzVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgbG9jYXRpb25zVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgZGV2aWNlQWxpYXNlc1RhYmxlOiBkeW5hbW9kYi5UYWJsZTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogU3RvcmFnZUNvbnN0cnVjdFByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRHluYW1vREIgVGFibGUgZm9yIERldmljZSBNZXRhZGF0YVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5kZXZpY2VzVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgJ0RldmljZXNUYWJsZScsIHtcbiAgICAgIHRhYmxlTmFtZTogcHJvcHMuZHluYW1vVGFibGVOYW1lLFxuXG4gICAgICAvLyBQcmltYXJ5IGtleVxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdkZXZpY2VfdWlkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuXG4gICAgICAvLyBCaWxsaW5nIG1vZGUgLSBvbi1kZW1hbmQgZm9yIHVucHJlZGljdGFibGUgZGVtbyB1c2FnZVxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcblxuICAgICAgLy8gRW5hYmxlIHBvaW50LWluLXRpbWUgcmVjb3ZlcnlcbiAgICAgIHBvaW50SW5UaW1lUmVjb3Zlcnk6IHRydWUsXG5cbiAgICAgIC8vIFJlbW92ZSB0YWJsZSBvbiBzdGFjayBkZWxldGlvbiAoZGVtbyBlbnZpcm9ubWVudClcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG5cbiAgICAgIC8vIEVuYWJsZSBzdHJlYW1zIGZvciBmdXR1cmUgZXZlbnQtZHJpdmVuIHVwZGF0ZXNcbiAgICAgIHN0cmVhbTogZHluYW1vZGIuU3RyZWFtVmlld1R5cGUuTkVXX0FORF9PTERfSU1BR0VTLFxuICAgIH0pO1xuXG4gICAgLy8gR1NJIGZvciBxdWVyeWluZyBieSBmbGVldFxuICAgIHRoaXMuZGV2aWNlc1RhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcbiAgICAgIGluZGV4TmFtZTogJ2ZsZWV0LWluZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnZmxlZXQnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBzb3J0S2V5OiB7XG4gICAgICAgIG5hbWU6ICdsYXN0X3NlZW4nLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLk5VTUJFUixcbiAgICAgIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgIH0pO1xuXG4gICAgLy8gR1NJIGZvciBxdWVyeWluZyBieSBzdGF0dXNcbiAgICB0aGlzLmRldmljZXNUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6ICdzdGF0dXMtaW5kZXgnLFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdzdGF0dXMnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBzb3J0S2V5OiB7XG4gICAgICAgIG5hbWU6ICdsYXN0X3NlZW4nLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLk5VTUJFUixcbiAgICAgIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBEeW5hbW9EQiBUYWJsZSBmb3IgVGVsZW1ldHJ5IERhdGFcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMudGVsZW1ldHJ5VGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgJ1RlbGVtZXRyeVRhYmxlJywge1xuICAgICAgdGFibGVOYW1lOiBwcm9wcy50ZWxlbWV0cnlUYWJsZU5hbWUsXG5cbiAgICAgIC8vIENvbXBvc2l0ZSBwcmltYXJ5IGtleTogZGV2aWNlX3VpZCArIHRpbWVzdGFtcFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdkZXZpY2VfdWlkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAndGltZXN0YW1wJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5OVU1CRVIsXG4gICAgICB9LFxuXG4gICAgICAvLyBCaWxsaW5nIG1vZGUgLSBvbi1kZW1hbmQgZm9yIHVucHJlZGljdGFibGUgZGVtbyB1c2FnZVxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcblxuICAgICAgLy8gUmVtb3ZlIHRhYmxlIG9uIHN0YWNrIGRlbGV0aW9uIChkZW1vIGVudmlyb25tZW50KVxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcblxuICAgICAgLy8gVFRMIHRvIGF1dG9tYXRpY2FsbHkgZGVsZXRlIG9sZCB0ZWxlbWV0cnkgKDkwIGRheXMpXG4gICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiAndHRsJyxcblxuICAgICAgLy8gRW5hYmxlIHN0cmVhbXMgZm9yIHJlYWwtdGltZSBzeW5jIHRvIEF1cm9yYSBBbmFseXRpY3NcbiAgICAgIHN0cmVhbTogZHluYW1vZGIuU3RyZWFtVmlld1R5cGUuTkVXX0FORF9PTERfSU1BR0VTLFxuICAgIH0pO1xuXG4gICAgLy8gR1NJIGZvciBxdWVyeWluZyBieSBldmVudCB0eXBlXG4gICAgdGhpcy50ZWxlbWV0cnlUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6ICdldmVudC10eXBlLWluZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnZGV2aWNlX3VpZCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIHNvcnRLZXk6IHtcbiAgICAgICAgbmFtZTogJ2V2ZW50X3R5cGVfdGltZXN0YW1wJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgcHJvamVjdGlvblR5cGU6IGR5bmFtb2RiLlByb2plY3Rpb25UeXBlLkFMTCxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRHluYW1vREIgVGFibGUgZm9yIEFsZXJ0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5hbGVydHNUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCAnQWxlcnRzVGFibGUnLCB7XG4gICAgICB0YWJsZU5hbWU6ICdzb25nYmlyZC1hbGVydHMnLFxuXG4gICAgICAvLyBQcmltYXJ5IGtleTogYWxlcnRfaWQgKFVVSUQpXG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogJ2FsZXJ0X2lkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuXG4gICAgICAvLyBCaWxsaW5nIG1vZGUgLSBvbi1kZW1hbmQgZm9yIHVucHJlZGljdGFibGUgZGVtbyB1c2FnZVxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcblxuICAgICAgLy8gUmVtb3ZlIHRhYmxlIG9uIHN0YWNrIGRlbGV0aW9uIChkZW1vIGVudmlyb25tZW50KVxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcblxuICAgICAgLy8gVFRMIHRvIGF1dG9tYXRpY2FsbHkgZGVsZXRlIG9sZCBhbGVydHMgKDkwIGRheXMpXG4gICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiAndHRsJyxcblxuICAgICAgLy8gRW5hYmxlIHN0cmVhbXMgZm9yIHJlYWwtdGltZSBzeW5jIHRvIEF1cm9yYSBBbmFseXRpY3NcbiAgICAgIHN0cmVhbTogZHluYW1vZGIuU3RyZWFtVmlld1R5cGUuTkVXX0FORF9PTERfSU1BR0VTLFxuICAgIH0pO1xuXG4gICAgLy8gR1NJIGZvciBxdWVyeWluZyBhbGVydHMgYnkgZGV2aWNlXG4gICAgdGhpcy5hbGVydHNUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6ICdkZXZpY2UtaW5kZXgnLFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdkZXZpY2VfdWlkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnY3JlYXRlZF9hdCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSLFxuICAgICAgfSxcbiAgICAgIHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgfSk7XG5cbiAgICAvLyBHU0kgZm9yIHF1ZXJ5aW5nIGFjdGl2ZSAodW5hY2tub3dsZWRnZWQpIGFsZXJ0c1xuICAgIHRoaXMuYWxlcnRzVGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xuICAgICAgaW5kZXhOYW1lOiAnc3RhdHVzLWluZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnYWNrbm93bGVkZ2VkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnY3JlYXRlZF9hdCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSLFxuICAgICAgfSxcbiAgICAgIHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIER5bmFtb0RCIFRhYmxlIGZvciBTZXR0aW5ncyAoRmxlZXQgRGVmYXVsdHMpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLnNldHRpbmdzVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgJ1NldHRpbmdzVGFibGUnLCB7XG4gICAgICB0YWJsZU5hbWU6ICdzb25nYmlyZC1zZXR0aW5ncycsXG5cbiAgICAgIC8vIENvbXBvc2l0ZSBwcmltYXJ5IGtleTogc2V0dGluZ190eXBlICsgc2V0dGluZ19pZFxuICAgICAgLy8gZS5nLiwgc2V0dGluZ190eXBlPVwiZmxlZXRfZGVmYXVsdHNcIiwgc2V0dGluZ19pZD08ZmxlZXRfdWlkPlxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdzZXR0aW5nX3R5cGUnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBzb3J0S2V5OiB7XG4gICAgICAgIG5hbWU6ICdzZXR0aW5nX2lkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuXG4gICAgICAvLyBCaWxsaW5nIG1vZGUgLSBvbi1kZW1hbmQgZm9yIHVucHJlZGljdGFibGUgdXNhZ2VcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG5cbiAgICAgIC8vIFJlbW92ZSB0YWJsZSBvbiBzdGFjayBkZWxldGlvbiAoZGVtbyBlbnZpcm9ubWVudClcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIER5bmFtb0RCIFRhYmxlIGZvciBKb3VybmV5cyAoR1BTIHRyYWNraW5nIGpvdXJuZXlzKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5qb3VybmV5c1RhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdKb3VybmV5c1RhYmxlJywge1xuICAgICAgdGFibGVOYW1lOiAnc29uZ2JpcmQtam91cm5leXMnLFxuXG4gICAgICAvLyBDb21wb3NpdGUgcHJpbWFyeSBrZXk6IGRldmljZV91aWQgKyBqb3VybmV5X2lkIChVbml4IHRpbWVzdGFtcClcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnZGV2aWNlX3VpZCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIHNvcnRLZXk6IHtcbiAgICAgICAgbmFtZTogJ2pvdXJuZXlfaWQnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLk5VTUJFUixcbiAgICAgIH0sXG5cbiAgICAgIC8vIEJpbGxpbmcgbW9kZSAtIG9uLWRlbWFuZCBmb3IgdW5wcmVkaWN0YWJsZSB1c2FnZVxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcblxuICAgICAgLy8gUmVtb3ZlIHRhYmxlIG9uIHN0YWNrIGRlbGV0aW9uIChkZW1vIGVudmlyb25tZW50KVxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcblxuICAgICAgLy8gVFRMIHRvIGF1dG9tYXRpY2FsbHkgZGVsZXRlIG9sZCBqb3VybmV5cyAoOTAgZGF5cylcbiAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6ICd0dGwnLFxuXG4gICAgICAvLyBFbmFibGUgc3RyZWFtcyBmb3IgcmVhbC10aW1lIHN5bmMgdG8gQXVyb3JhIEFuYWx5dGljc1xuICAgICAgc3RyZWFtOiBkeW5hbW9kYi5TdHJlYW1WaWV3VHlwZS5ORVdfQU5EX09MRF9JTUFHRVMsXG4gICAgfSk7XG5cbiAgICAvLyBHU0kgZm9yIHF1ZXJ5aW5nIGFjdGl2ZSBqb3VybmV5cyBhY3Jvc3MgYWxsIGRldmljZXNcbiAgICB0aGlzLmpvdXJuZXlzVGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xuICAgICAgaW5kZXhOYW1lOiAnc3RhdHVzLWluZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnc3RhdHVzJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnc3RhcnRfdGltZScsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSLFxuICAgICAgfSxcbiAgICAgIHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIER5bmFtb0RCIFRhYmxlIGZvciBMb2NhdGlvbiBIaXN0b3J5IChhbGwgbG9jYXRpb24gc291cmNlcylcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMubG9jYXRpb25zVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgJ0xvY2F0aW9uc1RhYmxlJywge1xuICAgICAgdGFibGVOYW1lOiAnc29uZ2JpcmQtbG9jYXRpb25zJyxcblxuICAgICAgLy8gQ29tcG9zaXRlIHByaW1hcnkga2V5OiBkZXZpY2VfdWlkICsgdGltZXN0YW1wXG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogJ2RldmljZV91aWQnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBzb3J0S2V5OiB7XG4gICAgICAgIG5hbWU6ICd0aW1lc3RhbXAnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLk5VTUJFUixcbiAgICAgIH0sXG5cbiAgICAgIC8vIEJpbGxpbmcgbW9kZSAtIG9uLWRlbWFuZCBmb3IgdW5wcmVkaWN0YWJsZSB1c2FnZVxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcblxuICAgICAgLy8gUmVtb3ZlIHRhYmxlIG9uIHN0YWNrIGRlbGV0aW9uIChkZW1vIGVudmlyb25tZW50KVxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcblxuICAgICAgLy8gVFRMIHRvIGF1dG9tYXRpY2FsbHkgZGVsZXRlIG9sZCBsb2NhdGlvbnMgKDkwIGRheXMpXG4gICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiAndHRsJyxcblxuICAgICAgLy8gRW5hYmxlIHN0cmVhbXMgZm9yIHJlYWwtdGltZSBzeW5jIHRvIEF1cm9yYSBBbmFseXRpY3NcbiAgICAgIHN0cmVhbTogZHluYW1vZGIuU3RyZWFtVmlld1R5cGUuTkVXX0FORF9PTERfSU1BR0VTLFxuICAgIH0pO1xuXG4gICAgLy8gR1NJIGZvciBxdWVyeWluZyBsb2NhdGlvbnMgYnkgam91cm5leVxuICAgIHRoaXMubG9jYXRpb25zVGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xuICAgICAgaW5kZXhOYW1lOiAnam91cm5leS1pbmRleCcsXG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogJ2RldmljZV91aWQnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBzb3J0S2V5OiB7XG4gICAgICAgIG5hbWU6ICdqb3VybmV5X2lkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5OVU1CRVIsXG4gICAgICB9LFxuICAgICAgcHJvamVjdGlvblR5cGU6IGR5bmFtb2RiLlByb2plY3Rpb25UeXBlLkFMTCxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRHluYW1vREIgVGFibGUgZm9yIERldmljZSBBbGlhc2VzIChzZXJpYWxfbnVtYmVyIC0+IGRldmljZV91aWQgbWFwcGluZylcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFRoaXMgdGFibGUgZW5hYmxlcyBOb3RlY2FyZCBzd2FwcGluZzogd2hlbiBhIE5vdGVjYXJkIGlzIHJlcGxhY2VkLFxuICAgIC8vIHRoZSBzZXJpYWxfbnVtYmVyIHJlbWFpbnMgc3RhYmxlIHdoaWxlIGRldmljZV91aWQgY2hhbmdlcy5cbiAgICAvLyBBbGwgaGlzdG9yaWNhbCBkYXRhIGlzIHByZXNlcnZlZCBhbmQgbWVyZ2VkIHVzaW5nIHRoaXMgbWFwcGluZy5cbiAgICB0aGlzLmRldmljZUFsaWFzZXNUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCAnRGV2aWNlQWxpYXNlc1RhYmxlJywge1xuICAgICAgdGFibGVOYW1lOiAnc29uZ2JpcmQtZGV2aWNlLWFsaWFzZXMnLFxuXG4gICAgICAvLyBQcmltYXJ5IGtleTogc2VyaWFsX251bWJlciAodGhlIHN0YWJsZSBkZXZpY2UgaWRlbnRpZmllcilcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnc2VyaWFsX251bWJlcicsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcblxuICAgICAgLy8gQmlsbGluZyBtb2RlIC0gb24tZGVtYW5kIGZvciB1bnByZWRpY3RhYmxlIHVzYWdlXG4gICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuXG4gICAgICAvLyBSZW1vdmUgdGFibGUgb24gc3RhY2sgZGVsZXRpb24gKGRlbW8gZW52aXJvbm1lbnQpXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIH0pO1xuXG4gICAgLy8gR1NJIGZvciBsb29raW5nIHVwIHNlcmlhbF9udW1iZXIgYnkgZGV2aWNlX3VpZFxuICAgIC8vIFVzZWQgd2hlbiB3ZSByZWNlaXZlIGFuIGV2ZW50IGFuZCBuZWVkIHRvIGZpbmQgdGhlIGFzc29jaWF0ZWQgc2VyaWFsX251bWJlclxuICAgIHRoaXMuZGV2aWNlQWxpYXNlc1RhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcbiAgICAgIGluZGV4TmFtZTogJ2RldmljZS11aWQtaW5kZXgnLFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdkZXZpY2VfdWlkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgcHJvamVjdGlvblR5cGU6IGR5bmFtb2RiLlByb2plY3Rpb25UeXBlLkFMTCxcbiAgICB9KTtcbiAgfVxufVxuIl19