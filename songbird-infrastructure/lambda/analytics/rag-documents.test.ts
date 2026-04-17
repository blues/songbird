import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { APIGatewayProxyEvent } from 'aws-lambda';

vi.mock('../shared/rag-retrieval', () => ({
  embedText: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
}));

const rdsMock = mockClient(RDSDataClient);
const lambdaMock = mockClient(LambdaClient);

const { handler } = await import('./rag-documents');

function makeEvent(overrides = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/analytics/rag-documents',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: { http: { method: 'GET', path: '/analytics/rag-documents' } } as any,
    resource: '',
    ...overrides,
  };
}

const DOC_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('analytics/rag-documents handler', () => {
  beforeEach(() => {
    rdsMock.reset();
    lambdaMock.reset();
  });

  // ─── POST /reseed ────────────────────────────────────────────────────

  it('POST /reseed invokes seed Lambda asynchronously', async () => {
    lambdaMock.on(InvokeCommand).resolves({});

    const result = await handler(makeEvent({
      httpMethod: 'POST',
      requestContext: { http: { method: 'POST', path: '/analytics/rag-documents/reseed' } },
    }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).message).toMatch(/Re-seed started/);

    const invokeCall = lambdaMock.commandCalls(InvokeCommand)[0];
    expect(invokeCall.args[0].input.InvocationType).toBe('Event');
    expect(invokeCall.args[0].input.FunctionName).toBe(process.env.SEED_LAMBDA_ARN);
  });

  // ─── GET (list) ──────────────────────────────────────────────────────

  it('GET lists all documents from Aurora', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({
      columnMetadata: [
        { name: 'id' }, { name: 'doc_type' }, { name: 'title' },
        { name: 'content' }, { name: 'metadata' }, { name: 'pinned' },
        { name: 'created_at' }, { name: 'updated_at' },
      ],
      records: [
        [
          { stringValue: DOC_UUID }, { stringValue: 'schema' }, { stringValue: 'Devices Table' },
          { stringValue: 'Schema content' }, { stringValue: '{"source":"seed"}' },
          { booleanValue: true }, { stringValue: '2025-01-01' }, { stringValue: '2025-01-02' },
        ],
      ],
    });

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0].doc_type).toBe('schema');
    expect(body.documents[0].pinned).toBe(true);
    expect(body.documents[0].metadata).toEqual({ source: 'seed' });
    expect(body.total).toBe(1);
  });

  it('GET with doc_type filter includes WHERE clause', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({
      columnMetadata: [{ name: 'id' }],
      records: [],
    });

    await handler(makeEvent({
      queryStringParameters: { doc_type: 'example' },
    }));

    const sql = rdsMock.commandCalls(ExecuteStatementCommand)[0].args[0].input.sql!;
    expect(sql).toMatch(/WHERE doc_type = 'example'/);
  });

  it('GET returns empty list when no documents', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({
      columnMetadata: [{ name: 'id' }],
      records: [],
    });

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).documents).toEqual([]);
  });

  // ─── POST (create) ──────────────────────────────────────────────────

  it('POST creates a document with embedding', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({
      columnMetadata: [
        { name: 'id' }, { name: 'doc_type' }, { name: 'title' },
        { name: 'content' }, { name: 'metadata' }, { name: 'created_at' }, { name: 'updated_at' },
      ],
      records: [[
        { stringValue: DOC_UUID }, { stringValue: 'example' }, { stringValue: 'Test doc' },
        { stringValue: 'content here' }, { stringValue: '{}' },
        { stringValue: '2025-01-01' }, { stringValue: '2025-01-01' },
      ]],
    });

    const result = await handler(makeEvent({
      httpMethod: 'POST',
      requestContext: { http: { method: 'POST', path: '/analytics/rag-documents' } },
      body: JSON.stringify({ doc_type: 'example', title: 'Test doc', content: 'content here' }),
    }));

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.document.doc_type).toBe('example');

    const sql = rdsMock.commandCalls(ExecuteStatementCommand)[0].args[0].input.sql!;
    expect(sql).toMatch(/INSERT INTO analytics\.rag_documents/);
  });

  it('POST returns 400 when doc_type is missing', async () => {
    const result = await handler(makeEvent({
      httpMethod: 'POST',
      requestContext: { http: { method: 'POST', path: '/analytics/rag-documents' } },
      body: JSON.stringify({ content: 'some content' }),
    }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/doc_type and content are required/);
  });

  it('POST returns 400 when content is missing', async () => {
    const result = await handler(makeEvent({
      httpMethod: 'POST',
      requestContext: { http: { method: 'POST', path: '/analytics/rag-documents' } },
      body: JSON.stringify({ doc_type: 'schema' }),
    }));

    expect(result.statusCode).toBe(400);
  });

  it('POST returns 400 for invalid doc_type', async () => {
    const result = await handler(makeEvent({
      httpMethod: 'POST',
      requestContext: { http: { method: 'POST', path: '/analytics/rag-documents' } },
      body: JSON.stringify({ doc_type: 'invalid', content: 'some content' }),
    }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/doc_type must be/);
  });

  // ─── PATCH /{id}/pin ─────────────────────────────────────────────────

  it('PATCH toggles pinned status', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({
      columnMetadata: [{ name: 'id' }, { name: 'pinned' }],
      records: [[{ stringValue: DOC_UUID }, { booleanValue: true }]],
    });

    const result = await handler(makeEvent({
      httpMethod: 'PATCH',
      requestContext: { http: { method: 'PATCH', path: `/analytics/rag-documents/${DOC_UUID}/pin` } },
      pathParameters: { id: DOC_UUID },
      body: JSON.stringify({ pinned: true }),
    }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ id: DOC_UUID, pinned: true });
  });

  it('PATCH returns 404 when document not found', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({ records: [] });

    const result = await handler(makeEvent({
      httpMethod: 'PATCH',
      requestContext: { http: { method: 'PATCH', path: `/analytics/rag-documents/${DOC_UUID}/pin` } },
      pathParameters: { id: DOC_UUID },
      body: JSON.stringify({ pinned: false }),
    }));

    expect(result.statusCode).toBe(404);
  });

  // ─── PUT /{id} ───────────────────────────────────────────────────────

  it('PUT updates a document with re-embedding', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({
      columnMetadata: [
        { name: 'id' }, { name: 'doc_type' }, { name: 'title' },
        { name: 'content' }, { name: 'metadata' }, { name: 'created_at' }, { name: 'updated_at' },
      ],
      records: [[
        { stringValue: DOC_UUID }, { stringValue: 'schema' }, { stringValue: 'Updated' },
        { stringValue: 'new content' }, { stringValue: '{}' },
        { stringValue: '2025-01-01' }, { stringValue: '2025-01-02' },
      ]],
    });

    const { embedText } = await import('../shared/rag-retrieval');

    const result = await handler(makeEvent({
      httpMethod: 'PUT',
      requestContext: { http: { method: 'PUT', path: `/analytics/rag-documents/${DOC_UUID}` } },
      pathParameters: { id: DOC_UUID },
      body: JSON.stringify({ title: 'Updated', content: 'new content' }),
    }));

    expect(result.statusCode).toBe(200);
    expect(embedText).toHaveBeenCalled();
    const sql = rdsMock.commandCalls(ExecuteStatementCommand)[0].args[0].input.sql!;
    expect(sql).toMatch(/UPDATE analytics\.rag_documents/);
  });

  it('PUT returns 400 when content is missing', async () => {
    const result = await handler(makeEvent({
      httpMethod: 'PUT',
      requestContext: { http: { method: 'PUT', path: `/analytics/rag-documents/${DOC_UUID}` } },
      pathParameters: { id: DOC_UUID },
      body: JSON.stringify({ title: 'No content' }),
    }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/content is required/);
  });

  // ─── DELETE /{id} ────────────────────────────────────────────────────

  it('DELETE removes a document by id', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({ numberOfRecordsUpdated: 1 });

    const result = await handler(makeEvent({
      httpMethod: 'DELETE',
      requestContext: { http: { method: 'DELETE', path: `/analytics/rag-documents/${DOC_UUID}` } },
      pathParameters: { id: DOC_UUID },
    }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).message).toBe('Document deleted');
  });

  it('DELETE returns 404 when document not found', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({ numberOfRecordsUpdated: 0 });

    const result = await handler(makeEvent({
      httpMethod: 'DELETE',
      requestContext: { http: { method: 'DELETE', path: `/analytics/rag-documents/${DOC_UUID}` } },
      pathParameters: { id: DOC_UUID },
    }));

    expect(result.statusCode).toBe(404);
  });

  // ─── 404 fallthrough ────────────────────────────────────────────────

  it('returns 404 for unknown routes', async () => {
    const result = await handler(makeEvent({
      httpMethod: 'OPTIONS',
      requestContext: { http: { method: 'OPTIONS', path: '/analytics/rag-documents' } },
    }));

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toBe('Not found');
  });
});
