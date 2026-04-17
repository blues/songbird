import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';

import { handler } from './get-session';

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
    path: '/analytics/sessions/abc123',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
    ...overrides,
  };
}

describe('get-session handler', () => {
  it('returns 400 when sessionId is missing', async () => {
    const result = await handler(makeEvent({
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: 'Missing sessionId parameter' });
  });

  it('returns 400 when userEmail is missing', async () => {
    const result = await handler(makeEvent({
      pathParameters: { sessionId: 'sess-1' },
    }));
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: 'Missing userEmail parameter' });
  });

  it('returns 404 when session has no items', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await handler(makeEvent({
      pathParameters: { sessionId: 'sess-1' },
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toEqual({ error: 'Session not found' });
  });

  it('returns 403 when session belongs to another user', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ user_email: 'bob@test.com', session_id: 'sess-1', timestamp: 1000 }],
    });

    const result = await handler(makeEvent({
      pathParameters: { sessionId: 'sess-1' },
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ error: "Cannot access another user's session" });
  });

  it('returns session messages on success', async () => {
    const items = [
      { user_email: 'alice@test.com', session_id: 'sess-1', timestamp: 1000, question: 'Q1' },
      { user_email: 'alice@test.com', session_id: 'sess-1', timestamp: 2000, question: 'Q2' },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const result = await handler(makeEvent({
      pathParameters: { sessionId: 'sess-1' },
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.sessionId).toBe('sess-1');
    expect(body.messages).toEqual(items);
    expect(body.total).toBe(2);
  });

  it('queries session-index GSI with ScanIndexForward true', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ user_email: 'alice@test.com', session_id: 'sess-1', timestamp: 1000 }],
    });

    await handler(makeEvent({
      pathParameters: { sessionId: 'sess-1' },
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.IndexName).toBe('session-index');
    expect(call.args[0].input.ScanIndexForward).toBe(true);
    expect(call.args[0].input.KeyConditionExpression).toBe('session_id = :sid');
  });

  it('returns 500 on DynamoDB error', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('Connection refused'));

    const result = await handler(makeEvent({
      pathParameters: { sessionId: 'sess-1' },
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ error: 'Connection refused' });
  });

  it('returns 404 when Items is undefined', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: undefined });

    const result = await handler(makeEvent({
      pathParameters: { sessionId: 'sess-1' },
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    expect(result.statusCode).toBe(404);
  });

  it('includes CORS headers', async () => {
    const result = await handler(makeEvent({
      pathParameters: { sessionId: 'sess-1' },
    }));
    expect(result.headers?.['Access-Control-Allow-Origin']).toBe('*');
  });
});
