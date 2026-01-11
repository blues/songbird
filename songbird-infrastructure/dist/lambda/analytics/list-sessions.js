"use strict";
/**
 * List Analytics Sessions Lambda
 *
 * Returns a list of unique chat sessions for a user with metadata.
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
        const result = await ddb.send(new lib_dynamodb_1.QueryCommand({
            TableName: CHAT_HISTORY_TABLE,
            KeyConditionExpression: 'user_email = :email',
            ExpressionAttributeValues: {
                ':email': userEmail,
            },
            ScanIndexForward: false, // Most recent first
            Limit: 500, // Get enough items to aggregate into sessions
        }));
        const items = (result.Items || []);
        // Group by session_id
        const sessionMap = new Map();
        for (const item of items) {
            const sessionId = item.session_id;
            if (!sessionMap.has(sessionId)) {
                sessionMap.set(sessionId, []);
            }
            sessionMap.get(sessionId).push(item);
        }
        // Build session summaries
        const sessions = [];
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
    }
    catch (error) {
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
exports.handler = handler;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGlzdC1zZXNzaW9ucy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL2xhbWJkYS9hbmFseXRpY3MvbGlzdC1zZXNzaW9ucy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7R0FJRzs7O0FBR0gsOERBQTBEO0FBQzFELHdEQUE2RTtBQUU3RSxNQUFNLFNBQVMsR0FBRyxJQUFJLGdDQUFjLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDekMsTUFBTSxHQUFHLEdBQUcscUNBQXNCLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBRW5ELE1BQU0sa0JBQWtCLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxrQkFBbUIsQ0FBQztBQXVCcEQsTUFBTSxPQUFPLEdBQUcsS0FBSyxFQUFFLEtBQTJCLEVBQWtDLEVBQUU7SUFDM0YsTUFBTSxPQUFPLEdBQUc7UUFDZCxjQUFjLEVBQUUsa0JBQWtCO1FBQ2xDLDZCQUE2QixFQUFFLEdBQUc7S0FDbkMsQ0FBQztJQUVGLElBQUksQ0FBQztRQUNILE1BQU0sU0FBUyxHQUFHLEtBQUssQ0FBQyxxQkFBcUIsRUFBRSxTQUFTLENBQUM7UUFDekQsTUFBTSxLQUFLLEdBQUcsUUFBUSxDQUFDLEtBQUssQ0FBQyxxQkFBcUIsRUFBRSxLQUFLLElBQUksSUFBSSxDQUFDLENBQUM7UUFFbkUsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDO1lBQ2YsT0FBTztnQkFDTCxVQUFVLEVBQUUsR0FBRztnQkFDZixPQUFPO2dCQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsS0FBSyxFQUFFLDZCQUE2QixFQUFFLENBQUM7YUFDL0QsQ0FBQztRQUNKLENBQUM7UUFFRCxxRkFBcUY7UUFDckYsTUFBTSxNQUFNLEdBQUcsTUFBTSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksMkJBQVksQ0FBQztZQUM3QyxTQUFTLEVBQUUsa0JBQWtCO1lBQzdCLHNCQUFzQixFQUFFLHFCQUFxQjtZQUM3Qyx5QkFBeUIsRUFBRTtnQkFDekIsUUFBUSxFQUFFLFNBQVM7YUFDcEI7WUFDRCxnQkFBZ0IsRUFBRSxLQUFLLEVBQUUsb0JBQW9CO1lBQzdDLEtBQUssRUFBRSxHQUFHLEVBQUUsOENBQThDO1NBQzNELENBQUMsQ0FBQyxDQUFDO1FBRUosTUFBTSxLQUFLLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSyxJQUFJLEVBQUUsQ0FBc0IsQ0FBQztRQUV4RCxzQkFBc0I7UUFDdEIsTUFBTSxVQUFVLEdBQUcsSUFBSSxHQUFHLEVBQTZCLENBQUM7UUFDeEQsS0FBSyxNQUFNLElBQUksSUFBSSxLQUFLLEVBQUUsQ0FBQztZQUN6QixNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMsVUFBVSxDQUFDO1lBQ2xDLElBQUksQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUM7Z0JBQy9CLFVBQVUsQ0FBQyxHQUFHLENBQUMsU0FBUyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1lBQ2hDLENBQUM7WUFDRCxVQUFVLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBRSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUN4QyxDQUFDO1FBRUQsMEJBQTBCO1FBQzFCLE1BQU0sUUFBUSxHQUFxQixFQUFFLENBQUM7UUFDdEMsS0FBSyxNQUFNLENBQUMsU0FBUyxFQUFFLFlBQVksQ0FBQyxJQUFJLFVBQVUsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDO1lBQzdELGdEQUFnRDtZQUNoRCxZQUFZLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLFNBQVMsR0FBRyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUM7WUFFdkQsTUFBTSxLQUFLLEdBQUcsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQzlCLE1BQU0sSUFBSSxHQUFHLFlBQVksQ0FBQyxZQUFZLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDO1lBRW5ELFFBQVEsQ0FBQyxJQUFJLENBQUM7Z0JBQ1osU0FBUztnQkFDVCxhQUFhLEVBQUUsS0FBSyxDQUFDLFFBQVE7Z0JBQzdCLFlBQVksRUFBRSxJQUFJLENBQUMsUUFBUTtnQkFDM0IsY0FBYyxFQUFFLEtBQUssQ0FBQyxTQUFTO2dCQUMvQixhQUFhLEVBQUUsSUFBSSxDQUFDLFNBQVM7Z0JBQzdCLFlBQVksRUFBRSxZQUFZLENBQUMsTUFBTTthQUNsQyxDQUFDLENBQUM7UUFDTCxDQUFDO1FBRUQscURBQXFEO1FBQ3JELFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsYUFBYSxHQUFHLENBQUMsQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUUzRCxjQUFjO1FBQ2QsTUFBTSxlQUFlLEdBQUcsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFakQsT0FBTztZQUNMLFVBQVUsRUFBRSxHQUFHO1lBQ2YsT0FBTztZQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDO2dCQUNuQixRQUFRLEVBQUUsZUFBZTtnQkFDekIsS0FBSyxFQUFFLFFBQVEsQ0FBQyxNQUFNO2FBQ3ZCLENBQUM7U0FDSCxDQUFDO0lBRUosQ0FBQztJQUFDLE9BQU8sS0FBVSxFQUFFLENBQUM7UUFDcEIsT0FBTyxDQUFDLEtBQUssQ0FBQyxzQkFBc0IsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUM3QyxPQUFPO1lBQ0wsVUFBVSxFQUFFLEdBQUc7WUFDZixPQUFPO1lBQ1AsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUM7Z0JBQ25CLEtBQUssRUFBRSxLQUFLLENBQUMsT0FBTyxJQUFJLHVCQUF1QjthQUNoRCxDQUFDO1NBQ0gsQ0FBQztJQUNKLENBQUM7QUFDSCxDQUFDLENBQUM7QUFyRlcsUUFBQSxPQUFPLFdBcUZsQiIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogTGlzdCBBbmFseXRpY3MgU2Vzc2lvbnMgTGFtYmRhXG4gKlxuICogUmV0dXJucyBhIGxpc3Qgb2YgdW5pcXVlIGNoYXQgc2Vzc2lvbnMgZm9yIGEgdXNlciB3aXRoIG1ldGFkYXRhLlxuICovXG5cbmltcG9ydCB7IEFQSUdhdGV3YXlQcm94eUV2ZW50LCBBUElHYXRld2F5UHJveHlSZXN1bHQgfSBmcm9tICdhd3MtbGFtYmRhJztcbmltcG9ydCB7IER5bmFtb0RCQ2xpZW50IH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LWR5bmFtb2RiJztcbmltcG9ydCB7IER5bmFtb0RCRG9jdW1lbnRDbGllbnQsIFF1ZXJ5Q29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2xpYi1keW5hbW9kYic7XG5cbmNvbnN0IGRkYkNsaWVudCA9IG5ldyBEeW5hbW9EQkNsaWVudCh7fSk7XG5jb25zdCBkZGIgPSBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LmZyb20oZGRiQ2xpZW50KTtcblxuY29uc3QgQ0hBVF9ISVNUT1JZX1RBQkxFID0gcHJvY2Vzcy5lbnYuQ0hBVF9ISVNUT1JZX1RBQkxFITtcblxuaW50ZXJmYWNlIENoYXRIaXN0b3J5SXRlbSB7XG4gIHVzZXJfZW1haWw6IHN0cmluZztcbiAgdGltZXN0YW1wOiBudW1iZXI7XG4gIHNlc3Npb25faWQ6IHN0cmluZztcbiAgcXVlc3Rpb246IHN0cmluZztcbiAgc3FsPzogc3RyaW5nO1xuICBleHBsYW5hdGlvbj86IHN0cmluZztcbiAgdmlzdWFsaXphdGlvbl90eXBlPzogc3RyaW5nO1xuICByb3dfY291bnQ/OiBudW1iZXI7XG4gIGluc2lnaHRzPzogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgU2Vzc2lvblN1bW1hcnkge1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgZmlyc3RRdWVzdGlvbjogc3RyaW5nO1xuICBsYXN0UXVlc3Rpb246IHN0cmluZztcbiAgc3RhcnRUaW1lc3RhbXA6IG51bWJlcjtcbiAgbGFzdFRpbWVzdGFtcDogbnVtYmVyO1xuICBtZXNzYWdlQ291bnQ6IG51bWJlcjtcbn1cblxuZXhwb3J0IGNvbnN0IGhhbmRsZXIgPSBhc3luYyAoZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50KTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+ID0+IHtcbiAgY29uc3QgaGVhZGVycyA9IHtcbiAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nOiAnKicsXG4gIH07XG5cbiAgdHJ5IHtcbiAgICBjb25zdCB1c2VyRW1haWwgPSBldmVudC5xdWVyeVN0cmluZ1BhcmFtZXRlcnM/LnVzZXJFbWFpbDtcbiAgICBjb25zdCBsaW1pdCA9IHBhcnNlSW50KGV2ZW50LnF1ZXJ5U3RyaW5nUGFyYW1ldGVycz8ubGltaXQgfHwgJzIwJyk7XG5cbiAgICBpZiAoIXVzZXJFbWFpbCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnTWlzc2luZyB1c2VyRW1haWwgcGFyYW1ldGVyJyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gUXVlcnkgYWxsIGNoYXQgaGlzdG9yeSBmb3IgdXNlciAodXAgdG8gYSByZWFzb25hYmxlIGxpbWl0IGZvciBzZXNzaW9uIGFnZ3JlZ2F0aW9uKVxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRkYi5zZW5kKG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBDSEFUX0hJU1RPUllfVEFCTEUsXG4gICAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAndXNlcl9lbWFpbCA9IDplbWFpbCcsXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICc6ZW1haWwnOiB1c2VyRW1haWwsXG4gICAgICB9LFxuICAgICAgU2NhbkluZGV4Rm9yd2FyZDogZmFsc2UsIC8vIE1vc3QgcmVjZW50IGZpcnN0XG4gICAgICBMaW1pdDogNTAwLCAvLyBHZXQgZW5vdWdoIGl0ZW1zIHRvIGFnZ3JlZ2F0ZSBpbnRvIHNlc3Npb25zXG4gICAgfSkpO1xuXG4gICAgY29uc3QgaXRlbXMgPSAocmVzdWx0Lkl0ZW1zIHx8IFtdKSBhcyBDaGF0SGlzdG9yeUl0ZW1bXTtcblxuICAgIC8vIEdyb3VwIGJ5IHNlc3Npb25faWRcbiAgICBjb25zdCBzZXNzaW9uTWFwID0gbmV3IE1hcDxzdHJpbmcsIENoYXRIaXN0b3J5SXRlbVtdPigpO1xuICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xuICAgICAgY29uc3Qgc2Vzc2lvbklkID0gaXRlbS5zZXNzaW9uX2lkO1xuICAgICAgaWYgKCFzZXNzaW9uTWFwLmhhcyhzZXNzaW9uSWQpKSB7XG4gICAgICAgIHNlc3Npb25NYXAuc2V0KHNlc3Npb25JZCwgW10pO1xuICAgICAgfVxuICAgICAgc2Vzc2lvbk1hcC5nZXQoc2Vzc2lvbklkKSEucHVzaChpdGVtKTtcbiAgICB9XG5cbiAgICAvLyBCdWlsZCBzZXNzaW9uIHN1bW1hcmllc1xuICAgIGNvbnN0IHNlc3Npb25zOiBTZXNzaW9uU3VtbWFyeVtdID0gW107XG4gICAgZm9yIChjb25zdCBbc2Vzc2lvbklkLCBzZXNzaW9uSXRlbXNdIG9mIHNlc3Npb25NYXAuZW50cmllcygpKSB7XG4gICAgICAvLyBTb3J0IGJ5IHRpbWVzdGFtcCBhc2NlbmRpbmcgdG8gZ2V0IGZpcnN0L2xhc3RcbiAgICAgIHNlc3Npb25JdGVtcy5zb3J0KChhLCBiKSA9PiBhLnRpbWVzdGFtcCAtIGIudGltZXN0YW1wKTtcblxuICAgICAgY29uc3QgZmlyc3QgPSBzZXNzaW9uSXRlbXNbMF07XG4gICAgICBjb25zdCBsYXN0ID0gc2Vzc2lvbkl0ZW1zW3Nlc3Npb25JdGVtcy5sZW5ndGggLSAxXTtcblxuICAgICAgc2Vzc2lvbnMucHVzaCh7XG4gICAgICAgIHNlc3Npb25JZCxcbiAgICAgICAgZmlyc3RRdWVzdGlvbjogZmlyc3QucXVlc3Rpb24sXG4gICAgICAgIGxhc3RRdWVzdGlvbjogbGFzdC5xdWVzdGlvbixcbiAgICAgICAgc3RhcnRUaW1lc3RhbXA6IGZpcnN0LnRpbWVzdGFtcCxcbiAgICAgICAgbGFzdFRpbWVzdGFtcDogbGFzdC50aW1lc3RhbXAsXG4gICAgICAgIG1lc3NhZ2VDb3VudDogc2Vzc2lvbkl0ZW1zLmxlbmd0aCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIFNvcnQgc2Vzc2lvbnMgYnkgbGFzdCBhY3Rpdml0eSAobW9zdCByZWNlbnQgZmlyc3QpXG4gICAgc2Vzc2lvbnMuc29ydCgoYSwgYikgPT4gYi5sYXN0VGltZXN0YW1wIC0gYS5sYXN0VGltZXN0YW1wKTtcblxuICAgIC8vIEFwcGx5IGxpbWl0XG4gICAgY29uc3QgbGltaXRlZFNlc3Npb25zID0gc2Vzc2lvbnMuc2xpY2UoMCwgbGltaXQpO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHNlc3Npb25zOiBsaW1pdGVkU2Vzc2lvbnMsXG4gICAgICAgIHRvdGFsOiBzZXNzaW9ucy5sZW5ndGgsXG4gICAgICB9KSxcbiAgICB9O1xuXG4gIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICBjb25zb2xlLmVycm9yKCdMaXN0IHNlc3Npb25zIGVycm9yOicsIGVycm9yKTtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNTAwLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgZXJyb3I6IGVycm9yLm1lc3NhZ2UgfHwgJ0ludGVybmFsIHNlcnZlciBlcnJvcicsXG4gICAgICB9KSxcbiAgICB9O1xuICB9XG59O1xuIl19