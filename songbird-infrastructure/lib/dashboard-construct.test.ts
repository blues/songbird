import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DashboardConstruct } from './dashboard-construct';

describe('DashboardConstruct', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  new DashboardConstruct(stack, 'Dashboard', {
    apiUrl: 'https://api.example.com',
    userPoolId: 'us-east-1_testpool',
    userPoolClientId: 'testclientid',
  });
  const template = Template.fromStack(stack);

  it('creates exactly 1 S3 bucket', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
  });

  it('creates S3 bucket with block public access', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('creates S3 bucket with S3 managed encryption', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256',
            },
          }),
        ]),
      }),
    });
  });

  it('creates exactly 1 CloudFront distribution', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  it('configures distribution with default root object', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
      }),
    });
  });

  it('configures distribution with HTTP/2', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        HttpVersion: 'http2',
      }),
    });
  });

  it('configures distribution with PRICE_CLASS_100', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        PriceClass: 'PriceClass_100',
      }),
    });
  });

  it('configures SPA error responses for 403 and 404', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 403,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          }),
          Match.objectLike({
            ErrorCode: 404,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          }),
        ]),
      }),
    });
  });

  it('creates a response headers policy for security headers', () => {
    template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 1);
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: Match.objectLike({
            Override: true,
            IncludeSubdomains: true,
          }),
          XSSProtection: Match.objectLike({
            Protection: true,
            ModeBlock: true,
            Override: true,
          }),
          FrameOptions: Match.objectLike({
            FrameOption: 'DENY',
            Override: true,
          }),
          ContentTypeOptions: Match.objectLike({
            Override: true,
          }),
        }),
      }),
    });
  });

  it('creates CfnOutputs for bucket name, distribution ID, and config', () => {
    const outputs = template.findOutputs('*');
    const outputKeys = Object.keys(outputs);

    const hasBucketOutput = outputKeys.some((k) => k.includes('DashboardBucketName'));
    const hasDistributionOutput = outputKeys.some((k) => k.includes('DashboardDistributionId'));
    const hasConfigOutput = outputKeys.some((k) => k.includes('DashboardConfig'));

    expect(hasBucketOutput).toBe(true);
    expect(hasDistributionOutput).toBe(true);
    expect(hasConfigOutput).toBe(true);
  });

  it('does not create ACM certificate or Route53 record without domain', () => {
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    template.resourceCountIs('AWS::Route53::RecordSet', 0);
  });
});
