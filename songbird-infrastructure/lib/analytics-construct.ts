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
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
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
  public readonly listSessionsLambda: lambda.Function;
  public readonly getSessionLambda: lambda.Function;
  public readonly deleteSessionLambda: lambda.Function;
  public readonly rerunQueryLambda: lambda.Function;
  public readonly vpc: ec2.Vpc;
  private syncLambda?: lambda.Function;

  constructor(scope: Construct, id: string, props: AnalyticsConstructProps) {
    super(scope, id);

    // ==========================================================================
    // VPC for Aurora Serverless v2
    // ==========================================================================
    this.vpc = new ec2.Vpc(this, 'AnalyticsVpc', {
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
      vpc: this.vpc,
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
    this.syncLambda = new NodejsFunction(this, 'SyncLambda', {
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
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    this.cluster.grantDataApiAccess(this.syncLambda);

    // Add DynamoDB stream sources
    this.syncLambda.addEventSource(new DynamoEventSource(props.devicesTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 100,
      bisectBatchOnError: true,
      retryAttempts: 3,
    }));

    this.syncLambda.addEventSource(new DynamoEventSource(props.telemetryTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 100,
      bisectBatchOnError: true,
      retryAttempts: 3,
    }));

    this.syncLambda.addEventSource(new DynamoEventSource(props.locationsTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 100,
      bisectBatchOnError: true,
      retryAttempts: 3,
    }));

    this.syncLambda.addEventSource(new DynamoEventSource(props.alertsTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 100,
      bisectBatchOnError: true,
      retryAttempts: 3,
    }));

    this.syncLambda.addEventSource(new DynamoEventSource(props.journeysTable, {
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
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    this.cluster.grantDataApiAccess(this.chatQueryLambda);
    this.chatHistoryTable.grantReadWriteData(this.chatQueryLambda);

    // Grant Bedrock access (includes Marketplace permissions for first-time model invocation)
    this.chatQueryLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    }));
    this.chatQueryLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['aws-marketplace:ViewSubscriptions', 'aws-marketplace:Subscribe'],
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
    // Lambda: List Sessions
    // ==========================================================================
    this.listSessionsLambda = new NodejsFunction(this, 'ListSessionsLambda', {
      functionName: 'songbird-analytics-list-sessions',
      description: 'List analytics chat sessions',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/analytics/list-sessions.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        CHAT_HISTORY_TABLE: this.chatHistoryTable.tableName,
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });

    this.chatHistoryTable.grantReadData(this.listSessionsLambda);

    // ==========================================================================
    // Lambda: Get Session
    // ==========================================================================
    this.getSessionLambda = new NodejsFunction(this, 'GetSessionLambda', {
      functionName: 'songbird-analytics-get-session',
      description: 'Get analytics chat session details',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/analytics/get-session.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        CHAT_HISTORY_TABLE: this.chatHistoryTable.tableName,
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });

    this.chatHistoryTable.grantReadData(this.getSessionLambda);

    // ==========================================================================
    // Lambda: Delete Session
    // ==========================================================================
    this.deleteSessionLambda = new NodejsFunction(this, 'DeleteSessionLambda', {
      functionName: 'songbird-analytics-delete-session',
      description: 'Delete analytics chat session',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/analytics/delete-session.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        CHAT_HISTORY_TABLE: this.chatHistoryTable.tableName,
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });

    this.chatHistoryTable.grantReadWriteData(this.deleteSessionLambda);

    // ==========================================================================
    // Lambda: Rerun Query (re-execute stored SQL for visualizations)
    // ==========================================================================
    this.rerunQueryLambda = new NodejsFunction(this, 'RerunQueryLambda', {
      functionName: 'songbird-analytics-rerun-query',
      description: 'Re-execute stored SQL query for visualizations',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/analytics/rerun-query.ts'),
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        CLUSTER_ARN: this.cluster.clusterArn,
        SECRET_ARN: this.cluster.secret!.secretArn,
        DATABASE_NAME: 'songbird_analytics',
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    this.cluster.grantDataApiAccess(this.rerunQueryLambda);

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
    // Lambda: Daily Evaluation
    // ==========================================================================
    const dailyEvaluationLambda = new NodejsFunction(this, 'DailyEvaluationLambda', {
      functionName: 'songbird-analytics-daily-evaluation',
      description: 'Run daily evaluations on analytics queries',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/analytics/daily-evaluation.ts'),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        CHAT_HISTORY_TABLE: this.chatHistoryTable.tableName,
      },
      bundling: { minify: true, sourceMap: true },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });

    this.chatHistoryTable.grantReadData(dailyEvaluationLambda);

    // Grant Bedrock access for LLM-based evaluations
    dailyEvaluationLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    }));

    // Schedule to run daily at 8am UTC
    const evaluationRule = new events.Rule(this, 'DailyEvaluationRule', {
      schedule: events.Schedule.cron({ hour: '8', minute: '0' }),
      description: 'Trigger daily analytics evaluation',
    });

    evaluationRule.addTarget(new targets.LambdaFunction(dailyEvaluationLambda));

    // ==========================================================================
    // CloudWatch Metric Filters (extract metrics from evaluation Lambda logs)
    // ==========================================================================
    const evalLogGroup = dailyEvaluationLambda.logGroup;

    const syntaxValidMetric = new logs.MetricFilter(this, 'SyntaxValidRateMetric', {
      logGroup: evalLogGroup,
      filterPattern: logs.FilterPattern.literal('{ $.metric = "EvaluationReport" }'),
      metricNamespace: 'Songbird/Analytics',
      metricName: 'SyntaxValidRate',
      metricValue: '$.syntaxValidRate',
      defaultValue: 0,
    });

    const executionSuccessMetric = new logs.MetricFilter(this, 'ExecutionSuccessRateMetric', {
      logGroup: evalLogGroup,
      filterPattern: logs.FilterPattern.literal('{ $.metric = "EvaluationReport" }'),
      metricNamespace: 'Songbird/Analytics',
      metricName: 'ExecutionSuccessRate',
      metricValue: '$.executionSuccessRate',
      defaultValue: 0,
    });

    const insightRelevanceMetric = new logs.MetricFilter(this, 'InsightRelevanceMetric', {
      logGroup: evalLogGroup,
      filterPattern: logs.FilterPattern.literal('{ $.metric = "EvaluationReport" }'),
      metricNamespace: 'Songbird/Analytics',
      metricName: 'AvgInsightRelevance',
      metricValue: '$.avgInsightRelevance',
      defaultValue: 0,
    });

    const hallucinationMetric = new logs.MetricFilter(this, 'HallucinationScoreMetric', {
      logGroup: evalLogGroup,
      filterPattern: logs.FilterPattern.literal('{ $.metric = "EvaluationReport" }'),
      metricNamespace: 'Songbird/Analytics',
      metricName: 'AvgHallucinationScore',
      metricValue: '$.avgHallucinationScore',
      defaultValue: 0,
    });

    const totalQueriesMetric = new logs.MetricFilter(this, 'TotalQueriesMetric', {
      logGroup: evalLogGroup,
      filterPattern: logs.FilterPattern.literal('{ $.metric = "EvaluationReport" }'),
      metricNamespace: 'Songbird/Analytics',
      metricName: 'TotalQueriesEvaluated',
      metricValue: '$.totalQueries',
      defaultValue: 0,
    });

    const llmEvaluatedMetric = new logs.MetricFilter(this, 'LLMEvaluatedMetric', {
      logGroup: evalLogGroup,
      filterPattern: logs.FilterPattern.literal('{ $.metric = "EvaluationReport" }'),
      metricNamespace: 'Songbird/Analytics',
      metricName: 'LLMEvaluatedCount',
      metricValue: '$.llmEvaluatedCount',
      defaultValue: 0,
    });

    // ==========================================================================
    // CloudWatch Dashboard
    // ==========================================================================
    const dashboard = new cloudwatch.Dashboard(this, 'AnalyticsDashboard', {
      dashboardName: 'Songbird-Analytics',
      periodOverride: cloudwatch.PeriodOverride.AUTO,
    });

    // -- Row 1: Evaluation Quality Scores --
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Evaluation Quality Scores',
        width: 12,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'Songbird/Analytics',
            metricName: 'SyntaxValidRate',
            statistic: 'Maximum',
            label: 'SQL Syntax Valid Rate',
            period: cdk.Duration.days(1),
          }),
          new cloudwatch.Metric({
            namespace: 'Songbird/Analytics',
            metricName: 'ExecutionSuccessRate',
            statistic: 'Maximum',
            label: 'Execution Success Rate',
            period: cdk.Duration.days(1),
          }),
          new cloudwatch.Metric({
            namespace: 'Songbird/Analytics',
            metricName: 'AvgInsightRelevance',
            statistic: 'Maximum',
            label: 'Avg Insight Relevance',
            period: cdk.Duration.days(1),
          }),
          new cloudwatch.Metric({
            namespace: 'Songbird/Analytics',
            metricName: 'AvgHallucinationScore',
            statistic: 'Maximum',
            label: 'Avg Hallucination Score (higher=better)',
            period: cdk.Duration.days(1),
          }),
        ],
        leftYAxis: { min: 0, max: 1, label: 'Score (0-1)' },
      }),
      new cloudwatch.GraphWidget({
        title: 'Queries Evaluated',
        width: 12,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'Songbird/Analytics',
            metricName: 'TotalQueriesEvaluated',
            statistic: 'Maximum',
            label: 'Total Queries (24h)',
            period: cdk.Duration.days(1),
          }),
          new cloudwatch.Metric({
            namespace: 'Songbird/Analytics',
            metricName: 'LLMEvaluatedCount',
            statistic: 'Maximum',
            label: 'LLM Evaluated',
            period: cdk.Duration.days(1),
          }),
        ],
        leftYAxis: { min: 0, label: 'Count' },
      }),
    );

    // -- Row 2: Lambda Performance --
    const chatQueryFn = this.chatQueryLambda;
    const syncFn = this.syncLambda!;
    const evalFn = dailyEvaluationLambda;

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Invocations',
        width: 12,
        height: 6,
        left: [
          chatQueryFn.metricInvocations({ label: 'Chat Query', period: cdk.Duration.hours(1) }),
          syncFn.metricInvocations({ label: 'Sync to Aurora', period: cdk.Duration.hours(1) }),
          evalFn.metricInvocations({ label: 'Daily Evaluation', period: cdk.Duration.hours(1) }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Errors',
        width: 12,
        height: 6,
        left: [
          chatQueryFn.metricErrors({ label: 'Chat Query', period: cdk.Duration.hours(1) }),
          syncFn.metricErrors({ label: 'Sync to Aurora', period: cdk.Duration.hours(1) }),
          evalFn.metricErrors({ label: 'Daily Evaluation', period: cdk.Duration.hours(1) }),
        ],
        leftYAxis: { min: 0, label: 'Errors' },
      }),
    );

    // -- Row 3: Lambda Duration + Aurora --
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Duration (p50 / p99)',
        width: 12,
        height: 6,
        left: [
          chatQueryFn.metricDuration({ statistic: 'p50', label: 'Chat Query p50', period: cdk.Duration.hours(1) }),
          chatQueryFn.metricDuration({ statistic: 'p99', label: 'Chat Query p99', period: cdk.Duration.hours(1) }),
          syncFn.metricDuration({ statistic: 'p50', label: 'Sync p50', period: cdk.Duration.hours(1) }),
          syncFn.metricDuration({ statistic: 'p99', label: 'Sync p99', period: cdk.Duration.hours(1) }),
        ],
        leftYAxis: { min: 0, label: 'Duration (ms)' },
      }),
      new cloudwatch.GraphWidget({
        title: 'Aurora Serverless Capacity (ACU)',
        width: 12,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/RDS',
            metricName: 'ServerlessDatabaseCapacity',
            dimensionsMap: { DBClusterIdentifier: this.cluster.clusterIdentifier },
            statistic: 'Average',
            label: 'Avg ACU',
            period: cdk.Duration.minutes(5),
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/RDS',
            metricName: 'ServerlessDatabaseCapacity',
            dimensionsMap: { DBClusterIdentifier: this.cluster.clusterIdentifier },
            statistic: 'Maximum',
            label: 'Max ACU',
            period: cdk.Duration.minutes(5),
          }),
        ],
        leftYAxis: { min: 0, label: 'ACU' },
      }),
    );

    // -- Row 4: Aurora Connections + Chat Query Throttles --
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Aurora Database Connections',
        width: 12,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/RDS',
            metricName: 'DatabaseConnections',
            dimensionsMap: { DBClusterIdentifier: this.cluster.clusterIdentifier },
            statistic: 'Average',
            label: 'Connections',
            period: cdk.Duration.minutes(5),
          }),
        ],
        leftYAxis: { min: 0, label: 'Connections' },
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Throttles',
        width: 12,
        height: 6,
        left: [
          chatQueryFn.metricThrottles({ label: 'Chat Query', period: cdk.Duration.hours(1) }),
          syncFn.metricThrottles({ label: 'Sync to Aurora', period: cdk.Duration.hours(1) }),
        ],
        leftYAxis: { min: 0, label: 'Throttles' },
      }),
    );

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

    new cdk.CfnOutput(this, 'AnalyticsDashboardUrl', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${cdk.Aws.REGION}#dashboards:name=Songbird-Analytics`,
      description: 'CloudWatch Analytics Dashboard URL',
    });
  }

  /**
   * Configure Phoenix OTLP endpoint for tracing
   */
  public configurePhoenixTracing(httpEndpoint: string): void {
    this.chatQueryLambda.addEnvironment('PHOENIX_HTTP_ENDPOINT', httpEndpoint);
    this.chatQueryLambda.addEnvironment('OTEL_SERVICE_NAME', 'songbird-analytics-chat-query');
  }

  /**
   * Configure Phoenix Prompt Hub for runtime prompt fetching.
   * Sets PHOENIX_HOST (used by @arizeai/phoenix-client SDK) and PHOENIX_PROMPT_TAG.
   */
  public configurePhoenixPrompts(phoenixEndpoint: string, promptTag: string = 'production'): void {
    this.chatQueryLambda.addEnvironment('PHOENIX_HOST', phoenixEndpoint);
    this.chatQueryLambda.addEnvironment('PHOENIX_PROMPT_TAG', promptTag);
  }

}
