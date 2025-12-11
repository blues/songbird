/**
 * IoT Construct
 *
 * Defines IoT Core rules for processing events from Notehub.
 * Events are routed to Lambda for processing into Timestream and DynamoDB.
 */

import * as cdk from 'aws-cdk-lib';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as timestream from 'aws-cdk-lib/aws-timestream';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface IotConstructProps {
  timestreamDatabase: timestream.CfnDatabase;
  timestreamTable: timestream.CfnTable;
  devicesTable: dynamodb.Table;
  alertTopic: sns.Topic;
}

export class IotConstruct extends Construct {
  public readonly eventProcessingRule: iot.CfnTopicRule;
  public readonly eventProcessorFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: IotConstructProps) {
    super(scope, id);

    // ==========================================================================
    // Event Processor Lambda
    // ==========================================================================
    this.eventProcessorFunction = new NodejsFunction(this, 'EventProcessor', {
      functionName: 'songbird-event-processor',
      description: 'Processes Songbird events from IoT Core, writes to Timestream and DynamoDB',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/event-processor/index.ts'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,

      environment: {
        TIMESTREAM_DATABASE: props.timestreamDatabase.databaseName!,
        TIMESTREAM_TABLE: props.timestreamTable.tableName!,
        DEVICES_TABLE: props.devicesTable.tableName,
        ALERT_TOPIC_ARN: props.alertTopic.topicArn,
      },

      bundling: {
        minify: true,
        sourceMap: true,
      },

      logRetention: logs.RetentionDays.TWO_WEEKS,
    });

    // Grant Timestream write permissions
    this.eventProcessorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'timestream:WriteRecords',
          'timestream:DescribeEndpoints',
        ],
        resources: ['*'], // Timestream requires * for DescribeEndpoints
      })
    );

    // Specific table permission
    this.eventProcessorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['timestream:WriteRecords'],
        resources: [
          `arn:aws:timestream:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:database/${props.timestreamDatabase.databaseName}/table/${props.timestreamTable.tableName}`,
        ],
      })
    );

    // Grant DynamoDB permissions
    props.devicesTable.grantReadWriteData(this.eventProcessorFunction);

    // Grant SNS publish for alerts
    props.alertTopic.grantPublish(this.eventProcessorFunction);

    // ==========================================================================
    // Alert Handler Lambda (for alert-specific processing)
    // ==========================================================================
    const alertHandler = new NodejsFunction(this, 'AlertHandler', {
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
    iotRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: ['*'],
      })
    );
  }
}
