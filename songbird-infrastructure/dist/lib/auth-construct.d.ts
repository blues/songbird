/**
 * Auth Construct
 *
 * Defines Cognito User Pool for dashboard authentication.
 * Supports self-registration with automatic Viewer role assignment.
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
/**
 * Separate construct for the post-confirmation Lambda trigger.
 * Uses a wildcard ARN for IAM permissions to avoid circular dependencies.
 */
export interface PostConfirmationTriggerProps {
    userPool: cognito.UserPool;
}
export declare class PostConfirmationTrigger extends Construct {
    constructor(scope: Construct, id: string, props: PostConfirmationTriggerProps);
}
