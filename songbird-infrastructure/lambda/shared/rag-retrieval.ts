/**
 * RAG Retrieval Utility
 *
 * Embeds a question using Amazon Titan Text Embeddings v2 and performs
 * a vector similarity search against the analytics.rag_documents table
 * (pgvector on Aurora). Returns a formatted context string ready to
 * inject into the SQL-generation prompt.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { traceAsyncFn } from './tracing';

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });

export interface RetrievedDocument {
  title: string;
  content: string;
  doc_type: string;
  similarity: number;
}

/**
 * Generate an embedding vector for the given text using Amazon Titan Text
 * Embeddings v2 (1024 dimensions, default).
 */
export async function embedText(text: string): Promise<number[]> {
  const response = await bedrock.send(new InvokeModelCommand({
    modelId: 'amazon.titan-embed-text-v2:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({ inputText: text }),
  }));

  const body = JSON.parse(new TextDecoder().decode(response.body));
  const embedding = body.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error(`Titan embedding response unexpected shape: ${JSON.stringify(Object.keys(body))}`);
  }
  return embedding as number[];
}

/**
 * Retrieve the top-k most relevant documents for a given question.
 *
 * Uses pgvector cosine distance to find the closest embeddings in
 * analytics.rag_documents. Falls back to an empty array on error so
 * the caller can fall back to static context.
 */
export async function retrieveRelevantContext(
  question: string,
  rds: RDSDataClient,
  clusterArn: string,
  secretArn: string,
  databaseName: string,
  topK: number = 5
): Promise<RetrievedDocument[]> {
  return traceAsyncFn(
    'rag.retrieve',
    async (span) => {
      span.setAttribute('input.value', question);
      span.setAttribute('retrieval.top_k', topK);

      // 1. Embed the question
      const embedding = await embedText(question);
      const embeddingStr = `[${embedding.join(',')}]`;

      // 2a. Fetch pinned documents (always include, regardless of similarity)
      const pinnedResult = await rds.send(new ExecuteStatementCommand({
        resourceArn: clusterArn,
        secretArn,
        database: databaseName,
        sql: `SELECT title, content, doc_type FROM analytics.rag_documents WHERE pinned = TRUE ORDER BY doc_type, title`,
      }));

      const pinnedDocs: RetrievedDocument[] = (pinnedResult.records || []).map(record => ({
        title: record[0]?.stringValue || '',
        content: record[1]?.stringValue || '',
        doc_type: record[2]?.stringValue || '',
        similarity: 1.0, // treat as perfect match
      }));

      // 2b. Vector similarity search (exclude already-pinned docs)
      const pinnedTitles = pinnedDocs.map(d => `'${d.title.replace(/'/g, "''")}'`).join(',');
      const excludePinned = pinnedTitles.length > 0
        ? `AND title NOT IN (${pinnedTitles})`
        : '';

      const sql = `
        SELECT title, content, doc_type,
               1 - (embedding <=> '${embeddingStr}'::vector) AS similarity
        FROM analytics.rag_documents
        WHERE embedding IS NOT NULL
          AND pinned = FALSE
          ${excludePinned}
        ORDER BY embedding <=> '${embeddingStr}'::vector
        LIMIT ${topK}
      `;

      const result = await rds.send(new ExecuteStatementCommand({
        resourceArn: clusterArn,
        secretArn,
        database: databaseName,
        sql,
      }));

      const similarDocs: RetrievedDocument[] = (result.records || []).map(record => ({
        title: record[0]?.stringValue || '',
        content: record[1]?.stringValue || '',
        doc_type: record[2]?.stringValue || '',
        similarity: record[3]?.doubleValue ?? 0,
      }));

      // Pinned docs first, then similarity results
      const docs = [...pinnedDocs, ...similarDocs];

      // OpenInference RETRIEVER span attributes (indexed per document)
      docs.forEach((doc, i) => {
        span.setAttribute(`retrieval.documents.${i}.document.content`, doc.content);
        span.setAttribute(`retrieval.documents.${i}.document.id`, doc.title);
        span.setAttribute(`retrieval.documents.${i}.document.score`, doc.similarity);
        span.setAttribute(`retrieval.documents.${i}.document.metadata`, JSON.stringify({ doc_type: doc.doc_type }));
      });
      span.setAttribute('retrieval.result_count', docs.length);
      span.setAttribute('retrieval.pinned_count', pinnedDocs.length);
      span.setAttribute('output.value', `Retrieved ${docs.length} documents (${pinnedDocs.length} pinned)`);

      return docs;
    },
    { 'openinference.span.kind': 'RETRIEVER' }
  );
}

/**
 * Format retrieved documents into a context string for the SQL-generation
 * prompt. Groups documents by type for clarity.
 */
export function formatRetrievedContext(docs: RetrievedDocument[]): string {
  if (docs.length === 0) {
    return '';
  }

  const sections: string[] = [];

  const byType: Record<string, RetrievedDocument[]> = {};
  for (const doc of docs) {
    if (!byType[doc.doc_type]) byType[doc.doc_type] = [];
    byType[doc.doc_type].push(doc);
  }

  if (byType['schema']) {
    sections.push('**Relevant Schema:**');
    for (const doc of byType['schema']) {
      sections.push(doc.content);
    }
  }

  if (byType['example']) {
    sections.push('**Similar Query Examples:**');
    for (const doc of byType['example']) {
      sections.push(`${doc.title ? `*${doc.title}*\n` : ''}${doc.content}`);
    }
  }

  if (byType['domain']) {
    sections.push('**Domain Knowledge:**');
    for (const doc of byType['domain']) {
      sections.push(`${doc.title ? `*${doc.title}*: ` : ''}${doc.content}`);
    }
  }

  return sections.join('\n\n');
}
