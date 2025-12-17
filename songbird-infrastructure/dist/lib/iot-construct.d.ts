/**
 * IoT Construct
 *
 * Defines IoT Core rules for processing events from Notehub.
 * Events are routed to Lambda for processing into DynamoDB.
 */
import * as iot from 'aws-cdk-lib/aws-iot';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
export interface IotConstructProps {
    telemetryTable: dynamodb.Table;
    devicesTable: dynamodb.Table;
    alertTopic: sns.Topic;
}
export declare class IotConstruct extends Construct {
    readonly eventProcessingRule: iot.CfnTopicRule;
    readonly eventProcessorFunction: lambda.Function;
    constructor(scope: Construct, id: string, props: IotConstructProps);
}
