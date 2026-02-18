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
                {
                    containerPort: 4318,
                    protocol: ecs.Protocol.TCP,
                    name: 'otlp-http',
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
        // HTTP listener for OTLP traces (port 4318)
        // Using HTTP protocol on port 4318 (standard OTLP/HTTP port)
        // Port 4317 is for gRPC which requires HTTPS on ALB
        const otlpListener = this.loadBalancer.addListener('OtlpListener', {
            port: 4318,
            protocol: elbv2.ApplicationProtocol.HTTP,
            open: true,
        });
        otlpListener.addTargets('PhoenixOTLP', {
            port: 4318,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targets: [this.service],
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
        // Using HTTP OTLP on port 4318 (standard OTLP/HTTP port)
        // Port 4317 is for gRPC which requires HTTPS on ALB
        this.otlpEndpoint = `http://${this.loadBalancer.loadBalancerDnsName}:4318/v1/traces`;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib2JzZXJ2YWJpbGl0eS1jb25zdHJ1Y3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvb2JzZXJ2YWJpbGl0eS1jb25zdHJ1Y3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7R0FNRzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFFSCxpREFBbUM7QUFDbkMseURBQTJDO0FBQzNDLHlEQUEyQztBQUMzQyx5REFBMkM7QUFDM0MsOEVBQWdFO0FBQ2hFLHdFQUEwRDtBQUMxRCxpRUFBbUQ7QUFDbkQseUVBQTJEO0FBQzNELDJEQUE2QztBQUM3Qyx5REFBMkM7QUFDM0MsMkNBQXVDO0FBc0J2QyxNQUFhLHNCQUF1QixTQUFRLHNCQUFTO0lBQ25DLE9BQU8sQ0FBYztJQUNyQixPQUFPLENBQXFCO0lBQzVCLFlBQVksQ0FBZ0M7SUFDNUMsZUFBZSxDQUFTO0lBQ3hCLFlBQVksQ0FBUztJQUNyQixvQkFBb0IsQ0FBb0I7SUFFeEQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFrQztRQUMxRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLDZFQUE2RTtRQUM3RSxjQUFjO1FBQ2QsNkVBQTZFO1FBQzdFLElBQUksQ0FBQyxPQUFPLEdBQUcsSUFBSSxHQUFHLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtZQUNyRCxHQUFHLEVBQUUsS0FBSyxDQUFDLEdBQUc7WUFDZCxXQUFXLEVBQUUsa0JBQWtCO1lBQy9CLGlCQUFpQixFQUFFLElBQUk7U0FDeEIsQ0FBQyxDQUFDO1FBRUgsNkVBQTZFO1FBQzdFLHlDQUF5QztRQUN6Qyw2RUFBNkU7UUFDN0UsTUFBTSxVQUFVLEdBQUcsSUFBSSxHQUFHLENBQUMsVUFBVSxDQUFDLElBQUksRUFBRSxXQUFXLEVBQUU7WUFDdkQsR0FBRyxFQUFFLEtBQUssQ0FBQyxHQUFHO1lBQ2QsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENB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QVcsRUFBRSxnQkFBZ0I7WUFDN0IsVUFBVSxFQUFFLHNCQUFzQjtTQUNuQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHFCQUFxQixFQUFFO1lBQzdDLEtBQUssRUFBRSxJQUFJLENBQUMsWUFBWTtZQUN4QixXQUFXLEVBQUUsK0NBQStDO1lBQzVELFVBQVUsRUFBRSw2QkFBNkI7U0FDMUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSx3QkFBd0IsRUFBRTtZQUNoRCxLQUFLLEVBQUUsSUFBSSxDQUFDLFlBQVksQ0FBQyxtQkFBbUI7WUFDNUMsV0FBVyxFQUFFLHNCQUFzQjtZQUNuQyxVQUFVLEVBQUUsdUJBQXVCO1NBQ3BDLENBQUMsQ0FBQztJQUNMLENBQUM7SUFFRDs7T0FFRztJQUNJLGdCQUFnQixDQUFDLE1BQXdCO1FBQzlDLE1BQU0sQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUN4QixJQUFJLENBQUMsT0FBTyxFQUNaLEdBQUcsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUNsQiw2Q0FBNkMsQ0FDOUMsQ0FBQztJQUNKLENBQUM7Q0FDRjtBQTdURCx3REE2VEMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIE9ic2VydmFiaWxpdHkgQ29uc3RydWN0XG4gKlxuICogUHJvdmlkZXMgQUkgb2JzZXJ2YWJpbGl0eSB2aWEgQXJpemUgUGhvZW5peCBydW5uaW5nIG9uIEVDUyBGYXJnYXRlLlxuICogQ2FwdHVyZXMgT3BlblRlbGVtZXRyeSB0cmFjZXMgZnJvbSBBV1MgQmVkcm9jayBjYWxscyBmb3IgbW9uaXRvcmluZyxcbiAqIGV2YWx1YXRpb24sIGFuZCBwcm9tcHQgZW5naW5lZXJpbmcuXG4gKi9cblxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGVjMiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWMyJztcbmltcG9ydCAqIGFzIGVjcyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNzJztcbmltcG9ydCAqIGFzIGVmcyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWZzJztcbmltcG9ydCAqIGFzIGVsYnYyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lbGFzdGljbG9hZGJhbGFuY2luZ3YyJztcbmltcG9ydCAqIGFzIGFjbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyJztcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXJvdXRlNTMnO1xuaW1wb3J0ICogYXMgdGFyZ2V0cyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtcm91dGU1My10YXJnZXRzJztcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxvZ3MnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgT2JzZXJ2YWJpbGl0eUNvbnN0cnVjdFByb3BzIHtcbiAgLyoqXG4gICAqIFZQQyB0byBkZXBsb3kgUGhvZW5peCBzZXJ2aWNlIGluLlxuICAgKiBTaG91bGQgYmUgdGhlIHNhbWUgVlBDIGFzIHRoZSBhbmFseXRpY3MgTGFtYmRhIGZvciBlZmZpY2llbnQgdHJhY2UgY29sbGVjdGlvbi5cbiAgICovXG4gIHZwYzogZWMyLklWcGM7XG5cbiAgLyoqXG4gICAqIERvbWFpbiBuYW1lIGZvciBQaG9lbml4IFVJIChlLmcuLCAncGhvZW5peC5zb25nYmlyZC5saXZlJylcbiAgICogT3B0aW9uYWwgLSBpZiBub3QgcHJvdmlkZWQsIHdpbGwgdXNlIEFMQiBETlMgbmFtZVxuICAgKi9cbiAgZG9tYWluTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3IgRE5TIHJlY29yZCBjcmVhdGlvblxuICAgKiBPcHRpb25hbCAtIGlmIG5vdCBwcm92aWRlZCwgd2lsbCBza2lwIEROUy9jZXJ0aWZpY2F0ZSBzZXR1cFxuICAgKi9cbiAgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG59XG5cbmV4cG9ydCBjbGFzcyBPYnNlcnZhYmlsaXR5Q29uc3RydWN0IGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGNsdXN0ZXI6IGVjcy5DbHVzdGVyO1xuICBwdWJsaWMgcmVhZG9ubHkgc2VydmljZTogZWNzLkZhcmdhdGVTZXJ2aWNlO1xuICBwdWJsaWMgcmVhZG9ubHkgbG9hZEJhbGFuY2VyOiBlbGJ2Mi5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlcjtcbiAgcHVibGljIHJlYWRvbmx5IHBob2VuaXhFbmRwb2ludDogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgb3RscEVuZHBvaW50OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBwaG9lbml4U2VjdXJpdHlHcm91cDogZWMyLlNlY3VyaXR5R3JvdXA7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IE9ic2VydmFiaWxpdHlDb25zdHJ1Y3RQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEVDUyBDbHVzdGVyXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLmNsdXN0ZXIgPSBuZXcgZWNzLkNsdXN0ZXIodGhpcywgJ1Bob2VuaXhDbHVzdGVyJywge1xuICAgICAgdnBjOiBwcm9wcy52cGMsXG4gICAgICBjbHVzdGVyTmFtZTogJ3NvbmdiaXJkLXBob2VuaXgnLFxuICAgICAgY29udGFpbmVySW5zaWdodHM6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEVGUyBGaWxlIFN5c3RlbSBmb3IgUGVyc2lzdGVudCBTdG9yYWdlXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBmaWxlU3lzdGVtID0gbmV3IGVmcy5GaWxlU3lzdGVtKHRoaXMsICdQaG9lbml4RlMnLCB7XG4gICAgICB2cGM6IHByb3BzLnZwYyxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICBlbmNyeXB0ZWQ6IHRydWUsXG4gICAgICBsaWZlY3ljbGVQb2xpY3k6IGVmcy5MaWZlY3ljbGVQb2xpY3kuQUZURVJfMTRfREFZUyxcbiAgICAgIHBlcmZvcm1hbmNlTW9kZTogZWZzLlBlcmZvcm1hbmNlTW9kZS5HRU5FUkFMX1BVUlBPU0UsXG4gICAgICB2cGNTdWJuZXRzOiB7XG4gICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBTZWN1cml0eSBHcm91cHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMucGhvZW5peFNlY3VyaXR5R3JvdXAgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ1Bob2VuaXhTRycsIHtcbiAgICAgIHZwYzogcHJvcHMudnBjLFxuICAgICAgZGVzY3JpcHRpb246ICdTZWN1cml0eSBncm91cCBmb3IgUGhvZW5peCBvYnNlcnZhYmlsaXR5IHNlcnZpY2UnLFxuICAgICAgYWxsb3dBbGxPdXRib3VuZDogdHJ1ZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGFsYlNlY3VyaXR5R3JvdXAgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ1Bob2VuaXhBTEJTRycsIHtcbiAgICAgIHZwYzogcHJvcHMudnBjLFxuICAgICAgZGVzY3JpcHRpb246ICdTZWN1cml0eSBncm91cCBmb3IgUGhvZW5peCBBTEInLFxuICAgICAgYWxsb3dBbGxPdXRib3VuZDogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vIEFsbG93IEhUVFBTIGZyb20gaW50ZXJuZXQgdG8gQUxCXG4gICAgYWxiU2VjdXJpdHlHcm91cC5hZGRJbmdyZXNzUnVsZShcbiAgICAgIGVjMi5QZWVyLmFueUlwdjQoKSxcbiAgICAgIGVjMi5Qb3J0LnRjcCg0NDMpLFxuICAgICAgJ0FsbG93IEhUVFBTIGZyb20gaW50ZXJuZXQnXG4gICAgKTtcblxuICAgIC8vIEFsbG93IGdSUEMgZnJvbSBpbnRlcm5ldCB0byBBTEIgKGZvciBPVExQKVxuICAgIGFsYlNlY3VyaXR5R3JvdXAuYWRkSW5ncmVzc1J1bGUoXG4gICAgICBlYzIuUGVlci5hbnlJcHY0KCksXG4gICAgICBlYzIuUG9ydC50Y3AoNDMxNyksXG4gICAgICAnQWxsb3cgZ1JQQyBmcm9tIGludGVybmV0J1xuICAgICk7XG5cbiAgICAvLyBBbGxvdyBBTEIgdG8gcmVhY2ggUGhvZW5peCBVSVxuICAgIHRoaXMucGhvZW5peFNlY3VyaXR5R3JvdXAuYWRkSW5ncmVzc1J1bGUoXG4gICAgICBhbGJTZWN1cml0eUdyb3VwLFxuICAgICAgZWMyLlBvcnQudGNwKDYwMDYpLFxuICAgICAgJ0FsbG93IEhUVFAgVUkgdHJhZmZpYyBmcm9tIEFMQidcbiAgICApO1xuXG4gICAgLy8gQWxsb3cgQUxCIHRvIHJlYWNoIE9UTFAgZW5kcG9pbnRcbiAgICB0aGlzLnBob2VuaXhTZWN1cml0eUdyb3VwLmFkZEluZ3Jlc3NSdWxlKFxuICAgICAgYWxiU2VjdXJpdHlHcm91cCxcbiAgICAgIGVjMi5Qb3J0LnRjcCg0MzE3KSxcbiAgICAgICdBbGxvdyBPVExQIGdSUEMgdHJhZmZpYyBmcm9tIEFMQidcbiAgICApO1xuXG4gICAgLy8gQWxsb3cgRUZTIGFjY2Vzc1xuICAgIGZpbGVTeXN0ZW0uY29ubmVjdGlvbnMuYWxsb3dEZWZhdWx0UG9ydEZyb20odGhpcy5waG9lbml4U2VjdXJpdHlHcm91cCk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFRhc2sgRGVmaW5pdGlvblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgdGFza0RlZmluaXRpb24gPSBuZXcgZWNzLkZhcmdhdGVUYXNrRGVmaW5pdGlvbih0aGlzLCAnUGhvZW5peFRhc2snLCB7XG4gICAgICBtZW1vcnlMaW1pdE1pQjogMjA0OCxcbiAgICAgIGNwdTogMTAyNCxcbiAgICAgIGZhbWlseTogJ3NvbmdiaXJkLXBob2VuaXgnLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIEVGUyB2b2x1bWUgdG8gdGFzayBkZWZpbml0aW9uXG4gICAgY29uc3Qgdm9sdW1lTmFtZSA9ICdwaG9lbml4LWRhdGEnO1xuICAgIHRhc2tEZWZpbml0aW9uLmFkZFZvbHVtZSh7XG4gICAgICBuYW1lOiB2b2x1bWVOYW1lLFxuICAgICAgZWZzVm9sdW1lQ29uZmlndXJhdGlvbjoge1xuICAgICAgICBmaWxlU3lzdGVtSWQ6IGZpbGVTeXN0ZW0uZmlsZVN5c3RlbUlkLFxuICAgICAgICB0cmFuc2l0RW5jcnlwdGlvbjogJ0VOQUJMRUQnLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIFBob2VuaXggY29udGFpbmVyXG4gICAgY29uc3QgcGhvZW5peENvbnRhaW5lciA9IHRhc2tEZWZpbml0aW9uLmFkZENvbnRhaW5lcigncGhvZW5peCcsIHtcbiAgICAgIGltYWdlOiBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbVJlZ2lzdHJ5KCdhcml6ZXBob2VuaXgvcGhvZW5peDp2ZXJzaW9uLTguMC4wJyksXG4gICAgICBsb2dnaW5nOiBlY3MuTG9nRHJpdmVycy5hd3NMb2dzKHtcbiAgICAgICAgc3RyZWFtUHJlZml4OiAncGhvZW5peCcsXG4gICAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICAgIH0pLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgUEhPRU5JWF9QT1JUOiAnNjAwNicsXG4gICAgICAgIFBIT0VOSVhfR1JQQ19QT1JUOiAnNDMxNycsXG4gICAgICAgIFBIT0VOSVhfV09SS0lOR19ESVI6ICcvcGhvZW5peC1kYXRhJyxcbiAgICAgICAgUEhPRU5JWF9TUUxfREFUQUJBU0VfVVJMOiAnc3FsaXRlOi8vLy9waG9lbml4LWRhdGEvcGhvZW5peC5kYicsXG4gICAgICB9LFxuICAgICAgcG9ydE1hcHBpbmdzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBjb250YWluZXJQb3J0OiA2MDA2LFxuICAgICAgICAgIHByb3RvY29sOiBlY3MuUHJvdG9jb2wuVENQLFxuICAgICAgICAgIG5hbWU6ICdodHRwJyxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGNvbnRhaW5lclBvcnQ6IDQzMTcsXG4gICAgICAgICAgcHJvdG9jb2w6IGVjcy5Qcm90b2NvbC5UQ1AsXG4gICAgICAgICAgbmFtZTogJ2dycGMnLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgY29udGFpbmVyUG9ydDogNDMxOCxcbiAgICAgICAgICBwcm90b2NvbDogZWNzLlByb3RvY29sLlRDUCxcbiAgICAgICAgICBuYW1lOiAnb3RscC1odHRwJyxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICAvLyBSZW1vdmVkIGNvbnRhaW5lciBoZWFsdGggY2hlY2sgLSByZWx5aW5nIG9uIEFMQiB0YXJnZXQgZ3JvdXAgaGVhbHRoIGNoZWNrcyBpbnN0ZWFkXG4gICAgICAvLyBQaG9lbml4IGNvbnRhaW5lciBtYXkgbm90IGhhdmUgY3VybC93Z2V0LCBhbmQgQUxCIGNoZWNrcyBhcmUgc3VmZmljaWVudFxuICAgIH0pO1xuXG4gICAgLy8gTW91bnQgRUZTIHZvbHVtZVxuICAgIHBob2VuaXhDb250YWluZXIuYWRkTW91bnRQb2ludHMoe1xuICAgICAgc291cmNlVm9sdW1lOiB2b2x1bWVOYW1lLFxuICAgICAgY29udGFpbmVyUGF0aDogJy9waG9lbml4LWRhdGEnLFxuICAgICAgcmVhZE9ubHk6IGZhbHNlLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBGYXJnYXRlIFNlcnZpY2VcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuc2VydmljZSA9IG5ldyBlY3MuRmFyZ2F0ZVNlcnZpY2UodGhpcywgJ1Bob2VuaXhTZXJ2aWNlJywge1xuICAgICAgY2x1c3RlcjogdGhpcy5jbHVzdGVyLFxuICAgICAgdGFza0RlZmluaXRpb24sXG4gICAgICBzZXJ2aWNlTmFtZTogJ3Bob2VuaXgnLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgbWluSGVhbHRoeVBlcmNlbnQ6IDAsIC8vIEFsbG93IHNlcnZpY2UgdG8gc3RvcCBkdXJpbmcgdXBkYXRlc1xuICAgICAgbWF4SGVhbHRoeVBlcmNlbnQ6IDIwMCxcbiAgICAgIHZwY1N1Ym5ldHM6IHtcbiAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyxcbiAgICAgIH0sXG4gICAgICBzZWN1cml0eUdyb3VwczogW3RoaXMucGhvZW5peFNlY3VyaXR5R3JvdXBdLFxuICAgICAgZW5hYmxlRXhlY3V0ZUNvbW1hbmQ6IHRydWUsIC8vIEVuYWJsZSBFQ1MgRXhlYyBmb3IgZGVidWdnaW5nXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEFwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMubG9hZEJhbGFuY2VyID0gbmV3IGVsYnYyLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyKHRoaXMsICdQaG9lbml4QUxCJywge1xuICAgICAgdnBjOiBwcm9wcy52cGMsXG4gICAgICBpbnRlcm5ldEZhY2luZzogdHJ1ZSxcbiAgICAgIHNlY3VyaXR5R3JvdXA6IGFsYlNlY3VyaXR5R3JvdXAsXG4gICAgICBsb2FkQmFsYW5jZXJOYW1lOiAnc29uZ2JpcmQtcGhvZW5peCcsXG4gICAgfSk7XG5cbiAgICAvLyBDb25kaXRpb25hbGx5IGNyZWF0ZSBjZXJ0aWZpY2F0ZSBhbmQgSFRUUFMgbGlzdGVuZXIgaWYgZG9tYWluIGlzIHByb3ZpZGVkXG4gICAgbGV0IGh0dHBMaXN0ZW5lcjogZWxidjIuQXBwbGljYXRpb25MaXN0ZW5lcjtcbiAgICBpZiAocHJvcHMuZG9tYWluTmFtZSAmJiBwcm9wcy5ob3N0ZWRab25lKSB7XG4gICAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgICAgLy8gQUNNIENlcnRpZmljYXRlXG4gICAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgICAgY29uc3QgY2VydGlmaWNhdGUgPSBuZXcgYWNtLkNlcnRpZmljYXRlKHRoaXMsICdQaG9lbml4Q2VydCcsIHtcbiAgICAgICAgZG9tYWluTmFtZTogcHJvcHMuZG9tYWluTmFtZSxcbiAgICAgICAgdmFsaWRhdGlvbjogYWNtLkNlcnRpZmljYXRlVmFsaWRhdGlvbi5mcm9tRG5zKHByb3BzLmhvc3RlZFpvbmUpLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIEhUVFBTIGxpc3RlbmVyIGZvciBQaG9lbml4IFVJXG4gICAgICBjb25zdCBodHRwc0xpc3RlbmVyID0gdGhpcy5sb2FkQmFsYW5jZXIuYWRkTGlzdGVuZXIoJ0h0dHBzTGlzdGVuZXInLCB7XG4gICAgICAgIHBvcnQ6IDQ0MyxcbiAgICAgICAgcHJvdG9jb2w6IGVsYnYyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUFMsXG4gICAgICAgIGNlcnRpZmljYXRlczogW2NlcnRpZmljYXRlXSxcbiAgICAgICAgb3BlbjogdHJ1ZSxcbiAgICAgIH0pO1xuXG4gICAgICBodHRwc0xpc3RlbmVyLmFkZFRhcmdldHMoJ1Bob2VuaXhVSScsIHtcbiAgICAgICAgcG9ydDogNjAwNixcbiAgICAgICAgcHJvdG9jb2w6IGVsYnYyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCxcbiAgICAgICAgdGFyZ2V0czogW3RoaXMuc2VydmljZV0sXG4gICAgICAgIGhlYWx0aENoZWNrOiB7XG4gICAgICAgICAgcGF0aDogJy9oZWFsdGh6JyxcbiAgICAgICAgICBpbnRlcnZhbDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDUpLFxuICAgICAgICAgIGhlYWx0aHlUaHJlc2hvbGRDb3VudDogMixcbiAgICAgICAgICB1bmhlYWx0aHlUaHJlc2hvbGRDb3VudDogMyxcbiAgICAgICAgfSxcbiAgICAgICAgZGVyZWdpc3RyYXRpb25EZWxheTogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgfSk7XG5cbiAgICAgIHRoaXMucGhvZW5peEVuZHBvaW50ID0gYGh0dHBzOi8vJHtwcm9wcy5kb21haW5OYW1lfWA7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEhUVFAgbGlzdGVuZXIgZm9yIFBob2VuaXggVUkgKG5vIGNlcnRpZmljYXRlKVxuICAgICAgaHR0cExpc3RlbmVyID0gdGhpcy5sb2FkQmFsYW5jZXIuYWRkTGlzdGVuZXIoJ0h0dHBMaXN0ZW5lcicsIHtcbiAgICAgICAgcG9ydDogODAsXG4gICAgICAgIHByb3RvY29sOiBlbGJ2Mi5BcHBsaWNhdGlvblByb3RvY29sLkhUVFAsXG4gICAgICAgIG9wZW46IHRydWUsXG4gICAgICB9KTtcblxuICAgICAgaHR0cExpc3RlbmVyLmFkZFRhcmdldHMoJ1Bob2VuaXhVSScsIHtcbiAgICAgICAgcG9ydDogNjAwNixcbiAgICAgICAgcHJvdG9jb2w6IGVsYnYyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCxcbiAgICAgICAgdGFyZ2V0czogW3RoaXMuc2VydmljZV0sXG4gICAgICAgIGhlYWx0aENoZWNrOiB7XG4gICAgICAgICAgcGF0aDogJy9oZWFsdGh6JyxcbiAgICAgICAgICBpbnRlcnZhbDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDUpLFxuICAgICAgICAgIGhlYWx0aHlUaHJlc2hvbGRDb3VudDogMixcbiAgICAgICAgICB1bmhlYWx0aHlUaHJlc2hvbGRDb3VudDogMyxcbiAgICAgICAgfSxcbiAgICAgICAgZGVyZWdpc3RyYXRpb25EZWxheTogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgfSk7XG5cbiAgICAgIHRoaXMucGhvZW5peEVuZHBvaW50ID0gYGh0dHA6Ly8ke3RoaXMubG9hZEJhbGFuY2VyLmxvYWRCYWxhbmNlckRuc05hbWV9YDtcbiAgICB9XG5cbiAgICAvLyBIVFRQIGxpc3RlbmVyIGZvciBPVExQIHRyYWNlcyAocG9ydCA0MzE4KVxuICAgIC8vIFVzaW5nIEhUVFAgcHJvdG9jb2wgb24gcG9ydCA0MzE4IChzdGFuZGFyZCBPVExQL0hUVFAgcG9ydClcbiAgICAvLyBQb3J0IDQzMTcgaXMgZm9yIGdSUEMgd2hpY2ggcmVxdWlyZXMgSFRUUFMgb24gQUxCXG4gICAgY29uc3Qgb3RscExpc3RlbmVyID0gdGhpcy5sb2FkQmFsYW5jZXIuYWRkTGlzdGVuZXIoJ090bHBMaXN0ZW5lcicsIHtcbiAgICAgIHBvcnQ6IDQzMTgsXG4gICAgICBwcm90b2NvbDogZWxidjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgICAgb3BlbjogdHJ1ZSxcbiAgICB9KTtcblxuICAgIG90bHBMaXN0ZW5lci5hZGRUYXJnZXRzKCdQaG9lbml4T1RMUCcsIHtcbiAgICAgIHBvcnQ6IDQzMTgsXG4gICAgICBwcm90b2NvbDogZWxidjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgICAgdGFyZ2V0czogW3RoaXMuc2VydmljZV0sXG4gICAgICBoZWFsdGhDaGVjazoge1xuICAgICAgICAvLyBDaGVjayB0aGUgVUkgcG9ydCAoNjAwNikgaGVhbHRoIGVuZHBvaW50IGluc3RlYWQgb2YgT1RMUCBwb3J0XG4gICAgICAgIC8vIE9UTFAgcG9ydCBkb2Vzbid0IGhhdmUgYSBoZWFsdGggY2hlY2sgZW5kcG9pbnRcbiAgICAgICAgcGF0aDogJy9oZWFsdGh6JyxcbiAgICAgICAgcG9ydDogJzYwMDYnLFxuICAgICAgICBpbnRlcnZhbDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg1KSxcbiAgICAgICAgaGVhbHRoeVRocmVzaG9sZENvdW50OiAyLFxuICAgICAgICB1bmhlYWx0aHlUaHJlc2hvbGRDb3VudDogMyxcbiAgICAgIH0sXG4gICAgICBkZXJlZ2lzdHJhdGlvbkRlbGF5OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFJvdXRlNTMgRE5TIFJlY29yZCAob3B0aW9uYWwpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBpZiAocHJvcHMuZG9tYWluTmFtZSAmJiBwcm9wcy5ob3N0ZWRab25lKSB7XG4gICAgICBuZXcgcm91dGU1My5BUmVjb3JkKHRoaXMsICdQaG9lbml4RE5TJywge1xuICAgICAgICB6b25lOiBwcm9wcy5ob3N0ZWRab25lLFxuICAgICAgICByZWNvcmROYW1lOiBwcm9wcy5kb21haW5OYW1lLnNwbGl0KCcuJylbMF0sIC8vIEV4dHJhY3Qgc3ViZG9tYWluXG4gICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKFxuICAgICAgICAgIG5ldyB0YXJnZXRzLkxvYWRCYWxhbmNlclRhcmdldCh0aGlzLmxvYWRCYWxhbmNlcilcbiAgICAgICAgKSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gSUFNIFBlcm1pc3Npb25zXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBHcmFudCBFRlMgYWNjZXNzXG4gICAgZmlsZVN5c3RlbS5ncmFudCh0YXNrRGVmaW5pdGlvbi50YXNrUm9sZSwgJ2VsYXN0aWNmaWxlc3lzdGVtOkNsaWVudE1vdW50Jyk7XG4gICAgZmlsZVN5c3RlbS5ncmFudCh0YXNrRGVmaW5pdGlvbi50YXNrUm9sZSwgJ2VsYXN0aWNmaWxlc3lzdGVtOkNsaWVudFdyaXRlJyk7XG5cbiAgICAvLyBHcmFudCBDbG91ZFdhdGNoIExvZ3NcbiAgICB0YXNrRGVmaW5pdGlvbi50YXNrUm9sZS5hZGRNYW5hZ2VkUG9saWN5KFxuICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdDbG91ZFdhdGNoTG9nc0Z1bGxBY2Nlc3MnKVxuICAgICk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEV4cG9ydHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIHBob2VuaXhFbmRwb2ludCBhbHJlYWR5IHNldCBhYm92ZSBiYXNlZCBvbiBkb21haW4gYXZhaWxhYmlsaXR5XG4gICAgLy8gVXNpbmcgSFRUUCBPVExQIG9uIHBvcnQgNDMxOCAoc3RhbmRhcmQgT1RMUC9IVFRQIHBvcnQpXG4gICAgLy8gUG9ydCA0MzE3IGlzIGZvciBnUlBDIHdoaWNoIHJlcXVpcmVzIEhUVFBTIG9uIEFMQlxuICAgIHRoaXMub3RscEVuZHBvaW50ID0gYGh0dHA6Ly8ke3RoaXMubG9hZEJhbGFuY2VyLmxvYWRCYWxhbmNlckRuc05hbWV9OjQzMTgvdjEvdHJhY2VzYDtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gT3V0cHV0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1Bob2VuaXhVSVVybCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnBob2VuaXhFbmRwb2ludCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUGhvZW5peCBVSSBVUkwnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkUGhvZW5peFVJVXJsJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdQaG9lbml4T1RMUEVuZHBvaW50Jywge1xuICAgICAgdmFsdWU6IHRoaXMub3RscEVuZHBvaW50LFxuICAgICAgZGVzY3JpcHRpb246ICdQaG9lbml4IE9UTFAgZ1JQQyBlbmRwb2ludCBmb3IgTGFtYmRhIHRyYWNpbmcnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkUGhvZW5peE9UTFBFbmRwb2ludCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUGhvZW5peExvYWRCYWxhbmNlckROUycsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJEbnNOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdQaG9lbml4IEFMQiBETlMgbmFtZScsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmRQaG9lbml4QUxCRE5TJyxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBBbGxvdyBhIExhbWJkYSBmdW5jdGlvbiB0byBzZW5kIHRyYWNlcyB0byBQaG9lbml4XG4gICAqL1xuICBwdWJsaWMgYWxsb3dUcmFjaW5nRnJvbShsYW1iZGE6IGVjMi5JQ29ubmVjdGFibGUpOiB2b2lkIHtcbiAgICBsYW1iZGEuY29ubmVjdGlvbnMuYWxsb3dUbyhcbiAgICAgIHRoaXMuc2VydmljZSxcbiAgICAgIGVjMi5Qb3J0LnRjcCg0MzE3KSxcbiAgICAgICdBbGxvdyBMYW1iZGEgdG8gc2VuZCBPVExQIHRyYWNlcyB0byBQaG9lbml4J1xuICAgICk7XG4gIH1cbn1cbiJdfQ==