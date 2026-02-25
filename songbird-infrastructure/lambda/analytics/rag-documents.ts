/**
 * RAG Documents CRUD Lambda
 *
 * Handles list, create, update, delete, and reseed operations for
 * the analytics.rag_documents vector store. Embedding is generated
 * server-side using Amazon Titan Text Embeddings v2.
 *
 * Routes:
 *   GET    /analytics/rag-documents          → list all documents
 *   POST   /analytics/rag-documents          → create + embed
 *   PUT    /analytics/rag-documents/{id}     → update + re-embed
 *   DELETE /analytics/rag-documents/{id}     → delete by id
 *   POST   /analytics/rag-documents/reseed   → invoke seed Lambda
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { embedText } from '../shared/rag-retrieval';

const rds = new RDSDataClient({});
const lambdaClient = new LambdaClient({});

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const SECRET_ARN = process.env.SECRET_ARN!;
const DATABASE_NAME = process.env.DATABASE_NAME!;
const SEED_LAMBDA_ARN = process.env.SEED_LAMBDA_ARN!;

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

function ok(body: unknown): APIGatewayProxyResult {
  return { statusCode: 200, headers: CORS, body: JSON.stringify(body) };
}

function created(body: unknown): APIGatewayProxyResult {
  return { statusCode: 201, headers: CORS, body: JSON.stringify(body) };
}

function err(statusCode: number, message: string): APIGatewayProxyResult {
  return { statusCode, headers: CORS, body: JSON.stringify({ error: message }) };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function listDocuments(docType?: string) {
  const typeFilter = docType ? `WHERE doc_type = '${docType.replace(/'/g, "''")}'` : '';
  const sql = `
    SELECT id, doc_type, title, content, metadata, pinned, created_at, updated_at
    FROM analytics.rag_documents
    ${typeFilter}
    ORDER BY pinned DESC, doc_type, title
  `;

  const result = await rds.send(new ExecuteStatementCommand({
    resourceArn: CLUSTER_ARN,
    secretArn: SECRET_ARN,
    database: DATABASE_NAME,
    sql,
    includeResultMetadata: true,
  }));

  const cols = (result.columnMetadata || []).map(c => c.name!);
  const docs = (result.records || []).map(record => {
    const row: any = {};
    record.forEach((field, i) => {
      const col = cols[i];
      if (field.booleanValue !== undefined) row[col] = field.booleanValue;
      else if (field.stringValue !== undefined) row[col] = field.stringValue;
      else if (field.isNull) row[col] = null;
      else row[col] = null;
    });
    // Parse metadata JSON
    if (row.metadata && typeof row.metadata === 'string') {
      try { row.metadata = JSON.parse(row.metadata); } catch { /* keep as string */ }
    }
    return row;
  });

  return ok({ documents: docs, total: docs.length });
}

async function createDocument(body: any) {
  const { doc_type, title, content, metadata } = body;
  if (!doc_type || !content) return err(400, 'doc_type and content are required');
  if (!['schema', 'example', 'domain'].includes(doc_type)) {
    return err(400, 'doc_type must be schema, example, or domain');
  }

  const embedding = await embedText(content);
  const embeddingStr = `[${embedding.join(',')}]`;
  const titleEscaped = (title || '').replace(/'/g, "''");
  const contentEscaped = content.replace(/'/g, "''");
  const metadataStr = metadata ? JSON.stringify(metadata).replace(/'/g, "''") : '{}';

  const sql = `
    INSERT INTO analytics.rag_documents (doc_type, title, content, embedding, metadata)
    VALUES (
      '${doc_type}',
      ${title ? `'${titleEscaped}'` : 'NULL'},
      '${contentEscaped}',
      '${embeddingStr}'::vector,
      '${metadataStr}'::jsonb
    )
    RETURNING id, doc_type, title, content, metadata, created_at, updated_at
  `;

  const result = await rds.send(new ExecuteStatementCommand({
    resourceArn: CLUSTER_ARN,
    secretArn: SECRET_ARN,
    database: DATABASE_NAME,
    sql,
    includeResultMetadata: true,
  }));

  const cols = (result.columnMetadata || []).map(c => c.name!);
  const record = result.records?.[0];
  if (!record) return err(500, 'Insert failed');

  const doc: any = {};
  record.forEach((field, i) => {
    doc[cols[i]] = field.stringValue ?? null;
  });

  return created({ document: doc });
}

async function updateDocument(id: string, body: any) {
  const { title, content } = body;
  if (!content) return err(400, 'content is required');

  const embedding = await embedText(content);
  const embeddingStr = `[${embedding.join(',')}]`;
  const titleEscaped = (title || '').replace(/'/g, "''");
  const contentEscaped = content.replace(/'/g, "''");
  const idEscaped = id.replace(/'/g, "''");

  const titleClause = title !== undefined
    ? `title = '${titleEscaped}',`
    : '';

  const sql = `
    UPDATE analytics.rag_documents
    SET ${titleClause}
        content = '${contentEscaped}',
        embedding = '${embeddingStr}'::vector,
        updated_at = NOW()
    WHERE id = '${idEscaped}'::uuid
    RETURNING id, doc_type, title, content, metadata, created_at, updated_at
  `;

  const result = await rds.send(new ExecuteStatementCommand({
    resourceArn: CLUSTER_ARN,
    secretArn: SECRET_ARN,
    database: DATABASE_NAME,
    sql,
    includeResultMetadata: true,
  }));

  if (!result.records?.length) return err(404, 'Document not found');

  const cols = (result.columnMetadata || []).map(c => c.name!);
  const doc: any = {};
  result.records[0].forEach((field, i) => {
    doc[cols[i]] = field.stringValue ?? null;
  });

  return ok({ document: doc });
}

async function deleteDocument(id: string) {
  const idEscaped = id.replace(/'/g, "''");

  const result = await rds.send(new ExecuteStatementCommand({
    resourceArn: CLUSTER_ARN,
    secretArn: SECRET_ARN,
    database: DATABASE_NAME,
    sql: `DELETE FROM analytics.rag_documents WHERE id = '${idEscaped}'::uuid`,
  }));

  if (result.numberOfRecordsUpdated === 0) return err(404, 'Document not found');
  return ok({ message: 'Document deleted' });
}

async function togglePin(id: string, pinned: boolean) {
  const idEscaped = id.replace(/'/g, "''");

  const result = await rds.send(new ExecuteStatementCommand({
    resourceArn: CLUSTER_ARN,
    secretArn: SECRET_ARN,
    database: DATABASE_NAME,
    sql: `
      UPDATE analytics.rag_documents
      SET pinned = ${pinned ? 'TRUE' : 'FALSE'}, updated_at = NOW()
      WHERE id = '${idEscaped}'::uuid
      RETURNING id, pinned
    `,
    includeResultMetadata: true,
  }));

  if (!result.records?.length) return err(404, 'Document not found');
  return ok({ id, pinned });
}

async function reseedDocuments() {
  // Invoke seed Lambda asynchronously (fire-and-forget)
  await lambdaClient.send(new InvokeCommand({
    FunctionName: SEED_LAMBDA_ARN,
    InvocationType: 'Event', // async
  }));

  return ok({ message: 'Re-seed started. Built-in documents will be refreshed in ~30 seconds.' });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // HTTP API Gateway v2 uses requestContext.http.method; REST API uses httpMethod
  const method = (event as any).requestContext?.http?.method || event.httpMethod;
  const path = (event as any).requestContext?.http?.path || event.path;
  const id = event.pathParameters?.id;

  try {
    // POST /analytics/rag-documents/reseed
    if (method === 'POST' && path.endsWith('/reseed')) {
      return await reseedDocuments();
    }

    // GET /analytics/rag-documents
    if (method === 'GET' && !id) {
      const docType = event.queryStringParameters?.doc_type;
      return await listDocuments(docType);
    }

    // POST /analytics/rag-documents
    if (method === 'POST' && !id) {
      const body = JSON.parse(event.body || '{}');
      return await createDocument(body);
    }

    // PATCH /analytics/rag-documents/{id}/pin
    if (method === 'PATCH' && id && path.endsWith('/pin')) {
      const body = JSON.parse(event.body || '{}');
      return await togglePin(id, !!body.pinned);
    }

    // PUT /analytics/rag-documents/{id}
    if (method === 'PUT' && id) {
      const body = JSON.parse(event.body || '{}');
      return await updateDocument(id, body);
    }

    // DELETE /analytics/rag-documents/{id}
    if (method === 'DELETE' && id) {
      return await deleteDocument(id);
    }

    return err(404, 'Not found');
  } catch (error: any) {
    console.error('RAG documents error:', error);
    return err(500, error.message || 'Internal server error');
  }
};
