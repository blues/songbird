/**
 * Songbird Main Stack
 *
 * Orchestrates all infrastructure constructs for the Songbird demo platform.
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { StorageConstruct } from './storage-construct';
import { IotConstruct } from './iot-construct';
import { ApiConstruct } from './api-construct';
import { DashboardConstruct } from './dashboard-construct';
import { AuthConstruct } from './auth-construct';

export interface SongbirdStackProps extends cdk.StackProps {
  notehubProjectUid: string;
}

export class SongbirdStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SongbirdStackProps) {
    super(scope, id, props);

    // ==========================================================================
    // Storage Layer (Timestream + DynamoDB)
    // ==========================================================================
    const storage = new StorageConstruct(this, 'Storage', {
      timestreamDatabaseName: 'songbird',
      timestreamTableName: 'telemetry',
      dynamoTableName: 'songbird-devices',
    });

    // ==========================================================================
    // Authentication (Cognito)
    // ==========================================================================
    const auth = new AuthConstruct(this, 'Auth', {
      userPoolName: 'songbird-users',
    });

    // ==========================================================================
    // API Layer (API Gateway + Lambda)
    // ==========================================================================
    const api = new ApiConstruct(this, 'Api', {
      timestreamDatabase: storage.timestreamDatabase,
      timestreamTable: storage.timestreamTable,
      devicesTable: storage.devicesTable,
      userPool: auth.userPool,
      notehubProjectUid: props.notehubProjectUid,
    });

    // ==========================================================================
    // IoT Layer (IoT Core Rules + Lambda)
    // ==========================================================================
    const iot = new IotConstruct(this, 'Iot', {
      timestreamDatabase: storage.timestreamDatabase,
      timestreamTable: storage.timestreamTable,
      devicesTable: storage.devicesTable,
      alertTopic: api.alertTopic,
    });

    // ==========================================================================
    // Dashboard Hosting (S3 + CloudFront)
    // ==========================================================================
    const dashboard = new DashboardConstruct(this, 'Dashboard', {
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
      value: iot.eventProcessingRule.ruleName!,
      description: 'IoT Core rule name for Notehub route configuration',
      exportName: 'SongbirdIoTRuleName',
    });

    new cdk.CfnOutput(this, 'TimestreamDatabase', {
      value: storage.timestreamDatabase.databaseName!,
      description: 'Timestream database name',
      exportName: 'SongbirdTimestreamDatabase',
    });

    new cdk.CfnOutput(this, 'DevicesTableName', {
      value: storage.devicesTable.tableName,
      description: 'DynamoDB devices table name',
      exportName: 'SongbirdDevicesTable',
    });
  }
}
