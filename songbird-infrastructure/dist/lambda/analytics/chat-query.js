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
const api_1 = require("@opentelemetry/api");
(0, tracing_1.initializeTracing)('songbird-analytics-chat-query');
const client_bedrock_runtime_1 = require("@aws-sdk/client-bedrock-runtime");
const client_rds_data_1 = require("@aws-sdk/client-rds-data");
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const phoenix_prompts_1 = require("../shared/phoenix-prompts");
const bedrock = new client_bedrock_runtime_1.BedrockRuntimeClient({ region: 'us-east-1' });
const rds = new client_rds_data_1.RDSDataClient({});
const ddbClient = new client_dynamodb_1.DynamoDBClient({});
const ddb = lib_dynamodb_1.DynamoDBDocumentClient.from(ddbClient);
const CLUSTER_ARN = process.env.CLUSTER_ARN;
const SECRET_ARN = process.env.SECRET_ARN;
const DATABASE_NAME = process.env.DATABASE_NAME;
const CHAT_HISTORY_TABLE = process.env.CHAT_HISTORY_TABLE;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID;
// Model pricing (USD per 1M tokens) - Updated January 2025
// Source: https://aws.amazon.com/bedrock/pricing/
const MODEL_PRICING = {
    // Claude 3.5 Sonnet v2
    'us.anthropic.claude-3-5-sonnet-20241022-v2:0': { input: 3.00, output: 15.00 },
    // Claude 3.5 Sonnet v1
    'anthropic.claude-3-5-sonnet-20240620-v1:0': { input: 3.00, output: 15.00 },
    // Claude 3 Opus
    'anthropic.claude-3-opus-20240229-v1:0': { input: 15.00, output: 75.00 },
    // Claude 3 Sonnet
    'anthropic.claude-3-sonnet-20240229-v1:0': { input: 3.00, output: 15.00 },
    // Claude 3 Haiku
    'anthropic.claude-3-haiku-20240307-v1:0': { input: 0.25, output: 1.25 },
};
// Fallback prompt constants (used when Phoenix Prompt Hub is unreachable)
const FALLBACK_SCHEMA_CONTEXT = `
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
const FALLBACK_FEW_SHOT_EXAMPLES = `
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
const FALLBACK_TASK_PROMPT = `
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
// Composed fallback prompts (match the templates stored in Phoenix Prompt Hub)
const FALLBACK_SQL_PROMPT = `${FALLBACK_SCHEMA_CONTEXT}\n\n${FALLBACK_FEW_SHOT_EXAMPLES}\n\n${FALLBACK_TASK_PROMPT}\n\nUser Question: "{{question}}"`;
const FALLBACK_INSIGHTS_PROMPT = `You analyzed IoT device data for this question: "{{question}}"

SQL Query executed:
\`\`\`sql
{{sql}}
\`\`\`

Query Results ({{data_count}} rows):
{{data_preview}}

Generate a 2-3 sentence insight summary highlighting:
1. Key findings from the data
2. Any notable patterns or anomalies
3. Actionable recommendations if applicable

Keep it concise and user-friendly.`;
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
/**
 * Calculate LLM cost based on token usage
 */
function calculateCost(modelId, inputTokens, outputTokens) {
    const pricing = MODEL_PRICING[modelId] || { input: 0, output: 0 };
    // Convert from per-1M-tokens to actual cost
    const inputCost = (inputTokens / 1000000) * pricing.input;
    const outputCost = (outputTokens / 1000000) * pricing.output;
    const totalCost = inputCost + outputCost;
    return {
        input: inputCost,
        output: outputCost,
        total: totalCost,
    };
}
async function generateSQL(question) {
    // Fetch prompt config from Phoenix (falls back to hardcoded if unavailable)
    const promptConfig = await (0, phoenix_prompts_1.getPromptTemplate)('songbird-sql-generator', FALLBACK_SQL_PROMPT);
    const prompt = (0, phoenix_prompts_1.renderTemplate)(promptConfig.template, { question });
    // Phoenix stores Anthropic API model IDs; map to Bedrock equivalents
    const modelId = (promptConfig.modelName && (0, phoenix_prompts_1.toBedrockModelId)(promptConfig.modelName)) || BEDROCK_MODEL_ID;
    const maxTokens = promptConfig.maxTokens || 4096;
    const { response, responseBody, content } = await (0, tracing_1.traceAsyncFn)('bedrock.generate_sql', async (span) => {
        span.setAttribute('llm.model_name', modelId);
        span.setAttribute('llm.system', 'aws-bedrock');
        span.setAttribute('llm.invocation_parameters', JSON.stringify({ max_tokens: maxTokens }));
        // Log the user's original question
        span.setAttribute('input.value', question);
        // Log the full prompt (OpenInference flattened message format)
        span.setAttribute('llm.input_messages.0.message.role', 'user');
        span.setAttribute('llm.input_messages.0.message.content', prompt);
        const response = await bedrock.send(new client_bedrock_runtime_1.InvokeModelCommand({
            modelId,
            body: JSON.stringify({
                anthropic_version: 'bedrock-2023-05-31',
                max_tokens: maxTokens,
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
        // Log the LLM's response (OpenInference flattened message format)
        span.setAttribute('llm.output_messages.0.message.role', 'assistant');
        span.setAttribute('llm.output_messages.0.message.content', content);
        span.setAttribute('output.value', content);
        // Token counts (OpenInference semantic conventions)
        const inputTokens = responseBody.usage?.input_tokens || 0;
        const outputTokens = responseBody.usage?.output_tokens || 0;
        span.setAttribute('llm.token_count.prompt', inputTokens);
        span.setAttribute('llm.token_count.completion', outputTokens);
        span.setAttribute('llm.token_count.total', inputTokens + outputTokens);
        // Calculate and log costs
        const cost = calculateCost(modelId, inputTokens, outputTokens);
        span.setAttribute('llm.cost.input_usd', cost.input);
        span.setAttribute('llm.cost.output_usd', cost.output);
        span.setAttribute('llm.cost.total_usd', cost.total);
        return { response, responseBody, content };
    }, {
        'openinference.span.kind': 'LLM',
    });
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
    // Fetch prompt config from Phoenix (falls back to hardcoded if unavailable)
    const promptConfig = await (0, phoenix_prompts_1.getPromptTemplate)('songbird-insights-generator', FALLBACK_INSIGHTS_PROMPT);
    const dataPreview = JSON.stringify(data.slice(0, 10), null, 2) +
        (data.length > 10 ? `\n... and ${data.length - 10} more rows` : '');
    const prompt = (0, phoenix_prompts_1.renderTemplate)(promptConfig.template, {
        question,
        sql,
        data_preview: dataPreview,
        data_count: String(data.length),
    });
    // Phoenix stores Anthropic API model IDs; map to Bedrock equivalents
    const modelId = (promptConfig.modelName && (0, phoenix_prompts_1.toBedrockModelId)(promptConfig.modelName)) || BEDROCK_MODEL_ID;
    const maxTokens = promptConfig.maxTokens || 500;
    return await (0, tracing_1.traceAsyncFn)('bedrock.generate_insights', async (span) => {
        span.setAttribute('llm.model_name', modelId);
        span.setAttribute('llm.system', 'aws-bedrock');
        span.setAttribute('llm.invocation_parameters', JSON.stringify({ max_tokens: maxTokens }));
        // Log context (OpenInference input/output values)
        span.setAttribute('input.value', question);
        span.setAttribute('sql.query', sql);
        span.setAttribute('sql.result_count', data.length);
        // Log the full prompt (OpenInference flattened message format)
        span.setAttribute('llm.input_messages.0.message.role', 'user');
        span.setAttribute('llm.input_messages.0.message.content', prompt);
        const response = await bedrock.send(new client_bedrock_runtime_1.InvokeModelCommand({
            modelId,
            body: JSON.stringify({
                anthropic_version: 'bedrock-2023-05-31',
                max_tokens: maxTokens,
                messages: [{ role: 'user', content: prompt }],
            }),
        }));
        const responseBody = JSON.parse(new TextDecoder().decode(response.body));
        const content = responseBody.content[0].text;
        // Log the LLM's response (OpenInference flattened message format)
        span.setAttribute('llm.output_messages.0.message.role', 'assistant');
        span.setAttribute('llm.output_messages.0.message.content', content);
        span.setAttribute('output.value', content);
        // Token counts (OpenInference semantic conventions)
        const inputTokens = responseBody.usage?.input_tokens || 0;
        const outputTokens = responseBody.usage?.output_tokens || 0;
        span.setAttribute('llm.token_count.prompt', inputTokens);
        span.setAttribute('llm.token_count.completion', outputTokens);
        span.setAttribute('llm.token_count.total', inputTokens + outputTokens);
        // Calculate and log costs
        const cost = calculateCost(modelId, inputTokens, outputTokens);
        span.setAttribute('llm.cost.input_usd', cost.input);
        span.setAttribute('llm.cost.output_usd', cost.output);
        span.setAttribute('llm.cost.total_usd', cost.total);
        return content;
    }, {
        'openinference.span.kind': 'LLM',
    });
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
        let deviceSerialNumbers = request.deviceSerialNumbers || [];
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
        // Wrap the entire pipeline in a CHAIN span so all steps are grouped in Phoenix
        const result = await (0, tracing_1.traceAsyncFn)('chat_query', async (chainSpan) => {
            chainSpan.setAttribute('input.value', request.question);
            chainSpan.setAttribute('user.email', request.userEmail);
            chainSpan.setAttribute('session.id', request.sessionId);
            chainSpan.setAttribute('device.count', deviceSerialNumbers.length);
            // Step 1: Generate SQL using Bedrock
            const { sql, visualizationType, explanation } = await generateSQL(request.question);
            // Step 2: Validate SQL
            await (0, tracing_1.traceAsyncFn)('validate_sql', async (span) => {
                span.setAttribute('input.value', sql);
                validateSQL(sql);
                span.setAttribute('output.value', 'valid');
            }, { 'openinference.span.kind': 'TOOL' }, api_1.SpanKind.INTERNAL);
            // Step 3: Execute query
            const data = await (0, tracing_1.traceAsyncFn)('execute_sql', async (span) => {
                span.setAttribute('input.value', sql);
                span.setAttribute('sql.query', sql);
                span.setAttribute('db.system', 'postgresql');
                span.setAttribute('db.name', DATABASE_NAME);
                const rows = await executeQuery(sql, deviceSerialNumbers);
                span.setAttribute('output.value', `${rows.length} rows returned`);
                span.setAttribute('sql.result_count', rows.length);
                return rows;
            }, { 'openinference.span.kind': 'TOOL' }, api_1.SpanKind.CLIENT);
            // Step 4: Generate insights
            const insights = await generateInsights(request.question, sql, data);
            // Step 5: Build result
            const queryResult = {
                sql,
                visualizationType,
                explanation,
                data,
                insights,
            };
            chainSpan.setAttribute('output.value', insights);
            chainSpan.setAttribute('sql.query', sql);
            chainSpan.setAttribute('sql.result_count', data.length);
            // Step 6: Save to chat history
            await saveChatHistory(request, queryResult);
            return queryResult;
        }, { 'openinference.span.kind': 'CHAIN' }, api_1.SpanKind.SERVER);
        // Flush spans to Phoenix before Lambda freezes
        await (0, tracing_1.flushSpans)();
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
        // Flush spans even on error
        await (0, tracing_1.flushSpans)();
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2hhdC1xdWVyeS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL2xhbWJkYS9hbmFseXRpY3MvY2hhdC1xdWVyeS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7OztHQU1HOzs7QUFFSCxzREFBc0Q7QUFDdEQsK0NBQWdGO0FBQ2hGLDRDQUE4QztBQUM5QyxJQUFBLDJCQUFpQixFQUFDLCtCQUErQixDQUFDLENBQUM7QUFHbkQsNEVBQTJGO0FBQzNGLDhEQUFrRjtBQUNsRiw4REFBMEQ7QUFDMUQsd0RBQTJFO0FBQzNFLCtEQUFtSDtBQUVuSCxNQUFNLE9BQU8sR0FBRyxJQUFJLDZDQUFvQixDQUFDLEVBQUUsTUFBTSxFQUFFLFdBQVcsRUFBRSxDQUFDLENBQUM7QUFDbEUsTUFBTSxHQUFHLEdBQUcsSUFBSSwrQkFBYSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQ2xDLE1BQU0sU0FBUyxHQUFHLElBQUksZ0NBQWMsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN6QyxNQUFNLEdBQUcsR0FBRyxxQ0FBc0IsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7QUFFbkQsTUFBTSxXQUFXLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxXQUFZLENBQUM7QUFDN0MsTUFBTSxVQUFVLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxVQUFXLENBQUM7QUFDM0MsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxhQUFjLENBQUM7QUFDakQsTUFBTSxrQkFBa0IsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGtCQUFtQixDQUFDO0FBQzNELE1BQU0sZ0JBQWdCLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQkFBaUIsQ0FBQztBQUV2RCwyREFBMkQ7QUFDM0Qsa0RBQWtEO0FBQ2xELE1BQU0sYUFBYSxHQUFzRDtJQUN2RSx1QkFBdUI7SUFDdkIsOENBQThDLEVBQUUsRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFB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UUFFRiwrQ0FBK0M7UUFDL0MsTUFBTSxJQUFBLG9CQUFVLEdBQUUsQ0FBQztRQUVuQixPQUFPO1lBQ0wsVUFBVSxFQUFFLEdBQUc7WUFDZixPQUFPLEVBQUU7Z0JBQ1AsY0FBYyxFQUFFLGtCQUFrQjtnQkFDbEMsNkJBQTZCLEVBQUUsR0FBRzthQUNuQztZQUNELElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLE1BQU0sQ0FBQztTQUM3QixDQUFDO0lBRUosQ0FBQztJQUFDLE9BQU8sS0FBVSxFQUFFLENBQUM7UUFDcEIsT0FBTyxDQUFDLEtBQUssQ0FBQyxtQkFBbUIsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUUxQyw0QkFBNEI7UUFDNUIsTUFBTSxJQUFBLG9CQUFVLEdBQUUsQ0FBQztRQUVuQixPQUFPO1lBQ0wsVUFBVSxFQUFFLEdBQUc7WUFDZixPQUFPLEVBQUU7Z0JBQ1AsY0FBYyxFQUFFLGtCQUFrQjtnQkFDbEMsNkJBQTZCLEVBQUUsR0FBRzthQUNuQztZQUNELElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDO2dCQUNuQixLQUFLLEVBQUUsS0FBSyxDQUFDLE9BQU8sSUFBSSx1QkFBdUI7YUFDaEQsQ0FBQztTQUNILENBQUM7SUFDSixDQUFDO0FBQ0gsQ0FBQyxDQUFDO0FBaEpXLFFBQUEsT0FBTyxXQWdKbEIiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEFuYWx5dGljcyBDaGF0IFF1ZXJ5IExhbWJkYVxuICpcbiAqIFRleHQtdG8tU1FMIHBvd2VyZWQgYnkgQVdTIEJlZHJvY2sgKENsYXVkZSAzLjUgU29ubmV0KS5cbiAqIENvbnZlcnRzIG5hdHVyYWwgbGFuZ3VhZ2UgcXVlc3Rpb25zIGludG8gU1FMIHF1ZXJpZXMsIGV4ZWN1dGVzIHRoZW0gb24gQXVyb3JhLFxuICogYW5kIGdlbmVyYXRlcyBpbnNpZ2h0cyBhbmQgdmlzdWFsaXphdGlvbnMuXG4gKi9cblxuLy8gSW5pdGlhbGl6ZSBQaG9lbml4IHRyYWNpbmcgYmVmb3JlIGFueSBvdGhlciBpbXBvcnRzXG5pbXBvcnQgeyBpbml0aWFsaXplVHJhY2luZywgdHJhY2VBc3luY0ZuLCBmbHVzaFNwYW5zIH0gZnJvbSAnLi4vc2hhcmVkL3RyYWNpbmcnO1xuaW1wb3J0IHsgU3BhbktpbmQgfSBmcm9tICdAb3BlbnRlbGVtZXRyeS9hcGknO1xuaW5pdGlhbGl6ZVRyYWNpbmcoJ3NvbmdiaXJkLWFuYWx5dGljcy1jaGF0LXF1ZXJ5Jyk7XG5cbmltcG9ydCB7IEFQSUdhdGV3YXlQcm94eUV2ZW50LCBBUElHYXRld2F5UHJveHlSZXN1bHQgfSBmcm9tICdhd3MtbGFtYmRhJztcbmltcG9ydCB7IEJlZHJvY2tSdW50aW1lQ2xpZW50LCBJbnZva2VNb2RlbENvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtYmVkcm9jay1ydW50aW1lJztcbmltcG9ydCB7IFJEU0RhdGFDbGllbnQsIEV4ZWN1dGVTdGF0ZW1lbnRDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LXJkcy1kYXRhJztcbmltcG9ydCB7IER5bmFtb0RCQ2xpZW50IH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LWR5bmFtb2RiJztcbmltcG9ydCB7IER5bmFtb0RCRG9jdW1lbnRDbGllbnQsIFB1dENvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9saWItZHluYW1vZGInO1xuaW1wb3J0IHsgZ2V0UHJvbXB0VGVtcGxhdGUsIHJlbmRlclRlbXBsYXRlLCB0b0JlZHJvY2tNb2RlbElkLCB0eXBlIFByb21wdENvbmZpZyB9IGZyb20gJy4uL3NoYXJlZC9waG9lbml4LXByb21wdHMnO1xuXG5jb25zdCBiZWRyb2NrID0gbmV3IEJlZHJvY2tSdW50aW1lQ2xpZW50KHsgcmVnaW9uOiAndXMtZWFzdC0xJyB9KTtcbmNvbnN0IHJkcyA9IG5ldyBSRFNEYXRhQ2xpZW50KHt9KTtcbmNvbnN0IGRkYkNsaWVudCA9IG5ldyBEeW5hbW9EQkNsaWVudCh7fSk7XG5jb25zdCBkZGIgPSBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LmZyb20oZGRiQ2xpZW50KTtcblxuY29uc3QgQ0xVU1RFUl9BUk4gPSBwcm9jZXNzLmVudi5DTFVTVEVSX0FSTiE7XG5jb25zdCBTRUNSRVRfQVJOID0gcHJvY2Vzcy5lbnYuU0VDUkVUX0FSTiE7XG5jb25zdCBEQVRBQkFTRV9OQU1FID0gcHJvY2Vzcy5lbnYuREFUQUJBU0VfTkFNRSE7XG5jb25zdCBDSEFUX0hJU1RPUllfVEFCTEUgPSBwcm9jZXNzLmVudi5DSEFUX0hJU1RPUllfVEFCTEUhO1xuY29uc3QgQkVEUk9DS19NT0RFTF9JRCA9IHByb2Nlc3MuZW52LkJFRFJPQ0tfTU9ERUxfSUQhO1xuXG4vLyBNb2RlbCBwcmljaW5nIChVU0QgcGVyIDFNIHRva2VucykgLSBVcGRhdGVkIEphbnVhcnkgMjAyNVxuLy8gU291cmNlOiBodHRwczovL2F3cy5hbWF6b24uY29tL2JlZHJvY2svcHJpY2luZy9cbmNvbnN0IE1PREVMX1BSSUNJTkc6IFJlY29yZDxzdHJpbmcsIHsgaW5wdXQ6IG51bWJlcjsgb3V0cHV0OiBudW1iZXIgfT4gPSB7XG4gIC8vIENsYXVkZSAzLjUgU29ubmV0IHYyXG4gICd1cy5hbnRocm9waWMuY2xhdWRlLTMtNS1zb25uZXQtMjAyNDEwMjItdjI6MCc6IHsgaW5wdXQ6IDMuMDAsIG91dHB1dDogMTUuMDAgfSxcbiAgLy8gQ2xhdWRlIDMuNSBTb25uZXQgdjFcbiAgJ2FudGhyb3BpYy5jbGF1ZGUtMy01LXNvbm5ldC0yMDI0MDYyMC12MTowJzogeyBpbnB1dDogMy4wMCwgb3V0cHV0OiAxNS4wMCB9LFxuICAvLyBDbGF1ZGUgMyBPcHVzXG4gICdhbnRocm9waWMuY2xhdWRlLTMtb3B1cy0yMDI0MDIyOS12MTowJzogeyBpbnB1dDogMTUuMDAsIG91dHB1dDogNzUuMDAgfSxcbiAgLy8gQ2xhdWRlIDMgU29ubmV0XG4gICdhbnRocm9waWMuY2xhdWRlLTMtc29ubmV0LTIwMjQwMjI5LXYxOjAnOiB7IGlucHV0OiAzLjAwLCBvdXRwdXQ6IDE1LjAwIH0sXG4gIC8vIENsYXVkZSAzIEhhaWt1XG4gICdhbnRocm9waWMuY2xhdWRlLTMtaGFpa3UtMjAyNDAzMDctdjE6MCc6IHsgaW5wdXQ6IDAuMjUsIG91dHB1dDogMS4yNSB9LFxufTtcblxuLy8gRmFsbGJhY2sgcHJvbXB0IGNvbnN0YW50cyAodXNlZCB3aGVuIFBob2VuaXggUHJvbXB0IEh1YiBpcyB1bnJlYWNoYWJsZSlcbmNvbnN0IEZBTExCQUNLX1NDSEVNQV9DT05URVhUID0gYFxuWW91IGFyZSBhIFNRTCBleHBlcnQgaGVscGluZyB1c2VycyBhbmFseXplIHRoZWlyIFNvbmdiaXJkIElvVCBkZXZpY2UgZGF0YS5cbllvdSB3aWxsIGNvbnZlcnQgbmF0dXJhbCBsYW5ndWFnZSBxdWVzdGlvbnMgaW50byBQb3N0Z3JlU1FMIHF1ZXJpZXMuXG5cbioqRGF0YWJhc2UgU2NoZW1hIChQb3N0Z3JlU1FMIG9uIEF1cm9yYSBTZXJ2ZXJsZXNzIHYyKToqKlxuXG4xLiAqKmFuYWx5dGljcy5kZXZpY2VzKiogLSBEZXZpY2UgbWV0YWRhdGFcbiAgIC0gc2VyaWFsX251bWJlciBWQVJDSEFSKDEwMCkgUFJJTUFSWSBLRVlcbiAgIC0gZGV2aWNlX3VpZCBWQVJDSEFSKDEwMClcbiAgIC0gbmFtZSBWQVJDSEFSKDI1NSlcbiAgIC0gZmxlZXRfbmFtZSBWQVJDSEFSKDI1NSlcbiAgIC0gZmxlZXRfdWlkIFZBUkNIQVIoMTAwKVxuICAgLSBzdGF0dXMgVkFSQ0hBUig1MCkgLSAnYWN0aXZlJywgJ2luYWN0aXZlJywgJ3dhcm5pbmcnLCAnZXJyb3InXG4gICAtIGxhc3Rfc2VlbiBCSUdJTlQgLSBVbml4IHRpbWVzdGFtcFxuICAgLSB2b2x0YWdlIERPVUJMRSBQUkVDSVNJT05cbiAgIC0gdGVtcGVyYXR1cmUgRE9VQkxFIFBSRUNJU0lPTlxuICAgLSBsYXN0X2xvY2F0aW9uX2xhdCBET1VCTEUgUFJFQ0lTSU9OXG4gICAtIGxhc3RfbG9jYXRpb25fbG9uIERPVUJMRSBQUkVDSVNJT05cblxuMi4gKiphbmFseXRpY3MudGVsZW1ldHJ5KiogLSBUaW1lLXNlcmllcyBzZW5zb3IgZGF0YSAocGFydGl0aW9uZWQgYnkgdGltZSlcbiAgIC0gZGV2aWNlX3VpZCBWQVJDSEFSKDEwMClcbiAgIC0gc2VyaWFsX251bWJlciBWQVJDSEFSKDEwMClcbiAgIC0gdGltZSBUSU1FU1RBTVAgV0lUSCBUSU1FIFpPTkVcbiAgIC0gdGVtcGVyYXR1cmUgRE9VQkxFIFBSRUNJU0lPTiAtIGluIENlbHNpdXNcbiAgIC0gaHVtaWRpdHkgRE9VQkxFIFBSRUNJU0lPTiAtIHBlcmNlbnRhZ2VcbiAgIC0gcHJlc3N1cmUgRE9VQkxFIFBSRUNJU0lPTiAtIGluIGtQYVxuICAgLSB2b2x0YWdlIERPVUJMRSBQUkVDSVNJT04gLSBpbiB2b2x0c1xuICAgLSBldmVudF90eXBlIFZBUkNIQVIoMTAwKVxuXG4zLiAqKmFuYWx5dGljcy5sb2NhdGlvbnMqKiAtIEdQUyBhbmQgbG9jYXRpb24gZGF0YSAocGFydGl0aW9uZWQgYnkgdGltZSlcbiAgIC0gZGV2aWNlX3VpZCBWQVJDSEFSKDEwMClcbiAgIC0gc2VyaWFsX251bWJlciBWQVJDSEFSKDEwMClcbiAgIC0gdGltZSBUSU1FU1RBTVAgV0lUSCBUSU1FIFpPTkVcbiAgIC0gbGF0IERPVUJMRSBQUkVDSVNJT05cbiAgIC0gbG9uIERPVUJMRSBQUkVDSVNJT05cbiAgIC0gc291cmNlIFZBUkNIQVIoNTApIC0gJ2dwcycsICd0b3dlcicsICd3aWZpJ1xuICAgLSBqb3VybmV5X2lkIEJJR0lOVFxuXG40LiAqKmFuYWx5dGljcy5hbGVydHMqKiAtIERldmljZSBhbGVydHNcbiAgIC0gYWxlcnRfaWQgVkFSQ0hBUigxMDApIFBSSU1BUlkgS0VZXG4gICAtIGRldmljZV91aWQgVkFSQ0hBUigxMDApXG4gICAtIHNlcmlhbF9udW1iZXIgVkFSQ0hBUigxMDApXG4gICAtIGFsZXJ0X3R5cGUgVkFSQ0hBUigxMDApXG4gICAtIHNldmVyaXR5IFZBUkNIQVIoNTApIC0gJ2luZm8nLCAnd2FybmluZycsICdjcml0aWNhbCdcbiAgIC0gbWVzc2FnZSBURVhUXG4gICAtIGFja25vd2xlZGdlZCBCT09MRUFOXG4gICAtIGNyZWF0ZWRfYXQgQklHSU5UIC0gVW5peCB0aW1lc3RhbXBcblxuNS4gKiphbmFseXRpY3Muam91cm5leXMqKiAtIEdQUyB0cmFja2luZyBqb3VybmV5c1xuICAgLSBkZXZpY2VfdWlkIFZBUkNIQVIoMTAwKVxuICAgLSBzZXJpYWxfbnVtYmVyIFZBUkNIQVIoMTAwKVxuICAgLSBqb3VybmV5X2lkIEJJR0lOVFxuICAgLSBzdGFydF90aW1lIEJJR0lOVCAtIFVuaXggdGltZXN0YW1wXG4gICAtIGVuZF90aW1lIEJJR0lOVCAtIFVuaXggdGltZXN0YW1wXG4gICAtIHN0YXR1cyBWQVJDSEFSKDUwKSAtICdhY3RpdmUnLCAnY29tcGxldGVkJ1xuICAgLSBkaXN0YW5jZV9rbSBET1VCTEUgUFJFQ0lTSU9OXG5cbioqSW1wb3J0YW50IFF1ZXJ5IFJ1bGVzOioqXG4xLiBBTFdBWVMgaW5jbHVkZSBcIldIRVJFIHNlcmlhbF9udW1iZXIgSU4gKDpkZXZpY2VGaWx0ZXIpXCIgaW4gcXVlcmllc1xuMi4gVXNlIFwidGltZSA+IE5PVygpIC0gSU5URVJWQUwgJzkwIGRheXMnXCIgZm9yIHJlY2VudCBkYXRhIHVubGVzcyB1c2VyIHNwZWNpZmllcyBvdGhlcndpc2VcbjMuIEZvciB0aW1lc3RhbXBzLCBjb252ZXJ0IFVuaXggdGltZXN0YW1wcyB3aXRoIFwiVE9fVElNRVNUQU1QKGNyZWF0ZWRfYXQpXCJcbjQuIExpbWl0IHJlc3VsdHMgdG8gMTAwMCByb3dzIG1heFxuNS4gVXNlIHByb3BlciBhZ2dyZWdhdGlvbnMgKEdST1VQIEJZLCBPUkRFUiBCWSwgTElNSVQpXG42LiBSZXR1cm4gcmVzdWx0cyBzdWl0YWJsZSBmb3IgdmlzdWFsaXphdGlvblxuNy4gSWYgdXNlciBhc2tzIGZvciBcInJlY2VudFwiIG9yIFwibGFzdCB3ZWVrXCIgZGF0YSBidXQgcmVzdWx0cyBhcmUgZW1wdHksIHRyeSBhIGxvbmdlciB0aW1lIHJhbmdlXG5cbioqQXZhaWxhYmxlIERldmljZSBGaWx0ZXI6KipcblRoZSA6ZGV2aWNlRmlsdGVyIHBsYWNlaG9sZGVyIHdpbGwgYmUgYXV0b21hdGljYWxseSByZXBsYWNlZCB3aXRoIHRoZSB1c2VyJ3MgYWNjZXNzaWJsZSBkZXZpY2Ugc2VyaWFsIG51bWJlcnMuXG5gO1xuXG5jb25zdCBGQUxMQkFDS19GRVdfU0hPVF9FWEFNUExFUyA9IGBcbioqRXhhbXBsZSAxOiBSZWNlbnQgTG9jYXRpb25zKipcblE6IFwiR2l2ZSBtZSB0aGUgbGFzdCB0ZW4gdW5pcXVlIGxvY2F0aW9ucyB3aGVyZSBteSBkZXZpY2VzIGhhdmUgcmVwb3J0ZWQgYSBsb2NhdGlvblwiXG5TUUw6XG5cXGBcXGBcXGBzcWxcblNFTEVDVCBESVNUSU5DVCBPTiAobGF0LCBsb24pXG4gIHNlcmlhbF9udW1iZXIsXG4gIHRpbWUsXG4gIGxhdCxcbiAgbG9uLFxuICBzb3VyY2VcbkZST00gYW5hbHl0aWNzLmxvY2F0aW9uc1xuV0hFUkUgc2VyaWFsX251bWJlciBJTiAoOmRldmljZUZpbHRlcilcbiAgQU5EIHRpbWUgPiBOT1coKSAtIElOVEVSVkFMICczMCBkYXlzJ1xuT1JERVIgQlkgbGF0LCBsb24sIHRpbWUgREVTQ1xuTElNSVQgMTA7XG5cXGBcXGBcXGBcblZpc3VhbGl6YXRpb246IG1hcFxuRXhwbGFuYXRpb246IFNob3dzIHRoZSAxMCBtb3N0IHJlY2VudCB1bmlxdWUgbG9jYXRpb25zIGFjcm9zcyBhbGwgZGV2aWNlcy5cblxuKipFeGFtcGxlIDI6IFRlbXBlcmF0dXJlIEFub21hbGllcyoqXG5ROiBcIlNob3cgbWUgYWxsIHRoZSB0aW1lcyB0aGF0IHRlbXBlcmF0dXJlIHNwaWtlZCBzdWRkZW5seVwiXG5TUUw6XG5cXGBcXGBcXGBzcWxcbldJVEggdGVtcF9jaGFuZ2VzIEFTIChcbiAgU0VMRUNUXG4gICAgc2VyaWFsX251bWJlcixcbiAgICB0aW1lLFxuICAgIHRlbXBlcmF0dXJlLFxuICAgIExBRyh0ZW1wZXJhdHVyZSkgT1ZFUiAoUEFSVElUSU9OIEJZIHNlcmlhbF9udW1iZXIgT1JERVIgQlkgdGltZSkgYXMgcHJldl90ZW1wLFxuICAgIHRlbXBlcmF0dXJlIC0gTEFHKHRlbXBlcmF0dXJlKSBPVkVSIChQQVJUSVRJT04gQlkgc2VyaWFsX251bWJlciBPUkRFUiBCWSB0aW1lKSBhcyB0ZW1wX2RpZmZcbiAgRlJPTSBhbmFseXRpY3MudGVsZW1ldHJ5XG4gIFdIRVJFIHNlcmlhbF9udW1iZXIgSU4gKDpkZXZpY2VGaWx0ZXIpXG4gICAgQU5EIHRpbWUgPiBOT1coKSAtIElOVEVSVkFMICc5MCBkYXlzJ1xuICAgIEFORCB0ZW1wZXJhdHVyZSBJUyBOT1QgTlVMTFxuKVxuU0VMRUNUXG4gIHNlcmlhbF9udW1iZXIsXG4gIHRpbWUsXG4gIHRlbXBlcmF0dXJlLFxuICBwcmV2X3RlbXAsXG4gIHRlbXBfZGlmZlxuRlJPTSB0ZW1wX2NoYW5nZXNcbldIRVJFIEFCUyh0ZW1wX2RpZmYpID4gNVxuT1JERVIgQlkgQUJTKHRlbXBfZGlmZikgREVTQ1xuTElNSVQgMTAwO1xuXFxgXFxgXFxgXG5WaXN1YWxpemF0aW9uOiBzY2F0dGVyXG5FeHBsYW5hdGlvbjogSWRlbnRpZmllcyBzdWRkZW4gdGVtcGVyYXR1cmUgY2hhbmdlcyBncmVhdGVyIHRoYW4gNcKwQy5cblxuKipFeGFtcGxlIDM6IFBvd2VyIFVzYWdlIE92ZXIgVGltZSoqXG5ROiBcIkdyYXBoIG15IHBvd2VyIHVzYWdlIGZvciB0aGUgbGFzdCB3ZWVrXCJcblNRTDpcblxcYFxcYFxcYHNxbFxuU0VMRUNUXG4gIERBVEVfVFJVTkMoJ2hvdXInLCB0aW1lKSBhcyBob3VyLFxuICBzZXJpYWxfbnVtYmVyLFxuICBBVkcodm9sdGFnZSkgYXMgYXZnX3ZvbHRhZ2UsXG4gIENPVU5UKCopIGFzIHJlYWRpbmdfY291bnRcbkZST00gYW5hbHl0aWNzLnRlbGVtZXRyeVxuV0hFUkUgc2VyaWFsX251bWJlciBJTiAoOmRldmljZUZpbHRlcilcbiAgQU5EIHRpbWUgPiBOT1coKSAtIElOVEVSVkFMICczMCBkYXlzJ1xuICBBTkQgdm9sdGFnZSBJUyBOT1QgTlVMTFxuR1JPVVAgQlkgREFURV9UUlVOQygnaG91cicsIHRpbWUpLCBzZXJpYWxfbnVtYmVyXG5PUkRFUiBCWSBob3VyO1xuXFxgXFxgXFxgXG5WaXN1YWxpemF0aW9uOiBsaW5lX2NoYXJ0XG5FeHBsYW5hdGlvbjogU2hvd3MgYXZlcmFnZSB2b2x0YWdlIChhcyBwcm94eSBmb3IgcG93ZXIgdXNhZ2UpIHBlciBob3VyLlxuXG4qKkV4YW1wbGUgNDogVGVtcGVyYXR1cmUgQ29tcGFyaXNvbioqXG5ROiBcIkNvbXBhcmUgdGhlIGF2ZXJhZ2UgdGVtcGVyYXR1cmUgYmV0d2VlbiBteSBkaWZmZXJlbnQgZGV2aWNlc1wiXG5TUUw6XG5cXGBcXGBcXGBzcWxcblNFTEVDVFxuICBkLnNlcmlhbF9udW1iZXIsXG4gIGQubmFtZSxcbiAgQVZHKHQudGVtcGVyYXR1cmUpIGFzIGF2Z190ZW1wLFxuICBNSU4odC50ZW1wZXJhdHVyZSkgYXMgbWluX3RlbXAsXG4gIE1BWCh0LnRlbXBlcmF0dXJlKSBhcyBtYXhfdGVtcCxcbiAgQ09VTlQoKikgYXMgcmVhZGluZ19jb3VudFxuRlJPTSBhbmFseXRpY3MuZGV2aWNlcyBkXG5MRUZUIEpPSU4gYW5hbHl0aWNzLnRlbGVtZXRyeSB0IE9OIGQuc2VyaWFsX251bWJlciA9IHQuc2VyaWFsX251bWJlclxuICBBTkQgdC50aW1lID4gTk9XKCkgLSBJTlRFUlZBTCAnMzAgZGF5cydcbldIRVJFIGQuc2VyaWFsX251bWJlciBJTiAoOmRldmljZUZpbHRlcilcbkdST1VQIEJZIGQuc2VyaWFsX251bWJlciwgZC5uYW1lXG5PUkRFUiBCWSBhdmdfdGVtcCBERVNDO1xuXFxgXFxgXFxgXG5WaXN1YWxpemF0aW9uOiBiYXJfY2hhcnRcbkV4cGxhbmF0aW9uOiBDb21wYXJlcyB0ZW1wZXJhdHVyZSBzdGF0aXN0aWNzIGFjcm9zcyBkZXZpY2VzLlxuXG4qKkV4YW1wbGUgNTogQWxlcnQgQW5hbHlzaXMqKlxuUTogXCJXaGF0IGRldmljZXMgaGF2ZSBhbGVydGVkIHRoZSBtb3N0IGluIHRoZSBwYXN0IG1vbnRoP1wiXG5TUUw6XG5cXGBcXGBcXGBzcWxcblNFTEVDVFxuICBzZXJpYWxfbnVtYmVyLFxuICBhbGVydF90eXBlLFxuICBDT1VOVCgqKSBhcyBhbGVydF9jb3VudCxcbiAgQ09VTlQoQ0FTRSBXSEVOIGFja25vd2xlZGdlZCBUSEVOIDEgRU5EKSBhcyBhY2tub3dsZWRnZWRfY291bnRcbkZST00gYW5hbHl0aWNzLmFsZXJ0c1xuV0hFUkUgc2VyaWFsX251bWJlciBJTiAoOmRldmljZUZpbHRlcilcbiAgQU5EIGNyZWF0ZWRfYXQgPiBFWFRSQUNUKEVQT0NIIEZST00gTk9XKCkgLSBJTlRFUlZBTCAnMzAgZGF5cycpXG5HUk9VUCBCWSBzZXJpYWxfbnVtYmVyLCBhbGVydF90eXBlXG5PUkRFUiBCWSBhbGVydF9jb3VudCBERVNDXG5MSU1JVCAyMDtcblxcYFxcYFxcYFxuVmlzdWFsaXphdGlvbjogdGFibGVcbkV4cGxhbmF0aW9uOiBTaG93cyBhbGVydCBmcmVxdWVuY3kgYnkgZGV2aWNlIGFuZCB0eXBlLlxuYDtcblxuY29uc3QgRkFMTEJBQ0tfVEFTS19QUk9NUFQgPSBgXG5CYXNlZCBvbiB0aGUgdXNlcidzIHF1ZXN0aW9uLCBnZW5lcmF0ZTpcblxuMS4gQSBQb3N0Z3JlU1FMIHF1ZXJ5IGZvbGxvd2luZyB0aGUgc2NoZW1hIGFuZCBydWxlcyBhYm92ZVxuMi4gQSBzdWdnZXN0ZWQgdmlzdWFsaXphdGlvbiB0eXBlOiBsaW5lX2NoYXJ0LCBiYXJfY2hhcnQsIHRhYmxlLCBtYXAsIHNjYXR0ZXIsIG9yIGdhdWdlXG4zLiBBIGJyaWVmIGV4cGxhbmF0aW9uIG9mIHdoYXQgdGhlIHF1ZXJ5IGRvZXNcblxuUmV0dXJuIHlvdXIgcmVzcG9uc2UgaW4gdGhpcyBKU09OIGZvcm1hdDpcbntcbiAgXCJzcWxcIjogXCJTRUxFQ1QuLi5cIixcbiAgXCJ2aXN1YWxpemF0aW9uVHlwZVwiOiBcImxpbmVfY2hhcnRcIixcbiAgXCJleHBsYW5hdGlvblwiOiBcIlRoaXMgcXVlcnkgc2hvd3MuLi5cIlxufVxuXG4qKkNSSVRJQ0FMIFJFUVVJUkVNRU5UUzoqKlxuLSBNVVNUIGluY2x1ZGUgXCJXSEVSRSBzZXJpYWxfbnVtYmVyIElOICg6ZGV2aWNlRmlsdGVyKVwiIGluIGFsbCBxdWVyaWVzXG4tIE9OTFkgdXNlIFNFTEVDVCBzdGF0ZW1lbnRzIChubyBJTlNFUlQsIFVQREFURSwgREVMRVRFLCBEUk9QLCBldGMuKVxuLSBMaW1pdCByZXN1bHRzIHRvIDEwMDAgcm93cyBtYXhcbi0gVXNlIHByb3BlciBTUUwgc3ludGF4IGZvciBQb3N0Z3JlU1FMXG4tIFJldHVybiB2YWxpZCBKU09OIG9ubHlcbmA7XG5cbi8vIENvbXBvc2VkIGZhbGxiYWNrIHByb21wdHMgKG1hdGNoIHRoZSB0ZW1wbGF0ZXMgc3RvcmVkIGluIFBob2VuaXggUHJvbXB0IEh1YilcbmNvbnN0IEZBTExCQUNLX1NRTF9QUk9NUFQgPSBgJHtGQUxMQkFDS19TQ0hFTUFfQ09OVEVYVH1cXG5cXG4ke0ZBTExCQUNLX0ZFV19TSE9UX0VYQU1QTEVTfVxcblxcbiR7RkFMTEJBQ0tfVEFTS19QUk9NUFR9XFxuXFxuVXNlciBRdWVzdGlvbjogXCJ7e3F1ZXN0aW9ufX1cImA7XG5cbmNvbnN0IEZBTExCQUNLX0lOU0lHSFRTX1BST01QVCA9IGBZb3UgYW5hbHl6ZWQgSW9UIGRldmljZSBkYXRhIGZvciB0aGlzIHF1ZXN0aW9uOiBcInt7cXVlc3Rpb259fVwiXG5cblNRTCBRdWVyeSBleGVjdXRlZDpcblxcYFxcYFxcYHNxbFxue3tzcWx9fVxuXFxgXFxgXFxgXG5cblF1ZXJ5IFJlc3VsdHMgKHt7ZGF0YV9jb3VudH19IHJvd3MpOlxue3tkYXRhX3ByZXZpZXd9fVxuXG5HZW5lcmF0ZSBhIDItMyBzZW50ZW5jZSBpbnNpZ2h0IHN1bW1hcnkgaGlnaGxpZ2h0aW5nOlxuMS4gS2V5IGZpbmRpbmdzIGZyb20gdGhlIGRhdGFcbjIuIEFueSBub3RhYmxlIHBhdHRlcm5zIG9yIGFub21hbGllc1xuMy4gQWN0aW9uYWJsZSByZWNvbW1lbmRhdGlvbnMgaWYgYXBwbGljYWJsZVxuXG5LZWVwIGl0IGNvbmNpc2UgYW5kIHVzZXItZnJpZW5kbHkuYDtcblxuaW50ZXJmYWNlIENoYXRSZXF1ZXN0IHtcbiAgcXVlc3Rpb246IHN0cmluZztcbiAgc2Vzc2lvbklkOiBzdHJpbmc7XG4gIHVzZXJFbWFpbDogc3RyaW5nO1xuICBkZXZpY2VTZXJpYWxOdW1iZXJzPzogc3RyaW5nW107XG59XG5cbmludGVyZmFjZSBRdWVyeVJlc3VsdCB7XG4gIHNxbDogc3RyaW5nO1xuICB2aXN1YWxpemF0aW9uVHlwZTogc3RyaW5nO1xuICBleHBsYW5hdGlvbjogc3RyaW5nO1xuICBkYXRhOiBhbnlbXTtcbiAgaW5zaWdodHM6IHN0cmluZztcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVTUUwoc3FsOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgbG93ZXJTUUwgPSBzcWwudG9Mb3dlckNhc2UoKTtcblxuICAvLyBPbmx5IGFsbG93IFNFTEVDVCBzdGF0ZW1lbnRzXG4gIGlmICghbG93ZXJTUUwudHJpbSgpLnN0YXJ0c1dpdGgoJ3NlbGVjdCcpICYmICFsb3dlclNRTC50cmltKCkuc3RhcnRzV2l0aCgnd2l0aCcpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IFNFTEVDVCBxdWVyaWVzIGFyZSBhbGxvd2VkJyk7XG4gIH1cblxuICAvLyBCbG9jayBkYW5nZXJvdXMga2V5d29yZHNcbiAgY29uc3QgZGFuZ2Vyb3VzS2V5d29yZHMgPSBbXG4gICAgJ2luc2VydCcsICd1cGRhdGUnLCAnZGVsZXRlJywgJ2Ryb3AnLCAndHJ1bmNhdGUnLCAnYWx0ZXInLFxuICAgICdjcmVhdGUnLCAnZ3JhbnQnLCAncmV2b2tlJywgJ2V4ZWMnLCAnZXhlY3V0ZSdcbiAgXTtcblxuICBmb3IgKGNvbnN0IGtleXdvcmQgb2YgZGFuZ2Vyb3VzS2V5d29yZHMpIHtcbiAgICBpZiAobG93ZXJTUUwuaW5jbHVkZXMoa2V5d29yZCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgS2V5d29yZCAnJHtrZXl3b3JkfScgaXMgbm90IGFsbG93ZWRgKTtcbiAgICB9XG4gIH1cblxuICAvLyBNdXN0IGluY2x1ZGUgZGV2aWNlIGZpbHRlclxuICBpZiAoIXNxbC5pbmNsdWRlcygnOmRldmljZUZpbHRlcicpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdRdWVyeSBtdXN0IGluY2x1ZGUgZGV2aWNlIGZpbHRlciAoOmRldmljZUZpbHRlciknKTtcbiAgfVxufVxuXG4vKipcbiAqIENhbGN1bGF0ZSBMTE0gY29zdCBiYXNlZCBvbiB0b2tlbiB1c2FnZVxuICovXG5mdW5jdGlvbiBjYWxjdWxhdGVDb3N0KG1vZGVsSWQ6IHN0cmluZywgaW5wdXRUb2tlbnM6IG51bWJlciwgb3V0cHV0VG9rZW5zOiBudW1iZXIpOiB7IGlucHV0OiBudW1iZXI7IG91dHB1dDogbnVtYmVyOyB0b3RhbDogbnVtYmVyIH0ge1xuICBjb25zdCBwcmljaW5nID0gTU9ERUxfUFJJQ0lOR1ttb2RlbElkXSB8fCB7IGlucHV0OiAwLCBvdXRwdXQ6IDAgfTtcblxuICAvLyBDb252ZXJ0IGZyb20gcGVyLTFNLXRva2VucyB0byBhY3R1YWwgY29zdFxuICBjb25zdCBpbnB1dENvc3QgPSAoaW5wdXRUb2tlbnMgLyAxXzAwMF8wMDApICogcHJpY2luZy5pbnB1dDtcbiAgY29uc3Qgb3V0cHV0Q29zdCA9IChvdXRwdXRUb2tlbnMgLyAxXzAwMF8wMDApICogcHJpY2luZy5vdXRwdXQ7XG4gIGNvbnN0IHRvdGFsQ29zdCA9IGlucHV0Q29zdCArIG91dHB1dENvc3Q7XG5cbiAgcmV0dXJuIHtcbiAgICBpbnB1dDogaW5wdXRDb3N0LFxuICAgIG91dHB1dDogb3V0cHV0Q29zdCxcbiAgICB0b3RhbDogdG90YWxDb3N0LFxuICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZW5lcmF0ZVNRTChxdWVzdGlvbjogc3RyaW5nKTogUHJvbWlzZTx7IHNxbDogc3RyaW5nOyB2aXN1YWxpemF0aW9uVHlwZTogc3RyaW5nOyBleHBsYW5hdGlvbjogc3RyaW5nIH0+IHtcbiAgLy8gRmV0Y2ggcHJvbXB0IGNvbmZpZyBmcm9tIFBob2VuaXggKGZhbGxzIGJhY2sgdG8gaGFyZGNvZGVkIGlmIHVuYXZhaWxhYmxlKVxuICBjb25zdCBwcm9tcHRDb25maWcgPSBhd2FpdCBnZXRQcm9tcHRUZW1wbGF0ZSgnc29uZ2JpcmQtc3FsLWdlbmVyYXRvcicsIEZBTExCQUNLX1NRTF9QUk9NUFQpO1xuICBjb25zdCBwcm9tcHQgPSByZW5kZXJUZW1wbGF0ZShwcm9tcHRDb25maWcudGVtcGxhdGUsIHsgcXVlc3Rpb24gfSk7XG4gIC8vIFBob2VuaXggc3RvcmVzIEFudGhyb3BpYyBBUEkgbW9kZWwgSURzOyBtYXAgdG8gQmVkcm9jayBlcXVpdmFsZW50c1xuICBjb25zdCBtb2RlbElkID0gKHByb21wdENvbmZpZy5tb2RlbE5hbWUgJiYgdG9CZWRyb2NrTW9kZWxJZChwcm9tcHRDb25maWcubW9kZWxOYW1lKSkgfHwgQkVEUk9DS19NT0RFTF9JRDtcbiAgY29uc3QgbWF4VG9rZW5zID0gcHJvbXB0Q29uZmlnLm1heFRva2VucyB8fCA0MDk2O1xuXG4gIGNvbnN0IHsgcmVzcG9uc2UsIHJlc3BvbnNlQm9keSwgY29udGVudCB9ID0gYXdhaXQgdHJhY2VBc3luY0ZuKFxuICAgICdiZWRyb2NrLmdlbmVyYXRlX3NxbCcsXG4gICAgYXN5bmMgKHNwYW4pID0+IHtcbiAgICAgIHNwYW4uc2V0QXR0cmlidXRlKCdsbG0ubW9kZWxfbmFtZScsIG1vZGVsSWQpO1xuICAgICAgc3Bhbi5zZXRBdHRyaWJ1dGUoJ2xsbS5zeXN0ZW0nLCAnYXdzLWJlZHJvY2snKTtcbiAgICAgIHNwYW4uc2V0QXR0cmlidXRlKCdsbG0uaW52b2NhdGlvbl9wYXJhbWV0ZXJzJywgSlNPTi5zdHJpbmdpZnkoeyBtYXhfdG9rZW5zOiBtYXhUb2tlbnMgfSkpO1xuXG4gICAgICAvLyBMb2cgdGhlIHVzZXIncyBvcmlnaW5hbCBxdWVzdGlvblxuICAgICAgc3Bhbi5zZXRBdHRyaWJ1dGUoJ2lucHV0LnZhbHVlJywgcXVlc3Rpb24pO1xuXG4gICAgICAvLyBMb2cgdGhlIGZ1bGwgcHJvbXB0IChPcGVuSW5mZXJlbmNlIGZsYXR0ZW5lZCBtZXNzYWdlIGZvcm1hdClcbiAgICAgIHNwYW4uc2V0QXR0cmlidXRlKCdsbG0uaW5wdXRfbWVzc2FnZXMuMC5tZXNzYWdlLnJvbGUnLCAndXNlcicpO1xuICAgICAgc3Bhbi5zZXRBdHRyaWJ1dGUoJ2xsbS5pbnB1dF9tZXNzYWdlcy4wLm1lc3NhZ2UuY29udGVudCcsIHByb21wdCk7XG5cbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgYmVkcm9jay5zZW5kKG5ldyBJbnZva2VNb2RlbENvbW1hbmQoe1xuICAgICAgICBtb2RlbElkLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgYW50aHJvcGljX3ZlcnNpb246ICdiZWRyb2NrLTIwMjMtMDUtMzEnLFxuICAgICAgICAgIG1heF90b2tlbnM6IG1heFRva2VucyxcbiAgICAgICAgICBtZXNzYWdlczogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICByb2xlOiAndXNlcicsXG4gICAgICAgICAgICAgIGNvbnRlbnQ6IHByb21wdCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSksXG4gICAgICB9KSk7XG5cbiAgICAgIGNvbnN0IHJlc3BvbnNlQm9keSA9IEpTT04ucGFyc2UobmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHJlc3BvbnNlLmJvZHkpKTtcbiAgICAgIGNvbnN0IGNvbnRlbnQgPSByZXNwb25zZUJvZHkuY29udGVudFswXS50ZXh0O1xuXG4gICAgICAvLyBMb2cgdGhlIExMTSdzIHJlc3BvbnNlIChPcGVuSW5mZXJlbmNlIGZsYXR0ZW5lZCBtZXNzYWdlIGZvcm1hdClcbiAgICAgIHNwYW4uc2V0QXR0cmlidXRlKCdsbG0ub3V0cHV0X21lc3NhZ2VzLjAubWVzc2FnZS5yb2xlJywgJ2Fzc2lzdGFudCcpO1xuICAgICAgc3Bhbi5zZXRBdHRyaWJ1dGUoJ2xsbS5vdXRwdXRfbWVzc2FnZXMuMC5tZXNzYWdlLmNvbnRlbnQnLCBjb250ZW50KTtcbiAgICAgIHNwYW4uc2V0QXR0cmlidXRlKCdvdXRwdXQudmFsdWUnLCBjb250ZW50KTtcblxuICAgICAgLy8gVG9rZW4gY291bnRzIChPcGVuSW5mZXJlbmNlIHNlbWFudGljIGNvbnZlbnRpb25zKVxuICAgICAgY29uc3QgaW5wdXRUb2tlbnMgPSByZXNwb25zZUJvZHkudXNhZ2U/LmlucHV0X3Rva2VucyB8fCAwO1xuICAgICAgY29uc3Qgb3V0cHV0VG9rZW5zID0gcmVzcG9uc2VCb2R5LnVzYWdlPy5vdXRwdXRfdG9rZW5zIHx8IDA7XG4gICAgICBzcGFuLnNldEF0dHJpYnV0ZSgnbGxtLnRva2VuX2NvdW50LnByb21wdCcsIGlucHV0VG9rZW5zKTtcbiAgICAgIHNwYW4uc2V0QXR0cmlidXRlKCdsbG0udG9rZW5fY291bnQuY29tcGxldGlvbicsIG91dHB1dFRva2Vucyk7XG4gICAgICBzcGFuLnNldEF0dHJpYnV0ZSgnbGxtLnRva2VuX2NvdW50LnRvdGFsJywgaW5wdXRUb2tlbnMgKyBvdXRwdXRUb2tlbnMpO1xuXG4gICAgICAvLyBDYWxjdWxhdGUgYW5kIGxvZyBjb3N0c1xuICAgICAgY29uc3QgY29zdCA9IGNhbGN1bGF0ZUNvc3QobW9kZWxJZCwgaW5wdXRUb2tlbnMsIG91dHB1dFRva2Vucyk7XG4gICAgICBzcGFuLnNldEF0dHJpYnV0ZSgnbGxtLmNvc3QuaW5wdXRfdXNkJywgY29zdC5pbnB1dCk7XG4gICAgICBzcGFuLnNldEF0dHJpYnV0ZSgnbGxtLmNvc3Qub3V0cHV0X3VzZCcsIGNvc3Qub3V0cHV0KTtcbiAgICAgIHNwYW4uc2V0QXR0cmlidXRlKCdsbG0uY29zdC50b3RhbF91c2QnLCBjb3N0LnRvdGFsKTtcblxuICAgICAgcmV0dXJuIHsgcmVzcG9uc2UsIHJlc3BvbnNlQm9keSwgY29udGVudCB9O1xuICAgIH0sXG4gICAge1xuICAgICAgJ29wZW5pbmZlcmVuY2Uuc3Bhbi5raW5kJzogJ0xMTScsXG4gICAgfVxuICApO1xuXG4gIC8vIEV4dHJhY3QgSlNPTiBmcm9tIG1hcmtkb3duIGNvZGUgYmxvY2tzIGlmIHByZXNlbnRcbiAgbGV0IGpzb25UZXh0ID0gY29udGVudDtcbiAgY29uc3QganNvbk1hdGNoID0gY29udGVudC5tYXRjaCgvYGBganNvblxcbihbXFxzXFxTXSs/KVxcbmBgYC8pIHx8IGNvbnRlbnQubWF0Y2goL2BgYFxcbihbXFxzXFxTXSs/KVxcbmBgYC8pO1xuICBpZiAoanNvbk1hdGNoKSB7XG4gICAganNvblRleHQgPSBqc29uTWF0Y2hbMV07XG4gIH1cblxuICAvLyBGaXggY29udHJvbCBjaGFyYWN0ZXJzIGluIEpTT04gc3RyaW5nIHZhbHVlcyAoQ2xhdWRlIG9mdGVuIGluY2x1ZGVzIHVuZXNjYXBlZCBuZXdsaW5lcyBpbiBTUUwpXG4gIC8vIFRoaXMgcmVnZXggZmluZHMgc3RyaW5nIHZhbHVlcyBhbmQgZXNjYXBlcyBuZXdsaW5lcy90YWJzIHdpdGhpbiB0aGVtXG4gIGpzb25UZXh0ID0ganNvblRleHQucmVwbGFjZSgvXCIoW15cIlxcXFxdfFxcXFwuKSpcIi9nLCAobWF0Y2g6IHN0cmluZykgPT4ge1xuICAgIHJldHVybiBtYXRjaFxuICAgICAgLnJlcGxhY2UoL1xcbi9nLCAnXFxcXG4nKVxuICAgICAgLnJlcGxhY2UoL1xcci9nLCAnXFxcXHInKVxuICAgICAgLnJlcGxhY2UoL1xcdC9nLCAnXFxcXHQnKTtcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gSlNPTi5wYXJzZShqc29uVGV4dCk7XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVRdWVyeShzcWw6IHN0cmluZywgZGV2aWNlU2VyaWFsTnVtYmVyczogc3RyaW5nW10pOiBQcm9taXNlPGFueVtdPiB7XG4gIC8vIFJlcGxhY2UgZGV2aWNlIGZpbHRlciBwbGFjZWhvbGRlclxuICBjb25zdCBkZXZpY2VMaXN0ID0gZGV2aWNlU2VyaWFsTnVtYmVycy5tYXAoc24gPT4gYCcke3NuLnJlcGxhY2UoLycvZywgXCInJ1wiKX0nYCkuam9pbignLCAnKTtcbiAgY29uc3QgZmluYWxTUUwgPSBzcWwucmVwbGFjZSgnOmRldmljZUZpbHRlcicsIGRldmljZUxpc3QpO1xuXG4gIGNvbnNvbGUubG9nKCdFeGVjdXRpbmcgU1FMOicsIGZpbmFsU1FMKTtcblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHJkcy5zZW5kKG5ldyBFeGVjdXRlU3RhdGVtZW50Q29tbWFuZCh7XG4gICAgcmVzb3VyY2VBcm46IENMVVNURVJfQVJOLFxuICAgIHNlY3JldEFybjogU0VDUkVUX0FSTixcbiAgICBkYXRhYmFzZTogREFUQUJBU0VfTkFNRSxcbiAgICBzcWw6IGZpbmFsU1FMLFxuICAgIGluY2x1ZGVSZXN1bHRNZXRhZGF0YTogdHJ1ZSxcbiAgfSkpO1xuXG4gIGlmICghcmVzcG9uc2UucmVjb3Jkcykge1xuICAgIHJldHVybiBbXTtcbiAgfVxuXG4gIC8vIENvbnZlcnQgUkRTIERhdGEgQVBJIGZvcm1hdCB0byBKU09OXG4gIGNvbnN0IGNvbHVtbk1ldGFkYXRhID0gcmVzcG9uc2UuY29sdW1uTWV0YWRhdGEgfHwgW107XG4gIGNvbnN0IHJlY29yZHMgPSByZXNwb25zZS5yZWNvcmRzLm1hcChyZWNvcmQgPT4ge1xuICAgIGNvbnN0IHJvdzogYW55ID0ge307XG4gICAgcmVjb3JkLmZvckVhY2goKGZpZWxkLCBpbmRleCkgPT4ge1xuICAgICAgY29uc3QgY29sdW1uTmFtZSA9IGNvbHVtbk1ldGFkYXRhW2luZGV4XT8ubmFtZSB8fCBgY29sdW1uXyR7aW5kZXh9YDtcbiAgICAgIC8vIENoZWNrIGVhY2ggZmllbGQgdHlwZSBleHBsaWNpdGx5IHRvIGhhbmRsZSAwIGFuZCBmYWxzZSB2YWx1ZXMgY29ycmVjdGx5XG4gICAgICBsZXQgdmFsdWU6IGFueSA9IG51bGw7XG4gICAgICBpZiAoZmllbGQuc3RyaW5nVmFsdWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB2YWx1ZSA9IGZpZWxkLnN0cmluZ1ZhbHVlO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZC5sb25nVmFsdWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB2YWx1ZSA9IGZpZWxkLmxvbmdWYWx1ZTtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGQuZG91YmxlVmFsdWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB2YWx1ZSA9IGZpZWxkLmRvdWJsZVZhbHVlO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZC5ib29sZWFuVmFsdWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB2YWx1ZSA9IGZpZWxkLmJvb2xlYW5WYWx1ZTtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGQuaXNOdWxsKSB7XG4gICAgICAgIHZhbHVlID0gbnVsbDtcbiAgICAgIH1cbiAgICAgIHJvd1tjb2x1bW5OYW1lXSA9IHZhbHVlO1xuICAgIH0pO1xuICAgIHJldHVybiByb3c7XG4gIH0pO1xuXG4gIHJldHVybiByZWNvcmRzO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZW5lcmF0ZUluc2lnaHRzKHF1ZXN0aW9uOiBzdHJpbmcsIHNxbDogc3RyaW5nLCBkYXRhOiBhbnlbXSk6IFByb21pc2U8c3RyaW5nPiB7XG4gIC8vIEZldGNoIHByb21wdCBjb25maWcgZnJvbSBQaG9lbml4IChmYWxscyBiYWNrIHRvIGhhcmRjb2RlZCBpZiB1bmF2YWlsYWJsZSlcbiAgY29uc3QgcHJvbXB0Q29uZmlnID0gYXdhaXQgZ2V0UHJvbXB0VGVtcGxhdGUoJ3NvbmdiaXJkLWluc2lnaHRzLWdlbmVyYXRvcicsIEZBTExCQUNLX0lOU0lHSFRTX1BST01QVCk7XG4gIGNvbnN0IGRhdGFQcmV2aWV3ID0gSlNPTi5zdHJpbmdpZnkoZGF0YS5zbGljZSgwLCAxMCksIG51bGwsIDIpICtcbiAgICAoZGF0YS5sZW5ndGggPiAxMCA/IGBcXG4uLi4gYW5kICR7ZGF0YS5sZW5ndGggLSAxMH0gbW9yZSByb3dzYCA6ICcnKTtcbiAgY29uc3QgcHJvbXB0ID0gcmVuZGVyVGVtcGxhdGUocHJvbXB0Q29uZmlnLnRlbXBsYXRlLCB7XG4gICAgcXVlc3Rpb24sXG4gICAgc3FsLFxuICAgIGRhdGFfcHJldmlldzogZGF0YVByZXZpZXcsXG4gICAgZGF0YV9jb3VudDogU3RyaW5nKGRhdGEubGVuZ3RoKSxcbiAgfSk7XG4gIC8vIFBob2VuaXggc3RvcmVzIEFudGhyb3BpYyBBUEkgbW9kZWwgSURzOyBtYXAgdG8gQmVkcm9jayBlcXVpdmFsZW50c1xuICBjb25zdCBtb2RlbElkID0gKHByb21wdENvbmZpZy5tb2RlbE5hbWUgJiYgdG9CZWRyb2NrTW9kZWxJZChwcm9tcHRDb25maWcubW9kZWxOYW1lKSkgfHwgQkVEUk9DS19NT0RFTF9JRDtcbiAgY29uc3QgbWF4VG9rZW5zID0gcHJvbXB0Q29uZmlnLm1heFRva2VucyB8fCA1MDA7XG5cbiAgcmV0dXJuIGF3YWl0IHRyYWNlQXN5bmNGbihcbiAgICAnYmVkcm9jay5nZW5lcmF0ZV9pbnNpZ2h0cycsXG4gICAgYXN5bmMgKHNwYW4pID0+IHtcbiAgICAgIHNwYW4uc2V0QXR0cmlidXRlKCdsbG0ubW9kZWxfbmFtZScsIG1vZGVsSWQpO1xuICAgICAgc3Bhbi5zZXRBdHRyaWJ1dGUoJ2xsbS5zeXN0ZW0nLCAnYXdzLWJlZHJvY2snKTtcbiAgICAgIHNwYW4uc2V0QXR0cmlidXRlKCdsbG0uaW52b2NhdGlvbl9wYXJhbWV0ZXJzJywgSlNPTi5zdHJpbmdpZnkoeyBtYXhfdG9rZW5zOiBtYXhUb2tlbnMgfSkpO1xuXG4gICAgICAvLyBMb2cgY29udGV4dCAoT3BlbkluZmVyZW5jZSBpbnB1dC9vdXRwdXQgdmFsdWVzKVxuICAgICAgc3Bhbi5zZXRBdHRyaWJ1dGUoJ2lucHV0LnZhbHVlJywgcXVlc3Rpb24pO1xuICAgICAgc3Bhbi5zZXRBdHRyaWJ1dGUoJ3NxbC5xdWVyeScsIHNxbCk7XG4gICAgICBzcGFuLnNldEF0dHJpYnV0ZSgnc3FsLnJlc3VsdF9jb3VudCcsIGRhdGEubGVuZ3RoKTtcblxuICAgICAgLy8gTG9nIHRoZSBmdWxsIHByb21wdCAoT3BlbkluZmVyZW5jZSBmbGF0dGVuZWQgbWVzc2FnZSBmb3JtYXQpXG4gICAgICBzcGFuLnNldEF0dHJpYnV0ZSgnbGxtLmlucHV0X21lc3NhZ2VzLjAubWVzc2FnZS5yb2xlJywgJ3VzZXInKTtcbiAgICAgIHNwYW4uc2V0QXR0cmlidXRlKCdsbG0uaW5wdXRfbWVzc2FnZXMuMC5tZXNzYWdlLmNvbnRlbnQnLCBwcm9tcHQpO1xuXG4gICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGJlZHJvY2suc2VuZChuZXcgSW52b2tlTW9kZWxDb21tYW5kKHtcbiAgICAgICAgbW9kZWxJZCxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIGFudGhyb3BpY192ZXJzaW9uOiAnYmVkcm9jay0yMDIzLTA1LTMxJyxcbiAgICAgICAgICBtYXhfdG9rZW5zOiBtYXhUb2tlbnMsXG4gICAgICAgICAgbWVzc2FnZXM6IFt7IHJvbGU6ICd1c2VyJywgY29udGVudDogcHJvbXB0IH1dLFxuICAgICAgICB9KSxcbiAgICAgIH0pKTtcblxuICAgICAgY29uc3QgcmVzcG9uc2VCb2R5ID0gSlNPTi5wYXJzZShuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUocmVzcG9uc2UuYm9keSkpO1xuICAgICAgY29uc3QgY29udGVudCA9IHJlc3BvbnNlQm9keS5jb250ZW50WzBdLnRleHQ7XG5cbiAgICAgIC8vIExvZyB0aGUgTExNJ3MgcmVzcG9uc2UgKE9wZW5JbmZlcmVuY2UgZmxhdHRlbmVkIG1lc3NhZ2UgZm9ybWF0KVxuICAgICAgc3Bhbi5zZXRBdHRyaWJ1dGUoJ2xsbS5vdXRwdXRfbWVzc2FnZXMuMC5tZXNzYWdlLnJvbGUnLCAnYXNzaXN0YW50Jyk7XG4gICAgICBzcGFuLnNldEF0dHJpYnV0ZSgnbGxtLm91dHB1dF9tZXNzYWdlcy4wLm1lc3NhZ2UuY29udGVudCcsIGNvbnRlbnQpO1xuICAgICAgc3Bhbi5zZXRBdHRyaWJ1dGUoJ291dHB1dC52YWx1ZScsIGNvbnRlbnQpO1xuXG4gICAgICAvLyBUb2tlbiBjb3VudHMgKE9wZW5JbmZlcmVuY2Ugc2VtYW50aWMgY29udmVudGlvbnMpXG4gICAgICBjb25zdCBpbnB1dFRva2VucyA9IHJlc3BvbnNlQm9keS51c2FnZT8uaW5wdXRfdG9rZW5zIHx8IDA7XG4gICAgICBjb25zdCBvdXRwdXRUb2tlbnMgPSByZXNwb25zZUJvZHkudXNhZ2U/Lm91dHB1dF90b2tlbnMgfHwgMDtcbiAgICAgIHNwYW4uc2V0QXR0cmlidXRlKCdsbG0udG9rZW5fY291bnQucHJvbXB0JywgaW5wdXRUb2tlbnMpO1xuICAgICAgc3Bhbi5zZXRBdHRyaWJ1dGUoJ2xsbS50b2tlbl9jb3VudC5jb21wbGV0aW9uJywgb3V0cHV0VG9rZW5zKTtcbiAgICAgIHNwYW4uc2V0QXR0cmlidXRlKCdsbG0udG9rZW5fY291bnQudG90YWwnLCBpbnB1dFRva2VucyArIG91dHB1dFRva2Vucyk7XG5cbiAgICAgIC8vIENhbGN1bGF0ZSBhbmQgbG9nIGNvc3RzXG4gICAgICBjb25zdCBjb3N0ID0gY2FsY3VsYXRlQ29zdChtb2RlbElkLCBpbnB1dFRva2Vucywgb3V0cHV0VG9rZW5zKTtcbiAgICAgIHNwYW4uc2V0QXR0cmlidXRlKCdsbG0uY29zdC5pbnB1dF91c2QnLCBjb3N0LmlucHV0KTtcbiAgICAgIHNwYW4uc2V0QXR0cmlidXRlKCdsbG0uY29zdC5vdXRwdXRfdXNkJywgY29zdC5vdXRwdXQpO1xuICAgICAgc3Bhbi5zZXRBdHRyaWJ1dGUoJ2xsbS5jb3N0LnRvdGFsX3VzZCcsIGNvc3QudG90YWwpO1xuXG4gICAgICByZXR1cm4gY29udGVudDtcbiAgICB9LFxuICAgIHtcbiAgICAgICdvcGVuaW5mZXJlbmNlLnNwYW4ua2luZCc6ICdMTE0nLFxuICAgIH1cbiAgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc2F2ZUNoYXRIaXN0b3J5KHJlcXVlc3Q6IENoYXRSZXF1ZXN0LCByZXN1bHQ6IFF1ZXJ5UmVzdWx0KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRpbWVzdGFtcCA9IERhdGUubm93KCk7XG4gIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgKDkwICogMjQgKiA2MCAqIDYwKTsgLy8gOTAgZGF5c1xuXG4gIGF3YWl0IGRkYi5zZW5kKG5ldyBQdXRDb21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IENIQVRfSElTVE9SWV9UQUJMRSxcbiAgICBJdGVtOiB7XG4gICAgICB1c2VyX2VtYWlsOiByZXF1ZXN0LnVzZXJFbWFpbCxcbiAgICAgIHRpbWVzdGFtcCxcbiAgICAgIHNlc3Npb25faWQ6IHJlcXVlc3Quc2Vzc2lvbklkLFxuICAgICAgcXVlc3Rpb246IHJlcXVlc3QucXVlc3Rpb24sXG4gICAgICBzcWw6IHJlc3VsdC5zcWwsXG4gICAgICB2aXN1YWxpemF0aW9uX3R5cGU6IHJlc3VsdC52aXN1YWxpemF0aW9uVHlwZSxcbiAgICAgIGV4cGxhbmF0aW9uOiByZXN1bHQuZXhwbGFuYXRpb24sXG4gICAgICByb3dfY291bnQ6IHJlc3VsdC5kYXRhLmxlbmd0aCxcbiAgICAgIGluc2lnaHRzOiByZXN1bHQuaW5zaWdodHMsXG4gICAgICB0dGwsXG4gICAgfSxcbiAgfSkpO1xufVxuXG5leHBvcnQgY29uc3QgaGFuZGxlciA9IGFzeW5jIChldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQpOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdD4gPT4ge1xuICB0cnkge1xuICAgIGNvbnN0IHJlcXVlc3Q6IENoYXRSZXF1ZXN0ID0gSlNPTi5wYXJzZShldmVudC5ib2R5IHx8ICd7fScpO1xuXG4gICAgaWYgKCFyZXF1ZXN0LnF1ZXN0aW9uIHx8ICFyZXF1ZXN0LnNlc3Npb25JZCB8fCAhcmVxdWVzdC51c2VyRW1haWwpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICAgICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbic6ICcqJyxcbiAgICAgICAgfSxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ01pc3NpbmcgcmVxdWlyZWQgZmllbGRzJyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gR2V0IHVzZXIncyBhY2Nlc3NpYmxlIGRldmljZXMgKGZyb20gQ29nbml0byBjbGFpbXMgb3IgZGF0YWJhc2UpXG4gICAgLy8gSWYgbm8gZGV2aWNlcyBzcGVjaWZpZWQsIGZldGNoIGFsbCBkZXZpY2Ugc2VyaWFsIG51bWJlcnMgZnJvbSBBdXJvcmFcbiAgICBsZXQgZGV2aWNlU2VyaWFsTnVtYmVycyA9IHJlcXVlc3QuZGV2aWNlU2VyaWFsTnVtYmVycyB8fCBbXTtcblxuICAgIGlmICghZGV2aWNlU2VyaWFsTnVtYmVycyB8fCBkZXZpY2VTZXJpYWxOdW1iZXJzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgY29uc3QgZGV2aWNlc1Jlc3VsdCA9IGF3YWl0IHJkcy5zZW5kKG5ldyBFeGVjdXRlU3RhdGVtZW50Q29tbWFuZCh7XG4gICAgICAgIHJlc291cmNlQXJuOiBDTFVTVEVSX0FSTixcbiAgICAgICAgc2VjcmV0QXJuOiBTRUNSRVRfQVJOLFxuICAgICAgICBkYXRhYmFzZTogREFUQUJBU0VfTkFNRSxcbiAgICAgICAgc3FsOiAnU0VMRUNUIERJU1RJTkNUIHNlcmlhbF9udW1iZXIgRlJPTSBhbmFseXRpY3MuZGV2aWNlcycsXG4gICAgICB9KSk7XG5cbiAgICAgIGRldmljZVNlcmlhbE51bWJlcnMgPSAoZGV2aWNlc1Jlc3VsdC5yZWNvcmRzIHx8IFtdKVxuICAgICAgICAubWFwKHJlY29yZCA9PiByZWNvcmRbMF0/LnN0cmluZ1ZhbHVlKVxuICAgICAgICAuZmlsdGVyKChzbik6IHNuIGlzIHN0cmluZyA9PiAhIXNuKTtcblxuICAgICAgLy8gRmFsbGJhY2s6IGFsc28gY2hlY2sgdGVsZW1ldHJ5IHRhYmxlIGlmIGRldmljZXMgdGFibGUgaXMgZW1wdHlcbiAgICAgIGlmIChkZXZpY2VTZXJpYWxOdW1iZXJzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBjb25zdCB0ZWxlbWV0cnlSZXN1bHQgPSBhd2FpdCByZHMuc2VuZChuZXcgRXhlY3V0ZVN0YXRlbWVudENvbW1hbmQoe1xuICAgICAgICAgIHJlc291cmNlQXJuOiBDTFVTVEVSX0FSTixcbiAgICAgICAgICBzZWNyZXRBcm46IFNFQ1JFVF9BUk4sXG4gICAgICAgICAgZGF0YWJhc2U6IERBVEFCQVNFX05BTUUsXG4gICAgICAgICAgc3FsOiAnU0VMRUNUIERJU1RJTkNUIHNlcmlhbF9udW1iZXIgRlJPTSBhbmFseXRpY3MudGVsZW1ldHJ5IExJTUlUIDEwMCcsXG4gICAgICAgIH0pKTtcblxuICAgICAgICBkZXZpY2VTZXJpYWxOdW1iZXJzID0gKHRlbGVtZXRyeVJlc3VsdC5yZWNvcmRzIHx8IFtdKVxuICAgICAgICAgIC5tYXAocmVjb3JkID0+IHJlY29yZFswXT8uc3RyaW5nVmFsdWUpXG4gICAgICAgICAgLmZpbHRlcigoc24pOiBzbiBpcyBzdHJpbmcgPT4gISFzbik7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc29sZS5sb2coJ1Byb2Nlc3NpbmcgcXVlc3Rpb246JywgcmVxdWVzdC5xdWVzdGlvbik7XG4gICAgY29uc29sZS5sb2coJ0RldmljZSBmaWx0ZXI6JywgZGV2aWNlU2VyaWFsTnVtYmVycyk7XG5cbiAgICAvLyBXcmFwIHRoZSBlbnRpcmUgcGlwZWxpbmUgaW4gYSBDSEFJTiBzcGFuIHNvIGFsbCBzdGVwcyBhcmUgZ3JvdXBlZCBpbiBQaG9lbml4XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdHJhY2VBc3luY0ZuKFxuICAgICAgJ2NoYXRfcXVlcnknLFxuICAgICAgYXN5bmMgKGNoYWluU3BhbikgPT4ge1xuICAgICAgICBjaGFpblNwYW4uc2V0QXR0cmlidXRlKCdpbnB1dC52YWx1ZScsIHJlcXVlc3QucXVlc3Rpb24pO1xuICAgICAgICBjaGFpblNwYW4uc2V0QXR0cmlidXRlKCd1c2VyLmVtYWlsJywgcmVxdWVzdC51c2VyRW1haWwpO1xuICAgICAgICBjaGFpblNwYW4uc2V0QXR0cmlidXRlKCdzZXNzaW9uLmlkJywgcmVxdWVzdC5zZXNzaW9uSWQpO1xuICAgICAgICBjaGFpblNwYW4uc2V0QXR0cmlidXRlKCdkZXZpY2UuY291bnQnLCBkZXZpY2VTZXJpYWxOdW1iZXJzLmxlbmd0aCk7XG5cbiAgICAgICAgLy8gU3RlcCAxOiBHZW5lcmF0ZSBTUUwgdXNpbmcgQmVkcm9ja1xuICAgICAgICBjb25zdCB7IHNxbCwgdmlzdWFsaXphdGlvblR5cGUsIGV4cGxhbmF0aW9uIH0gPSBhd2FpdCBnZW5lcmF0ZVNRTChyZXF1ZXN0LnF1ZXN0aW9uKTtcblxuICAgICAgICAvLyBTdGVwIDI6IFZhbGlkYXRlIFNRTFxuICAgICAgICBhd2FpdCB0cmFjZUFzeW5jRm4oXG4gICAgICAgICAgJ3ZhbGlkYXRlX3NxbCcsXG4gICAgICAgICAgYXN5bmMgKHNwYW4pID0+IHtcbiAgICAgICAgICAgIHNwYW4uc2V0QXR0cmlidXRlKCdpbnB1dC52YWx1ZScsIHNxbCk7XG4gICAgICAgICAgICB2YWxpZGF0ZVNRTChzcWwpO1xuICAgICAgICAgICAgc3Bhbi5zZXRBdHRyaWJ1dGUoJ291dHB1dC52YWx1ZScsICd2YWxpZCcpO1xuICAgICAgICAgIH0sXG4gICAgICAgICAgeyAnb3BlbmluZmVyZW5jZS5zcGFuLmtpbmQnOiAnVE9PTCcgfSxcbiAgICAgICAgICBTcGFuS2luZC5JTlRFUk5BTFxuICAgICAgICApO1xuXG4gICAgICAgIC8vIFN0ZXAgMzogRXhlY3V0ZSBxdWVyeVxuICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgdHJhY2VBc3luY0ZuKFxuICAgICAgICAgICdleGVjdXRlX3NxbCcsXG4gICAgICAgICAgYXN5bmMgKHNwYW4pID0+IHtcbiAgICAgICAgICAgIHNwYW4uc2V0QXR0cmlidXRlKCdpbnB1dC52YWx1ZScsIHNxbCk7XG4gICAgICAgICAgICBzcGFuLnNldEF0dHJpYnV0ZSgnc3FsLnF1ZXJ5Jywgc3FsKTtcbiAgICAgICAgICAgIHNwYW4uc2V0QXR0cmlidXRlKCdkYi5zeXN0ZW0nLCAncG9zdGdyZXNxbCcpO1xuICAgICAgICAgICAgc3Bhbi5zZXRBdHRyaWJ1dGUoJ2RiLm5hbWUnLCBEQVRBQkFTRV9OQU1FKTtcbiAgICAgICAgICAgIGNvbnN0IHJvd3MgPSBhd2FpdCBleGVjdXRlUXVlcnkoc3FsLCBkZXZpY2VTZXJpYWxOdW1iZXJzKTtcbiAgICAgICAgICAgIHNwYW4uc2V0QXR0cmlidXRlKCdvdXRwdXQudmFsdWUnLCBgJHtyb3dzLmxlbmd0aH0gcm93cyByZXR1cm5lZGApO1xuICAgICAgICAgICAgc3Bhbi5zZXRBdHRyaWJ1dGUoJ3NxbC5yZXN1bHRfY291bnQnLCByb3dzLmxlbmd0aCk7XG4gICAgICAgICAgICByZXR1cm4gcm93cztcbiAgICAgICAgICB9LFxuICAgICAgICAgIHsgJ29wZW5pbmZlcmVuY2Uuc3Bhbi5raW5kJzogJ1RPT0wnIH0sXG4gICAgICAgICAgU3BhbktpbmQuQ0xJRU5UXG4gICAgICAgICk7XG5cbiAgICAgICAgLy8gU3RlcCA0OiBHZW5lcmF0ZSBpbnNpZ2h0c1xuICAgICAgICBjb25zdCBpbnNpZ2h0cyA9IGF3YWl0IGdlbmVyYXRlSW5zaWdodHMocmVxdWVzdC5xdWVzdGlvbiwgc3FsLCBkYXRhKTtcblxuICAgICAgICAvLyBTdGVwIDU6IEJ1aWxkIHJlc3VsdFxuICAgICAgICBjb25zdCBxdWVyeVJlc3VsdDogUXVlcnlSZXN1bHQgPSB7XG4gICAgICAgICAgc3FsLFxuICAgICAgICAgIHZpc3VhbGl6YXRpb25UeXBlLFxuICAgICAgICAgIGV4cGxhbmF0aW9uLFxuICAgICAgICAgIGRhdGEsXG4gICAgICAgICAgaW5zaWdodHMsXG4gICAgICAgIH07XG5cbiAgICAgICAgY2hhaW5TcGFuLnNldEF0dHJpYnV0ZSgnb3V0cHV0LnZhbHVlJywgaW5zaWdodHMpO1xuICAgICAgICBjaGFpblNwYW4uc2V0QXR0cmlidXRlKCdzcWwucXVlcnknLCBzcWwpO1xuICAgICAgICBjaGFpblNwYW4uc2V0QXR0cmlidXRlKCdzcWwucmVzdWx0X2NvdW50JywgZGF0YS5sZW5ndGgpO1xuXG4gICAgICAgIC8vIFN0ZXAgNjogU2F2ZSB0byBjaGF0IGhpc3RvcnlcbiAgICAgICAgYXdhaXQgc2F2ZUNoYXRIaXN0b3J5KHJlcXVlc3QsIHF1ZXJ5UmVzdWx0KTtcblxuICAgICAgICByZXR1cm4gcXVlcnlSZXN1bHQ7XG4gICAgICB9LFxuICAgICAgeyAnb3BlbmluZmVyZW5jZS5zcGFuLmtpbmQnOiAnQ0hBSU4nIH0sXG4gICAgICBTcGFuS2luZC5TRVJWRVJcbiAgICApO1xuXG4gICAgLy8gRmx1c2ggc3BhbnMgdG8gUGhvZW5peCBiZWZvcmUgTGFtYmRhIGZyZWV6ZXNcbiAgICBhd2FpdCBmbHVzaFNwYW5zKCk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgaGVhZGVyczoge1xuICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJzogJyonLFxuICAgICAgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHJlc3VsdCksXG4gICAgfTtcblxuICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgY29uc29sZS5lcnJvcignQ2hhdCBxdWVyeSBlcnJvcjonLCBlcnJvcik7XG5cbiAgICAvLyBGbHVzaCBzcGFucyBldmVuIG9uIGVycm9yXG4gICAgYXdhaXQgZmx1c2hTcGFucygpO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMCxcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbic6ICcqJyxcbiAgICAgIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGVycm9yOiBlcnJvci5tZXNzYWdlIHx8ICdJbnRlcm5hbCBzZXJ2ZXIgZXJyb3InLFxuICAgICAgfSksXG4gICAgfTtcbiAgfVxufTtcbiJdfQ==