/**
 * Songbird Main Stack
 *
 * Orchestrates all infrastructure constructs for the Songbird demo platform.
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
export interface SongbirdStackProps extends cdk.StackProps {
    notehubProjectUid: string;
}
export declare class SongbirdStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: SongbirdStackProps);
}
