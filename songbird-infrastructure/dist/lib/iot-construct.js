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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW90LWNvbnN0cnVjdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL2xpYi9pb3QtY29uc3RydWN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7R0FLRzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFFSCxpREFBbUM7QUFDbkMseURBQTJDO0FBQzNDLCtEQUFpRDtBQUNqRCx5REFBMkM7QUFHM0MsMkRBQTZDO0FBQzdDLHFFQUErRDtBQUMvRCwyQ0FBdUM7QUFDdkMsMkNBQTZCO0FBUTdCLE1BQWEsWUFBYSxTQUFRLHNCQUFTO0lBQ3pCLG1CQUFtQixDQUFtQjtJQUN0QyxzQkFBc0IsQ0FBa0I7SUFFeEQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUF3QjtRQUNoRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLDZFQUE2RTtRQUM3RSx5QkFBeUI7UUFDekIsNkVBQTZFO1FBQzdFLElBQUksQ0FBQyxzQkFBc0IsR0FBRyxJQUFJLGtDQUFjLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQ3ZFLFlBQVksRUFBRSwwQkFBMEI7WUFDeEMsV0FBVyxFQUFFLDZEQUE2RDtZQUMxRSxPQUFPLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXO1lBQ25DLE9BQU8sRUFBRSxTQUFTO1lBQ2xCLEtBQUssRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxvQ0FBb0MsQ0FBQztZQUNqRSxPQUFPLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1lBQ2pDLFVBQVUsRUFBRSxHQUFHO1lBRWYsV0FBVyxFQUFFO2dCQUNYLGVBQWUsRUFBRSxLQUFLLENBQUMsY0FBYyxDQUFDLFNBQVM7Z0JBQy9DLGFBQWEsRUFBRSxLQUFLLENBQUMsWUFBWSxDQUFDLFNBQVM7Z0JBQzNDLGVBQWUsRUFBRSxLQUFLLENBQUMsVUFBVSxDQUFDLFFBQVE7YUFDM0M7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QXNCO2dCQUN0QixtQkFBbUI7YUFDcEI7WUFDRCxTQUFTLEVBQUUsQ0FBQyxHQUFHLENBQUM7U0FDakIsQ0FBQyxDQUNILENBQUM7SUFDSixDQUFDO0NBQ0Y7QUFqS0Qsb0NBaUtDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBJb1QgQ29uc3RydWN0XG4gKlxuICogRGVmaW5lcyBJb1QgQ29yZSBydWxlcyBmb3IgcHJvY2Vzc2luZyBldmVudHMgZnJvbSBOb3RlaHViLlxuICogRXZlbnRzIGFyZSByb3V0ZWQgdG8gTGFtYmRhIGZvciBwcm9jZXNzaW5nIGludG8gRHluYW1vREIuXG4gKi9cblxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGlvdCBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaW90JztcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIHNucyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc25zJztcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gJ2F3cy1jZGstbGliL2F3cy1keW5hbW9kYic7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCB7IE5vZGVqc0Z1bmN0aW9uIH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYS1ub2RlanMnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuXG5leHBvcnQgaW50ZXJmYWNlIElvdENvbnN0cnVjdFByb3BzIHtcbiAgdGVsZW1ldHJ5VGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBkZXZpY2VzVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBhbGVydFRvcGljOiBzbnMuSVRvcGljO1xufVxuXG5leHBvcnQgY2xhc3MgSW90Q29uc3RydWN0IGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGV2ZW50UHJvY2Vzc2luZ1J1bGU6IGlvdC5DZm5Ub3BpY1J1bGU7XG4gIHB1YmxpYyByZWFkb25seSBldmVudFByb2Nlc3NvckZ1bmN0aW9uOiBsYW1iZGEuRnVuY3Rpb247XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IElvdENvbnN0cnVjdFByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRXZlbnQgUHJvY2Vzc29yIExhbWJkYVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5ldmVudFByb2Nlc3NvckZ1bmN0aW9uID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdFdmVudFByb2Nlc3NvcicsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWV2ZW50LXByb2Nlc3NvcicsXG4gICAgICBkZXNjcmlwdGlvbjogJ1Byb2Nlc3NlcyBTb25nYmlyZCBldmVudHMgZnJvbSBJb1QgQ29yZSwgd3JpdGVzIHRvIER5bmFtb0RCJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvZXZlbnQtcHJvY2Vzc29yL2luZGV4LnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG5cbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFRFTEVNRVRSWV9UQUJMRTogcHJvcHMudGVsZW1ldHJ5VGFibGUudGFibGVOYW1lLFxuICAgICAgICBERVZJQ0VTX1RBQkxFOiBwcm9wcy5kZXZpY2VzVGFibGUudGFibGVOYW1lLFxuICAgICAgICBBTEVSVF9UT1BJQ19BUk46IHByb3BzLmFsZXJ0VG9waWMudG9waWNBcm4sXG4gICAgICB9LFxuXG4gICAgICBidW5kbGluZzoge1xuICAgICAgICBtaW5pZnk6IHRydWUsXG4gICAgICAgIHNvdXJjZU1hcDogdHJ1ZSxcbiAgICAgIH0sXG5cbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcblxuICAgIC8vIEdyYW50IER5bmFtb0RCIHBlcm1pc3Npb25zXG4gICAgcHJvcHMudGVsZW1ldHJ5VGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHRoaXMuZXZlbnRQcm9jZXNzb3JGdW5jdGlvbik7XG4gICAgcHJvcHMuZGV2aWNlc1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YSh0aGlzLmV2ZW50UHJvY2Vzc29yRnVuY3Rpb24pO1xuXG4gICAgLy8gR3JhbnQgU05TIHB1Ymxpc2ggZm9yIGFsZXJ0c1xuICAgIHByb3BzLmFsZXJ0VG9waWMuZ3JhbnRQdWJsaXNoKHRoaXMuZXZlbnRQcm9jZXNzb3JGdW5jdGlvbik7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEFsZXJ0IEhhbmRsZXIgTGFtYmRhIChmb3IgYWxlcnQtc3BlY2lmaWMgcHJvY2Vzc2luZylcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGFsZXJ0SGFuZGxlciA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnQWxlcnRIYW5kbGVyJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc29uZ2JpcmQtYWxlcnQtaGFuZGxlcicsXG4gICAgICBkZXNjcmlwdGlvbjogJ0hhbmRsZXMgU29uZ2JpcmQgYWxlcnQgZXZlbnRzLCBzZW5kcyBub3RpZmljYXRpb25zJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvYWxlcnQtaGFuZGxlci9pbmRleC50cycpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTUpLFxuICAgICAgbWVtb3J5U2l6ZTogMTI4LFxuXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBBTEVSVF9UT1BJQ19BUk46IHByb3BzLmFsZXJ0VG9waWMudG9waWNBcm4sXG4gICAgICAgIERFVklDRVNfVEFCTEU6IHByb3BzLmRldmljZXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICB9LFxuXG4gICAgICBidW5kbGluZzoge1xuICAgICAgICBtaW5pZnk6IHRydWUsXG4gICAgICAgIHNvdXJjZU1hcDogdHJ1ZSxcbiAgICAgIH0sXG5cbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICB9KTtcblxuICAgIHByb3BzLmFsZXJ0VG9waWMuZ3JhbnRQdWJsaXNoKGFsZXJ0SGFuZGxlcik7XG4gICAgcHJvcHMuZGV2aWNlc1RhYmxlLmdyYW50UmVhZERhdGEoYWxlcnRIYW5kbGVyKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gSW9UIENvcmUgUm9sZSBmb3IgTGFtYmRhIEludm9jYXRpb25cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGlvdFJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ0lvdFJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnaW90LmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUm9sZSBmb3IgSW9UIENvcmUgdG8gaW52b2tlIFNvbmdiaXJkIExhbWJkYSBmdW5jdGlvbnMnLFxuICAgIH0pO1xuXG4gICAgdGhpcy5ldmVudFByb2Nlc3NvckZ1bmN0aW9uLmdyYW50SW52b2tlKGlvdFJvbGUpO1xuICAgIGFsZXJ0SGFuZGxlci5ncmFudEludm9rZShpb3RSb2xlKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTWFpbiBFdmVudCBQcm9jZXNzaW5nIFJ1bGVcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFRoaXMgcnVsZSBwcm9jZXNzZXMgYWxsIGV2ZW50cyBmcm9tIHRoZSBzb25nYmlyZC9ldmVudHMgdG9waWNcbiAgICB0aGlzLmV2ZW50UHJvY2Vzc2luZ1J1bGUgPSBuZXcgaW90LkNmblRvcGljUnVsZSh0aGlzLCAnRXZlbnRSdWxlJywge1xuICAgICAgcnVsZU5hbWU6ICdzb25nYmlyZF9ldmVudF9wcm9jZXNzb3InLFxuXG4gICAgICB0b3BpY1J1bGVQYXlsb2FkOiB7XG4gICAgICAgIGRlc2NyaXB0aW9uOiAnUHJvY2VzcyBhbGwgU29uZ2JpcmQgZXZlbnRzIGZyb20gTm90ZWh1YicsXG4gICAgICAgIHNxbDogXCJTRUxFQ1QgKiBGUk9NICdzb25nYmlyZC9ldmVudHMnXCIsXG4gICAgICAgIGF3c0lvdFNxbFZlcnNpb246ICcyMDE2LTAzLTIzJyxcblxuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgbGFtYmRhOiB7XG4gICAgICAgICAgICAgIGZ1bmN0aW9uQXJuOiB0aGlzLmV2ZW50UHJvY2Vzc29yRnVuY3Rpb24uZnVuY3Rpb25Bcm4sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG5cbiAgICAgICAgZXJyb3JBY3Rpb246IHtcbiAgICAgICAgICBjbG91ZHdhdGNoTG9nczoge1xuICAgICAgICAgICAgbG9nR3JvdXBOYW1lOiBgL2F3cy9pb3Qvc29uZ2JpcmQtZXJyb3JzYCxcbiAgICAgICAgICAgIHJvbGVBcm46IGlvdFJvbGUucm9sZUFybixcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEFsbG93IElvVCB0byBpbnZva2UgdGhlIExhbWJkYVxuICAgIHRoaXMuZXZlbnRQcm9jZXNzb3JGdW5jdGlvbi5hZGRQZXJtaXNzaW9uKCdJb3RJbnZva2UnLCB7XG4gICAgICBwcmluY2lwYWw6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnaW90LmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIHNvdXJjZUFybjogdGhpcy5ldmVudFByb2Nlc3NpbmdSdWxlLmF0dHJBcm4sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEFsZXJ0LVNwZWNpZmljIFJ1bGVcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFNlcGFyYXRlIHJ1bGUgZm9yIGFsZXJ0IGV2ZW50cyB0byBlbmFibGUgc3BlY2lhbGl6ZWQgcHJvY2Vzc2luZ1xuICAgIGNvbnN0IGFsZXJ0UnVsZSA9IG5ldyBpb3QuQ2ZuVG9waWNSdWxlKHRoaXMsICdBbGVydFJ1bGUnLCB7XG4gICAgICBydWxlTmFtZTogJ3NvbmdiaXJkX2FsZXJ0X3Byb2Nlc3NvcicsXG5cbiAgICAgIHRvcGljUnVsZVBheWxvYWQ6IHtcbiAgICAgICAgZGVzY3JpcHRpb246ICdQcm9jZXNzIFNvbmdiaXJkIGFsZXJ0IGV2ZW50cycsXG4gICAgICAgIHNxbDogXCJTRUxFQ1QgKiBGUk9NICdzb25nYmlyZC9ldmVudHMnIFdIRVJFIGV2ZW50X3R5cGUgPSAnYWxlcnQucW8nXCIsXG4gICAgICAgIGF3c0lvdFNxbFZlcnNpb246ICcyMDE2LTAzLTIzJyxcblxuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgbGFtYmRhOiB7XG4gICAgICAgICAgICAgIGZ1bmN0aW9uQXJuOiBhbGVydEhhbmRsZXIuZnVuY3Rpb25Bcm4sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgYWxlcnRIYW5kbGVyLmFkZFBlcm1pc3Npb24oJ0lvdEludm9rZScsIHtcbiAgICAgIHByaW5jaXBhbDogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdpb3QuYW1hem9uYXdzLmNvbScpLFxuICAgICAgc291cmNlQXJuOiBhbGVydFJ1bGUuYXR0ckFybixcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ2xvdWRXYXRjaCBMb2cgR3JvdXAgZm9yIElvVCBFcnJvcnNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsICdJb3RFcnJvckxvZ3MnLCB7XG4gICAgICBsb2dHcm91cE5hbWU6ICcvYXdzL2lvdC9zb25nYmlyZC1lcnJvcnMnLFxuICAgICAgcmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIC8vIEdyYW50IElvVCByb2xlIHBlcm1pc3Npb24gdG8gd3JpdGUgbG9nc1xuICAgIGlvdFJvbGUuYWRkVG9Qb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAnbG9nczpDcmVhdGVMb2dTdHJlYW0nLFxuICAgICAgICAgICdsb2dzOlB1dExvZ0V2ZW50cycsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICB9KVxuICAgICk7XG4gIH1cbn1cbiJdfQ==