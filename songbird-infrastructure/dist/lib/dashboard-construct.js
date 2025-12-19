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
const constructs_1 = require("constructs");
class DashboardConstruct extends constructs_1.Construct {
    bucket;
    distribution;
    distributionUrl;
    constructor(scope, id, props) {
        super(scope, id);
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
        this.distributionUrl = `https://${this.distribution.distributionDomainName}`;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGFzaGJvYXJkLWNvbnN0cnVjdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL2xpYi9kYXNoYm9hcmQtY29uc3RydWN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7R0FLRzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFFSCxpREFBbUM7QUFDbkMsdURBQXlDO0FBQ3pDLHVFQUF5RDtBQUN6RCxzRkFBd0U7QUFFeEUsMkNBQXVDO0FBVXZDLE1BQWEsa0JBQW1CLFNBQVEsc0JBQVM7SUFDL0IsTUFBTSxDQUFZO0lBQ2xCLFlBQVksQ0FBMEI7SUFDdEMsZUFBZSxDQUFTO0lBRXhDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBOEI7UUFDdEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQiw2RUFBNkU7UUFDN0UsaUNBQWlDO1FBQ2pDLDZFQUE2RTtRQUM3RSxJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUU7WUFDbkQsVUFBVSxFQUFFLHNCQUFzQixHQUFHLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxPQUFPLEVBQUU7WUFDOUQsMkVBQTJFO1lBQzNFLGdCQUFnQixFQUFFLEtBQUs7WUFDdkIsaUJBQWlCLEVBQUUsRUFBRSxDQUFDLGlCQUFpQixDQUFDLFNBQVM7WUFDakQsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTztZQUN4QyxpQkFBaUIsRUFBRSxJQUFJO1lBQ3ZCLFVBQVUsRUFBRSxFQUFFLENBQUMsZ0JBQWdCLENBQUMsVUFBVTtZQUUxQyw0Q0FBNEM7WUFDNUMsSUFBSSxFQUFFO2dCQUNKO29CQUNFLGNBQWMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxXQUFXLENBQUMsR0FBRyxDQUFDO29CQUNwQyxjQUFjLEVBQUUsQ0FBQyxHQUFHLENBQUM7b0JBQ3JCLGNBQWMsRUFBRSxDQUFDLEdBQUcsQ0FBQztpQkFDdEI7YUFDRjtTQUNGLENBQUMsQ0FBQztRQUVILDZFQUE2RTtRQUM3RSwyREFBMkQ7UUFDM0QsNkVBQTZFO1FBQzdFLG1GQUFtRjtRQUNuRix5RUFBeUU7UUFDekUsSUFBSSxDQUFDLFlBQVksR0FBRyxJQUFJLFVBQVUsQ0FBQyxZQUFZLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRTtZQUNwRSxPQUFPLEVBQUUsb0JBQW9CO1lBRTdCLGVBQWUsRUFBRTtnQkFDZixNQUFNLEVBQUUsaUJBQWlCLENBQUMsY0FBYyxDQUFDLHVCQUF1QixDQUFDLElBQUksQ0FBQyxNQUFNLENBQUM7Z0JBQzdFLG9CQUFvQixFQUFFLFVBQVUsQ0FBQyxvQkFBb0IsQ0FBQyxpQkFBaUI7Z0JBQ3ZFLGNBQWMsRUFBRSxVQUFVLENBQUMsY0FBYyxDQUFDLHNCQUFzQjtnQkFDaEUsV0FBVyxFQUFFLFVBQVUsQ0FBQyxXQUFXLENBQUMsaUJBQWlCO2dCQUVyRCxnQ0FBZ0M7Z0JBQ2hDLHFCQUFxQixFQUFFLElBQUksVUFBVSxDQUFDLHFCQUFxQixDQUN6RCxJQUFJLEVBQ0osaUJBQWlCLEVBQ2pCO29CQUNFLHVCQUF1QixFQUFFO3dCQUN2QixrQkFBa0IsRUFBRSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUU7d0JBQ3RDLFlBQVksRUFBRTs0QkFDWixXQUFXLEVBQUUsVUFBVSxDQUFDLGtCQUFrQixDQUFDLElBQUk7NEJBQy9DLFFBQVEsRUFBRSxJQUFJO3lCQUNmO3dCQUNELGNBQWMsRUFBRTs0QkFDZCxjQUFjLEVBQ1osVUFBVSxDQUFDLHFCQUFxQixDQUFDLCtCQUErQjs0QkFDbEUsUUFBUSxFQUFFLElBQUk7eUJBQ2Y7d0JBQ0QsdUJBQXVCLEVBQUU7NEJBQ3ZCLG1CQUFtQixFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQzs0QkFDM0MsaUJBQWlCLEVBQUUsSUFBSTs0QkFDdkIsUUFBUSxFQUFFLElBQUk7eUJBQ2Y7d0JBQ0QsYUFBYSxFQUFFOzRCQUNiLFVBQVUsRUFBRSxJQUFJOzRCQUNoQixTQUFTLEVBQUUsSUFBSTs0QkFDZixRQUFRLEVBQUUsSUFBSTt5QkFDZjtxQkFDRjtpQkFDRixDQUNGO2FBQ0Y7WUFFRCxnREFBZ0Q7WUFDaEQsY0FBYyxFQUFFO2dCQUNkO29CQUNFLFVBQVUsRUFBRSxHQUFHO29CQUNmLGtCQUFrQixFQUFFLEdBQUc7b0JBQ3ZCLGdCQUFnQixFQUFFLGFBQWE7b0JBQy9CLEdBQUcsRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7aUJBQzdCO2dCQUNEO29CQUNFLFVBQVUsRUFBRSxHQUFHO29CQUNmLGtCQUFrQixFQUFFLEdBQUc7b0JBQ3ZCLGdCQUFnQixFQUFFLGFBQWE7b0JBQy9CLEdBQUcsRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7aUJBQzdCO2FBQ0Y7WUFFRCwyREFBMkQ7WUFDM0QsVUFBVSxFQUFFLFVBQVUsQ0FBQyxVQUFVLENBQUMsZUFBZTtZQUVqRCxnQkFBZ0I7WUFDaEIsV0FBVyxFQUFFLFVBQVUsQ0FBQyxXQUFXLENBQUMsS0FBSztZQUV6QyxzQkFBc0I7WUFDdEIsaUJBQWlCLEVBQUUsWUFBWTtTQUNoQyxDQUFDLENBQUM7UUFFSCx5QkFBeUI7UUFDekIsSUFBSSxDQUFDLGVBQWUsR0FBRyxXQUFXLElBQUksQ0FBQyxZQUFZLENBQUMsc0JBQXNCLEVBQUUsQ0FBQztRQUU3RSw2RUFBNkU7UUFDN0UsbUNBQW1DO1FBQ25DLDZFQUE2RTtRQUM3RSxnRUFBZ0U7UUFDaEUsTUFBTSxhQUFhLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQztZQUNuQyxNQUFNLEVBQUUsS0FBSyxDQUFDLE1BQU07WUFDcEIsTUFBTSxFQUFFLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU07WUFDakMsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVO1lBQzVCLGdCQUFnQixFQUFFLEtBQUssQ0FBQyxnQkFBZ0I7U0FDekMsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFFWixrRUFBa0U7UUFDbEUsbUVBQW1FO1FBRW5FLDZFQUE2RTtRQUM3RSw4QkFBOEI7UUFDOUIsNkVBQTZFO1FBQzdFLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUscUJBQXFCLEVBQUU7WUFDN0MsS0FBSyxFQUFFLElBQUksQ0FBQyxNQUFNLENBQUMsVUFBVTtZQUM3QixXQUFXLEVBQUUsb0NBQW9DO1lBQ2pELFVBQVUsRUFBRSx5QkFBeUI7U0FDdEMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSx5QkFBeUIsRUFBRTtZQUNqRCxLQUFLLEVBQUUsSUFBSSxDQUFDLFlBQVksQ0FBQyxjQUFjO1lBQ3ZDLFdBQVcsRUFBRSxxREFBcUQ7WUFDbEUsVUFBVSxFQUFFLHdCQUF3QjtTQUNyQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGlCQUFpQixFQUFFO1lBQ3pDLEtBQUssRUFBRSxhQUFhO1lBQ3BCLFdBQVcsRUFBRSx1REFBdUQ7U0FDckUsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBMUlELGdEQTBJQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRGFzaGJvYXJkIENvbnN0cnVjdFxuICpcbiAqIERlZmluZXMgUzMgYnVja2V0IGFuZCBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbiBmb3IgaG9zdGluZ1xuICogdGhlIFNvbmdiaXJkIFJlYWN0IGRhc2hib2FyZCBhcHBsaWNhdGlvbi5cbiAqL1xuXG5pbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgczMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzJztcbmltcG9ydCAqIGFzIGNsb3VkZnJvbnQgZnJvbSAnYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQnO1xuaW1wb3J0ICogYXMgY2xvdWRmcm9udE9yaWdpbnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQtb3JpZ2lucyc7XG5pbXBvcnQgKiBhcyBzM2RlcGxveSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMtZGVwbG95bWVudCc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgKiBhcyBmcyBmcm9tICdmcyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGFzaGJvYXJkQ29uc3RydWN0UHJvcHMge1xuICBhcGlVcmw6IHN0cmluZztcbiAgdXNlclBvb2xJZDogc3RyaW5nO1xuICB1c2VyUG9vbENsaWVudElkOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBEYXNoYm9hcmRDb25zdHJ1Y3QgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgYnVja2V0OiBzMy5CdWNrZXQ7XG4gIHB1YmxpYyByZWFkb25seSBkaXN0cmlidXRpb246IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uO1xuICBwdWJsaWMgcmVhZG9ubHkgZGlzdHJpYnV0aW9uVXJsOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IERhc2hib2FyZENvbnN0cnVjdFByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gUzMgQnVja2V0IGZvciBEYXNoYm9hcmQgQXNzZXRzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLmJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgJ0Rhc2hib2FyZEJ1Y2tldCcsIHtcbiAgICAgIGJ1Y2tldE5hbWU6IGBzb25nYmlyZC1kYXNoYm9hcmQtJHtjZGsuU3RhY2sub2YodGhpcykuYWNjb3VudH1gLFxuICAgICAgLy8gTm90ZTogTk9UIHVzaW5nIHdlYnNpdGVJbmRleERvY3VtZW50IC0gdXNpbmcgQ2xvdWRGcm9udCB3aXRoIE9BQyBpbnN0ZWFkXG4gICAgICBwdWJsaWNSZWFkQWNjZXNzOiBmYWxzZSxcbiAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgYXV0b0RlbGV0ZU9iamVjdHM6IHRydWUsXG4gICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG5cbiAgICAgIC8vIENPUlMgZm9yIEFQSSByZXF1ZXN0cyAoaWYgbmVlZGVkIGZvciBkZXYpXG4gICAgICBjb3JzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBhbGxvd2VkTWV0aG9kczogW3MzLkh0dHBNZXRob2RzLkdFVF0sXG4gICAgICAgICAgYWxsb3dlZE9yaWdpbnM6IFsnKiddLFxuICAgICAgICAgIGFsbG93ZWRIZWFkZXJzOiBbJyonXSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIENsb3VkRnJvbnQgRGlzdHJpYnV0aW9uIHdpdGggT3JpZ2luIEFjY2VzcyBDb250cm9sIChPQUMpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBVc2luZyBTM0J1Y2tldE9yaWdpbi53aXRoT3JpZ2luQWNjZXNzQ29udHJvbCgpIHdoaWNoIGlzIHRoZSByZWNvbW1lbmRlZCBhcHByb2FjaFxuICAgIC8vIFRoaXMgYXV0b21hdGljYWxseSBjcmVhdGVzIGFuIE9BQyBhbmQgZ3JhbnRzIHRoZSBuZWNlc3NhcnkgcGVybWlzc2lvbnNcbiAgICB0aGlzLmRpc3RyaWJ1dGlvbiA9IG5ldyBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbih0aGlzLCAnRGlzdHJpYnV0aW9uJywge1xuICAgICAgY29tbWVudDogJ1NvbmdiaXJkIERhc2hib2FyZCcsXG5cbiAgICAgIGRlZmF1bHRCZWhhdmlvcjoge1xuICAgICAgICBvcmlnaW46IGNsb3VkZnJvbnRPcmlnaW5zLlMzQnVja2V0T3JpZ2luLndpdGhPcmlnaW5BY2Nlc3NDb250cm9sKHRoaXMuYnVja2V0KSxcbiAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlMsXG4gICAgICAgIGNhY2hlUG9saWN5OiBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfT1BUSU1JWkVELFxuXG4gICAgICAgIC8vIFJlc3BvbnNlIGhlYWRlcnMgZm9yIHNlY3VyaXR5XG4gICAgICAgIHJlc3BvbnNlSGVhZGVyc1BvbGljeTogbmV3IGNsb3VkZnJvbnQuUmVzcG9uc2VIZWFkZXJzUG9saWN5KFxuICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgJ1NlY3VyaXR5SGVhZGVycycsXG4gICAgICAgICAge1xuICAgICAgICAgICAgc2VjdXJpdHlIZWFkZXJzQmVoYXZpb3I6IHtcbiAgICAgICAgICAgICAgY29udGVudFR5cGVPcHRpb25zOiB7IG92ZXJyaWRlOiB0cnVlIH0sXG4gICAgICAgICAgICAgIGZyYW1lT3B0aW9uczoge1xuICAgICAgICAgICAgICAgIGZyYW1lT3B0aW9uOiBjbG91ZGZyb250LkhlYWRlcnNGcmFtZU9wdGlvbi5ERU5ZLFxuICAgICAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICByZWZlcnJlclBvbGljeToge1xuICAgICAgICAgICAgICAgIHJlZmVycmVyUG9saWN5OlxuICAgICAgICAgICAgICAgICAgY2xvdWRmcm9udC5IZWFkZXJzUmVmZXJyZXJQb2xpY3kuU1RSSUNUX09SSUdJTl9XSEVOX0NST1NTX09SSUdJTixcbiAgICAgICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgc3RyaWN0VHJhbnNwb3J0U2VjdXJpdHk6IHtcbiAgICAgICAgICAgICAgICBhY2Nlc3NDb250cm9sTWF4QWdlOiBjZGsuRHVyYXRpb24uZGF5cygzNjUpLFxuICAgICAgICAgICAgICAgIGluY2x1ZGVTdWJkb21haW5zOiB0cnVlLFxuICAgICAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB4c3NQcm90ZWN0aW9uOiB7XG4gICAgICAgICAgICAgICAgcHJvdGVjdGlvbjogdHJ1ZSxcbiAgICAgICAgICAgICAgICBtb2RlQmxvY2s6IHRydWUsXG4gICAgICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH1cbiAgICAgICAgKSxcbiAgICAgIH0sXG5cbiAgICAgIC8vIEVycm9yIHBhZ2VzIC0gcm91dGUgYWxsIHRvIGluZGV4Lmh0bWwgZm9yIFNQQVxuICAgICAgZXJyb3JSZXNwb25zZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIGh0dHBTdGF0dXM6IDQwMyxcbiAgICAgICAgICByZXNwb25zZUh0dHBTdGF0dXM6IDIwMCxcbiAgICAgICAgICByZXNwb25zZVBhZ2VQYXRoOiAnL2luZGV4Lmh0bWwnLFxuICAgICAgICAgIHR0bDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMCksXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBodHRwU3RhdHVzOiA0MDQsXG4gICAgICAgICAgcmVzcG9uc2VIdHRwU3RhdHVzOiAyMDAsXG4gICAgICAgICAgcmVzcG9uc2VQYWdlUGF0aDogJy9pbmRleC5odG1sJyxcbiAgICAgICAgICB0dGw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgICB9LFxuICAgICAgXSxcblxuICAgICAgLy8gUHJpY2UgY2xhc3MgLSB1c2UgYWxsIGVkZ2UgbG9jYXRpb25zIGZvciBnbG9iYWwgY292ZXJhZ2VcbiAgICAgIHByaWNlQ2xhc3M6IGNsb3VkZnJvbnQuUHJpY2VDbGFzcy5QUklDRV9DTEFTU18xMDAsXG5cbiAgICAgIC8vIEVuYWJsZSBIVFRQLzJcbiAgICAgIGh0dHBWZXJzaW9uOiBjbG91ZGZyb250Lkh0dHBWZXJzaW9uLkhUVFAyLFxuXG4gICAgICAvLyBEZWZhdWx0IHJvb3Qgb2JqZWN0XG4gICAgICBkZWZhdWx0Um9vdE9iamVjdDogJ2luZGV4Lmh0bWwnLFxuICAgIH0pO1xuXG4gICAgLy8gU3RvcmUgZGlzdHJpYnV0aW9uIFVSTFxuICAgIHRoaXMuZGlzdHJpYnV0aW9uVXJsID0gYGh0dHBzOi8vJHt0aGlzLmRpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25Eb21haW5OYW1lfWA7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIENvbmZpZ3VyYXRpb24gRmlsZSBmb3IgRGFzaGJvYXJkXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDcmVhdGUgYSBjb25maWcuanNvbiB0aGF0IHRoZSBkYXNoYm9hcmQgd2lsbCBmZXRjaCBhdCBydW50aW1lXG4gICAgY29uc3QgY29uZmlnQ29udGVudCA9IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIGFwaVVybDogcHJvcHMuYXBpVXJsLFxuICAgICAgcmVnaW9uOiBjZGsuU3RhY2sub2YodGhpcykucmVnaW9uLFxuICAgICAgdXNlclBvb2xJZDogcHJvcHMudXNlclBvb2xJZCxcbiAgICAgIHVzZXJQb29sQ2xpZW50SWQ6IHByb3BzLnVzZXJQb29sQ2xpZW50SWQsXG4gICAgfSwgbnVsbCwgMik7XG5cbiAgICAvLyBOb3RlOiBUaGUgYWN0dWFsIGRhc2hib2FyZCBkZXBsb3ltZW50IHNob3VsZCBiZSBkb25lIHNlcGFyYXRlbHlcbiAgICAvLyBhZnRlciBidWlsZGluZyB0aGUgUmVhY3QgYXBwLiBUaGlzIGNyZWF0ZXMgYSBwbGFjZWhvbGRlciBjb25maWcuXG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE91dHB1dHMgZm9yIERhc2hib2FyZCBCdWlsZFxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0Rhc2hib2FyZEJ1Y2tldE5hbWUnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5idWNrZXQuYnVja2V0TmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUzMgYnVja2V0IGZvciBkYXNoYm9hcmQgZGVwbG95bWVudCcsXG4gICAgICBleHBvcnROYW1lOiAnU29uZ2JpcmREYXNoYm9hcmRCdWNrZXQnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0Rhc2hib2FyZERpc3RyaWJ1dGlvbklkJywge1xuICAgICAgdmFsdWU6IHRoaXMuZGlzdHJpYnV0aW9uLmRpc3RyaWJ1dGlvbklkLFxuICAgICAgZGVzY3JpcHRpb246ICdDbG91ZEZyb250IGRpc3RyaWJ1dGlvbiBJRCAoZm9yIGNhY2hlIGludmFsaWRhdGlvbiknLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkRGlzdHJpYnV0aW9uSWQnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0Rhc2hib2FyZENvbmZpZycsIHtcbiAgICAgIHZhbHVlOiBjb25maWdDb250ZW50LFxuICAgICAgZGVzY3JpcHRpb246ICdEYXNoYm9hcmQgcnVudGltZSBjb25maWd1cmF0aW9uIChzYXZlIGFzIGNvbmZpZy5qc29uKScsXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==