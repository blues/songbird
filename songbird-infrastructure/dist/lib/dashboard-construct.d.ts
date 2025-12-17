/**
 * Dashboard Construct
 *
 * Defines S3 bucket and CloudFront distribution for hosting
 * the Songbird React dashboard application.
 */
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Construct } from 'constructs';
export interface DashboardConstructProps {
    apiUrl: string;
    userPoolId: string;
    userPoolClientId: string;
}
export declare class DashboardConstruct extends Construct {
    readonly bucket: s3.Bucket;
    readonly distribution: cloudfront.Distribution;
    readonly distributionUrl: string;
    constructor(scope: Construct, id: string, props: DashboardConstructProps);
}
