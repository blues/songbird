import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { ScheduledEvent } from 'aws-lambda';

const ddbMock = mockClient(DynamoDBDocumentClient);
const snsMock = mockClient(SNSClient);
const bedrockMock = mockClient(BedrockRuntimeClient);

const { handler } = await import('./daily-evaluation');

function makeScheduledEvent(): ScheduledEvent {
  return {
    version: '0',
    id: 'test-id',
    'detail-type': 'Scheduled Event',
    source: 'aws.events',
    account: '123456789',
    time: new Date().toISOString(),
    region: 'us-east-1',
    resources: [],
    detail: {},
  };
}

function makeQuery(overrides: Record<string, any> = {}) {
  return {
    user_email: 'user@example.com',
    timestamp: Date.now(),
    question: 'How many devices are online?',
    sql: 'SELECT count(*) FROM analytics.devices WHERE status = :deviceFilter LIMIT 10',
    insights: 'There are 5 devices online.',
    row_count: 1,
    execution_error: null,
    ...overrides,
  };
}

describe('analytics/daily-evaluation handler', () => {
  beforeEach(() => {
    ddbMock.reset();
    snsMock.reset();
    bedrockMock.reset();

    bedrockMock.on(InvokeModelCommand).resolves({
      body: new TextEncoder().encode(JSON.stringify({
        content: [{ text: '{"score": 4, "explanation": "good", "issues": []}' }],
      })),
    });
  });

  it('returns early when no queries found in last 24h', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [], LastEvaluatedKey: undefined });

    await handler(makeScheduledEvent());

    // No SNS publish when there are no queries
    expect(snsMock.commandCalls(PublishCommand).length).toBe(0);
  });

  it('handles paginated DynamoDB scan', async () => {
    ddbMock.on(ScanCommand)
      .resolvesOnce({
        Items: [makeQuery()],
        LastEvaluatedKey: { user_email: 'user@example.com', timestamp: 1000 },
      })
      .resolvesOnce({
        Items: [makeQuery({ question: 'Second query' })],
        LastEvaluatedKey: undefined,
      });

    snsMock.on(PublishCommand).resolves({});

    await handler(makeScheduledEvent());

    // Should have scanned twice (pagination)
    expect(ddbMock.commandCalls(ScanCommand).length).toBe(2);
    // Should publish report
    expect(snsMock.commandCalls(PublishCommand).length).toBe(1);
  });

  it('runs code-based evaluators on all queries with SQL', async () => {
    const queries = [
      makeQuery({ sql: 'SELECT count(*) FROM analytics.devices WHERE serial_number IN (\'s1\') LIMIT 10' }),
      makeQuery({ sql: 'SELECT temperature FROM analytics.telemetry WHERE serial_number IN (\'s1\') LIMIT 5' }),
    ];
    ddbMock.on(ScanCommand).resolves({ Items: queries });
    snsMock.on(PublishCommand).resolves({});

    await handler(makeScheduledEvent());

    const publishCall = snsMock.commandCalls(PublishCommand)[0];
    const message = publishCall.args[0].input.Message!;
    // Report should mention total queries
    expect(message).toContain('Total Queries: 2');
  });

  it('publishes report to SNS when REPORT_SNS_TOPIC is set', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [makeQuery()] });
    snsMock.on(PublishCommand).resolves({});

    await handler(makeScheduledEvent());

    expect(snsMock.commandCalls(PublishCommand).length).toBe(1);
    const publishCall = snsMock.commandCalls(PublishCommand)[0];
    expect(publishCall.args[0].input.TopicArn).toBe(process.env.REPORT_SNS_TOPIC);
    expect(publishCall.args[0].input.Subject).toMatch(/Analytics Evaluation Report/);
  });

  it('runs LLM-based evaluators on queries with sql, question, and insights', async () => {
    const query = makeQuery({
      question: 'Show device temperatures',
      sql: 'SELECT temperature FROM analytics.telemetry WHERE serial_number IN (\'s1\') LIMIT 10',
      insights: 'The average temperature is 22C.',
    });
    ddbMock.on(ScanCommand).resolves({ Items: [query] });
    snsMock.on(PublishCommand).resolves({});

    await handler(makeScheduledEvent());

    // Bedrock should be called for insight relevance + hallucination evaluators
    expect(bedrockMock.commandCalls(InvokeModelCommand).length).toBe(2);
  });

  it('skips LLM evaluation for queries missing sql, question, or insights', async () => {
    const queryNoInsights = makeQuery({ insights: undefined });
    ddbMock.on(ScanCommand).resolves({ Items: [queryNoInsights] });
    snsMock.on(PublishCommand).resolves({});

    await handler(makeScheduledEvent());

    // No Bedrock calls since query is missing insights
    expect(bedrockMock.commandCalls(InvokeModelCommand).length).toBe(0);
  });

  it('limits LLM sample to 20 queries', async () => {
    const queries = Array.from({ length: 30 }, (_, i) => makeQuery({ question: `Q${i}` }));
    ddbMock.on(ScanCommand).resolves({ Items: queries });
    snsMock.on(PublishCommand).resolves({});

    await handler(makeScheduledEvent());

    // 20 queries * 2 evaluators = 40 Bedrock calls
    expect(bedrockMock.commandCalls(InvokeModelCommand).length).toBe(40);
  });

  it('tracks syntax errors in the report', async () => {
    const badQuery = makeQuery({
      // Starts with INSERT - dangerous keyword; also no device filter, no LIMIT
      sql: 'INSERT INTO analytics.devices VALUES (1)',
    });
    ddbMock.on(ScanCommand).resolves({ Items: [badQuery] });
    snsMock.on(PublishCommand).resolves({});

    await handler(makeScheduledEvent());

    const publishCall = snsMock.commandCalls(PublishCommand)[0];
    const message = publishCall.args[0].input.Message!;
    expect(message).toContain('SQL Syntax Valid: 0.0%');
  });

  it('tracks execution errors in the report', async () => {
    const failedQuery = makeQuery({ execution_error: 'relation does not exist' });
    ddbMock.on(ScanCommand).resolves({ Items: [failedQuery] });
    snsMock.on(PublishCommand).resolves({});

    await handler(makeScheduledEvent());

    const publishCall = snsMock.commandCalls(PublishCommand)[0];
    const message = publishCall.args[0].input.Message!;
    expect(message).toContain('Execution Success: 0.0%');
  });

  it('handles LLM evaluation errors gracefully', async () => {
    bedrockMock.on(InvokeModelCommand).rejects(new Error('Bedrock timeout'));

    ddbMock.on(ScanCommand).resolves({ Items: [makeQuery()] });
    snsMock.on(PublishCommand).resolves({});

    // Should not throw
    await handler(makeScheduledEvent());

    const publishCall = snsMock.commandCalls(PublishCommand)[0];
    const message = publishCall.args[0].input.Message!;
    // LLM metrics should be 0 since all evaluations failed
    expect(message).toContain('0 queries sampled');
  });

  it('skips queries without sql for code-based evaluators', async () => {
    const noSqlQuery = makeQuery({ sql: undefined });
    const withSqlQuery = makeQuery({
      sql: 'SELECT count(*) FROM analytics.devices WHERE serial_number IN (\'s1\') LIMIT 10',
    });
    ddbMock.on(ScanCommand).resolves({ Items: [noSqlQuery, withSqlQuery] });
    snsMock.on(PublishCommand).resolves({});

    await handler(makeScheduledEvent());

    const publishCall = snsMock.commandCalls(PublishCommand)[0];
    const message = publishCall.args[0].input.Message!;
    // Total is 2 but only 1 has SQL, so 100% syntax valid (the one with SQL is valid)
    expect(message).toContain('Total Queries: 2');
    expect(message).toContain('SQL Syntax Valid: 50.0%');
  });

  it('includes complexity distribution in the report', async () => {
    const simpleQuery = makeQuery({
      sql: 'SELECT count(*) FROM analytics.devices WHERE serial_number IN (\'s1\') LIMIT 10',
    });
    const complexQuery = makeQuery({
      sql: 'WITH cte AS (SELECT * FROM analytics.devices) SELECT d.*, t.temperature FROM cte d JOIN analytics.telemetry t ON d.device_uid = t.device_uid JOIN analytics.locations l ON d.device_uid = l.device_uid WHERE d.serial_number IN (\'s1\') LIMIT 10',
    });
    ddbMock.on(ScanCommand).resolves({ Items: [simpleQuery, complexQuery] });
    snsMock.on(PublishCommand).resolves({});

    await handler(makeScheduledEvent());

    const publishCall = snsMock.commandCalls(PublishCommand)[0];
    const message = publishCall.args[0].input.Message!;
    expect(message).toMatch(/Simple: \d/);
    expect(message).toMatch(/Complex: \d/);
  });
});
