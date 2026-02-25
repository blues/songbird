/**
 * Analytics Feedback Lambda
 *
 * Records thumbs up / thumbs down feedback on chat query results.
 *
 * On positive feedback: upserts the Q→SQL pair as an 'example' document
 * in analytics.rag_documents (with embedding) so future similar questions
 * benefit from the validated query.
 *
 * On negative feedback: records the feedback in DynamoDB only.
 *
 * POST /analytics/feedback
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { embedText } from '../shared/rag-retrieval';

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);
const rds = new RDSDataClient({});

const CHAT_HISTORY_TABLE = process.env.CHAT_HISTORY_TABLE!;
const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const SECRET_ARN = process.env.SECRET_ARN!;
const DATABASE_NAME = process.env.DATABASE_NAME!;

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

interface FeedbackRequest {
  userEmail: string;
  timestamp: number;       // DynamoDB sort key — identifies the chat record
  rating: 'positive' | 'negative';
  question: string;
  sql: string;
  visualizationType?: string;
  comment?: string;        // optional, negative feedback only
}

/**
 * Persist feedback rating on the DynamoDB chat history record.
 */
async function recordFeedback(req: FeedbackRequest): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: CHAT_HISTORY_TABLE,
    Key: {
      user_email: req.userEmail,
      timestamp: req.timestamp,
    },
    UpdateExpression: 'SET feedback = :f',
    ExpressionAttributeValues: {
      ':f': {
        rating: req.rating,
        comment: req.comment || null,
        rated_at: Date.now(),
      },
    },
  }));
}

/**
 * Format a Q→SQL pair as a RAG example document (matches seed format).
 */
function formatExample(question: string, sql: string, visualizationType?: string): string {
  const viz = visualizationType ? `\nVisualization: ${visualizationType}` : '';
  return `Q: "${question}"\nSQL:\n\`\`\`sql\n${sql}\n\`\`\`${viz}`;
}

/**
 * Upsert the Q→SQL pair into rag_documents as an 'example' document.
 * Title is truncated to 80 chars and prefixed with "User example: " to
 * make user-generated examples visually distinct in the Context Manager.
 */
async function indexPositiveFeedback(req: FeedbackRequest): Promise<void> {
  const title = `User example: ${req.question.slice(0, 80)}${req.question.length > 80 ? '...' : ''}`;
  const content = formatExample(req.question, req.sql, req.visualizationType);
  const metadata = JSON.stringify({
    source: 'user_feedback',
    rated_by: req.userEmail,
    rated_at: String(req.timestamp),
  });

  // Embed the content
  const embedding = await embedText(content);
  const embeddingStr = `[${embedding.join(',')}]`;

  const titleEscaped = title.replace(/'/g, "''");
  const contentEscaped = content.replace(/'/g, "''");
  const metadataEscaped = metadata.replace(/'/g, "''");

  // Delete existing by title then insert (upsert pattern)
  await rds.send(new ExecuteStatementCommand({
    resourceArn: CLUSTER_ARN,
    secretArn: SECRET_ARN,
    database: DATABASE_NAME,
    sql: `DELETE FROM analytics.rag_documents WHERE title = '${titleEscaped}'`,
  }));

  await rds.send(new ExecuteStatementCommand({
    resourceArn: CLUSTER_ARN,
    secretArn: SECRET_ARN,
    database: DATABASE_NAME,
    sql: `
      INSERT INTO analytics.rag_documents (doc_type, title, content, embedding, metadata, pinned)
      VALUES (
        'example',
        '${titleEscaped}',
        '${contentEscaped}',
        '${embeddingStr}'::vector,
        '${metadataEscaped}'::jsonb,
        FALSE
      )
    `,
  }));

  console.log(`Indexed positive feedback example: "${title}"`);
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const req: FeedbackRequest = JSON.parse(event.body || '{}');

    if (!req.userEmail || !req.timestamp || !req.rating || !req.question || !req.sql) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: 'Missing required fields: userEmail, timestamp, rating, question, sql' }),
      };
    }

    if (req.rating !== 'positive' && req.rating !== 'negative') {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: 'rating must be "positive" or "negative"' }),
      };
    }

    // Always record feedback in DynamoDB
    await recordFeedback(req);

    // On positive feedback, also index the Q→SQL pair into RAG
    if (req.rating === 'positive') {
      await indexPositiveFeedback(req);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, indexed: req.rating === 'positive' }),
    };

  } catch (error: any) {
    console.error('Feedback error:', error);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: error.message || 'Internal server error' }),
    };
  }
};
