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
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import * as path from 'path';
import * as fs from 'fs';

export interface DashboardConstructProps {
  apiUrl: string;
  userPoolId: string;
  userPoolClientId: string;
  domainName?: string;
  hostedZone?: route53.IHostedZone;
}

export class DashboardConstruct extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly distributionUrl: string;

  constructor(scope: Construct, id: string, props: DashboardConstructProps) {
    super(scope, id);

    // ==========================================================================
    // ACM Certificate (if custom domain provided)
    // ==========================================================================
    let certificate: acm.ICertificate | undefined;
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
        target: route53.RecordTarget.fromAlias(
          new route53Targets.CloudFrontTarget(this.distribution)
        ),
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
