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
            websiteIndexDocument: 'index.html',
            websiteErrorDocument: 'index.html', // SPA routing
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
        // CloudFront Origin Access Identity
        // ==========================================================================
        const originAccessIdentity = new cloudfront.OriginAccessIdentity(this, 'OAI', {
            comment: 'Songbird Dashboard OAI',
        });
        // Grant OAI read access to bucket
        this.bucket.grantRead(originAccessIdentity);
        // ==========================================================================
        // CloudFront Distribution
        // ==========================================================================
        this.distribution = new cloudfront.Distribution(this, 'Distribution', {
            comment: 'Songbird Dashboard',
            defaultBehavior: {
                origin: new cloudfrontOrigins.S3Origin(this.bucket, {
                    originAccessIdentity,
                }),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGFzaGJvYXJkLWNvbnN0cnVjdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL2xpYi9kYXNoYm9hcmQtY29uc3RydWN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7R0FLRzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFFSCxpREFBbUM7QUFDbkMsdURBQXlDO0FBQ3pDLHVFQUF5RDtBQUN6RCxzRkFBd0U7QUFFeEUsMkNBQXVDO0FBVXZDLE1BQWEsa0JBQW1CLFNBQVEsc0JBQVM7SUFDL0IsTUFBTSxDQUFZO0lBQ2xCLFlBQVksQ0FBMEI7SUFDdEMsZUFBZSxDQUFTO0lBRXhDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBOEI7UUFDdEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQiw2RUFBNkU7UUFDN0UsaUNBQWlDO1FBQ2pDLDZFQUE2RTtRQUM3RSxJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUU7WUFDbkQsVUFBVSxFQUFFLHNCQUFzQixHQUFHLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxPQUFPLEVBQUU7WUFDOUQsb0JBQW9CLEVBQUUsWUFBWTtZQUNsQyxvQkFBb0IsRUFBRSxZQUFZLEVBQUUsY0FBYztZQUNsRCxnQkFBZ0IsRUFBRSxLQUFLO1lBQ3ZCLGlCQUFpQixFQUFFLEVBQUUsQ0FBQyxpQkFBaUIsQ0FBQyxTQUFTO1lBQ2pELGFBQWEsRUFBRSxHQUFHLENBQUMsYUFBYSxDQUFDLE9BQU87WUFDeEMsaUJBQWlCLEVBQUUsSUFBSTtZQUN2QixVQUFVLEVBQUUsRUFBRSxDQUFDLGdCQUFnQixDQUFDLFVBQVU7WUFFMUMsNENBQTRDO1lBQzVDLElBQUksRUFBRTtnQkFDSjtvQkFDRSxjQUFjLEVBQUUsQ0FBQyxFQUFFLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQztvQkFDcEMsY0FBYyxFQUFFLENBQUMsR0FBRyxDQUFDO29CQUNyQixjQUFjLEVBQUUsQ0FBQyxHQUFHLENBQUM7aUJBQ3RCO2FBQ0Y7U0FDRixDQUFDLENBQUM7UUFFSCw2RUFBNkU7UUFDN0Usb0NBQW9DO1FBQ3BDLDZFQUE2RTtRQUM3RSxNQUFNLG9CQUFvQixHQUFHLElBQUksVUFBVSxDQUFDLG9CQUFvQixDQUM5RCxJQUFJLEVBQ0osS0FBSyxFQUNMO1lBQ0UsT0FBTyxFQUFFLHdCQUF3QjtTQUNsQyxDQUNGLENBQUM7UUFFRixrQ0FBa0M7UUFDbEMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsb0JBQW9CLENBQUMsQ0FBQztRQUU1Qyw2RUFBNkU7UUFDN0UsMEJBQTBCO1FBQzFCLDZFQUE2RTtRQUM3RSxJQUFJLENBQUMsWUFBWSxHQUFHLElBQUksVUFBVSxDQUFDLFlBQVksQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFO1lBQ3BFLE9BQU8sRUFBRSxvQkFBb0I7WUFFN0IsZUFBZSxFQUFFO2dCQUNmLE1BQU0sRUFBRSxJQUFJLGlCQUFpQixDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsTUFBTSxFQUFFO29CQUNsRCxvQkFBb0I7aUJBQ3JCLENBQUM7Z0JBQ0Ysb0JBQW9CLEVBQUUsVUFBVSxDQUFDLG9CQUFvQixDQUFDLGlCQUFpQjtnQkFDdkUsY0FBYyxFQUFFLFVBQVUsQ0FBQyxjQUFjLENBQUMsc0JBQXNCO2dCQUNoRSxXQUFXLEVBQUUsVUFBVSxDQUFDLFdBQVcsQ0FBQyxpQkFBaUI7Z0JBRXJELGdDQUFnQztnQkFDaEMscUJBQXFCLEVBQUUsSUFBSSxVQUFVLENBQUMscUJBQXFCLENBQ3pELElBQUksRUFDSixpQkFBaUIsRUFDakI7b0JBQ0UsdUJBQXVCLEVBQUU7d0JBQ3ZCLGtCQUFrQixFQUFFLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRTt3QkFDdEMsWUFBWSxFQUFFOzRCQUNaLFdBQVcsRUFBRSxVQUFVLENBQUMsa0JBQWtCLENBQUMsSUFBSTs0QkFDL0MsUUFBUSxFQUFFLElBQUk7eUJBQ2Y7d0JBQ0QsY0FBYyxFQUFFOzRCQUNkLGNBQWMsRUFDWixVQUFVLENBQUMscUJBQXFCLENBQUMsK0JBQStCOzRCQUNsRSxRQUFRLEVBQUUsSUFBSTt5QkFDZjt3QkFDRCx1QkFBdUIsRUFBRTs0QkFDdkIsbUJBQW1CLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDOzRCQUMzQyxpQkFBaUIsRUFBRSxJQUFJOzRCQUN2QixRQUFRLEVBQUUsSUFBSTt5QkFDZjt3QkFDRCxhQUFhLEVBQUU7NEJBQ2IsVUFBVSxFQUFFLElBQUk7NEJBQ2hCLFNBQVMsRUFBRSxJQUFJOzRCQUNmLFFBQVEsRUFBRSxJQUFJO3lCQUNmO3FCQUNGO2lCQUNGLENBQ0Y7YUFDRjtZQUVELGdEQUFnRDtZQUNoRCxjQUFjLEVBQUU7Z0JBQ2Q7b0JBQ0UsVUFBVSxFQUFFLEdBQUc7b0JBQ2Ysa0JBQWtCLEVBQUUsR0FBRztvQkFDdkIsZ0JBQWdCLEVBQUUsYUFBYTtvQkFDL0IsR0FBRyxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztpQkFDN0I7Z0JBQ0Q7b0JBQ0UsVUFBVSxFQUFFLEdBQUc7b0JBQ2Ysa0JBQWtCLEVBQUUsR0FBRztvQkFDdkIsZ0JBQWdCLEVBQUUsYUFBYTtvQkFDL0IsR0FBRyxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztpQkFDN0I7YUFDRjtZQUVELDJEQUEyRDtZQUMzRCxVQUFVLEVBQUUsVUFBVSxDQUFDLFVBQVUsQ0FBQyxlQUFlO1lBRWpELGdCQUFnQjtZQUNoQixXQUFXLEVBQUUsVUFBVSxDQUFDLFdBQVcsQ0FBQyxLQUFLO1lBRXpDLHNCQUFzQjtZQUN0QixpQkFBaUIsRUFBRSxZQUFZO1NBQ2hDLENBQUMsQ0FBQztRQUVILHlCQUF5QjtRQUN6QixJQUFJLENBQUMsZUFBZSxHQUFHLFdBQVcsSUFBSSxDQUFDLFlBQVksQ0FBQyxzQkFBc0IsRUFBRSxDQUFDO1FBRTdFLDZFQUE2RTtRQUM3RSxtQ0FBbUM7UUFDbkMsNkVBQTZFO1FBQzdFLGdFQUFnRTtRQUNoRSxNQUFNLGFBQWEsR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDO1lBQ25DLE1BQU0sRUFBRSxLQUFLLENBQUMsTUFBTTtZQUNwQixNQUFNLEVBQUUsR0FBRyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTTtZQUNqQyxVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVU7WUFDNUIsZ0JBQWdCLEVBQUUsS0FBSyxDQUFDLGdCQUFnQjtTQUN6QyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQztRQUVaLGtFQUFrRTtRQUNsRSxtRUFBbUU7UUFFbkUsNkVBQTZFO1FBQzdFLDhCQUE4QjtRQUM5Qiw2RUFBNkU7UUFDN0UsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxxQkFBcUIsRUFBRTtZQUM3QyxLQUFLLEVBQUUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxVQUFVO1lBQzdCLFdBQVcsRUFBRSxvQ0FBb0M7WUFDakQsVUFBVSxFQUFFLHlCQUF5QjtTQUN0QyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHlCQUF5QixFQUFFO1lBQ2pELEtBQUssRUFBRSxJQUFJLENBQUMsWUFBWSxDQUFDLGNBQWM7WUFDdkMsV0FBVyxFQUFFLHFEQUFxRDtZQUNsRSxVQUFVLEVBQUUsd0JBQXdCO1NBQ3JDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUU7WUFDekMsS0FBSyxFQUFFLGFBQWE7WUFDcEIsV0FBVyxFQUFFLHVEQUF1RDtTQUNyRSxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUF6SkQsZ0RBeUpDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBEYXNoYm9hcmQgQ29uc3RydWN0XG4gKlxuICogRGVmaW5lcyBTMyBidWNrZXQgYW5kIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uIGZvciBob3N0aW5nXG4gKiB0aGUgU29uZ2JpcmQgUmVhY3QgZGFzaGJvYXJkIGFwcGxpY2F0aW9uLlxuICovXG5cbmltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBzMyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMnO1xuaW1wb3J0ICogYXMgY2xvdWRmcm9udCBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udCc7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250T3JpZ2lucyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udC1vcmlnaW5zJztcbmltcG9ydCAqIGFzIHMzZGVwbG95IGZyb20gJ2F3cy1jZGstbGliL2F3cy1zMy1kZXBsb3ltZW50JztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCAqIGFzIGZzIGZyb20gJ2ZzJztcblxuZXhwb3J0IGludGVyZmFjZSBEYXNoYm9hcmRDb25zdHJ1Y3RQcm9wcyB7XG4gIGFwaVVybDogc3RyaW5nO1xuICB1c2VyUG9vbElkOiBzdHJpbmc7XG4gIHVzZXJQb29sQ2xpZW50SWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIERhc2hib2FyZENvbnN0cnVjdCBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBidWNrZXQ6IHMzLkJ1Y2tldDtcbiAgcHVibGljIHJlYWRvbmx5IGRpc3RyaWJ1dGlvbjogY2xvdWRmcm9udC5EaXN0cmlidXRpb247XG4gIHB1YmxpYyByZWFkb25seSBkaXN0cmlidXRpb25Vcmw6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogRGFzaGJvYXJkQ29uc3RydWN0UHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBTMyBCdWNrZXQgZm9yIERhc2hib2FyZCBBc3NldHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuYnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCAnRGFzaGJvYXJkQnVja2V0Jywge1xuICAgICAgYnVja2V0TmFtZTogYHNvbmdiaXJkLWRhc2hib2FyZC0ke2Nkay5TdGFjay5vZih0aGlzKS5hY2NvdW50fWAsXG4gICAgICB3ZWJzaXRlSW5kZXhEb2N1bWVudDogJ2luZGV4Lmh0bWwnLFxuICAgICAgd2Vic2l0ZUVycm9yRG9jdW1lbnQ6ICdpbmRleC5odG1sJywgLy8gU1BBIHJvdXRpbmdcbiAgICAgIHB1YmxpY1JlYWRBY2Nlc3M6IGZhbHNlLFxuICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICBhdXRvRGVsZXRlT2JqZWN0czogdHJ1ZSxcbiAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcblxuICAgICAgLy8gQ09SUyBmb3IgQVBJIHJlcXVlc3RzIChpZiBuZWVkZWQgZm9yIGRldilcbiAgICAgIGNvcnM6IFtcbiAgICAgICAge1xuICAgICAgICAgIGFsbG93ZWRNZXRob2RzOiBbczMuSHR0cE1ldGhvZHMuR0VUXSxcbiAgICAgICAgICBhbGxvd2VkT3JpZ2luczogWycqJ10sXG4gICAgICAgICAgYWxsb3dlZEhlYWRlcnM6IFsnKiddLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ2xvdWRGcm9udCBPcmlnaW4gQWNjZXNzIElkZW50aXR5XG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBvcmlnaW5BY2Nlc3NJZGVudGl0eSA9IG5ldyBjbG91ZGZyb250Lk9yaWdpbkFjY2Vzc0lkZW50aXR5KFxuICAgICAgdGhpcyxcbiAgICAgICdPQUknLFxuICAgICAge1xuICAgICAgICBjb21tZW50OiAnU29uZ2JpcmQgRGFzaGJvYXJkIE9BSScsXG4gICAgICB9XG4gICAgKTtcblxuICAgIC8vIEdyYW50IE9BSSByZWFkIGFjY2VzcyB0byBidWNrZXRcbiAgICB0aGlzLmJ1Y2tldC5ncmFudFJlYWQob3JpZ2luQWNjZXNzSWRlbnRpdHkpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDbG91ZEZyb250IERpc3RyaWJ1dGlvblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5kaXN0cmlidXRpb24gPSBuZXcgY2xvdWRmcm9udC5EaXN0cmlidXRpb24odGhpcywgJ0Rpc3RyaWJ1dGlvbicsIHtcbiAgICAgIGNvbW1lbnQ6ICdTb25nYmlyZCBEYXNoYm9hcmQnLFxuXG4gICAgICBkZWZhdWx0QmVoYXZpb3I6IHtcbiAgICAgICAgb3JpZ2luOiBuZXcgY2xvdWRmcm9udE9yaWdpbnMuUzNPcmlnaW4odGhpcy5idWNrZXQsIHtcbiAgICAgICAgICBvcmlnaW5BY2Nlc3NJZGVudGl0eSxcbiAgICAgICAgfSksXG4gICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19HRVRfSEVBRF9PUFRJT05TLFxuICAgICAgICBjYWNoZVBvbGljeTogY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX09QVElNSVpFRCxcblxuICAgICAgICAvLyBSZXNwb25zZSBoZWFkZXJzIGZvciBzZWN1cml0eVxuICAgICAgICByZXNwb25zZUhlYWRlcnNQb2xpY3k6IG5ldyBjbG91ZGZyb250LlJlc3BvbnNlSGVhZGVyc1BvbGljeShcbiAgICAgICAgICB0aGlzLFxuICAgICAgICAgICdTZWN1cml0eUhlYWRlcnMnLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIHNlY3VyaXR5SGVhZGVyc0JlaGF2aW9yOiB7XG4gICAgICAgICAgICAgIGNvbnRlbnRUeXBlT3B0aW9uczogeyBvdmVycmlkZTogdHJ1ZSB9LFxuICAgICAgICAgICAgICBmcmFtZU9wdGlvbnM6IHtcbiAgICAgICAgICAgICAgICBmcmFtZU9wdGlvbjogY2xvdWRmcm9udC5IZWFkZXJzRnJhbWVPcHRpb24uREVOWSxcbiAgICAgICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgcmVmZXJyZXJQb2xpY3k6IHtcbiAgICAgICAgICAgICAgICByZWZlcnJlclBvbGljeTpcbiAgICAgICAgICAgICAgICAgIGNsb3VkZnJvbnQuSGVhZGVyc1JlZmVycmVyUG9saWN5LlNUUklDVF9PUklHSU5fV0hFTl9DUk9TU19PUklHSU4sXG4gICAgICAgICAgICAgICAgb3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIHN0cmljdFRyYW5zcG9ydFNlY3VyaXR5OiB7XG4gICAgICAgICAgICAgICAgYWNjZXNzQ29udHJvbE1heEFnZTogY2RrLkR1cmF0aW9uLmRheXMoMzY1KSxcbiAgICAgICAgICAgICAgICBpbmNsdWRlU3ViZG9tYWluczogdHJ1ZSxcbiAgICAgICAgICAgICAgICBvdmVycmlkZTogdHJ1ZSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgeHNzUHJvdGVjdGlvbjoge1xuICAgICAgICAgICAgICAgIHByb3RlY3Rpb246IHRydWUsXG4gICAgICAgICAgICAgICAgbW9kZUJsb2NrOiB0cnVlLFxuICAgICAgICAgICAgICAgIG92ZXJyaWRlOiB0cnVlLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9XG4gICAgICAgICksXG4gICAgICB9LFxuXG4gICAgICAvLyBFcnJvciBwYWdlcyAtIHJvdXRlIGFsbCB0byBpbmRleC5odG1sIGZvciBTUEFcbiAgICAgIGVycm9yUmVzcG9uc2VzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBodHRwU3RhdHVzOiA0MDMsXG4gICAgICAgICAgcmVzcG9uc2VIdHRwU3RhdHVzOiAyMDAsXG4gICAgICAgICAgcmVzcG9uc2VQYWdlUGF0aDogJy9pbmRleC5odG1sJyxcbiAgICAgICAgICB0dGw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgaHR0cFN0YXR1czogNDA0LFxuICAgICAgICAgIHJlc3BvbnNlSHR0cFN0YXR1czogMjAwLFxuICAgICAgICAgIHJlc3BvbnNlUGFnZVBhdGg6ICcvaW5kZXguaHRtbCcsXG4gICAgICAgICAgdHRsOiBjZGsuRHVyYXRpb24uc2Vjb25kcygwKSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG5cbiAgICAgIC8vIFByaWNlIGNsYXNzIC0gdXNlIGFsbCBlZGdlIGxvY2F0aW9ucyBmb3IgZ2xvYmFsIGNvdmVyYWdlXG4gICAgICBwcmljZUNsYXNzOiBjbG91ZGZyb250LlByaWNlQ2xhc3MuUFJJQ0VfQ0xBU1NfMTAwLFxuXG4gICAgICAvLyBFbmFibGUgSFRUUC8yXG4gICAgICBodHRwVmVyc2lvbjogY2xvdWRmcm9udC5IdHRwVmVyc2lvbi5IVFRQMixcblxuICAgICAgLy8gRGVmYXVsdCByb290IG9iamVjdFxuICAgICAgZGVmYXVsdFJvb3RPYmplY3Q6ICdpbmRleC5odG1sJyxcbiAgICB9KTtcblxuICAgIC8vIFN0b3JlIGRpc3RyaWJ1dGlvbiBVUkxcbiAgICB0aGlzLmRpc3RyaWJ1dGlvblVybCA9IGBodHRwczovLyR7dGhpcy5kaXN0cmlidXRpb24uZGlzdHJpYnV0aW9uRG9tYWluTmFtZX1gO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDb25maWd1cmF0aW9uIEZpbGUgZm9yIERhc2hib2FyZFxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ3JlYXRlIGEgY29uZmlnLmpzb24gdGhhdCB0aGUgZGFzaGJvYXJkIHdpbGwgZmV0Y2ggYXQgcnVudGltZVxuICAgIGNvbnN0IGNvbmZpZ0NvbnRlbnQgPSBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBhcGlVcmw6IHByb3BzLmFwaVVybCxcbiAgICAgIHJlZ2lvbjogY2RrLlN0YWNrLm9mKHRoaXMpLnJlZ2lvbixcbiAgICAgIHVzZXJQb29sSWQ6IHByb3BzLnVzZXJQb29sSWQsXG4gICAgICB1c2VyUG9vbENsaWVudElkOiBwcm9wcy51c2VyUG9vbENsaWVudElkLFxuICAgIH0sIG51bGwsIDIpO1xuXG4gICAgLy8gTm90ZTogVGhlIGFjdHVhbCBkYXNoYm9hcmQgZGVwbG95bWVudCBzaG91bGQgYmUgZG9uZSBzZXBhcmF0ZWx5XG4gICAgLy8gYWZ0ZXIgYnVpbGRpbmcgdGhlIFJlYWN0IGFwcC4gVGhpcyBjcmVhdGVzIGEgcGxhY2Vob2xkZXIgY29uZmlnLlxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBPdXRwdXRzIGZvciBEYXNoYm9hcmQgQnVpbGRcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEYXNoYm9hcmRCdWNrZXROYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMuYnVja2V0LmJ1Y2tldE5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ1MzIGJ1Y2tldCBmb3IgZGFzaGJvYXJkIGRlcGxveW1lbnQnLFxuICAgICAgZXhwb3J0TmFtZTogJ1NvbmdiaXJkRGFzaGJvYXJkQnVja2V0JyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEYXNoYm9hcmREaXN0cmlidXRpb25JZCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmRpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25JZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gSUQgKGZvciBjYWNoZSBpbnZhbGlkYXRpb24pJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdTb25nYmlyZERpc3RyaWJ1dGlvbklkJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEYXNoYm9hcmRDb25maWcnLCB7XG4gICAgICB2YWx1ZTogY29uZmlnQ29udGVudCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRGFzaGJvYXJkIHJ1bnRpbWUgY29uZmlndXJhdGlvbiAoc2F2ZSBhcyBjb25maWcuanNvbiknLFxuICAgIH0pO1xuICB9XG59XG4iXX0=