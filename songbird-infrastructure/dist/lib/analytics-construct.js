"use strict";
/**
 * Analytics Construct
 *
 * Provides Text-to-SQL analytics powered by AWS Bedrock (Claude) and Aurora Serverless v2.
 * Includes real-time DynamoDB → Aurora sync via streams.
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
exports.AnalyticsConstruct = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const rds = __importStar(require("aws-cdk-lib/aws-rds"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const events = __importStar(require("aws-cdk-lib/aws-events"));
const targets = __importStar(require("aws-cdk-lib/aws-events-targets"));
const cloudwatch = __importStar(require("aws-cdk-lib/aws-cloudwatch"));
const aws_lambda_event_sources_1 = require("aws-cdk-lib/aws-lambda-event-sources");
const aws_lambda_nodejs_1 = require("aws-cdk-lib/aws-lambda-nodejs");
const constructs_1 = require("constructs");
const path = __importStar(require("path"));
class AnalyticsConstruct extends constructs_1.Construct {
    cluster;
    chatHistoryTable;
    chatQueryLambda;
    chatHistoryLambda;
    listSessionsLambda;
    getSessionLambda;
    deleteSessionLambda;
    rerunQueryLambda;
    vpc;
    syncLambda;
    constructor(scope, id, props) {
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
        const initSchemaLambda = new aws_lambda_nodejs_1.NodejsFunction(this, 'InitSchemaLambda', {
            functionName: 'songbird-analytics-init-schema',
            description: 'Initialize Aurora analytics schema',
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'handler',
            entry: path.join(__dirname, '../lambda/analytics/init-schema.ts'),
            timeout: cdk.Duration.seconds(60),
            memorySize: 512,
            environment: {
                CLUSTER_ARN: this.cluster.clusterArn,
                SECRET_ARN: this.cluster.secret.secretArn,
                DATABASE_NAME: 'songbird_analytics',
            },
            bundling: { minify: true, sourceMap: true },
            logRetention: logs.RetentionDays.TWO_WEEKS,
        });
        this.cluster.grantDataApiAccess(initSchemaLambda);
        // ==========================================================================
        // Lambda: DynamoDB → Aurora Sync
        // ==========================================================================
        this.syncLambda = new aws_lambda_nodejs_1.NodejsFunction(this, 'SyncLambda', {
            functionName: 'songbird-analytics-sync',
            description: 'Sync DynamoDB streams to Aurora',
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'handler',
            entry: path.join(__dirname, '../lambda/analytics/sync-to-aurora.ts'),
            timeout: cdk.Duration.seconds(60),
            memorySize: 512,
            environment: {
                CLUSTER_ARN: this.cluster.clusterArn,
                SECRET_ARN: this.cluster.secret.secretArn,
                DATABASE_NAME: 'songbird_analytics',
            },
            bundling: { minify: true, sourceMap: true },
            logRetention: logs.RetentionDays.TWO_WEEKS,
            vpc: this.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        });
        this.cluster.grantDataApiAccess(this.syncLambda);
        // Add DynamoDB stream sources
        this.syncLambda.addEventSource(new aws_lambda_event_sources_1.DynamoEventSource(props.devicesTable, {
            startingPosition: lambda.StartingPosition.TRIM_HORIZON,
            batchSize: 100,
            bisectBatchOnError: true,
            retryAttempts: 3,
        }));
        this.syncLambda.addEventSource(new aws_lambda_event_sources_1.DynamoEventSource(props.telemetryTable, {
            startingPosition: lambda.StartingPosition.TRIM_HORIZON,
            batchSize: 100,
            bisectBatchOnError: true,
            retryAttempts: 3,
        }));
        this.syncLambda.addEventSource(new aws_lambda_event_sources_1.DynamoEventSource(props.locationsTable, {
            startingPosition: lambda.StartingPosition.TRIM_HORIZON,
            batchSize: 100,
            bisectBatchOnError: true,
            retryAttempts: 3,
        }));
        this.syncLambda.addEventSource(new aws_lambda_event_sources_1.DynamoEventSource(props.alertsTable, {
            startingPosition: lambda.StartingPosition.TRIM_HORIZON,
            batchSize: 100,
            bisectBatchOnError: true,
            retryAttempts: 3,
        }));
        this.syncLambda.addEventSource(new aws_lambda_event_sources_1.DynamoEventSource(props.journeysTable, {
            startingPosition: lambda.StartingPosition.TRIM_HORIZON,
            batchSize: 100,
            bisectBatchOnError: true,
            retryAttempts: 3,
        }));
        // ==========================================================================
        // Lambda: Chat Query (Text-to-SQL)
        // ==========================================================================
        this.chatQueryLambda = new aws_lambda_nodejs_1.NodejsFunction(this, 'ChatQueryLambda', {
            functionName: 'songbird-analytics-chat-query',
            description: 'Analytics chat query with Bedrock',
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'handler',
            entry: path.join(__dirname, '../lambda/analytics/chat-query.ts'),
            timeout: cdk.Duration.seconds(60),
            memorySize: 1024,
            environment: {
                CLUSTER_ARN: this.cluster.clusterArn,
                SECRET_ARN: this.cluster.secret.secretArn,
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
        this.chatHistoryLambda = new aws_lambda_nodejs_1.NodejsFunction(this, 'ChatHistoryLambda', {
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
        this.listSessionsLambda = new aws_lambda_nodejs_1.NodejsFunction(this, 'ListSessionsLambda', {
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
        this.getSessionLambda = new aws_lambda_nodejs_1.NodejsFunction(this, 'GetSessionLambda', {
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
        this.deleteSessionLambda = new aws_lambda_nodejs_1.NodejsFunction(this, 'DeleteSessionLambda', {
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
        this.rerunQueryLambda = new aws_lambda_nodejs_1.NodejsFunction(this, 'RerunQueryLambda', {
            functionName: 'songbird-analytics-rerun-query',
            description: 'Re-execute stored SQL query for visualizations',
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'handler',
            entry: path.join(__dirname, '../lambda/analytics/rerun-query.ts'),
            timeout: cdk.Duration.seconds(60),
            memorySize: 512,
            environment: {
                CLUSTER_ARN: this.cluster.clusterArn,
                SECRET_ARN: this.cluster.secret.secretArn,
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
        const backfillLambda = new aws_lambda_nodejs_1.NodejsFunction(this, 'BackfillLambda', {
            functionName: 'songbird-analytics-backfill',
            description: 'Backfill historical DynamoDB data to Aurora',
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'handler',
            entry: path.join(__dirname, '../lambda/analytics/backfill.ts'),
            timeout: cdk.Duration.minutes(15),
            memorySize: 1024,
            environment: {
                CLUSTER_ARN: this.cluster.clusterArn,
                SECRET_ARN: this.cluster.secret.secretArn,
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
        const dailyEvaluationLambda = new aws_lambda_nodejs_1.NodejsFunction(this, 'DailyEvaluationLambda', {
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
        dashboard.addWidgets(new cloudwatch.GraphWidget({
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
        }), new cloudwatch.GraphWidget({
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
        }));
        // -- Row 2: Lambda Performance --
        const chatQueryFn = this.chatQueryLambda;
        const syncFn = this.syncLambda;
        const evalFn = dailyEvaluationLambda;
        dashboard.addWidgets(new cloudwatch.GraphWidget({
            title: 'Lambda Invocations',
            width: 12,
            height: 6,
            left: [
                chatQueryFn.metricInvocations({ label: 'Chat Query', period: cdk.Duration.hours(1) }),
                syncFn.metricInvocations({ label: 'Sync to Aurora', period: cdk.Duration.hours(1) }),
                evalFn.metricInvocations({ label: 'Daily Evaluation', period: cdk.Duration.hours(1) }),
            ],
        }), new cloudwatch.GraphWidget({
            title: 'Lambda Errors',
            width: 12,
            height: 6,
            left: [
                chatQueryFn.metricErrors({ label: 'Chat Query', period: cdk.Duration.hours(1) }),
                syncFn.metricErrors({ label: 'Sync to Aurora', period: cdk.Duration.hours(1) }),
                evalFn.metricErrors({ label: 'Daily Evaluation', period: cdk.Duration.hours(1) }),
            ],
            leftYAxis: { min: 0, label: 'Errors' },
        }));
        // -- Row 3: Lambda Duration + Aurora --
        dashboard.addWidgets(new cloudwatch.GraphWidget({
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
        }), new cloudwatch.GraphWidget({
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
        }));
        // -- Row 4: Aurora Connections + Chat Query Throttles --
        dashboard.addWidgets(new cloudwatch.GraphWidget({
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
        }), new cloudwatch.GraphWidget({
            title: 'Lambda Throttles',
            width: 12,
            height: 6,
            left: [
                chatQueryFn.metricThrottles({ label: 'Chat Query', period: cdk.Duration.hours(1) }),
                syncFn.metricThrottles({ label: 'Sync to Aurora', period: cdk.Duration.hours(1) }),
            ],
            leftYAxis: { min: 0, label: 'Throttles' },
        }));
        // ==========================================================================
        // Outputs
        // ==========================================================================
        new cdk.CfnOutput(this, 'ClusterEndpoint', {
            value: this.cluster.clusterEndpoint.hostname,
            description: 'Aurora Analytics cluster endpoint',
        });
        new cdk.CfnOutput(this, 'SecretArn', {
            value: this.cluster.secret.secretArn,
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
    configurePhoenixTracing(httpEndpoint) {
        this.chatQueryLambda.addEnvironment('PHOENIX_HTTP_ENDPOINT', httpEndpoint);
        this.chatQueryLambda.addEnvironment('OTEL_SERVICE_NAME', 'songbird-analytics-chat-query');
    }
    /**
     * Configure Phoenix Prompt Hub for runtime prompt fetching.
     * Sets PHOENIX_HOST (used by @arizeai/phoenix-client SDK) and PHOENIX_PROMPT_TAG.
     */
    configurePhoenixPrompts(phoenixEndpoint, promptTag = 'production') {
        this.chatQueryLambda.addEnvironment('PHOENIX_HOST', phoenixEndpoint);
        this.chatQueryLambda.addEnvironment('PHOENIX_PROMPT_TAG', promptTag);
    }
}
exports.AnalyticsConstruct = AnalyticsConstruct;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYW5hbHl0aWNzLWNvbnN0cnVjdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL2xpYi9hbmFseXRpY3MtY29uc3RydWN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7R0FLRzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFFSCxpREFBbUM7QUFDbkMseURBQTJDO0FBQzNDLHlEQUEyQztBQUMzQyxtRUFBcUQ7QUFDckQsK0RBQWlEO0FBQ2pELDJEQUE2QztBQUM3Qyx5REFBMkM7QUFDM0MsK0RBQWlEO0FBQ2pELHdFQUEwRDtBQUMxRCx1RUFBeUQ7QUFDekQsbUZBQXlFO0FBQ3pFLHFFQUErRDtBQUMvRCwyQ0FBdUM7QUFDdkMsMkNBQTZCO0FBVTdCLE1BQWEsa0JBQW1CLFNBQVEsc0JBQVM7SUFDL0IsT0FBTyxDQUFzQjtJQUM3QixnQkFBZ0IsQ0FBaUI7SUFDakMsZUFBZSxDQUFrQjtJQUNqQyxpQkFBaUIsQ0FBa0I7SUFDbkMsa0JBQWtCLENBQWtCO0lBQ3BDLGdCQUFnQixDQUFrQjtJQUNsQyxtQkFBbUIsQ0FBa0I7SUFDckMsZ0JBQWdCLENBQWtCO0lBQ2xDLEdBQUcsQ0FBVTtJQUNyQixVQUFVLENBQW1CO0lBRXJDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBOEI7UUFDdEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQiw2RUFBNkU7UUFDN0UsK0JBQStCO1FBQy9CLDZFQUE2RTtRQUM3RSxJQUFJLENBQUMsR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFO1lBQzNDLE1BQU0sRUFBRSxDQUFDO1lBQ1QsV0FBVyxFQUFFLENBQUM7WUFDZCxtQkFBbUIsRUFBRTtnQkFDbkI7b0JBQ0UsUUFBUSxFQUFFLEVBQUU7b0JBQ1osSUFBSSxFQUFFLFFBQVE7b0JBQ2QsVUFBVSxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsTUFBTTtp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dUIsQ0FBQyxlQUF1QixFQUFFLFlBQW9CLFlBQVk7UUFDdEYsSUFBSSxDQUFDLGVBQWUsQ0FBQyxjQUFjLENBQUMsY0FBYyxFQUFFLGVBQWUsQ0FBQyxDQUFDO1FBQ3JFLElBQUksQ0FBQyxlQUFlLENBQUMsY0FBYyxDQUFDLG9CQUFvQixFQUFFLFNBQVMsQ0FBQyxDQUFDO0lBQ3ZFLENBQUM7Q0FFRjtBQXZvQkQsZ0RBdW9CQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQW5hbHl0aWNzIENvbnN0cnVjdFxuICpcbiAqIFByb3ZpZGVzIFRleHQtdG8tU1FMIGFuYWx5dGljcyBwb3dlcmVkIGJ5IEFXUyBCZWRyb2NrIChDbGF1ZGUpIGFuZCBBdXJvcmEgU2VydmVybGVzcyB2Mi5cbiAqIEluY2x1ZGVzIHJlYWwtdGltZSBEeW5hbW9EQiDihpIgQXVyb3JhIHN5bmMgdmlhIHN0cmVhbXMuXG4gKi9cblxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGVjMiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWMyJztcbmltcG9ydCAqIGFzIHJkcyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtcmRzJztcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gJ2F3cy1jZGstbGliL2F3cy1keW5hbW9kYic7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYSc7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIGV2ZW50cyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZXZlbnRzJztcbmltcG9ydCAqIGFzIHRhcmdldHMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWV2ZW50cy10YXJnZXRzJztcbmltcG9ydCAqIGFzIGNsb3Vkd2F0Y2ggZnJvbSAnYXdzLWNkay1saWIvYXdzLWNsb3Vkd2F0Y2gnO1xuaW1wb3J0IHsgRHluYW1vRXZlbnRTb3VyY2UgfSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhLWV2ZW50LXNvdXJjZXMnO1xuaW1wb3J0IHsgTm9kZWpzRnVuY3Rpb24gfSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhLW5vZGVqcyc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQW5hbHl0aWNzQ29uc3RydWN0UHJvcHMge1xuICBkZXZpY2VzVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICB0ZWxlbWV0cnlUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIGxvY2F0aW9uc1RhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbiAgYWxlcnRzVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBqb3VybmV5c1RhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbn1cblxuZXhwb3J0IGNsYXNzIEFuYWx5dGljc0NvbnN0cnVjdCBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBjbHVzdGVyOiByZHMuRGF0YWJhc2VDbHVzdGVyO1xuICBwdWJsaWMgcmVhZG9ubHkgY2hhdEhpc3RvcnlUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSBjaGF0UXVlcnlMYW1iZGE6IGxhbWJkYS5GdW5jdGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IGNoYXRIaXN0b3J5TGFtYmRhOiBsYW1iZGEuRnVuY3Rpb247XG4gIHB1YmxpYyByZWFkb25seSBsaXN0U2Vzc2lvbnNMYW1iZGE6IGxhbWJkYS5GdW5jdGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IGdldFNlc3Npb25MYW1iZGE6IGxhbWJkYS5GdW5jdGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IGRlbGV0ZVNlc3Npb25MYW1iZGE6IGxhbWJkYS5GdW5jdGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IHJlcnVuUXVlcnlMYW1iZGE6IGxhbWJkYS5GdW5jdGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IHZwYzogZWMyLlZwYztcbiAgcHJpdmF0ZSBzeW5jTGFtYmRhPzogbGFtYmRhLkZ1bmN0aW9uO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBbmFseXRpY3NDb25zdHJ1Y3RQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFZQQyBmb3IgQXVyb3JhIFNlcnZlcmxlc3MgdjJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMudnBjID0gbmV3IGVjMi5WcGModGhpcywgJ0FuYWx5dGljc1ZwYycsIHtcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgc3VibmV0Q29uZmlndXJhdGlvbjogW1xuICAgICAgICB7XG4gICAgICAgICAgY2lkck1hc2s6IDI0LFxuICAgICAgICAgIG5hbWU6ICdQdWJsaWMnLFxuICAgICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBVQkxJQyxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGNpZHJNYXNrOiAyNCxcbiAgICAgICAgICBuYW1lOiAnUHJpdmF0ZScsXG4gICAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGNpZHJNYXNrOiAyOCxcbiAgICAgICAgICBuYW1lOiAnSXNvbGF0ZWQnLFxuICAgICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfSVNPTEFURUQsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBBdXJvcmEgU2VydmVybGVzcyB2MiBDbHVzdGVyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLmNsdXN0ZXIgPSBuZXcgcmRzLkRhdGFiYXNlQ2x1c3Rlcih0aGlzLCAnQW5hbHl0aWNzQ2x1c3RlcicsIHtcbiAgICAgIGVuZ2luZTogcmRzLkRhdGFiYXNlQ2x1c3RlckVuZ2luZS5hdXJvcmFQb3N0Z3Jlcyh7XG4gICAgICAgIHZlcnNpb246IHJkcy5BdXJvcmFQb3N0Z3Jlc0VuZ2luZVZlcnNpb24uVkVSXzE2XzQsXG4gICAgICB9KSxcbiAgICAgIHZwYzogdGhpcy52cGMsXG4gICAgICB2cGNTdWJuZXRzOiB7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfSVNPTEFURUQgfSxcbiAgICAgIHdyaXRlcjogcmRzLkNsdXN0ZXJJbnN0YW5jZS5zZXJ2ZXJsZXNzVjIoJ3dyaXRlcicsIHtcbiAgICAgICAgYXV0b01pbm9yVmVyc2lvblVwZ3JhZGU6IHRydWUsXG4gICAgICB9KSxcbiAgICAgIHNlcnZlcmxlc3NWMk1pbkNhcGFjaXR5OiAwLjUsXG4gICAgICBzZXJ2ZXJsZXNzVjJNYXhDYXBhY2l0eTogNCxcbiAgICAgIGRlZmF1bHREYXRhYmFzZU5hbWU6ICdzb25nYmlyZF9hbmFseXRpY3MnLFxuICAgICAgZW5hYmxlRGF0YUFwaTogdHJ1ZSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICBzdG9yYWdlRW5jcnlwdGVkOiB0cnVlLFxuICAgICAgYmFja3VwOiB7XG4gICAgICAgIHJldGVudGlvbjogY2RrLkR1cmF0aW9uLmRheXMoNyksXG4gICAgICAgIHByZWZlcnJlZFdpbmRvdzogJzAzOjAwLTA0OjAwJyxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIER5bmFtb0RCIFRhYmxlIGZvciBDaGF0IEhpc3RvcnlcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuY2hhdEhpc3RvcnlUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCAnQ2hhdEhpc3RvcnlUYWJsZScsIHtcbiAgICAgIHRhYmxlTmFtZTogJ3NvbmdiaXJkLWNoYXQtaGlzdG9yeScsXG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogJ3VzZXJfZW1haWwnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBzb3J0S2V5OiB7XG4gICAgICAgIG5hbWU6ICd0aW1lc3RhbXAnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLk5VTUJFUixcbiAgICAgIH0sXG4gICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6ICd0dGwnLFxuICAgIH0pO1xuXG4gICAgLy8gR1NJIGZvciBxdWVyeWluZyBieSBzZXNzaW9uXG4gICAgdGhpcy5jaGF0SGlzdG9yeVRhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcbiAgICAgIGluZGV4TmFtZTogJ3Nlc3Npb24taW5kZXgnLFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdzZXNzaW9uX2lkJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAndGltZXN0YW1wJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5OVU1CRVIsXG4gICAgICB9LFxuICAgICAgcHJvamVjdGlvblR5cGU6IGR5bmFtb2RiLlByb2plY3Rpb25UeXBlLkFMTCxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTGFtYmRhOiBTY2hlbWEgSW5pdGlhbGl6YXRpb25cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGluaXRTY2hlbWFMYW1iZGEgPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0luaXRTY2hlbWFMYW1iZGEnLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hbmFseXRpY3MtaW5pdC1zY2hlbWEnLFxuICAgICAgZGVzY3JpcHRpb246ICdJbml0aWFsaXplIEF1cm9yYSBhbmFseXRpY3Mgc2NoZW1hJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYW5hbHl0aWNzL2luaXQtc2NoZW1hLnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg2MCksXG4gICAgICBtZW1vcnlTaXplOiA1MTIsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBDTFVTVEVSX0FSTjogdGhpcy5jbHVzdGVyLmNsdXN0ZXJBcm4sXG4gICAgICAgIFNFQ1JFVF9BUk46IHRoaXMuY2x1c3Rlci5zZWNyZXQhLnNlY3JldEFybixcbiAgICAgICAgREFUQUJBU0VfTkFNRTogJ3NvbmdiaXJkX2FuYWx5dGljcycsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcblxuICAgIHRoaXMuY2x1c3Rlci5ncmFudERhdGFBcGlBY2Nlc3MoaW5pdFNjaGVtYUxhbWJkYSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIExhbWJkYTogRHluYW1vREIg4oaSIEF1cm9yYSBTeW5jXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLnN5bmNMYW1iZGEgPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ1N5bmNMYW1iZGEnLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hbmFseXRpY3Mtc3luYycsXG4gICAgICBkZXNjcmlwdGlvbjogJ1N5bmMgRHluYW1vREIgc3RyZWFtcyB0byBBdXJvcmEnLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hbmFseXRpY3Mvc3luYy10by1hdXJvcmEudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDYwKSxcbiAgICAgIG1lbW9yeVNpemU6IDUxMixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIENMVVNURVJfQVJOOiB0aGlzLmNsdXN0ZXIuY2x1c3RlckFybixcbiAgICAgICAgU0VDUkVUX0FSTjogdGhpcy5jbHVzdGVyLnNlY3JldCEuc2VjcmV0QXJuLFxuICAgICAgICBEQVRBQkFTRV9OQU1FOiAnc29uZ2JpcmRfYW5hbHl0aWNzJyxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgICAgdnBjOiB0aGlzLnZwYyxcbiAgICAgIHZwY1N1Ym5ldHM6IHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyB9LFxuICAgIH0pO1xuXG4gICAgdGhpcy5jbHVzdGVyLmdyYW50RGF0YUFwaUFjY2Vzcyh0aGlzLnN5bmNMYW1iZGEpO1xuXG4gICAgLy8gQWRkIER5bmFtb0RCIHN0cmVhbSBzb3VyY2VzXG4gICAgdGhpcy5zeW5jTGFtYmRhLmFkZEV2ZW50U291cmNlKG5ldyBEeW5hbW9FdmVudFNvdXJjZShwcm9wcy5kZXZpY2VzVGFibGUsIHtcbiAgICAgIHN0YXJ0aW5nUG9zaXRpb246IGxhbWJkYS5TdGFydGluZ1Bvc2l0aW9uLlRSSU1fSE9SSVpPTixcbiAgICAgIGJhdGNoU2l6ZTogMTAwLFxuICAgICAgYmlzZWN0QmF0Y2hPbkVycm9yOiB0cnVlLFxuICAgICAgcmV0cnlBdHRlbXB0czogMyxcbiAgICB9KSk7XG5cbiAgICB0aGlzLnN5bmNMYW1iZGEuYWRkRXZlbnRTb3VyY2UobmV3IER5bmFtb0V2ZW50U291cmNlKHByb3BzLnRlbGVtZXRyeVRhYmxlLCB7XG4gICAgICBzdGFydGluZ1Bvc2l0aW9uOiBsYW1iZGEuU3RhcnRpbmdQb3NpdGlvbi5UUklNX0hPUklaT04sXG4gICAgICBiYXRjaFNpemU6IDEwMCxcbiAgICAgIGJpc2VjdEJhdGNoT25FcnJvcjogdHJ1ZSxcbiAgICAgIHJldHJ5QXR0ZW1wdHM6IDMsXG4gICAgfSkpO1xuXG4gICAgdGhpcy5zeW5jTGFtYmRhLmFkZEV2ZW50U291cmNlKG5ldyBEeW5hbW9FdmVudFNvdXJjZShwcm9wcy5sb2NhdGlvbnNUYWJsZSwge1xuICAgICAgc3RhcnRpbmdQb3NpdGlvbjogbGFtYmRhLlN0YXJ0aW5nUG9zaXRpb24uVFJJTV9IT1JJWk9OLFxuICAgICAgYmF0Y2hTaXplOiAxMDAsXG4gICAgICBiaXNlY3RCYXRjaE9uRXJyb3I6IHRydWUsXG4gICAgICByZXRyeUF0dGVtcHRzOiAzLFxuICAgIH0pKTtcblxuICAgIHRoaXMuc3luY0xhbWJkYS5hZGRFdmVudFNvdXJjZShuZXcgRHluYW1vRXZlbnRTb3VyY2UocHJvcHMuYWxlcnRzVGFibGUsIHtcbiAgICAgIHN0YXJ0aW5nUG9zaXRpb246IGxhbWJkYS5TdGFydGluZ1Bvc2l0aW9uLlRSSU1fSE9SSVpPTixcbiAgICAgIGJhdGNoU2l6ZTogMTAwLFxuICAgICAgYmlzZWN0QmF0Y2hPbkVycm9yOiB0cnVlLFxuICAgICAgcmV0cnlBdHRlbXB0czogMyxcbiAgICB9KSk7XG5cbiAgICB0aGlzLnN5bmNMYW1iZGEuYWRkRXZlbnRTb3VyY2UobmV3IER5bmFtb0V2ZW50U291cmNlKHByb3BzLmpvdXJuZXlzVGFibGUsIHtcbiAgICAgIHN0YXJ0aW5nUG9zaXRpb246IGxhbWJkYS5TdGFydGluZ1Bvc2l0aW9uLlRSSU1fSE9SSVpPTixcbiAgICAgIGJhdGNoU2l6ZTogMTAwLFxuICAgICAgYmlzZWN0QmF0Y2hPbkVycm9yOiB0cnVlLFxuICAgICAgcmV0cnlBdHRlbXB0czogMyxcbiAgICB9KSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIExhbWJkYTogQ2hhdCBRdWVyeSAoVGV4dC10by1TUUwpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLmNoYXRRdWVyeUxhbWJkYSA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnQ2hhdFF1ZXJ5TGFtYmRhJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYW5hbHl0aWNzLWNoYXQtcXVlcnknLFxuICAgICAgZGVzY3JpcHRpb246ICdBbmFseXRpY3MgY2hhdCBxdWVyeSB3aXRoIEJlZHJvY2snLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hbmFseXRpY3MvY2hhdC1xdWVyeS50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApLFxuICAgICAgbWVtb3J5U2l6ZTogMTAyNCxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIENMVVNURVJfQVJOOiB0aGlzLmNsdXN0ZXIuY2x1c3RlckFybixcbiAgICAgICAgU0VDUkVUX0FSTjogdGhpcy5jbHVzdGVyLnNlY3JldCEuc2VjcmV0QXJuLFxuICAgICAgICBEQVRBQkFTRV9OQU1FOiAnc29uZ2JpcmRfYW5hbHl0aWNzJyxcbiAgICAgICAgQ0hBVF9ISVNUT1JZX1RBQkxFOiB0aGlzLmNoYXRIaXN0b3J5VGFibGUudGFibGVOYW1lLFxuICAgICAgICBCRURST0NLX01PREVMX0lEOiAndXMuYW50aHJvcGljLmNsYXVkZS0zLTUtc29ubmV0LTIwMjQxMDIyLXYyOjAnLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgICB2cGM6IHRoaXMudnBjLFxuICAgICAgdnBjU3VibmV0czogeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTIH0sXG4gICAgfSk7XG5cbiAgICB0aGlzLmNsdXN0ZXIuZ3JhbnREYXRhQXBpQWNjZXNzKHRoaXMuY2hhdFF1ZXJ5TGFtYmRhKTtcbiAgICB0aGlzLmNoYXRIaXN0b3J5VGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHRoaXMuY2hhdFF1ZXJ5TGFtYmRhKTtcblxuICAgIC8vIEdyYW50IEJlZHJvY2sgYWNjZXNzIChpbmNsdWRlcyBNYXJrZXRwbGFjZSBwZXJtaXNzaW9ucyBmb3IgZmlyc3QtdGltZSBtb2RlbCBpbnZvY2F0aW9uKVxuICAgIHRoaXMuY2hhdFF1ZXJ5TGFtYmRhLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2JlZHJvY2s6SW52b2tlTW9kZWwnXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgfSkpO1xuICAgIHRoaXMuY2hhdFF1ZXJ5TGFtYmRhLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2F3cy1tYXJrZXRwbGFjZTpWaWV3U3Vic2NyaXB0aW9ucycsICdhd3MtbWFya2V0cGxhY2U6U3Vic2NyaWJlJ10sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgIH0pKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTGFtYmRhOiBDaGF0IEhpc3RvcnlcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuY2hhdEhpc3RvcnlMYW1iZGEgPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0NoYXRIaXN0b3J5TGFtYmRhJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYW5hbHl0aWNzLWNoYXQtaGlzdG9yeScsXG4gICAgICBkZXNjcmlwdGlvbjogJ1JldHJpZXZlIGFuYWx5dGljcyBjaGF0IGhpc3RvcnknLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hbmFseXRpY3MvY2hhdC1oaXN0b3J5LnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBDSEFUX0hJU1RPUllfVEFCTEU6IHRoaXMuY2hhdEhpc3RvcnlUYWJsZS50YWJsZU5hbWUsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcblxuICAgIHRoaXMuY2hhdEhpc3RvcnlUYWJsZS5ncmFudFJlYWREYXRhKHRoaXMuY2hhdEhpc3RvcnlMYW1iZGEpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBMYW1iZGE6IExpc3QgU2Vzc2lvbnNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMubGlzdFNlc3Npb25zTGFtYmRhID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdMaXN0U2Vzc2lvbnNMYW1iZGEnLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hbmFseXRpY3MtbGlzdC1zZXNzaW9ucycsXG4gICAgICBkZXNjcmlwdGlvbjogJ0xpc3QgYW5hbHl0aWNzIGNoYXQgc2Vzc2lvbnMnLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hbmFseXRpY3MvbGlzdC1zZXNzaW9ucy50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQ0hBVF9ISVNUT1JZX1RBQkxFOiB0aGlzLmNoYXRIaXN0b3J5VGFibGUudGFibGVOYW1lLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG5cbiAgICB0aGlzLmNoYXRIaXN0b3J5VGFibGUuZ3JhbnRSZWFkRGF0YSh0aGlzLmxpc3RTZXNzaW9uc0xhbWJkYSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIExhbWJkYTogR2V0IFNlc3Npb25cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuZ2V0U2Vzc2lvbkxhbWJkYSA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnR2V0U2Vzc2lvbkxhbWJkYScsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFuYWx5dGljcy1nZXQtc2Vzc2lvbicsXG4gICAgICBkZXNjcmlwdGlvbjogJ0dldCBhbmFseXRpY3MgY2hhdCBzZXNzaW9uIGRldGFpbHMnLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hbmFseXRpY3MvZ2V0LXNlc3Npb24udHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIENIQVRfSElTVE9SWV9UQUJMRTogdGhpcy5jaGF0SGlzdG9yeVRhYmxlLnRhYmxlTmFtZSxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuXG4gICAgdGhpcy5jaGF0SGlzdG9yeVRhYmxlLmdyYW50UmVhZERhdGEodGhpcy5nZXRTZXNzaW9uTGFtYmRhKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTGFtYmRhOiBEZWxldGUgU2Vzc2lvblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5kZWxldGVTZXNzaW9uTGFtYmRhID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdEZWxldGVTZXNzaW9uTGFtYmRhJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYW5hbHl0aWNzLWRlbGV0ZS1zZXNzaW9uJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRGVsZXRlIGFuYWx5dGljcyBjaGF0IHNlc3Npb24nLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hbmFseXRpY3MvZGVsZXRlLXNlc3Npb24udHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIENIQVRfSElTVE9SWV9UQUJMRTogdGhpcy5jaGF0SGlzdG9yeVRhYmxlLnRhYmxlTmFtZSxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuXG4gICAgdGhpcy5jaGF0SGlzdG9yeVRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YSh0aGlzLmRlbGV0ZVNlc3Npb25MYW1iZGEpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBMYW1iZGE6IFJlcnVuIFF1ZXJ5IChyZS1leGVjdXRlIHN0b3JlZCBTUUwgZm9yIHZpc3VhbGl6YXRpb25zKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5yZXJ1blF1ZXJ5TGFtYmRhID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdSZXJ1blF1ZXJ5TGFtYmRhJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYW5hbHl0aWNzLXJlcnVuLXF1ZXJ5JyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUmUtZXhlY3V0ZSBzdG9yZWQgU1FMIHF1ZXJ5IGZvciB2aXN1YWxpemF0aW9ucycsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FuYWx5dGljcy9yZXJ1bi1xdWVyeS50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApLFxuICAgICAgbWVtb3J5U2l6ZTogNTEyLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQ0xVU1RFUl9BUk46IHRoaXMuY2x1c3Rlci5jbHVzdGVyQXJuLFxuICAgICAgICBTRUNSRVRfQVJOOiB0aGlzLmNsdXN0ZXIuc2VjcmV0IS5zZWNyZXRBcm4sXG4gICAgICAgIERBVEFCQVNFX05BTUU6ICdzb25nYmlyZF9hbmFseXRpY3MnLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgICB2cGM6IHRoaXMudnBjLFxuICAgICAgdnBjU3VibmV0czogeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTIH0sXG4gICAgfSk7XG5cbiAgICB0aGlzLmNsdXN0ZXIuZ3JhbnREYXRhQXBpQWNjZXNzKHRoaXMucmVydW5RdWVyeUxhbWJkYSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIExhbWJkYTogQmFja2ZpbGwgKG9uZS10aW1lIGhpc3RvcmljYWwgZGF0YSBtaWdyYXRpb24pXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBiYWNrZmlsbExhbWJkYSA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnQmFja2ZpbGxMYW1iZGEnLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hbmFseXRpY3MtYmFja2ZpbGwnLFxuICAgICAgZGVzY3JpcHRpb246ICdCYWNrZmlsbCBoaXN0b3JpY2FsIER5bmFtb0RCIGRhdGEgdG8gQXVyb3JhJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYW5hbHl0aWNzL2JhY2tmaWxsLnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcygxNSksXG4gICAgICBtZW1vcnlTaXplOiAxMDI0LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQ0xVU1RFUl9BUk46IHRoaXMuY2x1c3Rlci5jbHVzdGVyQXJuLFxuICAgICAgICBTRUNSRVRfQVJOOiB0aGlzLmNsdXN0ZXIuc2VjcmV0IS5zZWNyZXRBcm4sXG4gICAgICAgIERBVEFCQVNFX05BTUU6ICdzb25nYmlyZF9hbmFseXRpY3MnLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG5cbiAgICB0aGlzLmNsdXN0ZXIuZ3JhbnREYXRhQXBpQWNjZXNzKGJhY2tmaWxsTGFtYmRhKTtcbiAgICBwcm9wcy5kZXZpY2VzVGFibGUuZ3JhbnRSZWFkRGF0YShiYWNrZmlsbExhbWJkYSk7XG4gICAgcHJvcHMudGVsZW1ldHJ5VGFibGUuZ3JhbnRSZWFkRGF0YShiYWNrZmlsbExhbWJkYSk7XG4gICAgcHJvcHMubG9jYXRpb25zVGFibGUuZ3JhbnRSZWFkRGF0YShiYWNrZmlsbExhbWJkYSk7XG4gICAgcHJvcHMuYWxlcnRzVGFibGUuZ3JhbnRSZWFkRGF0YShiYWNrZmlsbExhbWJkYSk7XG4gICAgcHJvcHMuam91cm5leXNUYWJsZS5ncmFudFJlYWREYXRhKGJhY2tmaWxsTGFtYmRhKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTGFtYmRhOiBEYWlseSBFdmFsdWF0aW9uXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBkYWlseUV2YWx1YXRpb25MYW1iZGEgPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0RhaWx5RXZhbHVhdGlvbkxhbWJkYScsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFuYWx5dGljcy1kYWlseS1ldmFsdWF0aW9uJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUnVuIGRhaWx5IGV2YWx1YXRpb25zIG9uIGFuYWx5dGljcyBxdWVyaWVzJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYW5hbHl0aWNzL2RhaWx5LWV2YWx1YXRpb24udHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgbWVtb3J5U2l6ZTogNTEyLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQ0hBVF9ISVNUT1JZX1RBQkxFOiB0aGlzLmNoYXRIaXN0b3J5VGFibGUudGFibGVOYW1lLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG5cbiAgICB0aGlzLmNoYXRIaXN0b3J5VGFibGUuZ3JhbnRSZWFkRGF0YShkYWlseUV2YWx1YXRpb25MYW1iZGEpO1xuXG4gICAgLy8gR3JhbnQgQmVkcm9jayBhY2Nlc3MgZm9yIExMTS1iYXNlZCBldmFsdWF0aW9uc1xuICAgIGRhaWx5RXZhbHVhdGlvbkxhbWJkYS5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogWydiZWRyb2NrOkludm9rZU1vZGVsJ10sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgIH0pKTtcblxuICAgIC8vIFNjaGVkdWxlIHRvIHJ1biBkYWlseSBhdCA4YW0gVVRDXG4gICAgY29uc3QgZXZhbHVhdGlvblJ1bGUgPSBuZXcgZXZlbnRzLlJ1bGUodGhpcywgJ0RhaWx5RXZhbHVhdGlvblJ1bGUnLCB7XG4gICAgICBzY2hlZHVsZTogZXZlbnRzLlNjaGVkdWxlLmNyb24oeyBob3VyOiAnOCcsIG1pbnV0ZTogJzAnIH0pLFxuICAgICAgZGVzY3JpcHRpb246ICdUcmlnZ2VyIGRhaWx5IGFuYWx5dGljcyBldmFsdWF0aW9uJyxcbiAgICB9KTtcblxuICAgIGV2YWx1YXRpb25SdWxlLmFkZFRhcmdldChuZXcgdGFyZ2V0cy5MYW1iZGFGdW5jdGlvbihkYWlseUV2YWx1YXRpb25MYW1iZGEpKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ2xvdWRXYXRjaCBNZXRyaWMgRmlsdGVycyAoZXh0cmFjdCBtZXRyaWNzIGZyb20gZXZhbHVhdGlvbiBMYW1iZGEgbG9ncylcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGV2YWxMb2dHcm91cCA9IGRhaWx5RXZhbHVhdGlvbkxhbWJkYS5sb2dHcm91cDtcblxuICAgIGNvbnN0IHN5bnRheFZhbGlkTWV0cmljID0gbmV3IGxvZ3MuTWV0cmljRmlsdGVyKHRoaXMsICdTeW50YXhWYWxpZFJhdGVNZXRyaWMnLCB7XG4gICAgICBsb2dHcm91cDogZXZhbExvZ0dyb3VwLFxuICAgICAgZmlsdGVyUGF0dGVybjogbG9ncy5GaWx0ZXJQYXR0ZXJuLmxpdGVyYWwoJ3sgJC5tZXRyaWMgPSBcIkV2YWx1YXRpb25SZXBvcnRcIiB9JyksXG4gICAgICBtZXRyaWNOYW1lc3BhY2U6ICdTb25nYmlyZC9BbmFseXRpY3MnLFxuICAgICAgbWV0cmljTmFtZTogJ1N5bnRheFZhbGlkUmF0ZScsXG4gICAgICBtZXRyaWNWYWx1ZTogJyQuc3ludGF4VmFsaWRSYXRlJyxcbiAgICAgIGRlZmF1bHRWYWx1ZTogMCxcbiAgICB9KTtcblxuICAgIGNvbnN0IGV4ZWN1dGlvblN1Y2Nlc3NNZXRyaWMgPSBuZXcgbG9ncy5NZXRyaWNGaWx0ZXIodGhpcywgJ0V4ZWN1dGlvblN1Y2Nlc3NSYXRlTWV0cmljJywge1xuICAgICAgbG9nR3JvdXA6IGV2YWxMb2dHcm91cCxcbiAgICAgIGZpbHRlclBhdHRlcm46IGxvZ3MuRmlsdGVyUGF0dGVybi5saXRlcmFsKCd7ICQubWV0cmljID0gXCJFdmFsdWF0aW9uUmVwb3J0XCIgfScpLFxuICAgICAgbWV0cmljTmFtZXNwYWNlOiAnU29uZ2JpcmQvQW5hbHl0aWNzJyxcbiAgICAgIG1ldHJpY05hbWU6ICdFeGVjdXRpb25TdWNjZXNzUmF0ZScsXG4gICAgICBtZXRyaWNWYWx1ZTogJyQuZXhlY3V0aW9uU3VjY2Vzc1JhdGUnLFxuICAgICAgZGVmYXVsdFZhbHVlOiAwLFxuICAgIH0pO1xuXG4gICAgY29uc3QgaW5zaWdodFJlbGV2YW5jZU1ldHJpYyA9IG5ldyBsb2dzLk1ldHJpY0ZpbHRlcih0aGlzLCAnSW5zaWdodFJlbGV2YW5jZU1ldHJpYycsIHtcbiAgICAgIGxvZ0dyb3VwOiBldmFsTG9nR3JvdXAsXG4gICAgICBmaWx0ZXJQYXR0ZXJuOiBsb2dzLkZpbHRlclBhdHRlcm4ubGl0ZXJhbCgneyAkLm1ldHJpYyA9IFwiRXZhbHVhdGlvblJlcG9ydFwiIH0nKSxcbiAgICAgIG1ldHJpY05hbWVzcGFjZTogJ1NvbmdiaXJkL0FuYWx5dGljcycsXG4gICAgICBtZXRyaWNOYW1lOiAnQXZnSW5zaWdodFJlbGV2YW5jZScsXG4gICAgICBtZXRyaWNWYWx1ZTogJyQuYXZnSW5zaWdodFJlbGV2YW5jZScsXG4gICAgICBkZWZhdWx0VmFsdWU6IDAsXG4gICAgfSk7XG5cbiAgICBjb25zdCBoYWxsdWNpbmF0aW9uTWV0cmljID0gbmV3IGxvZ3MuTWV0cmljRmlsdGVyKHRoaXMsICdIYWxsdWNpbmF0aW9uU2NvcmVNZXRyaWMnLCB7XG4gICAgICBsb2dHcm91cDogZXZhbExvZ0dyb3VwLFxuICAgICAgZmlsdGVyUGF0dGVybjogbG9ncy5GaWx0ZXJQYXR0ZXJuLmxpdGVyYWwoJ3sgJC5tZXRyaWMgPSBcIkV2YWx1YXRpb25SZXBvcnRcIiB9JyksXG4gICAgICBtZXRyaWNOYW1lc3BhY2U6ICdTb25nYmlyZC9BbmFseXRpY3MnLFxuICAgICAgbWV0cmljTmFtZTogJ0F2Z0hhbGx1Y2luYXRpb25TY29yZScsXG4gICAgICBtZXRyaWNWYWx1ZTogJyQuYXZnSGFsbHVjaW5hdGlvblNjb3JlJyxcbiAgICAgIGRlZmF1bHRWYWx1ZTogMCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHRvdGFsUXVlcmllc01ldHJpYyA9IG5ldyBsb2dzLk1ldHJpY0ZpbHRlcih0aGlzLCAnVG90YWxRdWVyaWVzTWV0cmljJywge1xuICAgICAgbG9nR3JvdXA6IGV2YWxMb2dHcm91cCxcbiAgICAgIGZpbHRlclBhdHRlcm46IGxvZ3MuRmlsdGVyUGF0dGVybi5saXRlcmFsKCd7ICQubWV0cmljID0gXCJFdmFsdWF0aW9uUmVwb3J0XCIgfScpLFxuICAgICAgbWV0cmljTmFtZXNwYWNlOiAnU29uZ2JpcmQvQW5hbHl0aWNzJyxcbiAgICAgIG1ldHJpY05hbWU6ICdUb3RhbFF1ZXJpZXNFdmFsdWF0ZWQnLFxuICAgICAgbWV0cmljVmFsdWU6ICckLnRvdGFsUXVlcmllcycsXG4gICAgICBkZWZhdWx0VmFsdWU6IDAsXG4gICAgfSk7XG5cbiAgICBjb25zdCBsbG1FdmFsdWF0ZWRNZXRyaWMgPSBuZXcgbG9ncy5NZXRyaWNGaWx0ZXIodGhpcywgJ0xMTUV2YWx1YXRlZE1ldHJpYycsIHtcbiAgICAgIGxvZ0dyb3VwOiBldmFsTG9nR3JvdXAsXG4gICAgICBmaWx0ZXJQYXR0ZXJuOiBsb2dzLkZpbHRlclBhdHRlcm4ubGl0ZXJhbCgneyAkLm1ldHJpYyA9IFwiRXZhbHVhdGlvblJlcG9ydFwiIH0nKSxcbiAgICAgIG1ldHJpY05hbWVzcGFjZTogJ1NvbmdiaXJkL0FuYWx5dGljcycsXG4gICAgICBtZXRyaWNOYW1lOiAnTExNRXZhbHVhdGVkQ291bnQnLFxuICAgICAgbWV0cmljVmFsdWU6ICckLmxsbUV2YWx1YXRlZENvdW50JyxcbiAgICAgIGRlZmF1bHRWYWx1ZTogMCxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ2xvdWRXYXRjaCBEYXNoYm9hcmRcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGRhc2hib2FyZCA9IG5ldyBjbG91ZHdhdGNoLkRhc2hib2FyZCh0aGlzLCAnQW5hbHl0aWNzRGFzaGJvYXJkJywge1xuICAgICAgZGFzaGJvYXJkTmFtZTogJ1NvbmdiaXJkLUFuYWx5dGljcycsXG4gICAgICBwZXJpb2RPdmVycmlkZTogY2xvdWR3YXRjaC5QZXJpb2RPdmVycmlkZS5BVVRPLFxuICAgIH0pO1xuXG4gICAgLy8gLS0gUm93IDE6IEV2YWx1YXRpb24gUXVhbGl0eSBTY29yZXMgLS1cbiAgICBkYXNoYm9hcmQuYWRkV2lkZ2V0cyhcbiAgICAgIG5ldyBjbG91ZHdhdGNoLkdyYXBoV2lkZ2V0KHtcbiAgICAgICAgdGl0bGU6ICdFdmFsdWF0aW9uIFF1YWxpdHkgU2NvcmVzJyxcbiAgICAgICAgd2lkdGg6IDEyLFxuICAgICAgICBoZWlnaHQ6IDYsXG4gICAgICAgIGxlZnQ6IFtcbiAgICAgICAgICBuZXcgY2xvdWR3YXRjaC5NZXRyaWMoe1xuICAgICAgICAgICAgbmFtZXNwYWNlOiAnU29uZ2JpcmQvQW5hbHl0aWNzJyxcbiAgICAgICAgICAgIG1ldHJpY05hbWU6ICdTeW50YXhWYWxpZFJhdGUnLFxuICAgICAgICAgICAgc3RhdGlzdGljOiAnTWF4aW11bScsXG4gICAgICAgICAgICBsYWJlbDogJ1NRTCBTeW50YXggVmFsaWQgUmF0ZScsXG4gICAgICAgICAgICBwZXJpb2Q6IGNkay5EdXJhdGlvbi5kYXlzKDEpLFxuICAgICAgICAgIH0pLFxuICAgICAgICAgIG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICAgICAgICBuYW1lc3BhY2U6ICdTb25nYmlyZC9BbmFseXRpY3MnLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ0V4ZWN1dGlvblN1Y2Nlc3NSYXRlJyxcbiAgICAgICAgICAgIHN0YXRpc3RpYzogJ01heGltdW0nLFxuICAgICAgICAgICAgbGFiZWw6ICdFeGVjdXRpb24gU3VjY2VzcyBSYXRlJyxcbiAgICAgICAgICAgIHBlcmlvZDogY2RrLkR1cmF0aW9uLmRheXMoMSksXG4gICAgICAgICAgfSksXG4gICAgICAgICAgbmV3IGNsb3Vkd2F0Y2guTWV0cmljKHtcbiAgICAgICAgICAgIG5hbWVzcGFjZTogJ1NvbmdiaXJkL0FuYWx5dGljcycsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnQXZnSW5zaWdodFJlbGV2YW5jZScsXG4gICAgICAgICAgICBzdGF0aXN0aWM6ICdNYXhpbXVtJyxcbiAgICAgICAgICAgIGxhYmVsOiAnQXZnIEluc2lnaHQgUmVsZXZhbmNlJyxcbiAgICAgICAgICAgIHBlcmlvZDogY2RrLkR1cmF0aW9uLmRheXMoMSksXG4gICAgICAgICAgfSksXG4gICAgICAgICAgbmV3IGNsb3Vkd2F0Y2guTWV0cmljKHtcbiAgICAgICAgICAgIG5hbWVzcGFjZTogJ1NvbmdiaXJkL0FuYWx5dGljcycsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnQXZnSGFsbHVjaW5hdGlvblNjb3JlJyxcbiAgICAgICAgICAgIHN0YXRpc3RpYzogJ01heGltdW0nLFxuICAgICAgICAgICAgbGFiZWw6ICdBdmcgSGFsbHVjaW5hdGlvbiBTY29yZSAoaGlnaGVyPWJldHRlciknLFxuICAgICAgICAgICAgcGVyaW9kOiBjZGsuRHVyYXRpb24uZGF5cygxKSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSxcbiAgICAgICAgbGVmdFlBeGlzOiB7IG1pbjogMCwgbWF4OiAxLCBsYWJlbDogJ1Njb3JlICgwLTEpJyB9LFxuICAgICAgfSksXG4gICAgICBuZXcgY2xvdWR3YXRjaC5HcmFwaFdpZGdldCh7XG4gICAgICAgIHRpdGxlOiAnUXVlcmllcyBFdmFsdWF0ZWQnLFxuICAgICAgICB3aWR0aDogMTIsXG4gICAgICAgIGhlaWdodDogNixcbiAgICAgICAgbGVmdDogW1xuICAgICAgICAgIG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICAgICAgICBuYW1lc3BhY2U6ICdTb25nYmlyZC9BbmFseXRpY3MnLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ1RvdGFsUXVlcmllc0V2YWx1YXRlZCcsXG4gICAgICAgICAgICBzdGF0aXN0aWM6ICdNYXhpbXVtJyxcbiAgICAgICAgICAgIGxhYmVsOiAnVG90YWwgUXVlcmllcyAoMjRoKScsXG4gICAgICAgICAgICBwZXJpb2Q6IGNkay5EdXJhdGlvbi5kYXlzKDEpLFxuICAgICAgICAgIH0pLFxuICAgICAgICAgIG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICAgICAgICBuYW1lc3BhY2U6ICdTb25nYmlyZC9BbmFseXRpY3MnLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ0xMTUV2YWx1YXRlZENvdW50JyxcbiAgICAgICAgICAgIHN0YXRpc3RpYzogJ01heGltdW0nLFxuICAgICAgICAgICAgbGFiZWw6ICdMTE0gRXZhbHVhdGVkJyxcbiAgICAgICAgICAgIHBlcmlvZDogY2RrLkR1cmF0aW9uLmRheXMoMSksXG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICAgIGxlZnRZQXhpczogeyBtaW46IDAsIGxhYmVsOiAnQ291bnQnIH0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgLy8gLS0gUm93IDI6IExhbWJkYSBQZXJmb3JtYW5jZSAtLVxuICAgIGNvbnN0IGNoYXRRdWVyeUZuID0gdGhpcy5jaGF0UXVlcnlMYW1iZGE7XG4gICAgY29uc3Qgc3luY0ZuID0gdGhpcy5zeW5jTGFtYmRhITtcbiAgICBjb25zdCBldmFsRm4gPSBkYWlseUV2YWx1YXRpb25MYW1iZGE7XG5cbiAgICBkYXNoYm9hcmQuYWRkV2lkZ2V0cyhcbiAgICAgIG5ldyBjbG91ZHdhdGNoLkdyYXBoV2lkZ2V0KHtcbiAgICAgICAgdGl0bGU6ICdMYW1iZGEgSW52b2NhdGlvbnMnLFxuICAgICAgICB3aWR0aDogMTIsXG4gICAgICAgIGhlaWdodDogNixcbiAgICAgICAgbGVmdDogW1xuICAgICAgICAgIGNoYXRRdWVyeUZuLm1ldHJpY0ludm9jYXRpb25zKHsgbGFiZWw6ICdDaGF0IFF1ZXJ5JywgcGVyaW9kOiBjZGsuRHVyYXRpb24uaG91cnMoMSkgfSksXG4gICAgICAgICAgc3luY0ZuLm1ldHJpY0ludm9jYXRpb25zKHsgbGFiZWw6ICdTeW5jIHRvIEF1cm9yYScsIHBlcmlvZDogY2RrLkR1cmF0aW9uLmhvdXJzKDEpIH0pLFxuICAgICAgICAgIGV2YWxGbi5tZXRyaWNJbnZvY2F0aW9ucyh7IGxhYmVsOiAnRGFpbHkgRXZhbHVhdGlvbicsIHBlcmlvZDogY2RrLkR1cmF0aW9uLmhvdXJzKDEpIH0pLFxuICAgICAgICBdLFxuICAgICAgfSksXG4gICAgICBuZXcgY2xvdWR3YXRjaC5HcmFwaFdpZGdldCh7XG4gICAgICAgIHRpdGxlOiAnTGFtYmRhIEVycm9ycycsXG4gICAgICAgIHdpZHRoOiAxMixcbiAgICAgICAgaGVpZ2h0OiA2LFxuICAgICAgICBsZWZ0OiBbXG4gICAgICAgICAgY2hhdFF1ZXJ5Rm4ubWV0cmljRXJyb3JzKHsgbGFiZWw6ICdDaGF0IFF1ZXJ5JywgcGVyaW9kOiBjZGsuRHVyYXRpb24uaG91cnMoMSkgfSksXG4gICAgICAgICAgc3luY0ZuLm1ldHJpY0Vycm9ycyh7IGxhYmVsOiAnU3luYyB0byBBdXJvcmEnLCBwZXJpb2Q6IGNkay5EdXJhdGlvbi5ob3VycygxKSB9KSxcbiAgICAgICAgICBldmFsRm4ubWV0cmljRXJyb3JzKHsgbGFiZWw6ICdEYWlseSBFdmFsdWF0aW9uJywgcGVyaW9kOiBjZGsuRHVyYXRpb24uaG91cnMoMSkgfSksXG4gICAgICAgIF0sXG4gICAgICAgIGxlZnRZQXhpczogeyBtaW46IDAsIGxhYmVsOiAnRXJyb3JzJyB9LFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIC8vIC0tIFJvdyAzOiBMYW1iZGEgRHVyYXRpb24gKyBBdXJvcmEgLS1cbiAgICBkYXNoYm9hcmQuYWRkV2lkZ2V0cyhcbiAgICAgIG5ldyBjbG91ZHdhdGNoLkdyYXBoV2lkZ2V0KHtcbiAgICAgICAgdGl0bGU6ICdMYW1iZGEgRHVyYXRpb24gKHA1MCAvIHA5OSknLFxuICAgICAgICB3aWR0aDogMTIsXG4gICAgICAgIGhlaWdodDogNixcbiAgICAgICAgbGVmdDogW1xuICAgICAgICAgIGNoYXRRdWVyeUZuLm1ldHJpY0R1cmF0aW9uKHsgc3RhdGlzdGljOiAncDUwJywgbGFiZWw6ICdDaGF0IFF1ZXJ5IHA1MCcsIHBlcmlvZDogY2RrLkR1cmF0aW9uLmhvdXJzKDEpIH0pLFxuICAgICAgICAgIGNoYXRRdWVyeUZuLm1ldHJpY0R1cmF0aW9uKHsgc3RhdGlzdGljOiAncDk5JywgbGFiZWw6ICdDaGF0IFF1ZXJ5IHA5OScsIHBlcmlvZDogY2RrLkR1cmF0aW9uLmhvdXJzKDEpIH0pLFxuICAgICAgICAgIHN5bmNGbi5tZXRyaWNEdXJhdGlvbih7IHN0YXRpc3RpYzogJ3A1MCcsIGxhYmVsOiAnU3luYyBwNTAnLCBwZXJpb2Q6IGNkay5EdXJhdGlvbi5ob3VycygxKSB9KSxcbiAgICAgICAgICBzeW5jRm4ubWV0cmljRHVyYXRpb24oeyBzdGF0aXN0aWM6ICdwOTknLCBsYWJlbDogJ1N5bmMgcDk5JywgcGVyaW9kOiBjZGsuRHVyYXRpb24uaG91cnMoMSkgfSksXG4gICAgICAgIF0sXG4gICAgICAgIGxlZnRZQXhpczogeyBtaW46IDAsIGxhYmVsOiAnRHVyYXRpb24gKG1zKScgfSxcbiAgICAgIH0pLFxuICAgICAgbmV3IGNsb3Vkd2F0Y2guR3JhcGhXaWRnZXQoe1xuICAgICAgICB0aXRsZTogJ0F1cm9yYSBTZXJ2ZXJsZXNzIENhcGFjaXR5IChBQ1UpJyxcbiAgICAgICAgd2lkdGg6IDEyLFxuICAgICAgICBoZWlnaHQ6IDYsXG4gICAgICAgIGxlZnQ6IFtcbiAgICAgICAgICBuZXcgY2xvdWR3YXRjaC5NZXRyaWMoe1xuICAgICAgICAgICAgbmFtZXNwYWNlOiAnQVdTL1JEUycsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnU2VydmVybGVzc0RhdGFiYXNlQ2FwYWNpdHknLFxuICAgICAgICAgICAgZGltZW5zaW9uc01hcDogeyBEQkNsdXN0ZXJJZGVudGlmaWVyOiB0aGlzLmNsdXN0ZXIuY2x1c3RlcklkZW50aWZpZXIgfSxcbiAgICAgICAgICAgIHN0YXRpc3RpYzogJ0F2ZXJhZ2UnLFxuICAgICAgICAgICAgbGFiZWw6ICdBdmcgQUNVJyxcbiAgICAgICAgICAgIHBlcmlvZDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICAgICAgfSksXG4gICAgICAgICAgbmV3IGNsb3Vkd2F0Y2guTWV0cmljKHtcbiAgICAgICAgICAgIG5hbWVzcGFjZTogJ0FXUy9SRFMnLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ1NlcnZlcmxlc3NEYXRhYmFzZUNhcGFjaXR5JyxcbiAgICAgICAgICAgIGRpbWVuc2lvbnNNYXA6IHsgREJDbHVzdGVySWRlbnRpZmllcjogdGhpcy5jbHVzdGVyLmNsdXN0ZXJJZGVudGlmaWVyIH0sXG4gICAgICAgICAgICBzdGF0aXN0aWM6ICdNYXhpbXVtJyxcbiAgICAgICAgICAgIGxhYmVsOiAnTWF4IEFDVScsXG4gICAgICAgICAgICBwZXJpb2Q6IGNkay5EdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgICAgIH0pLFxuICAgICAgICBdLFxuICAgICAgICBsZWZ0WUF4aXM6IHsgbWluOiAwLCBsYWJlbDogJ0FDVScgfSxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICAvLyAtLSBSb3cgNDogQXVyb3JhIENvbm5lY3Rpb25zICsgQ2hhdCBRdWVyeSBUaHJvdHRsZXMgLS1cbiAgICBkYXNoYm9hcmQuYWRkV2lkZ2V0cyhcbiAgICAgIG5ldyBjbG91ZHdhdGNoLkdyYXBoV2lkZ2V0KHtcbiAgICAgICAgdGl0bGU6ICdBdXJvcmEgRGF0YWJhc2UgQ29ubmVjdGlvbnMnLFxuICAgICAgICB3aWR0aDogMTIsXG4gICAgICAgIGhlaWdodDogNixcbiAgICAgICAgbGVmdDogW1xuICAgICAgICAgIG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICAgICAgICBuYW1lc3BhY2U6ICdBV1MvUkRTJyxcbiAgICAgICAgICAgIG1ldHJpY05hbWU6ICdEYXRhYmFzZUNvbm5lY3Rpb25zJyxcbiAgICAgICAgICAgIGRpbWVuc2lvbnNNYXA6IHsgREJDbHVzdGVySWRlbnRpZmllcjogdGhpcy5jbHVzdGVyLmNsdXN0ZXJJZGVudGlmaWVyIH0sXG4gICAgICAgICAgICBzdGF0aXN0aWM6ICdBdmVyYWdlJyxcbiAgICAgICAgICAgIGxhYmVsOiAnQ29ubmVjdGlvbnMnLFxuICAgICAgICAgICAgcGVyaW9kOiBjZGsuRHVyYXRpb24ubWludXRlcyg1KSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSxcbiAgICAgICAgbGVmdFlBeGlzOiB7IG1pbjogMCwgbGFiZWw6ICdDb25uZWN0aW9ucycgfSxcbiAgICAgIH0pLFxuICAgICAgbmV3IGNsb3Vkd2F0Y2guR3JhcGhXaWRnZXQoe1xuICAgICAgICB0aXRsZTogJ0xhbWJkYSBUaHJvdHRsZXMnLFxuICAgICAgICB3aWR0aDogMTIsXG4gICAgICAgIGhlaWdodDogNixcbiAgICAgICAgbGVmdDogW1xuICAgICAgICAgIGNoYXRRdWVyeUZuLm1ldHJpY1Rocm90dGxlcyh7IGxhYmVsOiAnQ2hhdCBRdWVyeScsIHBlcmlvZDogY2RrLkR1cmF0aW9uLmhvdXJzKDEpIH0pLFxuICAgICAgICAgIHN5bmNGbi5tZXRyaWNUaHJvdHRsZXMoeyBsYWJlbDogJ1N5bmMgdG8gQXVyb3JhJywgcGVyaW9kOiBjZGsuRHVyYXRpb24uaG91cnMoMSkgfSksXG4gICAgICAgIF0sXG4gICAgICAgIGxlZnRZQXhpczogeyBtaW46IDAsIGxhYmVsOiAnVGhyb3R0bGVzJyB9LFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gT3V0cHV0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0NsdXN0ZXJFbmRwb2ludCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmNsdXN0ZXIuY2x1c3RlckVuZHBvaW50Lmhvc3RuYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdBdXJvcmEgQW5hbHl0aWNzIGNsdXN0ZXIgZW5kcG9pbnQnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1NlY3JldEFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmNsdXN0ZXIuc2VjcmV0IS5zZWNyZXRBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0F1cm9yYSBjcmVkZW50aWFscyBzZWNyZXQgQVJOJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBbmFseXRpY3NEYXNoYm9hcmRVcmwnLCB7XG4gICAgICB2YWx1ZTogYGh0dHBzOi8vY29uc29sZS5hd3MuYW1hem9uLmNvbS9jbG91ZHdhdGNoL2hvbWU/cmVnaW9uPSR7Y2RrLkF3cy5SRUdJT059I2Rhc2hib2FyZHM6bmFtZT1Tb25nYmlyZC1BbmFseXRpY3NgLFxuICAgICAgZGVzY3JpcHRpb246ICdDbG91ZFdhdGNoIEFuYWx5dGljcyBEYXNoYm9hcmQgVVJMJyxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDb25maWd1cmUgUGhvZW5peCBPVExQIGVuZHBvaW50IGZvciB0cmFjaW5nXG4gICAqL1xuICBwdWJsaWMgY29uZmlndXJlUGhvZW5peFRyYWNpbmcoaHR0cEVuZHBvaW50OiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLmNoYXRRdWVyeUxhbWJkYS5hZGRFbnZpcm9ubWVudCgnUEhPRU5JWF9IVFRQX0VORFBPSU5UJywgaHR0cEVuZHBvaW50KTtcbiAgICB0aGlzLmNoYXRRdWVyeUxhbWJkYS5hZGRFbnZpcm9ubWVudCgnT1RFTF9TRVJWSUNFX05BTUUnLCAnc29uZ2JpcmQtYW5hbHl0aWNzLWNoYXQtcXVlcnknKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDb25maWd1cmUgUGhvZW5peCBQcm9tcHQgSHViIGZvciBydW50aW1lIHByb21wdCBmZXRjaGluZy5cbiAgICogU2V0cyBQSE9FTklYX0hPU1QgKHVzZWQgYnkgQGFyaXplYWkvcGhvZW5peC1jbGllbnQgU0RLKSBhbmQgUEhPRU5JWF9QUk9NUFRfVEFHLlxuICAgKi9cbiAgcHVibGljIGNvbmZpZ3VyZVBob2VuaXhQcm9tcHRzKHBob2VuaXhFbmRwb2ludDogc3RyaW5nLCBwcm9tcHRUYWc6IHN0cmluZyA9ICdwcm9kdWN0aW9uJyk6IHZvaWQge1xuICAgIHRoaXMuY2hhdFF1ZXJ5TGFtYmRhLmFkZEVudmlyb25tZW50KCdQSE9FTklYX0hPU1QnLCBwaG9lbml4RW5kcG9pbnQpO1xuICAgIHRoaXMuY2hhdFF1ZXJ5TGFtYmRhLmFkZEVudmlyb25tZW50KCdQSE9FTklYX1BST01QVF9UQUcnLCBwcm9tcHRUYWcpO1xuICB9XG5cbn1cbiJdfQ==