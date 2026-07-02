/**
 * Tests for chat-query identity handling (finding H1).
 *
 * The handler must derive the user identity from the verified JWT claims and
 * must never trust a client-supplied `userEmail` or `deviceSerialNumbers`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock all heavy AWS / tracing deps before importing the handler ---------

const scanMock = vi.fn();
const putMock = vi.fn();

vi.mock('../shared/tracing', () => ({
  initializeTracing: vi.fn(),
  // Run the traced fn immediately so the pipeline executes in tests.
  traceAsyncFn: vi.fn(async (_name: string, fn: any) => fn({ setAttribute: vi.fn() })),
  flushSpans: vi.fn(async () => {}),
}));

vi.mock('@opentelemetry/api', () => ({
  SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2 },
}));

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class { send = vi.fn(); },
  InvokeModelCommand: class {},
}));

vi.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: class { send = vi.fn(); },
  ExecuteStatementCommand: class {},
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {},
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: (cmd: any) => cmd.__put ? putMock(cmd) : scanMock(cmd) }) },
  ScanCommand: class { constructor(public input: any) {} },
  PutCommand: class { __put = true; constructor(public input: any) {} },
}));

// Minimal env so module-level `!` assertions don't blow up.
process.env.CLUSTER_ARN = 'arn:cluster';
process.env.SECRET_ARN = 'arn:secret';
process.env.DATABASE_NAME = 'analytics';
process.env.CHAT_HISTORY_TABLE = 'songbird-chat-history';
process.env.BEDROCK_MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0';
process.env.DEVICES_TABLE = 'songbird-devices';

function makeEvent(email: string | undefined, body: any) {
  return {
    body: JSON.stringify(body),
    requestContext: email
      ? { authorizer: { jwt: { claims: { email } } } }
      : { authorizer: { jwt: { claims: {} } } },
  } as any;
}

describe('chat-query handler — H1 identity trust', () => {
  beforeEach(() => {
    scanMock.mockReset();
    putMock.mockReset();
  });

  it('returns 401 when no verified email claim is present', async () => {
    const { handler } = await import('./chat-query');
    const res = await handler(
      makeEvent(undefined, { question: 'q', sessionId: 's', userEmail: 'attacker@evil.com' })
    );
    expect(res.statusCode).toBe(401);
    // The devices table must never be scanned on an unauthenticated request.
    expect(scanMock).not.toHaveBeenCalled();
  });

  it('ignores client-supplied userEmail and resolves serials from the JWT email', async () => {
    // No devices assigned to the verified user -> 403, but the scan must use
    // the JWT email, NOT the attacker-supplied one.
    scanMock.mockResolvedValueOnce({ Items: [] });

    const { handler } = await import('./chat-query');
    const res = await handler(
      makeEvent('real.user@example.com', {
        question: 'show my data',
        sessionId: 'sess-1',
        userEmail: 'attacker@evil.com',
        deviceSerialNumbers: ['SN-NOT-MINE-1', 'SN-NOT-MINE-2'],
      })
    );

    // Access denied because the *verified* user has no assigned devices.
    expect(res.statusCode).toBe(403);

    // The server-side scan used the JWT email, not the injected body value.
    expect(scanMock).toHaveBeenCalledTimes(1);
    const scanInput = scanMock.mock.calls[0][0].input;
    expect(scanInput.ExpressionAttributeValues[':email']).toBe('real.user@example.com');
    expect(JSON.stringify(scanInput.ExpressionAttributeValues)).not.toContain('attacker@evil.com');
  });
});
