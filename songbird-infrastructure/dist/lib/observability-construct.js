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
    grpcEndpoint;
    phoenixSecurityGroup;
    albSecurityGroup;
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
        this.albSecurityGroup = new ec2.SecurityGroup(this, 'PhoenixALBSG', {
            vpc: props.vpc,
            description: 'Security group for Phoenix ALB',
            allowAllOutbound: true,
        });
        // Allow HTTPS from internet to ALB
        this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS from internet');
        // Allow gRPC from internet to ALB (for OTLP)
        this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(4317), 'Allow gRPC from internet');
        // Allow ALB to reach Phoenix UI
        this.phoenixSecurityGroup.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(6006), 'Allow HTTP UI traffic from ALB');
        // Allow ALB to reach OTLP endpoint
        this.phoenixSecurityGroup.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(4317), 'Allow OTLP gRPC traffic from ALB');
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
            image: ecs.ContainerImage.fromRegistry('arizephoenix/phoenix:version-13.0.3'),
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
            // Removed container health check - relying on ALB target group health checks instead
            // Phoenix container may not have curl/wget, and ALB checks are sufficient
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
            securityGroup: this.albSecurityGroup,
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
                targets: [this.service.loadBalancerTarget({ containerName: 'phoenix', containerPort: 6006 })],
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
                targets: [this.service.loadBalancerTarget({ containerName: 'phoenix', containerPort: 6006 })],
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
        // Phoenix v13+ serves OTLP HTTP on port 6006 (same as UI), so no separate
        // port 4318 listener is needed. OTLP traces go through the HTTPS/443 listener.
        // gRPC listener for OTLP traces (port 4317)
        // Using HTTP protocol for gRPC over HTTP/2
        const grpcListener = this.loadBalancer.addListener("GrpcListener", {
            port: 4317,
            protocol: elbv2.ApplicationProtocol.HTTP,
            open: true,
        });
        grpcListener.addTargets("PhoenixGRPC", {
            port: 4317,
            protocol: elbv2.ApplicationProtocol.HTTP,
            // Note: AWS ALB gRPC support requires HTTPS listener, which needs TLS certs
            // For simplicity, using plain HTTP without GRPC protocol version
            targets: [this.service.loadBalancerTarget({ containerName: 'phoenix', containerPort: 4317 })],
            healthCheck: {
                path: "/healthz",
                port: "6006",
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
        // Phoenix v13+ serves OTLP HTTP on the same port as the UI (6006)
        // Route through HTTPS/443 listener which forwards to container port 6006
        this.otlpEndpoint = `https://${props.domainName || this.loadBalancer.loadBalancerDnsName}/v1/traces`;
        this.grpcEndpoint = `http://${this.loadBalancer.loadBalancerDnsName}:4317`;
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
     * Allow a Lambda function to send traces and access the Phoenix API via ALB
     */
    allowTracingFrom(lambda) {
        // Phoenix v13+ serves OTLP and REST API on the same port as UI (6006),
        // accessible via HTTPS/443 on the ALB
        lambda.connections.allowTo(this.albSecurityGroup, ec2.Port.tcp(443), 'Allow Lambda to send OTLP traces and access Phoenix API via ALB HTTPS');
    }
}
exports.ObservabilityConstruct = ObservabilityConstruct;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib2JzZXJ2YWJpbGl0eS1jb25zdHJ1Y3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvb2JzZXJ2YWJpbGl0eS1jb25zdHJ1Y3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7R0FNRzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFFSCxpREFBbUM7QUFDbkMseURBQTJDO0FBQzNDLHlEQUEyQztBQUMzQyx5REFBMkM7QUFDM0MsOEVBQWdFO0FBQ2hFLHdFQUEwRDtBQUMxRCxpRUFBbUQ7QUFDbkQseUVBQTJEO0FBQzNELDJEQUE2QztBQUM3Qyx5REFBMkM7QUFDM0MsMkNBQXVDO0FBc0J2QyxNQUFhLHNCQUF1QixTQUFRLHNCQUFTO0lBQ25DLE9BQU8sQ0FBYztJQUNyQixPQUFPLENBQXFCO0lBQzVCLFlBQVksQ0FBZ0M7SUFDNUMsZUFBZSxDQUFTO0lBQ3hCLFlBQVksQ0FBUztJQUNyQixZQUFZLENBQVM7SUFDckIsb0JBQW9CLENBQW9CO0lBQ3hDLGdCQUFnQixDQUFvQjtJQUVwRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQWtDO1FBQzFFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsNkVBQTZFO1FBQzdFLGNBQWM7UUFDZCw2RUFBNkU7UUFDN0UsSUFBSSxDQUFDLE9BQU8sR0FBRyxJQUFJLEdBQUcsQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQ3JELEdBQUcsRUFBRSxLQUFLLENBQUMsR0FBRztZQUNkLFdBQVcsRUFBRSxrQkFBa0I7WUFDL0IsaUJBQWlCLEVBQUUsSUFBSTtTQUN4QixDQUFDLENBQUM7UUFFSCw2RUFBNkU7UUFDN0UseUNBQXlDO1FBQ3pDLDZFQUE2RTtRQUM3RSxNQUFNLFVBQVUsR0FBRyxJQUFJLEdBQUcsQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLFdBQVcsRUFBRTtZQUN2RCxHQUFHLEVBQUUsS0FBSyxDQUFDLEdB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cnZhYmlsaXR5IENvbnN0cnVjdFxuICpcbiAqIFByb3ZpZGVzIEFJIG9ic2VydmFiaWxpdHkgdmlhIEFyaXplIFBob2VuaXggcnVubmluZyBvbiBFQ1MgRmFyZ2F0ZS5cbiAqIENhcHR1cmVzIE9wZW5UZWxlbWV0cnkgdHJhY2VzIGZyb20gQVdTIEJlZHJvY2sgY2FsbHMgZm9yIG1vbml0b3JpbmcsXG4gKiBldmFsdWF0aW9uLCBhbmQgcHJvbXB0IGVuZ2luZWVyaW5nLlxuICovXG5cbmltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjMic7XG5pbXBvcnQgKiBhcyBlY3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcyc7XG5pbXBvcnQgKiBhcyBlZnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVmcyc7XG5pbXBvcnQgKiBhcyBlbGJ2MiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mic7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSAnYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlcic7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1yb3V0ZTUzJztcbmltcG9ydCAqIGFzIHRhcmdldHMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXJvdXRlNTMtdGFyZ2V0cyc7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIE9ic2VydmFiaWxpdHlDb25zdHJ1Y3RQcm9wcyB7XG4gIC8qKlxuICAgKiBWUEMgdG8gZGVwbG95IFBob2VuaXggc2VydmljZSBpbi5cbiAgICogU2hvdWxkIGJlIHRoZSBzYW1lIFZQQyBhcyB0aGUgYW5hbHl0aWNzIExhbWJkYSBmb3IgZWZmaWNpZW50IHRyYWNlIGNvbGxlY3Rpb24uXG4gICAqL1xuICB2cGM6IGVjMi5JVnBjO1xuXG4gIC8qKlxuICAgKiBEb21haW4gbmFtZSBmb3IgUGhvZW5peCBVSSAoZS5nLiwgJ3Bob2VuaXguc29uZ2JpcmQubGl2ZScpXG4gICAqIE9wdGlvbmFsIC0gaWYgbm90IHByb3ZpZGVkLCB3aWxsIHVzZSBBTEIgRE5TIG5hbWVcbiAgICovXG4gIGRvbWFpbk5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIEROUyByZWNvcmQgY3JlYXRpb25cbiAgICogT3B0aW9uYWwgLSBpZiBub3QgcHJvdmlkZWQsIHdpbGwgc2tpcCBETlMvY2VydGlmaWNhdGUgc2V0dXBcbiAgICovXG4gIGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xufVxuXG5leHBvcnQgY2xhc3MgT2JzZXJ2YWJpbGl0eUNvbnN0cnVjdCBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBjbHVzdGVyOiBlY3MuQ2x1c3RlcjtcbiAgcHVibGljIHJlYWRvbmx5IHNlcnZpY2U6IGVjcy5GYXJnYXRlU2VydmljZTtcbiAgcHVibGljIHJlYWRvbmx5IGxvYWRCYWxhbmNlcjogZWxidjIuQXBwbGljYXRpb25Mb2FkQmFsYW5jZXI7XG4gIHB1YmxpYyByZWFkb25seSBwaG9lbml4RW5kcG9pbnQ6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IG90bHBFbmRwb2ludDogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgZ3JwY0VuZHBvaW50OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBwaG9lbml4U2VjdXJpdHlHcm91cDogZWMyLlNlY3VyaXR5R3JvdXA7XG4gIHB1YmxpYyByZWFkb25seSBhbGJTZWN1cml0eUdyb3VwOiBlYzIuU2VjdXJpdHlHcm91cDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogT2JzZXJ2YWJpbGl0eUNvbnN0cnVjdFByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRUNTIENsdXN0ZXJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuY2x1c3RlciA9IG5ldyBlY3MuQ2x1c3Rlcih0aGlzLCAnUGhvZW5peENsdXN0ZXInLCB7XG4gICAgICB2cGM6IHByb3BzLnZwYyxcbiAgICAgIGNsdXN0ZXJOYW1lOiAnc29uZ2JpcmQtcGhvZW5peCcsXG4gICAgICBjb250YWluZXJJbnNpZ2h0czogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRUZTIEZpbGUgU3lzdGVtIGZvciBQZXJzaXN0ZW50IFN0b3JhZ2VcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGZpbGVTeXN0ZW0gPSBuZXcgZWZzLkZpbGVTeXN0ZW0odGhpcywgJ1Bob2VuaXhGUycsIHtcbiAgICAgIHZwYzogcHJvcHMudnBjLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGVuY3J5cHRlZDogdHJ1ZSxcbiAgICAgIGxpZmVjeWNsZVBvbGljeTogZWZzLkxpZmVjeWNsZVBvbGljeS5BRlRFUl8xNF9EQVlTLFxuICAgICAgcGVyZm9ybWFuY2VNb2RlOiBlZnMuUGVyZm9ybWFuY2VNb2RlLkdFTkVSQUxfUFVSUE9TRSxcbiAgICAgIHZwY1N1Ym5ldHM6IHtcbiAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFNlY3VyaXR5IEdyb3Vwc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5waG9lbml4U2VjdXJpdHlHcm91cCA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCAnUGhvZW5peFNHJywge1xuICAgICAgdnBjOiBwcm9wcy52cGMsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NlY3VyaXR5IGdyb3VwIGZvciBQaG9lbml4IG9ic2VydmFiaWxpdHkgc2VydmljZScsXG4gICAgICBhbGxvd0FsbE91dGJvdW5kOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hbGJTZWN1cml0eUdyb3VwID0gbmV3IGVjMi5TZWN1cml0eUdyb3VwKHRoaXMsICdQaG9lbml4QUxCU0cnLCB7XG4gICAgICB2cGM6IHByb3BzLnZwYyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU2VjdXJpdHkgZ3JvdXAgZm9yIFBob2VuaXggQUxCJyxcbiAgICAgIGFsbG93QWxsT3V0Ym91bmQ6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyBBbGxvdyBIVFRQUyBmcm9tIGludGVybmV0IHRvIEFMQlxuICAgIHRoaXMuYWxiU2VjdXJpdHlHcm91cC5hZGRJbmdyZXNzUnVsZShcbiAgICAgIGVjMi5QZWVyLmFueUlwdjQoKSxcbiAgICAgIGVjMi5Qb3J0LnRjcCg0NDMpLFxuICAgICAgJ0FsbG93IEhUVFBTIGZyb20gaW50ZXJuZXQnXG4gICAgKTtcblxuICAgIC8vIEFsbG93IGdSUEMgZnJvbSBpbnRlcm5ldCB0byBBTEIgKGZvciBPVExQKVxuICAgIHRoaXMuYWxiU2VjdXJpdHlHcm91cC5hZGRJbmdyZXNzUnVsZShcbiAgICAgIGVjMi5QZWVyLmFueUlwdjQoKSxcbiAgICAgIGVjMi5Qb3J0LnRjcCg0MzE3KSxcbiAgICAgICdBbGxvdyBnUlBDIGZyb20gaW50ZXJuZXQnXG4gICAgKTtcblxuICAgIC8vIEFsbG93IEFMQiB0byByZWFjaCBQaG9lbml4IFVJXG4gICAgdGhpcy5waG9lbml4U2VjdXJpdHlHcm91cC5hZGRJbmdyZXNzUnVsZShcbiAgICAgIHRoaXMuYWxiU2VjdXJpdHlHcm91cCxcbiAgICAgIGVjMi5Qb3J0LnRjcCg2MDA2KSxcbiAgICAgICdBbGxvdyBIVFRQIFVJIHRyYWZmaWMgZnJvbSBBTEInXG4gICAgKTtcblxuICAgIC8vIEFsbG93IEFMQiB0byByZWFjaCBPVExQIGVuZHBvaW50XG4gICAgdGhpcy5waG9lbml4U2VjdXJpdHlHcm91cC5hZGRJbmdyZXNzUnVsZShcbiAgICAgIHRoaXMuYWxiU2VjdXJpdHlHcm91cCxcbiAgICAgIGVjMi5Qb3J0LnRjcCg0MzE3KSxcbiAgICAgICdBbGxvdyBPVExQIGdSUEMgdHJhZmZpYyBmcm9tIEFMQidcbiAgICApO1xuXG4gICAgLy8gQWxsb3cgRUZTIGFjY2Vzc1xuICAgIGZpbGVTeXN0ZW0uY29ubmVjdGlvbnMuYWxsb3dEZWZhdWx0UG9ydEZyb20odGhpcy5waG9lbml4U2VjdXJpdHlHcm91cCk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFRhc2sgRGVmaW5pdGlvblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgdGFza0RlZmluaXRpb24gPSBuZXcgZWNzLkZhcmdhdGVUYXNrRGVmaW5pdGlvbih0aGlzLCAnUGhvZW5peFRhc2snLCB7XG4gICAgICBtZW1vcnlMaW1pdE1pQjogMjA0OCxcbiAgICAgIGNwdTogMTAyNCxcbiAgICAgIGZhbWlseTogJ3NvbmdiaXJkLXBob2VuaXgnLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIEVGUyB2b2x1bWUgdG8gdGFzayBkZWZpbml0aW9uXG4gICAgY29uc3Qgdm9sdW1lTmFtZSA9ICdwaG9lbml4LWRhdGEnO1xuICAgIHRhc2tEZWZpbml0aW9uLmFkZFZvbHVtZSh7XG4gICAgICBuYW1lOiB2b2x1bWVOYW1lLFxuICAgICAgZWZzVm9sdW1lQ29uZmlndXJhdGlvbjoge1xuICAgICAgICBmaWxlU3lzdGVtSWQ6IGZpbGVTeXN0ZW0uZmlsZVN5c3RlbUlkLFxuICAgICAgICB0cmFuc2l0RW5jcnlwdGlvbjogJ0VOQUJMRUQnLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIFBob2VuaXggY29udGFpbmVyXG4gICAgY29uc3QgcGhvZW5peENvbnRhaW5lciA9IHRhc2tEZWZpbml0aW9uLmFkZENvbnRhaW5lcigncGhvZW5peCcsIHtcbiAgICAgIGltYWdlOiBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbVJlZ2lzdHJ5KCdhcml6ZXBob2VuaXgvcGhvZW5peDp2ZXJzaW9uLTEzLjAuMycpLFxuICAgICAgbG9nZ2luZzogZWNzLkxvZ0RyaXZlcnMuYXdzTG9ncyh7XG4gICAgICAgIHN0cmVhbVByZWZpeDogJ3Bob2VuaXgnLFxuICAgICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fV0VFS1MsXG4gICAgICB9KSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFBIT0VOSVhfUE9SVDogJzYwMDYnLFxuICAgICAgICBQSE9FTklYX0dSUENfUE9SVDogJzQzMTcnLFxuICAgICAgICBQSE9FTklYX1dPUktJTkdfRElSOiAnL3Bob2VuaXgtZGF0YScsXG4gICAgICAgIFBIT0VOSVhfU1FMX0RBVEFCQVNFX1VSTDogJ3NxbGl0ZTovLy8vcGhvZW5peC1kYXRhL3Bob2VuaXguZGInLFxuICAgICAgfSxcbiAgICAgIHBvcnRNYXBwaW5nczogW1xuICAgICAgICB7XG4gICAgICAgICAgY29udGFpbmVyUG9ydDogNjAwNixcbiAgICAgICAgICBwcm90b2NvbDogZWNzLlByb3RvY29sLlRDUCxcbiAgICAgICAgICBuYW1lOiAnaHR0cCcsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBjb250YWluZXJQb3J0OiA0MzE3LFxuICAgICAgICAgIHByb3RvY29sOiBlY3MuUHJvdG9jb2wuVENQLFxuICAgICAgICAgIG5hbWU6ICdncnBjJyxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICAvLyBSZW1vdmVkIGNvbnRhaW5lciBoZWFsdGggY2hlY2sgLSByZWx5aW5nIG9uIEFMQiB0YXJnZXQgZ3JvdXAgaGVhbHRoIGNoZWNrcyBpbnN0ZWFkXG4gICAgICAvLyBQaG9lbml4IGNvbnRhaW5lciBtYXkgbm90IGhhdmUgY3VybC93Z2V0LCBhbmQgQUxCIGNoZWNrcyBhcmUgc3VmZmljaWVudFxuICAgIH0pO1xuXG4gICAgLy8gTW91bnQgRUZTIHZvbHVtZVxuICAgIHBob2VuaXhDb250YWluZXIuYWRkTW91bnRQb2ludHMoe1xuICAgICAgc291cmNlVm9sdW1lOiB2b2x1bWVOYW1lLFxuICAgICAgY29udGFpbmVyUGF0aDogJy9waG9lbml4LWRhdGEnLFxuICAgICAgcmVhZE9ubHk6IGZhbHNlLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBGYXJnYXRlIFNlcnZpY2VcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuc2VydmljZSA9IG5ldyBlY3MuRmFyZ2F0ZVNlcnZpY2UodGhpcywgJ1Bob2VuaXhTZXJ2aWNlJywge1xuICAgICAgY2x1c3RlcjogdGhpcy5jbHVzdGVyLFxuICAgICAgdGFza0RlZmluaXRpb24sXG4gICAgICBzZXJ2aWNlTmFtZTogJ3Bob2VuaXgnLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgbWluSGVhbHRoeVBlcmNlbnQ6IDAsIC8vIEFsbG93IHNlcnZpY2UgdG8gc3RvcCBkdXJpbmcgdXBkYXRlc1xuICAgICAgbWF4SGVhbHRoeVBlcmNlbnQ6IDIwMCxcbiAgICAgIHZwY1N1Ym5ldHM6IHtcbiAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyxcbiAgICAgIH0sXG4gICAgICBzZWN1cml0eUdyb3VwczogW3RoaXMucGhvZW5peFNlY3VyaXR5R3JvdXBdLFxuICAgICAgZW5hYmxlRXhlY3V0ZUNvbW1hbmQ6IHRydWUsIC8vIEVuYWJsZSBFQ1MgRXhlYyBmb3IgZGVidWdnaW5nXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEFwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMubG9hZEJhbGFuY2VyID0gbmV3IGVsYnYyLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyKHRoaXMsICdQaG9lbml4QUxCJywge1xuICAgICAgdnBjOiBwcm9wcy52cGMsXG4gICAgICBpbnRlcm5ldEZhY2luZzogdHJ1ZSxcbiAgICAgIHNlY3VyaXR5R3JvdXA6IHRoaXMuYWxiU2VjdXJpdHlHcm91cCxcbiAgICAgIGxvYWRCYWxhbmNlck5hbWU6ICdzb25nYmlyZC1waG9lbml4JyxcbiAgICB9KTtcblxuICAgIC8vIENvbmRpdGlvbmFsbHkgY3JlYXRlIGNlcnRpZmljYXRlIGFuZCBIVFRQUyBsaXN0ZW5lciBpZiBkb21haW4gaXMgcHJvdmlkZWRcbiAgICBsZXQgaHR0cExpc3RlbmVyOiBlbGJ2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyO1xuICAgIGlmIChwcm9wcy5kb21haW5OYW1lICYmIHByb3BzLmhvc3RlZFpvbmUpIHtcbiAgICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgICAvLyBBQ00gQ2VydGlmaWNhdGVcbiAgICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgICBjb25zdCBjZXJ0aWZpY2F0ZSA9IG5ldyBhY20uQ2VydGlmaWNhdGUodGhpcywgJ1Bob2VuaXhDZXJ0Jywge1xuICAgICAgICBkb21haW5OYW1lOiBwcm9wcy5kb21haW5OYW1lLFxuICAgICAgICB2YWxpZGF0aW9uOiBhY20uQ2VydGlmaWNhdGVWYWxpZGF0aW9uLmZyb21EbnMocHJvcHMuaG9zdGVkWm9uZSksXG4gICAgICB9KTtcblxuICAgICAgLy8gSFRUUFMgbGlzdGVuZXIgZm9yIFBob2VuaXggVUlcbiAgICAgIGNvbnN0IGh0dHBzTGlzdGVuZXIgPSB0aGlzLmxvYWRCYWxhbmNlci5hZGRMaXN0ZW5lcignSHR0cHNMaXN0ZW5lcicsIHtcbiAgICAgICAgcG9ydDogNDQzLFxuICAgICAgICBwcm90b2NvbDogZWxidjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQUyxcbiAgICAgICAgY2VydGlmaWNhdGVzOiBbY2VydGlmaWNhdGVdLFxuICAgICAgICBvcGVuOiB0cnVlLFxuICAgICAgfSk7XG5cbiAgICAgIGh0dHBzTGlzdGVuZXIuYWRkVGFyZ2V0cygnUGhvZW5peFVJJywge1xuICAgICAgICBwb3J0OiA2MDA2LFxuICAgICAgICBwcm90b2NvbDogZWxidjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgICAgICB0YXJnZXRzOiBbdGhpcy5zZXJ2aWNlLmxvYWRCYWxhbmNlclRhcmdldCh7IGNvbnRhaW5lck5hbWU6ICdwaG9lbml4JywgY29udGFpbmVyUG9ydDogNjAwNiB9KV0sXG4gICAgICAgIGhlYWx0aENoZWNrOiB7XG4gICAgICAgICAgcGF0aDogJy9oZWFsdGh6JyxcbiAgICAgICAgICBpbnRlcnZhbDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDUpLFxuICAgICAgICAgIGhlYWx0aHlUaHJlc2hvbGRDb3VudDogMixcbiAgICAgICAgICB1bmhlYWx0aHlUaHJlc2hvbGRDb3VudDogMyxcbiAgICAgICAgfSxcbiAgICAgICAgZGVyZWdpc3RyYXRpb25EZWxheTogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgfSk7XG5cbiAgICAgIHRoaXMucGhvZW5peEVuZHBvaW50ID0gYGh0dHBzOi8vJHtwcm9wcy5kb21haW5OYW1lfWA7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEhUVFAgbGlzdGVuZXIgZm9yIFBob2VuaXggVUkgKG5vIGNlcnRpZmljYXRlKVxuICAgICAgaHR0cExpc3RlbmVyID0gdGhpcy5sb2FkQmFsYW5jZXIuYWRkTGlzdGVuZXIoJ0h0dHBMaXN0ZW5lcicsIHtcbiAgICAgICAgcG9ydDogODAsXG4gICAgICAgIHByb3RvY29sOiBlbGJ2Mi5BcHBsaWNhdGlvblByb3RvY29sLkhUVFAsXG4gICAgICAgIG9wZW46IHRydWUsXG4gICAgICB9KTtcblxuICAgICAgaHR0cExpc3RlbmVyLmFkZFRhcmdldHMoJ1Bob2VuaXhVSScsIHtcbiAgICAgICAgcG9ydDogNjAwNixcbiAgICAgICAgcHJvdG9jb2w6IGVsYnYyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCxcbiAgICAgICAgdGFyZ2V0czogW3RoaXMuc2VydmljZS5sb2FkQmFsYW5jZXJUYXJnZXQoeyBjb250YWluZXJOYW1lOiAncGhvZW5peCcsIGNvbnRhaW5lclBvcnQ6IDYwMDYgfSldLFxuICAgICAgICBoZWFsdGhDaGVjazoge1xuICAgICAgICAgIHBhdGg6ICcvaGVhbHRoeicsXG4gICAgICAgICAgaW50ZXJ2YWw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg1KSxcbiAgICAgICAgICBoZWFsdGh5VGhyZXNob2xkQ291bnQ6IDIsXG4gICAgICAgICAgdW5oZWFsdGh5VGhyZXNob2xkQ291bnQ6IDMsXG4gICAgICAgIH0sXG4gICAgICAgIGRlcmVnaXN0cmF0aW9uRGVsYXk6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIH0pO1xuXG4gICAgICB0aGlzLnBob2VuaXhFbmRwb2ludCA9IGBodHRwOi8vJHt0aGlzLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJEbnNOYW1lfWA7XG4gICAgfVxuXG4gICAgLy8gUGhvZW5peCB2MTMrIHNlcnZlcyBPVExQIEhUVFAgb24gcG9ydCA2MDA2IChzYW1lIGFzIFVJKSwgc28gbm8gc2VwYXJhdGVcbiAgICAvLyBwb3J0IDQzMTggbGlzdGVuZXIgaXMgbmVlZGVkLiBPVExQIHRyYWNlcyBnbyB0aHJvdWdoIHRoZSBIVFRQUy80NDMgbGlzdGVuZXIuXG5cbiAgICAvLyBnUlBDIGxpc3RlbmVyIGZvciBPVExQIHRyYWNlcyAocG9ydCA0MzE3KVxuICAgIC8vIFVzaW5nIEhUVFAgcHJvdG9jb2wgZm9yIGdSUEMgb3ZlciBIVFRQLzJcbiAgICBjb25zdCBncnBjTGlzdGVuZXIgPSB0aGlzLmxvYWRCYWxhbmNlci5hZGRMaXN0ZW5lcihcIkdycGNMaXN0ZW5lclwiLCB7XG4gICAgICBwb3J0OiA0MzE3LFxuICAgICAgcHJvdG9jb2w6IGVsYnYyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCxcbiAgICAgIG9wZW46IHRydWUsXG4gICAgfSk7XG5cbiAgICBncnBjTGlzdGVuZXIuYWRkVGFyZ2V0cyhcIlBob2VuaXhHUlBDXCIsIHtcbiAgICAgIHBvcnQ6IDQzMTcsXG4gICAgICBwcm90b2NvbDogZWxidjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgICAgLy8gTm90ZTogQVdTIEFMQiBnUlBDIHN1cHBvcnQgcmVxdWlyZXMgSFRUUFMgbGlzdGVuZXIsIHdoaWNoIG5lZWRzIFRMUyBjZXJ0c1xuICAgICAgLy8gRm9yIHNpbXBsaWNpdHksIHVzaW5nIHBsYWluIEhUVFAgd2l0aG91dCBHUlBDIHByb3RvY29sIHZlcnNpb25cbiAgICAgIHRhcmdldHM6IFt0aGlzLnNlcnZpY2UubG9hZEJhbGFuY2VyVGFyZ2V0KHsgY29udGFpbmVyTmFtZTogJ3Bob2VuaXgnLCBjb250YWluZXJQb3J0OiA0MzE3IH0pXSxcbiAgICAgIGhlYWx0aENoZWNrOiB7XG4gICAgICAgIHBhdGg6IFwiL2hlYWx0aHpcIixcbiAgICAgICAgcG9ydDogXCI2MDA2XCIsXG4gICAgICAgIGludGVydmFsOiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDUpLFxuICAgICAgICBoZWFsdGh5VGhyZXNob2xkQ291bnQ6IDIsXG4gICAgICAgIHVuaGVhbHRoeVRocmVzaG9sZENvdW50OiAzLFxuICAgICAgfSxcbiAgICAgIGRlcmVnaXN0cmF0aW9uRGVsYXk6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gUm91dGU1MyBETlMgUmVjb3JkIChvcHRpb25hbClcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGlmIChwcm9wcy5kb21haW5OYW1lICYmIHByb3BzLmhvc3RlZFpvbmUpIHtcbiAgICAgIG5ldyByb3V0ZTUzLkFSZWNvcmQodGhpcywgJ1Bob2VuaXhETlMnLCB7XG4gICAgICAgIHpvbmU6IHByb3BzLmhvc3RlZFpvbmUsXG4gICAgICAgIHJlY29yZE5hbWU6IHByb3BzLmRvbWFpbk5hbWUuc3BsaXQoJy4nKVswXSwgLy8gRXh0cmFjdCBzdWJkb21haW5cbiAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMoXG4gICAgICAgICAgbmV3IHRhcmdldHMuTG9hZEJhbGFuY2VyVGFyZ2V0KHRoaXMubG9hZEJhbGFuY2VyKVxuICAgICAgICApLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBJQU0gUGVybWlzc2lvbnNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEdyYW50IEVGUyBhY2Nlc3NcbiAgICBmaWxlU3lzdGVtLmdyYW50KHRhc2tEZWZpbml0aW9uLnRhc2tSb2xlLCAnZWxhc3RpY2ZpbGVzeXN0ZW06Q2xpZW50TW91bnQnKTtcbiAgICBmaWxlU3lzdGVtLmdyYW50KHRhc2tEZWZpbml0aW9uLnRhc2tSb2xlLCAnZWxhc3RpY2ZpbGVzeXN0ZW06Q2xpZW50V3JpdGUnKTtcblxuICAgIC8vIEdyYW50IENsb3VkV2F0Y2ggTG9nc1xuICAgIHRhc2tEZWZpbml0aW9uLnRhc2tSb2xlLmFkZE1hbmFnZWRQb2xpY3koXG4gICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoJ0Nsb3VkV2F0Y2hMb2dzRnVsbEFjY2VzcycpXG4gICAgKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRXhwb3J0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gcGhvZW5peEVuZHBvaW50IGFscmVhZHkgc2V0IGFib3ZlIGJhc2VkIG9uIGRvbWFpbiBhdmFpbGFiaWxpdHlcbiAgICAvLyBQaG9lbml4IHYxMysgc2VydmVzIE9UTFAgSFRUUCBvbiB0aGUgc2FtZSBwb3J0IGFzIHRoZSBVSSAoNjAwNilcbiAgICAvLyBSb3V0ZSB0aHJvdWdoIEhUVFBTLzQ0MyBsaXN0ZW5lciB3aGljaCBmb3J3YXJkcyB0byBjb250YWluZXIgcG9ydCA2MDA2XG4gICAgdGhpcy5vdGxwRW5kcG9pbnQgPSBgaHR0cHM6Ly8ke3Byb3BzLmRvbWFpbk5hbWUgfHwgdGhpcy5sb2FkQmFsYW5jZXIubG9hZEJhbGFuY2VyRG5zTmFtZX0vdjEvdHJhY2VzYDtcbiAgICB0aGlzLmdycGNFbmRwb2ludCA9IGBodHRwOi8vJHt0aGlzLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJEbnNOYW1lfTo0MzE3YDtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gT3V0cHV0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1Bob2VuaXhVSVVybCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnBob2VuaXhFbmRwb2ludCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUGhvZW5peCBVSSBVUkwnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkUGhvZW5peFVJVXJsJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdQaG9lbml4T1RMUEVuZHBvaW50Jywge1xuICAgICAgdmFsdWU6IHRoaXMub3RscEVuZHBvaW50LFxuICAgICAgZGVzY3JpcHRpb246ICdQaG9lbml4IE9UTFAgZ1JQQyBlbmRwb2ludCBmb3IgTGFtYmRhIHRyYWNpbmcnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkUGhvZW5peE9UTFBFbmRwb2ludCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUGhvZW5peExvYWRCYWxhbmNlckROUycsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJEbnNOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdQaG9lbml4IEFMQiBETlMgbmFtZScsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRQaG9lbml4QUxCRE5TJyxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBBbGxvdyBhIExhbWJkYSBmdW5jdGlvbiB0byBzZW5kIHRyYWNlcyBhbmQgYWNjZXNzIHRoZSBQaG9lbml4IEFQSSB2aWEgQUxCXG4gICAqL1xuICBwdWJsaWMgYWxsb3dUcmFjaW5nRnJvbShsYW1iZGE6IGVjMi5JQ29ubmVjdGFibGUpOiB2b2lkIHtcbiAgICAvLyBQaG9lbml4IHYxMysgc2VydmVzIE9UTFAgYW5kIFJFU1QgQVBJIG9uIHRoZSBzYW1lIHBvcnQgYXMgVUkgKDYwMDYpLFxuICAgIC8vIGFjY2Vzc2libGUgdmlhIEhUVFBTLzQ0MyBvbiB0aGUgQUxCXG4gICAgbGFtYmRhLmNvbm5lY3Rpb25zLmFsbG93VG8oXG4gICAgICB0aGlzLmFsYlNlY3VyaXR5R3JvdXAsXG4gICAgICBlYzIuUG9ydC50Y3AoNDQzKSxcbiAgICAgICdBbGxvdyBMYW1iZGEgdG8gc2VuZCBPVExQIHRyYWNlcyBhbmQgYWNjZXNzIFBob2VuaXggQVBJIHZpYSBBTEIgSFRUUFMnXG4gICAgKTtcbiAgfVxufVxuIl19