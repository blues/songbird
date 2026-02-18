"use strict";
/**
 * Observability Construct
 *
 * Provides AI observability via Arize Phoenix running on ECS Fargate.
 * Captures OpenTelemetry traces from AWS Bedrock calls for monitoring,
 * evaluation, and prompt engineering.
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
exports.ObservabilityConstruct = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const ecs = __importStar(require("aws-cdk-lib/aws-ecs"));
const efs = __importStar(require("aws-cdk-lib/aws-efs"));
const elbv2 = __importStar(require("aws-cdk-lib/aws-elasticloadbalancingv2"));
const acm = __importStar(require("aws-cdk-lib/aws-certificatemanager"));
const route53 = __importStar(require("aws-cdk-lib/aws-route53"));
const targets = __importStar(require("aws-cdk-lib/aws-route53-targets"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const constructs_1 = require("constructs");
class ObservabilityConstruct extends constructs_1.Construct {
    cluster;
    service;
    loadBalancer;
    phoenixEndpoint;
    otlpEndpoint;
    phoenixSecurityGroup;
    constructor(scope, id, props) {
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
        albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS from internet');
        // Allow gRPC from internet to ALB (for OTLP)
        albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(4317), 'Allow gRPC from internet');
        // Allow ALB to reach Phoenix UI
        this.phoenixSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(6006), 'Allow HTTP UI traffic from ALB');
        // Allow ALB to reach OTLP endpoint
        this.phoenixSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(4317), 'Allow OTLP gRPC traffic from ALB');
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
        let httpListener;
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
        }
        else {
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
                target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(this.loadBalancer)),
            });
        }
        // ==========================================================================
        // IAM Permissions
        // ==========================================================================
        // Grant EFS access
        fileSystem.grant(taskDefinition.taskRole, 'elasticfilesystem:ClientMount');
        fileSystem.grant(taskDefinition.taskRole, 'elasticfilesystem:ClientWrite');
        // Grant CloudWatch Logs
        taskDefinition.taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsFullAccess'));
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
    allowTracingFrom(lambda) {
        lambda.connections.allowTo(this.service, ec2.Port.tcp(4317), 'Allow Lambda to send OTLP traces to Phoenix');
    }
}
exports.ObservabilityConstruct = ObservabilityConstruct;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib2JzZXJ2YWJpbGl0eS1jb25zdHJ1Y3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvb2JzZXJ2YWJpbGl0eS1jb25zdHJ1Y3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7R0FNRzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFFSCxpREFBbUM7QUFDbkMseURBQTJDO0FBQzNDLHlEQUEyQztBQUMzQyx5REFBMkM7QUFDM0MsOEVBQWdFO0FBQ2hFLHdFQUEwRDtBQUMxRCxpRUFBbUQ7QUFDbkQseUVBQTJEO0FBQzNELDJEQUE2QztBQUM3Qyx5REFBMkM7QUFDM0MsMkNBQXVDO0FBc0J2QyxNQUFhLHNCQUF1QixTQUFRLHNCQUFTO0lBQ25DLE9BQU8sQ0FBYztJQUNyQixPQUFPLENBQXFCO0lBQzVCLFlBQVksQ0FBZ0M7SUFDNUMsZUFBZSxDQUFTO0lBQ3hCLFlBQVksQ0FBUztJQUNyQixvQkFBb0IsQ0FBb0I7SUFFeEQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFrQztRQUMxRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLDZFQUE2RTtRQUM3RSxjQUFjO1FBQ2QsNkVBQTZFO1FBQzdFLElBQUksQ0FBQyxPQUFPLEdBQUcsSUFBSSxHQUFHLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtZQUNyRCxHQUFHLEVBQUUsS0FBSyxDQUFDLEdBQUc7WUFDZCxXQUFXLEVBQUUsa0JBQWtCO1lBQy9CLGlCQUFpQixFQUFFLElBQUk7U0FDeEIsQ0FBQyxDQUFDO1FBRUgsNkVBQTZFO1FBQzdFLHlDQUF5QztRQUN6Qyw2RUFBNkU7UUFDN0UsTUFBTSxVQUFVLEdBQUcsSUFBSSxHQUFHLENBQUMsVUFBVSxDQUFDLElBQUksRUFBRSxXQUFXLEVBQUU7WUFDdkQsR0FBRyxFQUFFLEtBQUssQ0FBQyxHQUFHO1lBQ2QsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENB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bUJBQW1CLE9BQU8sQ0FBQztRQUUzRSw2RUFBNkU7UUFDN0UsVUFBVTtRQUNWLDZFQUE2RTtRQUM3RSxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRTtZQUN0QyxLQUFLLEVBQUUsSUFBSSxDQUFDLGVBQWU7WUFDM0IsV0FBVyxFQUFFLGdCQUFnQjtZQUM3QixVQUFVLEVBQUUsc0JBQXNCO1NBQ25DLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUscUJBQXFCLEVBQUU7WUFDN0MsS0FBSyxFQUFFLElBQUksQ0FBQyxZQUFZO1lBQ3hCLFdBQVcsRUFBRSwrQ0FBK0M7WUFDNUQsVUFBVSxFQUFFLDZCQUE2QjtTQUMxQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHdCQUF3QixFQUFFO1lBQ2hELEtBQUssRUFBRSxJQUFJLENBQUMsWUFBWSxDQUFDLG1CQUFtQjtZQUM1QyxXQUFXLEVBQUUsc0JBQXNCO1lBQ25DLFVBQVUsRUFBRSx1QkFBdUI7U0FDcEMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVEOztPQUVHO0lBQ0ksZ0JBQWdCLENBQUMsTUFBd0I7UUFDOUMsTUFBTSxDQUFDLFdBQVcsQ0FBQyxPQUFPLENBQ3hCLElBQUksQ0FBQyxPQUFPLEVBQ1osR0FBRyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQ2xCLDZDQUE2QyxDQUM5QyxDQUFDO0lBQ0osQ0FBQztDQUNGO0FBOVRELHdEQThUQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogT2JzZXJ2YWJpbGl0eSBDb25zdHJ1Y3RcbiAqXG4gKiBQcm92aWRlcyBBSSBvYnNlcnZhYmlsaXR5IHZpYSBBcml6ZSBQaG9lbml4IHJ1bm5pbmcgb24gRUNTIEZhcmdhdGUuXG4gKiBDYXB0dXJlcyBPcGVuVGVsZW1ldHJ5IHRyYWNlcyBmcm9tIEFXUyBCZWRyb2NrIGNhbGxzIGZvciBtb25pdG9yaW5nLFxuICogZXZhbHVhdGlvbiwgYW5kIHByb21wdCBlbmdpbmVlcmluZy5cbiAqL1xuXG5pbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xuaW1wb3J0ICogYXMgZWNzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3MnO1xuaW1wb3J0ICogYXMgZWZzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lZnMnO1xuaW1wb3J0ICogYXMgZWxidjIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVsYXN0aWNsb2FkYmFsYW5jaW5ndjInO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXInO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtcm91dGU1Myc7XG5pbXBvcnQgKiBhcyB0YXJnZXRzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1yb3V0ZTUzLXRhcmdldHMnO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcblxuZXhwb3J0IGludGVyZmFjZSBPYnNlcnZhYmlsaXR5Q29uc3RydWN0UHJvcHMge1xuICAvKipcbiAgICogVlBDIHRvIGRlcGxveSBQaG9lbml4IHNlcnZpY2UgaW4uXG4gICAqIFNob3VsZCBiZSB0aGUgc2FtZSBWUEMgYXMgdGhlIGFuYWx5dGljcyBMYW1iZGEgZm9yIGVmZmljaWVudCB0cmFjZSBjb2xsZWN0aW9uLlxuICAgKi9cbiAgdnBjOiBlYzIuSVZwYztcblxuICAvKipcbiAgICogRG9tYWluIG5hbWUgZm9yIFBob2VuaXggVUkgKGUuZy4sICdwaG9lbml4LnNvbmdiaXJkLmxpdmUnKVxuICAgKiBPcHRpb25hbCAtIGlmIG5vdCBwcm92aWRlZCwgd2lsbCB1c2UgQUxCIEROUyBuYW1lXG4gICAqL1xuICBkb21haW5OYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBSb3V0ZTUzIGhvc3RlZCB6b25lIGZvciBETlMgcmVjb3JkIGNyZWF0aW9uXG4gICAqIE9wdGlvbmFsIC0gaWYgbm90IHByb3ZpZGVkLCB3aWxsIHNraXAgRE5TL2NlcnRpZmljYXRlIHNldHVwXG4gICAqL1xuICBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcbn1cblxuZXhwb3J0IGNsYXNzIE9ic2VydmFiaWxpdHlDb25zdHJ1Y3QgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgY2x1c3RlcjogZWNzLkNsdXN0ZXI7XG4gIHB1YmxpYyByZWFkb25seSBzZXJ2aWNlOiBlY3MuRmFyZ2F0ZVNlcnZpY2U7XG4gIHB1YmxpYyByZWFkb25seSBsb2FkQmFsYW5jZXI6IGVsYnYyLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyO1xuICBwdWJsaWMgcmVhZG9ubHkgcGhvZW5peEVuZHBvaW50OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBvdGxwRW5kcG9pbnQ6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IHBob2VuaXhTZWN1cml0eUdyb3VwOiBlYzIuU2VjdXJpdHlHcm91cDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogT2JzZXJ2YWJpbGl0eUNvbnN0cnVjdFByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRUNTIENsdXN0ZXJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuY2x1c3RlciA9IG5ldyBlY3MuQ2x1c3Rlcih0aGlzLCAnUGhvZW5peENsdXN0ZXInLCB7XG4gICAgICB2cGM6IHByb3BzLnZwYyxcbiAgICAgIGNsdXN0ZXJOYW1lOiAnc29uZ2JpcmQtcGhvZW5peCcsXG4gICAgICBjb250YWluZXJJbnNpZ2h0czogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRUZTIEZpbGUgU3lzdGVtIGZvciBQZXJzaXN0ZW50IFN0b3JhZ2VcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGZpbGVTeXN0ZW0gPSBuZXcgZWZzLkZpbGVTeXN0ZW0odGhpcywgJ1Bob2VuaXhGUycsIHtcbiAgICAgIHZwYzogcHJvcHMudnBjLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGVuY3J5cHRlZDogdHJ1ZSxcbiAgICAgIGxpZmVjeWNsZVBvbGljeTogZWZzLkxpZmVjeWNsZVBvbGljeS5BRlRFUl8xNF9EQVlTLFxuICAgICAgcGVyZm9ybWFuY2VNb2RlOiBlZnMuUGVyZm9ybWFuY2VNb2RlLkdFTkVSQUxfUFVSUE9TRSxcbiAgICAgIHZwY1N1Ym5ldHM6IHtcbiAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFNlY3VyaXR5IEdyb3Vwc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5waG9lbml4U2VjdXJpdHlHcm91cCA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCAnUGhvZW5peFNHJywge1xuICAgICAgdnBjOiBwcm9wcy52cGMsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NlY3VyaXR5IGdyb3VwIGZvciBQaG9lbml4IG9ic2VydmFiaWxpdHkgc2VydmljZScsXG4gICAgICBhbGxvd0FsbE91dGJvdW5kOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgY29uc3QgYWxiU2VjdXJpdHlHcm91cCA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCAnUGhvZW5peEFMQlNHJywge1xuICAgICAgdnBjOiBwcm9wcy52cGMsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NlY3VyaXR5IGdyb3VwIGZvciBQaG9lbml4IEFMQicsXG4gICAgICBhbGxvd0FsbE91dGJvdW5kOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgLy8gQWxsb3cgSFRUUFMgZnJvbSBpbnRlcm5ldCB0byBBTEJcbiAgICBhbGJTZWN1cml0eUdyb3VwLmFkZEluZ3Jlc3NSdWxlKFxuICAgICAgZWMyLlBlZXIuYW55SXB2NCgpLFxuICAgICAgZWMyLlBvcnQudGNwKDQ0MyksXG4gICAgICAnQWxsb3cgSFRUUFMgZnJvbSBpbnRlcm5ldCdcbiAgICApO1xuXG4gICAgLy8gQWxsb3cgZ1JQQyBmcm9tIGludGVybmV0IHRvIEFMQiAoZm9yIE9UTFApXG4gICAgYWxiU2VjdXJpdHlHcm91cC5hZGRJbmdyZXNzUnVsZShcbiAgICAgIGVjMi5QZWVyLmFueUlwdjQoKSxcbiAgICAgIGVjMi5Qb3J0LnRjcCg0MzE3KSxcbiAgICAgICdBbGxvdyBnUlBDIGZyb20gaW50ZXJuZXQnXG4gICAgKTtcblxuICAgIC8vIEFsbG93IEFMQiB0byByZWFjaCBQaG9lbml4IFVJXG4gICAgdGhpcy5waG9lbml4U2VjdXJpdHlHcm91cC5hZGRJbmdyZXNzUnVsZShcbiAgICAgIGFsYlNlY3VyaXR5R3JvdXAsXG4gICAgICBlYzIuUG9ydC50Y3AoNjAwNiksXG4gICAgICAnQWxsb3cgSFRUUCBVSSB0cmFmZmljIGZyb20gQUxCJ1xuICAgICk7XG5cbiAgICAvLyBBbGxvdyBBTEIgdG8gcmVhY2ggT1RMUCBlbmRwb2ludFxuICAgIHRoaXMucGhvZW5peFNlY3VyaXR5R3JvdXAuYWRkSW5ncmVzc1J1bGUoXG4gICAgICBhbGJTZWN1cml0eUdyb3VwLFxuICAgICAgZWMyLlBvcnQudGNwKDQzMTcpLFxuICAgICAgJ0FsbG93IE9UTFAgZ1JQQyB0cmFmZmljIGZyb20gQUxCJ1xuICAgICk7XG5cbiAgICAvLyBBbGxvdyBFRlMgYWNjZXNzXG4gICAgZmlsZVN5c3RlbS5jb25uZWN0aW9ucy5hbGxvd0RlZmF1bHRQb3J0RnJvbSh0aGlzLnBob2VuaXhTZWN1cml0eUdyb3VwKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gVGFzayBEZWZpbml0aW9uXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCB0YXNrRGVmaW5pdGlvbiA9IG5ldyBlY3MuRmFyZ2F0ZVRhc2tEZWZpbml0aW9uKHRoaXMsICdQaG9lbml4VGFzaycsIHtcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiAyMDQ4LFxuICAgICAgY3B1OiAxMDI0LFxuICAgICAgZmFtaWx5OiAnc29uZ2JpcmQtcGhvZW5peCcsXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgRUZTIHZvbHVtZSB0byB0YXNrIGRlZmluaXRpb25cbiAgICBjb25zdCB2b2x1bWVOYW1lID0gJ3Bob2VuaXgtZGF0YSc7XG4gICAgdGFza0RlZmluaXRpb24uYWRkVm9sdW1lKHtcbiAgICAgIG5hbWU6IHZvbHVtZU5hbWUsXG4gICAgICBlZnNWb2x1bWVDb25maWd1cmF0aW9uOiB7XG4gICAgICAgIGZpbGVTeXN0ZW1JZDogZmlsZVN5c3RlbS5maWxlU3lzdGVtSWQsXG4gICAgICAgIHRyYW5zaXRFbmNyeXB0aW9uOiAnRU5BQkxFRCcsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gUGhvZW5peCBjb250YWluZXJcbiAgICBjb25zdCBwaG9lbml4Q29udGFpbmVyID0gdGFza0RlZmluaXRpb24uYWRkQ29udGFpbmVyKCdwaG9lbml4Jywge1xuICAgICAgaW1hZ2U6IGVjcy5Db250YWluZXJJbWFnZS5mcm9tUmVnaXN0cnkoJ2FyaXplcGhvZW5peC9waG9lbml4OnZlcnNpb24tOC4wLjAnKSxcbiAgICAgIGxvZ2dpbmc6IGVjcy5Mb2dEcml2ZXJzLmF3c0xvZ3Moe1xuICAgICAgICBzdHJlYW1QcmVmaXg6ICdwaG9lbml4JyxcbiAgICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuVFdPX1dFRUtTLFxuICAgICAgfSksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBQSE9FTklYX1BPUlQ6ICc2MDA2JyxcbiAgICAgICAgUEhPRU5JWF9HUlBDX1BPUlQ6ICc0MzE3JyxcbiAgICAgICAgUEhPRU5JWF9XT1JLSU5HX0RJUjogJy9waG9lbml4LWRhdGEnLFxuICAgICAgICBQSE9FTklYX1NRTF9EQVRBQkFTRV9VUkw6ICdzcWxpdGU6Ly8vL3Bob2VuaXgtZGF0YS9waG9lbml4LmRiJyxcbiAgICAgIH0sXG4gICAgICBwb3J0TWFwcGluZ3M6IFtcbiAgICAgICAge1xuICAgICAgICAgIGNvbnRhaW5lclBvcnQ6IDYwMDYsXG4gICAgICAgICAgcHJvdG9jb2w6IGVjcy5Qcm90b2NvbC5UQ1AsXG4gICAgICAgICAgbmFtZTogJ2h0dHAnLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgY29udGFpbmVyUG9ydDogNDMxNyxcbiAgICAgICAgICBwcm90b2NvbDogZWNzLlByb3RvY29sLlRDUCxcbiAgICAgICAgICBuYW1lOiAnZ3JwYycsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgaGVhbHRoQ2hlY2s6IHtcbiAgICAgICAgY29tbWFuZDogWydDTUQtU0hFTEwnLCAnY3VybCAtZiBodHRwOi8vbG9jYWxob3N0OjYwMDYvaGVhbHRoeiB8fCBleGl0IDEnXSxcbiAgICAgICAgaW50ZXJ2YWw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNSksXG4gICAgICAgIHJldHJpZXM6IDMsXG4gICAgICAgIHN0YXJ0UGVyaW9kOiBjZGsuRHVyYXRpb24uc2Vjb25kcyg2MCksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gTW91bnQgRUZTIHZvbHVtZVxuICAgIHBob2VuaXhDb250YWluZXIuYWRkTW91bnRQb2ludHMoe1xuICAgICAgc291cmNlVm9sdW1lOiB2b2x1bWVOYW1lLFxuICAgICAgY29udGFpbmVyUGF0aDogJy9waG9lbml4LWRhdGEnLFxuICAgICAgcmVhZE9ubHk6IGZhbHNlLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBGYXJnYXRlIFNlcnZpY2VcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuc2VydmljZSA9IG5ldyBlY3MuRmFyZ2F0ZVNlcnZpY2UodGhpcywgJ1Bob2VuaXhTZXJ2aWNlJywge1xuICAgICAgY2x1c3RlcjogdGhpcy5jbHVzdGVyLFxuICAgICAgdGFza0RlZmluaXRpb24sXG4gICAgICBzZXJ2aWNlTmFtZTogJ3Bob2VuaXgnLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgbWluSGVhbHRoeVBlcmNlbnQ6IDAsIC8vIEFsbG93IHNlcnZpY2UgdG8gc3RvcCBkdXJpbmcgdXBkYXRlc1xuICAgICAgbWF4SGVhbHRoeVBlcmNlbnQ6IDIwMCxcbiAgICAgIHZwY1N1Ym5ldHM6IHtcbiAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyxcbiAgICAgIH0sXG4gICAgICBzZWN1cml0eUdyb3VwczogW3RoaXMucGhvZW5peFNlY3VyaXR5R3JvdXBdLFxuICAgICAgZW5hYmxlRXhlY3V0ZUNvbW1hbmQ6IHRydWUsIC8vIEVuYWJsZSBFQ1MgRXhlYyBmb3IgZGVidWdnaW5nXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEFwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMubG9hZEJhbGFuY2VyID0gbmV3IGVsYnYyLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyKHRoaXMsICdQaG9lbml4QUxCJywge1xuICAgICAgdnBjOiBwcm9wcy52cGMsXG4gICAgICBpbnRlcm5ldEZhY2luZzogdHJ1ZSxcbiAgICAgIHNlY3VyaXR5R3JvdXA6IGFsYlNlY3VyaXR5R3JvdXAsXG4gICAgICBsb2FkQmFsYW5jZXJOYW1lOiAnc29uZ2JpcmQtcGhvZW5peCcsXG4gICAgfSk7XG5cbiAgICAvLyBDb25kaXRpb25hbGx5IGNyZWF0ZSBjZXJ0aWZpY2F0ZSBhbmQgSFRUUFMgbGlzdGVuZXIgaWYgZG9tYWluIGlzIHByb3ZpZGVkXG4gICAgbGV0IGh0dHBMaXN0ZW5lcjogZWxidjIuQXBwbGljYXRpb25MaXN0ZW5lcjtcbiAgICBpZiAocHJvcHMuZG9tYWluTmFtZSAmJiBwcm9wcy5ob3N0ZWRab25lKSB7XG4gICAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgICAgLy8gQUNNIENlcnRpZmljYXRlXG4gICAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgICAgY29uc3QgY2VydGlmaWNhdGUgPSBuZXcgYWNtLkNlcnRpZmljYXRlKHRoaXMsICdQaG9lbml4Q2VydCcsIHtcbiAgICAgICAgZG9tYWluTmFtZTogcHJvcHMuZG9tYWluTmFtZSxcbiAgICAgICAgdmFsaWRhdGlvbjogYWNtLkNlcnRpZmljYXRlVmFsaWRhdGlvbi5mcm9tRG5zKHByb3BzLmhvc3RlZFpvbmUpLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIEhUVFBTIGxpc3RlbmVyIGZvciBQaG9lbml4IFVJXG4gICAgICBjb25zdCBodHRwc0xpc3RlbmVyID0gdGhpcy5sb2FkQmFsYW5jZXIuYWRkTGlzdGVuZXIoJ0h0dHBzTGlzdGVuZXInLCB7XG4gICAgICAgIHBvcnQ6IDQ0MyxcbiAgICAgICAgcHJvdG9jb2w6IGVsYnYyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUFMsXG4gICAgICAgIGNlcnRpZmljYXRlczogW2NlcnRpZmljYXRlXSxcbiAgICAgICAgb3BlbjogdHJ1ZSxcbiAgICAgIH0pO1xuXG4gICAgICBodHRwc0xpc3RlbmVyLmFkZFRhcmdldHMoJ1Bob2VuaXhVSScsIHtcbiAgICAgICAgcG9ydDogNjAwNixcbiAgICAgICAgcHJvdG9jb2w6IGVsYnYyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCxcbiAgICAgICAgdGFyZ2V0czogW3RoaXMuc2VydmljZV0sXG4gICAgICAgIGhlYWx0aENoZWNrOiB7XG4gICAgICAgICAgcGF0aDogJy9oZWFsdGh6JyxcbiAgICAgICAgICBpbnRlcnZhbDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDUpLFxuICAgICAgICAgIGhlYWx0aHlUaHJlc2hvbGRDb3VudDogMixcbiAgICAgICAgICB1bmhlYWx0aHlUaHJlc2hvbGRDb3VudDogMyxcbiAgICAgICAgfSxcbiAgICAgICAgZGVyZWdpc3RyYXRpb25EZWxheTogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgfSk7XG5cbiAgICAgIHRoaXMucGhvZW5peEVuZHBvaW50ID0gYGh0dHBzOi8vJHtwcm9wcy5kb21haW5OYW1lfWA7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEhUVFAgbGlzdGVuZXIgZm9yIFBob2VuaXggVUkgKG5vIGNlcnRpZmljYXRlKVxuICAgICAgaHR0cExpc3RlbmVyID0gdGhpcy5sb2FkQmFsYW5jZXIuYWRkTGlzdGVuZXIoJ0h0dHBMaXN0ZW5lcicsIHtcbiAgICAgICAgcG9ydDogODAsXG4gICAgICAgIHByb3RvY29sOiBlbGJ2Mi5BcHBsaWNhdGlvblByb3RvY29sLkhUVFAsXG4gICAgICAgIG9wZW46IHRydWUsXG4gICAgICB9KTtcblxuICAgICAgaHR0cExpc3RlbmVyLmFkZFRhcmdldHMoJ1Bob2VuaXhVSScsIHtcbiAgICAgICAgcG9ydDogNjAwNixcbiAgICAgICAgcHJvdG9jb2w6IGVsYnYyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCxcbiAgICAgICAgdGFyZ2V0czogW3RoaXMuc2VydmljZV0sXG4gICAgICAgIGhlYWx0aENoZWNrOiB7XG4gICAgICAgICAgcGF0aDogJy9oZWFsdGh6JyxcbiAgICAgICAgICBpbnRlcnZhbDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDUpLFxuICAgICAgICAgIGhlYWx0aHlUaHJlc2hvbGRDb3VudDogMixcbiAgICAgICAgICB1bmhlYWx0aHlUaHJlc2hvbGRDb3VudDogMyxcbiAgICAgICAgfSxcbiAgICAgICAgZGVyZWdpc3RyYXRpb25EZWxheTogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgfSk7XG5cbiAgICAgIHRoaXMucGhvZW5peEVuZHBvaW50ID0gYGh0dHA6Ly8ke3RoaXMubG9hZEJhbGFuY2VyLmxvYWRCYWxhbmNlckRuc05hbWV9YDtcbiAgICB9XG5cbiAgICAvLyBIVFRQIGxpc3RlbmVyIGZvciBPVExQIHRyYWNlcyAocG9ydCA0MzE3KVxuICAgIC8vIE5vdGU6IFVzaW5nIEhUVFAgKG5vdCBIVFRQUykgZm9yIHNpbXBsaWNpdHkgc2luY2Ugbm8gZG9tYWluL2NlcnRpZmljYXRlIGlzIGNvbmZpZ3VyZWRcbiAgICAvLyBPVExQIHdvcmtzIGZpbmUgb3ZlciBIVFRQIC0gbm8gbmVlZCBmb3IgZ1JQQyBwcm90b2NvbCB2ZXJzaW9uXG4gICAgY29uc3Qgb3RscExpc3RlbmVyID0gdGhpcy5sb2FkQmFsYW5jZXIuYWRkTGlzdGVuZXIoJ090bHBMaXN0ZW5lcicsIHtcbiAgICAgIHBvcnQ6IDQzMTcsXG4gICAgICBwcm90b2NvbDogZWxidjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgICAgb3BlbjogdHJ1ZSxcbiAgICB9KTtcblxuICAgIG90bHBMaXN0ZW5lci5hZGRUYXJnZXRzKCdQaG9lbml4T1RMUCcsIHtcbiAgICAgIHBvcnQ6IDQzMTcsXG4gICAgICBwcm90b2NvbDogZWxidjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgICAgdGFyZ2V0czogW3RoaXMuc2VydmljZV0sXG4gICAgICAvLyBSZW1vdmVkIHByb3RvY29sVmVyc2lvbiBHUlBDIC0gSFRUUCBsaXN0ZW5lciBkb2Vzbid0IHN1cHBvcnQgaXRcbiAgICAgIC8vIE9UTFAgb3ZlciBIVFRQIHdvcmtzIHdpdGhvdXQgZ1JQQyBwcm90b2NvbCB2ZXJzaW9uXG4gICAgICBoZWFsdGhDaGVjazoge1xuICAgICAgICAvLyBDaGVjayB0aGUgVUkgcG9ydCAoNjAwNikgaGVhbHRoIGVuZHBvaW50IGluc3RlYWQgb2YgT1RMUCBwb3J0XG4gICAgICAgIC8vIE9UTFAgcG9ydCBkb2Vzbid0IGhhdmUgYSBoZWFsdGggY2hlY2sgZW5kcG9pbnRcbiAgICAgICAgcGF0aDogJy9oZWFsdGh6JyxcbiAgICAgICAgcG9ydDogJzYwMDYnLFxuICAgICAgICBpbnRlcnZhbDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg1KSxcbiAgICAgICAgaGVhbHRoeVRocmVzaG9sZENvdW50OiAyLFxuICAgICAgICB1bmhlYWx0aHlUaHJlc2hvbGRDb3VudDogMyxcbiAgICAgIH0sXG4gICAgICBkZXJlZ2lzdHJhdGlvbkRlbGF5OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFJvdXRlNTMgRE5TIFJlY29yZCAob3B0aW9uYWwpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBpZiAocHJvcHMuZG9tYWluTmFtZSAmJiBwcm9wcy5ob3N0ZWRab25lKSB7XG4gICAgICBuZXcgcm91dGU1My5BUmVjb3JkKHRoaXMsICdQaG9lbml4RE5TJywge1xuICAgICAgICB6b25lOiBwcm9wcy5ob3N0ZWRab25lLFxuICAgICAgICByZWNvcmROYW1lOiBwcm9wcy5kb21haW5OYW1lLnNwbGl0KCcuJylbMF0sIC8vIEV4dHJhY3Qgc3ViZG9tYWluXG4gICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKFxuICAgICAgICAgIG5ldyB0YXJnZXRzLkxvYWRCYWxhbmNlclRhcmdldCh0aGlzLmxvYWRCYWxhbmNlcilcbiAgICAgICAgKSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gSUFNIFBlcm1pc3Npb25zXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBHcmFudCBFRlMgYWNjZXNzXG4gICAgZmlsZVN5c3RlbS5ncmFudCh0YXNrRGVmaW5pdGlvbi50YXNrUm9sZSwgJ2VsYXN0aWNmaWxlc3lzdGVtOkNsaWVudE1vdW50Jyk7XG4gICAgZmlsZVN5c3RlbS5ncmFudCh0YXNrRGVmaW5pdGlvbi50YXNrUm9sZSwgJ2VsYXN0aWNmaWxlc3lzdGVtOkNsaWVudFdyaXRlJyk7XG5cbiAgICAvLyBHcmFudCBDbG91ZFdhdGNoIExvZ3NcbiAgICB0YXNrRGVmaW5pdGlvbi50YXNrUm9sZS5hZGRNYW5hZ2VkUG9saWN5KFxuICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdDbG91ZFdhdGNoTG9nc0Z1bGxBY2Nlc3MnKVxuICAgICk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEV4cG9ydHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIHBob2VuaXhFbmRwb2ludCBhbHJlYWR5IHNldCBhYm92ZSBiYXNlZCBvbiBkb21haW4gYXZhaWxhYmlsaXR5XG4gICAgLy8gVXNpbmcgSFRUUCBmb3IgT1RMUCAobm90IGdSUEMpIHNpbmNlIEFMQiBIVFRQIGxpc3RlbmVyIGRvZXNuJ3Qgc3VwcG9ydCBnUlBDIHByb3RvY29sIHZlcnNpb25cbiAgICB0aGlzLm90bHBFbmRwb2ludCA9IGBodHRwOi8vJHt0aGlzLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJEbnNOYW1lfTo0MzE3YDtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gT3V0cHV0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1Bob2VuaXhVSVVybCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnBob2VuaXhFbmRwb2ludCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUGhvZW5peCBVSSBVUkwnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkUGhvZW5peFVJVXJsJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdQaG9lbml4T1RMUEVuZHBvaW50Jywge1xuICAgICAgdmFsdWU6IHRoaXMub3RscEVuZHBvaW50LFxuICAgICAgZGVzY3JpcHRpb246ICdQaG9lbml4IE9UTFAgZ1JQQyBlbmRwb2ludCBmb3IgTGFtYmRhIHRyYWNpbmcnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkUGhvZW5peE9UTFBFbmRwb2ludCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUGhvZW5peExvYWRCYWxhbmNlckROUycsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJEbnNOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdQaG9lbml4IEFMQiBETlMgbmFtZScsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRQaG9lbml4QUxCRE5TJyxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBBbGxvdyBhIExhbWJkYSBmdW5jdGlvbiB0byBzZW5kIHRyYWNlcyB0byBQaG9lbml4XG4gICAqL1xuICBwdWJsaWMgYWxsb3dUcmFjaW5nRnJvbShsYW1iZGE6IGVjMi5JQ29ubmVjdGFibGUpOiB2b2lkIHtcbiAgICBsYW1iZGEuY29ubmVjdGlvbnMuYWxsb3dUbyhcbiAgICAgIHRoaXMuc2VydmljZSxcbiAgICAgIGVjMi5Qb3J0LnRjcCg0MzE3KSxcbiAgICAgICdBbGxvdyBMYW1iZGEgdG8gc2VuZCBPVExQIHRyYWNlcyB0byBQaG9lbml4J1xuICAgICk7XG4gIH1cbn1cbiJdfQ==