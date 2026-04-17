/**
 * Tests for the Cognito Post-Confirmation Trigger Lambda
 *
 * Tests that newly confirmed users are added to the Viewer group,
 * non-signup triggers are skipped, and Cognito errors don't fail signup.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { PostConfirmationTriggerEvent, Context } from 'aws-lambda';

import { handler } from './index';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

beforeEach(() => {
  cognitoMock.reset();
});

function makeEvent(overrides: Partial<PostConfirmationTriggerEvent> = {}): PostConfirmationTriggerEvent {
  return {
    version: '1',
    region: 'us-east-1',
    userPoolId: 'us-east-1_TestPool',
    userName: 'testuser',
    callerContext: {
      awsSdkVersion: '3.0.0',
      clientId: 'test-client-id',
    },
    triggerSource: 'PostConfirmation_ConfirmSignUp',
    request: {
      userAttributes: {
        sub: 'test-sub-id',
        email: 'testuser@example.com',
        email_verified: 'true',
      },
    },
    response: {},
    ...overrides,
  } as PostConfirmationTriggerEvent;
}

const mockContext: Context = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: 'test',
  functionVersion: '1',
  invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789:function:test',
  memoryLimitInMB: '128',
  awsRequestId: 'test-request-id',
  logGroupName: 'test-log-group',
  logStreamName: 'test-log-stream',
  getRemainingTimeInMillis: () => 30000,
  done: vi.fn(),
  fail: vi.fn(),
  succeed: vi.fn(),
};

describe('PostConfirmation_ConfirmSignUp trigger', () => {
  it('adds user to Viewer group on ConfirmSignUp', async () => {
    cognitoMock.on(AdminAddUserToGroupCommand).resolves({});

    const event = makeEvent();
    const result = await handler(event, mockContext, vi.fn());

    // Should call AdminAddUserToGroupCommand
    const calls = cognitoMock.commandCalls(AdminAddUserToGroupCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      UserPoolId: 'us-east-1_TestPool',
      Username: 'testuser',
      GroupName: 'Viewer',
    });

    // Should return the event unchanged
    expect(result).toEqual(event);
  });

  it('returns the event object unchanged', async () => {
    cognitoMock.on(AdminAddUserToGroupCommand).resolves({});

    const event = makeEvent();
    const result = await handler(event, mockContext, vi.fn());

    expect(result).toBe(event);
  });
});

describe('other trigger sources', () => {
  it('skips PostConfirmation_ConfirmForgotPassword', async () => {
    const event = makeEvent({
      triggerSource: 'PostConfirmation_ConfirmForgotPassword' as any,
    });

    const result = await handler(event, mockContext, vi.fn());

    // Should NOT call AdminAddUserToGroupCommand
    expect(cognitoMock.commandCalls(AdminAddUserToGroupCommand)).toHaveLength(0);
    // Should still return the event
    expect(result).toEqual(event);
  });

  it('skips unknown trigger sources', async () => {
    const event = makeEvent({
      triggerSource: 'SomeOtherTrigger' as any,
    });

    const result = await handler(event, mockContext, vi.fn());

    expect(cognitoMock.commandCalls(AdminAddUserToGroupCommand)).toHaveLength(0);
    expect(result).toEqual(event);
  });
});

describe('error handling', () => {
  it('does not throw when Cognito group assignment fails', async () => {
    cognitoMock.on(AdminAddUserToGroupCommand).rejects(new Error('Cognito error'));

    const event = makeEvent();

    // Should not throw - signup should still succeed
    const result = await handler(event, mockContext, vi.fn());
    expect(result).toEqual(event);
  });

  it('does not throw when group does not exist', async () => {
    const resourceNotFoundError = new Error('Group does not exist');
    resourceNotFoundError.name = 'ResourceNotFoundException';
    cognitoMock.on(AdminAddUserToGroupCommand).rejects(resourceNotFoundError);

    const event = makeEvent();
    const result = await handler(event, mockContext, vi.fn());

    expect(result).toEqual(event);
  });
});
