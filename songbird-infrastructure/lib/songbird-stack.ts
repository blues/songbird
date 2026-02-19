/**
 * Songbird Main Stack
 *
 * Orchestrates all infrastructure constructs for the Songbird demo platform.
 */

import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'path';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { StorageConstruct } from './storage-construct';
import { ApiConstruct } from './api-construct';
import { DashboardConstruct } from './dashboard-construct';
import { AuthConstruct, PostConfirmationTrigger } from './auth-construct';
import { AnalyticsConstruct } from './analytics-construct';
import { ObservabilityConstruct } from './observability-construct';

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
    // Route53 Hosted Zone for songbird.live
    // ==========================================================================
    // Look up the existing hosted zone instead of creating a new one
    // This prevents creating duplicate zones on each deployment
    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: 'songbird.live',
    });

    // ==========================================================================
    // Observability Layer (Arize Phoenix on ECS Fargate)
    // ==========================================================================
    const observability = new ObservabilityConstruct(this, 'Observability', {
      vpc: analytics.vpc,
      domainName: 'phoenix.songbird.live',
      hostedZone: hostedZone,
    });

    // Configure analytics Lambda to send traces to Phoenix
    analytics.configurePhoenixTracing(observability.otlpEndpoint);
    observability.allowTracingFrom(analytics.chatQueryLambda);

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
      auditTable: storage.auditTable,
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
      analytics.deleteSessionLambda,
      analytics.rerunQueryLambda
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
      domainName: 'songbird.live',
      hostedZone: hostedZone,
    });

    // ==========================================================================
    // SES Email Identity (for alert emails)
    // ==========================================================================
    // Note: Email identity 'brandon@blues.com' must be verified in SES
    // The identity already exists and is managed outside of CDK
    // We just reference it here for documentation purposes

    // ==========================================================================
    // Alert Email Lambda
    // ==========================================================================
    const alertEmailLambda = new NodejsFunction(this, 'AlertEmailFunction', {
      functionName: 'songbird-alert-email',
      description: 'Sends email notifications for low battery alerts to device owners',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/alert-email/index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        DEVICES_TABLE: storage.devicesTable.tableName,
        ALERTS_TABLE: storage.alertsTable.tableName,
        SENDER_EMAIL: 'brandon@blues.com',
        DASHBOARD_URL: 'https://songbird.live',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });

    // Grant permissions to the alert email Lambda
    storage.devicesTable.grantReadData(alertEmailLambda);
    storage.alertsTable.grantReadWriteData(alertEmailLambda);

    // Grant permission to send emails via SES
    alertEmailLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'ses:FromAddress': 'brandon@blues.com',
        },
      },
    }));

    // Subscribe the email Lambda to the SNS alert topic
    alertTopic.addSubscription(new snsSubscriptions.LambdaSubscription(alertEmailLambda, {
      filterPolicy: {
        alert_type: sns.SubscriptionFilter.stringFilter({
          allowlist: ['low_battery'],
        }),
      },
    }));

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

    new cdk.CfnOutput(this, 'AlertEmailIdentity', {
      value: 'brandon@blues.com',
      description: 'SES email identity for alerts (must be verified)',
      exportName: 'SongbirdAlertEmailIdentity',
    });

    new cdk.CfnOutput(this, 'AlertEmailLambdaArn', {
      value: alertEmailLambda.functionArn,
      description: 'Alert email Lambda function ARN',
      exportName: 'SongbirdAlertEmailLambdaArn',
    });
  }
}
