import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';

import { handler } from './chat-history';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/analytics/chat-history',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
    ...overrides,
  };
}

describe('chat-history handler', () => {
  it('returns 400 when userEmail is missing', async () => {
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: 'Missing userEmail parameter' });
  });

  it('returns chat history for a valid userEmail', async () => {
    const items = [
      { user_email: 'alice@test.com', timestamp: 2000, question: 'second' },
      { user_email: 'alice@test.com', timestamp: 1000, question: 'first' },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items, Count: 2 });

    const result = await handler(makeEvent({
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.history).toEqual(items);
    expect(body.total).toBe(2);
  });

  it('uses default limit of 50 when not specified', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });

    await handler(makeEvent({
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.Limit).toBe(50);
  });

  it('respects custom limit parameter', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });

    await handler(makeEvent({
      queryStringParameters: { userEmail: 'alice@test.com', limit: '10' },
    }));

    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.Limit).toBe(10);
  });

  it('queries with ScanIndexForward false (most recent first)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });

    await handler(makeEvent({
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.ScanIndexForward).toBe(false);
  });

  it('queries the correct table with correct key condition', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });

    await handler(makeEvent({
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.TableName).toBe('test-chat-history');
    expect(call.args[0].input.KeyConditionExpression).toBe('user_email = :email');
    expect(call.args[0].input.ExpressionAttributeValues).toEqual({ ':email': 'alice@test.com' });
  });

  it('returns empty history when no items exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: undefined, Count: undefined });

    const result = await handler(makeEvent({
      queryStringParameters: { userEmail: 'nobody@test.com' },
    }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.history).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('returns 500 on DynamoDB error', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB timeout'));

    const result = await handler(makeEvent({
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ error: 'DynamoDB timeout' });
  });

  it('includes CORS headers in all responses', async () => {
    const result = await handler(makeEvent());
    expect(result.headers?.['Access-Control-Allow-Origin']).toBe('*');
    expect(result.headers?.['Content-Type']).toBe('application/json');
  });
});
