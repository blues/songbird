/**
 * Observability Construct
 *
 * Provides AI observability via Arize Phoenix running on ECS Fargate.
 * Captures OpenTelemetry traces from AWS Bedrock calls for monitoring,
 * evaluation, and prompt engineering.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
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

export class ObservabilityConstruct extends Construct {
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly phoenixEndpoint: string;
  public readonly otlpEndpoint: string;
  public readonly phoenixSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: ObservabilityConstructProps) {
    super(scope, id);

    // ==========================================================================
    // ECS Cluster
    // ==========================================================================
    this.cluster = new ecs.Cluster(this, 'PhoenixCluster', {
      vpc: props.vpc,
      clusterName: 'songbird-phoenix',
      containerInsights: true,
    });

    // ==========================================================================
    // EFS File System for Persistent Storage
    // ==========================================================================
    const fileSystem = new efs.FileSystem(this, 'PhoenixFS', {
      vpc: props.vpc,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // ==========================================================================
    // Security Groups
    // ==========================================================================
    this.phoenixSecurityGroup = new ec2.SecurityGroup(this, 'PhoenixSG', {
      vpc: props.vpc,
      description: 'Security group for Phoenix observability service',
      allowAllOutbound: true,
    });

    const albSecurityGroup = new ec2.SecurityGroup(this, 'PhoenixALBSG', {
      vpc: props.vpc,
      description: 'Security group for Phoenix ALB',
      allowAllOutbound: true,
    });

    // Allow HTTPS from internet to ALB
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS from internet'
    );

    // Allow gRPC from internet to ALB (for OTLP)
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(4317),
      'Allow gRPC from internet'
    );

    // Allow ALB to reach Phoenix UI
    this.phoenixSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(6006),
      'Allow HTTP UI traffic from ALB'
    );

    // Allow ALB to reach OTLP endpoint
    this.phoenixSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(4317),
      'Allow OTLP gRPC traffic from ALB'
    );

    // Allow EFS access
    fileSystem.connections.allowDefaultPortFrom(this.phoenixSecurityGroup);

    // ==========================================================================
    // Task Definition
    // ==========================================================================
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'PhoenixTask', {
      memoryLimitMiB: 2048,
      cpu: 1024,
      family: 'songbird-phoenix',
    });

    // Add EFS volume to task definition
    const volumeName = 'phoenix-data';
    taskDefinition.addVolume({
      name: volumeName,
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
      },
    });

    // Phoenix container
    const phoenixContainer = taskDefinition.addContainer('phoenix', {
      image: ecs.ContainerImage.fromRegistry('arizephoenix/phoenix:version-8.0.0'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'phoenix',
        logRetention: logs.RetentionDays.TWO_WEEKS,
      }),
      environment: {
        PHOENIX_PORT: '6006',
        PHOENIX_GRPC_PORT: '4317',
        PHOENIX_WORKING_DIR: '/phoenix-data',
        PHOENIX_SQL_DATABASE_URL: 'sqlite:////phoenix-data/phoenix.db',
      },
      portMappings: [
        {
          containerPort: 6006,
          protocol: ecs.Protocol.TCP,
          name: 'http',
        },
        {
          containerPort: 4317,
          protocol: ecs.Protocol.TCP,
          name: 'grpc',
        },
      ],
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:6006/healthz || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    // Mount EFS volume
    phoenixContainer.addMountPoints({
      sourceVolume: volumeName,
      containerPath: '/phoenix-data',
      readOnly: false,
    });

    // ==========================================================================
    // Fargate Service
    // ==========================================================================
    this.service = new ecs.FargateService(this, 'PhoenixService', {
      cluster: this.cluster,
      taskDefinition,
      serviceName: 'phoenix',
      desiredCount: 1,
      minHealthyPercent: 0, // Allow service to stop during updates
      maxHealthyPercent: 200,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [this.phoenixSecurityGroup],
      enableExecuteCommand: true, // Enable ECS Exec for debugging
    });

    // ==========================================================================
    // Application Load Balancer
    // ==========================================================================
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'PhoenixALB', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      loadBalancerName: 'songbird-phoenix',
    });

    // Conditionally create certificate and HTTPS listener if domain is provided
    let httpListener: elbv2.ApplicationListener;
    if (props.domainName && props.hostedZone) {
      // ==========================================================================
      // ACM Certificate
      // ==========================================================================
      const certificate = new acm.Certificate(this, 'PhoenixCert', {
        domainName: props.domainName,
        validation: acm.CertificateValidation.fromDns(props.hostedZone),
      });

      // HTTPS listener for Phoenix UI
      const httpsListener = this.loadBalancer.addListener('HttpsListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
        open: true,
      });

      httpsListener.addTargets('PhoenixUI', {
        port: 6006,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [this.service],
        healthCheck: {
          path: '/healthz',
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
        },
        deregistrationDelay: cdk.Duration.seconds(30),
      });

      this.phoenixEndpoint = `https://${props.domainName}`;
    } else {
      // HTTP listener for Phoenix UI (no certificate)
      httpListener = this.loadBalancer.addListener('HttpListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        open: true,
      });

      httpListener.addTargets('PhoenixUI', {
        port: 6006,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [this.service],
        healthCheck: {
          path: '/healthz',
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
        },
        deregistrationDelay: cdk.Duration.seconds(30),
      });

      this.phoenixEndpoint = `http://${this.loadBalancer.loadBalancerDnsName}`;
    }

    // HTTP listener for OTLP traces (port 4317)
    // Note: Using HTTP (not HTTPS) for simplicity since no domain/certificate is configured
    // OTLP works fine over HTTP - no need for gRPC protocol version
    const otlpListener = this.loadBalancer.addListener('OtlpListener', {
      port: 4317,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: true,
    });

    otlpListener.addTargets('PhoenixOTLP', {
      port: 4317,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      // Removed protocolVersion GRPC - HTTP listener doesn't support it
      // OTLP over HTTP works without gRPC protocol version
      healthCheck: {
        // Check the UI port (6006) health endpoint instead of OTLP port
        // OTLP port doesn't have a health check endpoint
        path: '/healthz',
        port: '6006',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ==========================================================================
    // Route53 DNS Record (optional)
    // ==========================================================================
    if (props.domainName && props.hostedZone) {
      new route53.ARecord(this, 'PhoenixDNS', {
        zone: props.hostedZone,
        recordName: props.domainName.split('.')[0], // Extract subdomain
        target: route53.RecordTarget.fromAlias(
          new targets.LoadBalancerTarget(this.loadBalancer)
        ),
      });
    }

    // ==========================================================================
    // IAM Permissions
    // ==========================================================================
    // Grant EFS access
    fileSystem.grant(taskDefinition.taskRole, 'elasticfilesystem:ClientMount');
    fileSystem.grant(taskDefinition.taskRole, 'elasticfilesystem:ClientWrite');

    // Grant CloudWatch Logs
    taskDefinition.taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsFullAccess')
    );

    // ==========================================================================
    // Exports
    // ==========================================================================
    // phoenixEndpoint already set above based on domain availability
    // Using HTTP for OTLP (not gRPC) since ALB HTTP listener doesn't support gRPC protocol version
    this.otlpEndpoint = `http://${this.loadBalancer.loadBalancerDnsName}:4317`;

    // ==========================================================================
    // Outputs
    // ==========================================================================
    new cdk.CfnOutput(this, 'PhoenixUIUrl', {
      value: this.phoenixEndpoint,
      description: 'Phoenix UI URL',
      exportName: 'SongbirdPhoenixUIUrl',
    });

    new cdk.CfnOutput(this, 'PhoenixOTLPEndpoint', {
      value: this.otlpEndpoint,
      description: 'Phoenix OTLP gRPC endpoint for Lambda tracing',
      exportName: 'SongbirdPhoenixOTLPEndpoint',
    });

    new cdk.CfnOutput(this, 'PhoenixLoadBalancerDNS', {
      value: this.loadBalancer.loadBalancerDnsName,
      description: 'Phoenix ALB DNS name',
      exportName: 'SongbirdPhoenixALBDNS',
    });
  }

  /**
   * Allow a Lambda function to send traces to Phoenix
   */
  public allowTracingFrom(lambda: ec2.IConnectable): void {
    lambda.connections.allowTo(
      this.service,
      ec2.Port.tcp(4317),
      'Allow Lambda to send OTLP traces to Phoenix'
    );
  }
}
