/**
 * Delete Analytics Session Lambda
 *
 * Deletes all chat history items for a given session.
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

const CHAT_HISTORY_TABLE = process.env.CHAT_HISTORY_TABLE!;

interface ChatHistoryKey {
  user_email: string;
  timestamp: number;
}

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
    const queryResult = await ddb.send(new QueryCommand({
      TableName: CHAT_HISTORY_TABLE,
      IndexName: 'session-index',
      KeyConditionExpression: 'session_id = :sid',
      ExpressionAttributeValues: {
        ':sid': sessionId,
      },
      ProjectionExpression: 'user_email, #ts',
      ExpressionAttributeNames: {
        '#ts': 'timestamp',
      },
    }));

    const items = (queryResult.Items || []) as ChatHistoryKey[];

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
        body: JSON.stringify({ error: 'Cannot delete another user\'s session' }),
      };
    }

    // Delete items in batches of 25 (DynamoDB BatchWriteItem limit)
    const batchSize = 25;
    let deletedCount = 0;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);

      const deleteRequests = batch.map(item => ({
        DeleteRequest: {
          Key: {
            user_email: item.user_email,
            timestamp: item.timestamp,
          },
        },
      }));

      await ddb.send(new BatchWriteCommand({
        RequestItems: {
          [CHAT_HISTORY_TABLE]: deleteRequests,
        },
      }));

      deletedCount += batch.length;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: 'Session deleted successfully',
        deletedCount,
      }),
    };

  } catch (error: any) {
    console.error('Delete session error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: error.message || 'Internal server error',
      }),
    };
  }
};
