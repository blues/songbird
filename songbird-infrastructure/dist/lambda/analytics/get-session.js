"use strict";
/**
 * Get Analytics Session Lambda
 *
 * Returns all chat history items for a specific session.
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
        const result = await ddb.send(new lib_dynamodb_1.QueryCommand({
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
    }
    catch (error) {
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
exports.handler = handler;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2V0LXNlc3Npb24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYW5hbHl0aWNzL2dldC1zZXNzaW9uLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7OztHQUlHOzs7QUFHSCw4REFBMEQ7QUFDMUQsd0RBQTZFO0FBRTdFLE1BQU0sU0FBUyxHQUFHLElBQUksZ0NBQWMsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN6QyxNQUFNLEdBQUcsR0FBRyxxQ0FBc0IsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7QUFFbkQsTUFBTSxrQkFBa0IsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGtCQUFtQixDQUFDO0FBRXBELE1BQU0sT0FBTyxHQUFHLEtBQUssRUFBRSxLQUEyQixFQUFrQyxFQUFFO0lBQzNGLE1BQU0sT0FBTyxHQUFHO1FBQ2QsY0FBYyxFQUFFLGtCQUFrQjtRQUNsQyw2QkFBNkIsRUFBRSxHQUFHO0tBQ25DLENBQUM7SUFFRixJQUFJLENBQUM7UUFDSCxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMsY0FBYyxFQUFFLFNBQVMsQ0FBQztRQUNsRCxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMscUJBQXFCLEVBQUUsU0FBUyxDQUFDO1FBRXpELElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQztZQUNmLE9BQU87Z0JBQ0wsVUFBVSxFQUFFLEdBQUc7Z0JBQ2YsT0FBTztnQkFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSw2QkFBNkIsRUFBRSxDQUFDO2FBQy9ELENBQUM7UUFDSixDQUFDO1FBRUQsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDO1lBQ2YsT0FBTztnQkFDTCxVQUFVLEVBQUUsR0FBRztnQkFDZixPQUFPO2dCQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsS0FBSyxFQUFFLDZCQUE2QixFQUFFLENBQUM7YUFDL0QsQ0FBQztRQUNKLENBQUM7UUFFRCxpREFBaUQ7UUFDakQsTUFBTSxNQUFNLEdBQUcsTUFBTSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksMkJBQVksQ0FBQztZQUM3QyxTQUFTLEVBQUUsa0JBQWtCO1lBQzdCLFNBQVMsRUFBRSxlQUFlO1lBQzFCLHNCQUFzQixFQUFFLG1CQUFtQjtZQUMzQyx5QkFBeUIsRUFBRTtnQkFDekIsTUFBTSxFQUFFLFNBQVM7YUFDbEI7WUFDRCxnQkFBZ0IsRUFBRSxJQUFJLEVBQUUscUNBQXFDO1NBQzlELENBQUMsQ0FBQyxDQUFDO1FBRUosTUFBTSxLQUFLLEdBQUcsTUFBTSxDQUFDLEtBQUssSUFBSSxFQUFFLENBQUM7UUFFakMsSUFBSSxLQUFLLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ3ZCLE9BQU87Z0JBQ0wsVUFBVSxFQUFFLEdBQUc7Z0JBQ2YsT0FBTztnQkFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSxtQkFBbUIsRUFBRSxDQUFDO2FBQ3JELENBQUM7UUFDSixDQUFDO1FBRUQsb0RBQW9EO1FBQ3BELE1BQU0sZ0JBQWdCLEdBQUcsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQztRQUM3QyxJQUFJLGdCQUFnQixLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQ25DLE9BQU87Z0JBQ0wsVUFBVSxFQUFFLEdBQUc7Z0JBQ2YsT0FBTztnQkFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSx1Q0FBdUMsRUFBRSxDQUFDO2FBQ3pFLENBQUM7UUFDSixDQUFDO1FBRUQsT0FBTztZQUNMLFVBQVUsRUFBRSxHQUFHO1lBQ2YsT0FBTztZQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDO2dCQUNuQixTQUFTO2dCQUNULFFBQVEsRUFBRSxLQUFLO2dCQUNmLEtBQUssRUFBRSxLQUFLLENBQUMsTUFBTTthQUNwQixDQUFDO1NBQ0gsQ0FBQztJQUVKLENBQUM7SUFBQyxPQUFPLEtBQVUsRUFBRSxDQUFDO1FBQ3BCLE9BQU8sQ0FBQyxLQUFLLENBQUMsb0JBQW9CLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDM0MsT0FBTztZQUNMLFVBQVUsRUFBRSxHQUFHO1lBQ2YsT0FBTztZQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDO2dCQUNuQixLQUFLLEVBQUUsS0FBSyxDQUFDLE9BQU8sSUFBSSx1QkFBdUI7YUFDaEQsQ0FBQztTQUNILENBQUM7SUFDSixDQUFDO0FBQ0gsQ0FBQyxDQUFDO0FBN0VXLFFBQUEsT0FBTyxXQTZFbEIiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEdldCBBbmFseXRpY3MgU2Vzc2lvbiBMYW1iZGFcbiAqXG4gKiBSZXR1cm5zIGFsbCBjaGF0IGhpc3RvcnkgaXRlbXMgZm9yIGEgc3BlY2lmaWMgc2Vzc2lvbi5cbiAqL1xuXG5pbXBvcnQgeyBBUElHYXRld2F5UHJveHlFdmVudCwgQVBJR2F0ZXdheVByb3h5UmVzdWx0IH0gZnJvbSAnYXdzLWxhbWJkYSc7XG5pbXBvcnQgeyBEeW5hbW9EQkNsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYic7XG5pbXBvcnQgeyBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LCBRdWVyeUNvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9saWItZHluYW1vZGInO1xuXG5jb25zdCBkZGJDbGllbnQgPSBuZXcgRHluYW1vREJDbGllbnQoe30pO1xuY29uc3QgZGRiID0gRHluYW1vREJEb2N1bWVudENsaWVudC5mcm9tKGRkYkNsaWVudCk7XG5cbmNvbnN0IENIQVRfSElTVE9SWV9UQUJMRSA9IHByb2Nlc3MuZW52LkNIQVRfSElTVE9SWV9UQUJMRSE7XG5cbmV4cG9ydCBjb25zdCBoYW5kbGVyID0gYXN5bmMgKGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudCk6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0PiA9PiB7XG4gIGNvbnN0IGhlYWRlcnMgPSB7XG4gICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJzogJyonLFxuICB9O1xuXG4gIHRyeSB7XG4gICAgY29uc3Qgc2Vzc2lvbklkID0gZXZlbnQucGF0aFBhcmFtZXRlcnM/LnNlc3Npb25JZDtcbiAgICBjb25zdCB1c2VyRW1haWwgPSBldmVudC5xdWVyeVN0cmluZ1BhcmFtZXRlcnM/LnVzZXJFbWFpbDtcblxuICAgIGlmICghc2Vzc2lvbklkKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdNaXNzaW5nIHNlc3Npb25JZCBwYXJhbWV0ZXInIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBpZiAoIXVzZXJFbWFpbCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnTWlzc2luZyB1c2VyRW1haWwgcGFyYW1ldGVyJyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gUXVlcnkgYWxsIGl0ZW1zIGZvciB0aGlzIHNlc3Npb24gdXNpbmcgdGhlIEdTSVxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRkYi5zZW5kKG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBDSEFUX0hJU1RPUllfVEFCTEUsXG4gICAgICBJbmRleE5hbWU6ICdzZXNzaW9uLWluZGV4JyxcbiAgICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdzZXNzaW9uX2lkID0gOnNpZCcsXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICc6c2lkJzogc2Vzc2lvbklkLFxuICAgICAgfSxcbiAgICAgIFNjYW5JbmRleEZvcndhcmQ6IHRydWUsIC8vIE9sZGVzdCBmaXJzdCAoY2hyb25vbG9naWNhbCBvcmRlcilcbiAgICB9KSk7XG5cbiAgICBjb25zdCBpdGVtcyA9IHJlc3VsdC5JdGVtcyB8fCBbXTtcblxuICAgIGlmIChpdGVtcy5sZW5ndGggPT09IDApIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwNCxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1Nlc3Npb24gbm90IGZvdW5kJyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gVmVyaWZ5IHRoZSBzZXNzaW9uIGJlbG9uZ3MgdG8gdGhlIHJlcXVlc3RpbmcgdXNlclxuICAgIGNvbnN0IHNlc3Npb25Vc2VyRW1haWwgPSBpdGVtc1swXS51c2VyX2VtYWlsO1xuICAgIGlmIChzZXNzaW9uVXNlckVtYWlsICE9PSB1c2VyRW1haWwpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwMyxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0Nhbm5vdCBhY2Nlc3MgYW5vdGhlciB1c2VyXFwncyBzZXNzaW9uJyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHNlc3Npb25JZCxcbiAgICAgICAgbWVzc2FnZXM6IGl0ZW1zLFxuICAgICAgICB0b3RhbDogaXRlbXMubGVuZ3RoLFxuICAgICAgfSksXG4gICAgfTtcblxuICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgY29uc29sZS5lcnJvcignR2V0IHNlc3Npb24gZXJyb3I6JywgZXJyb3IpO1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA1MDAsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBlcnJvcjogZXJyb3IubWVzc2FnZSB8fCAnSW50ZXJuYWwgc2VydmVyIGVycm9yJyxcbiAgICAgIH0pLFxuICAgIH07XG4gIH1cbn07XG4iXX0=