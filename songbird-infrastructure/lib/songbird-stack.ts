/**
 * Songbird Main Stack
 *
 * Orchestrates all infrastructure constructs for the Songbird demo platform.
 */

import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
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
    // Storage Layer (DynamoDB for devices and telemetry)
    // ==========================================================================
    const storage = new StorageConstruct(this, 'Storage', {
      dynamoTableName: 'songbird-devices',
      telemetryTableName: 'songbird-telemetry',
    });

    // ==========================================================================
    // Authentication (Cognito)
    // ==========================================================================
    const auth = new AuthConstruct(this, 'Auth', {
      userPoolName: 'songbird-users',
    });

    // ==========================================================================
    // SNS Topic for Alerts (shared between API and IoT constructs)
    // ==========================================================================
    // Note: We import the existing topic created by the previous ApiConstruct deployment
    // rather than creating a new one to avoid name conflicts
    const alertTopic = sns.Topic.fromTopicArn(
      this,
      'AlertTopic',
      `arn:aws:sns:${this.region}:${this.account}:songbird-alerts`
    );

    // ==========================================================================
    // API Layer (API Gateway + Lambda)
    // ==========================================================================
    const api = new ApiConstruct(this, 'Api', {
      telemetryTable: storage.telemetryTable,
      devicesTable: storage.devicesTable,
      userPool: auth.userPool,
      userPoolClient: auth.userPoolClient,
      notehubProjectUid: props.notehubProjectUid,
      alertTopic,
    });

    // ==========================================================================
    // IoT Layer (IoT Core Rules + Lambda)
    // ==========================================================================
    const iot = new IotConstruct(this, 'Iot', {
      telemetryTable: storage.telemetryTable,
      devicesTable: storage.devicesTable,
      alertTopic,
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

    new cdk.CfnOutput(this, 'IoTRuleName', {
      value: iot.eventProcessingRule.ruleName!,
      description: 'IoT Core rule name for Notehub route configuration',
      exportName: 'SongbirdIoTRuleName',
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
