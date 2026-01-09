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
    constructor(scope, id, props) {
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
            vpc,
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
}
exports.AnalyticsConstruct = AnalyticsConstruct;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYW5hbHl0aWNzLWNvbnN0cnVjdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL2xpYi9hbmFseXRpY3MtY29uc3RydWN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7R0FLRzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFFSCxpREFBbUM7QUFDbkMseURBQTJDO0FBQzNDLHlEQUEyQztBQUMzQyxtRUFBcUQ7QUFDckQsK0RBQWlEO0FBQ2pELDJEQUE2QztBQUM3Qyx5REFBMkM7QUFDM0MsbUZBQXlFO0FBQ3pFLHFFQUErRDtBQUMvRCwyQ0FBdUM7QUFDdkMsMkNBQTZCO0FBVTdCLE1BQWEsa0JBQW1CLFNBQVEsc0JBQVM7SUFDL0IsT0FBTyxDQUFzQjtJQUM3QixnQkFBZ0IsQ0FBaUI7SUFDakMsZUFBZSxDQUFrQjtJQUNqQyxpQkFBaUIsQ0FBa0I7SUFFbkQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUE4QjtRQUN0RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLDZFQUE2RTtRQUM3RSwrQkFBK0I7UUFDL0IsNkVBQTZFO1FBQzdFLE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFO1lBQzVDLE1BQU0sRUFBRSxDQUFDO1lBQ1QsV0FBVyxFQUFFLENBQUM7WUFDZCxtQkFBbUIsRUFBRTtnQkFDbkI7b0JBQ0UsUUFBUSxFQUFFLEVBQUU7b0JBQ1osSUFBSSxFQUFFLFFBQVE7b0JBQ2QsVUFBVSxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsTUFBTTtpQkFDbEM7Z0JBQ0Q7b0JBQ0UsUUFBUSxFQUFFLEVBQUU7b0JBQ1osSUFBSSxFQUFFLFNBQVM7b0JBQ2YsVUFBVSxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsbUJBQW1CO2lCQUMvQztnQkFDRDtvQkFDRSxRQUFRLEVBQUUsRUFBRTtvQkFDWixJQUFJLEVBQUUsVUFBVTtv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QUFDO1FBQ2hELEtBQUssQ0FBQyxhQUFhLENBQUMsYUFBYSxDQUFDLGNBQWMsQ0FBQyxDQUFDO1FBRWxELDZFQUE2RTtRQUM3RSxVQUFVO1FBQ1YsNkVBQTZFO1FBQzdFLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUU7WUFDekMsS0FBSyxFQUFFLElBQUksQ0FBQyxPQUFPLENBQUMsZUFBZSxDQUFDLFFBQVE7WUFDNUMsV0FBVyxFQUFFLG1DQUFtQztTQUNqRCxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLFdBQVcsRUFBRTtZQUNuQyxLQUFLLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFPLENBQUMsU0FBUztZQUNyQyxXQUFXLEVBQUUsK0JBQStCO1NBQzdDLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQTFRRCxnREEwUUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEFuYWx5dGljcyBDb25zdHJ1Y3RcbiAqXG4gKiBQcm92aWRlcyBUZXh0LXRvLVNRTCBhbmFseXRpY3MgcG93ZXJlZCBieSBBV1MgQmVkcm9jayAoQ2xhdWRlKSBhbmQgQXVyb3JhIFNlcnZlcmxlc3MgdjIuXG4gKiBJbmNsdWRlcyByZWFsLXRpbWUgRHluYW1vREIg4oaSIEF1cm9yYSBzeW5jIHZpYSBzdHJlYW1zLlxuICovXG5cbmltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjMic7XG5pbXBvcnQgKiBhcyByZHMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXJkcyc7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGInO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgeyBEeW5hbW9FdmVudFNvdXJjZSB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEtZXZlbnQtc291cmNlcyc7XG5pbXBvcnQgeyBOb2RlanNGdW5jdGlvbiB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEtbm9kZWpzJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcblxuZXhwb3J0IGludGVyZmFjZSBBbmFseXRpY3NDb25zdHJ1Y3RQcm9wcyB7XG4gIGRldmljZXNUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIHRlbGVtZXRyeVRhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbiAgbG9jYXRpb25zVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBhbGVydHNUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIGpvdXJuZXlzVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xufVxuXG5leHBvcnQgY2xhc3MgQW5hbHl0aWNzQ29uc3RydWN0IGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGNsdXN0ZXI6IHJkcy5EYXRhYmFzZUNsdXN0ZXI7XG4gIHB1YmxpYyByZWFkb25seSBjaGF0SGlzdG9yeVRhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbiAgcHVibGljIHJlYWRvbmx5IGNoYXRRdWVyeUxhbWJkYTogbGFtYmRhLkZ1bmN0aW9uO1xuICBwdWJsaWMgcmVhZG9ubHkgY2hhdEhpc3RvcnlMYW1iZGE6IGxhbWJkYS5GdW5jdGlvbjtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQW5hbHl0aWNzQ29uc3RydWN0UHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBWUEMgZm9yIEF1cm9yYSBTZXJ2ZXJsZXNzIHYyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCB2cGMgPSBuZXcgZWMyLlZwYyh0aGlzLCAnQW5hbHl0aWNzVnBjJywge1xuICAgICAgbWF4QXpzOiAyLFxuICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICBzdWJuZXRDb25maWd1cmF0aW9uOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBjaWRyTWFzazogMjQsXG4gICAgICAgICAgbmFtZTogJ1B1YmxpYycsXG4gICAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFVCTElDLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgY2lkck1hc2s6IDI0LFxuICAgICAgICAgIG5hbWU6ICdQcml2YXRlJyxcbiAgICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgY2lkck1hc2s6IDI4LFxuICAgICAgICAgIG5hbWU6ICdJc29sYXRlZCcsXG4gICAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9JU09MQVRFRCxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEF1cm9yYSBTZXJ2ZXJsZXNzIHYyIENsdXN0ZXJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuY2x1c3RlciA9IG5ldyByZHMuRGF0YWJhc2VDbHVzdGVyKHRoaXMsICdBbmFseXRpY3NDbHVzdGVyJywge1xuICAgICAgZW5naW5lOiByZHMuRGF0YWJhc2VDbHVzdGVyRW5naW5lLmF1cm9yYVBvc3RncmVzKHtcbiAgICAgICAgdmVyc2lvbjogcmRzLkF1cm9yYVBvc3RncmVzRW5naW5lVmVyc2lvbi5WRVJfMTZfNCxcbiAgICAgIH0pLFxuICAgICAgdnBjLFxuICAgICAgdnBjU3VibmV0czogeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX0lTT0xBVEVEIH0sXG4gICAgICB3cml0ZXI6IHJkcy5DbHVzdGVySW5zdGFuY2Uuc2VydmVybGVzc1YyKCd3cml0ZXInLCB7XG4gICAgICAgIGF1dG9NaW5vclZlcnNpb25VcGdyYWRlOiB0cnVlLFxuICAgICAgfSksXG4gICAgICBzZXJ2ZXJsZXNzVjJNaW5DYXBhY2l0eTogMC41LFxuICAgICAgc2VydmVybGVzc1YyTWF4Q2FwYWNpdHk6IDQsXG4gICAgICBkZWZhdWx0RGF0YWJhc2VOYW1lOiAnc29uZ2JpcmRfYW5hbHl0aWNzJyxcbiAgICAgIGVuYWJsZURhdGFBcGk6IHRydWUsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgc3RvcmFnZUVuY3J5cHRlZDogdHJ1ZSxcbiAgICAgIGJhY2t1cDoge1xuICAgICAgICByZXRlbnRpb246IGNkay5EdXJhdGlvbi5kYXlzKDcpLFxuICAgICAgICBwcmVmZXJyZWRXaW5kb3c6ICcwMzowMC0wNDowMCcsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBEeW5hbW9EQiBUYWJsZSBmb3IgQ2hhdCBIaXN0b3J5XG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLmNoYXRIaXN0b3J5VGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgJ0NoYXRIaXN0b3J5VGFibGUnLCB7XG4gICAgICB0YWJsZU5hbWU6ICdzb25nYmlyZC1jaGF0LWhpc3RvcnknLFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICd1c2VyX2VtYWlsJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG4gICAgICB9LFxuICAgICAgc29ydEtleToge1xuICAgICAgICBuYW1lOiAndGltZXN0YW1wJyxcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5OVU1CRVIsXG4gICAgICB9LFxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiAndHRsJyxcbiAgICB9KTtcblxuICAgIC8vIEdTSSBmb3IgcXVlcnlpbmcgYnkgc2Vzc2lvblxuICAgIHRoaXMuY2hhdEhpc3RvcnlUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6ICdzZXNzaW9uLWluZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAnc2Vzc2lvbl9pZCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIHNvcnRLZXk6IHtcbiAgICAgICAgbmFtZTogJ3RpbWVzdGFtcCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSLFxuICAgICAgfSxcbiAgICAgIHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIExhbWJkYTogU2NoZW1hIEluaXRpYWxpemF0aW9uXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBpbml0U2NoZW1hTGFtYmRhID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdJbml0U2NoZW1hTGFtYmRhJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYW5hbHl0aWNzLWluaXQtc2NoZW1hJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnSW5pdGlhbGl6ZSBBdXJvcmEgYW5hbHl0aWNzIHNjaGVtYScsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FuYWx5dGljcy9pbml0LXNjaGVtYS50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApLFxuICAgICAgbWVtb3J5U2l6ZTogNTEyLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQ0xVU1RFUl9BUk46IHRoaXMuY2x1c3Rlci5jbHVzdGVyQXJuLFxuICAgICAgICBTRUNSRVRfQVJOOiB0aGlzLmNsdXN0ZXIuc2VjcmV0IS5zZWNyZXRBcm4sXG4gICAgICAgIERBVEFCQVNFX05BTUU6ICdzb25nYmlyZF9hbmFseXRpY3MnLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG5cbiAgICB0aGlzLmNsdXN0ZXIuZ3JhbnREYXRhQXBpQWNjZXNzKGluaXRTY2hlbWFMYW1iZGEpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBMYW1iZGE6IER5bmFtb0RCIOKGkiBBdXJvcmEgU3luY1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3Qgc3luY0xhbWJkYSA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnU3luY0xhbWJkYScsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFuYWx5dGljcy1zeW5jJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU3luYyBEeW5hbW9EQiBzdHJlYW1zIHRvIEF1cm9yYScsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FuYWx5dGljcy9zeW5jLXRvLWF1cm9yYS50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApLFxuICAgICAgbWVtb3J5U2l6ZTogNTEyLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQ0xVU1RFUl9BUk46IHRoaXMuY2x1c3Rlci5jbHVzdGVyQXJuLFxuICAgICAgICBTRUNSRVRfQVJOOiB0aGlzLmNsdXN0ZXIuc2VjcmV0IS5zZWNyZXRBcm4sXG4gICAgICAgIERBVEFCQVNFX05BTUU6ICdzb25nYmlyZF9hbmFseXRpY3MnLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgICB2cGMsXG4gICAgICB2cGNTdWJuZXRzOiB7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MgfSxcbiAgICB9KTtcblxuICAgIHRoaXMuY2x1c3Rlci5ncmFudERhdGFBcGlBY2Nlc3Moc3luY0xhbWJkYSk7XG5cbiAgICAvLyBBZGQgRHluYW1vREIgc3RyZWFtIHNvdXJjZXNcbiAgICBzeW5jTGFtYmRhLmFkZEV2ZW50U291cmNlKG5ldyBEeW5hbW9FdmVudFNvdXJjZShwcm9wcy5kZXZpY2VzVGFibGUsIHtcbiAgICAgIHN0YXJ0aW5nUG9zaXRpb246IGxhbWJkYS5TdGFydGluZ1Bvc2l0aW9uLlRSSU1fSE9SSVpPTixcbiAgICAgIGJhdGNoU2l6ZTogMTAwLFxuICAgICAgYmlzZWN0QmF0Y2hPbkVycm9yOiB0cnVlLFxuICAgICAgcmV0cnlBdHRlbXB0czogMyxcbiAgICB9KSk7XG5cbiAgICBzeW5jTGFtYmRhLmFkZEV2ZW50U291cmNlKG5ldyBEeW5hbW9FdmVudFNvdXJjZShwcm9wcy50ZWxlbWV0cnlUYWJsZSwge1xuICAgICAgc3RhcnRpbmdQb3NpdGlvbjogbGFtYmRhLlN0YXJ0aW5nUG9zaXRpb24uVFJJTV9IT1JJWk9OLFxuICAgICAgYmF0Y2hTaXplOiAxMDAsXG4gICAgICBiaXNlY3RCYXRjaE9uRXJyb3I6IHRydWUsXG4gICAgICByZXRyeUF0dGVtcHRzOiAzLFxuICAgIH0pKTtcblxuICAgIHN5bmNMYW1iZGEuYWRkRXZlbnRTb3VyY2UobmV3IER5bmFtb0V2ZW50U291cmNlKHByb3BzLmxvY2F0aW9uc1RhYmxlLCB7XG4gICAgICBzdGFydGluZ1Bvc2l0aW9uOiBsYW1iZGEuU3RhcnRpbmdQb3NpdGlvbi5UUklNX0hPUklaT04sXG4gICAgICBiYXRjaFNpemU6IDEwMCxcbiAgICAgIGJpc2VjdEJhdGNoT25FcnJvcjogdHJ1ZSxcbiAgICAgIHJldHJ5QXR0ZW1wdHM6IDMsXG4gICAgfSkpO1xuXG4gICAgc3luY0xhbWJkYS5hZGRFdmVudFNvdXJjZShuZXcgRHluYW1vRXZlbnRTb3VyY2UocHJvcHMuYWxlcnRzVGFibGUsIHtcbiAgICAgIHN0YXJ0aW5nUG9zaXRpb246IGxhbWJkYS5TdGFydGluZ1Bvc2l0aW9uLlRSSU1fSE9SSVpPTixcbiAgICAgIGJhdGNoU2l6ZTogMTAwLFxuICAgICAgYmlzZWN0QmF0Y2hPbkVycm9yOiB0cnVlLFxuICAgICAgcmV0cnlBdHRlbXB0czogMyxcbiAgICB9KSk7XG5cbiAgICBzeW5jTGFtYmRhLmFkZEV2ZW50U291cmNlKG5ldyBEeW5hbW9FdmVudFNvdXJjZShwcm9wcy5qb3VybmV5c1RhYmxlLCB7XG4gICAgICBzdGFydGluZ1Bvc2l0aW9uOiBsYW1iZGEuU3RhcnRpbmdQb3NpdGlvbi5UUklNX0hPUklaT04sXG4gICAgICBiYXRjaFNpemU6IDEwMCxcbiAgICAgIGJpc2VjdEJhdGNoT25FcnJvcjogdHJ1ZSxcbiAgICAgIHJldHJ5QXR0ZW1wdHM6IDMsXG4gICAgfSkpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBMYW1iZGE6IENoYXQgUXVlcnkgKFRleHQtdG8tU1FMKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5jaGF0UXVlcnlMYW1iZGEgPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0NoYXRRdWVyeUxhbWJkYScsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFuYWx5dGljcy1jaGF0LXF1ZXJ5JyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQW5hbHl0aWNzIGNoYXQgcXVlcnkgd2l0aCBCZWRyb2NrJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYW5hbHl0aWNzL2NoYXQtcXVlcnkudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDYwKSxcbiAgICAgIG1lbW9yeVNpemU6IDEwMjQsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBDTFVTVEVSX0FSTjogdGhpcy5jbHVzdGVyLmNsdXN0ZXJBcm4sXG4gICAgICAgIFNFQ1JFVF9BUk46IHRoaXMuY2x1c3Rlci5zZWNyZXQhLnNlY3JldEFybixcbiAgICAgICAgREFUQUJBU0VfTkFNRTogJ3NvbmdiaXJkX2FuYWx5dGljcycsXG4gICAgICAgIENIQVRfSElTVE9SWV9UQUJMRTogdGhpcy5jaGF0SGlzdG9yeVRhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgQkVEUk9DS19NT0RFTF9JRDogJ3VzLmFudGhyb3BpYy5jbGF1ZGUtMy01LXNvbm5ldC0yMDI0MTAyMi12MjowJyxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgICAgdnBjLFxuICAgICAgdnBjU3VibmV0czogeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTIH0sXG4gICAgfSk7XG5cbiAgICB0aGlzLmNsdXN0ZXIuZ3JhbnREYXRhQXBpQWNjZXNzKHRoaXMuY2hhdFF1ZXJ5TGFtYmRhKTtcbiAgICB0aGlzLmNoYXRIaXN0b3J5VGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHRoaXMuY2hhdFF1ZXJ5TGFtYmRhKTtcblxuICAgIC8vIEdyYW50IEJlZHJvY2sgYWNjZXNzXG4gICAgdGhpcy5jaGF0UXVlcnlMYW1iZGEuYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnYmVkcm9jazpJbnZva2VNb2RlbCddLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICB9KSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIExhbWJkYTogQ2hhdCBIaXN0b3J5XG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLmNoYXRIaXN0b3J5TGFtYmRhID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdDaGF0SGlzdG9yeUxhbWJkYScsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFuYWx5dGljcy1jaGF0LWhpc3RvcnknLFxuICAgICAgZGVzY3JpcHRpb246ICdSZXRyaWV2ZSBhbmFseXRpY3MgY2hhdCBoaXN0b3J5JyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYW5hbHl0aWNzL2NoYXQtaGlzdG9yeS50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQ0hBVF9ISVNUT1JZX1RBQkxFOiB0aGlzLmNoYXRIaXN0b3J5VGFibGUudGFibGVOYW1lLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG5cbiAgICB0aGlzLmNoYXRIaXN0b3J5VGFibGUuZ3JhbnRSZWFkRGF0YSh0aGlzLmNoYXRIaXN0b3J5TGFtYmRhKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTGFtYmRhOiBCYWNrZmlsbCAob25lLXRpbWUgaGlzdG9yaWNhbCBkYXRhIG1pZ3JhdGlvbilcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGJhY2tmaWxsTGFtYmRhID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdCYWNrZmlsbExhbWJkYScsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFuYWx5dGljcy1iYWNrZmlsbCcsXG4gICAgICBkZXNjcmlwdGlvbjogJ0JhY2tmaWxsIGhpc3RvcmljYWwgRHluYW1vREIgZGF0YSB0byBBdXJvcmEnLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hbmFseXRpY3MvYmFja2ZpbGwudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDE1KSxcbiAgICAgIG1lbW9yeVNpemU6IDEwMjQsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBDTFVTVEVSX0FSTjogdGhpcy5jbHVzdGVyLmNsdXN0ZXJBcm4sXG4gICAgICAgIFNFQ1JFVF9BUk46IHRoaXMuY2x1c3Rlci5zZWNyZXQhLnNlY3JldEFybixcbiAgICAgICAgREFUQUJBU0VfTkFNRTogJ3NvbmdiaXJkX2FuYWx5dGljcycsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcblxuICAgIHRoaXMuY2x1c3Rlci5ncmFudERhdGFBcGlBY2Nlc3MoYmFja2ZpbGxMYW1iZGEpO1xuICAgIHByb3BzLmRldmljZXNUYWJsZS5ncmFudFJlYWREYXRhKGJhY2tmaWxsTGFtYmRhKTtcbiAgICBwcm9wcy50ZWxlbWV0cnlUYWJsZS5ncmFudFJlYWREYXRhKGJhY2tmaWxsTGFtYmRhKTtcbiAgICBwcm9wcy5sb2NhdGlvbnNUYWJsZS5ncmFudFJlYWREYXRhKGJhY2tmaWxsTGFtYmRhKTtcbiAgICBwcm9wcy5hbGVydHNUYWJsZS5ncmFudFJlYWREYXRhKGJhY2tmaWxsTGFtYmRhKTtcbiAgICBwcm9wcy5qb3VybmV5c1RhYmxlLmdyYW50UmVhZERhdGEoYmFja2ZpbGxMYW1iZGEpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBPdXRwdXRzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2x1c3RlckVuZHBvaW50Jywge1xuICAgICAgdmFsdWU6IHRoaXMuY2x1c3Rlci5jbHVzdGVyRW5kcG9pbnQuaG9zdG5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0F1cm9yYSBBbmFseXRpY3MgY2x1c3RlciBlbmRwb2ludCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnU2VjcmV0QXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMuY2x1c3Rlci5zZWNyZXQhLnNlY3JldEFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXVyb3JhIGNyZWRlbnRpYWxzIHNlY3JldCBBUk4nLFxuICAgIH0pO1xuICB9XG59XG4iXX0=