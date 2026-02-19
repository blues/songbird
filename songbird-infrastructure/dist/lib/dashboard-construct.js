"use strict";
/**
 * Dashboard Construct
 *
 * Defines S3 bucket and CloudFront distribution for hosting
 * the Songbird React dashboard application.
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
exports.DashboardConstruct = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const cloudfront = __importStar(require("aws-cdk-lib/aws-cloudfront"));
const cloudfrontOrigins = __importStar(require("aws-cdk-lib/aws-cloudfront-origins"));
const acm = __importStar(require("aws-cdk-lib/aws-certificatemanager"));
const route53 = __importStar(require("aws-cdk-lib/aws-route53"));
const route53Targets = __importStar(require("aws-cdk-lib/aws-route53-targets"));
const constructs_1 = require("constructs");
class DashboardConstruct extends constructs_1.Construct {
    bucket;
    distribution;
    distributionUrl;
    constructor(scope, id, props) {
        super(scope, id);
        // ==========================================================================
        // ACM Certificate (if custom domain provided)
        // ==========================================================================
        let certificate;
        if (props.domainName && props.hostedZone) {
            certificate = new acm.Certificate(this, 'Certificate', {
                domainName: props.domainName,
                validation: acm.CertificateValidation.fromDns(props.hostedZone),
            });
        }
        // ==========================================================================
        // S3 Bucket for Dashboard Assets
        // ==========================================================================
        this.bucket = new s3.Bucket(this, 'DashboardBucket', {
            bucketName: `songbird-dashboard-${cdk.Stack.of(this).account}`,
            // Note: NOT using websiteIndexDocument - using CloudFront with OAC instead
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            // CORS for API requests (if needed for dev)
            cors: [
                {
                    allowedMethods: [s3.HttpMethods.GET],
                    allowedOrigins: ['*'],
                    allowedHeaders: ['*'],
                },
            ],
        });
        // ==========================================================================
        // CloudFront Distribution with Origin Access Control (OAC)
        // ==========================================================================
        // Using S3BucketOrigin.withOriginAccessControl() which is the recommended approach
        // This automatically creates an OAC and grants the necessary permissions
        this.distribution = new cloudfront.Distribution(this, 'Distribution', {
            comment: 'Songbird Dashboard',
            certificate: certificate,
            domainNames: props.domainName ? [props.domainName] : undefined,
            defaultBehavior: {
                origin: cloudfrontOrigins.S3BucketOrigin.withOriginAccessControl(this.bucket),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
                cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                // Response headers for security
                responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
                    securityHeadersBehavior: {
                        contentTypeOptions: { override: true },
                        frameOptions: {
                            frameOption: cloudfront.HeadersFrameOption.DENY,
                            override: true,
                        },
                        referrerPolicy: {
                            referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
                            override: true,
                        },
                        strictTransportSecurity: {
                            accessControlMaxAge: cdk.Duration.days(365),
                            includeSubdomains: true,
                            override: true,
                        },
                        xssProtection: {
                            protection: true,
                            modeBlock: true,
                            override: true,
                        },
                    },
                }),
            },
            // Error pages - route all to index.html for SPA
            errorResponses: [
                {
                    httpStatus: 403,
                    responseHttpStatus: 200,
                    responsePagePath: '/index.html',
                    ttl: cdk.Duration.seconds(0),
                },
                {
                    httpStatus: 404,
                    responseHttpStatus: 200,
                    responsePagePath: '/index.html',
                    ttl: cdk.Duration.seconds(0),
                },
            ],
            // Price class - use all edge locations for global coverage
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
            // Enable HTTP/2
            httpVersion: cloudfront.HttpVersion.HTTP2,
            // Default root object
            defaultRootObject: 'index.html',
        });
        // Store distribution URL
        this.distributionUrl = props.domainName
            ? `https://${props.domainName}`
            : `https://${this.distribution.distributionDomainName}`;
        // ==========================================================================
        // Route53 A Record (if custom domain provided)
        // ==========================================================================
        if (props.domainName && props.hostedZone) {
            new route53.ARecord(this, 'AliasRecord', {
                zone: props.hostedZone,
                recordName: props.domainName,
                target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(this.distribution)),
            });
        }
        // ==========================================================================
        // Configuration File for Dashboard
        // ==========================================================================
        // Create a config.json that the dashboard will fetch at runtime
        const configContent = JSON.stringify({
            apiUrl: props.apiUrl,
            region: cdk.Stack.of(this).region,
            userPoolId: props.userPoolId,
            userPoolClientId: props.userPoolClientId,
        }, null, 2);
        // Note: The actual dashboard deployment should be done separately
        // after building the React app. This creates a placeholder config.
        // ==========================================================================
        // Outputs for Dashboard Build
        // ==========================================================================
        new cdk.CfnOutput(this, 'DashboardBucketName', {
            value: this.bucket.bucketName,
            description: 'S3 bucket for dashboard deployment',
            exportName: 'SongbirdDashboardBucket',
        });
        new cdk.CfnOutput(this, 'DashboardDistributionId', {
            value: this.distribution.distributionId,
            description: 'CloudFront distribution ID (for cache invalidation)',
            exportName: 'SongbirdDistributionId',
        });
        new cdk.CfnOutput(this, 'DashboardConfig', {
            value: configContent,
            description: 'Dashboard runtime configuration (save as config.json)',
        });
    }
}
exports.DashboardConstruct = DashboardConstruct;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGFzaGJvYXJkLWNvbnN0cnVjdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL2xpYi9kYXNoYm9hcmQtY29uc3RydWN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7R0FLRzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFFSCxpREFBbUM7QUFDbkMsdURBQXlDO0FBQ3pDLHVFQUF5RDtBQUN6RCxzRkFBd0U7QUFFeEUsd0VBQTBEO0FBQzFELGlFQUFtRDtBQUNuRCxnRkFBa0U7QUFDbEUsMkNBQXVDO0FBWXZDLE1BQWEsa0JBQW1CLFNBQVEsc0JBQVM7SUFDL0IsTUFBTSxDQUFZO0lBQ2xCLFlBQVksQ0FBMEI7SUFDdEMsZUFBZSxDQUFTO0lBRXhDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBOEI7UUFDdEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQiw2RUFBNkU7UUFDN0UsOENBQThDO1FBQzlDLDZFQUE2RTtRQUM3RSxJQUFJLFdBQXlDLENBQUM7UUFDOUMsSUFBSSxLQUFLLENBQUMsVUFBVSxJQUFJLEtBQUssQ0FBQyxVQUFVLEVBQUUsQ0FBQztZQUN6QyxXQUFXLEdBQUcsSUFBSSxHQUFHLENBQUMsV0FBVyxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7Z0JBQ3JELFVBQVUsRUFBRSxLQUFLLENBQUMsVUFBVTtnQkFDNUIsVUFBVSxFQUFFLEdBQUcsQ0FBQyxxQkFBcUIsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLFVBQVUsQ0FBQzthQUNoRSxDQUFDLENBQUM7UUFDTCxDQUFDO1FBRUQsNkVBQTZFO1FBQzdFLGlDQUFpQztRQUNqQyw2RUFBNkU7UUFDN0UsSUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLGlCQUFpQixFQUFFO1lBQ25ELFVBQVUsRUFBRSxzQkFBc0IsR0FBRyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMs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O1FBQ2xFLG1FQUFtRTtRQUVuRSw2RUFBNkU7UUFDN0UsOEJBQThCO1FBQzlCLDZFQUE2RTtRQUM3RSxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHFCQUFxQixFQUFFO1lBQzdDLEtBQUssRUFBRSxJQUFJLENBQUMsTUFBTSxDQUFDLFVBQVU7WUFDN0IsV0FBVyxFQUFFLG9DQUFvQztZQUNqRCxVQUFVLEVBQUUseUJBQXlCO1NBQ3RDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUseUJBQXlCLEVBQUU7WUFDakQsS0FBSyxFQUFFLElBQUksQ0FBQyxZQUFZLENBQUMsY0FBYztZQUN2QyxXQUFXLEVBQUUscURBQXFEO1lBQ2xFLFVBQVUsRUFBRSx3QkFBd0I7U0FDckMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxpQkFBaUIsRUFBRTtZQUN6QyxLQUFLLEVBQUUsYUFBYTtZQUNwQixXQUFXLEVBQUUsdURBQXVEO1NBQ3JFLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQXRLRCxnREFzS0MiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIERhc2hib2FyZCBDb25zdHJ1Y3RcbiAqXG4gKiBEZWZpbmVzIFMzIGJ1Y2tldCBhbmQgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gZm9yIGhvc3RpbmdcbiAqIHRoZSBTb25nYmlyZCBSZWFjdCBkYXNoYm9hcmQgYXBwbGljYXRpb24uXG4gKi9cblxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIHMzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zMyc7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZGZyb250JztcbmltcG9ydCAqIGFzIGNsb3VkZnJvbnRPcmlnaW5zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZGZyb250LW9yaWdpbnMnO1xuaW1wb3J0ICogYXMgczNkZXBsb3kgZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzLWRlcGxveW1lbnQnO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXInO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtcm91dGU1Myc7XG5pbXBvcnQgKiBhcyByb3V0ZTUzVGFyZ2V0cyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtcm91dGU1My10YXJnZXRzJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCAqIGFzIGZzIGZyb20gJ2ZzJztcblxuZXhwb3J0IGludGVyZmFjZSBEYXNoYm9hcmRDb25zdHJ1Y3RQcm9wcyB7XG4gIGFwaVVybDogc3RyaW5nO1xuICB1c2VyUG9vbElkOiBzdHJpbmc7XG4gIHVzZXJQb29sQ2xpZW50SWQ6IHN0cmluZztcbiAgZG9tYWluTmFtZT86IHN0cmluZztcbiAgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG59XG5cbmV4cG9ydCBjbGFzcyBEYXNoYm9hcmRDb25zdHJ1Y3QgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgYnVja2V0OiBzMy5CdWNrZXQ7XG4gIHB1YmxpYyByZWFkb25seSBkaXN0cmlidXRpb246IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uO1xuICBwdWJsaWMgcmVhZG9ubHkgZGlzdHJpYnV0aW9uVXJsOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IERhc2hib2FyZENvbnN0cnVjdFByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQUNNIENlcnRpZmljYXRlIChpZiBjdXN0b20gZG9tYWluIHByb3ZpZGVkKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgbGV0IGNlcnRpZmljYXRlOiBhY20uSUNlcnRpZmljYXRlIHwgdW5kZWZpbmVkO1xuICAgIGlmIChwcm9wcy5kb21haW5OYW1lICYmIHByb3BzLmhvc3RlZFpvbmUpIHtcbiAgICAgIGNlcnRpZmljYXRlID0gbmV3IGFjbS5DZXJ0aWZpY2F0ZSh0aGlzLCAnQ2VydGlmaWNhdGUnLCB7XG4gICAgICAgIGRvbWFpbk5hbWU6IHByb3BzLmRvbWFpbk5hbWUsXG4gICAgICAgIHZhbGlkYXRpb246IGFjbS5DZXJ0aWZpY2F0ZVZhbGlkYXRpb24uZnJvbURucyhwcm9wcy5ob3N0ZWRab25lKSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gUzMgQnVja2V0IGZvciBEYXNoYm9hcmQgQXNzZXRzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLmJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgJ0Rhc2hib2FyZEJ1Y2tldCcsIHtcbiAgICAgIGJ1Y2tldE5hbWU6IGBzb25nYmlyZC1kYXNoYm9hcmQtJHtjZGsuU3RhY2sub2YodGhpcykuYWNjb3VudH1gLFxuICAgICAgLy8gTm90ZTogTk9UIHVzaW5nIHdlYnNpdGVJbmRleERvY3VtZW50IC0gdXNpbmcgQ2xvdWRGcm9udCB3aXRoIE9BQyBpbnN0ZWFkXG4gICAgICBwdWJsaWNSZWFkQWNjZXNzOiBmYWxzZSxcbiAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgYXV0b0RlbGV0ZU9iamVjdHM6IHRydWUsXG4gICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG5cbiAgICAgIC8vIENPUlMgZm9yIEFQSSByZXF1ZXN0cyAoaWYgbmVlZGVkIGZvciBkZXYpXG4gICAgICBjb3JzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBhbGxvd2VkTWV0aG9kczogW3MzLkh0dHBNZXRob2RzLkdFVF0sXG4gICAgICAgICAgYWxsb3dlZE9yaWdpbnM6IFsnKiddLFxuICAgICAgICAgIGFsbG93ZWRIZWFkZXJzOiBbJyonXSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIENsb3VkRnJvbnQgRGlzdHJpYnV0aW9uIHdpdGggT3JpZ2luIEFjY2VzcyBDb250cm9sIChPQUMpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBVc2luZyBTM0J1Y2tldE9yaWdpbi53aXRoT3JpZ2luQWNjZXNzQ29udHJvbCgpIHdoaWNoIGlzIHRoZSByZWNvbW1lbmRlZCBhcHByb2FjaFxuICAgIC8vIFRoaXMgYXV0b21hdGljYWxseSBjcmVhdGVzIGFuIE9BQyBhbmQgZ3JhbnRzIHRoZSBuZWNlc3NhcnkgcGVybWlzc2lvbnNcbiAgICB0aGlzLmRpc3RyaWJ1dGlvbiA9IG5ldyBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbih0aGlzLCAnRGlzdHJpYnV0aW9uJywge1xuICAgICAgY29tbWVudDogJ1NvbmdiaXJkIERhc2hib2FyZCcsXG4gICAgICBjZXJ0aWZpY2F0ZTogY2VydGlmaWNhdGUsXG4gICAgICBkb21haW5OYW1lczogcHJvcHMuZG9tYWluTmFtZSA/IFtwcm9wcy5kb21haW5OYW1lXSA6IHVuZGVmaW5lZCxcblxuICAgICAgZGVmYXVsdEJlaGF2aW9yOiB7XG4gICAgICAgIG9yaWdpbjogY2xvdWRmcm9udE9yaWdpbnMuUzNCdWNrZXRPcmlnaW4ud2l0aE9yaWdpbkFjY2Vzc0NvbnRyb2wodGhpcy5idWNrZXQpLFxuICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfR0VUX0hFQURfT1BUSU9OUyxcbiAgICAgICAgY2FjaGVQb2xpY3k6IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19PUFRJTUlaRUQsXG5cbiAgICAgICAgLy8gUmVzcG9uc2UgaGVhZGVycyBmb3Igc2VjdXJpdHlcbiAgICAgICAgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiBuZXcgY2xvdWRmcm9udC5SZXNwb25zZUhlYWRlcnNQb2xpY3koXG4gICAgICAgICAgdGhpcyxcbiAgICAgICAgICAnU2VjdXJpdHlIZWFkZXJzJyxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBzZWN1cml0eUhlYWRlcnNCZWhhdmlvcjoge1xuICAgICAgICAgICAgICBjb250ZW50VHlwZU9wdGlvbnM6IHsgb3ZlcnJpZGU6IHRydWUgfSxcbiAgICAgICAgICAgICAgZnJhbWVPcHRpb25zOiB7XG4gICAgICAgICAgICAgICAgZnJhbWVPcHRpb246IGNsb3VkZnJvbnQuSGVhZGVyc0ZyYW1lT3B0aW9uLkRFTlksXG4gICAgICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIHJlZmVycmVyUG9saWN5OiB7XG4gICAgICAgICAgICAgICAgcmVmZXJyZXJQb2xpY3k6XG4gICAgICAgICAgICAgICAgICBjbG91ZGZyb250LkhlYWRlcnNSZWZlcnJlclBvbGljeS5TVFJJQ1RfT1JJR0lOX1dIRU5fQ1JPU1NfT1JJR0lOLFxuICAgICAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBzdHJpY3RUcmFuc3BvcnRTZWN1cml0eToge1xuICAgICAgICAgICAgICAgIGFjY2Vzc0NvbnRyb2xNYXhBZ2U6IGNkay5EdXJhdGlvbi5kYXlzKDM2NSksXG4gICAgICAgICAgICAgICAgaW5jbHVkZVN1YmRvbWFpbnM6IHRydWUsXG4gICAgICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIHhzc1Byb3RlY3Rpb246IHtcbiAgICAgICAgICAgICAgICBwcm90ZWN0aW9uOiB0cnVlLFxuICAgICAgICAgICAgICAgIG1vZGVCbG9jazogdHJ1ZSxcbiAgICAgICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfVxuICAgICAgICApLFxuICAgICAgfSxcblxuICAgICAgLy8gRXJyb3IgcGFnZXMgLSByb3V0ZSBhbGwgdG8gaW5kZXguaHRtbCBmb3IgU1BBXG4gICAgICBlcnJvclJlc3BvbnNlczogW1xuICAgICAgICB7XG4gICAgICAgICAgaHR0cFN0YXR1czogNDAzLFxuICAgICAgICAgIHJlc3BvbnNlSHR0cFN0YXR1czogMjAwLFxuICAgICAgICAgIHJlc3BvbnNlUGFnZVBhdGg6ICcvaW5kZXguaHRtbCcsXG4gICAgICAgICAgdHRsOiBjZGsuRHVyYXRpb24uc2Vjb25kcygwKSxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGh0dHBTdGF0dXM6IDQwNCxcbiAgICAgICAgICByZXNwb25zZUh0dHBTdGF0dXM6IDIwMCxcbiAgICAgICAgICByZXNwb25zZVBhZ2VQYXRoOiAnL2luZGV4Lmh0bWwnLFxuICAgICAgICAgIHR0bDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMCksXG4gICAgICAgIH0sXG4gICAgICBdLFxuXG4gICAgICAvLyBQcmljZSBjbGFzcyAtIHVzZSBhbGwgZWRnZSBsb2NhdGlvbnMgZm9yIGdsb2JhbCBjb3ZlcmFnZVxuICAgICAgcHJpY2VDbGFzczogY2xvdWRmcm9udC5QcmljZUNsYXNzLlBSSUNFX0NMQVNTXzEwMCxcblxuICAgICAgLy8gRW5hYmxlIEhUVFAvMlxuICAgICAgaHR0cFZlcnNpb246IGNsb3VkZnJvbnQuSHR0cFZlcnNpb24uSFRUUDIsXG5cbiAgICAgIC8vIERlZmF1bHQgcm9vdCBvYmplY3RcbiAgICAgIGRlZmF1bHRSb290T2JqZWN0OiAnaW5kZXguaHRtbCcsXG4gICAgfSk7XG5cbiAgICAvLyBTdG9yZSBkaXN0cmlidXRpb24gVVJMXG4gICAgdGhpcy5kaXN0cmlidXRpb25VcmwgPSBwcm9wcy5kb21haW5OYW1lXG4gICAgICA/IGBodHRwczovLyR7cHJvcHMuZG9tYWluTmFtZX1gXG4gICAgICA6IGBodHRwczovLyR7dGhpcy5kaXN0cmlidXRpb24uZGlzdHJpYnV0aW9uRG9tYWluTmFtZX1gO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBSb3V0ZTUzIEEgUmVjb3JkIChpZiBjdXN0b20gZG9tYWluIHByb3ZpZGVkKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgaWYgKHByb3BzLmRvbWFpbk5hbWUgJiYgcHJvcHMuaG9zdGVkWm9uZSkge1xuICAgICAgbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCAnQWxpYXNSZWNvcmQnLCB7XG4gICAgICAgIHpvbmU6IHByb3BzLmhvc3RlZFpvbmUsXG4gICAgICAgIHJlY29yZE5hbWU6IHByb3BzLmRvbWFpbk5hbWUsXG4gICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKFxuICAgICAgICAgIG5ldyByb3V0ZTUzVGFyZ2V0cy5DbG91ZEZyb250VGFyZ2V0KHRoaXMuZGlzdHJpYnV0aW9uKVxuICAgICAgICApLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDb25maWd1cmF0aW9uIEZpbGUgZm9yIERhc2hib2FyZFxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ3JlYXRlIGEgY29uZmlnLmpzb24gdGhhdCB0aGUgZGFzaGJvYXJkIHdpbGwgZmV0Y2ggYXQgcnVudGltZVxuICAgIGNvbnN0IGNvbmZpZ0NvbnRlbnQgPSBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBhcGlVcmw6IHByb3BzLmFwaVVybCxcbiAgICAgIHJlZ2lvbjogY2RrLlN0YWNrLm9mKHRoaXMpLnJlZ2lvbixcbiAgICAgIHVzZXJQb29sSWQ6IHByb3BzLnVzZXJQb29sSWQsXG4gICAgICB1c2VyUG9vbENsaWVudElkOiBwcm9wcy51c2VyUG9vbENsaWVudElkLFxuICAgIH0sIG51bGwsIDIpO1xuXG4gICAgLy8gTm90ZTogVGhlIGFjdHVhbCBkYXNoYm9hcmQgZGVwbG95bWVudCBzaG91bGQgYmUgZG9uZSBzZXBhcmF0ZWx5XG4gICAgLy8gYWZ0ZXIgYnVpbGRpbmcgdGhlIFJlYWN0IGFwcC4gVGhpcyBjcmVhdGVzIGEgcGxhY2Vob2xkZXIgY29uZmlnLlxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBPdXRwdXRzIGZvciBEYXNoYm9hcmQgQnVpbGRcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEYXNoYm9hcmRCdWNrZXROYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMuYnVja2V0LmJ1Y2tldE5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ1MzIGJ1Y2tldCBmb3IgZGFzaGJvYXJkIGRlcGxveW1lbnQnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkRGFzaGJvYXJkQnVja2V0JyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEYXNoYm9hcmREaXN0cmlidXRpb25JZCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmRpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25JZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gSUQgKGZvciBjYWNoZSBpbnZhbGlkYXRpb24pJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZERpc3RyaWJ1dGlvbklkJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEYXNoYm9hcmRDb25maWcnLCB7XG4gICAgICB2YWx1ZTogY29uZmlnQ29udGVudCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRGFzaGJvYXJkIHJ1bnRpbWUgY29uZmlndXJhdGlvbiAoc2F2ZSBhcyBjb25maWcuanNvbiknLFxuICAgIH0pO1xuICB9XG59XG4iXX0=