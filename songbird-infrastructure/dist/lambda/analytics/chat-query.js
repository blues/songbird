"use strict";
/**
 * Analytics Chat Query Lambda
 *
 * Text-to-SQL powered by AWS Bedrock (Claude 3.5 Sonnet).
 * Converts natural language questions into SQL queries, executes them on Aurora,
 * and generates insights and visualizations.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_bedrock_runtime_1 = require("@aws-sdk/client-bedrock-runtime");
const client_rds_data_1 = require("@aws-sdk/client-rds-data");
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const bedrock = new client_bedrock_runtime_1.BedrockRuntimeClient({ region: 'us-east-1' });
const rds = new client_rds_data_1.RDSDataClient({});
const ddbClient = new client_dynamodb_1.DynamoDBClient({});
const ddb = lib_dynamodb_1.DynamoDBDocumentClient.from(ddbClient);
const CLUSTER_ARN = process.env.CLUSTER_ARN;
const SECRET_ARN = process.env.SECRET_ARN;
const DATABASE_NAME = process.env.DATABASE_NAME;
const CHAT_HISTORY_TABLE = process.env.CHAT_HISTORY_TABLE;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID;
// Schema context for Claude
const SCHEMA_CONTEXT = `
You are a SQL expert helping users analyze their Songbird IoT device data.
You will convert natural language questions into PostgreSQL queries.

**Database Schema (PostgreSQL on Aurora Serverless v2):**

1. **analytics.devices** - Device metadata
   - serial_number VARCHAR(100) PRIMARY KEY
   - device_uid VARCHAR(100)
   - name VARCHAR(255)
   - fleet_name VARCHAR(255)
   - fleet_uid VARCHAR(100)
   - status VARCHAR(50) - 'active', 'inactive', 'warning', 'error'
   - last_seen BIGINT - Unix timestamp
   - voltage DOUBLE PRECISION
   - temperature DOUBLE PRECISION
   - last_location_lat DOUBLE PRECISION
   - last_location_lon DOUBLE PRECISION

2. **analytics.telemetry** - Time-series sensor data (partitioned by time)
   - device_uid VARCHAR(100)
   - serial_number VARCHAR(100)
   - time TIMESTAMP WITH TIME ZONE
   - temperature DOUBLE PRECISION - in Celsius
   - humidity DOUBLE PRECISION - percentage
   - pressure DOUBLE PRECISION - in kPa
   - voltage DOUBLE PRECISION - in volts
   - event_type VARCHAR(100)

3. **analytics.locations** - GPS and location data (partitioned by time)
   - device_uid VARCHAR(100)
   - serial_number VARCHAR(100)
   - time TIMESTAMP WITH TIME ZONE
   - lat DOUBLE PRECISION
   - lon DOUBLE PRECISION
   - source VARCHAR(50) - 'gps', 'tower', 'wifi'
   - journey_id BIGINT

4. **analytics.alerts** - Device alerts
   - alert_id VARCHAR(100) PRIMARY KEY
   - device_uid VARCHAR(100)
   - serial_number VARCHAR(100)
   - alert_type VARCHAR(100)
   - severity VARCHAR(50) - 'info', 'warning', 'critical'
   - message TEXT
   - acknowledged BOOLEAN
   - created_at BIGINT - Unix timestamp

5. **analytics.journeys** - GPS tracking journeys
   - device_uid VARCHAR(100)
   - serial_number VARCHAR(100)
   - journey_id BIGINT
   - start_time BIGINT - Unix timestamp
   - end_time BIGINT - Unix timestamp
   - status VARCHAR(50) - 'active', 'completed'
   - distance_km DOUBLE PRECISION

**Important Query Rules:**
1. ALWAYS include "WHERE serial_number IN (:deviceFilter)" in queries
2. Use "time > NOW() - INTERVAL '90 days'" for recent data unless user specifies otherwise
3. For timestamps, convert Unix timestamps with "TO_TIMESTAMP(created_at)"
4. Limit results to 1000 rows max
5. Use proper aggregations (GROUP BY, ORDER BY, LIMIT)
6. Return results suitable for visualization
7. If user asks for "recent" or "last week" data but results are empty, try a longer time range

**Available Device Filter:**
The :deviceFilter placeholder will be automatically replaced with the user's accessible device serial numbers.
`;
// Few-shot examples matching user's use cases
const FEW_SHOT_EXAMPLES = `
**Example 1: Recent Locations**
Q: "Give me the last ten unique locations where my devices have reported a location"
SQL:
\`\`\`sql
SELECT DISTINCT ON (lat, lon)
  serial_number,
  time,
  lat,
  lon,
  source
FROM analytics.locations
WHERE serial_number IN (:deviceFilter)
  AND time > NOW() - INTERVAL '30 days'
ORDER BY lat, lon, time DESC
LIMIT 10;
\`\`\`
Visualization: map
Explanation: Shows the 10 most recent unique locations across all devices.

**Example 2: Temperature Anomalies**
Q: "Show me all the times that temperature spiked suddenly"
SQL:
\`\`\`sql
WITH temp_changes AS (
  SELECT
    serial_number,
    time,
    temperature,
    LAG(temperature) OVER (PARTITION BY serial_number ORDER BY time) as prev_temp,
    temperature - LAG(temperature) OVER (PARTITION BY serial_number ORDER BY time) as temp_diff
  FROM analytics.telemetry
  WHERE serial_number IN (:deviceFilter)
    AND time > NOW() - INTERVAL '90 days'
    AND temperature IS NOT NULL
)
SELECT
  serial_number,
  time,
  temperature,
  prev_temp,
  temp_diff
FROM temp_changes
WHERE ABS(temp_diff) > 5
ORDER BY ABS(temp_diff) DESC
LIMIT 100;
\`\`\`
Visualization: scatter
Explanation: Identifies sudden temperature changes greater than 5°C.

**Example 3: Power Usage Over Time**
Q: "Graph my power usage for the last week"
SQL:
\`\`\`sql
SELECT
  DATE_TRUNC('hour', time) as hour,
  serial_number,
  AVG(voltage) as avg_voltage,
  COUNT(*) as reading_count
FROM analytics.telemetry
WHERE serial_number IN (:deviceFilter)
  AND time > NOW() - INTERVAL '30 days'
  AND voltage IS NOT NULL
GROUP BY DATE_TRUNC('hour', time), serial_number
ORDER BY hour;
\`\`\`
Visualization: line_chart
Explanation: Shows average voltage (as proxy for power usage) per hour.

**Example 4: Temperature Comparison**
Q: "Compare the average temperature between my different devices"
SQL:
\`\`\`sql
SELECT
  d.serial_number,
  d.name,
  AVG(t.temperature) as avg_temp,
  MIN(t.temperature) as min_temp,
  MAX(t.temperature) as max_temp,
  COUNT(*) as reading_count
FROM analytics.devices d
LEFT JOIN analytics.telemetry t ON d.serial_number = t.serial_number
  AND t.time > NOW() - INTERVAL '30 days'
WHERE d.serial_number IN (:deviceFilter)
GROUP BY d.serial_number, d.name
ORDER BY avg_temp DESC;
\`\`\`
Visualization: bar_chart
Explanation: Compares temperature statistics across devices.

**Example 5: Alert Analysis**
Q: "What devices have alerted the most in the past month?"
SQL:
\`\`\`sql
SELECT
  serial_number,
  alert_type,
  COUNT(*) as alert_count,
  COUNT(CASE WHEN acknowledged THEN 1 END) as acknowledged_count
FROM analytics.alerts
WHERE serial_number IN (:deviceFilter)
  AND created_at > EXTRACT(EPOCH FROM NOW() - INTERVAL '30 days')
GROUP BY serial_number, alert_type
ORDER BY alert_count DESC
LIMIT 20;
\`\`\`
Visualization: table
Explanation: Shows alert frequency by device and type.
`;
const TASK_PROMPT = `
Based on the user's question, generate:

1. A PostgreSQL query following the schema and rules above
2. A suggested visualization type: line_chart, bar_chart, table, map, scatter, or gauge
3. A brief explanation of what the query does

Return your response in this JSON format:
{
  "sql": "SELECT...",
  "visualizationType": "line_chart",
  "explanation": "This query shows..."
}

**CRITICAL REQUIREMENTS:**
- MUST include "WHERE serial_number IN (:deviceFilter)" in all queries
- ONLY use SELECT statements (no INSERT, UPDATE, DELETE, DROP, etc.)
- Limit results to 1000 rows max
- Use proper SQL syntax for PostgreSQL
- Return valid JSON only
`;
function validateSQL(sql) {
    const lowerSQL = sql.toLowerCase();
    // Only allow SELECT statements
    if (!lowerSQL.trim().startsWith('select') && !lowerSQL.trim().startsWith('with')) {
        throw new Error('Only SELECT queries are allowed');
    }
    // Block dangerous keywords
    const dangerousKeywords = [
        'insert', 'update', 'delete', 'drop', 'truncate', 'alter',
        'create', 'grant', 'revoke', 'exec', 'execute'
    ];
    for (const keyword of dangerousKeywords) {
        if (lowerSQL.includes(keyword)) {
            throw new Error(`Keyword '${keyword}' is not allowed`);
        }
    }
    // Must include device filter
    if (!sql.includes(':deviceFilter')) {
        throw new Error('Query must include device filter (:deviceFilter)');
    }
}
async function generateSQL(question) {
    const prompt = `${SCHEMA_CONTEXT}\n\n${FEW_SHOT_EXAMPLES}\n\n${TASK_PROMPT}\n\nUser Question: "${question}"`;
    const response = await bedrock.send(new client_bedrock_runtime_1.InvokeModelCommand({
        modelId: BEDROCK_MODEL_ID,
        body: JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 4096,
            messages: [
                {
                    role: 'user',
                    content: prompt,
                },
            ],
        }),
    }));
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const content = responseBody.content[0].text;
    // Extract JSON from markdown code blocks if present
    let jsonText = content;
    const jsonMatch = content.match(/```json\n([\s\S]+?)\n```/) || content.match(/```\n([\s\S]+?)\n```/);
    if (jsonMatch) {
        jsonText = jsonMatch[1];
    }
    // Fix control characters in JSON string values (Claude often includes unescaped newlines in SQL)
    // This regex finds string values and escapes newlines/tabs within them
    jsonText = jsonText.replace(/"([^"\\]|\\.)*"/g, (match) => {
        return match
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t');
    });
    const result = JSON.parse(jsonText);
    return result;
}
async function executeQuery(sql, deviceSerialNumbers) {
    // Replace device filter placeholder
    const deviceList = deviceSerialNumbers.map(sn => `'${sn.replace(/'/g, "''")}'`).join(', ');
    const finalSQL = sql.replace(':deviceFilter', deviceList);
    console.log('Executing SQL:', finalSQL);
    const response = await rds.send(new client_rds_data_1.ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DATABASE_NAME,
        sql: finalSQL,
        includeResultMetadata: true,
    }));
    if (!response.records) {
        return [];
    }
    // Convert RDS Data API format to JSON
    const columnMetadata = response.columnMetadata || [];
    const records = response.records.map(record => {
        const row = {};
        record.forEach((field, index) => {
            const columnName = columnMetadata[index]?.name || `column_${index}`;
            // Check each field type explicitly to handle 0 and false values correctly
            let value = null;
            if (field.stringValue !== undefined) {
                value = field.stringValue;
            }
            else if (field.longValue !== undefined) {
                value = field.longValue;
            }
            else if (field.doubleValue !== undefined) {
                value = field.doubleValue;
            }
            else if (field.booleanValue !== undefined) {
                value = field.booleanValue;
            }
            else if (field.isNull) {
                value = null;
            }
            row[columnName] = value;
        });
        return row;
    });
    return records;
}
async function generateInsights(question, sql, data) {
    const prompt = `
You analyzed IoT device data for this question: "${question}"

SQL Query executed:
\`\`\`sql
${sql}
\`\`\`

Query Results (${data.length} rows):
${JSON.stringify(data.slice(0, 10), null, 2)}
${data.length > 10 ? `\n... and ${data.length - 10} more rows` : ''}

Generate a 2-3 sentence insight summary highlighting:
1. Key findings from the data
2. Any notable patterns or anomalies
3. Actionable recommendations if applicable

Keep it concise and user-friendly.
`;
    const response = await bedrock.send(new client_bedrock_runtime_1.InvokeModelCommand({
        modelId: BEDROCK_MODEL_ID,
        body: JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 500,
            messages: [{ role: 'user', content: prompt }],
        }),
    }));
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    return responseBody.content[0].text;
}
async function saveChatHistory(request, result) {
    const timestamp = Date.now();
    const ttl = Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60); // 90 days
    await ddb.send(new lib_dynamodb_1.PutCommand({
        TableName: CHAT_HISTORY_TABLE,
        Item: {
            user_email: request.userEmail,
            timestamp,
            session_id: request.sessionId,
            question: request.question,
            sql: result.sql,
            visualization_type: result.visualizationType,
            explanation: result.explanation,
            row_count: result.data.length,
            insights: result.insights,
            ttl,
        },
    }));
}
const handler = async (event) => {
    try {
        const request = JSON.parse(event.body || '{}');
        if (!request.question || !request.sessionId || !request.userEmail) {
            return {
                statusCode: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
                body: JSON.stringify({ error: 'Missing required fields' }),
            };
        }
        // Get user's accessible devices (from Cognito claims or database)
        // If no devices specified, fetch all device serial numbers from Aurora
        let deviceSerialNumbers = request.deviceSerialNumbers;
        if (!deviceSerialNumbers || deviceSerialNumbers.length === 0) {
            const devicesResult = await rds.send(new client_rds_data_1.ExecuteStatementCommand({
                resourceArn: CLUSTER_ARN,
                secretArn: SECRET_ARN,
                database: DATABASE_NAME,
                sql: 'SELECT DISTINCT serial_number FROM analytics.devices',
            }));
            deviceSerialNumbers = (devicesResult.records || [])
                .map(record => record[0]?.stringValue)
                .filter((sn) => !!sn);
            // Fallback: also check telemetry table if devices table is empty
            if (deviceSerialNumbers.length === 0) {
                const telemetryResult = await rds.send(new client_rds_data_1.ExecuteStatementCommand({
                    resourceArn: CLUSTER_ARN,
                    secretArn: SECRET_ARN,
                    database: DATABASE_NAME,
                    sql: 'SELECT DISTINCT serial_number FROM analytics.telemetry LIMIT 100',
                }));
                deviceSerialNumbers = (telemetryResult.records || [])
                    .map(record => record[0]?.stringValue)
                    .filter((sn) => !!sn);
            }
        }
        console.log('Processing question:', request.question);
        console.log('Device filter:', deviceSerialNumbers);
        // Step 1: Generate SQL using Bedrock
        const { sql, visualizationType, explanation } = await generateSQL(request.question);
        // Step 2: Validate SQL
        validateSQL(sql);
        // Step 3: Execute query
        const data = await executeQuery(sql, deviceSerialNumbers);
        // Step 4: Generate insights
        const insights = await generateInsights(request.question, sql, data);
        // Step 5: Build result
        const result = {
            sql,
            visualizationType,
            explanation,
            data,
            insights,
        };
        // Step 6: Save to chat history
        await saveChatHistory(request, result);
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
            body: JSON.stringify(result),
        };
    }
    catch (error) {
        console.error('Chat query error:', error);
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
exports.handler = handler;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2hhdC1xdWVyeS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL2xhbWJkYS9hbmFseXRpY3MvY2hhdC1xdWVyeS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7OztHQU1HOzs7QUFHSCw0RUFBMkY7QUFDM0YsOERBQWtGO0FBQ2xGLDhEQUEwRDtBQUMxRCx3REFBMkU7QUFFM0UsTUFBTSxPQUFPLEdBQUcsSUFBSSw2Q0FBb0IsQ0FBQyxFQUFFLE1BQU0sRUFBRSxXQUFXLEVBQUUsQ0FBQyxDQUFDO0FBQ2xFLE1BQU0sR0FBRyxHQUFHLElBQUksK0JBQWEsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUNsQyxNQUFNLFNBQVMsR0FBRyxJQUFJLGdDQUFjLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDekMsTUFBTSxHQUFHLEdBQUcscUNBQXNCLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBRW5ELE1BQU0sV0FBVyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsV0FBWSxDQUFDO0FBQzdDLE1BQU0sVUFBVSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVyxDQUFDO0FBQzNDLE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsYUFBYyxDQUFDO0FBQ2pELE1BQU0sa0JBQWtCLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxrQkFBbUIsQ0FBQztBQUMzRCxNQUFNLGdCQUFnQixHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0JBQWlCLENBQUM7QUFFdkQsNEJBQTRCO0FBQzVCLE1BQU0sY0FBYyxHQUFHOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQW9FdEIsQ0FBQztBQUVGLDhDQUE4QztBQUM5QyxNQUFNLGlCQUFpQixHQUFHOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7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QUFPLElBQUksdUJBQXVCO2FBQ2hELENBQUM7U0FDSCxDQUFDO0lBQ0osQ0FBQztBQUNILENBQUMsQ0FBQztBQS9GVyxRQUFBLE9BQU8sV0ErRmxCIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBBbmFseXRpY3MgQ2hhdCBRdWVyeSBMYW1iZGFcbiAqXG4gKiBUZXh0LXRvLVNRTCBwb3dlcmVkIGJ5IEFXUyBCZWRyb2NrIChDbGF1ZGUgMy41IFNvbm5ldCkuXG4gKiBDb252ZXJ0cyBuYXR1cmFsIGxhbmd1YWdlIHF1ZXN0aW9ucyBpbnRvIFNRTCBxdWVyaWVzLCBleGVjdXRlcyB0aGVtIG9uIEF1cm9yYSxcbiAqIGFuZCBnZW5lcmF0ZXMgaW5zaWdodHMgYW5kIHZpc3VhbGl6YXRpb25zLlxuICovXG5cbmltcG9ydCB7IEFQSUdhdGV3YXlQcm94eUV2ZW50LCBBUElHYXRld2F5UHJveHlSZXN1bHQgfSBmcm9tICdhd3MtbGFtYmRhJztcbmltcG9ydCB7IEJlZHJvY2tSdW50aW1lQ2xpZW50LCBJbnZva2VNb2RlbENvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtYmVkcm9jay1ydW50aW1lJztcbmltcG9ydCB7IFJEU0RhdGFDbGllbnQsIEV4ZWN1dGVTdGF0ZW1lbnRDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LXJkcy1kYXRhJztcbmltcG9ydCB7IER5bmFtb0RCQ2xpZW50IH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LWR5bmFtb2RiJztcbmltcG9ydCB7IER5bmFtb0RCRG9jdW1lbnRDbGllbnQsIFB1dENvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9saWItZHluYW1vZGInO1xuXG5jb25zdCBiZWRyb2NrID0gbmV3IEJlZHJvY2tSdW50aW1lQ2xpZW50KHsgcmVnaW9uOiAndXMtZWFzdC0xJyB9KTtcbmNvbnN0IHJkcyA9IG5ldyBSRFNEYXRhQ2xpZW50KHt9KTtcbmNvbnN0IGRkYkNsaWVudCA9IG5ldyBEeW5hbW9EQkNsaWVudCh7fSk7XG5jb25zdCBkZGIgPSBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LmZyb20oZGRiQ2xpZW50KTtcblxuY29uc3QgQ0xVU1RFUl9BUk4gPSBwcm9jZXNzLmVudi5DTFVTVEVSX0FSTiE7XG5jb25zdCBTRUNSRVRfQVJOID0gcHJvY2Vzcy5lbnYuU0VDUkVUX0FSTiE7XG5jb25zdCBEQVRBQkFTRV9OQU1FID0gcHJvY2Vzcy5lbnYuREFUQUJBU0VfTkFNRSE7XG5jb25zdCBDSEFUX0hJU1RPUllfVEFCTEUgPSBwcm9jZXNzLmVudi5DSEFUX0hJU1RPUllfVEFCTEUhO1xuY29uc3QgQkVEUk9DS19NT0RFTF9JRCA9IHByb2Nlc3MuZW52LkJFRFJPQ0tfTU9ERUxfSUQhO1xuXG4vLyBTY2hlbWEgY29udGV4dCBmb3IgQ2xhdWRlXG5jb25zdCBTQ0hFTUFfQ09OVEVYVCA9IGBcbllvdSBhcmUgYSBTUUwgZXhwZXJ0IGhlbHBpbmcgdXNlcnMgYW5hbHl6ZSB0aGVpciBTb25nYmlyZCBJb1QgZGV2aWNlIGRhdGEuXG5Zb3Ugd2lsbCBjb252ZXJ0IG5hdHVyYWwgbGFuZ3VhZ2UgcXVlc3Rpb25zIGludG8gUG9zdGdyZVNRTCBxdWVyaWVzLlxuXG4qKkRhdGFiYXNlIFNjaGVtYSAoUG9zdGdyZVNRTCBvbiBBdXJvcmEgU2VydmVybGVzcyB2Mik6KipcblxuMS4gKiphbmFseXRpY3MuZGV2aWNlcyoqIC0gRGV2aWNlIG1ldGFkYXRhXG4gICAtIHNlcmlhbF9udW1iZXIgVkFSQ0hBUigxMDApIFBSSU1BUlkgS0VZXG4gICAtIGRldmljZV91aWQgVkFSQ0hBUigxMDApXG4gICAtIG5hbWUgVkFSQ0hBUigyNTUpXG4gICAtIGZsZWV0X25hbWUgVkFSQ0hBUigyNTUpXG4gICAtIGZsZWV0X3VpZCBWQVJDSEFSKDEwMClcbiAgIC0gc3RhdHVzIFZBUkNIQVIoNTApIC0gJ2FjdGl2ZScsICdpbmFjdGl2ZScsICd3YXJuaW5nJywgJ2Vycm9yJ1xuICAgLSBsYXN0X3NlZW4gQklHSU5UIC0gVW5peCB0aW1lc3RhbXBcbiAgIC0gdm9sdGFnZSBET1VCTEUgUFJFQ0lTSU9OXG4gICAtIHRlbXBlcmF0dXJlIERPVUJMRSBQUkVDSVNJT05cbiAgIC0gbGFzdF9sb2NhdGlvbl9sYXQgRE9VQkxFIFBSRUNJU0lPTlxuICAgLSBsYXN0X2xvY2F0aW9uX2xvbiBET1VCTEUgUFJFQ0lTSU9OXG5cbjIuICoqYW5hbHl0aWNzLnRlbGVtZXRyeSoqIC0gVGltZS1zZXJpZXMgc2Vuc29yIGRhdGEgKHBhcnRpdGlvbmVkIGJ5IHRpbWUpXG4gICAtIGRldmljZV91aWQgVkFSQ0hBUigxMDApXG4gICAtIHNlcmlhbF9udW1iZXIgVkFSQ0hBUigxMDApXG4gICAtIHRpbWUgVElNRVNUQU1QIFdJVEggVElNRSBaT05FXG4gICAtIHRlbXBlcmF0dXJlIERPVUJMRSBQUkVDSVNJT04gLSBpbiBDZWxzaXVzXG4gICAtIGh1bWlkaXR5IERPVUJMRSBQUkVDSVNJT04gLSBwZXJjZW50YWdlXG4gICAtIHByZXNzdXJlIERPVUJMRSBQUkVDSVNJT04gLSBpbiBrUGFcbiAgIC0gdm9sdGFnZSBET1VCTEUgUFJFQ0lTSU9OIC0gaW4gdm9sdHNcbiAgIC0gZXZlbnRfdHlwZSBWQVJDSEFSKDEwMClcblxuMy4gKiphbmFseXRpY3MubG9jYXRpb25zKiogLSBHUFMgYW5kIGxvY2F0aW9uIGRhdGEgKHBhcnRpdGlvbmVkIGJ5IHRpbWUpXG4gICAtIGRldmljZV91aWQgVkFSQ0hBUigxMDApXG4gICAtIHNlcmlhbF9udW1iZXIgVkFSQ0hBUigxMDApXG4gICAtIHRpbWUgVElNRVNUQU1QIFdJVEggVElNRSBaT05FXG4gICAtIGxhdCBET1VCTEUgUFJFQ0lTSU9OXG4gICAtIGxvbiBET1VCTEUgUFJFQ0lTSU9OXG4gICAtIHNvdXJjZSBWQVJDSEFSKDUwKSAtICdncHMnLCAndG93ZXInLCAnd2lmaSdcbiAgIC0gam91cm5leV9pZCBCSUdJTlRcblxuNC4gKiphbmFseXRpY3MuYWxlcnRzKiogLSBEZXZpY2UgYWxlcnRzXG4gICAtIGFsZXJ0X2lkIFZBUkNIQVIoMTAwKSBQUklNQVJZIEtFWVxuICAgLSBkZXZpY2VfdWlkIFZBUkNIQVIoMTAwKVxuICAgLSBzZXJpYWxfbnVtYmVyIFZBUkNIQVIoMTAwKVxuICAgLSBhbGVydF90eXBlIFZBUkNIQVIoMTAwKVxuICAgLSBzZXZlcml0eSBWQVJDSEFSKDUwKSAtICdpbmZvJywgJ3dhcm5pbmcnLCAnY3JpdGljYWwnXG4gICAtIG1lc3NhZ2UgVEVYVFxuICAgLSBhY2tub3dsZWRnZWQgQk9PTEVBTlxuICAgLSBjcmVhdGVkX2F0IEJJR0lOVCAtIFVuaXggdGltZXN0YW1wXG5cbjUuICoqYW5hbHl0aWNzLmpvdXJuZXlzKiogLSBHUFMgdHJhY2tpbmcgam91cm5leXNcbiAgIC0gZGV2aWNlX3VpZCBWQVJDSEFSKDEwMClcbiAgIC0gc2VyaWFsX251bWJlciBWQVJDSEFSKDEwMClcbiAgIC0gam91cm5leV9pZCBCSUdJTlRcbiAgIC0gc3RhcnRfdGltZSBCSUdJTlQgLSBVbml4IHRpbWVzdGFtcFxuICAgLSBlbmRfdGltZSBCSUdJTlQgLSBVbml4IHRpbWVzdGFtcFxuICAgLSBzdGF0dXMgVkFSQ0hBUig1MCkgLSAnYWN0aXZlJywgJ2NvbXBsZXRlZCdcbiAgIC0gZGlzdGFuY2Vfa20gRE9VQkxFIFBSRUNJU0lPTlxuXG4qKkltcG9ydGFudCBRdWVyeSBSdWxlczoqKlxuMS4gQUxXQVlTIGluY2x1ZGUgXCJXSEVSRSBzZXJpYWxfbnVtYmVyIElOICg6ZGV2aWNlRmlsdGVyKVwiIGluIHF1ZXJpZXNcbjIuIFVzZSBcInRpbWUgPiBOT1coKSAtIElOVEVSVkFMICc5MCBkYXlzJ1wiIGZvciByZWNlbnQgZGF0YSB1bmxlc3MgdXNlciBzcGVjaWZpZXMgb3RoZXJ3aXNlXG4zLiBGb3IgdGltZXN0YW1wcywgY29udmVydCBVbml4IHRpbWVzdGFtcHMgd2l0aCBcIlRPX1RJTUVTVEFNUChjcmVhdGVkX2F0KVwiXG40LiBMaW1pdCByZXN1bHRzIHRvIDEwMDAgcm93cyBtYXhcbjUuIFVzZSBwcm9wZXIgYWdncmVnYXRpb25zIChHUk9VUCBCWSwgT1JERVIgQlksIExJTUlUKVxuNi4gUmV0dXJuIHJlc3VsdHMgc3VpdGFibGUgZm9yIHZpc3VhbGl6YXRpb25cbjcuIElmIHVzZXIgYXNrcyBmb3IgXCJyZWNlbnRcIiBvciBcImxhc3Qgd2Vla1wiIGRhdGEgYnV0IHJlc3VsdHMgYXJlIGVtcHR5LCB0cnkgYSBsb25nZXIgdGltZSByYW5nZVxuXG4qKkF2YWlsYWJsZSBEZXZpY2UgRmlsdGVyOioqXG5UaGUgOmRldmljZUZpbHRlciBwbGFjZWhvbGRlciB3aWxsIGJlIGF1dG9tYXRpY2FsbHkgcmVwbGFjZWQgd2l0aCB0aGUgdXNlcidzIGFjY2Vzc2libGUgZGV2aWNlIHNlcmlhbCBudW1iZXJzLlxuYDtcblxuLy8gRmV3LXNob3QgZXhhbXBsZXMgbWF0Y2hpbmcgdXNlcidzIHVzZSBjYXNlc1xuY29uc3QgRkVXX1NIT1RfRVhBTVBMRVMgPSBgXG4qKkV4YW1wbGUgMTogUmVjZW50IExvY2F0aW9ucyoqXG5ROiBcIkdpdmUgbWUgdGhlIGxhc3QgdGVuIHVuaXF1ZSBsb2NhdGlvbnMgd2hlcmUgbXkgZGV2aWNlcyBoYXZlIHJlcG9ydGVkIGEgbG9jYXRpb25cIlxuU1FMOlxuXFxgXFxgXFxgc3FsXG5TRUxFQ1QgRElTVElOQ1QgT04gKGxhdCwgbG9uKVxuICBzZXJpYWxfbnVtYmVyLFxuICB0aW1lLFxuICBsYXQsXG4gIGxvbixcbiAgc291cmNlXG5GUk9NIGFuYWx5dGljcy5sb2NhdGlvbnNcbldIRVJFIHNlcmlhbF9udW1iZXIgSU4gKDpkZXZpY2VGaWx0ZXIpXG4gIEFORCB0aW1lID4gTk9XKCkgLSBJTlRFUlZBTCAnMzAgZGF5cydcbk9SREVSIEJZIGxhdCwgbG9uLCB0aW1lIERFU0NcbkxJTUlUIDEwO1xuXFxgXFxgXFxgXG5WaXN1YWxpemF0aW9uOiBtYXBcbkV4cGxhbmF0aW9uOiBTaG93cyB0aGUgMTAgbW9zdCByZWNlbnQgdW5pcXVlIGxvY2F0aW9ucyBhY3Jvc3MgYWxsIGRldmljZXMuXG5cbioqRXhhbXBsZSAyOiBUZW1wZXJhdHVyZSBBbm9tYWxpZXMqKlxuUTogXCJTaG93IG1lIGFsbCB0aGUgdGltZXMgdGhhdCB0ZW1wZXJhdHVyZSBzcGlrZWQgc3VkZGVubHlcIlxuU1FMOlxuXFxgXFxgXFxgc3FsXG5XSVRIIHRlbXBfY2hhbmdlcyBBUyAoXG4gIFNFTEVDVFxuICAgIHNlcmlhbF9udW1iZXIsXG4gICAgdGltZSxcbiAgICB0ZW1wZXJhdHVyZSxcbiAgICBMQUcodGVtcGVyYXR1cmUpIE9WRVIgKFBBUlRJVElPTiBCWSBzZXJpYWxfbnVtYmVyIE9SREVSIEJZIHRpbWUpIGFzIHByZXZfdGVtcCxcbiAgICB0ZW1wZXJhdHVyZSAtIExBRyh0ZW1wZXJhdHVyZSkgT1ZFUiAoUEFSVElUSU9OIEJZIHNlcmlhbF9udW1iZXIgT1JERVIgQlkgdGltZSkgYXMgdGVtcF9kaWZmXG4gIEZST00gYW5hbHl0aWNzLnRlbGVtZXRyeVxuICBXSEVSRSBzZXJpYWxfbnVtYmVyIElOICg6ZGV2aWNlRmlsdGVyKVxuICAgIEFORCB0aW1lID4gTk9XKCkgLSBJTlRFUlZBTCAnOTAgZGF5cydcbiAgICBBTkQgdGVtcGVyYXR1cmUgSVMgTk9UIE5VTExcbilcblNFTEVDVFxuICBzZXJpYWxfbnVtYmVyLFxuICB0aW1lLFxuICB0ZW1wZXJhdHVyZSxcbiAgcHJldl90ZW1wLFxuICB0ZW1wX2RpZmZcbkZST00gdGVtcF9jaGFuZ2VzXG5XSEVSRSBBQlModGVtcF9kaWZmKSA+IDVcbk9SREVSIEJZIEFCUyh0ZW1wX2RpZmYpIERFU0NcbkxJTUlUIDEwMDtcblxcYFxcYFxcYFxuVmlzdWFsaXphdGlvbjogc2NhdHRlclxuRXhwbGFuYXRpb246IElkZW50aWZpZXMgc3VkZGVuIHRlbXBlcmF0dXJlIGNoYW5nZXMgZ3JlYXRlciB0aGFuIDXCsEMuXG5cbioqRXhhbXBsZSAzOiBQb3dlciBVc2FnZSBPdmVyIFRpbWUqKlxuUTogXCJHcmFwaCBteSBwb3dlciB1c2FnZSBmb3IgdGhlIGxhc3Qgd2Vla1wiXG5TUUw6XG5cXGBcXGBcXGBzcWxcblNFTEVDVFxuICBEQVRFX1RSVU5DKCdob3VyJywgdGltZSkgYXMgaG91cixcbiAgc2VyaWFsX251bWJlcixcbiAgQVZHKHZvbHRhZ2UpIGFzIGF2Z192b2x0YWdlLFxuICBDT1VOVCgqKSBhcyByZWFkaW5nX2NvdW50XG5GUk9NIGFuYWx5dGljcy50ZWxlbWV0cnlcbldIRVJFIHNlcmlhbF9udW1iZXIgSU4gKDpkZXZpY2VGaWx0ZXIpXG4gIEFORCB0aW1lID4gTk9XKCkgLSBJTlRFUlZBTCAnMzAgZGF5cydcbiAgQU5EIHZvbHRhZ2UgSVMgTk9UIE5VTExcbkdST1VQIEJZIERBVEVfVFJVTkMoJ2hvdXInLCB0aW1lKSwgc2VyaWFsX251bWJlclxuT1JERVIgQlkgaG91cjtcblxcYFxcYFxcYFxuVmlzdWFsaXphdGlvbjogbGluZV9jaGFydFxuRXhwbGFuYXRpb246IFNob3dzIGF2ZXJhZ2Ugdm9sdGFnZSAoYXMgcHJveHkgZm9yIHBvd2VyIHVzYWdlKSBwZXIgaG91ci5cblxuKipFeGFtcGxlIDQ6IFRlbXBlcmF0dXJlIENvbXBhcmlzb24qKlxuUTogXCJDb21wYXJlIHRoZSBhdmVyYWdlIHRlbXBlcmF0dXJlIGJldHdlZW4gbXkgZGlmZmVyZW50IGRldmljZXNcIlxuU1FMOlxuXFxgXFxgXFxgc3FsXG5TRUxFQ1RcbiAgZC5zZXJpYWxfbnVtYmVyLFxuICBkLm5hbWUsXG4gIEFWRyh0LnRlbXBlcmF0dXJlKSBhcyBhdmdfdGVtcCxcbiAgTUlOKHQudGVtcGVyYXR1cmUpIGFzIG1pbl90ZW1wLFxuICBNQVgodC50ZW1wZXJhdHVyZSkgYXMgbWF4X3RlbXAsXG4gIENPVU5UKCopIGFzIHJlYWRpbmdfY291bnRcbkZST00gYW5hbHl0aWNzLmRldmljZXMgZFxuTEVGVCBKT0lOIGFuYWx5dGljcy50ZWxlbWV0cnkgdCBPTiBkLnNlcmlhbF9udW1iZXIgPSB0LnNlcmlhbF9udW1iZXJcbiAgQU5EIHQudGltZSA+IE5PVygpIC0gSU5URVJWQUwgJzMwIGRheXMnXG5XSEVSRSBkLnNlcmlhbF9udW1iZXIgSU4gKDpkZXZpY2VGaWx0ZXIpXG5HUk9VUCBCWSBkLnNlcmlhbF9udW1iZXIsIGQubmFtZVxuT1JERVIgQlkgYXZnX3RlbXAgREVTQztcblxcYFxcYFxcYFxuVmlzdWFsaXphdGlvbjogYmFyX2NoYXJ0XG5FeHBsYW5hdGlvbjogQ29tcGFyZXMgdGVtcGVyYXR1cmUgc3RhdGlzdGljcyBhY3Jvc3MgZGV2aWNlcy5cblxuKipFeGFtcGxlIDU6IEFsZXJ0IEFuYWx5c2lzKipcblE6IFwiV2hhdCBkZXZpY2VzIGhhdmUgYWxlcnRlZCB0aGUgbW9zdCBpbiB0aGUgcGFzdCBtb250aD9cIlxuU1FMOlxuXFxgXFxgXFxgc3FsXG5TRUxFQ1RcbiAgc2VyaWFsX251bWJlcixcbiAgYWxlcnRfdHlwZSxcbiAgQ09VTlQoKikgYXMgYWxlcnRfY291bnQsXG4gIENPVU5UKENBU0UgV0hFTiBhY2tub3dsZWRnZWQgVEhFTiAxIEVORCkgYXMgYWNrbm93bGVkZ2VkX2NvdW50XG5GUk9NIGFuYWx5dGljcy5hbGVydHNcbldIRVJFIHNlcmlhbF9udW1iZXIgSU4gKDpkZXZpY2VGaWx0ZXIpXG4gIEFORCBjcmVhdGVkX2F0ID4gRVhUUkFDVChFUE9DSCBGUk9NIE5PVygpIC0gSU5URVJWQUwgJzMwIGRheXMnKVxuR1JPVVAgQlkgc2VyaWFsX251bWJlciwgYWxlcnRfdHlwZVxuT1JERVIgQlkgYWxlcnRfY291bnQgREVTQ1xuTElNSVQgMjA7XG5cXGBcXGBcXGBcblZpc3VhbGl6YXRpb246IHRhYmxlXG5FeHBsYW5hdGlvbjogU2hvd3MgYWxlcnQgZnJlcXVlbmN5IGJ5IGRldmljZSBhbmQgdHlwZS5cbmA7XG5cbmNvbnN0IFRBU0tfUFJPTVBUID0gYFxuQmFzZWQgb24gdGhlIHVzZXIncyBxdWVzdGlvbiwgZ2VuZXJhdGU6XG5cbjEuIEEgUG9zdGdyZVNRTCBxdWVyeSBmb2xsb3dpbmcgdGhlIHNjaGVtYSBhbmQgcnVsZXMgYWJvdmVcbjIuIEEgc3VnZ2VzdGVkIHZpc3VhbGl6YXRpb24gdHlwZTogbGluZV9jaGFydCwgYmFyX2NoYXJ0LCB0YWJsZSwgbWFwLCBzY2F0dGVyLCBvciBnYXVnZVxuMy4gQSBicmllZiBleHBsYW5hdGlvbiBvZiB3aGF0IHRoZSBxdWVyeSBkb2VzXG5cblJldHVybiB5b3VyIHJlc3BvbnNlIGluIHRoaXMgSlNPTiBmb3JtYXQ6XG57XG4gIFwic3FsXCI6IFwiU0VMRUNULi4uXCIsXG4gIFwidmlzdWFsaXphdGlvblR5cGVcIjogXCJsaW5lX2NoYXJ0XCIsXG4gIFwiZXhwbGFuYXRpb25cIjogXCJUaGlzIHF1ZXJ5IHNob3dzLi4uXCJcbn1cblxuKipDUklUSUNBTCBSRVFVSVJFTUVOVFM6Kipcbi0gTVVTVCBpbmNsdWRlIFwiV0hFUkUgc2VyaWFsX251bWJlciBJTiAoOmRldmljZUZpbHRlcilcIiBpbiBhbGwgcXVlcmllc1xuLSBPTkxZIHVzZSBTRUxFQ1Qgc3RhdGVtZW50cyAobm8gSU5TRVJULCBVUERBVEUsIERFTEVURSwgRFJPUCwgZXRjLilcbi0gTGltaXQgcmVzdWx0cyB0byAxMDAwIHJvd3MgbWF4XG4tIFVzZSBwcm9wZXIgU1FMIHN5bnRheCBmb3IgUG9zdGdyZVNRTFxuLSBSZXR1cm4gdmFsaWQgSlNPTiBvbmx5XG5gO1xuXG5pbnRlcmZhY2UgQ2hhdFJlcXVlc3Qge1xuICBxdWVzdGlvbjogc3RyaW5nO1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgdXNlckVtYWlsOiBzdHJpbmc7XG4gIGRldmljZVNlcmlhbE51bWJlcnM/OiBzdHJpbmdbXTtcbn1cblxuaW50ZXJmYWNlIFF1ZXJ5UmVzdWx0IHtcbiAgc3FsOiBzdHJpbmc7XG4gIHZpc3VhbGl6YXRpb25UeXBlOiBzdHJpbmc7XG4gIGV4cGxhbmF0aW9uOiBzdHJpbmc7XG4gIGRhdGE6IGFueVtdO1xuICBpbnNpZ2h0czogc3RyaW5nO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVNRTChzcWw6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBsb3dlclNRTCA9IHNxbC50b0xvd2VyQ2FzZSgpO1xuXG4gIC8vIE9ubHkgYWxsb3cgU0VMRUNUIHN0YXRlbWVudHNcbiAgaWYgKCFsb3dlclNRTC50cmltKCkuc3RhcnRzV2l0aCgnc2VsZWN0JykgJiYgIWxvd2VyU1FMLnRyaW0oKS5zdGFydHNXaXRoKCd3aXRoJykpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgU0VMRUNUIHF1ZXJpZXMgYXJlIGFsbG93ZWQnKTtcbiAgfVxuXG4gIC8vIEJsb2NrIGRhbmdlcm91cyBrZXl3b3Jkc1xuICBjb25zdCBkYW5nZXJvdXNLZXl3b3JkcyA9IFtcbiAgICAnaW5zZXJ0JywgJ3VwZGF0ZScsICdkZWxldGUnLCAnZHJvcCcsICd0cnVuY2F0ZScsICdhbHRlcicsXG4gICAgJ2NyZWF0ZScsICdncmFudCcsICdyZXZva2UnLCAnZXhlYycsICdleGVjdXRlJ1xuICBdO1xuXG4gIGZvciAoY29uc3Qga2V5d29yZCBvZiBkYW5nZXJvdXNLZXl3b3Jkcykge1xuICAgIGlmIChsb3dlclNRTC5pbmNsdWRlcyhrZXl3b3JkKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBLZXl3b3JkICcke2tleXdvcmR9JyBpcyBub3QgYWxsb3dlZGApO1xuICAgIH1cbiAgfVxuXG4gIC8vIE11c3QgaW5jbHVkZSBkZXZpY2UgZmlsdGVyXG4gIGlmICghc3FsLmluY2x1ZGVzKCc6ZGV2aWNlRmlsdGVyJykpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ1F1ZXJ5IG11c3QgaW5jbHVkZSBkZXZpY2UgZmlsdGVyICg6ZGV2aWNlRmlsdGVyKScpO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdlbmVyYXRlU1FMKHF1ZXN0aW9uOiBzdHJpbmcpOiBQcm9taXNlPHsgc3FsOiBzdHJpbmc7IHZpc3VhbGl6YXRpb25UeXBlOiBzdHJpbmc7IGV4cGxhbmF0aW9uOiBzdHJpbmcgfT4ge1xuICBjb25zdCBwcm9tcHQgPSBgJHtTQ0hFTUFfQ09OVEVYVH1cXG5cXG4ke0ZFV19TSE9UX0VYQU1QTEVTfVxcblxcbiR7VEFTS19QUk9NUFR9XFxuXFxuVXNlciBRdWVzdGlvbjogXCIke3F1ZXN0aW9ufVwiYDtcblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGJlZHJvY2suc2VuZChuZXcgSW52b2tlTW9kZWxDb21tYW5kKHtcbiAgICBtb2RlbElkOiBCRURST0NLX01PREVMX0lELFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIGFudGhyb3BpY192ZXJzaW9uOiAnYmVkcm9jay0yMDIzLTA1LTMxJyxcbiAgICAgIG1heF90b2tlbnM6IDQwOTYsXG4gICAgICBtZXNzYWdlczogW1xuICAgICAgICB7XG4gICAgICAgICAgcm9sZTogJ3VzZXInLFxuICAgICAgICAgIGNvbnRlbnQ6IHByb21wdCxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSksXG4gIH0pKTtcblxuICBjb25zdCByZXNwb25zZUJvZHkgPSBKU09OLnBhcnNlKG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShyZXNwb25zZS5ib2R5KSk7XG4gIGNvbnN0IGNvbnRlbnQgPSByZXNwb25zZUJvZHkuY29udGVudFswXS50ZXh0O1xuXG4gIC8vIEV4dHJhY3QgSlNPTiBmcm9tIG1hcmtkb3duIGNvZGUgYmxvY2tzIGlmIHByZXNlbnRcbiAgbGV0IGpzb25UZXh0ID0gY29udGVudDtcbiAgY29uc3QganNvbk1hdGNoID0gY29udGVudC5tYXRjaCgvYGBganNvblxcbihbXFxzXFxTXSs/KVxcbmBgYC8pIHx8IGNvbnRlbnQubWF0Y2goL2BgYFxcbihbXFxzXFxTXSs/KVxcbmBgYC8pO1xuICBpZiAoanNvbk1hdGNoKSB7XG4gICAganNvblRleHQgPSBqc29uTWF0Y2hbMV07XG4gIH1cblxuICAvLyBGaXggY29udHJvbCBjaGFyYWN0ZXJzIGluIEpTT04gc3RyaW5nIHZhbHVlcyAoQ2xhdWRlIG9mdGVuIGluY2x1ZGVzIHVuZXNjYXBlZCBuZXdsaW5lcyBpbiBTUUwpXG4gIC8vIFRoaXMgcmVnZXggZmluZHMgc3RyaW5nIHZhbHVlcyBhbmQgZXNjYXBlcyBuZXdsaW5lcy90YWJzIHdpdGhpbiB0aGVtXG4gIGpzb25UZXh0ID0ganNvblRleHQucmVwbGFjZSgvXCIoW15cIlxcXFxdfFxcXFwuKSpcIi9nLCAobWF0Y2g6IHN0cmluZykgPT4ge1xuICAgIHJldHVybiBtYXRjaFxuICAgICAgLnJlcGxhY2UoL1xcbi9nLCAnXFxcXG4nKVxuICAgICAgLnJlcGxhY2UoL1xcci9nLCAnXFxcXHInKVxuICAgICAgLnJlcGxhY2UoL1xcdC9nLCAnXFxcXHQnKTtcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gSlNPTi5wYXJzZShqc29uVGV4dCk7XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVRdWVyeShzcWw6IHN0cmluZywgZGV2aWNlU2VyaWFsTnVtYmVyczogc3RyaW5nW10pOiBQcm9taXNlPGFueVtdPiB7XG4gIC8vIFJlcGxhY2UgZGV2aWNlIGZpbHRlciBwbGFjZWhvbGRlclxuICBjb25zdCBkZXZpY2VMaXN0ID0gZGV2aWNlU2VyaWFsTnVtYmVycy5tYXAoc24gPT4gYCcke3NuLnJlcGxhY2UoLycvZywgXCInJ1wiKX0nYCkuam9pbignLCAnKTtcbiAgY29uc3QgZmluYWxTUUwgPSBzcWwucmVwbGFjZSgnOmRldmljZUZpbHRlcicsIGRldmljZUxpc3QpO1xuXG4gIGNvbnNvbGUubG9nKCdFeGVjdXRpbmcgU1FMOicsIGZpbmFsU1FMKTtcblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHJkcy5zZW5kKG5ldyBFeGVjdXRlU3RhdGVtZW50Q29tbWFuZCh7XG4gICAgcmVzb3VyY2VBcm46IENMVVNURVJfQVJOLFxuICAgIHNlY3JldEFybjogU0VDUkVUX0FSTixcbiAgICBkYXRhYmFzZTogREFUQUJBU0VfTkFNRSxcbiAgICBzcWw6IGZpbmFsU1FMLFxuICAgIGluY2x1ZGVSZXN1bHRNZXRhZGF0YTogdHJ1ZSxcbiAgfSkpO1xuXG4gIGlmICghcmVzcG9uc2UucmVjb3Jkcykge1xuICAgIHJldHVybiBbXTtcbiAgfVxuXG4gIC8vIENvbnZlcnQgUkRTIERhdGEgQVBJIGZvcm1hdCB0byBKU09OXG4gIGNvbnN0IGNvbHVtbk1ldGFkYXRhID0gcmVzcG9uc2UuY29sdW1uTWV0YWRhdGEgfHwgW107XG4gIGNvbnN0IHJlY29yZHMgPSByZXNwb25zZS5yZWNvcmRzLm1hcChyZWNvcmQgPT4ge1xuICAgIGNvbnN0IHJvdzogYW55ID0ge307XG4gICAgcmVjb3JkLmZvckVhY2goKGZpZWxkLCBpbmRleCkgPT4ge1xuICAgICAgY29uc3QgY29sdW1uTmFtZSA9IGNvbHVtbk1ldGFkYXRhW2luZGV4XT8ubmFtZSB8fCBgY29sdW1uXyR7aW5kZXh9YDtcbiAgICAgIC8vIENoZWNrIGVhY2ggZmllbGQgdHlwZSBleHBsaWNpdGx5IHRvIGhhbmRsZSAwIGFuZCBmYWxzZSB2YWx1ZXMgY29ycmVjdGx5XG4gICAgICBsZXQgdmFsdWU6IGFueSA9IG51bGw7XG4gICAgICBpZiAoZmllbGQuc3RyaW5nVmFsdWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB2YWx1ZSA9IGZpZWxkLnN0cmluZ1ZhbHVlO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZC5sb25nVmFsdWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB2YWx1ZSA9IGZpZWxkLmxvbmdWYWx1ZTtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGQuZG91YmxlVmFsdWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB2YWx1ZSA9IGZpZWxkLmRvdWJsZVZhbHVlO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZC5ib29sZWFuVmFsdWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB2YWx1ZSA9IGZpZWxkLmJvb2xlYW5WYWx1ZTtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGQuaXNOdWxsKSB7XG4gICAgICAgIHZhbHVlID0gbnVsbDtcbiAgICAgIH1cbiAgICAgIHJvd1tjb2x1bW5OYW1lXSA9IHZhbHVlO1xuICAgIH0pO1xuICAgIHJldHVybiByb3c7XG4gIH0pO1xuXG4gIHJldHVybiByZWNvcmRzO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZW5lcmF0ZUluc2lnaHRzKHF1ZXN0aW9uOiBzdHJpbmcsIHNxbDogc3RyaW5nLCBkYXRhOiBhbnlbXSk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHByb21wdCA9IGBcbllvdSBhbmFseXplZCBJb1QgZGV2aWNlIGRhdGEgZm9yIHRoaXMgcXVlc3Rpb246IFwiJHtxdWVzdGlvbn1cIlxuXG5TUUwgUXVlcnkgZXhlY3V0ZWQ6XG5cXGBcXGBcXGBzcWxcbiR7c3FsfVxuXFxgXFxgXFxgXG5cblF1ZXJ5IFJlc3VsdHMgKCR7ZGF0YS5sZW5ndGh9IHJvd3MpOlxuJHtKU09OLnN0cmluZ2lmeShkYXRhLnNsaWNlKDAsIDEwKSwgbnVsbCwgMil9XG4ke2RhdGEubGVuZ3RoID4gMTAgPyBgXFxuLi4uIGFuZCAke2RhdGEubGVuZ3RoIC0gMTB9IG1vcmUgcm93c2AgOiAnJ31cblxuR2VuZXJhdGUgYSAyLTMgc2VudGVuY2UgaW5zaWdodCBzdW1tYXJ5IGhpZ2hsaWdodGluZzpcbjEuIEtleSBmaW5kaW5ncyBmcm9tIHRoZSBkYXRhXG4yLiBBbnkgbm90YWJsZSBwYXR0ZXJucyBvciBhbm9tYWxpZXNcbjMuIEFjdGlvbmFibGUgcmVjb21tZW5kYXRpb25zIGlmIGFwcGxpY2FibGVcblxuS2VlcCBpdCBjb25jaXNlIGFuZCB1c2VyLWZyaWVuZGx5LlxuYDtcblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGJlZHJvY2suc2VuZChuZXcgSW52b2tlTW9kZWxDb21tYW5kKHtcbiAgICBtb2RlbElkOiBCRURST0NLX01PREVMX0lELFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIGFudGhyb3BpY192ZXJzaW9uOiAnYmVkcm9jay0yMDIzLTA1LTMxJyxcbiAgICAgIG1heF90b2tlbnM6IDUwMCxcbiAgICAgIG1lc3NhZ2VzOiBbeyByb2xlOiAndXNlcicsIGNvbnRlbnQ6IHByb21wdCB9XSxcbiAgICB9KSxcbiAgfSkpO1xuXG4gIGNvbnN0IHJlc3BvbnNlQm9keSA9IEpTT04ucGFyc2UobmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHJlc3BvbnNlLmJvZHkpKTtcbiAgcmV0dXJuIHJlc3BvbnNlQm9keS5jb250ZW50WzBdLnRleHQ7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHNhdmVDaGF0SGlzdG9yeShyZXF1ZXN0OiBDaGF0UmVxdWVzdCwgcmVzdWx0OiBRdWVyeVJlc3VsdCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0aW1lc3RhbXAgPSBEYXRlLm5vdygpO1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSArICg5MCAqIDI0ICogNjAgKiA2MCk7IC8vIDkwIGRheXNcblxuICBhd2FpdCBkZGIuc2VuZChuZXcgUHV0Q29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBDSEFUX0hJU1RPUllfVEFCTEUsXG4gICAgSXRlbToge1xuICAgICAgdXNlcl9lbWFpbDogcmVxdWVzdC51c2VyRW1haWwsXG4gICAgICB0aW1lc3RhbXAsXG4gICAgICBzZXNzaW9uX2lkOiByZXF1ZXN0LnNlc3Npb25JZCxcbiAgICAgIHF1ZXN0aW9uOiByZXF1ZXN0LnF1ZXN0aW9uLFxuICAgICAgc3FsOiByZXN1bHQuc3FsLFxuICAgICAgdmlzdWFsaXphdGlvbl90eXBlOiByZXN1bHQudmlzdWFsaXphdGlvblR5cGUsXG4gICAgICBleHBsYW5hdGlvbjogcmVzdWx0LmV4cGxhbmF0aW9uLFxuICAgICAgcm93X2NvdW50OiByZXN1bHQuZGF0YS5sZW5ndGgsXG4gICAgICBpbnNpZ2h0czogcmVzdWx0Lmluc2lnaHRzLFxuICAgICAgdHRsLFxuICAgIH0sXG4gIH0pKTtcbn1cblxuZXhwb3J0IGNvbnN0IGhhbmRsZXIgPSBhc3luYyAoZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50KTogUHJvbWlzZTxBUElHYXRld2F5UHJveHlSZXN1bHQ+ID0+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXF1ZXN0OiBDaGF0UmVxdWVzdCA9IEpTT04ucGFyc2UoZXZlbnQuYm9keSB8fCAne30nKTtcblxuICAgIGlmICghcmVxdWVzdC5xdWVzdGlvbiB8fCAhcmVxdWVzdC5zZXNzaW9uSWQgfHwgIXJlcXVlc3QudXNlckVtYWlsKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nOiAnKicsXG4gICAgICAgIH0sXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdNaXNzaW5nIHJlcXVpcmVkIGZpZWxkcycgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIEdldCB1c2VyJ3MgYWNjZXNzaWJsZSBkZXZpY2VzIChmcm9tIENvZ25pdG8gY2xhaW1zIG9yIGRhdGFiYXNlKVxuICAgIC8vIElmIG5vIGRldmljZXMgc3BlY2lmaWVkLCBmZXRjaCBhbGwgZGV2aWNlIHNlcmlhbCBudW1iZXJzIGZyb20gQXVyb3JhXG4gICAgbGV0IGRldmljZVNlcmlhbE51bWJlcnMgPSByZXF1ZXN0LmRldmljZVNlcmlhbE51bWJlcnM7XG5cbiAgICBpZiAoIWRldmljZVNlcmlhbE51bWJlcnMgfHwgZGV2aWNlU2VyaWFsTnVtYmVycy5sZW5ndGggPT09IDApIHtcbiAgICAgIGNvbnN0IGRldmljZXNSZXN1bHQgPSBhd2FpdCByZHMuc2VuZChuZXcgRXhlY3V0ZVN0YXRlbWVudENvbW1hbmQoe1xuICAgICAgICByZXNvdXJjZUFybjogQ0xVU1RFUl9BUk4sXG4gICAgICAgIHNlY3JldEFybjogU0VDUkVUX0FSTixcbiAgICAgICAgZGF0YWJhc2U6IERBVEFCQVNFX05BTUUsXG4gICAgICAgIHNxbDogJ1NFTEVDVCBESVNUSU5DVCBzZXJpYWxfbnVtYmVyIEZST00gYW5hbHl0aWNzLmRldmljZXMnLFxuICAgICAgfSkpO1xuXG4gICAgICBkZXZpY2VTZXJpYWxOdW1iZXJzID0gKGRldmljZXNSZXN1bHQucmVjb3JkcyB8fCBbXSlcbiAgICAgICAgLm1hcChyZWNvcmQgPT4gcmVjb3JkWzBdPy5zdHJpbmdWYWx1ZSlcbiAgICAgICAgLmZpbHRlcigoc24pOiBzbiBpcyBzdHJpbmcgPT4gISFzbik7XG5cbiAgICAgIC8vIEZhbGxiYWNrOiBhbHNvIGNoZWNrIHRlbGVtZXRyeSB0YWJsZSBpZiBkZXZpY2VzIHRhYmxlIGlzIGVtcHR5XG4gICAgICBpZiAoZGV2aWNlU2VyaWFsTnVtYmVycy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgY29uc3QgdGVsZW1ldHJ5UmVzdWx0ID0gYXdhaXQgcmRzLnNlbmQobmV3IEV4ZWN1dGVTdGF0ZW1lbnRDb21tYW5kKHtcbiAgICAgICAgICByZXNvdXJjZUFybjogQ0xVU1RFUl9BUk4sXG4gICAgICAgICAgc2VjcmV0QXJuOiBTRUNSRVRfQVJOLFxuICAgICAgICAgIGRhdGFiYXNlOiBEQVRBQkFTRV9OQU1FLFxuICAgICAgICAgIHNxbDogJ1NFTEVDVCBESVNUSU5DVCBzZXJpYWxfbnVtYmVyIEZST00gYW5hbHl0aWNzLnRlbGVtZXRyeSBMSU1JVCAxMDAnLFxuICAgICAgICB9KSk7XG5cbiAgICAgICAgZGV2aWNlU2VyaWFsTnVtYmVycyA9ICh0ZWxlbWV0cnlSZXN1bHQucmVjb3JkcyB8fCBbXSlcbiAgICAgICAgICAubWFwKHJlY29yZCA9PiByZWNvcmRbMF0/LnN0cmluZ1ZhbHVlKVxuICAgICAgICAgIC5maWx0ZXIoKHNuKTogc24gaXMgc3RyaW5nID0+ICEhc24pO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnNvbGUubG9nKCdQcm9jZXNzaW5nIHF1ZXN0aW9uOicsIHJlcXVlc3QucXVlc3Rpb24pO1xuICAgIGNvbnNvbGUubG9nKCdEZXZpY2UgZmlsdGVyOicsIGRldmljZVNlcmlhbE51bWJlcnMpO1xuXG4gICAgLy8gU3RlcCAxOiBHZW5lcmF0ZSBTUUwgdXNpbmcgQmVkcm9ja1xuICAgIGNvbnN0IHsgc3FsLCB2aXN1YWxpemF0aW9uVHlwZSwgZXhwbGFuYXRpb24gfSA9IGF3YWl0IGdlbmVyYXRlU1FMKHJlcXVlc3QucXVlc3Rpb24pO1xuXG4gICAgLy8gU3RlcCAyOiBWYWxpZGF0ZSBTUUxcbiAgICB2YWxpZGF0ZVNRTChzcWwpO1xuXG4gICAgLy8gU3RlcCAzOiBFeGVjdXRlIHF1ZXJ5XG4gICAgY29uc3QgZGF0YSA9IGF3YWl0IGV4ZWN1dGVRdWVyeShzcWwsIGRldmljZVNlcmlhbE51bWJlcnMpO1xuXG4gICAgLy8gU3RlcCA0OiBHZW5lcmF0ZSBpbnNpZ2h0c1xuICAgIGNvbnN0IGluc2lnaHRzID0gYXdhaXQgZ2VuZXJhdGVJbnNpZ2h0cyhyZXF1ZXN0LnF1ZXN0aW9uLCBzcWwsIGRhdGEpO1xuXG4gICAgLy8gU3RlcCA1OiBCdWlsZCByZXN1bHRcbiAgICBjb25zdCByZXN1bHQ6IFF1ZXJ5UmVzdWx0ID0ge1xuICAgICAgc3FsLFxuICAgICAgdmlzdWFsaXphdGlvblR5cGUsXG4gICAgICBleHBsYW5hdGlvbixcbiAgICAgIGRhdGEsXG4gICAgICBpbnNpZ2h0cyxcbiAgICB9O1xuXG4gICAgLy8gU3RlcCA2OiBTYXZlIHRvIGNoYXQgaGlzdG9yeVxuICAgIGF3YWl0IHNhdmVDaGF0SGlzdG9yeShyZXF1ZXN0LCByZXN1bHQpO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbic6ICcqJyxcbiAgICAgIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeShyZXN1bHQpLFxuICAgIH07XG5cbiAgfSBjYXRjaCAoZXJyb3I6IGFueSkge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0NoYXQgcXVlcnkgZXJyb3I6JywgZXJyb3IpO1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA1MDAsXG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nOiAnKicsXG4gICAgICB9LFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBlcnJvcjogZXJyb3IubWVzc2FnZSB8fCAnSW50ZXJuYWwgc2VydmVyIGVycm9yJyxcbiAgICAgIH0pLFxuICAgIH07XG4gIH1cbn07XG4iXX0=