/**
 * Get Analytics Session Lambda
 *
 * Returns all chat history items for a specific session.
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

const CHAT_HISTORY_TABLE = process.env.CHAT_HISTORY_TABLE!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  try {
    const sessionId = event.pathParameters?.sessionId;
    const userEmail = event.queryStringParameters?.userEmail;

    if (!sessionId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing sessionId parameter' }),
      };
    }

    if (!userEmail) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing userEmail parameter' }),
      };
    }

    // Query all items for this session using the GSI
    const result = await ddb.send(new QueryCommand({
      TableName: CHAT_HISTORY_TABLE,
      IndexName: 'session-index',
      KeyConditionExpression: 'session_id = :sid',
      ExpressionAttributeValues: {
        ':sid': sessionId,
      },
      ScanIndexForward: true, // Oldest first (chronological order)
    }));

    const items = result.Items || [];

    if (items.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Session not found' }),
      };
    }

    // Verify the session belongs to the requesting user
    const sessionUserEmail = items[0].user_email;
    if (sessionUserEmail !== userEmail) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: 'Cannot access another user\'s session' }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        sessionId,
        messages: items,
        total: items.length,
      }),
    };

  } catch (error: any) {
    console.error('Get session error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: error.message || 'Internal server error',
      }),
    };
  }
};
