import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';

import { handler } from './list-sessions';

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
    path: '/analytics/sessions',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
    ...overrides,
  };
}

describe('list-sessions handler', () => {
  it('returns 400 when userEmail is missing', async () => {
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: 'Missing userEmail parameter' });
  });

  it('returns session summaries grouped by session_id', async () => {
    const items = [
      { user_email: 'alice@test.com', timestamp: 3000, session_id: 'sess-1', question: 'Q3' },
      { user_email: 'alice@test.com', timestamp: 2000, session_id: 'sess-1', question: 'Q2' },
      { user_email: 'alice@test.com', timestamp: 1000, session_id: 'sess-1', question: 'Q1' },
      { user_email: 'alice@test.com', timestamp: 5000, session_id: 'sess-2', question: 'Q5' },
      { user_email: 'alice@test.com', timestamp: 4000, session_id: 'sess-2', question: 'Q4' },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const result = await handler(makeEvent({
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.sessions).toHaveLength(2);
    expect(body.total).toBe(2);

    // Most recent session first (sess-2 has lastTimestamp 5000)
    expect(body.sessions[0].sessionId).toBe('sess-2');
    expect(body.sessions[0].firstQuestion).toBe('Q4');
    expect(body.sessions[0].lastQuestion).toBe('Q5');
    expect(body.sessions[0].startTimestamp).toBe(4000);
    expect(body.sessions[0].lastTimestamp).toBe(5000);
    expect(body.sessions[0].messageCount).toBe(2);

    expect(body.sessions[1].sessionId).toBe('sess-1');
    expect(body.sessions[1].firstQuestion).toBe('Q1');
    expect(body.sessions[1].lastQuestion).toBe('Q3');
    expect(body.sessions[1].messageCount).toBe(3);
  });

  it('skips items with no session_id', async () => {
    const items = [
      { user_email: 'alice@test.com', timestamp: 2000, session_id: 'sess-1', question: 'Q1' },
      { user_email: 'alice@test.com', timestamp: 1000, question: 'orphan' }, // no session_id
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const result = await handler(makeEvent({
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    const body = JSON.parse(result.body);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].sessionId).toBe('sess-1');
  });

  it('uses default limit of 20', async () => {
    // Create 25 distinct sessions
    const items = Array.from({ length: 25 }, (_, i) => ({
      user_email: 'alice@test.com',
      timestamp: 1000 + i,
      session_id: `sess-${i}`,
      question: `Q${i}`,
    }));
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const result = await handler(makeEvent({
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    const body = JSON.parse(result.body);
    expect(body.sessions).toHaveLength(20);
    expect(body.total).toBe(25); // total before limit
  });

  it('respects custom limit parameter', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      user_email: 'alice@test.com',
      timestamp: 1000 + i,
      session_id: `sess-${i}`,
      question: `Q${i}`,
    }));
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const result = await handler(makeEvent({
      queryStringParameters: { userEmail: 'alice@test.com', limit: '3' },
    }));

    const body = JSON.parse(result.body);
    expect(body.sessions).toHaveLength(3);
  });

  it('sorts sessions by lastTimestamp descending', async () => {
    const items = [
      { user_email: 'a@t.com', timestamp: 100, session_id: 'old', question: 'Q1' },
      { user_email: 'a@t.com', timestamp: 9000, session_id: 'new', question: 'Q2' },
      { user_email: 'a@t.com', timestamp: 5000, session_id: 'mid', question: 'Q3' },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const result = await handler(makeEvent({
      queryStringParameters: { userEmail: 'a@t.com' },
    }));

    const body = JSON.parse(result.body);
    expect(body.sessions[0].sessionId).toBe('new');
    expect(body.sessions[1].sessionId).toBe('mid');
    expect(body.sessions[2].sessionId).toBe('old');
  });

  it('returns empty sessions when no items exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await handler(makeEvent({
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.sessions).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('queries with Limit 500 and ScanIndexForward false', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await handler(makeEvent({
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.Limit).toBe(500);
    expect(call.args[0].input.ScanIndexForward).toBe(false);
    expect(call.args[0].input.TableName).toBe('test-chat-history');
  });

  it('returns 500 on DynamoDB error', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('Service unavailable'));

    const result = await handler(makeEvent({
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ error: 'Service unavailable' });
  });

  it('handles items with undefined Items from DynamoDB', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: undefined });

    const result = await handler(makeEvent({
      queryStringParameters: { userEmail: 'alice@test.com' },
    }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.sessions).toEqual([]);
  });

  it('includes CORS headers', async () => {
    const result = await handler(makeEvent());
    expect(result.headers?.['Access-Control-Allow-Origin']).toBe('*');
  });
});
