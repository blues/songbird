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
    }
}
exports.StorageConstruct = StorageConstruct;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RvcmFnZS1jb25zdHJ1Y3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvc3RvcmFnZS1jb25zdHJ1Y3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7OztHQUtHOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUVILGlEQUFtQztBQUNuQyxtRUFBcUQ7QUFDckQsMkNBQXVDO0FBT3ZDLE1BQWEsZ0JBQWlCLFNBQVEsc0JBQVM7SUFDN0IsWUFBWSxDQUFpQjtJQUM3QixjQUFjLENBQWlCO0lBRS9DLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBNEI7UUFDcEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQiw2RUFBNkU7UUFDN0UscUNBQXFDO1FBQ3JDLDZFQUE2RTtRQUM3RSxJQUFJLENBQUMsWUFBWSxHQUFHLElBQUksUUFBUSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFO1lBQzNELFNBQVMsRUFBRSxLQUFLLENBQUMsZUFBZTtZQUVoQyxjQUFjO1lBQ2QsWUFBWSxFQUFFO2dCQUNaLElBQUksRUFBRSxZQUFZO2dCQUNsQixJQUFJLEVBQUUsUUFBUSxDQUFDLGFBQWEsQ0FBQyxNQUFNO2FBQ3BDO1lBRUQsd0RBQXdEO1lBQ3hELFdBQVcsRUFBRSxRQUFRLENBQUMsV0FBVyxDQUFDLGVBQWU7WUFFakQsZ0NBQWdDO1lBQ2hDLG1CQUFtQixFQUFFLElBQUk7WUFFekIsb0RBQW9EO1lBQ3BELGFBQWEsRUFBRSxHQUFHLENBQUMsYUFBYSxDQUFDLE9BQU87WUFFeEMsaURBQWlEO1lBQ2pELE1BQU0sRUFBRSxRQUFRLENBQUMsY0FBYyxDQUFDLGtCQUFrQjtTQUNuRCxDQUFDLENBQUM7UUFFSCw0QkFBNEI7UUFDNUIsSUFBSSxDQUFDLFlBQVksQ0FBQyx1QkFBdUIsQ0FBQztZQUN4QyxTQUFTLEVBQUUsYUFBYTtZQUN4QixZQUFZLEVBQUU7Z0JBQ1osSUFBSSxFQUFFLE9BQU87Z0JBQ2IsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTTthQUNwQztZQUNELE9BQU8sRUFBRTtnQkFDUCxJQUFJLEVBQUUsV0FBVztnQkFDakIsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTTthQUNwQztZQUNELGNBQWMsRUFBRSxRQUFRLENBQUMsY0FBYyxDQUFDLEdBQUc7U0FDNUMsQ0FBQyxDQUFDO1FBRUgsNkJBQTZCO1FBQzdCLElBQUksQ0FBQyxZQUFZLENBQUMsdUJBQXVCLENBQUM7WUFDeEMsU0FBUyxFQUFFLGNBQWM7WUFDekIsWUFBWSxFQUFFO2dCQUNaLElBQUksRUFBRSxRQUFRO2dCQUNkLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU07YUFDcEM7WUFDRCxPQUFPLEVBQUU7Z0JBQ1AsSUFBSSxFQUFFLFdBQVc7Z0JBQ2pCLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU07YUFDcEM7WUFDRCxjQUFjLEVBQUUsUUFBUSxDQUFDLGNBQWMsQ0FBQyxHQUFHO1NBQzVDLENBQUMsQ0FBQztRQUVILDZFQUE2RTtRQUM3RSxvQ0FBb0M7UUFDcEMsNkVBQTZFO1FBQzdFLElBQUksQ0FBQyxjQUFjLEdBQUcsSUFBSSxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtZQUMvRCxTQUFTLEVBQUUsS0FBSyxDQUFDLGtCQUFrQjtZQUVuQyxnREFBZ0Q7WUFDaEQsWUFBWSxFQUFFO2dCQUNaLElBQUksRUFBRSxZQUFZO2dCQUNsQixJQUFJLEVBQUUsUUFBUSxDQUFDLGFBQWEsQ0FBQyxNQUFNO2FBQ3BDO1lBQ0QsT0FBTyxFQUFFO2dCQUNQLElBQUksRUFBRSxXQUFXO2dCQUNqQixJQUFJLEVBQUUsUUFBUSxDQUFDLGFBQWEsQ0FBQyxNQUFNO2FBQ3BDO1lBRUQsd0RBQXdEO1lBQ3hELFdBQVcsRUFBRSxRQUFRLENBQUMsV0FBVyxDQUFDLGVBQWU7WUFFakQsb0RBQW9EO1lBQ3BELGFBQWEsRUFBRSxHQUFHLENBQUMsYUFBYSxDQUFDLE9BQU87WUFFeEMsc0RBQXNEO1lBQ3RELG1CQUFtQixFQUFFLEtBQUs7U0FDM0IsQ0FBQyxDQUFDO1FBRUgsaUNBQWlDO1FBQ2pDLElBQUksQ0FBQyxjQUFjLENBQUMsdUJBQXVCLENBQUM7WUFDMUMsU0FBUyxFQUFFLGtCQUFrQjtZQUM3QixZQUFZLEVBQUU7Z0JBQ1osSUFBSSxFQUFFLFlBQVk7Z0JBQ2xCLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU07YUFDcEM7WUFDRCxPQUFPLEVBQUU7Z0JBQ1AsSUFBSSxFQUFFLHNCQUFzQjtnQkFDNUIsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTTthQUNwQztZQUNELGNBQWMsRUFBRSxRQUFRLENBQUMsY0FBYyxDQUFDLEdBQUc7U0FDNUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBcEdELDRDQW9HQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU3RvcmFnZSBDb25zdHJ1Y3RcbiAqXG4gKiBEZWZpbmVzIER5bmFtb0RCIHRhYmxlcyBmb3IgZGV2aWNlIG1ldGFkYXRhIGFuZCB0ZWxlbWV0cnkgZGF0YS5cbiAqIChUaW1lc3RyZWFtIGlzIG5vIGxvbmdlciBhdmFpbGFibGUgdG8gbmV3IEFXUyBjdXN0b21lcnMpXG4gKi9cblxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gJ2F3cy1jZGstbGliL2F3cy1keW5hbW9kYic7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcblxuZXhwb3J0IGludGVyZmFjZSBTdG9yYWdlQ29uc3RydWN0UHJvcHMge1xuICBkeW5hbW9UYWJsZU5hbWU6IHN0cmluZztcbiAgdGVsZW1ldHJ5VGFibGVOYW1lOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBTdG9yYWdlQ29uc3RydWN0IGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGRldmljZXNUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSB0ZWxlbWV0cnlUYWJsZTogZHluYW1vZGIuVGFibGU7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IFN0b3JhZ2VDb25zdHJ1Y3RQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIER5bmFtb0RCIFRhYmxlIGZvciBEZXZpY2UgTWV0YWRhdGFcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuZGV2aWNlc1RhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdEZXZpY2VzVGFibGUnLCB7XG4gICAgICB0YWJsZU5hbWU6IHByb3BzLmR5bmFtb1RhYmxlTmFtZSxcblxuICAgICAgLy8gUHJpbWFyeSBrZXlcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnZGV2aWNlX3VpZCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcblxuICAgICAgLy8gQmlsbGluZyBtb2RlIC0gb24tZGVtYW5kIGZvciB1bnByZWRpY3RhYmxlIGRlbW8gdXNhZ2VcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG5cbiAgICAgIC8vIEVuYWJsZSBwb2ludC1pbi10aW1lIHJlY292ZXJ5XG4gICAgICBwb2ludEluVGltZVJlY292ZXJ5OiB0cnVlLFxuXG4gICAgICAvLyBSZW1vdmUgdGFibGUgb24gc3RhY2sgZGVsZXRpb24gKGRlbW8gZW52aXJvbm1lbnQpXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuXG4gICAgICAvLyBFbmFibGUgc3RyZWFtcyBmb3IgZnV0dXJlIGV2ZW50LWRyaXZlbiB1cGRhdGVzXG4gICAgICBzdHJlYW06IGR5bmFtb2RiLlN0cmVhbVZpZXdUeXBlLk5FV19BTkRfT0xEX0lNQUdFUyxcbiAgICB9KTtcblxuICAgIC8vIEdTSSBmb3IgcXVlcnlpbmcgYnkgZmxlZXRcbiAgICB0aGlzLmRldmljZXNUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6ICdmbGVldC1pbmRleCcsXG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogJ2ZsZWV0JyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnbGFzdF9zZWVuJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5OVU1CRVIsXG4gICAgICB9LFxuICAgICAgcHJvamVjdGlvblR5cGU6IGR5bmFtb2RiLlByb2plY3Rpb25UeXBlLkFMTCxcbiAgICB9KTtcblxuICAgIC8vIEdTSSBmb3IgcXVlcnlpbmcgYnkgc3RhdHVzXG4gICAgdGhpcy5kZXZpY2VzVGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xuICAgICAgaW5kZXhOYW1lOiAnc3RhdHVzLWluZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnc3RhdHVzJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnbGFzdF9zZWVuJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5OVU1CRVIsXG4gICAgICB9LFxuICAgICAgcHJvamVjdGlvblR5cGU6IGR5bmFtb2RiLlByb2plY3Rpb25UeXBlLkFMTCxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRHluYW1vREIgVGFibGUgZm9yIFRlbGVtZXRyeSBEYXRhXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLnRlbGVtZXRyeVRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdUZWxlbWV0cnlUYWJsZScsIHtcbiAgICAgIHRhYmxlTmFtZTogcHJvcHMudGVsZW1ldHJ5VGFibGVOYW1lLFxuXG4gICAgICAvLyBDb21wb3NpdGUgcHJpbWFyeSBrZXk6IGRldmljZV91aWQgKyB0aW1lc3RhbXBcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnZGV2aWNlX3VpZCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIHNvcnRLZXk6IHtcbiAgICAgICAgbmFtZTogJ3RpbWVzdGFtcCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSLFxuICAgICAgfSxcblxuICAgICAgLy8gQmlsbGluZyBtb2RlIC0gb24tZGVtYW5kIGZvciB1bnByZWRpY3RhYmxlIGRlbW8gdXNhZ2VcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG5cbiAgICAgIC8vIFJlbW92ZSB0YWJsZSBvbiBzdGFjayBkZWxldGlvbiAoZGVtbyBlbnZpcm9ubWVudClcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG5cbiAgICAgIC8vIFRUTCB0byBhdXRvbWF0aWNhbGx5IGRlbGV0ZSBvbGQgdGVsZW1ldHJ5ICg5MCBkYXlzKVxuICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogJ3R0bCcsXG4gICAgfSk7XG5cbiAgICAvLyBHU0kgZm9yIHF1ZXJ5aW5nIGJ5IGV2ZW50IHR5cGVcbiAgICB0aGlzLnRlbGVtZXRyeVRhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcbiAgICAgIGluZGV4TmFtZTogJ2V2ZW50LXR5cGUtaW5kZXgnLFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdkZXZpY2VfdWlkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAnZXZlbnRfdHlwZV90aW1lc3RhbXAnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgIH0pO1xuICB9XG59XG4iXX0=