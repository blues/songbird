/**
 * Songbird Main Stack
 *
 * Orchestrates all infrastructure constructs for the Songbird demo platform.
 */

import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { StorageConstruct } from './storage-construct';
import { ApiConstruct } from './api-construct';
import { DashboardConstruct } from './dashboard-construct';
import { AuthConstruct, PostConfirmationTrigger } from './auth-construct';
import { AnalyticsConstruct } from './analytics-construct';

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
    // SNS Topic for Alerts
    // ==========================================================================
    const alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: 'songbird-alerts',
      displayName: 'Songbird Alert Notifications',
    });

    // ==========================================================================
    // Analytics Layer (Aurora Serverless + Bedrock)
    // ==========================================================================
    const analytics = new AnalyticsConstruct(this, 'Analytics', {
      devicesTable: storage.devicesTable,
      telemetryTable: storage.telemetryTable,
      locationsTable: storage.locationsTable,
      alertsTable: storage.alertsTable,
      journeysTable: storage.journeysTable,
    });

    // ==========================================================================
    // API Layer (API Gateway + Lambda)
    // ==========================================================================
    const api = new ApiConstruct(this, 'Api', {
      telemetryTable: storage.telemetryTable,
      devicesTable: storage.devicesTable,
      alertsTable: storage.alertsTable,
      settingsTable: storage.settingsTable,
      journeysTable: storage.journeysTable,
      locationsTable: storage.locationsTable,
      deviceAliasesTable: storage.deviceAliasesTable,
      userPool: auth.userPool,
      userPoolClient: auth.userPoolClient,
      notehubProjectUid: props.notehubProjectUid,
      alertTopic,
    });

    // Add Analytics routes to API
    api.addAnalyticsRoutes(
      analytics.chatQueryLambda,
      analytics.chatHistoryLambda,
      analytics.listSessionsLambda,
      analytics.getSessionLambda,
      analytics.deleteSessionLambda
    );

    // ==========================================================================
    // Post-Confirmation Lambda Trigger (for self-signup with Viewer role)
    // Must be created after API construct to avoid circular dependencies
    // ==========================================================================
    new PostConfirmationTrigger(this, 'PostConfirmation', {
      userPool: auth.userPool,
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

    new cdk.CfnOutput(this, 'AnalyticsClusterEndpoint', {
      value: analytics.cluster.clusterEndpoint.hostname,
      description: 'Aurora Analytics cluster endpoint',
      exportName: 'SongbirdAnalyticsClusterEndpoint',
    });

    new cdk.CfnOutput(this, 'ChatHistoryTableName', {
      value: analytics.chatHistoryTable.tableName,
      description: 'Analytics chat history table name',
      exportName: 'SongbirdChatHistoryTable',
    });
  }
}
