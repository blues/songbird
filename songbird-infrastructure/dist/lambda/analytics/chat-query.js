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
// Initialize Phoenix tracing before any other imports
const tracing_1 = require("../shared/tracing");
(0, tracing_1.initializeTracing)('songbird-analytics-chat-query');
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2hhdC1xdWVyeS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL2xhbWJkYS9hbmFseXRpY3MvY2hhdC1xdWVyeS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7OztHQU1HOzs7QUFFSCxzREFBc0Q7QUFDdEQsK0NBQXNEO0FBQ3RELElBQUEsMkJBQWlCLEVBQUMsK0JBQStCLENBQUMsQ0FBQztBQUduRCw0RUFBMkY7QUFDM0YsOERBQWtGO0FBQ2xGLDhEQUEwRDtBQUMxRCx3REFBMkU7QUFFM0UsTUFBTSxPQUFPLEdBQUcsSUFBSSw2Q0FBb0IsQ0FBQyxFQUFFLE1BQU0sRUFBRSxXQUFXLEVBQUUsQ0FBQyxDQUFDO0FBQ2xFLE1BQU0sR0FBRyxHQUFHLElBQUksK0JBQWEsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUNsQyxNQUFNLFNBQVMsR0FBRyxJQUFJLGdDQUFjLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDekMsTUFBTSxHQUFHLEdBQUcscUNBQXNCLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBRW5ELE1BQU0sV0FBVyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsV0FBWSxDQUFDO0FBQzdDLE1BQU0sVUFBVSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVyxDQUFDO0FBQzNDLE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsYUFBYyxDQUFDO0FBQ2pELE1BQU0sa0JBQWtCLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxrQkFBbUIsQ0FBQztBQUMzRCxNQUFNLGdCQUFnQixHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0JBQWlCLENBQUM7QUFFdkQsNEJBQTRCO0FBQzVCLE1BQU0sY0FBYyxHQUFHOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQW9FdEIsQ0FBQztBQUVGLDhDQUE4QztBQUM5QyxNQUFNLGlC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bkM7WUFDRCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQztnQkFDbkIsS0FBSyxFQUFFLEtBQUssQ0FBQyxPQUFPLElBQUksdUJBQXVCO2FBQ2hELENBQUM7U0FDSCxDQUFDO0lBQ0osQ0FBQztBQUNILENBQUMsQ0FBQztBQS9GVyxRQUFBLE9BQU8sV0ErRmxCIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBBbmFseXRpY3MgQ2hhdCBRdWVyeSBMYW1iZGFcbiAqXG4gKiBUZXh0LXRvLVNRTCBwb3dlcmVkIGJ5IEFXUyBCZWRyb2NrIChDbGF1ZGUgMy41IFNvbm5ldCkuXG4gKiBDb252ZXJ0cyBuYXR1cmFsIGxhbmd1YWdlIHF1ZXN0aW9ucyBpbnRvIFNRTCBxdWVyaWVzLCBleGVjdXRlcyB0aGVtIG9uIEF1cm9yYSxcbiAqIGFuZCBnZW5lcmF0ZXMgaW5zaWdodHMgYW5kIHZpc3VhbGl6YXRpb25zLlxuICovXG5cbi8vIEluaXRpYWxpemUgUGhvZW5peCB0cmFjaW5nIGJlZm9yZSBhbnkgb3RoZXIgaW1wb3J0c1xuaW1wb3J0IHsgaW5pdGlhbGl6ZVRyYWNpbmcgfSBmcm9tICcuLi9zaGFyZWQvdHJhY2luZyc7XG5pbml0aWFsaXplVHJhY2luZygnc29uZ2JpcmQtYW5hbHl0aWNzLWNoYXQtcXVlcnknKTtcblxuaW1wb3J0IHsgQVBJR2F0ZXdheVByb3h5RXZlbnQsIEFQSUdhdGV3YXlQcm94eVJlc3VsdCB9IGZyb20gJ2F3cy1sYW1iZGEnO1xuaW1wb3J0IHsgQmVkcm9ja1J1bnRpbWVDbGllbnQsIEludm9rZU1vZGVsQ29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1iZWRyb2NrLXJ1bnRpbWUnO1xuaW1wb3J0IHsgUkRTRGF0YUNsaWVudCwgRXhlY3V0ZVN0YXRlbWVudENvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtcmRzLWRhdGEnO1xuaW1wb3J0IHsgRHluYW1vREJDbGllbnQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtZHluYW1vZGInO1xuaW1wb3J0IHsgRHluYW1vREJEb2N1bWVudENsaWVudCwgUHV0Q29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2xpYi1keW5hbW9kYic7XG5cbmNvbnN0IGJlZHJvY2sgPSBuZXcgQmVkcm9ja1J1bnRpbWVDbGllbnQoeyByZWdpb246ICd1cy1lYXN0LTEnIH0pO1xuY29uc3QgcmRzID0gbmV3IFJEU0RhdGFDbGllbnQoe30pO1xuY29uc3QgZGRiQ2xpZW50ID0gbmV3IER5bmFtb0RCQ2xpZW50KHt9KTtcbmNvbnN0IGRkYiA9IER5bmFtb0RCRG9jdW1lbnRDbGllbnQuZnJvbShkZGJDbGllbnQpO1xuXG5jb25zdCBDTFVTVEVSX0FSTiA9IHByb2Nlc3MuZW52LkNMVVNURVJfQVJOITtcbmNvbnN0IFNFQ1JFVF9BUk4gPSBwcm9jZXNzLmVudi5TRUNSRVRfQVJOITtcbmNvbnN0IERBVEFCQVNFX05BTUUgPSBwcm9jZXNzLmVudi5EQVRBQkFTRV9OQU1FITtcbmNvbnN0IENIQVRfSElTVE9SWV9UQUJMRSA9IHByb2Nlc3MuZW52LkNIQVRfSElTVE9SWV9UQUJMRSE7XG5jb25zdCBCRURST0NLX01PREVMX0lEID0gcHJvY2Vzcy5lbnYuQkVEUk9DS19NT0RFTF9JRCE7XG5cbi8vIFNjaGVtYSBjb250ZXh0IGZvciBDbGF1ZGVcbmNvbnN0IFNDSEVNQV9DT05URVhUID0gYFxuWW91IGFyZSBhIFNRTCBleHBlcnQgaGVscGluZyB1c2VycyBhbmFseXplIHRoZWlyIFNvbmdiaXJkIElvVCBkZXZpY2UgZGF0YS5cbllvdSB3aWxsIGNvbnZlcnQgbmF0dXJhbCBsYW5ndWFnZSBxdWVzdGlvbnMgaW50byBQb3N0Z3JlU1FMIHF1ZXJpZXMuXG5cbioqRGF0YWJhc2UgU2NoZW1hIChQb3N0Z3JlU1FMIG9uIEF1cm9yYSBTZXJ2ZXJsZXNzIHYyKToqKlxuXG4xLiAqKmFuYWx5dGljcy5kZXZpY2VzKiogLSBEZXZpY2UgbWV0YWRhdGFcbiAgIC0gc2VyaWFsX251bWJlciBWQVJDSEFSKDEwMCkgUFJJTUFSWSBLRVlcbiAgIC0gZGV2aWNlX3VpZCBWQVJDSEFSKDEwMClcbiAgIC0gbmFtZSBWQVJDSEFSKDI1NSlcbiAgIC0gZmxlZXRfbmFtZSBWQVJDSEFSKDI1NSlcbiAgIC0gZmxlZXRfdWlkIFZBUkNIQVIoMTAwKVxuICAgLSBzdGF0dXMgVkFSQ0hBUig1MCkgLSAnYWN0aXZlJywgJ2luYWN0aXZlJywgJ3dhcm5pbmcnLCAnZXJyb3InXG4gICAtIGxhc3Rfc2VlbiBCSUdJTlQgLSBVbml4IHRpbWVzdGFtcFxuICAgLSB2b2x0YWdlIERPVUJMRSBQUkVDSVNJT05cbiAgIC0gdGVtcGVyYXR1cmUgRE9VQkxFIFBSRUNJU0lPTlxuICAgLSBsYXN0X2xvY2F0aW9uX2xhdCBET1VCTEUgUFJFQ0lTSU9OXG4gICAtIGxhc3RfbG9jYXRpb25fbG9uIERPVUJMRSBQUkVDSVNJT05cblxuMi4gKiphbmFseXRpY3MudGVsZW1ldHJ5KiogLSBUaW1lLXNlcmllcyBzZW5zb3IgZGF0YSAocGFydGl0aW9uZWQgYnkgdGltZSlcbiAgIC0gZGV2aWNlX3VpZCBWQVJDSEFSKDEwMClcbiAgIC0gc2VyaWFsX251bWJlciBWQVJDSEFSKDEwMClcbiAgIC0gdGltZSBUSU1FU1RBTVAgV0lUSCBUSU1FIFpPTkVcbiAgIC0gdGVtcGVyYXR1cmUgRE9VQkxFIFBSRUNJU0lPTiAtIGluIENlbHNpdXNcbiAgIC0gaHVtaWRpdHkgRE9VQkxFIFBSRUNJU0lPTiAtIHBlcmNlbnRhZ2VcbiAgIC0gcHJlc3N1cmUgRE9VQkxFIFBSRUNJU0lPTiAtIGluIGtQYVxuICAgLSB2b2x0YWdlIERPVUJMRSBQUkVDSVNJT04gLSBpbiB2b2x0c1xuICAgLSBldmVudF90eXBlIFZBUkNIQVIoMTAwKVxuXG4zLiAqKmFuYWx5dGljcy5sb2NhdGlvbnMqKiAtIEdQUyBhbmQgbG9jYXRpb24gZGF0YSAocGFydGl0aW9uZWQgYnkgdGltZSlcbiAgIC0gZGV2aWNlX3VpZCBWQVJDSEFSKDEwMClcbiAgIC0gc2VyaWFsX251bWJlciBWQVJDSEFSKDEwMClcbiAgIC0gdGltZSBUSU1FU1RBTVAgV0lUSCBUSU1FIFpPTkVcbiAgIC0gbGF0IERPVUJMRSBQUkVDSVNJT05cbiAgIC0gbG9uIERPVUJMRSBQUkVDSVNJT05cbiAgIC0gc291cmNlIFZBUkNIQVIoNTApIC0gJ2dwcycsICd0b3dlcicsICd3aWZpJ1xuICAgLSBqb3VybmV5X2lkIEJJR0lOVFxuXG40LiAqKmFuYWx5dGljcy5hbGVydHMqKiAtIERldmljZSBhbGVydHNcbiAgIC0gYWxlcnRfaWQgVkFSQ0hBUigxMDApIFBSSU1BUlkgS0VZXG4gICAtIGRldmljZV91aWQgVkFSQ0hBUigxMDApXG4gICAtIHNlcmlhbF9udW1iZXIgVkFSQ0hBUigxMDApXG4gICAtIGFsZXJ0X3R5cGUgVkFSQ0hBUigxMDApXG4gICAtIHNldmVyaXR5IFZBUkNIQVIoNTApIC0gJ2luZm8nLCAnd2FybmluZycsICdjcml0aWNhbCdcbiAgIC0gbWVzc2FnZSBURVhUXG4gICAtIGFja25vd2xlZGdlZCBCT09MRUFOXG4gICAtIGNyZWF0ZWRfYXQgQklHSU5UIC0gVW5peCB0aW1lc3RhbXBcblxuNS4gKiphbmFseXRpY3Muam91cm5leXMqKiAtIEdQUyB0cmFja2luZyBqb3VybmV5c1xuICAgLSBkZXZpY2VfdWlkIFZBUkNIQVIoMTAwKVxuICAgLSBzZXJpYWxfbnVtYmVyIFZBUkNIQVIoMTAwKVxuICAgLSBqb3VybmV5X2lkIEJJR0lOVFxuICAgLSBzdGFydF90aW1lIEJJR0lOVCAtIFVuaXggdGltZXN0YW1wXG4gICAtIGVuZF90aW1lIEJJR0lOVCAtIFVuaXggdGltZXN0YW1wXG4gICAtIHN0YXR1cyBWQVJDSEFSKDUwKSAtICdhY3RpdmUnLCAnY29tcGxldGVkJ1xuICAgLSBkaXN0YW5jZV9rbSBET1VCTEUgUFJFQ0lTSU9OXG5cbioqSW1wb3J0YW50IFF1ZXJ5IFJ1bGVzOioqXG4xLiBBTFdBWVMgaW5jbHVkZSBcIldIRVJFIHNlcmlhbF9udW1iZXIgSU4gKDpkZXZpY2VGaWx0ZXIpXCIgaW4gcXVlcmllc1xuMi4gVXNlIFwidGltZSA+IE5PVygpIC0gSU5URVJWQUwgJzkwIGRheXMnXCIgZm9yIHJlY2VudCBkYXRhIHVubGVzcyB1c2VyIHNwZWNpZmllcyBvdGhlcndpc2VcbjMuIEZvciB0aW1lc3RhbXBzLCBjb252ZXJ0IFVuaXggdGltZXN0YW1wcyB3aXRoIFwiVE9fVElNRVNUQU1QKGNyZWF0ZWRfYXQpXCJcbjQuIExpbWl0IHJlc3VsdHMgdG8gMTAwMCByb3dzIG1heFxuNS4gVXNlIHByb3BlciBhZ2dyZWdhdGlvbnMgKEdST1VQIEJZLCBPUkRFUiBCWSwgTElNSVQpXG42LiBSZXR1cm4gcmVzdWx0cyBzdWl0YWJsZSBmb3IgdmlzdWFsaXphdGlvblxuNy4gSWYgdXNlciBhc2tzIGZvciBcInJlY2VudFwiIG9yIFwibGFzdCB3ZWVrXCIgZGF0YSBidXQgcmVzdWx0cyBhcmUgZW1wdHksIHRyeSBhIGxvbmdlciB0aW1lIHJhbmdlXG5cbioqQXZhaWxhYmxlIERldmljZSBGaWx0ZXI6KipcblRoZSA6ZGV2aWNlRmlsdGVyIHBsYWNlaG9sZGVyIHdpbGwgYmUgYXV0b21hdGljYWxseSByZXBsYWNlZCB3aXRoIHRoZSB1c2VyJ3MgYWNjZXNzaWJsZSBkZXZpY2Ugc2VyaWFsIG51bWJlcnMuXG5gO1xuXG4vLyBGZXctc2hvdCBleGFtcGxlcyBtYXRjaGluZyB1c2VyJ3MgdXNlIGNhc2VzXG5jb25zdCBGRVdfU0hPVF9FWEFNUExFUyA9IGBcbioqRXhhbXBsZSAxOiBSZWNlbnQgTG9jYXRpb25zKipcblE6IFwiR2l2ZSBtZSB0aGUgbGFzdCB0ZW4gdW5pcXVlIGxvY2F0aW9ucyB3aGVyZSBteSBkZXZpY2VzIGhhdmUgcmVwb3J0ZWQgYSBsb2NhdGlvblwiXG5TUUw6XG5cXGBcXGBcXGBzcWxcblNFTEVDVCBESVNUSU5DVCBPTiAobGF0LCBsb24pXG4gIHNlcmlhbF9udW1iZXIsXG4gIHRpbWUsXG4gIGxhdCxcbiAgbG9uLFxuICBzb3VyY2VcbkZST00gYW5hbHl0aWNzLmxvY2F0aW9uc1xuV0hFUkUgc2VyaWFsX251bWJlciBJTiAoOmRldmljZUZpbHRlcilcbiAgQU5EIHRpbWUgPiBOT1coKSAtIElOVEVSVkFMICczMCBkYXlzJ1xuT1JERVIgQlkgbGF0LCBsb24sIHRpbWUgREVTQ1xuTElNSVQgMTA7XG5cXGBcXGBcXGBcblZpc3VhbGl6YXRpb246IG1hcFxuRXhwbGFuYXRpb246IFNob3dzIHRoZSAxMCBtb3N0IHJlY2VudCB1bmlxdWUgbG9jYXRpb25zIGFjcm9zcyBhbGwgZGV2aWNlcy5cblxuKipFeGFtcGxlIDI6IFRlbXBlcmF0dXJlIEFub21hbGllcyoqXG5ROiBcIlNob3cgbWUgYWxsIHRoZSB0aW1lcyB0aGF0IHRlbXBlcmF0dXJlIHNwaWtlZCBzdWRkZW5seVwiXG5TUUw6XG5cXGBcXGBcXGBzcWxcbldJVEggdGVtcF9jaGFuZ2VzIEFTIChcbiAgU0VMRUNUXG4gICAgc2VyaWFsX251bWJlcixcbiAgICB0aW1lLFxuICAgIHRlbXBlcmF0dXJlLFxuICAgIExBRyh0ZW1wZXJhdHVyZSkgT1ZFUiAoUEFSVElUSU9OIEJZIHNlcmlhbF9udW1iZXIgT1JERVIgQlkgdGltZSkgYXMgcHJldl90ZW1wLFxuICAgIHRlbXBlcmF0dXJlIC0gTEFHKHRlbXBlcmF0dXJlKSBPVkVSIChQQVJUSVRJT04gQlkgc2VyaWFsX251bWJlciBPUkRFUiBCWSB0aW1lKSBhcyB0ZW1wX2RpZmZcbiAgRlJPTSBhbmFseXRpY3MudGVsZW1ldHJ5XG4gIFdIRVJFIHNlcmlhbF9udW1iZXIgSU4gKDpkZXZpY2VGaWx0ZXIpXG4gICAgQU5EIHRpbWUgPiBOT1coKSAtIElOVEVSVkFMICc5MCBkYXlzJ1xuICAgIEFORCB0ZW1wZXJhdHVyZSBJUyBOT1QgTlVMTFxuKVxuU0VMRUNUXG4gIHNlcmlhbF9udW1iZXIsXG4gIHRpbWUsXG4gIHRlbXBlcmF0dXJlLFxuICBwcmV2X3RlbXAsXG4gIHRlbXBfZGlmZlxuRlJPTSB0ZW1wX2NoYW5nZXNcbldIRVJFIEFCUyh0ZW1wX2RpZmYpID4gNVxuT1JERVIgQlkgQUJTKHRlbXBfZGlmZikgREVTQ1xuTElNSVQgMTAwO1xuXFxgXFxgXFxgXG5WaXN1YWxpemF0aW9uOiBzY2F0dGVyXG5FeHBsYW5hdGlvbjogSWRlbnRpZmllcyBzdWRkZW4gdGVtcGVyYXR1cmUgY2hhbmdlcyBncmVhdGVyIHRoYW4gNcKwQy5cblxuKipFeGFtcGxlIDM6IFBvd2VyIFVzYWdlIE92ZXIgVGltZSoqXG5ROiBcIkdyYXBoIG15IHBvd2VyIHVzYWdlIGZvciB0aGUgbGFzdCB3ZWVrXCJcblNRTDpcblxcYFxcYFxcYHNxbFxuU0VMRUNUXG4gIERBVEVfVFJVTkMoJ2hvdXInLCB0aW1lKSBhcyBob3VyLFxuICBzZXJpYWxfbnVtYmVyLFxuICBBVkcodm9sdGFnZSkgYXMgYXZnX3ZvbHRhZ2UsXG4gIENPVU5UKCopIGFzIHJlYWRpbmdfY291bnRcbkZST00gYW5hbHl0aWNzLnRlbGVtZXRyeVxuV0hFUkUgc2VyaWFsX251bWJlciBJTiAoOmRldmljZUZpbHRlcilcbiAgQU5EIHRpbWUgPiBOT1coKSAtIElOVEVSVkFMICczMCBkYXlzJ1xuICBBTkQgdm9sdGFnZSBJUyBOT1QgTlVMTFxuR1JPVVAgQlkgREFURV9UUlVOQygnaG91cicsIHRpbWUpLCBzZXJpYWxfbnVtYmVyXG5PUkRFUiBCWSBob3VyO1xuXFxgXFxgXFxgXG5WaXN1YWxpemF0aW9uOiBsaW5lX2NoYXJ0XG5FeHBsYW5hdGlvbjogU2hvd3MgYXZlcmFnZSB2b2x0YWdlIChhcyBwcm94eSBmb3IgcG93ZXIgdXNhZ2UpIHBlciBob3VyLlxuXG4qKkV4YW1wbGUgNDogVGVtcGVyYXR1cmUgQ29tcGFyaXNvbioqXG5ROiBcIkNvbXBhcmUgdGhlIGF2ZXJhZ2UgdGVtcGVyYXR1cmUgYmV0d2VlbiBteSBkaWZmZXJlbnQgZGV2aWNlc1wiXG5TUUw6XG5cXGBcXGBcXGBzcWxcblNFTEVDVFxuICBkLnNlcmlhbF9udW1iZXIsXG4gIGQubmFtZSxcbiAgQVZHKHQudGVtcGVyYXR1cmUpIGFzIGF2Z190ZW1wLFxuICBNSU4odC50ZW1wZXJhdHVyZSkgYXMgbWluX3RlbXAsXG4gIE1BWCh0LnRlbXBlcmF0dXJlKSBhcyBtYXhfdGVtcCxcbiAgQ09VTlQoKikgYXMgcmVhZGluZ19jb3VudFxuRlJPTSBhbmFseXRpY3MuZGV2aWNlcyBkXG5MRUZUIEpPSU4gYW5hbHl0aWNzLnRlbGVtZXRyeSB0IE9OIGQuc2VyaWFsX251bWJlciA9IHQuc2VyaWFsX251bWJlclxuICBBTkQgdC50aW1lID4gTk9XKCkgLSBJTlRFUlZBTCAnMzAgZGF5cydcbldIRVJFIGQuc2VyaWFsX251bWJlciBJTiAoOmRldmljZUZpbHRlcilcbkdST1VQIEJZIGQuc2VyaWFsX251bWJlciwgZC5uYW1lXG5PUkRFUiBCWSBhdmdfdGVtcCBERVNDO1xuXFxgXFxgXFxgXG5WaXN1YWxpemF0aW9uOiBiYXJfY2hhcnRcbkV4cGxhbmF0aW9uOiBDb21wYXJlcyB0ZW1wZXJhdHVyZSBzdGF0aXN0aWNzIGFjcm9zcyBkZXZpY2VzLlxuXG4qKkV4YW1wbGUgNTogQWxlcnQgQW5hbHlzaXMqKlxuUTogXCJXaGF0IGRldmljZXMgaGF2ZSBhbGVydGVkIHRoZSBtb3N0IGluIHRoZSBwYXN0IG1vbnRoP1wiXG5TUUw6XG5cXGBcXGBcXGBzcWxcblNFTEVDVFxuICBzZXJpYWxfbnVtYmVyLFxuICBhbGVydF90eXBlLFxuICBDT1VOVCgqKSBhcyBhbGVydF9jb3VudCxcbiAgQ09VTlQoQ0FTRSBXSEVOIGFja25vd2xlZGdlZCBUSEVOIDEgRU5EKSBhcyBhY2tub3dsZWRnZWRfY291bnRcbkZST00gYW5hbHl0aWNzLmFsZXJ0c1xuV0hFUkUgc2VyaWFsX251bWJlciBJTiAoOmRldmljZUZpbHRlcilcbiAgQU5EIGNyZWF0ZWRfYXQgPiBFWFRSQUNUKEVQT0NIIEZST00gTk9XKCkgLSBJTlRFUlZBTCAnMzAgZGF5cycpXG5HUk9VUCBCWSBzZXJpYWxfbnVtYmVyLCBhbGVydF90eXBlXG5PUkRFUiBCWSBhbGVydF9jb3VudCBERVNDXG5MSU1JVCAyMDtcblxcYFxcYFxcYFxuVmlzdWFsaXphdGlvbjogdGFibGVcbkV4cGxhbmF0aW9uOiBTaG93cyBhbGVydCBmcmVxdWVuY3kgYnkgZGV2aWNlIGFuZCB0eXBlLlxuYDtcblxuY29uc3QgVEFTS19QUk9NUFQgPSBgXG5CYXNlZCBvbiB0aGUgdXNlcidzIHF1ZXN0aW9uLCBnZW5lcmF0ZTpcblxuMS4gQSBQb3N0Z3JlU1FMIHF1ZXJ5IGZvbGxvd2luZyB0aGUgc2NoZW1hIGFuZCBydWxlcyBhYm92ZVxuMi4gQSBzdWdnZXN0ZWQgdmlzdWFsaXphdGlvbiB0eXBlOiBsaW5lX2NoYXJ0LCBiYXJfY2hhcnQsIHRhYmxlLCBtYXAsIHNjYXR0ZXIsIG9yIGdhdWdlXG4zLiBBIGJyaWVmIGV4cGxhbmF0aW9uIG9mIHdoYXQgdGhlIHF1ZXJ5IGRvZXNcblxuUmV0dXJuIHlvdXIgcmVzcG9uc2UgaW4gdGhpcyBKU09OIGZvcm1hdDpcbntcbiAgXCJzcWxcIjogXCJTRUxFQ1QuLi5cIixcbiAgXCJ2aXN1YWxpemF0aW9uVHlwZVwiOiBcImxpbmVfY2hhcnRcIixcbiAgXCJleHBsYW5hdGlvblwiOiBcIlRoaXMgcXVlcnkgc2hvd3MuLi5cIlxufVxuXG4qKkNSSVRJQ0FMIFJFUVVJUkVNRU5UUzoqKlxuLSBNVVNUIGluY2x1ZGUgXCJXSEVSRSBzZXJpYWxfbnVtYmVyIElOICg6ZGV2aWNlRmlsdGVyKVwiIGluIGFsbCBxdWVyaWVzXG4tIE9OTFkgdXNlIFNFTEVDVCBzdGF0ZW1lbnRzIChubyBJTlNFUlQsIFVQREFURSwgREVMRVRFLCBEUk9QLCBldGMuKVxuLSBMaW1pdCByZXN1bHRzIHRvIDEwMDAgcm93cyBtYXhcbi0gVXNlIHByb3BlciBTUUwgc3ludGF4IGZvciBQb3N0Z3JlU1FMXG4tIFJldHVybiB2YWxpZCBKU09OIG9ubHlcbmA7XG5cbmludGVyZmFjZSBDaGF0UmVxdWVzdCB7XG4gIHF1ZXN0aW9uOiBzdHJpbmc7XG4gIHNlc3Npb25JZDogc3RyaW5nO1xuICB1c2VyRW1haWw6IHN0cmluZztcbiAgZGV2aWNlU2VyaWFsTnVtYmVycz86IHN0cmluZ1tdO1xufVxuXG5pbnRlcmZhY2UgUXVlcnlSZXN1bHQge1xuICBzcWw6IHN0cmluZztcbiAgdmlzdWFsaXphdGlvblR5cGU6IHN0cmluZztcbiAgZXhwbGFuYXRpb246IHN0cmluZztcbiAgZGF0YTogYW55W107XG4gIGluc2lnaHRzOiBzdHJpbmc7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlU1FMKHNxbDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGxvd2VyU1FMID0gc3FsLnRvTG93ZXJDYXNlKCk7XG5cbiAgLy8gT25seSBhbGxvdyBTRUxFQ1Qgc3RhdGVtZW50c1xuICBpZiAoIWxvd2VyU1FMLnRyaW0oKS5zdGFydHNXaXRoKCdzZWxlY3QnKSAmJiAhbG93ZXJTUUwudHJpbSgpLnN0YXJ0c1dpdGgoJ3dpdGgnKSkge1xuICAgIHRocm93IG5ldyBFcnJvcignT25seSBTRUxFQ1QgcXVlcmllcyBhcmUgYWxsb3dlZCcpO1xuICB9XG5cbiAgLy8gQmxvY2sgZGFuZ2Vyb3VzIGtleXdvcmRzXG4gIGNvbnN0IGRhbmdlcm91c0tleXdvcmRzID0gW1xuICAgICdpbnNlcnQnLCAndXBkYXRlJywgJ2RlbGV0ZScsICdkcm9wJywgJ3RydW5jYXRlJywgJ2FsdGVyJyxcbiAgICAnY3JlYXRlJywgJ2dyYW50JywgJ3Jldm9rZScsICdleGVjJywgJ2V4ZWN1dGUnXG4gIF07XG5cbiAgZm9yIChjb25zdCBrZXl3b3JkIG9mIGRhbmdlcm91c0tleXdvcmRzKSB7XG4gICAgaWYgKGxvd2VyU1FMLmluY2x1ZGVzKGtleXdvcmQpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEtleXdvcmQgJyR7a2V5d29yZH0nIGlzIG5vdCBhbGxvd2VkYCk7XG4gICAgfVxuICB9XG5cbiAgLy8gTXVzdCBpbmNsdWRlIGRldmljZSBmaWx0ZXJcbiAgaWYgKCFzcWwuaW5jbHVkZXMoJzpkZXZpY2VGaWx0ZXInKSkge1xuICAgIHRocm93IG5ldyBFcnJvcignUXVlcnkgbXVzdCBpbmNsdWRlIGRldmljZSBmaWx0ZXIgKDpkZXZpY2VGaWx0ZXIpJyk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2VuZXJhdGVTUUwocXVlc3Rpb246IHN0cmluZyk6IFByb21pc2U8eyBzcWw6IHN0cmluZzsgdmlzdWFsaXphdGlvblR5cGU6IHN0cmluZzsgZXhwbGFuYXRpb246IHN0cmluZyB9PiB7XG4gIGNvbnN0IHByb21wdCA9IGAke1NDSEVNQV9DT05URVhUfVxcblxcbiR7RkVXX1NIT1RfRVhBTVBMRVN9XFxuXFxuJHtUQVNLX1BST01QVH1cXG5cXG5Vc2VyIFF1ZXN0aW9uOiBcIiR7cXVlc3Rpb259XCJgO1xuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgYmVkcm9jay5zZW5kKG5ldyBJbnZva2VNb2RlbENvbW1hbmQoe1xuICAgIG1vZGVsSWQ6IEJFRFJPQ0tfTU9ERUxfSUQsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgYW50aHJvcGljX3ZlcnNpb246ICdiZWRyb2NrLTIwMjMtMDUtMzEnLFxuICAgICAgbWF4X3Rva2VuczogNDA5NixcbiAgICAgIG1lc3NhZ2VzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICByb2xlOiAndXNlcicsXG4gICAgICAgICAgY29udGVudDogcHJvbXB0LFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KSxcbiAgfSkpO1xuXG4gIGNvbnN0IHJlc3BvbnNlQm9keSA9IEpTT04ucGFyc2UobmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHJlc3BvbnNlLmJvZHkpKTtcbiAgY29uc3QgY29udGVudCA9IHJlc3BvbnNlQm9keS5jb250ZW50WzBdLnRleHQ7XG5cbiAgLy8gRXh0cmFjdCBKU09OIGZyb20gbWFya2Rvd24gY29kZSBibG9ja3MgaWYgcHJlc2VudFxuICBsZXQganNvblRleHQgPSBjb250ZW50O1xuICBjb25zdCBqc29uTWF0Y2ggPSBjb250ZW50Lm1hdGNoKC9gYGBqc29uXFxuKFtcXHNcXFNdKz8pXFxuYGBgLykgfHwgY29udGVudC5tYXRjaCgvYGBgXFxuKFtcXHNcXFNdKz8pXFxuYGBgLyk7XG4gIGlmIChqc29uTWF0Y2gpIHtcbiAgICBqc29uVGV4dCA9IGpzb25NYXRjaFsxXTtcbiAgfVxuXG4gIC8vIEZpeCBjb250cm9sIGNoYXJhY3RlcnMgaW4gSlNPTiBzdHJpbmcgdmFsdWVzIChDbGF1ZGUgb2Z0ZW4gaW5jbHVkZXMgdW5lc2NhcGVkIG5ld2xpbmVzIGluIFNRTClcbiAgLy8gVGhpcyByZWdleCBmaW5kcyBzdHJpbmcgdmFsdWVzIGFuZCBlc2NhcGVzIG5ld2xpbmVzL3RhYnMgd2l0aGluIHRoZW1cbiAganNvblRleHQgPSBqc29uVGV4dC5yZXBsYWNlKC9cIihbXlwiXFxcXF18XFxcXC4pKlwiL2csIChtYXRjaDogc3RyaW5nKSA9PiB7XG4gICAgcmV0dXJuIG1hdGNoXG4gICAgICAucmVwbGFjZSgvXFxuL2csICdcXFxcbicpXG4gICAgICAucmVwbGFjZSgvXFxyL2csICdcXFxccicpXG4gICAgICAucmVwbGFjZSgvXFx0L2csICdcXFxcdCcpO1xuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBKU09OLnBhcnNlKGpzb25UZXh0KTtcbiAgcmV0dXJuIHJlc3VsdDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZVF1ZXJ5KHNxbDogc3RyaW5nLCBkZXZpY2VTZXJpYWxOdW1iZXJzOiBzdHJpbmdbXSk6IFByb21pc2U8YW55W10+IHtcbiAgLy8gUmVwbGFjZSBkZXZpY2UgZmlsdGVyIHBsYWNlaG9sZGVyXG4gIGNvbnN0IGRldmljZUxpc3QgPSBkZXZpY2VTZXJpYWxOdW1iZXJzLm1hcChzbiA9PiBgJyR7c24ucmVwbGFjZSgvJy9nLCBcIicnXCIpfSdgKS5qb2luKCcsICcpO1xuICBjb25zdCBmaW5hbFNRTCA9IHNxbC5yZXBsYWNlKCc6ZGV2aWNlRmlsdGVyJywgZGV2aWNlTGlzdCk7XG5cbiAgY29uc29sZS5sb2coJ0V4ZWN1dGluZyBTUUw6JywgZmluYWxTUUwpO1xuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcmRzLnNlbmQobmV3IEV4ZWN1dGVTdGF0ZW1lbnRDb21tYW5kKHtcbiAgICByZXNvdXJjZUFybjogQ0xVU1RFUl9BUk4sXG4gICAgc2VjcmV0QXJuOiBTRUNSRVRfQVJOLFxuICAgIGRhdGFiYXNlOiBEQVRBQkFTRV9OQU1FLFxuICAgIHNxbDogZmluYWxTUUwsXG4gICAgaW5jbHVkZVJlc3VsdE1ldGFkYXRhOiB0cnVlLFxuICB9KSk7XG5cbiAgaWYgKCFyZXNwb25zZS5yZWNvcmRzKSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG5cbiAgLy8gQ29udmVydCBSRFMgRGF0YSBBUEkgZm9ybWF0IHRvIEpTT05cbiAgY29uc3QgY29sdW1uTWV0YWRhdGEgPSByZXNwb25zZS5jb2x1bW5NZXRhZGF0YSB8fCBbXTtcbiAgY29uc3QgcmVjb3JkcyA9IHJlc3BvbnNlLnJlY29yZHMubWFwKHJlY29yZCA9PiB7XG4gICAgY29uc3Qgcm93OiBhbnkgPSB7fTtcbiAgICByZWNvcmQuZm9yRWFjaCgoZmllbGQsIGluZGV4KSA9PiB7XG4gICAgICBjb25zdCBjb2x1bW5OYW1lID0gY29sdW1uTWV0YWRhdGFbaW5kZXhdPy5uYW1lIHx8IGBjb2x1bW5fJHtpbmRleH1gO1xuICAgICAgLy8gQ2hlY2sgZWFjaCBmaWVsZCB0eXBlIGV4cGxpY2l0bHkgdG8gaGFuZGxlIDAgYW5kIGZhbHNlIHZhbHVlcyBjb3JyZWN0bHlcbiAgICAgIGxldCB2YWx1ZTogYW55ID0gbnVsbDtcbiAgICAgIGlmIChmaWVsZC5zdHJpbmdWYWx1ZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHZhbHVlID0gZmllbGQuc3RyaW5nVmFsdWU7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkLmxvbmdWYWx1ZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHZhbHVlID0gZmllbGQubG9uZ1ZhbHVlO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZC5kb3VibGVWYWx1ZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHZhbHVlID0gZmllbGQuZG91YmxlVmFsdWU7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkLmJvb2xlYW5WYWx1ZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHZhbHVlID0gZmllbGQuYm9vbGVhblZhbHVlO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZC5pc051bGwpIHtcbiAgICAgICAgdmFsdWUgPSBudWxsO1xuICAgICAgfVxuICAgICAgcm93W2NvbHVtbk5hbWVdID0gdmFsdWU7XG4gICAgfSk7XG4gICAgcmV0dXJuIHJvdztcbiAgfSk7XG5cbiAgcmV0dXJuIHJlY29yZHM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdlbmVyYXRlSW5zaWdodHMocXVlc3Rpb246IHN0cmluZywgc3FsOiBzdHJpbmcsIGRhdGE6IGFueVtdKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgcHJvbXB0ID0gYFxuWW91IGFuYWx5emVkIElvVCBkZXZpY2UgZGF0YSBmb3IgdGhpcyBxdWVzdGlvbjogXCIke3F1ZXN0aW9ufVwiXG5cblNRTCBRdWVyeSBleGVjdXRlZDpcblxcYFxcYFxcYHNxbFxuJHtzcWx9XG5cXGBcXGBcXGBcblxuUXVlcnkgUmVzdWx0cyAoJHtkYXRhLmxlbmd0aH0gcm93cyk6XG4ke0pTT04uc3RyaW5naWZ5KGRhdGEuc2xpY2UoMCwgMTApLCBudWxsLCAyKX1cbiR7ZGF0YS5sZW5ndGggPiAxMCA/IGBcXG4uLi4gYW5kICR7ZGF0YS5sZW5ndGggLSAxMH0gbW9yZSByb3dzYCA6ICcnfVxuXG5HZW5lcmF0ZSBhIDItMyBzZW50ZW5jZSBpbnNpZ2h0IHN1bW1hcnkgaGlnaGxpZ2h0aW5nOlxuMS4gS2V5IGZpbmRpbmdzIGZyb20gdGhlIGRhdGFcbjIuIEFueSBub3RhYmxlIHBhdHRlcm5zIG9yIGFub21hbGllc1xuMy4gQWN0aW9uYWJsZSByZWNvbW1lbmRhdGlvbnMgaWYgYXBwbGljYWJsZVxuXG5LZWVwIGl0IGNvbmNpc2UgYW5kIHVzZXItZnJpZW5kbHkuXG5gO1xuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgYmVkcm9jay5zZW5kKG5ldyBJbnZva2VNb2RlbENvbW1hbmQoe1xuICAgIG1vZGVsSWQ6IEJFRFJPQ0tfTU9ERUxfSUQsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgYW50aHJvcGljX3ZlcnNpb246ICdiZWRyb2NrLTIwMjMtMDUtMzEnLFxuICAgICAgbWF4X3Rva2VuczogNTAwLFxuICAgICAgbWVzc2FnZXM6IFt7IHJvbGU6ICd1c2VyJywgY29udGVudDogcHJvbXB0IH1dLFxuICAgIH0pLFxuICB9KSk7XG5cbiAgY29uc3QgcmVzcG9uc2VCb2R5ID0gSlNPTi5wYXJzZShuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUocmVzcG9uc2UuYm9keSkpO1xuICByZXR1cm4gcmVzcG9uc2VCb2R5LmNvbnRlbnRbMF0udGV4dDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc2F2ZUNoYXRIaXN0b3J5KHJlcXVlc3Q6IENoYXRSZXF1ZXN0LCByZXN1bHQ6IFF1ZXJ5UmVzdWx0KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRpbWVzdGFtcCA9IERhdGUubm93KCk7XG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgKDkwICogMjQgKiA2MCAqIDYwKTsgLy8gOTAgZGF5c1xuXG4gIGF3YWl0IGRkYi5zZW5kKG5ldyBQdXRDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IENIQVRfSElTVE9SWV9UQUJMRSxcbiAgICBJdGVtOiB7XG4gICAgICB1c2VyX2VtYWlsOiByZXF1ZXN0LnVzZXJFbWFpbCxcbiAgICAgIHRpbWVzdGFtcCxcbiAgICAgIHNlc3Npb25faWQ6IHJlcXVlc3Quc2Vzc2lvbklkLFxuICAgICAgcXVlc3Rpb246IHJlcXVlc3QucXVlc3Rpb24sXG4gICAgICBzcWw6IHJlc3VsdC5zcWwsXG4gICAgICB2aXN1YWxpemF0aW9uX3R5cGU6IHJlc3VsdC52aXN1YWxpemF0aW9uVHlwZSxcbiAgICAgIGV4cGxhbmF0aW9uOiByZXN1bHQuZXhwbGFuYXRpb24sXG4gICAgICByb3dfY291bnQ6IHJlc3VsdC5kYXRhLmxlbmd0aCxcbiAgICAgIGluc2lnaHRzOiByZXN1bHQuaW5zaWdodHMsXG4gICAgICB0dGwsXG4gICAgfSxcbiAgfSkpO1xufVxuXG5leHBvcnQgY29uc3QgaGFuZGxlciA9IGFzeW5jIChldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQpOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4gPT4ge1xuICB0cnkge1xuICAgIGNvbnN0IHJlcXVlc3Q6IENoYXRSZXF1ZXN0ID0gSlNPTi5wYXJzZShldmVudC5ib2R5IHx8ICd7fScpO1xuXG4gICAgaWYgKCFyZXF1ZXN0LnF1ZXN0aW9uIHx8ICFyZXF1ZXN0LnNlc3Npb25JZCB8fCAhcmVxdWVzdC51c2VyRW1haWwpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICAgICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbic6ICcqJyxcbiAgICAgICAgfSxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ01pc3NpbmcgcmVxdWlyZWQgZmllbGRzJyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gR2V0IHVzZXIncyBhY2Nlc3NpYmxlIGRldmljZXMgKGZyb20gQ29nbml0byBjbGFpbXMgb3IgZGF0YWJhc2UpXG4gICAgLy8gSWYgbm8gZGV2aWNlcyBzcGVjaWZpZWQsIGZldGNoIGFsbCBkZXZpY2Ugc2VyaWFsIG51bWJlcnMgZnJvbSBBdXJvcmFcbiAgICBsZXQgZGV2aWNlU2VyaWFsTnVtYmVycyA9IHJlcXVlc3QuZGV2aWNlU2VyaWFsTnVtYmVycztcblxuICAgIGlmICghZGV2aWNlU2VyaWFsTnVtYmVycyB8fCBkZXZpY2VTZXJpYWxOdW1iZXJzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgY29uc3QgZGV2aWNlc1Jlc3VsdCA9IGF3YWl0IHJkcy5zZW5kKG5ldyBFeGVjdXRlU3RhdGVtZW50Q29tbWFuZCh7XG4gICAgICAgIHJlc291cmNlQXJuOiBDTFVTVEVSX0FSTixcbiAgICAgICAgc2VjcmV0QXJuOiBTRUNSRVRfQVJOLFxuICAgICAgICBkYXRhYmFzZTogREFUQUJBU0VfTkFNRSxcbiAgICAgICAgc3FsOiAnU0VMRUNUIERJU1RJTkNUIHNlcmlhbF9udW1iZXIgRlJPTSBhbmFseXRpY3MuZGV2aWNlcycsXG4gICAgICB9KSk7XG5cbiAgICAgIGRldmljZVNlcmlhbE51bWJlcnMgPSAoZGV2aWNlc1Jlc3VsdC5yZWNvcmRzIHx8IFtdKVxuICAgICAgICAubWFwKHJlY29yZCA9PiByZWNvcmRbMF0/LnN0cmluZ1ZhbHVlKVxuICAgICAgICAuZmlsdGVyKChzbik6IHNuIGlzIHN0cmluZyA9PiAhIXNuKTtcblxuICAgICAgLy8gRmFsbGJhY2s6IGFsc28gY2hlY2sgdGVsZW1ldHJ5IHRhYmxlIGlmIGRldmljZXMgdGFibGUgaXMgZW1wdHlcbiAgICAgIGlmIChkZXZpY2VTZXJpYWxOdW1iZXJzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBjb25zdCB0ZWxlbWV0cnlSZXN1bHQgPSBhd2FpdCByZHMuc2VuZChuZXcgRXhlY3V0ZVN0YXRlbWVudENvbW1hbmQoe1xuICAgICAgICAgIHJlc291cmNlQXJuOiBDTFVTVEVSX0FSTixcbiAgICAgICAgICBzZWNyZXRBcm46IFNFQ1JFVF9BUk4sXG4gICAgICAgICAgZGF0YWJhc2U6IERBVEFCQVNFX05BTUUsXG4gICAgICAgICAgc3FsOiAnU0VMRUNUIERJU1RJTkNUIHNlcmlhbF9udW1iZXIgRlJPTSBhbmFseXRpY3MudGVsZW1ldHJ5IExJTUlUIDEwMCcsXG4gICAgICAgIH0pKTtcblxuICAgICAgICBkZXZpY2VTZXJpYWxOdW1iZXJzID0gKHRlbGVtZXRyeVJlc3VsdC5yZWNvcmRzIHx8IFtdKVxuICAgICAgICAgIC5tYXAocmVjb3JkID0+IHJlY29yZFswXT8uc3RyaW5nVmFsdWUpXG4gICAgICAgICAgLmZpbHRlcigoc24pOiBzbiBpcyBzdHJpbmcgPT4gISFzbik7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc29sZS5sb2coJ1Byb2Nlc3NpbmcgcXVlc3Rpb246JywgcmVxdWVzdC5xdWVzdGlvbik7XG4gICAgY29uc29sZS5sb2coJ0RldmljZSBmaWx0ZXI6JywgZGV2aWNlU2VyaWFsTnVtYmVycyk7XG5cbiAgICAvLyBTdGVwIDE6IEdlbmVyYXRlIFNRTCB1c2luZyBCZWRyb2NrXG4gICAgY29uc3QgeyBzcWwsIHZpc3VhbGl6YXRpb25UeXBlLCBleHBsYW5hdGlvbiB9ID0gYXdhaXQgZ2VuZXJhdGVTUUwocmVxdWVzdC5xdWVzdGlvbik7XG5cbiAgICAvLyBTdGVwIDI6IFZhbGlkYXRlIFNRTFxuICAgIHZhbGlkYXRlU1FMKHNxbCk7XG5cbiAgICAvLyBTdGVwIDM6IEV4ZWN1dGUgcXVlcnlcbiAgICBjb25zdCBkYXRhID0gYXdhaXQgZXhlY3V0ZVF1ZXJ5KHNxbCwgZGV2aWNlU2VyaWFsTnVtYmVycyk7XG5cbiAgICAvLyBTdGVwIDQ6IEdlbmVyYXRlIGluc2lnaHRzXG4gICAgY29uc3QgaW5zaWdodHMgPSBhd2FpdCBnZW5lcmF0ZUluc2lnaHRzKHJlcXVlc3QucXVlc3Rpb24sIHNxbCwgZGF0YSk7XG5cbiAgICAvLyBTdGVwIDU6IEJ1aWxkIHJlc3VsdFxuICAgIGNvbnN0IHJlc3VsdDogUXVlcnlSZXN1bHQgPSB7XG4gICAgICBzcWwsXG4gICAgICB2aXN1YWxpemF0aW9uVHlwZSxcbiAgICAgIGV4cGxhbmF0aW9uLFxuICAgICAgZGF0YSxcbiAgICAgIGluc2lnaHRzLFxuICAgIH07XG5cbiAgICAvLyBTdGVwIDY6IFNhdmUgdG8gY2hhdCBoaXN0b3J5XG4gICAgYXdhaXQgc2F2ZUNoYXRIaXN0b3J5KHJlcXVlc3QsIHJlc3VsdCk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgaGVhZGVyczoge1xuICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJzogJyonLFxuICAgICAgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHJlc3VsdCksXG4gICAgfTtcblxuICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgY29uc29sZS5lcnJvcignQ2hhdCBxdWVyeSBlcnJvcjonLCBlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMCxcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbic6ICcqJyxcbiAgICAgIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGVycm9yOiBlcnJvci5tZXNzYWdlIHx8ICdJbnRlcm5hbCBzZXJ2ZXIgZXJyb3InLFxuICAgICAgfSksXG4gICAgfTtcbiAgfVxufTtcbiJdfQ==