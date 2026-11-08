import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ApiConstruct } from './api-construct';
import { StorageConstruct } from './storage-construct';
import { AuthConstruct } from './auth-construct';

describe('ApiConstruct', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });

  const storage = new StorageConstruct(stack, 'Storage', {
    dynamoTableName: 'test-devices',
    telemetryTableName: 'test-telemetry',
  });
  const auth = new AuthConstruct(stack, 'Auth', {
    userPoolName: 'test-user-pool',
  });
  const alertTopic = new sns.Topic(stack, 'TestAlertTopic');

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

  const template = Template.fromStack(stack);

  it('creates an HTTP API', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  });

  // M14: API Gateway throttling to defend against abuse and public-endpoint
  // serial enumeration (WAFv2 cannot attach to HTTP APIs).
  it('applies fleet-wide default throttling on the API stage', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: Match.objectLike({
        ThrottlingRateLimit: 100,
        ThrottlingBurstLimit: 200,
      }),
    });
  });

  it('applies a tighter per-route throttle on the public device endpoint', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      RouteSettings: Match.objectLike({
        'GET /v1/public/devices/{serial_number}': {
          ThrottlingRateLimit: 5,
          ThrottlingBurstLimit: 10,
        },
      }),
    });
  });
});
