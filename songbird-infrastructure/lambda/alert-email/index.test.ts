/**
 * Tests for the Alert Email Lambda
 *
 * Tests SNS-triggered low battery alert processing including deduplication,
 * battery recovery handling, recipient lookup, and email sending via SES.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import type { SNSEvent } from 'aws-lambda';

import { handler } from './index';

const ddbMock = mockClient(DynamoDBDocumentClient);
const sesMock = mockClient(SESClient);

beforeEach(() => {
  ddbMock.reset();
  sesMock.reset();
  sesMock.on(SendEmailCommand).resolves({ MessageId: 'test-message-id' });
});

function makeSNSEvent(message: Record<string, any>): SNSEvent {
  return {
    Records: [
      {
        EventSource: 'aws:sns',
        EventVersion: '1.0',
        EventSubscriptionArn: 'arn:aws:sns:us-east-1:123456789:test:sub-id',
        Sns: {
          Type: 'Notification',
          MessageId: 'test-msg-id',
          TopicArn: 'arn:aws:sns:us-east-1:123456789:test',
          Subject: 'Alert',
          Message: JSON.stringify(message),
          Timestamp: new Date().toISOString(),
          SignatureVersion: '1',
          Signature: 'test',
          SigningCertUrl: 'https://test',
          UnsubscribeUrl: 'https://test',
          MessageAttributes: {},
        },
      },
    ],
  };
}

function makeAlertMessage(overrides: Record<string, any> = {}) {
  return {
    device_uid: 'dev:1234',
    serial_number: 'sb01',
    fleet: 'default',
    alert_type: 'low_battery',
    value: 2.8,
    message: 'Low battery detected',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe('alert type filtering', () => {
  it('skips non-low_battery alerts', async () => {
    const event = makeSNSEvent(makeAlertMessage({ alert_type: 'temp_high' }));

    await handler(event);

    // Should not query for device or send email
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it('processes low_battery alerts', async () => {
    // Device with low battery (no recovery)
    ddbMock.on(GetCommand).resolves({
      Item: { device_uid: 'dev:1234', serial_number: 'sb01', voltage: 2.8, assigned_to: 'owner@example.com' },
    });

    // No existing claim record (not a duplicate)
    ddbMock.on(GetCommand, {
      TableName: process.env.ALERTS_TABLE,
      Key: { alert_id: 'email_claim_dev:1234_low_battery' },
    }).resolves({ Item: undefined });

    // Claim succeeds
    ddbMock.on(PutCommand).resolves({});

    const event = makeSNSEvent(makeAlertMessage());
    await handler(event);

    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
  });
});

describe('deduplication', () => {
  it('skips when claim record already exists', async () => {
    // Device with low battery
    ddbMock.on(GetCommand, {
      TableName: process.env.DEVICES_TABLE,
    }).resolves({
      Item: { device_uid: 'dev:1234', voltage: 2.8 },
    });

    // Existing claim record found - duplicate
    ddbMock.on(GetCommand, {
      TableName: process.env.ALERTS_TABLE,
    }).resolves({
      Item: { alert_id: 'email_claim_dev:1234_low_battery', email_sent: true },
    });

    const event = makeSNSEvent(makeAlertMessage());
    await handler(event);

    // Should not send email
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it('skips when conditional PutCommand fails (race condition)', async () => {
    // Device with low battery
    ddbMock.on(GetCommand, {
      TableName: process.env.DEVICES_TABLE,
    }).resolves({
      Item: { device_uid: 'dev:1234', voltage: 2.8, assigned_to: 'owner@example.com' },
    });

    // No existing claim
    ddbMock.on(GetCommand, {
      TableName: process.env.ALERTS_TABLE,
    }).resolves({ Item: undefined });

    // Claim fails - another invocation got there first
    const conditionalError = new Error('ConditionalCheckFailedException');
    conditionalError.name = 'ConditionalCheckFailedException';
    ddbMock.on(PutCommand).rejectsOnce(conditionalError);

    const event = makeSNSEvent(makeAlertMessage());
    await handler(event);

    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });
});

describe('recipient lookup', () => {
  it('skips when no recipients (device has no owner)', async () => {
    // Device without assigned_to
    ddbMock.on(GetCommand, {
      TableName: process.env.DEVICES_TABLE,
    }).resolves({
      Item: { device_uid: 'dev:1234', voltage: 2.8 },
    });

    // No existing claim
    ddbMock.on(GetCommand, {
      TableName: process.env.ALERTS_TABLE,
    }).resolves({ Item: undefined });

    // Claim succeeds
    ddbMock.on(PutCommand).resolves({});
    // Cleanup delete after no recipients
    ddbMock.on(DeleteCommand).resolves({});

    const event = makeSNSEvent(makeAlertMessage());
    await handler(event);

    // Should not send email
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
    // Should clean up the claim
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
  });
});

describe('email sending', () => {
  it('sends email successfully to device owner', async () => {
    // Device lookup returns device with owner and low voltage
    ddbMock.on(GetCommand).resolves({
      Item: {
        device_uid: 'dev:1234',
        serial_number: 'sb01',
        name: 'My Songbird',
        voltage: 2.8,
        assigned_to: 'owner@example.com',
      },
    });

    // No existing claim (overridden for alerts table below)
    ddbMock.on(GetCommand, {
      TableName: process.env.ALERTS_TABLE,
    }).resolves({ Item: undefined });

    ddbMock.on(PutCommand).resolves({});

    const event = makeSNSEvent(makeAlertMessage());
    await handler(event);

    const sesCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sesCalls).toHaveLength(1);

    const emailInput = sesCalls[0].args[0].input;
    expect(emailInput.Source).toBe(process.env.SENDER_EMAIL);
    expect(emailInput.Destination?.ToAddresses).toContain('owner@example.com');
    expect(emailInput.Message?.Subject?.Data).toContain('Low Battery');
  });
});

describe('battery recovery', () => {
  it('handles battery recovery when voltage is above threshold', async () => {
    // Device has recovered (voltage >= 3.5)
    ddbMock.on(GetCommand, {
      TableName: process.env.DEVICES_TABLE,
    }).resolves({
      Item: {
        device_uid: 'dev:1234',
        serial_number: 'sb01',
        name: 'My Songbird',
        voltage: 3.8,
        assigned_to: 'owner@example.com',
      },
    });

    // Recent low battery alert exists
    ddbMock.on(QueryCommand).resolves({
      Items: [{ alert_id: 'alert_1', type: 'low_battery', email_sent: true }],
    });

    // No recovery email sent yet
    ddbMock.on(GetCommand, {
      TableName: process.env.ALERTS_TABLE,
    }).resolves({ Item: undefined });

    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});

    const event = makeSNSEvent(makeAlertMessage());
    await handler(event);

    const sesCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sesCalls).toHaveLength(1);
    expect(sesCalls[0].args[0].input.Message?.Subject?.Data).toContain('Battery Recovered');
  });

  it('skips recovery when no recent low battery alert was sent', async () => {
    // Device has recovered
    ddbMock.on(GetCommand, {
      TableName: process.env.DEVICES_TABLE,
    }).resolves({
      Item: { device_uid: 'dev:1234', voltage: 3.8 },
    });

    // No recent low battery alert
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    // No existing claim record
    ddbMock.on(GetCommand, {
      TableName: process.env.ALERTS_TABLE,
    }).resolves({ Item: undefined });

    const event = makeSNSEvent(makeAlertMessage());
    await handler(event);

    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });
});
