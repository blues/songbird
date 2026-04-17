import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, UpdateCommand, ScanCommand, DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { APIGatewayProxyEvent } from 'aws-lambda';

vi.mock('../shared/rag-retrieval', () => ({
  embedText: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
}));

const ddbMock = mockClient(DynamoDBDocumentClient);
const rdsMock = mockClient(RDSDataClient);

// Import handler after mocks are set up
const { handler } = await import('./feedback');

function makeEvent(overrides = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/analytics/feedback',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: { http: { method: 'POST', path: '/analytics/feedback' } } as any,
    resource: '',
    ...overrides,
  };
}

describe('analytics/feedback handler', () => {
  beforeEach(() => {
    ddbMock.reset();
    rdsMock.reset();
  });

  // ─── GET: listNegativeFeedback ───────────────────────────────────────

  it('GET returns negative feedback items sorted by ratedAt', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          user_email: 'feedback#alice@example.com',
          timestamp: 1000,
          question: 'What is the temperature?',
          sql: 'SELECT temperature FROM analytics.telemetry LIMIT 10',
          feedback: { rating: 'negative', comment: 'wrong answer', rated_at: 2000, original_user: 'alice@example.com' },
        },
        {
          user_email: 'feedback#bob@example.com',
          timestamp: 1100,
          question: 'How many devices?',
          sql: 'SELECT count(*) FROM analytics.devices LIMIT 1',
          feedback: { rating: 'negative', comment: null, rated_at: 3000, original_user: 'bob@example.com' },
        },
        {
          user_email: 'feedback#charlie@example.com',
          timestamp: 1200,
          question: 'Positive one',
          sql: 'SELECT 1',
          feedback: { rating: 'positive', rated_at: 2500 },
        },
      ],
    });

    const result = await handler(makeEvent({
      httpMethod: 'GET',
      requestContext: {
        http: { method: 'GET', path: '/analytics/feedback' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Admin' } } },
      },
    }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    // Only negative items returned, positive filtered out
    expect(body.total).toBe(2);
    // Sorted by ratedAt descending: bob (3000) before alice (2000)
    expect(body.items[0].userEmail).toBe('bob@example.com');
    expect(body.items[1].userEmail).toBe('alice@example.com');
  });

  it('GET returns empty list when no feedback exists', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const result = await handler(makeEvent({
      httpMethod: 'GET',
      requestContext: {
        http: { method: 'GET', path: '/analytics/feedback' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Admin' } } },
      },
    }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('GET respects limit query parameter', async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      user_email: `feedback#user${i}@example.com`,
      timestamp: 1000 + i,
      question: `Question ${i}`,
      sql: 'SELECT 1',
      feedback: { rating: 'negative' as const, comment: null, rated_at: 2000 + i, original_user: `user${i}@example.com` },
    }));
    ddbMock.on(ScanCommand).resolves({ Items: items });

    const result = await handler(makeEvent({
      httpMethod: 'GET',
      requestContext: {
        http: { method: 'GET', path: '/analytics/feedback' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Admin' } } },
      },
      queryStringParameters: { limit: '2' },
    }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.items.length).toBe(2);
  });

  it('GET returns 403 when caller is not in the Admin group', async () => {
    const result = await handler(makeEvent({
      httpMethod: 'GET',
      requestContext: {
        http: { method: 'GET', path: '/analytics/feedback' },
        authorizer: { jwt: { claims: { 'cognito:groups': 'Viewer' } } },
      },
    }));

    expect(result.statusCode).toBe(403);
  });

  // ─── DELETE ──────────────────────────────────────────────────────────

  it('DELETE removes feedback record by userEmail and ratedAt', async () => {
    ddbMock.on(DeleteCommand).resolves({});

    const result = await handler(makeEvent({
      httpMethod: 'DELETE',
      requestContext: { http: { method: 'DELETE', path: '/analytics/feedback' } },
      body: JSON.stringify({ userEmail: 'alice@example.com', ratedAt: 2000 }),
    }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ success: true });

    const deleteCall = ddbMock.commandCalls(DeleteCommand)[0];
    expect(deleteCall.args[0].input.Key).toEqual({
      user_email: 'feedback#alice@example.com',
      timestamp: 2000,
    });
  });

  it('DELETE returns 400 when userEmail is missing', async () => {
    const result = await handler(makeEvent({
      httpMethod: 'DELETE',
      requestContext: { http: { method: 'DELETE', path: '/analytics/feedback' } },
      body: JSON.stringify({ ratedAt: 2000 }),
    }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/Missing/);
  });

  it('DELETE returns 400 when ratedAt is missing', async () => {
    const result = await handler(makeEvent({
      httpMethod: 'DELETE',
      requestContext: { http: { method: 'DELETE', path: '/analytics/feedback' } },
      body: JSON.stringify({ userEmail: 'alice@example.com' }),
    }));

    expect(result.statusCode).toBe(400);
  });

  // ─── POST: submit feedback ──────────────────────────────────────────

  it('POST returns 400 when required fields are missing', async () => {
    const result = await handler(makeEvent({
      body: JSON.stringify({ userEmail: 'alice@example.com', rating: 'positive' }),
    }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/Missing required fields/);
  });

  it('POST returns 400 when rating is invalid', async () => {
    const result = await handler(makeEvent({
      body: JSON.stringify({
        userEmail: 'alice@example.com',
        timestamp: 1000,
        rating: 'neutral',
        question: 'How many?',
        sql: 'SELECT count(*) FROM analytics.devices LIMIT 1',
      }),
    }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/rating must be/);
  });

  it('POST with negative rating records feedback in DynamoDB only', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    const result = await handler(makeEvent({
      body: JSON.stringify({
        userEmail: 'alice@example.com',
        timestamp: 1000,
        rating: 'negative',
        question: 'How many devices?',
        sql: 'SELECT count(*) FROM analytics.devices LIMIT 1',
        comment: 'Wrong answer',
      }),
    }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.success).toBe(true);
    expect(body.indexed).toBe(false);

    // Should have called DynamoDB (UpdateCommand + PutCommand) but NOT RDS
    expect(ddbMock.commandCalls(UpdateCommand).length).toBe(1);
    expect(ddbMock.commandCalls(PutCommand).length).toBe(1);
    expect(rdsMock.commandCalls(ExecuteStatementCommand).length).toBe(0);
  });

  it('POST with positive rating records feedback and indexes in RDS', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    rdsMock.on(ExecuteStatementCommand).resolves({});

    const result = await handler(makeEvent({
      body: JSON.stringify({
        userEmail: 'alice@example.com',
        timestamp: 1000,
        rating: 'positive',
        question: 'How many devices?',
        sql: 'SELECT count(*) FROM analytics.devices LIMIT 1',
        visualizationType: 'bar_chart',
      }),
    }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.success).toBe(true);
    expect(body.indexed).toBe(true);

    // DynamoDB: UpdateCommand + PutCommand
    expect(ddbMock.commandCalls(UpdateCommand).length).toBe(1);
    expect(ddbMock.commandCalls(PutCommand).length).toBe(1);

    // RDS: DELETE then INSERT (indexPositiveFeedback)
    const rdsCalls = rdsMock.commandCalls(ExecuteStatementCommand);
    expect(rdsCalls.length).toBe(2);
    expect(rdsCalls[0].args[0].input.sql).toMatch(/DELETE FROM analytics\.rag_documents/);
    expect(rdsCalls[1].args[0].input.sql).toMatch(/INSERT INTO analytics\.rag_documents/);
  });

  it('POST with positive rating embeds content via embedText', async () => {
    const { embedText } = await import('../shared/rag-retrieval');
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    rdsMock.on(ExecuteStatementCommand).resolves({});

    await handler(makeEvent({
      body: JSON.stringify({
        userEmail: 'alice@example.com',
        timestamp: 1000,
        rating: 'positive',
        question: 'How many devices?',
        sql: 'SELECT count(*) FROM analytics.devices LIMIT 1',
      }),
    }));

    expect(embedText).toHaveBeenCalled();
  });

  it('POST records dedicated feedback record with feedback# prefix', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    await handler(makeEvent({
      body: JSON.stringify({
        userEmail: 'alice@example.com',
        timestamp: 1000,
        rating: 'negative',
        question: 'How many devices?',
        sql: 'SELECT count(*) FROM analytics.devices LIMIT 1',
      }),
    }));

    const putCall = ddbMock.commandCalls(PutCommand)[0];
    const item = putCall.args[0].input.Item;
    expect(item!.user_email).toMatch(/^feedback#alice@example\.com$/);
    expect(item!.question).toBe('How many devices?');
    expect(item!.feedback.rating).toBe('negative');
  });

  it('POST returns 500 when PutCommand fails', async () => {
    // UpdateCommand failure is caught with console.warn, so we need PutCommand to fail
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB failure'));

    const result = await handler(makeEvent({
      body: JSON.stringify({
        userEmail: 'alice@example.com',
        timestamp: 1000,
        rating: 'negative',
        question: 'Q?',
        sql: 'SELECT 1',
      }),
    }));

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error).toBe('DynamoDB failure');
  });
});
