/**
 * Dashboard Construct
 *
 * Defines S3 bucket and CloudFront distribution for hosting
 * the Songbird React dashboard application.
 */

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfrontOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import * as path from 'path';
import * as fs from 'fs';

export interface DashboardConstructProps {
  apiUrl: string;
  userPoolId: string;
  userPoolClientId: string;
}

export class DashboardConstruct extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly distributionUrl: string;

  constructor(scope: Construct, id: string, props: DashboardConstructProps) {
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
    const originAccessIdentity = new cloudfront.OriginAccessIdentity(
      this,
      'OAI',
      {
        comment: 'Songbird Dashboard OAI',
      }
    );

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
        responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(
          this,
          'SecurityHeaders',
          {
            securityHeadersBehavior: {
              contentTypeOptions: { override: true },
              frameOptions: {
                frameOption: cloudfront.HeadersFrameOption.DENY,
                override: true,
              },
              referrerPolicy: {
                referrerPolicy:
                  cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
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
          }
        ),
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
