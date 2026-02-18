/**
 * Observability Construct
 *
 * Provides AI observability via Arize Phoenix running on ECS Fargate.
 * Captures OpenTelemetry traces from AWS Bedrock calls for monitoring,
 * evaluation, and prompt engineering.
 */
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
export interface ObservabilityConstructProps {
    /**
     * VPC to deploy Phoenix service in.
     * Should be the same VPC as the analytics Lambda for efficient trace collection.
     */
    vpc: ec2.IVpc;
    /**
     * Domain name for Phoenix UI (e.g., 'phoenix.songbird.live')
     * Optional - if not provided, will use ALB DNS name
     */
    domainName?: string;
    /**
     * Route53 hosted zone for DNS record creation
     * Optional - if not provided, will skip DNS/certificate setup
     */
    hostedZone?: route53.IHostedZone;
}
export declare class ObservabilityConstruct extends Construct {
    readonly cluster: ecs.Cluster;
    readonly service: ecs.FargateService;
    readonly loadBalancer: elbv2.ApplicationLoadBalancer;
    readonly phoenixEndpoint: string;
    readonly otlpEndpoint: string;
    readonly phoenixSecurityGroup: ec2.SecurityGroup;
    constructor(scope: Construct, id: string, props: ObservabilityConstructProps);
    /**
     * Allow a Lambda function to send traces to Phoenix
     */
    allowTracingFrom(lambda: ec2.IConnectable): void;
}
