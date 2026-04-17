import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AuthConstruct } from './auth-construct';

describe('AuthConstruct', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack');
  new AuthConstruct(stack, 'Auth', {
    userPoolName: 'test-user-pool',
  });
  const template = Template.fromStack(stack);

  it('creates exactly 1 UserPool', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
  });

  it('creates UserPool with correct name', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'test-user-pool',
    });
  });

  it('configures email sign-in', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UsernameAttributes: Match.arrayWith(['email']),
    });
  });

  it('enables self-signup', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: Match.objectLike({
        AllowAdminCreateUserOnly: false,
      }),
    });
  });

  it('configures password policy correctly', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: Match.objectLike({
        PasswordPolicy: Match.objectLike({
          MinimumLength: 8,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: false,
        }),
      }),
    });
  });

  it('configures MFA as optional with OTP only', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      MfaConfiguration: 'OPTIONAL',
      EnabledMfas: Match.arrayWith(['SOFTWARE_TOKEN_MFA']),
    });
  });

  it('auto-verifies email', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AutoVerifiedAttributes: Match.arrayWith(['email']),
    });
  });

  it('defines custom attributes', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Schema: Match.arrayWith([
        Match.objectLike({ Name: 'team', AttributeDataType: 'String', Mutable: true }),
        Match.objectLike({ Name: 'role', AttributeDataType: 'String', Mutable: true }),
        Match.objectLike({ Name: 'temp_unit', AttributeDataType: 'String', Mutable: true }),
        Match.objectLike({ Name: 'time_format', AttributeDataType: 'String', Mutable: true }),
        Match.objectLike({ Name: 'default_time_range', AttributeDataType: 'String', Mutable: true }),
        Match.objectLike({ Name: 'map_style', AttributeDataType: 'String', Mutable: true }),
        Match.objectLike({ Name: 'distance_unit', AttributeDataType: 'String', Mutable: true }),
      ]),
    });
  });

  it('creates exactly 1 UserPoolClient', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
  });

  it('creates UserPoolClient with correct auth flows and no secret', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'songbird-dashboard',
      ExplicitAuthFlows: Match.arrayWith([
        'ALLOW_USER_PASSWORD_AUTH',
        'ALLOW_USER_SRP_AUTH',
      ]),
      GenerateSecret: false,
    });
  });

  it('configures token validity on the client', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      AccessTokenValidity: 60,
      IdTokenValidity: 60,
      RefreshTokenValidity: 43200,
    });
  });

  it('creates exactly 4 user pool groups', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolGroup', 4);
  });

  it('creates Admin group with precedence 1', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
      GroupName: 'Admin',
      Precedence: 1,
    });
  });

  it('creates Sales group with precedence 10', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
      GroupName: 'Sales',
      Precedence: 10,
    });
  });

  it('creates FieldEngineering group with precedence 10', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
      GroupName: 'FieldEngineering',
      Precedence: 10,
    });
  });

  it('creates Viewer group with precedence 100', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
      GroupName: 'Viewer',
      Precedence: 100,
    });
  });
});
