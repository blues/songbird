/**
 * Auth Construct
 *
 * Defines Cognito User Pool for dashboard authentication.
 */
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
export interface AuthConstructProps {
    userPoolName: string;
}
export declare class AuthConstruct extends Construct {
    readonly userPool: cognito.UserPool;
    readonly userPoolClient: cognito.UserPoolClient;
    constructor(scope: Construct, id: string, props: AuthConstructProps);
}
