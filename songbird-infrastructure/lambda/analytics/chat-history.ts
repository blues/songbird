import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

const CHAT_HISTORY_TABLE = process.env.CHAT_HISTORY_TABLE!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const userEmail = event.queryStringParameters?.userEmail;
    const limit = parseInt(event.queryStringParameters?.limit || '50');

    if (!userEmail) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ error: 'Missing userEmail parameter' }),
      };
    }

    // Query chat history for user
    const result = await ddb.send(new QueryCommand({
      TableName: CHAT_HISTORY_TABLE,
      KeyConditionExpression: 'user_email = :email',
      ExpressionAttributeValues: {
        ':email': userEmail,
      },
      ScanIndexForward: false, // Most recent first
      Limit: limit,
    }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        history: result.Items || [],
        total: result.Count || 0,
      }),
    };

  } catch (error: any) {
    console.error('Chat history error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        error: error.message || 'Internal server error',
      }),
    };
  }
};
