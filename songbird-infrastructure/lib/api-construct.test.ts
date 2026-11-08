/**
 * Tests for the ApiConstruct (CDK synth-snapshot assertions)
 */

import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as sns from 'aws-cdk-lib/aws-sns';
import { StorageConstruct } from './storage-construct';
import { AuthConstruct } from './auth-construct';
import { ApiConstruct, ApiConstructProps } from './api-construct';

function synthApiTemplate(overrides: Partial<ApiConstructProps> = {}): Template {
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
    ...overrides,
  });
  return Template.fromStack(stack);
}

describe('ApiConstruct - M9 CORS origins', () => {
  it('does not allow a wildcard CORS origin', () => {
    const template = synthApiTemplate();
    const apis = template.findResources('AWS::ApiGatewayV2::Api');
    for (const [, resource] of Object.entries(apis)) {
      const cors = (resource as any).Properties?.CorsConfiguration;
      if (cors && cors.AllowOrigins) {
        expect(cors.AllowOrigins).not.toContain('*');
      }
    }
  });

  it('restricts CORS to the dashboard domain by default', () => {
    const template = synthApiTemplate();
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: Match.arrayWith(['https://songbird.live']),
      }),
    });
  });

  it('honors a caller-supplied list of allowed origins', () => {
    const template = synthApiTemplate({
      corsAllowedOrigins: ['https://staging.example.com'],
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: ['https://staging.example.com'],
      }),
    });
  });
});
