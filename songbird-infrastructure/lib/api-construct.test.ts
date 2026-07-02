/**
 * Tests for the ApiConstruct (CDK synth-snapshot assertions)
 *
 * These tests synthesize the construct and assert on the generated
 * CloudFormation template for security posture regressions.
 */

import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as sns from 'aws-cdk-lib/aws-sns';
import { StorageConstruct } from './storage-construct';
import { AuthConstruct } from './auth-construct';
import { ApiConstruct } from './api-construct';

function synthApiTemplate(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestApiStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const storage = new StorageConstruct(stack, 'Storage', {
    dynamoTableName: 'test-devices',
    telemetryTableName: 'test-telemetry',
  });
  const auth = new AuthConstruct(stack, 'Auth', { userPoolName: 'test-users' });
  const alertTopic = new sns.Topic(stack, 'AlertTopic');
  new ApiConstruct(stack, 'Api', {
    telemetryTable: storage.telemetryTable,
    devicesTable: storage.devicesTable,
    alertsTable: storage.alertsTable,
    settingsTable: storage.settingsTable,
    journeysTable: storage.journeysTable,
    locationsTable: storage.locationsTable,
    deviceAliasesTable: storage.deviceAliasesTable,
    auditTable: storage.auditTable,
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
    notehubProjectUid: 'app:test-uid',
    alertTopic,
  });
  return Template.fromStack(stack);
}

describe('ApiConstruct - H8 Mapbox token handling', () => {
  const template = synthApiTemplate();

  it('does not expose the Mapbox token as a plaintext Lambda environment variable', () => {
    // The Journeys function must receive only the secret ARN, never a resolved
    // token value. Assert no Lambda env var references a MAPBOX_TOKEN key.
    const functions = template.findResources('AWS::Lambda::Function');
    for (const [, resource] of Object.entries(functions)) {
      const env = (resource as any).Properties?.Environment?.Variables ?? {};
      expect(env).not.toHaveProperty('MAPBOX_TOKEN');
    }
  });

  it('passes the Mapbox secret ARN to the Journeys function via MAPBOX_SECRET_ARN', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          MAPBOX_SECRET_ARN: Match.anyValue(),
        }),
      },
    });
  });

  it('grants the Journeys function read access to the Mapbox secret', () => {
    // secretsmanager:GetSecretValue must appear in an IAM policy so the
    // function can fetch the token at runtime (grantRead).
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
          }),
        ]),
      },
    });
  });
});
