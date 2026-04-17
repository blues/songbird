import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { StorageConstruct } from './storage-construct';

describe('StorageConstruct', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack');
  new StorageConstruct(stack, 'Storage', {
    dynamoTableName: 'test-devices',
    telemetryTableName: 'test-telemetry',
  });
  const template = Template.fromStack(stack);

  it('creates exactly 8 DynamoDB tables', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 8);
  });

  it('creates devices table with correct key schema and billing mode', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'test-devices',
      KeySchema: [
        { AttributeName: 'device_uid', KeyType: 'HASH' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('creates telemetry table with composite key', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'test-telemetry',
      KeySchema: Match.arrayWith([
        { AttributeName: 'device_uid', KeyType: 'HASH' },
        { AttributeName: 'timestamp', KeyType: 'RANGE' },
      ]),
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('creates alerts table', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'songbird-alerts',
      KeySchema: [
        { AttributeName: 'alert_id', KeyType: 'HASH' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('creates settings table with composite key', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'songbird-settings',
      KeySchema: Match.arrayWith([
        { AttributeName: 'setting_type', KeyType: 'HASH' },
        { AttributeName: 'setting_id', KeyType: 'RANGE' },
      ]),
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('creates journeys table with composite key', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'songbird-journeys',
      KeySchema: Match.arrayWith([
        { AttributeName: 'device_uid', KeyType: 'HASH' },
        { AttributeName: 'journey_id', KeyType: 'RANGE' },
      ]),
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('creates locations table with composite key', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'songbird-locations',
      KeySchema: Match.arrayWith([
        { AttributeName: 'device_uid', KeyType: 'HASH' },
        { AttributeName: 'timestamp', KeyType: 'RANGE' },
      ]),
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('creates device aliases table', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'songbird-device-aliases',
      KeySchema: [
        { AttributeName: 'serial_number', KeyType: 'HASH' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('creates audit table', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'songbird-audit',
      KeySchema: [
        { AttributeName: 'audit_id', KeyType: 'HASH' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('enables TTL on telemetry, alerts, journeys, locations, and audit tables', () => {
    const ttlSpec = { TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } };

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'test-telemetry',
      ...ttlSpec,
    });
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'songbird-alerts',
      ...ttlSpec,
    });
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'songbird-journeys',
      ...ttlSpec,
    });
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'songbird-locations',
      ...ttlSpec,
    });
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'songbird-audit',
      ...ttlSpec,
    });
  });

  it('enables streams on devices, telemetry, alerts, journeys, and locations tables', () => {
    const streamSpec = { StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' } };

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'test-devices',
      ...streamSpec,
    });
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'test-telemetry',
      ...streamSpec,
    });
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'songbird-alerts',
      ...streamSpec,
    });
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'songbird-journeys',
      ...streamSpec,
    });
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'songbird-locations',
      ...streamSpec,
    });
  });

  it('enables PITR on devices table', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'test-devices',
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    });
  });

  it('devices table has fleet-index and status-index GSIs', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'test-devices',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'fleet-index',
          KeySchema: Match.arrayWith([
            { AttributeName: 'fleet', KeyType: 'HASH' },
            { AttributeName: 'last_seen', KeyType: 'RANGE' },
          ]),
        }),
        Match.objectLike({
          IndexName: 'status-index',
          KeySchema: Match.arrayWith([
            { AttributeName: 'status', KeyType: 'HASH' },
            { AttributeName: 'last_seen', KeyType: 'RANGE' },
          ]),
        }),
      ]),
    });
  });

  it('telemetry table has event-type-index GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'test-telemetry',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'event-type-index',
          KeySchema: Match.arrayWith([
            { AttributeName: 'device_uid', KeyType: 'HASH' },
            { AttributeName: 'event_type_timestamp', KeyType: 'RANGE' },
          ]),
        }),
      ]),
    });
  });

  it('alerts table has device-index and status-index GSIs', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'songbird-alerts',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'device-index',
          KeySchema: Match.arrayWith([
            { AttributeName: 'device_uid', KeyType: 'HASH' },
            { AttributeName: 'created_at', KeyType: 'RANGE' },
          ]),
        }),
        Match.objectLike({
          IndexName: 'status-index',
          KeySchema: Match.arrayWith([
            { AttributeName: 'acknowledged', KeyType: 'HASH' },
            { AttributeName: 'created_at', KeyType: 'RANGE' },
          ]),
        }),
      ]),
    });
  });

  it('device aliases table has device-uid-index GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'songbird-device-aliases',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'device-uid-index',
          KeySchema: Match.arrayWith([
            { AttributeName: 'device_uid', KeyType: 'HASH' },
          ]),
        }),
      ]),
    });
  });

  it('audit table has action-index and serial-number-index GSIs', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'songbird-audit',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'action-index',
          KeySchema: Match.arrayWith([
            { AttributeName: 'action', KeyType: 'HASH' },
            { AttributeName: 'timestamp', KeyType: 'RANGE' },
          ]),
        }),
        Match.objectLike({
          IndexName: 'serial-number-index',
          KeySchema: Match.arrayWith([
            { AttributeName: 'serial_number', KeyType: 'HASH' },
            { AttributeName: 'timestamp', KeyType: 'RANGE' },
          ]),
        }),
      ]),
    });
  });
});
