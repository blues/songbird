"use strict";
/**
 * Delete Analytics Session Lambda
 *
 * Deletes all chat history items for a given session.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const ddbClient = new client_dynamodb_1.DynamoDBClient({});
const ddb = lib_dynamodb_1.DynamoDBDocumentClient.from(ddbClient);
const CHAT_HISTORY_TABLE = process.env.CHAT_HISTORY_TABLE;
const handler = async (event) => {
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
        const queryResult = await ddb.send(new lib_dynamodb_1.QueryCommand({
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
        const items = (queryResult.Items || []);
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
            await ddb.send(new lib_dynamodb_1.BatchWriteCommand({
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
    }
    catch (error) {
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
exports.handler = handler;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGVsZXRlLXNlc3Npb24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYW5hbHl0aWNzL2RlbGV0ZS1zZXNzaW9uLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7OztHQUlHOzs7QUFHSCw4REFBMEQ7QUFDMUQsd0RBSStCO0FBRS9CLE1BQU0sU0FBUyxHQUFHLElBQUksZ0NBQWMsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN6QyxNQUFNLEdBQUcsR0FBRyxxQ0FBc0IsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7QUFFbkQsTUFBTSxrQkFBa0IsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGtCQUFtQixDQUFDO0FBT3BELE1BQU0sT0FBTyxHQUFHLEtBQUssRUFBRSxLQUEyQixFQUFrQyxFQUFFO0lBQzNGLE1BQU0sT0FBTyxHQUFHO1FBQ2QsY0FBYyxFQUFFLGtCQUFrQjtRQUNsQyw2QkFBNkIsRUFBRSxHQUFHO0tBQ25DLENBQUM7SUFFRixJQUFJLENBQUM7UUFDSCxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMsY0FBYyxFQUFFLFNBQVMsQ0FBQztRQUNsRCxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMscUJBQXFCLEVBQUUsU0FBUyxDQUFDO1FBRXpELElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQztZQUNmLE9BQU87Z0JBQ0wsVUFBVSxFQUFFLEdBQUc7Z0JBQ2YsT0FBTztnQkFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSw2QkFBNkIsRUFBRSxDQUFDO2FBQy9ELENBQUM7UUFDSixDQUFDO1FBRUQsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDO1lBQ2YsT0FBTztnQkFDTCxVQUFVLEVBQUUsR0FBRztnQkFDZixPQUFPO2dCQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsS0FBSyxFQUFFLDZCQUE2QixFQUFFLENBQUM7YUFDL0QsQ0FBQztR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Ii8qKlxuICogRGVsZXRlIEFuYWx5dGljcyBTZXNzaW9uIExhbWJkYVxuICpcbiAqIERlbGV0ZXMgYWxsIGNoYXQgaGlzdG9yeSBpdGVtcyBmb3IgYSBnaXZlbiBzZXNzaW9uLlxuICovXG5cbmltcG9ydCB7IEFQSUdhdGV3YXlQcm94eUV2ZW50LCBBUElHYXRld2F5UHJveHlSZXN1bHQgfSBmcm9tICdhd3MtbGFtYmRhJztcbmltcG9ydCB7IER5bmFtb0RCQ2xpZW50IH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LWR5bmFtb2RiJztcbmltcG9ydCB7XG4gIER5bmFtb0RCRG9jdW1lbnRDbGllbnQsXG4gIFF1ZXJ5Q29tbWFuZCxcbiAgQmF0Y2hXcml0ZUNvbW1hbmQsXG59IGZyb20gJ0Bhd3Mtc2RrL2xpYi1keW5hbW9kYic7XG5cbmNvbnN0IGRkYkNsaWVudCA9IG5ldyBEeW5hbW9EQkNsaWVudCh7fSk7XG5jb25zdCBkZGIgPSBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LmZyb20oZGRiQ2xpZW50KTtcblxuY29uc3QgQ0hBVF9ISVNUT1JZX1RBQkxFID0gcHJvY2Vzcy5lbnYuQ0hBVF9ISVNUT1JZX1RBQkxFITtcblxuaW50ZXJmYWNlIENoYXRIaXN0b3J5S2V5IHtcbiAgdXNlcl9lbWFpbDogc3RyaW5nO1xuICB0aW1lc3RhbXA6IG51bWJlcjtcbn1cblxuZXhwb3J0IGNvbnN0IGhhbmRsZXIgPSBhc3luYyAoZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50KTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+ID0+IHtcbiAgY29uc3QgaGVhZGVycyA9IHtcbiAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nOiAnKicsXG4gIH07XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBzZXNzaW9uSWQgPSBldmVudC5wYXRoUGFyYW1ldGVycz8uc2Vzc2lvbklkO1xuICAgIGNvbnN0IHVzZXJFbWFpbCA9IGV2ZW50LnF1ZXJ5U3RyaW5nUGFyYW1ldGVycz8udXNlckVtYWlsO1xuXG4gICAgaWYgKCFzZXNzaW9uSWQpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ01pc3Npbmcgc2Vzc2lvbklkIHBhcmFtZXRlcicgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIGlmICghdXNlckVtYWlsKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdNaXNzaW5nIHVzZXJFbWFpbCBwYXJhbWV0ZXInIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBRdWVyeSBhbGwgaXRlbXMgZm9yIHRoaXMgc2Vzc2lvbiB1c2luZyB0aGUgR1NJXG4gICAgY29uc3QgcXVlcnlSZXN1bHQgPSBhd2FpdCBkZGIuc2VuZChuZXcgUXVlcnlDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogQ0hBVF9ISVNUT1JZX1RBQkxFLFxuICAgICAgSW5kZXhOYW1lOiAnc2Vzc2lvbi1pbmRleCcsXG4gICAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnc2Vzc2lvbl9pZCA9IDpzaWQnLFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAnOnNpZCc6IHNlc3Npb25JZCxcbiAgICAgIH0sXG4gICAgICBQcm9qZWN0aW9uRXhwcmVzc2lvbjogJ3VzZXJfZW1haWwsICN0cycsXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICAgJyN0cyc6ICd0aW1lc3RhbXAnLFxuICAgICAgfSxcbiAgICB9KSk7XG5cbiAgICBjb25zdCBpdGVtcyA9IChxdWVyeVJlc3VsdC5JdGVtcyB8fCBbXSkgYXMgQ2hhdEhpc3RvcnlLZXlbXTtcblxuICAgIGlmIChpdGVtcy5sZW5ndGggPT09IDApIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwNCxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1Nlc3Npb24gbm90IGZvdW5kJyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gVmVyaWZ5IHRoZSBzZXNzaW9uIGJlbG9uZ3MgdG8gdGhlIHJlcXVlc3RpbmcgdXNlclxuICAgIGNvbnN0IHNlc3Npb25Vc2VyRW1haWwgPSBpdGVtc1swXS51c2VyX2VtYWlsO1xuICAgIGlmIChzZXNzaW9uVXNlckVtYWlsICE9PSB1c2VyRW1haWwpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwMyxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0Nhbm5vdCBkZWxldGUgYW5vdGhlciB1c2VyXFwncyBzZXNzaW9uJyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gRGVsZXRlIGl0ZW1zIGluIGJhdGNoZXMgb2YgMjUgKER5bmFtb0RCIEJhdGNoV3JpdGVJdGVtIGxpbWl0KVxuICAgIGNvbnN0IGJhdGNoU2l6ZSA9IDI1O1xuICAgIGxldCBkZWxldGVkQ291bnQgPSAwO1xuXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBpdGVtcy5sZW5ndGg7IGkgKz0gYmF0Y2hTaXplKSB7XG4gICAgICBjb25zdCBiYXRjaCA9IGl0ZW1zLnNsaWNlKGksIGkgKyBiYXRjaFNpemUpO1xuXG4gICAgICBjb25zdCBkZWxldGVSZXF1ZXN0cyA9IGJhdGNoLm1hcChpdGVtID0+ICh7XG4gICAgICAgIERlbGV0ZVJlcXVlc3Q6IHtcbiAgICAgICAgICBLZXk6IHtcbiAgICAgICAgICAgIHVzZXJfZW1haWw6IGl0ZW0udXNlcl9lbWFpbCxcbiAgICAgICAgICAgIHRpbWVzdGFtcDogaXRlbS50aW1lc3RhbXAsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0pKTtcblxuICAgICAgYXdhaXQgZGRiLnNlbmQobmV3IEJhdGNoV3JpdGVDb21tYW5kKHtcbiAgICAgICAgUmVxdWVzdEl0ZW1zOiB7XG4gICAgICAgICAgW0NIQVRfSElTVE9SWV9UQUJMRV06IGRlbGV0ZVJlcXVlc3RzLFxuICAgICAgICB9LFxuICAgICAgfSkpO1xuXG4gICAgICBkZWxldGVkQ291bnQgKz0gYmF0Y2gubGVuZ3RoO1xuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBtZXNzYWdlOiAnU2Vzc2lvbiBkZWxldGVkIHN1Y2Nlc3NmdWxseScsXG4gICAgICAgIGRlbGV0ZWRDb3VudCxcbiAgICAgIH0pLFxuICAgIH07XG5cbiAgfSBjYXRjaCAoZXJyb3I6IGFueSkge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0RlbGV0ZSBzZXNzaW9uIGVycm9yOicsIGVycm9yKTtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNTAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgZXJyb3I6IGVycm9yLm1lc3NhZ2UgfHwgJ0ludGVybmFsIHNlcnZlciBlcnJvcicsXG4gICAgICB9KSxcbiAgICB9O1xuICB9XG59O1xuIl19