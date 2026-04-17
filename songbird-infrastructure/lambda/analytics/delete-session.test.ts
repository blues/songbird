import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';

import { handler } from './delete-session';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'DELETE',
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

describe('delete-session handler', () => {
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
      Items: [{ user_email: 'bob@test.com', timestamp: 1000 }],
    });

    const result = await handler(makeEvent({
      pathParameters: { sessionId: 'sess-1' },
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ error: "Cannot delete another user's session" });
  });

  it('deletes items and returns deletedCount', async () => {
    const items = [
      { user_email: 'alice@test.com', timestamp: 1000 },
      { user_email: 'alice@test.com', timestamp: 2000 },
      { user_email: 'alice@test.com', timestamp: 3000 },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });
    ddbMock.on(BatchWriteCommand).resolves({});

    const result = await handler(makeEvent({
      pathParameters: { sessionId: 'sess-1' },
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.message).toBe('Session deleted successfully');
    expect(body.deletedCount).toBe(3);
  });

  it('sends correct delete requests to BatchWriteCommand', async () => {
    const items = [
      { user_email: 'alice@test.com', timestamp: 1000 },
      { user_email: 'alice@test.com', timestamp: 2000 },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });
    ddbMock.on(BatchWriteCommand).resolves({});

    await handler(makeEvent({
      pathParameters: { sessionId: 'sess-1' },
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    expect(batchCalls).toHaveLength(1);
    const requestItems = batchCalls[0].args[0].input.RequestItems!;
    const requests = requestItems['test-chat-history'];
    expect(requests).toHaveLength(2);
    expect(requests![0].DeleteRequest?.Key).toEqual({ user_email: 'alice@test.com', timestamp: 1000 });
    expect(requests![1].DeleteRequest?.Key).toEqual({ user_email: 'alice@test.com', timestamp: 2000 });
  });

  it('batches deletes in groups of 25', async () => {
    // Create 30 items to trigger 2 batches
    const items = Array.from({ length: 30 }, (_, i) => ({
      user_email: 'alice@test.com',
      timestamp: 1000 + i,
    }));
    ddbMock.on(QueryCommand).resolves({ Items: items });
    ddbMock.on(BatchWriteCommand).resolves({});

    const result = await handler(makeEvent({
      pathParameters: { sessionId: 'sess-1' },
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    const body = JSON.parse(result.body);
    expect(body.deletedCount).toBe(30);

    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    expect(batchCalls).toHaveLength(2);
    expect(batchCalls[0].args[0].input.RequestItems!['test-chat-history']).toHaveLength(25);
    expect(batchCalls[1].args[0].input.RequestItems!['test-chat-history']).toHaveLength(5);
  });

  it('queries session-index GSI with projection', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await handler(makeEvent({
      pathParameters: { sessionId: 'sess-1' },
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.IndexName).toBe('session-index');
    expect(call.args[0].input.ProjectionExpression).toBe('user_email, #ts');
    expect(call.args[0].input.ExpressionAttributeNames).toEqual({ '#ts': 'timestamp' });
  });

  it('returns 500 on DynamoDB error', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('Provisioned throughput exceeded'));

    const result = await handler(makeEvent({
      pathParameters: { sessionId: 'sess-1' },
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ error: 'Provisioned throughput exceeded' });
  });

  it('includes CORS headers', async () => {
    const result = await handler(makeEvent());
    expect(result.headers?.['Access-Control-Allow-Origin']).toBe('*');
  });
});
