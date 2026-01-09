/**
 * Analytics Construct
 *
 * Provides Text-to-SQL analytics powered by AWS Bedrock (Claude) and Aurora Serverless v2.
 * Includes real-time DynamoDB → Aurora sync via streams.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface AnalyticsConstructProps {
  devicesTable: dynamodb.Table;
  telemetryTable: dynamodb.Table;
  locationsTable: dynamodb.Table;
  alertsTable: dynamodb.Table;
  journeysTable: dynamodb.Table;
}

export class AnalyticsConstruct extends Construct {
  public readonly cluster: rds.DatabaseCluster;
  public readonly chatHistoryTable: dynamodb.Table;
  public readonly chatQueryLambda: lambda.Function;
  public readonly chatHistoryLambda: lambda.Function;

  constructor(scope: Construct, id: string, props: AnalyticsConstructProps) {
    super(scope, id);

    // ==========================================================================
    // VPC for Aurora Serverless v2
    // ==========================================================================
    const vpc = new ec2.Vpc(this, 'AnalyticsVpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 28,
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // ==========================================================================
    // Aurora Serverless v2 Cluster
    // ==========================================================================
    this.cluster = new rds.DatabaseCluster(this, 'AnalyticsCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      writer: rds.ClusterInstance.serverlessV2('writer', {
        autoMinorVersionUpgrade: true,
      }),
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 4,
      defaultDatabaseName: 'songbird_analytics',
      enableDataApi: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      storageEncrypted: true,
      backup: {
        retention: cdk.Duration.days(7),
        preferredWindow: '03:00-04:00',
      },
    });

    // ==========================================================================
    // DynamoDB Table for Chat History
    // ==========================================================================
    this.chatHistoryTable = new dynamodb.Table(this, 'ChatHistoryTable', {
      tableName: 'songbird-chat-history',
      partitionKey: {
        name: 'user_email',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    // GSI for querying by session
    this.chatHistoryTable.addGlobalSecondaryIndex({
      indexName: 'session-index',
      partitionKey: {
        name: 'session_id',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ==========================================================================
    // Lambda: Schema Initialization
    // ==========================================================================
    const initSchemaLambda = new NodejsFunction(this, 'InitSchemaLambda', {
      functionName: 'songbird-analytics-init-schema',
      description: 'Initialize Aurora analytics schema',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/analytics/init-schema.ts'),
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        CLUSTER_ARN: this.cluster.clusterArn,
        SECRET_ARN: this.cluster.secret!.secretArn,
        DATABASE_NAME: 'songbird_analytics',
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });

    this.cluster.grantDataApiAccess(initSchemaLambda);

    // ==========================================================================
    // Lambda: DynamoDB → Aurora Sync
    // ==========================================================================
    const syncLambda = new NodejsFunction(this, 'SyncLambda', {
      functionName: 'songbird-analytics-sync',
      description: 'Sync DynamoDB streams to Aurora',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/analytics/sync-to-aurora.ts'),
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        CLUSTER_ARN: this.cluster.clusterArn,
        SECRET_ARN: this.cluster.secret!.secretArn,
        DATABASE_NAME: 'songbird_analytics',
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    this.cluster.grantDataApiAccess(syncLambda);

    // Add DynamoDB stream sources
    syncLambda.addEventSource(new DynamoEventSource(props.devicesTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 100,
      bisectBatchOnError: true,
      retryAttempts: 3,
    }));

    syncLambda.addEventSource(new DynamoEventSource(props.telemetryTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 100,
      bisectBatchOnError: true,
      retryAttempts: 3,
    }));

    syncLambda.addEventSource(new DynamoEventSource(props.locationsTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 100,
      bisectBatchOnError: true,
      retryAttempts: 3,
    }));

    syncLambda.addEventSource(new DynamoEventSource(props.alertsTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 100,
      bisectBatchOnError: true,
      retryAttempts: 3,
    }));

    syncLambda.addEventSource(new DynamoEventSource(props.journeysTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 100,
      bisectBatchOnError: true,
      retryAttempts: 3,
    }));

    // ==========================================================================
    // Lambda: Chat Query (Text-to-SQL)
    // ==========================================================================
    this.chatQueryLambda = new NodejsFunction(this, 'ChatQueryLambda', {
      functionName: 'songbird-analytics-chat-query',
      description: 'Analytics chat query with Bedrock',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/analytics/chat-query.ts'),
      timeout: cdk.Duration.seconds(60),
      memorySize: 1024,
      environment: {
        CLUSTER_ARN: this.cluster.clusterArn,
        SECRET_ARN: this.cluster.secret!.secretArn,
        DATABASE_NAME: 'songbird_analytics',
        CHAT_HISTORY_TABLE: this.chatHistoryTable.tableName,
        BEDROCK_MODEL_ID: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    this.cluster.grantDataApiAccess(this.chatQueryLambda);
    this.chatHistoryTable.grantReadWriteData(this.chatQueryLambda);

    // Grant Bedrock access
    this.chatQueryLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    }));

    // ==========================================================================
    // Lambda: Chat History
    // ==========================================================================
    this.chatHistoryLambda = new NodejsFunction(this, 'ChatHistoryLambda', {
      functionName: 'songbird-analytics-chat-history',
      description: 'Retrieve analytics chat history',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/analytics/chat-history.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        CHAT_HISTORY_TABLE: this.chatHistoryTable.tableName,
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });

    this.chatHistoryTable.grantReadData(this.chatHistoryLambda);

    // ==========================================================================
    // Lambda: Backfill (one-time historical data migration)
    // ==========================================================================
    const backfillLambda = new NodejsFunction(this, 'BackfillLambda', {
      functionName: 'songbird-analytics-backfill',
      description: 'Backfill historical DynamoDB data to Aurora',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/analytics/backfill.ts'),
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: {
        CLUSTER_ARN: this.cluster.clusterArn,
        SECRET_ARN: this.cluster.secret!.secretArn,
        DATABASE_NAME: 'songbird_analytics',
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });

    this.cluster.grantDataApiAccess(backfillLambda);
    props.devicesTable.grantReadData(backfillLambda);
    props.telemetryTable.grantReadData(backfillLambda);
    props.locationsTable.grantReadData(backfillLambda);
    props.alertsTable.grantReadData(backfillLambda);
    props.journeysTable.grantReadData(backfillLambda);

    // ==========================================================================
    // Outputs
    // ==========================================================================
    new cdk.CfnOutput(this, 'ClusterEndpoint', {
      value: this.cluster.clusterEndpoint.hostname,
      description: 'Aurora Analytics cluster endpoint',
    });

    new cdk.CfnOutput(this, 'SecretArn', {
      value: this.cluster.secret!.secretArn,
      description: 'Aurora credentials secret ARN',
    });
  }
}
