/**
 * Storage Construct
 *
 * Defines Timestream database/table for time-series telemetry data
 * and DynamoDB table for device metadata.
 */

import * as cdk from 'aws-cdk-lib';
import * as timestream from 'aws-cdk-lib/aws-timestream';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface StorageConstructProps {
  timestreamDatabaseName: string;
  timestreamTableName: string;
  dynamoTableName: string;
}

export class StorageConstruct extends Construct {
  public readonly timestreamDatabase: timestream.CfnDatabase;
  public readonly timestreamTable: timestream.CfnTable;
  public readonly devicesTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: StorageConstructProps) {
    super(scope, id);

    // ==========================================================================
    // Timestream Database
    // ==========================================================================
    this.timestreamDatabase = new timestream.CfnDatabase(this, 'Database', {
      databaseName: props.timestreamDatabaseName,
      tags: [{ key: 'Application', value: 'Songbird' }],
    });

    // ==========================================================================
    // Timestream Table for Telemetry Data
    // ==========================================================================
    this.timestreamTable = new timestream.CfnTable(this, 'TelemetryTable', {
      databaseName: props.timestreamDatabaseName,
      tableName: props.timestreamTableName,

      // Retention policy
      retentionProperties: {
        // Memory store retention: 24 hours (for real-time queries)
        memoryStoreRetentionPeriodInHours: '24',
        // Magnetic store retention: 90 days (for historical queries)
        magneticStoreRetentionPeriodInDays: '90',
      },

      // Enable magnetic store writes for late-arriving data
      magneticStoreWriteProperties: {
        enableMagneticStoreWrites: true,
      },

      // Schema definition (informational - Timestream is schema-on-write)
      // Dimensions: device_uid, serial_number, fleet, event_type
      // Measures: temperature, humidity, pressure, voltage, latitude, longitude, motion, mode

      tags: [{ key: 'Application', value: 'Songbird' }],
    });

    // Ensure table is created after database
    this.timestreamTable.addDependency(this.timestreamDatabase);

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
  }
}
