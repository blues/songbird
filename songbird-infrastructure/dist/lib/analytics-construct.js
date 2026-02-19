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
        const syncLambda = new aws_lambda_nodejs_1.NodejsFunction(this, 'SyncLambda', {
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
        this.cluster.grantDataApiAccess(syncLambda);
        // Add DynamoDB stream sources
        syncLambda.addEventSource(new aws_lambda_event_sources_1.DynamoEventSource(props.devicesTable, {
            startingPosition: lambda.StartingPosition.TRIM_HORIZON,
            batchSize: 100,
            bisectBatchOnError: true,
            retryAttempts: 3,
        }));
        syncLambda.addEventSource(new aws_lambda_event_sources_1.DynamoEventSource(props.telemetryTable, {
            startingPosition: lambda.StartingPosition.TRIM_HORIZON,
            batchSize: 100,
            bisectBatchOnError: true,
            retryAttempts: 3,
        }));
        syncLambda.addEventSource(new aws_lambda_event_sources_1.DynamoEventSource(props.locationsTable, {
            startingPosition: lambda.StartingPosition.TRIM_HORIZON,
            batchSize: 100,
            bisectBatchOnError: true,
            retryAttempts: 3,
        }));
        syncLambda.addEventSource(new aws_lambda_event_sources_1.DynamoEventSource(props.alertsTable, {
            startingPosition: lambda.StartingPosition.TRIM_HORIZON,
            batchSize: 100,
            bisectBatchOnError: true,
            retryAttempts: 3,
        }));
        syncLambda.addEventSource(new aws_lambda_event_sources_1.DynamoEventSource(props.journeysTable, {
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
        // Grant Bedrock access
        this.chatQueryLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['bedrock:InvokeModel'],
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
    }
    /**
     * Configure Phoenix OTLP endpoint for tracing
     */
    configurePhoenixTracing(otlpEndpoint) {
        this.chatQueryLambda.addEnvironment('PHOENIX_COLLECTOR_ENDPOINT', otlpEndpoint);
        this.chatQueryLambda.addEnvironment('OTEL_SERVICE_NAME', 'songbird-analytics-chat-query');
        // Force OTLP to use HTTP protocol instead of gRPC
        this.chatQueryLambda.addEnvironment('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/protobuf');
    }
}
exports.AnalyticsConstruct = AnalyticsConstruct;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYW5hbHl0aWNzLWNvbnN0cnVjdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL2xpYi9hbmFseXRpY3MtY29uc3RydWN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7R0FLRzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFFSCxpREFBbUM7QUFDbkMseURBQTJDO0FBQzNDLHlEQUEyQztBQUMzQyxtRUFBcUQ7QUFDckQsK0RBQWlEO0FBQ2pELDJEQUE2QztBQUM3Qyx5REFBMkM7QUFDM0MsbUZBQXlFO0FBQ3pFLHFFQUErRDtBQUMvRCwyQ0FBdUM7QUFDdkMsMkNBQTZCO0FBVTdCLE1BQWEsa0JBQW1CLFNBQVEsc0JBQVM7SUFDL0IsT0FBTyxDQUFzQjtJQUM3QixnQkFBZ0IsQ0FBaUI7SUFDakMsZUFBZSxDQUFrQjtJQUNqQyxpQkFBaUIsQ0FBa0I7SUFDbkMsa0JBQWtCLENBQWtCO0lBQ3BDLGdCQUFnQixDQUFrQjtJQUNsQyxtQkFBbUIsQ0FBa0I7SUFDckMsZ0JBQWdCLENBQWtCO0lBQ2xDLEdBQUcsQ0FBVTtJQUU3QixZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQThCO1FBQ3RFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsNkVBQTZFO1FBQzdFLCtCQUErQjtRQUMvQiw2RUFBNkU7UUFDN0UsSUFBSSxDQUFDLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRTtZQUMzQyxNQUFNLEVBQUUsQ0FBQztZQUNULFdBQVcsRUFBRSxDQUFDO1lBQ2QsbUJBQW1CLEVBQUU7Z0JBQ25CO29CQUNFLFFBQVEsRUFBRSxFQUFFO29CQUNaLElBQUksRUFBRSxRQUFRO29CQUNkLFVBQVUsRUFBRSxHQUFHLENBQUMsVUFBVSxDQUFDLE1BQU07aUJBQ2xDO2dCQUNEO29CQUNFLFFBQVEsRUFBRSxFQUFFO29CQUNaLElBQUksRUFBRSxTQUFTO29C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QUMsQ0FBQztRQUNoRCxLQUFLLENBQUMsYUFBYSxDQUFDLGFBQWEsQ0FBQyxjQUFjLENBQUMsQ0FBQztRQUVsRCw2RUFBNkU7UUFDN0UsVUFBVTtRQUNWLDZFQUE2RTtRQUM3RSxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGlCQUFpQixFQUFFO1lBQ3pDLEtBQUssRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLGVBQWUsQ0FBQyxRQUFRO1lBQzVDLFdBQVcsRUFBRSxtQ0FBbUM7U0FDakQsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxXQUFXLEVBQUU7WUFDbkMsS0FBSyxFQUFFLElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTyxDQUFDLFNBQVM7WUFDckMsV0FBVyxFQUFFLCtCQUErQjtTQUM3QyxDQUFDLENBQUM7SUFDTCxDQUFDO0lBRUQ7O09BRUc7SUFDSSx1QkFBdUIsQ0FBQyxZQUFvQjtRQUNqRCxJQUFJLENBQUMsZUFBZSxDQUFDLGNBQWMsQ0FBQyw0QkFBNEIsRUFBRSxZQUFZLENBQUMsQ0FBQztRQUNoRixJQUFJLENBQUMsZUFBZSxDQUFDLGNBQWMsQ0FBQyxtQkFBbUIsRUFBRSwrQkFBK0IsQ0FBQyxDQUFDO1FBQzFGLGtEQUFrRDtRQUNsRCxJQUFJLENBQUMsZUFBZSxDQUFDLGNBQWMsQ0FBQyw2QkFBNkIsRUFBRSxlQUFlLENBQUMsQ0FBQztJQUN0RixDQUFDO0NBQ0Y7QUE3V0QsZ0RBNldDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBBbmFseXRpY3MgQ29uc3RydWN0XG4gKlxuICogUHJvdmlkZXMgVGV4dC10by1TUUwgYW5hbHl0aWNzIHBvd2VyZWQgYnkgQVdTIEJlZHJvY2sgKENsYXVkZSkgYW5kIEF1cm9yYSBTZXJ2ZXJsZXNzIHYyLlxuICogSW5jbHVkZXMgcmVhbC10aW1lIER5bmFtb0RCIOKGkiBBdXJvcmEgc3luYyB2aWEgc3RyZWFtcy5cbiAqL1xuXG5pbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xuaW1wb3J0ICogYXMgcmRzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1yZHMnO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiJztcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxvZ3MnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0IHsgRHluYW1vRXZlbnRTb3VyY2UgfSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhLWV2ZW50LXNvdXJjZXMnO1xuaW1wb3J0IHsgTm9kZWpzRnVuY3Rpb24gfSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhLW5vZGVqcyc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQW5hbHl0aWNzQ29uc3RydWN0UHJvcHMge1xuICBkZXZpY2VzVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICB0ZWxlbWV0cnlUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIGxvY2F0aW9uc1RhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbiAgYWxlcnRzVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBqb3VybmV5c1RhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbn1cblxuZXhwb3J0IGNsYXNzIEFuYWx5dGljc0NvbnN0cnVjdCBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBjbHVzdGVyOiByZHMuRGF0YWJhc2VDbHVzdGVyO1xuICBwdWJsaWMgcmVhZG9ubHkgY2hhdEhpc3RvcnlUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSBjaGF0UXVlcnlMYW1iZGE6IGxhbWJkYS5GdW5jdGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IGNoYXRIaXN0b3J5TGFtYmRhOiBsYW1iZGEuRnVuY3Rpb247XG4gIHB1YmxpYyByZWFkb25seSBsaXN0U2Vzc2lvbnNMYW1iZGE6IGxhbWJkYS5GdW5jdGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IGdldFNlc3Npb25MYW1iZGE6IGxhbWJkYS5GdW5jdGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IGRlbGV0ZVNlc3Npb25MYW1iZGE6IGxhbWJkYS5GdW5jdGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IHJlcnVuUXVlcnlMYW1iZGE6IGxhbWJkYS5GdW5jdGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IHZwYzogZWMyLlZwYztcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQW5hbHl0aWNzQ29uc3RydWN0UHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBWUEMgZm9yIEF1cm9yYSBTZXJ2ZXJsZXNzIHYyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLnZwYyA9IG5ldyBlYzIuVnBjKHRoaXMsICdBbmFseXRpY3NWcGMnLCB7XG4gICAgICBtYXhBenM6IDIsXG4gICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgIHN1Ym5ldENvbmZpZ3VyYXRpb246IFtcbiAgICAgICAge1xuICAgICAgICAgIGNpZHJNYXNrOiAyNCxcbiAgICAgICAgICBuYW1lOiAnUHVibGljJyxcbiAgICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QVUJMSUMsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBjaWRyTWFzazogMjQsXG4gICAgICAgICAgbmFtZTogJ1ByaXZhdGUnLFxuICAgICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBjaWRyTWFzazogMjgsXG4gICAgICAgICAgbmFtZTogJ0lzb2xhdGVkJyxcbiAgICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX0lTT0xBVEVELFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQXVyb3JhIFNlcnZlcmxlc3MgdjIgQ2x1c3RlclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5jbHVzdGVyID0gbmV3IHJkcy5EYXRhYmFzZUNsdXN0ZXIodGhpcywgJ0FuYWx5dGljc0NsdXN0ZXInLCB7XG4gICAgICBlbmdpbmU6IHJkcy5EYXRhYmFzZUNsdXN0ZXJFbmdpbmUuYXVyb3JhUG9zdGdyZXMoe1xuICAgICAgICB2ZXJzaW9uOiByZHMuQXVyb3JhUG9zdGdyZXNFbmdpbmVWZXJzaW9uLlZFUl8xNl80LFxuICAgICAgfSksXG4gICAgICB2cGM6IHRoaXMudnBjLFxuICAgICAgdnBjU3VibmV0czogeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX0lTT0xBVEVEIH0sXG4gICAgICB3cml0ZXI6IHJkcy5DbHVzdGVySW5zdGFuY2Uuc2VydmVybGVzc1YyKCd3cml0ZXInLCB7XG4gICAgICAgIGF1dG9NaW5vclZlcnNpb25VcGdyYWRlOiB0cnVlLFxuICAgICAgfSksXG4gICAgICBzZXJ2ZXJsZXNzVjJNaW5DYXBhY2l0eTogMC41LFxuICAgICAgc2VydmVybGVzc1YyTWF4Q2FwYWNpdHk6IDQsXG4gICAgICBkZWZhdWx0RGF0YWJhc2VOYW1lOiAnc29uZ2JpcmRfYW5hbHl0aWNzJyxcbiAgICAgIGVuYWJsZURhdGFBcGk6IHRydWUsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgc3RvcmFnZUVuY3J5cHRlZDogdHJ1ZSxcbiAgICAgIGJhY2t1cDoge1xuICAgICAgICByZXRlbnRpb246IGNkay5EdXJhdGlvbi5kYXlzKDcpLFxuICAgICAgICBwcmVmZXJyZWRXaW5kb3c6ICcwMzowMC0wNDowMCcsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBEeW5hbW9EQiBUYWJsZSBmb3IgQ2hhdCBIaXN0b3J5XG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLmNoYXRIaXN0b3J5VGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgJ0NoYXRIaXN0b3J5VGFibGUnLCB7XG4gICAgICB0YWJsZU5hbWU6ICdzb25nYmlyZC1jaGF0LWhpc3RvcnknLFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICd1c2VyX2VtYWlsJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAndGltZXN0YW1wJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5OVU1CRVIsXG4gICAgICB9LFxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiAndHRsJyxcbiAgICB9KTtcblxuICAgIC8vIEdTSSBmb3IgcXVlcnlpbmcgYnkgc2Vzc2lvblxuICAgIHRoaXMuY2hhdEhpc3RvcnlUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6ICdzZXNzaW9uLWluZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnc2Vzc2lvbl9pZCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIHNvcnRLZXk6IHtcbiAgICAgICAgbmFtZTogJ3RpbWVzdGFtcCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSLFxuICAgICAgfSxcbiAgICAgIHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIExhbWJkYTogU2NoZW1hIEluaXRpYWxpemF0aW9uXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBpbml0U2NoZW1hTGFtYmRhID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdJbml0U2NoZW1hTGFtYmRhJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYW5hbHl0aWNzLWluaXQtc2NoZW1hJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnSW5pdGlhbGl6ZSBBdXJvcmEgYW5hbHl0aWNzIHNjaGVtYScsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FuYWx5dGljcy9pbml0LXNjaGVtYS50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApLFxuICAgICAgbWVtb3J5U2l6ZTogNTEyLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQ0xVU1RFUl9BUk46IHRoaXMuY2x1c3Rlci5jbHVzdGVyQXJuLFxuICAgICAgICBTRUNSRVRfQVJOOiB0aGlzLmNsdXN0ZXIuc2VjcmV0IS5zZWNyZXRBcm4sXG4gICAgICAgIERBVEFCQVNFX05BTUU6ICdzb25nYmlyZF9hbmFseXRpY3MnLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG5cbiAgICB0aGlzLmNsdXN0ZXIuZ3JhbnREYXRhQXBpQWNjZXNzKGluaXRTY2hlbWFMYW1iZGEpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBMYW1iZGE6IER5bmFtb0RCIOKGkiBBdXJvcmEgU3luY1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3Qgc3luY0xhbWJkYSA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnU3luY0xhbWJkYScsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFuYWx5dGljcy1zeW5jJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU3luYyBEeW5hbW9EQiBzdHJlYW1zIHRvIEF1cm9yYScsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FuYWx5dGljcy9zeW5jLXRvLWF1cm9yYS50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApLFxuICAgICAgbWVtb3J5U2l6ZTogNTEyLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQ0xVU1RFUl9BUk46IHRoaXMuY2x1c3Rlci5jbHVzdGVyQXJuLFxuICAgICAgICBTRUNSRVRfQVJOOiB0aGlzLmNsdXN0ZXIuc2VjcmV0IS5zZWNyZXRBcm4sXG4gICAgICAgIERBVEFCQVNFX05BTUU6ICdzb25nYmlyZF9hbmFseXRpY3MnLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgICB2cGM6IHRoaXMudnBjLFxuICAgICAgdnBjU3VibmV0czogeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTIH0sXG4gICAgfSk7XG5cbiAgICB0aGlzLmNsdXN0ZXIuZ3JhbnREYXRhQXBpQWNjZXNzKHN5bmNMYW1iZGEpO1xuXG4gICAgLy8gQWRkIER5bmFtb0RCIHN0cmVhbSBzb3VyY2VzXG4gICAgc3luY0xhbWJkYS5hZGRFdmVudFNvdXJjZShuZXcgRHluYW1vRXZlbnRTb3VyY2UocHJvcHMuZGV2aWNlc1RhYmxlLCB7XG4gICAgICBzdGFydGluZ1Bvc2l0aW9uOiBsYW1iZGEuU3RhcnRpbmdQb3NpdGlvbi5UUklNX0hPUklaT04sXG4gICAgICBiYXRjaFNpemU6IDEwMCxcbiAgICAgIGJpc2VjdEJhdGNoT25FcnJvcjogdHJ1ZSxcbiAgICAgIHJldHJ5QXR0ZW1wdHM6IDMsXG4gICAgfSkpO1xuXG4gICAgc3luY0xhbWJkYS5hZGRFdmVudFNvdXJjZShuZXcgRHluYW1vRXZlbnRTb3VyY2UocHJvcHMudGVsZW1ldHJ5VGFibGUsIHtcbiAgICAgIHN0YXJ0aW5nUG9zaXRpb246IGxhbWJkYS5TdGFydGluZ1Bvc2l0aW9uLlRSSU1fSE9SSVpPTixcbiAgICAgIGJhdGNoU2l6ZTogMTAwLFxuICAgICAgYmlzZWN0QmF0Y2hPbkVycm9yOiB0cnVlLFxuICAgICAgcmV0cnlBdHRlbXB0czogMyxcbiAgICB9KSk7XG5cbiAgICBzeW5jTGFtYmRhLmFkZEV2ZW50U291cmNlKG5ldyBEeW5hbW9FdmVudFNvdXJjZShwcm9wcy5sb2NhdGlvbnNUYWJsZSwge1xuICAgICAgc3RhcnRpbmdQb3NpdGlvbjogbGFtYmRhLlN0YXJ0aW5nUG9zaXRpb24uVFJJTV9IT1JJWk9OLFxuICAgICAgYmF0Y2hTaXplOiAxMDAsXG4gICAgICBiaXNlY3RCYXRjaE9uRXJyb3I6IHRydWUsXG4gICAgICByZXRyeUF0dGVtcHRzOiAzLFxuICAgIH0pKTtcblxuICAgIHN5bmNMYW1iZGEuYWRkRXZlbnRTb3VyY2UobmV3IER5bmFtb0V2ZW50U291cmNlKHByb3BzLmFsZXJ0c1RhYmxlLCB7XG4gICAgICBzdGFydGluZ1Bvc2l0aW9uOiBsYW1iZGEuU3RhcnRpbmdQb3NpdGlvbi5UUklNX0hPUklaT04sXG4gICAgICBiYXRjaFNpemU6IDEwMCxcbiAgICAgIGJpc2VjdEJhdGNoT25FcnJvcjogdHJ1ZSxcbiAgICAgIHJldHJ5QXR0ZW1wdHM6IDMsXG4gICAgfSkpO1xuXG4gICAgc3luY0xhbWJkYS5hZGRFdmVudFNvdXJjZShuZXcgRHluYW1vRXZlbnRTb3VyY2UocHJvcHMuam91cm5leXNUYWJsZSwge1xuICAgICAgc3RhcnRpbmdQb3NpdGlvbjogbGFtYmRhLlN0YXJ0aW5nUG9zaXRpb24uVFJJTV9IT1JJWk9OLFxuICAgICAgYmF0Y2hTaXplOiAxMDAsXG4gICAgICBiaXNlY3RCYXRjaE9uRXJyb3I6IHRydWUsXG4gICAgICByZXRyeUF0dGVtcHRzOiAzLFxuICAgIH0pKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTGFtYmRhOiBDaGF0IFF1ZXJ5IChUZXh0LXRvLVNRTClcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuY2hhdFF1ZXJ5TGFtYmRhID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdDaGF0UXVlcnlMYW1iZGEnLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hbmFseXRpY3MtY2hhdC1xdWVyeScsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FuYWx5dGljcyBjaGF0IHF1ZXJ5IHdpdGggQmVkcm9jaycsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FuYWx5dGljcy9jaGF0LXF1ZXJ5LnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg2MCksXG4gICAgICBtZW1vcnlTaXplOiAxMDI0LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQ0xVU1RFUl9BUk46IHRoaXMuY2x1c3Rlci5jbHVzdGVyQXJuLFxuICAgICAgICBTRUNSRVRfQVJOOiB0aGlzLmNsdXN0ZXIuc2VjcmV0IS5zZWNyZXRBcm4sXG4gICAgICAgIERBVEFCQVNFX05BTUU6ICdzb25nYmlyZF9hbmFseXRpY3MnLFxuICAgICAgICBDSEFUX0hJU1RPUllfVEFCTEU6IHRoaXMuY2hhdEhpc3RvcnlUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIEJFRFJPQ0tfTU9ERUxfSUQ6ICd1cy5hbnRocm9waWMuY2xhdWRlLTMtNS1zb25uZXQtMjAyNDEwMjItdjI6MCcsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICAgIHZwYzogdGhpcy52cGMsXG4gICAgICB2cGNTdWJuZXRzOiB7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MgfSxcbiAgICB9KTtcblxuICAgIHRoaXMuY2x1c3Rlci5ncmFudERhdGFBcGlBY2Nlc3ModGhpcy5jaGF0UXVlcnlMYW1iZGEpO1xuICAgIHRoaXMuY2hhdEhpc3RvcnlUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEodGhpcy5jaGF0UXVlcnlMYW1iZGEpO1xuXG4gICAgLy8gR3JhbnQgQmVkcm9jayBhY2Nlc3NcbiAgICB0aGlzLmNoYXRRdWVyeUxhbWJkYS5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogWydiZWRyb2NrOkludm9rZU1vZGVsJ10sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgIH0pKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTGFtYmRhOiBDaGF0IEhpc3RvcnlcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuY2hhdEhpc3RvcnlMYW1iZGEgPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0NoYXRIaXN0b3J5TGFtYmRhJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYW5hbHl0aWNzLWNoYXQtaGlzdG9yeScsXG4gICAgICBkZXNjcmlwdGlvbjogJ1JldHJpZXZlIGFuYWx5dGljcyBjaGF0IGhpc3RvcnknLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hbmFseXRpY3MvY2hhdC1oaXN0b3J5LnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBDSEFUX0hJU1RPUllfVEFCTEU6IHRoaXMuY2hhdEhpc3RvcnlUYWJsZS50YWJsZU5hbWUsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcblxuICAgIHRoaXMuY2hhdEhpc3RvcnlUYWJsZS5ncmFudFJlYWREYXRhKHRoaXMuY2hhdEhpc3RvcnlMYW1iZGEpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBMYW1iZGE6IExpc3QgU2Vzc2lvbnNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMubGlzdFNlc3Npb25zTGFtYmRhID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdMaXN0U2Vzc2lvbnNMYW1iZGEnLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hbmFseXRpY3MtbGlzdC1zZXNzaW9ucycsXG4gICAgICBkZXNjcmlwdGlvbjogJ0xpc3QgYW5hbHl0aWNzIGNoYXQgc2Vzc2lvbnMnLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hbmFseXRpY3MvbGlzdC1zZXNzaW9ucy50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQ0hBVF9ISVNUT1JZX1RBQkxFOiB0aGlzLmNoYXRIaXN0b3J5VGFibGUudGFibGVOYW1lLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG5cbiAgICB0aGlzLmNoYXRIaXN0b3J5VGFibGUuZ3JhbnRSZWFkRGF0YSh0aGlzLmxpc3RTZXNzaW9uc0xhbWJkYSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIExhbWJkYTogR2V0IFNlc3Npb25cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuZ2V0U2Vzc2lvbkxhbWJkYSA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnR2V0U2Vzc2lvbkxhbWJkYScsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFuYWx5dGljcy1nZXQtc2Vzc2lvbicsXG4gICAgICBkZXNjcmlwdGlvbjogJ0dldCBhbmFseXRpY3MgY2hhdCBzZXNzaW9uIGRldGFpbHMnLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hbmFseXRpY3MvZ2V0LXNlc3Npb24udHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIENIQVRfSElTVE9SWV9UQUJMRTogdGhpcy5jaGF0SGlzdG9yeVRhYmxlLnRhYmxlTmFtZSxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuXG4gICAgdGhpcy5jaGF0SGlzdG9yeVRhYmxlLmdyYW50UmVhZERhdGEodGhpcy5nZXRTZXNzaW9uTGFtYmRhKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTGFtYmRhOiBEZWxldGUgU2Vzc2lvblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5kZWxldGVTZXNzaW9uTGFtYmRhID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdEZWxldGVTZXNzaW9uTGFtYmRhJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYW5hbHl0aWNzLWRlbGV0ZS1zZXNzaW9uJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRGVsZXRlIGFuYWx5dGljcyBjaGF0IHNlc3Npb24nLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hbmFseXRpY3MvZGVsZXRlLXNlc3Npb24udHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIENIQVRfSElTVE9SWV9UQUJMRTogdGhpcy5jaGF0SGlzdG9yeVRhYmxlLnRhYmxlTmFtZSxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuXG4gICAgdGhpcy5jaGF0SGlzdG9yeVRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YSh0aGlzLmRlbGV0ZVNlc3Npb25MYW1iZGEpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBMYW1iZGE6IFJlcnVuIFF1ZXJ5IChyZS1leGVjdXRlIHN0b3JlZCBTUUwgZm9yIHZpc3VhbGl6YXRpb25zKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5yZXJ1blF1ZXJ5TGFtYmRhID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdSZXJ1blF1ZXJ5TGFtYmRhJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYW5hbHl0aWNzLXJlcnVuLXF1ZXJ5JyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUmUtZXhlY3V0ZSBzdG9yZWQgU1FMIHF1ZXJ5IGZvciB2aXN1YWxpemF0aW9ucycsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FuYWx5dGljcy9yZXJ1bi1xdWVyeS50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApLFxuICAgICAgbWVtb3J5U2l6ZTogNTEyLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQ0xVU1RFUl9BUk46IHRoaXMuY2x1c3Rlci5jbHVzdGVyQXJuLFxuICAgICAgICBTRUNSRVRfQVJOOiB0aGlzLmNsdXN0ZXIuc2VjcmV0IS5zZWNyZXRBcm4sXG4gICAgICAgIERBVEFCQVNFX05BTUU6ICdzb25nYmlyZF9hbmFseXRpY3MnLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgICB2cGM6IHRoaXMudnBjLFxuICAgICAgdnBjU3VibmV0czogeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTIH0sXG4gICAgfSk7XG5cbiAgICB0aGlzLmNsdXN0ZXIuZ3JhbnREYXRhQXBpQWNjZXNzKHRoaXMucmVydW5RdWVyeUxhbWJkYSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIExhbWJkYTogQmFja2ZpbGwgKG9uZS10aW1lIGhpc3RvcmljYWwgZGF0YSBtaWdyYXRpb24pXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBiYWNrZmlsbExhbWJkYSA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnQmFja2ZpbGxMYW1iZGEnLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hbmFseXRpY3MtYmFja2ZpbGwnLFxuICAgICAgZGVzY3JpcHRpb246ICdCYWNrZmlsbCBoaXN0b3JpY2FsIER5bmFtb0RCIGRhdGEgdG8gQXVyb3JhJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYW5hbHl0aWNzL2JhY2tmaWxsLnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcygxNSksXG4gICAgICBtZW1vcnlTaXplOiAxMDI0LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQ0xVU1RFUl9BUk46IHRoaXMuY2x1c3Rlci5jbHVzdGVyQXJuLFxuICAgICAgICBTRUNSRVRfQVJOOiB0aGlzLmNsdXN0ZXIuc2VjcmV0IS5zZWNyZXRBcm4sXG4gICAgICAgIERBVEFCQVNFX05BTUU6ICdzb25nYmlyZF9hbmFseXRpY3MnLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG5cbiAgICB0aGlzLmNsdXN0ZXIuZ3JhbnREYXRhQXBpQWNjZXNzKGJhY2tmaWxsTGFtYmRhKTtcbiAgICBwcm9wcy5kZXZpY2VzVGFibGUuZ3JhbnRSZWFkRGF0YShiYWNrZmlsbExhbWJkYSk7XG4gICAgcHJvcHMudGVsZW1ldHJ5VGFibGUuZ3JhbnRSZWFkRGF0YShiYWNrZmlsbExhbWJkYSk7XG4gICAgcHJvcHMubG9jYXRpb25zVGFibGUuZ3JhbnRSZWFkRGF0YShiYWNrZmlsbExhbWJkYSk7XG4gICAgcHJvcHMuYWxlcnRzVGFibGUuZ3JhbnRSZWFkRGF0YShiYWNrZmlsbExhbWJkYSk7XG4gICAgcHJvcHMuam91cm5leXNUYWJsZS5ncmFudFJlYWREYXRhKGJhY2tmaWxsTGFtYmRhKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gT3V0cHV0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0NsdXN0ZXJFbmRwb2ludCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmNsdXN0ZXIuY2x1c3RlckVuZHBvaW50Lmhvc3RuYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdBdXJvcmEgQW5hbHl0aWNzIGNsdXN0ZXIgZW5kcG9pbnQnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1NlY3JldEFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmNsdXN0ZXIuc2VjcmV0IS5zZWNyZXRBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0F1cm9yYSBjcmVkZW50aWFscyBzZWNyZXQgQVJOJyxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDb25maWd1cmUgUGhvZW5peCBPVExQIGVuZHBvaW50IGZvciB0cmFjaW5nXG4gICAqL1xuICBwdWJsaWMgY29uZmlndXJlUGhvZW5peFRyYWNpbmcob3RscEVuZHBvaW50OiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLmNoYXRRdWVyeUxhbWJkYS5hZGRFbnZpcm9ubWVudCgnUEhPRU5JWF9DT0xMRUNUT1JfRU5EUE9JTlQnLCBvdGxwRW5kcG9pbnQpO1xuICAgIHRoaXMuY2hhdFF1ZXJ5TGFtYmRhLmFkZEVudmlyb25tZW50KCdPVEVMX1NFUlZJQ0VfTkFNRScsICdzb25nYmlyZC1hbmFseXRpY3MtY2hhdC1xdWVyeScpO1xuICAgIC8vIEZvcmNlIE9UTFAgdG8gdXNlIEhUVFAgcHJvdG9jb2wgaW5zdGVhZCBvZiBnUlBDXG4gICAgdGhpcy5jaGF0UXVlcnlMYW1iZGEuYWRkRW52aXJvbm1lbnQoJ09URUxfRVhQT1JURVJfT1RMUF9QUk9UT0NPTCcsICdodHRwL3Byb3RvYnVmJyk7XG4gIH1cbn1cbiJdfQ==