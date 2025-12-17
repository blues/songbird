"use strict";
/**
 * IoT Construct
 *
 * Defines IoT Core rules for processing events from Notehub.
 * Events are routed to Lambda for processing into DynamoDB.
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
exports.IotConstruct = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const iot = __importStar(require("aws-cdk-lib/aws-iot"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const aws_lambda_nodejs_1 = require("aws-cdk-lib/aws-lambda-nodejs");
const constructs_1 = require("constructs");
const path = __importStar(require("path"));
class IotConstruct extends constructs_1.Construct {
    eventProcessingRule;
    eventProcessorFunction;
    constructor(scope, id, props) {
        super(scope, id);
        // ==========================================================================
        // Event Processor Lambda
        // ==========================================================================
        this.eventProcessorFunction = new aws_lambda_nodejs_1.NodejsFunction(this, 'EventProcessor', {
            functionName: 'songbird-event-processor',
            description: 'Processes Songbird events from IoT Core, writes to DynamoDB',
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'handler',
            entry: path.join(__dirname, '../lambda/event-processor/index.ts'),
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
            environment: {
                TELEMETRY_TABLE: props.telemetryTable.tableName,
                DEVICES_TABLE: props.devicesTable.tableName,
                ALERT_TOPIC_ARN: props.alertTopic.topicArn,
            },
            bundling: {
                minify: true,
                sourceMap: true,
            },
            logRetention: logs.RetentionDays.TWO_WEEKS,
        });
        // Grant DynamoDB permissions
        props.telemetryTable.grantReadWriteData(this.eventProcessorFunction);
        props.devicesTable.grantReadWriteData(this.eventProcessorFunction);
        // Grant SNS publish for alerts
        props.alertTopic.grantPublish(this.eventProcessorFunction);
        // ==========================================================================
        // Alert Handler Lambda (for alert-specific processing)
        // ==========================================================================
        const alertHandler = new aws_lambda_nodejs_1.NodejsFunction(this, 'AlertHandler', {
            functionName: 'songbird-alert-handler',
            description: 'Handles Songbird alert events, sends notifications',
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'handler',
            entry: path.join(__dirname, '../lambda/alert-handler/index.ts'),
            timeout: cdk.Duration.seconds(15),
            memorySize: 128,
            environment: {
                ALERT_TOPIC_ARN: props.alertTopic.topicArn,
                DEVICES_TABLE: props.devicesTable.tableName,
            },
            bundling: {
                minify: true,
                sourceMap: true,
            },
            logRetention: logs.RetentionDays.TWO_WEEKS,
        });
        props.alertTopic.grantPublish(alertHandler);
        props.devicesTable.grantReadData(alertHandler);
        // ==========================================================================
        // IoT Core Role for Lambda Invocation
        // ==========================================================================
        const iotRole = new iam.Role(this, 'IotRole', {
            assumedBy: new iam.ServicePrincipal('iot.amazonaws.com'),
            description: 'Role for IoT Core to invoke Songbird Lambda functions',
        });
        this.eventProcessorFunction.grantInvoke(iotRole);
        alertHandler.grantInvoke(iotRole);
        // ==========================================================================
        // Main Event Processing Rule
        // ==========================================================================
        // This rule processes all events from the songbird/events topic
        this.eventProcessingRule = new iot.CfnTopicRule(this, 'EventRule', {
            ruleName: 'songbird_event_processor',
            topicRulePayload: {
                description: 'Process all Songbird events from Notehub',
                sql: "SELECT * FROM 'songbird/events'",
                awsIotSqlVersion: '2016-03-23',
                actions: [
                    {
                        lambda: {
                            functionArn: this.eventProcessorFunction.functionArn,
                        },
                    },
                ],
                errorAction: {
                    cloudwatchLogs: {
                        logGroupName: `/aws/iot/songbird-errors`,
                        roleArn: iotRole.roleArn,
                    },
                },
            },
        });
        // Allow IoT to invoke the Lambda
        this.eventProcessorFunction.addPermission('IotInvoke', {
            principal: new iam.ServicePrincipal('iot.amazonaws.com'),
            sourceArn: this.eventProcessingRule.attrArn,
        });
        // ==========================================================================
        // Alert-Specific Rule
        // ==========================================================================
        // Separate rule for alert events to enable specialized processing
        const alertRule = new iot.CfnTopicRule(this, 'AlertRule', {
            ruleName: 'songbird_alert_processor',
            topicRulePayload: {
                description: 'Process Songbird alert events',
                sql: "SELECT * FROM 'songbird/events' WHERE event_type = 'alert.qo'",
                awsIotSqlVersion: '2016-03-23',
                actions: [
                    {
                        lambda: {
                            functionArn: alertHandler.functionArn,
                        },
                    },
                ],
            },
        });
        alertHandler.addPermission('IotInvoke', {
            principal: new iam.ServicePrincipal('iot.amazonaws.com'),
            sourceArn: alertRule.attrArn,
        });
        // ==========================================================================
        // CloudWatch Log Group for IoT Errors
        // ==========================================================================
        new logs.LogGroup(this, 'IotErrorLogs', {
            logGroupName: '/aws/iot/songbird-errors',
            retention: logs.RetentionDays.TWO_WEEKS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        // Grant IoT role permission to write logs
        iotRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'logs:CreateLogStream',
                'logs:PutLogEvents',
            ],
            resources: ['*'],
        }));
    }
}
exports.IotConstruct = IotConstruct;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW90LWNvbnN0cnVjdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL2xpYi9pb3QtY29uc3RydWN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7R0FLRzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFFSCxpREFBbUM7QUFDbkMseURBQTJDO0FBQzNDLCtEQUFpRDtBQUNqRCx5REFBMkM7QUFHM0MsMkRBQTZDO0FBQzdDLHFFQUErRDtBQUMvRCwyQ0FBdUM7QUFDdkMsMkNBQTZCO0FBUTdCLE1BQWEsWUFBYSxTQUFRLHNCQUFTO0lBQ3pCLG1CQUFtQixDQUFtQjtJQUN0QyxzQkFBc0IsQ0FBa0I7SUFFeEQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUF3QjtRQUNoRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLDZFQUE2RTtRQUM3RSx5QkFBeUI7UUFDekIsNkVBQTZFO1FBQzdFLElBQUksQ0FBQyxzQkFBc0IsR0FBRyxJQUFJLGtDQUFjLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQ3ZFLFlBQVksRUFBRSwwQkFBMEI7WUFDeEMsV0FBVyxFQUFFLDZEQUE2RDtZQUMxRSxPQUFPLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXO1lBQ25DLE9BQU8sRUFBRSxTQUFTO1lBQ2xCLEtBQUssRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxvQ0FBb0MsQ0FBQztZQUNqRSxPQUFPLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1lBQ2pDLFVBQVUsRUFBRSxHQUFHO1lBRWYsV0FBVyxFQUFFO2dCQUNYLGVBQWUsRUFBRSxLQUFLLENBQUMsY0FBYyxDQUFDLFNBQVM7Z0JBQy9DLGFBQWEsRUFBRSxLQUFLLENBQUMsWUFBWSxDQUFDLFNBQVM7Z0JBQzNDLGVBQWUsRUFBRSxLQUFLLENBQUMsVUFBVSxDQUFDLFFBQVE7YUFDM0M7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QXNCO2dCQUN0QixtQkFBbUI7YUFDcEI7WUFDRCxTQUFTLEVBQUUsQ0FBQyxHQUFHLENBQUM7U0FDakIsQ0FBQyxDQUNILENBQUM7SUFDSixDQUFDO0NBQ0Y7QUFqS0Qsb0NBaUtDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBJb1QgQ29uc3RydWN0XG4gKlxuICogRGVmaW5lcyBJb1QgQ29yZSBydWxlcyBmb3IgcHJvY2Vzc2luZyBldmVudHMgZnJvbSBOb3RlaHViLlxuICogRXZlbnRzIGFyZSByb3V0ZWQgdG8gTGFtYmRhIGZvciBwcm9jZXNzaW5nIGludG8gRHluYW1vREIuXG4gKi9cblxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGlvdCBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaW90JztcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIHNucyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc25zJztcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gJ2F3cy1jZGstbGliL2F3cy1keW5hbW9kYic7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCB7IE5vZGVqc0Z1bmN0aW9uIH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYS1ub2RlanMnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuXG5leHBvcnQgaW50ZXJmYWNlIElvdENvbnN0cnVjdFByb3BzIHtcbiAgdGVsZW1ldHJ5VGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBkZXZpY2VzVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBhbGVydFRvcGljOiBzbnMuVG9waWM7XG59XG5cbmV4cG9ydCBjbGFzcyBJb3RDb25zdHJ1Y3QgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgZXZlbnRQcm9jZXNzaW5nUnVsZTogaW90LkNmblRvcGljUnVsZTtcbiAgcHVibGljIHJlYWRvbmx5IGV2ZW50UHJvY2Vzc29yRnVuY3Rpb246IGxhbWJkYS5GdW5jdGlvbjtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogSW90Q29uc3RydWN0UHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBFdmVudCBQcm9jZXNzb3IgTGFtYmRhXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLmV2ZW50UHJvY2Vzc29yRnVuY3Rpb24gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0V2ZW50UHJvY2Vzc29yJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtZXZlbnQtcHJvY2Vzc29yJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUHJvY2Vzc2VzIFNvbmdiaXJkIGV2ZW50cyBmcm9tIElvVCBDb3JlLCB3cml0ZXMgdG8gRHluYW1vREInLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9ldmVudC1wcm9jZXNzb3IvaW5kZXgudHMnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcblxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgVEVMRU1FVFJZX1RBQkxFOiBwcm9wcy50ZWxlbWV0cnlUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIERFVklDRVNfVEFCTEU6IHByb3BzLmRldmljZXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIEFMRVJUX1RPUElDX0FSTjogcHJvcHMuYWxlcnRUb3BpYy50b3BpY0FybixcbiAgICAgIH0sXG5cbiAgICAgIGJ1bmRsaW5nOiB7XG4gICAgICAgIG1pbmlmeTogdHJ1ZSxcbiAgICAgICAgc291cmNlTWFwOiB0cnVlLFxuICAgICAgfSxcblxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuXG4gICAgLy8gR3JhbnQgRHluYW1vREIgcGVybWlzc2lvbnNcbiAgICBwcm9wcy50ZWxlbWV0cnlUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEodGhpcy5ldmVudFByb2Nlc3NvckZ1bmN0aW9uKTtcbiAgICBwcm9wcy5kZXZpY2VzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHRoaXMuZXZlbnRQcm9jZXNzb3JGdW5jdGlvbik7XG5cbiAgICAvLyBHcmFudCBTTlMgcHVibGlzaCBmb3IgYWxlcnRzXG4gICAgcHJvcHMuYWxlcnRUb3BpYy5ncmFudFB1Ymxpc2godGhpcy5ldmVudFByb2Nlc3NvckZ1bmN0aW9uKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQWxlcnQgSGFuZGxlciBMYW1iZGEgKGZvciBhbGVydC1zcGVjaWZpYyBwcm9jZXNzaW5nKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYWxlcnRIYW5kbGVyID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdBbGVydEhhbmRsZXInLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6ICdzb25nYmlyZC1hbGVydC1oYW5kbGVyJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnSGFuZGxlcyBTb25nYmlyZCBhbGVydCBldmVudHMsIHNlbmRzIG5vdGlmaWNhdGlvbnMnLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9hbGVydC1oYW5kbGVyL2luZGV4LnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygxNSksXG4gICAgICBtZW1vcnlTaXplOiAxMjgsXG5cbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIEFMRVJUX1RPUElDX0FSTjogcHJvcHMuYWxlcnRUb3BpYy50b3BpY0FybixcbiAgICAgICAgREVWSUNFU19UQUJMRTogcHJvcHMuZGV2aWNlc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgIH0sXG5cbiAgICAgIGJ1bmRsaW5nOiB7XG4gICAgICAgIG1pbmlmeTogdHJ1ZSxcbiAgICAgICAgc291cmNlTWFwOiB0cnVlLFxuICAgICAgfSxcblxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgIH0pO1xuXG4gICAgcHJvcHMuYWxlcnRUb3BpYy5ncmFudFB1Ymxpc2goYWxlcnRIYW5kbGVyKTtcbiAgICBwcm9wcy5kZXZpY2VzVGFibGUuZ3JhbnRSZWFkRGF0YShhbGVydEhhbmRsZXIpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBJb1QgQ29yZSBSb2xlIGZvciBMYW1iZGEgSW52b2NhdGlvblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgaW90Um9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnSW90Um9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdpb3QuYW1hem9uYXdzLmNvbScpLFxuICAgICAgZGVzY3JpcHRpb246ICdSb2xlIGZvciBJb1QgQ29yZSB0byBpbnZva2UgU29uZ2JpcmQgTGFtYmRhIGZ1bmN0aW9ucycsXG4gICAgfSk7XG5cbiAgICB0aGlzLmV2ZW50UHJvY2Vzc29yRnVuY3Rpb24uZ3JhbnRJbnZva2UoaW90Um9sZSk7XG4gICAgYWxlcnRIYW5kbGVyLmdyYW50SW52b2tlKGlvdFJvbGUpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBNYWluIEV2ZW50IFByb2Nlc3NpbmcgUnVsZVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gVGhpcyBydWxlIHByb2Nlc3NlcyBhbGwgZXZlbnRzIGZyb20gdGhlIHNvbmdiaXJkL2V2ZW50cyB0b3BpY1xuICAgIHRoaXMuZXZlbnRQcm9jZXNzaW5nUnVsZSA9IG5ldyBpb3QuQ2ZuVG9waWNSdWxlKHRoaXMsICdFdmVudFJ1bGUnLCB7XG4gICAgICBydWxlTmFtZTogJ3NvbmdiaXJkX2V2ZW50X3Byb2Nlc3NvcicsXG5cbiAgICAgIHRvcGljUnVsZVBheWxvYWQ6IHtcbiAgICAgICAgZGVzY3JpcHRpb246ICdQcm9jZXNzIGFsbCBTb25nYmlyZCBldmVudHMgZnJvbSBOb3RlaHViJyxcbiAgICAgICAgc3FsOiBcIlNFTEVDVCAqIEZST00gJ3NvbmdiaXJkL2V2ZW50cydcIixcbiAgICAgICAgYXdzSW90U3FsVmVyc2lvbjogJzIwMTYtMDMtMjMnLFxuXG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBsYW1iZGE6IHtcbiAgICAgICAgICAgICAgZnVuY3Rpb25Bcm46IHRoaXMuZXZlbnRQcm9jZXNzb3JGdW5jdGlvbi5mdW5jdGlvbkFybixcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcblxuICAgICAgICBlcnJvckFjdGlvbjoge1xuICAgICAgICAgIGNsb3Vkd2F0Y2hMb2dzOiB7XG4gICAgICAgICAgICBsb2dHcm91cE5hbWU6IGAvYXdzL2lvdC9zb25nYmlyZC1lcnJvcnNgLFxuICAgICAgICAgICAgcm9sZUFybjogaW90Um9sZS5yb2xlQXJuLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gQWxsb3cgSW9UIHRvIGludm9rZSB0aGUgTGFtYmRhXG4gICAgdGhpcy5ldmVudFByb2Nlc3NvckZ1bmN0aW9uLmFkZFBlcm1pc3Npb24oJ0lvdEludm9rZScsIHtcbiAgICAgIHByaW5jaXBhbDogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdpb3QuYW1hem9uYXdzLmNvbScpLFxuICAgICAgc291cmNlQXJuOiB0aGlzLmV2ZW50UHJvY2Vzc2luZ1J1bGUuYXR0ckFybixcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQWxlcnQtU3BlY2lmaWMgUnVsZVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gU2VwYXJhdGUgcnVsZSBmb3IgYWxlcnQgZXZlbnRzIHRvIGVuYWJsZSBzcGVjaWFsaXplZCBwcm9jZXNzaW5nXG4gICAgY29uc3QgYWxlcnRSdWxlID0gbmV3IGlvdC5DZm5Ub3BpY1J1bGUodGhpcywgJ0FsZXJ0UnVsZScsIHtcbiAgICAgIHJ1bGVOYW1lOiAnc29uZ2JpcmRfYWxlcnRfcHJvY2Vzc29yJyxcblxuICAgICAgdG9waWNSdWxlUGF5bG9hZDoge1xuICAgICAgICBkZXNjcmlwdGlvbjogJ1Byb2Nlc3MgU29uZ2JpcmQgYWxlcnQgZXZlbnRzJyxcbiAgICAgICAgc3FsOiBcIlNFTEVDVCAqIEZST00gJ3NvbmdiaXJkL2V2ZW50cycgV0hFUkUgZXZlbnRfdHlwZSA9ICdhbGVydC5xbydcIixcbiAgICAgICAgYXdzSW90U3FsVmVyc2lvbjogJzIwMTYtMDMtMjMnLFxuXG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBsYW1iZGE6IHtcbiAgICAgICAgICAgICAgZnVuY3Rpb25Bcm46IGFsZXJ0SGFuZGxlci5mdW5jdGlvbkFybixcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBhbGVydEhhbmRsZXIuYWRkUGVybWlzc2lvbignSW90SW52b2tlJywge1xuICAgICAgcHJpbmNpcGFsOiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2lvdC5hbWF6b25hd3MuY29tJyksXG4gICAgICBzb3VyY2VBcm46IGFsZXJ0UnVsZS5hdHRyQXJuLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDbG91ZFdhdGNoIExvZyBHcm91cCBmb3IgSW9UIEVycm9yc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgJ0lvdEVycm9yTG9ncycsIHtcbiAgICAgIGxvZ0dyb3VwTmFtZTogJy9hd3MvaW90L3NvbmdiaXJkLWVycm9ycycsXG4gICAgICByZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIH0pO1xuXG4gICAgLy8gR3JhbnQgSW9UIHJvbGUgcGVybWlzc2lvbiB0byB3cml0ZSBsb2dzXG4gICAgaW90Um9sZS5hZGRUb1BvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICdsb2dzOkNyZWF0ZUxvZ1N0cmVhbScsXG4gICAgICAgICAgJ2xvZ3M6UHV0TG9nRXZlbnRzJyxcbiAgICAgICAgXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgIH0pXG4gICAgKTtcbiAgfVxufVxuIl19