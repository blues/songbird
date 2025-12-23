/**
 * Auth Construct
 *
 * Defines Cognito User Pool for dashboard authentication.
 */

import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

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

      // Self sign-up disabled - admin creates users
      selfSignUpEnabled: false,

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
