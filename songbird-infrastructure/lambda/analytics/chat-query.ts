/**
 * Analytics Chat Query Lambda
 *
 * Text-to-SQL powered by AWS Bedrock (Claude 3.5 Sonnet).
 * Converts natural language questions into SQL queries, executes them on Aurora,
 * and generates insights and visualizations.
 */

// Initialize Phoenix tracing before any other imports
import { initializeTracing, traceAsyncFn, flushSpans } from '../shared/tracing';
import { SpanKind } from '@opentelemetry/api';
initializeTracing('songbird-analytics-chat-query');

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getPromptTemplate, renderTemplate, toBedrockModelId, type PromptConfig } from '../shared/phoenix-prompts';

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
const rds = new RDSDataClient({});
const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const SECRET_ARN = process.env.SECRET_ARN!;
const DATABASE_NAME = process.env.DATABASE_NAME!;
const CHAT_HISTORY_TABLE = process.env.CHAT_HISTORY_TABLE!;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID!;

// Model pricing (USD per 1M tokens) - Updated January 2025
// Source: https://aws.amazon.com/bedrock/pricing/
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
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

interface ChatRequest {
  question: string;
  sessionId: string;
  userEmail: string;
  deviceSerialNumbers?: string[];
}

interface QueryResult {
  sql: string;
  visualizationType: string;
  explanation: string;
  data: any[];
  insights: string;
}

function validateSQL(sql: string): void {
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
function calculateCost(modelId: string, inputTokens: number, outputTokens: number): { input: number; output: number; total: number } {
  const pricing = MODEL_PRICING[modelId] || { input: 0, output: 0 };

  // Convert from per-1M-tokens to actual cost
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const totalCost = inputCost + outputCost;

  return {
    input: inputCost,
    output: outputCost,
    total: totalCost,
  };
}

async function generateSQL(question: string): Promise<{ sql: string; visualizationType: string; explanation: string }> {
  // Fetch prompt config from Phoenix (falls back to hardcoded if unavailable)
  const promptConfig = await getPromptTemplate('songbird-sql-generator', FALLBACK_SQL_PROMPT);
  const prompt = renderTemplate(promptConfig.template, { question });
  // Phoenix stores Anthropic API model IDs; map to Bedrock equivalents
  const modelId = (promptConfig.modelName && toBedrockModelId(promptConfig.modelName)) || BEDROCK_MODEL_ID;
  const maxTokens = promptConfig.maxTokens || 4096;

  const { response, responseBody, content } = await traceAsyncFn(
    'bedrock.generate_sql',
    async (span) => {
      span.setAttribute('llm.model_name', modelId);
      span.setAttribute('llm.system', 'aws-bedrock');
      span.setAttribute('llm.invocation_parameters', JSON.stringify({ max_tokens: maxTokens }));

      // Log the user's original question
      span.setAttribute('input.value', question);

      // Log the full prompt (OpenInference flattened message format)
      span.setAttribute('llm.input_messages.0.message.role', 'user');
      span.setAttribute('llm.input_messages.0.message.content', prompt);

      const response = await bedrock.send(new InvokeModelCommand({
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
    },
    {
      'openinference.span.kind': 'LLM',
    }
  );

  // Extract JSON from markdown code blocks if present
  let jsonText = content;
  const jsonMatch = content.match(/```json\n([\s\S]+?)\n```/) || content.match(/```\n([\s\S]+?)\n```/);
  if (jsonMatch) {
    jsonText = jsonMatch[1];
  }

  // Fix control characters in JSON string values (Claude often includes unescaped newlines in SQL)
  // This regex finds string values and escapes newlines/tabs within them
  jsonText = jsonText.replace(/"([^"\\]|\\.)*"/g, (match: string) => {
    return match
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  });

  const result = JSON.parse(jsonText);
  return result;
}

async function executeQuery(sql: string, deviceSerialNumbers: string[]): Promise<any[]> {
  // Replace device filter placeholder
  const deviceList = deviceSerialNumbers.map(sn => `'${sn.replace(/'/g, "''")}'`).join(', ');
  const finalSQL = sql.replace(':deviceFilter', deviceList);

  console.log('Executing SQL:', finalSQL);

  const response = await rds.send(new ExecuteStatementCommand({
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
    const row: any = {};
    record.forEach((field, index) => {
      const columnName = columnMetadata[index]?.name || `column_${index}`;
      // Check each field type explicitly to handle 0 and false values correctly
      let value: any = null;
      if (field.stringValue !== undefined) {
        value = field.stringValue;
      } else if (field.longValue !== undefined) {
        value = field.longValue;
      } else if (field.doubleValue !== undefined) {
        value = field.doubleValue;
      } else if (field.booleanValue !== undefined) {
        value = field.booleanValue;
      } else if (field.isNull) {
        value = null;
      }
      row[columnName] = value;
    });
    return row;
  });

  return records;
}

async function generateInsights(question: string, sql: string, data: any[]): Promise<string> {
  // Fetch prompt config from Phoenix (falls back to hardcoded if unavailable)
  const promptConfig = await getPromptTemplate('songbird-insights-generator', FALLBACK_INSIGHTS_PROMPT);
  const dataPreview = JSON.stringify(data.slice(0, 10), null, 2) +
    (data.length > 10 ? `\n... and ${data.length - 10} more rows` : '');
  const prompt = renderTemplate(promptConfig.template, {
    question,
    sql,
    data_preview: dataPreview,
    data_count: String(data.length),
  });
  // Phoenix stores Anthropic API model IDs; map to Bedrock equivalents
  const modelId = (promptConfig.modelName && toBedrockModelId(promptConfig.modelName)) || BEDROCK_MODEL_ID;
  const maxTokens = promptConfig.maxTokens || 500;

  return await traceAsyncFn(
    'bedrock.generate_insights',
    async (span) => {
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

      const response = await bedrock.send(new InvokeModelCommand({
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
    },
    {
      'openinference.span.kind': 'LLM',
    }
  );
}

async function saveChatHistory(request: ChatRequest, result: QueryResult): Promise<void> {
  const timestamp = Date.now();
  const ttl = Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60); // 90 days

  await ddb.send(new PutCommand({
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

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const request: ChatRequest = JSON.parse(event.body || '{}');

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
      const devicesResult = await rds.send(new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DATABASE_NAME,
        sql: 'SELECT DISTINCT serial_number FROM analytics.devices',
      }));

      deviceSerialNumbers = (devicesResult.records || [])
        .map(record => record[0]?.stringValue)
        .filter((sn): sn is string => !!sn);

      // Fallback: also check telemetry table if devices table is empty
      if (deviceSerialNumbers.length === 0) {
        const telemetryResult = await rds.send(new ExecuteStatementCommand({
          resourceArn: CLUSTER_ARN,
          secretArn: SECRET_ARN,
          database: DATABASE_NAME,
          sql: 'SELECT DISTINCT serial_number FROM analytics.telemetry LIMIT 100',
        }));

        deviceSerialNumbers = (telemetryResult.records || [])
          .map(record => record[0]?.stringValue)
          .filter((sn): sn is string => !!sn);
      }
    }

    console.log('Processing question:', request.question);
    console.log('Device filter:', deviceSerialNumbers);

    // Wrap the entire pipeline in a CHAIN span so all steps are grouped in Phoenix
    const result = await traceAsyncFn(
      'chat_query',
      async (chainSpan) => {
        chainSpan.setAttribute('input.value', request.question);
        chainSpan.setAttribute('user.email', request.userEmail);
        chainSpan.setAttribute('session.id', request.sessionId);
        chainSpan.setAttribute('device.count', deviceSerialNumbers.length);

        // Step 1: Generate SQL using Bedrock
        const { sql, visualizationType, explanation } = await generateSQL(request.question);

        // Step 2: Validate SQL
        await traceAsyncFn(
          'validate_sql',
          async (span) => {
            span.setAttribute('input.value', sql);
            validateSQL(sql);
            span.setAttribute('output.value', 'valid');
          },
          { 'openinference.span.kind': 'TOOL' },
          SpanKind.INTERNAL
        );

        // Step 3: Execute query
        const data = await traceAsyncFn(
          'execute_sql',
          async (span) => {
            span.setAttribute('input.value', sql);
            span.setAttribute('sql.query', sql);
            span.setAttribute('db.system', 'postgresql');
            span.setAttribute('db.name', DATABASE_NAME);
            const rows = await executeQuery(sql, deviceSerialNumbers);
            span.setAttribute('output.value', `${rows.length} rows returned`);
            span.setAttribute('sql.result_count', rows.length);
            return rows;
          },
          { 'openinference.span.kind': 'TOOL' },
          SpanKind.CLIENT
        );

        // Step 4: Generate insights
        const insights = await generateInsights(request.question, sql, data);

        // Step 5: Build result
        const queryResult: QueryResult = {
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
      },
      { 'openinference.span.kind': 'CHAIN' },
      SpanKind.SERVER
    );

    // Flush spans to Phoenix before Lambda freezes
    await flushSpans();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(result),
    };

  } catch (error: any) {
    console.error('Chat query error:', error);

    // Flush spans even on error
    await flushSpans();

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
