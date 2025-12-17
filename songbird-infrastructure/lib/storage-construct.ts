/**
 * Storage Construct
 *
 * Defines DynamoDB tables for device metadata and telemetry data.
 * (Timestream is no longer available to new AWS customers)
 */

import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface StorageConstructProps {
  dynamoTableName: string;
  telemetryTableName: string;
}

export class StorageConstruct extends Construct {
  public readonly devicesTable: dynamodb.Table;
  public readonly telemetryTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: StorageConstructProps) {
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
