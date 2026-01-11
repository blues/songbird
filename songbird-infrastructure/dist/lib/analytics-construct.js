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
            vpc,
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
}
exports.AnalyticsConstruct = AnalyticsConstruct;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYW5hbHl0aWNzLWNvbnN0cnVjdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL2xpYi9hbmFseXRpY3MtY29uc3RydWN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7R0FLRzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFFSCxpREFBbUM7QUFDbkMseURBQTJDO0FBQzNDLHlEQUEyQztBQUMzQyxtRUFBcUQ7QUFDckQsK0RBQWlEO0FBQ2pELDJEQUE2QztBQUM3Qyx5REFBMkM7QUFDM0MsbUZBQXlFO0FBQ3pFLHFFQUErRDtBQUMvRCwyQ0FBdUM7QUFDdkMsMkNBQTZCO0FBVTdCLE1BQWEsa0JBQW1CLFNBQVEsc0JBQVM7SUFDL0IsT0FBTyxDQUFzQjtJQUM3QixnQkFBZ0IsQ0FBaUI7SUFDakMsZUFBZSxDQUFrQjtJQUNqQyxpQkFBaUIsQ0FBa0I7SUFDbkMsa0JBQWtCLENBQWtCO0lBQ3BDLGdCQUFnQixDQUFrQjtJQUNsQyxtQkFBbUIsQ0FBa0I7SUFDckMsZ0JBQWdCLENBQWtCO0lBRWxELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBOEI7UUFDdEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQiw2RUFBNkU7UUFDN0UsK0JBQStCO1FBQy9CLDZFQUE2RTtRQUM3RSxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRTtZQUM1QyxNQUFNLEVBQUUsQ0FBQztZQUNULFdBQVcsRUFBRSxDQUFDO1lBQ2QsbUJBQW1CLEVBQUU7Z0JBQ25CO29CQUNFLFFBQVEsRUFBRSxFQUFFO29CQUNaLElBQUksRUFBRSxRQUFRO29CQUNkLFVBQVUsRUFBRSxHQUFHLENBQUMsVUFBVSxDQUFDLE1BQU07aUJBQ2xDO2dCQUNEO29CQUNFLFFBQVEsRUFBRSxFQUFFO29CQUNaLElBQUksRUFBRSxTQUFTO29CQUNmLFVBQVUsRUFBRSxHQUFHLENBQUMsVUFBVSxDQUFDLG1CQUFtQjtpQkFDL0M7Z0JBQ0Q7b0JBQ0UsUUFBUSxFQUFFLEVBQUU7b0JBQ1osSUFBSSxFQUFFLFVBQVU7b0JBQ2hCLFVBQVUsRUFBRSxHQUFHLENBQUMsVUFBVSxDQUFDLGdCQUFnQjtpQkFDNUM7YUFDRjtTQUNGLENBQUMsQ0FBQztRQUVILDZFQUE2RTtRQUM3RSwrQkFBK0I7UUFDL0IsNkVBQTZFO1FBQzdFLElBQUksQ0FBQyxPQUFPLEdBQUcsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRTtZQUMvRCxNQUFNLEVBQUUsR0FBRyxDQUFDLHFCQUFxQixDQUFDLGNBQWMsQ0FBQztnQkFDL0MsT0FBTyxFQUFFLEdBQUcsQ0FBQywyQkFBMkIsQ0FBQyxRQUFRO2FBQ2xELENBQUM7WUFDRixHQUFHO1lBQ0gsVUFBVSxFQUFFLEVBQUUsVUFBVSxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsZ0JBQWdCLEVBQUU7WUFDM0QsTUFBTSxFQUFFLEdBQUcsQ0FBQyxlQUFlLENBQUMsWUFBWSxDQUFDLFFBQVEsRUFBRTtnQkFDakQsdUJBQXVCLEVBQUUsSUFBSTthQUM5QixDQUFDO1lBQ0YsdUJBQXVCLEVBQUUsR0FBRztZQUM1Qix1QkFBdUIsRUFBRSxDQUFDO1lBQzFCLG1CQUFtQixFQUFFLG9CQUFvQjtZQUN6QyxhQUFhLEVBQUUsSUFBSTtZQUNuQixhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBQ3hDLGdCQUFnQixFQUFFLElBQUk7WUFDdEIsTUFBTSxFQUFFO2dCQUNOLFNBQVMsRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7Z0JBQy9CLGVBQWUsRUFBRSxhQUFhO2FBQy9CO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsNkVBQTZFO1FBQzdFLGtDQUFrQztRQUNsQyw2RUFBNkU7UUFDN0UsSUFBSSxDQUFDLGdCQUFnQixHQUFHLElBQUksUUFBUSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsa0JBQWtCLEVBQUU7WUFDbkUsU0FBUyxFQUFFLHVCQUF1QjtZQUNsQyxZQUFZLEVBQUU7Z0JBQ1osSUFBSSxFQUFFLFlBQVk7Z0JBQ2xCLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU07YUFDcEM7WUFDRCxPQUFPLEVBQUU7Z0JBQ1AsSUFBSSxFQUFFLFdBQVc7Z0JBQ2pCLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU07YUFDcEM7WUFDRCxXQUFXLEVBQUUsUUFBUSxDQUFDLFdBQVcsQ0FBQyxlQUFlO1lBQ2pELGFBQWEsRUFBRSxHQUFHLENBQUMsYUFBYSxDQUFDLE9BQU87WUFDeEMsbUJBQW1CLEVBQUUsS0FBSztTQUMzQixDQUFDLENBQUM7UUFFSCw4QkFBOEI7UUFDOUIsSUFBSSxDQUFDLGdCQUFnQixDQUFDLHVCQUF1QixDQUFDO1lBQzVDLFNBQVMsRUFBRSxlQUFlO1lBQzFCLFlBQVksRUFBRTtnQkFDWixJQUFJLEVBQUUsWUFBWTtnQkFDbEIsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTTthQUNwQztZQUNELE9BQU8sRUFBRTtnQkFDUCxJQUFJLEVBQUUsV0FBVztnQkFDakIsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTTthQUNwQztZQUNELGNBQWMsRUFBRSxRQUFRLENBQUMsY0FBYyxDQUFDLEdBQUc7U0FDNUMsQ0FBQyxDQUFDO1FBRUgsNkVBQTZFO1FBQzdFLGdDQUFnQztRQUNoQyw2RUFBNkU7UUFDN0UsTUFBTSxnQkFBZ0IsR0FBRyxJQUFJLGtDQUFjLENBQUMsSUFBSSxFQUFFLGtCQUFrQixFQUFFO1lBQ3BFLFlBQVksRUFBRSxnQ0FBZ0M7WUFDOUMsV0FBVyxFQUFFLG9DQUFvQztZQUNqRCxPQUFPLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXO1lBQ25DLE9BQU8sRUFBRSxTQUFTO1lBQ2xCLEtBQUssRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxvQ0FBb0MsQ0FBQztZQUNqRSxPQUFPLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1lBQ2pDLFVBQVUsRUFBRSxHQUFHO1lBQ2YsV0FBVyxFQUFFO2dCQUNYLFdBQVcsRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLFVBQVU7Z0JBQ3BDLFVBQVUsRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU8sQ0FBQyxTQUFTO2dCQUMxQyxhQUFhLEVBQUUsb0JBQW9CO2FBQ3BDO1lBQ0QsUUFBUSxFQUFFLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFO1lBQzNDLFlBQVksRUFBRSxJQUFJLENBQUMsYUFBYSxDQUFDLFNBQVM7U0FDM0MsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLE9BQU8sQ0FBQyxrQkFBa0IsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO1FBRWxELDZFQUE2RTtRQUM3RSxpQ0FBaUM7UUFDakMsNkVBQTZFO1FBQzdFLE1BQU0sVUFBVSxHQUFHLElBQUksa0NBQWMsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO1lBQ3hELFlBQVksRUFBRSx5QkFBeUI7WUFDdkMsV0FBVyxFQUFFLGlDQUFpQztZQUM5QyxPQUFPLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXO1lBQ25DLE9BQU8sRUFBRSxTQUFTO1lBQ2xCLEtBQUssRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSx1Q0FBdUMsQ0FBQztZQUNwRSxPQUFPLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1lBQ2pDLFVBQVUsRUFBRSxHQUFHO1lBQ2YsV0FBVyxFQUFFO2dCQUNYLFdBQVcsRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLFVBQVU7Z0JBQ3BDLFVBQVUsRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU8sQ0FBQyxTQUFTO2dCQUMxQyxhQUFhLEVBQUUsb0JBQW9CO2FBQ3BDO1lBQ0QsUUFBUSxFQUFFLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFO1lBQzNDLFlBQVksRUFBRSxJQUFJLENBQUMsYUFBYSxDQUFDLFNBQVM7WUFDMUMsR0FBRztZQUNILFVBQVUsRUFBRSxFQUFFLFVBQVUsRUFBRSxHQUFHLENBQUMsVUFBVSxDQUFDLG1CQUFtQixFQUFFO1NBQy9ELENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxPQUFPLENBQUMsa0JBQWtCLENBQUMsVUFBVSxDQUFDLENBQUM7UUFFNUMsOEJBQThCO1FBQzlCLFVBQVUsQ0FBQyxjQUFjLENBQUMsSUFBSSw0Q0FBaUIsQ0FBQyxLQUFLLENBQUMsWUFBWSxFQUFFO1lBQ2xFLGdCQUFnQixFQUFFLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxZQUFZO1lBQ3RELFNBQVMsRUFBRSxHQUFHO1lBQ2Qsa0JBQWtCLEVBQUUsSUFBSTtZQUN4QixhQUFhLEVBQUUsQ0FBQztTQUNqQixDQUFDLENBQUMsQ0FBQztRQUVKLFVBQVUsQ0FBQyxjQUFjLENBQUMsSUFBSSw0Q0FBaUIsQ0FBQyxLQUFLLENBQUMsY0FBYyxFQUFFO1lBQ3BFLGdCQUFnQixFQUFFLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxZQUFZO1lBQ3RELFNBQVMsRUFBRSxHQUFHO1lBQ2Qsa0JBQWtCLEVBQUUsSUFBSTtZQUN4QixhQUFhLEVBQUUsQ0FBQztTQUNqQixDQUFDLENBQUMsQ0FBQztRQUVKLFVBQVUsQ0FBQyxjQUFjLENBQUMsSUFBSSw0Q0FBaUIsQ0FBQyxLQUFLLENBQUMsY0FBYyxFQUFFO1lBQ3BFLGdCQUFnQixFQUFFLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxZQUFZO1lBQ3RELFNBQVMsRUFBRSxHQUFHO1lBQ2Qsa0JBQWtCLEVBQUUsSUFBSTtZQUN4QixhQUFhLEVBQUUsQ0FBQztTQUNqQixDQUFDLENBQUMsQ0FBQztRQUVKLFVBQVUsQ0FBQyxjQUFjLENBQUMsSUFBSSw0Q0FBaUIsQ0FBQyxLQUFLLENBQUMsV0FBVyxFQUFFO1lBQ2pFLGdCQUFnQixFQUFFLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxZQUFZO1lBQ3RELFNBQVMsRUFBRSxHQUFHO1lBQ2Qsa0JBQWtCLEVBQUUsSUFBSTtZQUN4QixhQUFhLEVBQUUsQ0FBQztTQUNqQixDQUFDLENBQUMsQ0FBQztRQUVKLFVBQVUsQ0FBQyxjQUFjLENBQUMsSUFBSSw0Q0FBaUIsQ0FBQyxLQUFLLENBQUMsYUFBYSxFQUFFO1lBQ25FLGdCQUFnQixFQUFFLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxZQUFZO1lBQ3RELFNBQVMsRUFBRSxHQUFHO1lBQ2Qsa0JBQWtCLEVBQUUsSUFBSTtZQUN4QixhQUFhLEVBQUUsQ0FBQztTQUNqQixDQUFDLENBQUMsQ0FBQztRQUVKLDZFQUE2RTtRQUM3RSxtQ0FBbUM7UUFDbkMsNkVBQTZFO1FBQzdFLElBQUksQ0FBQyxlQUFlLEdBQUcsSUFBSSxrQ0FBYyxDQUFDLElBQUksRUFBRSxpQkFBaUIsRUFBRTtZQUNqRSxZQUFZLEVBQUUsK0JBQStCO1lBQzdDLFdBQVcsRUFBRSxtQ0FBbUM7WUFDaEQsT0FBTyxFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsV0FBVztZQUNuQyxPQUFPLEVBQUUsU0FBUztZQUNsQixLQUFLLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsbUNBQW1DLENBQUM7WUFDaEUsT0FBTyxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUNqQyxVQUFVLEVBQUUsSUFBSTtZQUNoQixXQUFXLEVBQUU7Z0JBQ1gsV0FBVyxFQUFFLElBQUksQ0FBQyxPQUFPLENBQUMsVUFBVTtnQkFDcEMsVUFBVSxFQUFFLElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTyxDQUFDLFNBQVM7Z0JBQzFDLGFBQWEsRUFBRSxvQkFBb0I7Z0JBQ25DLGtCQUFrQixFQUFFLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxTQUFTO2dCQUNuRCxnQkFBZ0IsRUFBRSw4Q0FBOEM7YUFDakU7WUFDRCxRQUFRLEVBQUUsRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLFNBQVMsRUFBRSxJQUFJLEVBQUU7WUFDM0MsWUFBWSxFQUFFLElBQUksQ0FBQyxhQUFhLENBQUMsU0FBUztZQUMxQyxHQUFHO1lBQ0gsVUFBVSxFQUFFLEVBQUUsVUFBVSxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsbUJBQW1CLEVBQUU7U0FDL0QsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLE9BQU8sQ0FBQyxrQkFBa0IsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLENBQUM7UUFDdEQsSUFBSSxDQUFDLGdCQUFnQixDQUFDLGtCQUFrQixDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQztRQUUvRCx1QkFBdUI7UUFDdkIsSUFBSSxDQUFDLGVBQWUsQ0FBQyxlQUFlLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQzNELE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7WUFDeEIsT0FBTyxFQUFFLENBQUMscUJBQXFCLENBQUM7WUFDaEMsU0FBUyxFQUFFLENBQUMsR0FBRyxDQUFDO1NBQ2pCLENBQUMsQ0FBQyxDQUFDO1FBRUosNkVBQTZFO1FBQzdFLHVCQUF1QjtRQUN2Qiw2RUFBNkU7UUFDN0UsSUFBSSxDQUFDLGlCQUFpQixHQUFHLElBQUksa0NBQWMsQ0FBQyxJQUFJLEVBQUUsbUJBQW1CLEVBQUU7WUFDckUsWUFBWSxFQUFFLGlDQUFpQztZQUMvQyxXQUFXLEVBQUUsaUNBQWlDO1lBQzlDLE9BQU8sRUFBRSxNQUFNLENBQUMsT0FBTyxDQUFDLFdBQVc7WUFDbkMsT0FBTyxFQUFFLFNBQVM7WUFDbEIsS0FBSyxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLHFDQUFxQyxDQUFDO1lBQ2xFLE9BQU8sRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7WUFDakMsVUFBVSxFQUFFLEdBQUc7WUFDZixXQUFXLEVBQUU7Z0JBQ1gsa0JBQWtCLEVBQUUsSUFBSSxDQUFDLGdCQUFnQixDQUFDLFNBQVM7YUFDcEQ7WUFDRCxRQUFRLEVBQUUsRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLFNBQVMsRUFBRSxJQUFJLEVBQUU7WUFDM0MsWUFBWSxFQUFFLElBQUksQ0FBQyxhQUFhLENBQUMsU0FBUztTQUMzQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsZ0JBQWdCLENBQUMsYUFBYSxDQUFDLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO1FBRTVELDZFQUE2RTtRQUM3RSx3QkFBd0I7UUFDeEIsNkVBQTZFO1FBQzdFLElBQUksQ0FBQyxrQkFBa0IsR0FBRyxJQUFJLGtDQUFjLENBQUMsSUFBSSxFQUFFLG9CQUFvQixFQUFFO1lBQ3ZFLFlBQVksRUFBRSxrQ0FBa0M7WUFDaEQsV0FBVyxFQUFFLDhCQUE4QjtZQUMzQyxPQUFPLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXO1lBQ25DLE9BQU8sRUFBRSxTQUFTO1lBQ2xCLEtBQUssRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxzQ0FBc0MsQ0FBQztZQUNuRSxPQUFPLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1lBQ2pDLFVBQVUsRUFBRSxHQUFHO1lBQ2YsV0FBVyxFQUFFO2dCQUNYLGtCQUFrQixFQUFFLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxTQUFTO2FBQ3BEO1lBQ0QsUUFBUSxFQUFFLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFO1lBQzNDLFlBQVksRUFBRSxJQUFJLENBQUMsYUFBYSxDQUFDLFNBQVM7U0FDM0MsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLGdCQUFnQixDQUFDLGFBQWEsQ0FBQyxJQUFJLENBQUMsa0JBQWtCLENBQUMsQ0FBQztRQUU3RCw2RUFBNkU7UUFDN0Usc0JBQXNCO1FBQ3RCLDZFQUE2RTtRQUM3RSxJQUFJLENBQUMsZ0JBQWdCLEdBQUcsSUFBSSxrQ0FBYyxDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRTtZQUNuRSxZQUFZLEVBQUUsZ0NBQWdDO1lBQzlDLFdBQVcsRUFBRSxvQ0FBb0M7WUFDakQsT0FBTyxFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsV0FBVztZQUNuQyxPQUFPLEVBQUUsU0FBUztZQUNsQixLQUFLLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsb0NBQW9DLENBQUM7WUFDakUsT0FBTyxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUNqQyxVQUFVLEVBQUUsR0FBRztZQUNmLFdBQVcsRUFBRTtnQkFDWCxrQkFBa0IsRUFBRSxJQUFJLENBQUMsZ0JBQWdCLENBQUMsU0FBUzthQUNwRDtZQUNELFFBQVEsRUFBRSxFQUFFLE1BQU0sRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRTtZQUMzQyxZQUFZLEVBQUUsSUFBSSxDQUFDLGFBQWEsQ0FBQyxTQUFTO1NBQzNDLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxhQUFhLENBQUMsSUFBSSxDQUFDLGdCQUFnQixDQUFDLENBQUM7UUFFM0QsNkVBQTZFO1FBQzdFLHlCQUF5QjtRQUN6Qiw2RUFBNkU7UUFDN0UsSUFBSSxDQUFDLG1CQUFtQixHQUFHLElBQUksa0NBQWMsQ0FBQyxJQUFJLEVBQUUscUJBQXFCLEVBQUU7WUFDekUsWUFBWSxFQUFFLG1DQUFtQztZQUNqRCxXQUFXLEVBQUUsK0JBQStCO1lBQzVDLE9BQU8sRUFBRSxNQUFNLENBQUMsT0FBTyxDQUFDLFdBQVc7WUFDbkMsT0FBTyxFQUFFLFNBQVM7WUFDbEIsS0FBSyxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLHVDQUF1QyxDQUFDO1lBQ3BFLE9BQU8sRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7WUFDakMsVUFBVSxFQUFFLEdBQUc7WUFDZixXQUFXLEVBQUU7Z0JBQ1gsa0JBQWtCLEVBQUUsSUFBSSxDQUFDLGdCQUFnQixDQUFDLFNBQVM7YUFDcEQ7WUFDRCxRQUFRLEVBQUUsRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLFNBQVMsRUFBRSxJQUFJLEVBQUU7WUFDM0MsWUFBWSxFQUFFLElBQUksQ0FBQyxhQUFhLENBQUMsU0FBUztTQUMzQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsZ0JBQWdCLENBQUMsa0JBQWtCLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLENBQUM7UUFFbkUsNkVBQTZFO1FBQzdFLGlFQUFpRTtRQUNqRSw2RUFBNkU7UUFDN0UsSUFBSSxDQUFDLGdCQUFnQixHQUFHLElBQUksa0NBQWMsQ0FBQyxJQUFJLEVBQUUsa0JBQWtCLEVBQUU7WUFDbkUsWUFBWSxFQUFFLGdDQUFnQztZQUM5QyxXQUFXLEVBQUUsZ0RBQWdEO1lBQzdELE9BQU8sRUFBRSxNQUFNLENBQUMsT0FBTyxDQUFDLFdBQVc7WUFDbkMsT0FBTyxFQUFFLFNBQVM7WUFDbEIsS0FBSyxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLG9DQUFvQyxDQUFDO1lBQ2pFLE9BQU8sRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7WUFDakMsVUFBVSxFQUFFLEdBQUc7WUFDZixXQUFXLEVBQUU7Z0JBQ1gsV0FBVyxFQUFFLElBQUksQ0FBQyxPQUFPLENBQUMsVUFBVTtnQkFDcEMsVUFBVSxFQUFFLElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTyxDQUFDLFNBQVM7Z0JBQzFDLGFBQWEsRUFBRSxvQkFBb0I7YUFDcEM7WUFDRCxRQUFRLEVBQUUsRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLFNBQVMsRUFBRSxJQUFJLEVBQUU7WUFDM0MsWUFBWSxFQUFFLElBQUksQ0FBQyxhQUFhLENBQUMsU0FBUztZQUMxQyxHQUFHO1lBQ0gsVUFBVSxFQUFFLEVBQUUsVUFBVSxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsbUJBQW1CLEVBQUU7U0FDL0QsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLE9BQU8sQ0FBQyxrQkFBa0IsQ0FBQyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsQ0FBQztRQUV2RCw2RUFBNkU7UUFDN0Usd0RBQXdEO1FBQ3hELDZFQUE2RTtRQUM3RSxNQUFNLGNBQWMsR0FBRyxJQUFJLGtDQUFjLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQ2hFLFlBQVksRUFBRSw2QkFBNkI7WUFDM0MsV0FBVyxFQUFFLDZDQUE2QztZQUMxRCxPQUFPLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXO1lBQ25DLE9BQU8sRUFBRSxTQUFTO1lBQ2xCLEtBQUssRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxpQ0FBaUMsQ0FBQztZQUM5RCxPQUFPLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1lBQ2pDLFVBQVUsRUFBRSxJQUFJO1lBQ2hCLFdBQVcsRUFBRTtnQkFDWCxXQUFXLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxVQUFVO2dCQUNwQyxVQUFVLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFPLENBQUMsU0FBUztnQkFDMUMsYUFBYSxFQUFFLG9CQUFvQjthQUNwQztZQUNELFFBQVEsRUFBRSxFQUFFLE1BQU0sRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRTtZQUMzQyxZQUFZLEVBQUUsSUFBSSxDQUFDLGFBQWEsQ0FBQyxTQUFTO1NBQzNDLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxPQUFPLENBQUMsa0JBQWtCLENBQUMsY0FBYyxDQUFDLENBQUM7UUFDaEQsS0FBSyxDQUFDLFlBQVksQ0FBQyxhQUFhLENBQUMsY0FBYyxDQUFDLENBQUM7UUFDakQsS0FBSyxDQUFDLGNBQWMsQ0FBQyxhQUFhLENBQUMsY0FBYyxDQUFDLENBQUM7UUFDbkQsS0FBSyxDQUFDLGNBQWMsQ0FBQyxhQUFhLENBQUMsY0FBYyxDQUFDLENBQUM7UUFDbkQsS0FBSyxDQUFDLFdBQVcsQ0FBQyxhQUFhLENBQUMsY0FBYyxDQUFDLENBQUM7UUFDaEQsS0FBSyxDQUFDLGFBQWEsQ0FBQyxhQUFhLENBQUMsY0FBYyxDQUFDLENBQUM7UUFFbEQsNkVBQTZFO1FBQzdFLFVBQVU7UUFDViw2RUFBNkU7UUFDN0UsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxpQkFBaUIsRUFBRTtZQUN6QyxLQUFLLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxlQUFlLENBQUMsUUFBUTtZQUM1QyxXQUFXLEVBQUUsbUNBQW1DO1NBQ2pELENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsV0FBVyxFQUFFO1lBQ25DLEtBQUssRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU8sQ0FBQyxTQUFTO1lBQ3JDLFdBQVcsRUFBRSwrQkFBK0I7U0FDN0MsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBbFdELGdEQWtXQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQW5hbHl0aWNzIENvbnN0cnVjdFxuICpcbiAqIFByb3ZpZGVzIFRleHQtdG8tU1FMIGFuYWx5dGljcyBwb3dlcmVkIGJ5IEFXUyBCZWRyb2NrIChDbGF1ZGUpIGFuZCBBdXJvcmEgU2VydmVybGVzcyB2Mi5cbiAqIEluY2x1ZGVzIHJlYWwtdGltZSBEeW5hbW9EQiDihpIgQXVyb3JhIHN5bmMgdmlhIHN0cmVhbXMuXG4gKi9cblxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGVjMiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWMyJztcbmltcG9ydCAqIGFzIHJkcyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtcmRzJztcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gJ2F3cy1jZGstbGliL2F3cy1keW5hbW9kYic7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYSc7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCB7IER5bmFtb0V2ZW50U291cmNlIH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYS1ldmVudC1zb3VyY2VzJztcbmltcG9ydCB7IE5vZGVqc0Z1bmN0aW9uIH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYS1ub2RlanMnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFuYWx5dGljc0NvbnN0cnVjdFByb3BzIHtcbiAgZGV2aWNlc1RhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbiAgdGVsZW1ldHJ5VGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBsb2NhdGlvbnNUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIGFsZXJ0c1RhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbiAgam91cm5leXNUYWJsZTogZHluYW1vZGIuVGFibGU7XG59XG5cbmV4cG9ydCBjbGFzcyBBbmFseXRpY3NDb25zdHJ1Y3QgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgY2x1c3RlcjogcmRzLkRhdGFiYXNlQ2x1c3RlcjtcbiAgcHVibGljIHJlYWRvbmx5IGNoYXRIaXN0b3J5VGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgY2hhdFF1ZXJ5TGFtYmRhOiBsYW1iZGEuRnVuY3Rpb247XG4gIHB1YmxpYyByZWFkb25seSBjaGF0SGlzdG9yeUxhbWJkYTogbGFtYmRhLkZ1bmN0aW9uO1xuICBwdWJsaWMgcmVhZG9ubHkgbGlzdFNlc3Npb25zTGFtYmRhOiBsYW1iZGEuRnVuY3Rpb247XG4gIHB1YmxpYyByZWFkb25seSBnZXRTZXNzaW9uTGFtYmRhOiBsYW1iZGEuRnVuY3Rpb247XG4gIHB1YmxpYyByZWFkb25seSBkZWxldGVTZXNzaW9uTGFtYmRhOiBsYW1iZGEuRnVuY3Rpb247XG4gIHB1YmxpYyByZWFkb25seSByZXJ1blF1ZXJ5TGFtYmRhOiBsYW1iZGEuRnVuY3Rpb247XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFuYWx5dGljc0NvbnN0cnVjdFByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gVlBDIGZvciBBdXJvcmEgU2VydmVybGVzcyB2MlxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgdnBjID0gbmV3IGVjMi5WcGModGhpcywgJ0FuYWx5dGljc1ZwYycsIHtcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgc3VibmV0Q29uZmlndXJhdGlvbjogW1xuICAgICAgICB7XG4gICAgICAgICAgY2lkck1hc2s6IDI0LFxuICAgICAgICAgIG5hbWU6ICdQdWJsaWMnLFxuICAgICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBVQkxJQyxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGNpZHJNYXNrOiAyNCxcbiAgICAgICAgICBuYW1lOiAnUHJpdmF0ZScsXG4gICAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGNpZHJNYXNrOiAyOCxcbiAgICAgICAgICBuYW1lOiAnSXNvbGF0ZWQnLFxuICAgICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfSVNPTEFURUQsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBBdXJvcmEgU2VydmVybGVzcyB2MiBDbHVzdGVyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLmNsdXN0ZXIgPSBuZXcgcmRzLkRhdGFiYXNlQ2x1c3Rlcih0aGlzLCAnQW5hbHl0aWNzQ2x1c3RlcicsIHtcbiAgICAgIGVuZ2luZTogcmRzLkRhdGFiYXNlQ2x1c3RlckVuZ2luZS5hdXJvcmFQb3N0Z3Jlcyh7XG4gICAgICAgIHZlcnNpb246IHJkcy5BdXJvcmFQb3N0Z3Jlc0VuZ2luZVZlcnNpb24uVkVSXzE2XzQsXG4gICAgICB9KSxcbiAgICAgIHZwYyxcbiAgICAgIHZwY1N1Ym5ldHM6IHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9JU09MQVRFRCB9LFxuICAgICAgd3JpdGVyOiByZHMuQ2x1c3Rlckluc3RhbmNlLnNlcnZlcmxlc3NWMignd3JpdGVyJywge1xuICAgICAgICBhdXRvTWlub3JWZXJzaW9uVXBncmFkZTogdHJ1ZSxcbiAgICAgIH0pLFxuICAgICAgc2VydmVybGVzc1YyTWluQ2FwYWNpdHk6IDAuNSxcbiAgICAgIHNlcnZlcmxlc3NWMk1heENhcGFjaXR5OiA0LFxuICAgICAgZGVmYXVsdERhdGFiYXNlTmFtZTogJ3NvbmdiaXJkX2FuYWx5dGljcycsXG4gICAgICBlbmFibGVEYXRhQXBpOiB0cnVlLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIHN0b3JhZ2VFbmNyeXB0ZWQ6IHRydWUsXG4gICAgICBiYWNrdXA6IHtcbiAgICAgICAgcmV0ZW50aW9uOiBjZGsuRHVyYXRpb24uZGF5cyg3KSxcbiAgICAgICAgcHJlZmVycmVkV2luZG93OiAnMDM6MDAtMDQ6MDAnLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRHluYW1vREIgVGFibGUgZm9yIENoYXQgSGlzdG9yeVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5jaGF0SGlzdG9yeVRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdDaGF0SGlzdG9yeVRhYmxlJywge1xuICAgICAgdGFibGVOYW1lOiAnc29uZ2JpcmQtY2hhdC1oaXN0b3J5JyxcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAndXNlcl9lbWFpbCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIHNvcnRLZXk6IHtcbiAgICAgICAgbmFtZTogJ3RpbWVzdGFtcCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSLFxuICAgICAgfSxcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogJ3R0bCcsXG4gICAgfSk7XG5cbiAgICAvLyBHU0kgZm9yIHF1ZXJ5aW5nIGJ5IHNlc3Npb25cbiAgICB0aGlzLmNoYXRIaXN0b3J5VGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xuICAgICAgaW5kZXhOYW1lOiAnc2Vzc2lvbi1pbmRleCcsXG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogJ3Nlc3Npb25faWQnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcbiAgICAgIH0sXG4gICAgICBzb3J0S2V5OiB7XG4gICAgICAgIG5hbWU6ICd0aW1lc3RhbXAnLFxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLk5VTUJFUixcbiAgICAgIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBMYW1iZGE6IFNjaGVtYSBJbml0aWFsaXphdGlvblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgaW5pdFNjaGVtYUxhbWJkYSA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnSW5pdFNjaGVtYUxhbWJkYScsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFuYWx5dGljcy1pbml0LXNjaGVtYScsXG4gICAgICBkZXNjcmlwdGlvbjogJ0luaXRpYWxpemUgQXVyb3JhIGFuYWx5dGljcyBzY2hlbWEnLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hbmFseXRpY3MvaW5pdC1zY2hlbWEudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDYwKSxcbiAgICAgIG1lbW9yeVNpemU6IDUxMixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIENMVVNURVJfQVJOOiB0aGlzLmNsdXN0ZXIuY2x1c3RlckFybixcbiAgICAgICAgU0VDUkVUX0FSTjogdGhpcy5jbHVzdGVyLnNlY3JldCEuc2VjcmV0QXJuLFxuICAgICAgICBEQVRBQkFTRV9OQU1FOiAnc29uZ2JpcmRfYW5hbHl0aWNzJyxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuXG4gICAgdGhpcy5jbHVzdGVyLmdyYW50RGF0YUFwaUFjY2Vzcyhpbml0U2NoZW1hTGFtYmRhKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTGFtYmRhOiBEeW5hbW9EQiDihpIgQXVyb3JhIFN5bmNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IHN5bmNMYW1iZGEgPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ1N5bmNMYW1iZGEnLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hbmFseXRpY3Mtc3luYycsXG4gICAgICBkZXNjcmlwdGlvbjogJ1N5bmMgRHluYW1vREIgc3RyZWFtcyB0byBBdXJvcmEnLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hbmFseXRpY3Mvc3luYy10by1hdXJvcmEudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDYwKSxcbiAgICAgIG1lbW9yeVNpemU6IDUxMixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIENMVVNURVJfQVJOOiB0aGlzLmNsdXN0ZXIuY2x1c3RlckFybixcbiAgICAgICAgU0VDUkVUX0FSTjogdGhpcy5jbHVzdGVyLnNlY3JldCEuc2VjcmV0QXJuLFxuICAgICAgICBEQVRBQkFTRV9OQU1FOiAnc29uZ2JpcmRfYW5hbHl0aWNzJyxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgICAgdnBjLFxuICAgICAgdnBjU3VibmV0czogeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTIH0sXG4gICAgfSk7XG5cbiAgICB0aGlzLmNsdXN0ZXIuZ3JhbnREYXRhQXBpQWNjZXNzKHN5bmNMYW1iZGEpO1xuXG4gICAgLy8gQWRkIER5bmFtb0RCIHN0cmVhbSBzb3VyY2VzXG4gICAgc3luY0xhbWJkYS5hZGRFdmVudFNvdXJjZShuZXcgRHluYW1vRXZlbnRTb3VyY2UocHJvcHMuZGV2aWNlc1RhYmxlLCB7XG4gICAgICBzdGFydGluZ1Bvc2l0aW9uOiBsYW1iZGEuU3RhcnRpbmdQb3NpdGlvbi5UUklNX0hPUklaT04sXG4gICAgICBiYXRjaFNpemU6IDEwMCxcbiAgICAgIGJpc2VjdEJhdGNoT25FcnJvcjogdHJ1ZSxcbiAgICAgIHJldHJ5QXR0ZW1wdHM6IDMsXG4gICAgfSkpO1xuXG4gICAgc3luY0xhbWJkYS5hZGRFdmVudFNvdXJjZShuZXcgRHluYW1vRXZlbnRTb3VyY2UocHJvcHMudGVsZW1ldHJ5VGFibGUsIHtcbiAgICAgIHN0YXJ0aW5nUG9zaXRpb246IGxhbWJkYS5TdGFydGluZ1Bvc2l0aW9uLlRSSU1fSE9SSVpPTixcbiAgICAgIGJhdGNoU2l6ZTogMTAwLFxuICAgICAgYmlzZWN0QmF0Y2hPbkVycm9yOiB0cnVlLFxuICAgICAgcmV0cnlBdHRlbXB0czogMyxcbiAgICB9KSk7XG5cbiAgICBzeW5jTGFtYmRhLmFkZEV2ZW50U291cmNlKG5ldyBEeW5hbW9FdmVudFNvdXJjZShwcm9wcy5sb2NhdGlvbnNUYWJsZSwge1xuICAgICAgc3RhcnRpbmdQb3NpdGlvbjogbGFtYmRhLlN0YXJ0aW5nUG9zaXRpb24uVFJJTV9IT1JJWk9OLFxuICAgICAgYmF0Y2hTaXplOiAxMDAsXG4gICAgICBiaXNlY3RCYXRjaE9uRXJyb3I6IHRydWUsXG4gICAgICByZXRyeUF0dGVtcHRzOiAzLFxuICAgIH0pKTtcblxuICAgIHN5bmNMYW1iZGEuYWRkRXZlbnRTb3VyY2UobmV3IER5bmFtb0V2ZW50U291cmNlKHByb3BzLmFsZXJ0c1RhYmxlLCB7XG4gICAgICBzdGFydGluZ1Bvc2l0aW9uOiBsYW1iZGEuU3RhcnRpbmdQb3NpdGlvbi5UUklNX0hPUklaT04sXG4gICAgICBiYXRjaFNpemU6IDEwMCxcbiAgICAgIGJpc2VjdEJhdGNoT25FcnJvcjogdHJ1ZSxcbiAgICAgIHJldHJ5QXR0ZW1wdHM6IDMsXG4gICAgfSkpO1xuXG4gICAgc3luY0xhbWJkYS5hZGRFdmVudFNvdXJjZShuZXcgRHluYW1vRXZlbnRTb3VyY2UocHJvcHMuam91cm5leXNUYWJsZSwge1xuICAgICAgc3RhcnRpbmdQb3NpdGlvbjogbGFtYmRhLlN0YXJ0aW5nUG9zaXRpb24uVFJJTV9IT1JJWk9OLFxuICAgICAgYmF0Y2hTaXplOiAxMDAsXG4gICAgICBiaXNlY3RCYXRjaE9uRXJyb3I6IHRydWUsXG4gICAgICByZXRyeUF0dGVtcHRzOiAzLFxuICAgIH0pKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTGFtYmRhOiBDaGF0IFF1ZXJ5IChUZXh0LXRvLVNRTClcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuY2hhdFF1ZXJ5TGFtYmRhID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdDaGF0UXVlcnlMYW1iZGEnLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hbmFseXRpY3MtY2hhdC1xdWVyeScsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FuYWx5dGljcyBjaGF0IHF1ZXJ5IHdpdGggQmVkcm9jaycsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FuYWx5dGljcy9jaGF0LXF1ZXJ5LnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg2MCksXG4gICAgICBtZW1vcnlTaXplOiAxMDI0LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQ0xVU1RFUl9BUk46IHRoaXMuY2x1c3Rlci5jbHVzdGVyQXJuLFxuICAgICAgICBTRUNSRVRfQVJOOiB0aGlzLmNsdXN0ZXIuc2VjcmV0IS5zZWNyZXRBcm4sXG4gICAgICAgIERBVEFCQVNFX05BTUU6ICdzb25nYmlyZF9hbmFseXRpY3MnLFxuICAgICAgICBDSEFUX0hJU1RPUllfVEFCTEU6IHRoaXMuY2hhdEhpc3RvcnlUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIEJFRFJPQ0tfTU9ERUxfSUQ6ICd1cy5hbnRocm9waWMuY2xhdWRlLTMtNS1zb25uZXQtMjAyNDEwMjItdjI6MCcsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICAgIHZwYyxcbiAgICAgIHZwY1N1Ym5ldHM6IHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyB9LFxuICAgIH0pO1xuXG4gICAgdGhpcy5jbHVzdGVyLmdyYW50RGF0YUFwaUFjY2Vzcyh0aGlzLmNoYXRRdWVyeUxhbWJkYSk7XG4gICAgdGhpcy5jaGF0SGlzdG9yeVRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YSh0aGlzLmNoYXRRdWVyeUxhbWJkYSk7XG5cbiAgICAvLyBHcmFudCBCZWRyb2NrIGFjY2Vzc1xuICAgIHRoaXMuY2hhdFF1ZXJ5TGFtYmRhLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2JlZHJvY2s6SW52b2tlTW9kZWwnXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgfSkpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBMYW1iZGE6IENoYXQgSGlzdG9yeVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5jaGF0SGlzdG9yeUxhbWJkYSA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnQ2hhdEhpc3RvcnlMYW1iZGEnLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hbmFseXRpY3MtY2hhdC1oaXN0b3J5JyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUmV0cmlldmUgYW5hbHl0aWNzIGNoYXQgaGlzdG9yeScsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FuYWx5dGljcy9jaGF0LWhpc3RvcnkudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIENIQVRfSElTVE9SWV9UQUJMRTogdGhpcy5jaGF0SGlzdG9yeVRhYmxlLnRhYmxlTmFtZSxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuXG4gICAgdGhpcy5jaGF0SGlzdG9yeVRhYmxlLmdyYW50UmVhZERhdGEodGhpcy5jaGF0SGlzdG9yeUxhbWJkYSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIExhbWJkYTogTGlzdCBTZXNzaW9uc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5saXN0U2Vzc2lvbnNMYW1iZGEgPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0xpc3RTZXNzaW9uc0xhbWJkYScsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWFuYWx5dGljcy1saXN0LXNlc3Npb25zJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnTGlzdCBhbmFseXRpY3MgY2hhdCBzZXNzaW9ucycsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FuYWx5dGljcy9saXN0LXNlc3Npb25zLnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBDSEFUX0hJU1RPUllfVEFCTEU6IHRoaXMuY2hhdEhpc3RvcnlUYWJsZS50YWJsZU5hbWUsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcblxuICAgIHRoaXMuY2hhdEhpc3RvcnlUYWJsZS5ncmFudFJlYWREYXRhKHRoaXMubGlzdFNlc3Npb25zTGFtYmRhKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTGFtYmRhOiBHZXQgU2Vzc2lvblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5nZXRTZXNzaW9uTGFtYmRhID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdHZXRTZXNzaW9uTGFtYmRhJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYW5hbHl0aWNzLWdldC1zZXNzaW9uJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnR2V0IGFuYWx5dGljcyBjaGF0IHNlc3Npb24gZGV0YWlscycsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FuYWx5dGljcy9nZXQtc2Vzc2lvbi50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQ0hBVF9ISVNUT1JZX1RBQkxFOiB0aGlzLmNoYXRIaXN0b3J5VGFibGUudGFibGVOYW1lLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG5cbiAgICB0aGlzLmNoYXRIaXN0b3J5VGFibGUuZ3JhbnRSZWFkRGF0YSh0aGlzLmdldFNlc3Npb25MYW1iZGEpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBMYW1iZGE6IERlbGV0ZSBTZXNzaW9uXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLmRlbGV0ZVNlc3Npb25MYW1iZGEgPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0RlbGV0ZVNlc3Npb25MYW1iZGEnLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hbmFseXRpY3MtZGVsZXRlLXNlc3Npb24nLFxuICAgICAgZGVzY3JpcHRpb246ICdEZWxldGUgYW5hbHl0aWNzIGNoYXQgc2Vzc2lvbicsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FuYWx5dGljcy9kZWxldGUtc2Vzc2lvbi50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgQ0hBVF9ISVNUT1JZX1RBQkxFOiB0aGlzLmNoYXRIaXN0b3J5VGFibGUudGFibGVOYW1lLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7IG1pbmlmeTogdHJ1ZSwgc291cmNlTWFwOiB0cnVlIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgfSk7XG5cbiAgICB0aGlzLmNoYXRIaXN0b3J5VGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHRoaXMuZGVsZXRlU2Vzc2lvbkxhbWJkYSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIExhbWJkYTogUmVydW4gUXVlcnkgKHJlLWV4ZWN1dGUgc3RvcmVkIFNRTCBmb3IgdmlzdWFsaXphdGlvbnMpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLnJlcnVuUXVlcnlMYW1iZGEgPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ1JlcnVuUXVlcnlMYW1iZGEnLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hbmFseXRpY3MtcmVydW4tcXVlcnknLFxuICAgICAgZGVzY3JpcHRpb246ICdSZS1leGVjdXRlIHN0b3JlZCBTUUwgcXVlcnkgZm9yIHZpc3VhbGl6YXRpb25zJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYW5hbHl0aWNzL3JlcnVuLXF1ZXJ5LnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg2MCksXG4gICAgICBtZW1vcnlTaXplOiA1MTIsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBDTFVTVEVSX0FSTjogdGhpcy5jbHVzdGVyLmNsdXN0ZXJBcm4sXG4gICAgICAgIFNFQ1JFVF9BUk46IHRoaXMuY2x1c3Rlci5zZWNyZXQhLnNlY3JldEFybixcbiAgICAgICAgREFUQUJBU0VfTkFNRTogJ3NvbmdiaXJkX2FuYWx5dGljcycsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHsgbWluaWZ5OiB0cnVlLCBzb3VyY2VNYXA6IHRydWUgfSxcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICAgIHZwYyxcbiAgICAgIHZwY1N1Ym5ldHM6IHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyB9LFxuICAgIH0pO1xuXG4gICAgdGhpcy5jbHVzdGVyLmdyYW50RGF0YUFwaUFjY2Vzcyh0aGlzLnJlcnVuUXVlcnlMYW1iZGEpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBMYW1iZGE6IEJhY2tmaWxsIChvbmUtdGltZSBoaXN0b3JpY2FsIGRhdGEgbWlncmF0aW9uKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYmFja2ZpbGxMYW1iZGEgPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0JhY2tmaWxsTGFtYmRhJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYW5hbHl0aWNzLWJhY2tmaWxsJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQmFja2ZpbGwgaGlzdG9yaWNhbCBEeW5hbW9EQiBkYXRhIHRvIEF1cm9yYScsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2FuYWx5dGljcy9iYWNrZmlsbC50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMTUpLFxuICAgICAgbWVtb3J5U2l6ZTogMTAyNCxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIENMVVNURVJfQVJOOiB0aGlzLmNsdXN0ZXIuY2x1c3RlckFybixcbiAgICAgICAgU0VDUkVUX0FSTjogdGhpcy5jbHVzdGVyLnNlY3JldCEuc2VjcmV0QXJuLFxuICAgICAgICBEQVRBQkFTRV9OQU1FOiAnc29uZ2JpcmRfYW5hbHl0aWNzJyxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzogeyBtaW5pZnk6IHRydWUsIHNvdXJjZU1hcDogdHJ1ZSB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuXG4gICAgdGhpcy5jbHVzdGVyLmdyYW50RGF0YUFwaUFjY2VzcyhiYWNrZmlsbExhbWJkYSk7XG4gICAgcHJvcHMuZGV2aWNlc1RhYmxlLmdyYW50UmVhZERhdGEoYmFja2ZpbGxMYW1iZGEpO1xuICAgIHByb3BzLnRlbGVtZXRyeVRhYmxlLmdyYW50UmVhZERhdGEoYmFja2ZpbGxMYW1iZGEpO1xuICAgIHByb3BzLmxvY2F0aW9uc1RhYmxlLmdyYW50UmVhZERhdGEoYmFja2ZpbGxMYW1iZGEpO1xuICAgIHByb3BzLmFsZXJ0c1RhYmxlLmdyYW50UmVhZERhdGEoYmFja2ZpbGxMYW1iZGEpO1xuICAgIHByb3BzLmpvdXJuZXlzVGFibGUuZ3JhbnRSZWFkRGF0YShiYWNrZmlsbExhbWJkYSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE91dHB1dHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdDbHVzdGVyRW5kcG9pbnQnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5jbHVzdGVyLmNsdXN0ZXJFbmRwb2ludC5ob3N0bmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXVyb3JhIEFuYWx5dGljcyBjbHVzdGVyIGVuZHBvaW50JyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdTZWNyZXRBcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy5jbHVzdGVyLnNlY3JldCEuc2VjcmV0QXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdBdXJvcmEgY3JlZGVudGlhbHMgc2VjcmV0IEFSTicsXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==