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
  public readonly alertsTable: dynamodb.Table;
  public readonly settingsTable: dynamodb.Table;
  public readonly journeysTable: dynamodb.Table;
  public readonly locationsTable: dynamodb.Table;
  public readonly deviceAliasesTable: dynamodb.Table;

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
