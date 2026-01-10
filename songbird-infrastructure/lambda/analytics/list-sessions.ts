/**
 * List Analytics Sessions Lambda
 *
 * Returns a list of unique chat sessions for a user with metadata.
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

const CHAT_HISTORY_TABLE = process.env.CHAT_HISTORY_TABLE!;

interface ChatHistoryItem {
  user_email: string;
  timestamp: number;
  session_id: string;
  question: string;
  sql?: string;
  explanation?: string;
  visualization_type?: string;
  row_count?: number;
  insights?: string;
}

interface SessionSummary {
  sessionId: string;
  firstQuestion: string;
  lastQuestion: string;
  startTimestamp: number;
  lastTimestamp: number;
  messageCount: number;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  try {
    const userEmail = event.queryStringParameters?.userEmail;
    const limit = parseInt(event.queryStringParameters?.limit || '20');

    if (!userEmail) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing userEmail parameter' }),
      };
    }

    // Query all chat history for user (up to a reasonable limit for session aggregation)
    const result = await ddb.send(new QueryCommand({
      TableName: CHAT_HISTORY_TABLE,
      KeyConditionExpression: 'user_email = :email',
      ExpressionAttributeValues: {
        ':email': userEmail,
      },
      ScanIndexForward: false, // Most recent first
      Limit: 500, // Get enough items to aggregate into sessions
    }));

    const items = (result.Items || []) as ChatHistoryItem[];

    // Group by session_id
    const sessionMap = new Map<string, ChatHistoryItem[]>();
    for (const item of items) {
      const sessionId = item.session_id;
      if (!sessionMap.has(sessionId)) {
        sessionMap.set(sessionId, []);
      }
      sessionMap.get(sessionId)!.push(item);
    }

    // Build session summaries
    const sessions: SessionSummary[] = [];
    for (const [sessionId, sessionItems] of sessionMap.entries()) {
      // Sort by timestamp ascending to get first/last
      sessionItems.sort((a, b) => a.timestamp - b.timestamp);

      const first = sessionItems[0];
      const last = sessionItems[sessionItems.length - 1];

      sessions.push({
        sessionId,
        firstQuestion: first.question,
        lastQuestion: last.question,
        startTimestamp: first.timestamp,
        lastTimestamp: last.timestamp,
        messageCount: sessionItems.length,
      });
    }

    // Sort sessions by last activity (most recent first)
    sessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp);

    // Apply limit
    const limitedSessions = sessions.slice(0, limit);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        sessions: limitedSessions,
        total: sessions.length,
      }),
    };

  } catch (error: any) {
    console.error('List sessions error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: error.message || 'Internal server error',
      }),
    };
  }
};
