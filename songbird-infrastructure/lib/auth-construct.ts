/**
 * Auth Construct
 *
 * Defines Cognito User Pool for dashboard authentication.
 * Supports self-registration with automatic Viewer role assignment.
 */

import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';

export interface AuthConstructProps {
  userPoolName: string;
}

export class AuthConstruct extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthConstructProps) {
    super(scope, id);

    // ==========================================================================
    // Cognito User Pool
    // ==========================================================================
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: props.userPoolName,

      // Sign-in options
      signInAliases: {
        email: true,
        username: false,
      },

      // Self sign-up enabled - users get Viewer role by default via Lambda trigger
      selfSignUpEnabled: true,
      userVerification: {
        emailSubject: 'Welcome to Songbird - Verify your email',
        emailBody: 'Thanks for signing up to Songbird! Your verification code is {####}',
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },

      // Password policy
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
        tempPasswordValidity: cdk.Duration.days(7),
      },

      // Account recovery
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,

      // MFA - optional for demo
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: false,
        otp: true,
      },

      // User verification
      autoVerify: {
        email: true,
      },

      // Standard attributes
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
        fullname: {
          required: true,
          mutable: true,
        },
      },

      // Custom attributes
      customAttributes: {
        team: new cognito.StringAttribute({ mutable: true }),
        role: new cognito.StringAttribute({ mutable: true }),
        // Display preferences
        temp_unit: new cognito.StringAttribute({ mutable: true }), // 'celsius' | 'fahrenheit'
        time_format: new cognito.StringAttribute({ mutable: true }), // '12h' | '24h'
        default_time_range: new cognito.StringAttribute({ mutable: true }), // '1' | '12' | '24' | '48' | '168'
        map_style: new cognito.StringAttribute({ mutable: true }), // 'street' | 'satellite'
        distance_unit: new cognito.StringAttribute({ mutable: true }), // 'km' | 'mi'
      },

      // Email configuration (use Cognito default for demo)
      email: cognito.UserPoolEmail.withCognito(),

      // Removal policy for demo environment
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ==========================================================================
    // User Pool Client (for Dashboard SPA)
    // ==========================================================================
    this.userPoolClient = this.userPool.addClient('DashboardClient', {
      userPoolClientName: 'songbird-dashboard',

      // Auth flows
      authFlows: {
        userPassword: true,
        userSrp: true,
      },

      // No client secret for SPA
      generateSecret: false,

      // Token validity
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),

      // Prevent user existence errors (security)
      preventUserExistenceErrors: true,

      // OAuth settings (for hosted UI if needed)
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: false,
        },
        scopes: [
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [
          'http://localhost:5173/callback',  // Vite dev server
          'http://localhost:3000/callback',
        ],
        logoutUrls: [
          'http://localhost:5173/',
          'http://localhost:3000/',
        ],
      },
    });

    // ==========================================================================
    // User Pool Groups
    // ==========================================================================

    // Admin group - full access
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'Admin',
      description: 'Administrators with full access',
      precedence: 1,
    });

    // Sales group
    new cognito.CfnUserPoolGroup(this, 'SalesGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'Sales',
      description: 'Sales team members',
      precedence: 10,
    });

    // Field Engineering group
    new cognito.CfnUserPoolGroup(this, 'FieldEngineeringGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'FieldEngineering',
      description: 'Field Engineering team members',
      precedence: 10,
    });

    // Read-only group
    new cognito.CfnUserPoolGroup(this, 'ViewerGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'Viewer',
      description: 'Read-only access',
      precedence: 100,
    });

  }
}

/**
 * Separate construct for the post-confirmation Lambda trigger.
 * Uses a wildcard ARN for IAM permissions to avoid circular dependencies.
 */
export interface PostConfirmationTriggerProps {
  userPool: cognito.UserPool;
}

export class PostConfirmationTrigger extends Construct {
  constructor(scope: Construct, id: string, props: PostConfirmationTriggerProps) {
    super(scope, id);

    const postConfirmationLambda = new lambdaNodejs.NodejsFunction(this, 'Function', {
      functionName: 'songbird-cognito-post-confirmation',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/cognito-post-confirmation/index.ts'),
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      bundling: {
        minify: true,
        sourceMap: false,
        externalModules: ['@aws-sdk/*'],
      },
    });

    // Grant the Lambda permission to add users to groups
    // Use wildcard to avoid circular dependency (the lambda only operates on this user pool anyway)
    postConfirmationLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminAddUserToGroup'],
      resources: ['*'],
    }));

    // Grant Cognito permission to invoke the Lambda using CfnPermission to avoid dependency
    new lambda.CfnPermission(this, 'CognitoInvoke', {
      action: 'lambda:InvokeFunction',
      functionName: postConfirmationLambda.functionName,
      principal: 'cognito-idp.amazonaws.com',
      sourceArn: props.userPool.userPoolArn,
    });

    // Add the Lambda trigger using escape hatch to avoid circular dependency
    const cfnUserPool = props.userPool.node.defaultChild as cognito.CfnUserPool;
    cfnUserPool.lambdaConfig = {
      postConfirmation: postConfirmationLambda.functionArn,
    };
  }
}
