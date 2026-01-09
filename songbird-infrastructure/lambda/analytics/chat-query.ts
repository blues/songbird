/**
 * Analytics Chat Query Lambda
 *
 * Text-to-SQL powered by AWS Bedrock (Claude 3.5 Sonnet).
 * Converts natural language questions into SQL queries, executes them on Aurora,
 * and generates insights and visualizations.
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
const rds = new RDSDataClient({});
const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const SECRET_ARN = process.env.SECRET_ARN!;
const DATABASE_NAME = process.env.DATABASE_NAME!;
const CHAT_HISTORY_TABLE = process.env.CHAT_HISTORY_TABLE!;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID!;

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

async function generateSQL(question: string): Promise<{ sql: string; visualizationType: string; explanation: string }> {
  const prompt = `${SCHEMA_CONTEXT}\n\n${FEW_SHOT_EXAMPLES}\n\n${TASK_PROMPT}\n\nUser Question: "${question}"`;

  const response = await bedrock.send(new InvokeModelCommand({
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

  const response = await bedrock.send(new InvokeModelCommand({
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
    let deviceSerialNumbers = request.deviceSerialNumbers;

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

    // Step 1: Generate SQL using Bedrock
    const { sql, visualizationType, explanation } = await generateSQL(request.question);

    // Step 2: Validate SQL
    validateSQL(sql);

    // Step 3: Execute query
    const data = await executeQuery(sql, deviceSerialNumbers);

    // Step 4: Generate insights
    const insights = await generateInsights(request.question, sql, data);

    // Step 5: Build result
    const result: QueryResult = {
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

  } catch (error: any) {
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
