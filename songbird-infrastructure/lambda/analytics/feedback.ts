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
import { DynamoDBDocumentClient, UpdateCommand, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
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
 * Persist feedback by updating the original chat history record if it exists,
 * and also writing a dedicated feedback record that includes question/sql
 * for the admin review view (since UpdateCommand may not match on timestamp).
 */
async function recordFeedback(req: FeedbackRequest): Promise<void> {
  const ratedAt = Date.now();

  // Try to update the original chat history record
  try {
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
          rated_at: ratedAt,
        },
      },
    }));
  } catch (e) {
    console.warn('Could not update original chat record:', e);
  }

  // Always write a dedicated feedback record with question + sql included,
  // so the admin review view can always show the full context.
  const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
  await ddb.send(new PutCommand({
    TableName: CHAT_HISTORY_TABLE,
    Item: {
      user_email: `feedback#${req.userEmail}`,
      timestamp: ratedAt,
      question: req.question,
      sql: req.sql,
      visualization_type: req.visualizationType,
      feedback: {
        rating: req.rating,
        comment: req.comment || null,
        rated_at: ratedAt,
        original_user: req.userEmail,
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

/**
 * List negative feedback items across all users (admin use).
 * Scans the chat history table for items with feedback.rating = 'negative'.
 */
async function listNegativeFeedback(limit: number): Promise<APIGatewayProxyResult> {
  const result = await ddb.send(new ScanCommand({
    TableName: CHAT_HISTORY_TABLE,
    FilterExpression: 'begins_with(user_email, :prefix) AND attribute_exists(feedback)',
    ExpressionAttributeValues: { ':prefix': 'feedback#' },
  }));

  const items = (result.Items || [])
    .filter(item => item.feedback?.rating === 'negative')
    .map(item => ({
      userEmail: item.feedback?.original_user || item.user_email.replace('feedback#', ''),
      timestamp: item.timestamp,
      question: item.question,
      sql: item.sql,
      comment: item.feedback?.comment || null,
      ratedAt: item.feedback?.rated_at,
    }))
    .sort((a, b) => (b.ratedAt || 0) - (a.ratedAt || 0))
    .slice(0, limit);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ items, total: items.length }),
  };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = (event as any).requestContext?.http?.method || event.httpMethod;

  // GET /analytics/feedback — list negative feedback (admin)
  if (method === 'GET') {
    try {
      const limit = parseInt(event.queryStringParameters?.limit || '100');
      return await listNegativeFeedback(limit);
    } catch (error: any) {
      console.error('List feedback error:', error);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    }
  }

  // DELETE /analytics/feedback — delete a feedback record by userEmail + ratedAt timestamp
  if (method === 'DELETE') {
    try {
      const { userEmail, ratedAt } = JSON.parse(event.body || '{}');
      if (!userEmail || !ratedAt) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing userEmail or ratedAt' }) };
      }
      await ddb.send(new DeleteCommand({
        TableName: CHAT_HISTORY_TABLE,
        Key: {
          user_email: `feedback#${userEmail}`,
          timestamp: ratedAt,
        },
      }));
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
    } catch (error: any) {
      console.error('Delete feedback error:', error);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    }
  }

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
