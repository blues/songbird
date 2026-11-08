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
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getPromptTemplate, renderTemplate, toBedrockModelId, type PromptConfig } from '../shared/phoenix-prompts';
import { retrieveRelevantContext, formatRetrievedContext } from '../shared/rag-retrieval';

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
const rds = new RDSDataClient({});
const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const SECRET_ARN = process.env.SECRET_ARN!;
const DATABASE_NAME = process.env.DATABASE_NAME!;
const CHAT_HISTORY_TABLE = process.env.CHAT_HISTORY_TABLE!;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID!;
const DEVICES_TABLE = process.env.DEVICES_TABLE || 'songbird-devices';

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

// Fallback prompt (used when Phoenix Prompt Hub is unreachable).
// Schema details and examples are now in the RAG corpus and injected via
// {{retrieved_context}} — only rules and structure live here.
const FALLBACK_SQL_PROMPT = `You are a SQL expert helping users analyze their Songbird IoT device data stored in PostgreSQL (Aurora Serverless v2). Convert the user's natural language question into a valid PostgreSQL SELECT query.

{{retrieved_context}}

**Critical Query Rules:**
1. ALL tables MUST be prefixed with the "analytics." schema: analytics.devices, analytics.telemetry, analytics.locations, analytics.alerts, analytics.journeys
2. ALWAYS include "WHERE serial_number IN (:deviceFilter)" — this placeholder is replaced at runtime with the user's accessible devices
3. {{assigned_device_rule}}
4. Default time range: time > NOW() - INTERVAL '90 days' unless the user specifies otherwise
5. CRITICAL timestamp conversion: last_seen in analytics.devices is in MILLISECONDS → use TO_TIMESTAMP(last_seen/1000). The columns created_at, start_time, end_time are in SECONDS → use TO_TIMESTAMP(column_name)
6. LIMIT results to 1000 rows max
7. ONLY use SELECT statements — no INSERT, UPDATE, DELETE, DROP, etc.
8. Do NOT use $1/$2/... positional parameters
9. Only use columns that exist in the schema — do not invent columns like battery_level, firmware_version, signal_strength, etc.

**Response Format (JSON only, no explanation outside the JSON):**
{
  "sql": "SELECT...",
  "visualizationType": "line_chart",
  "explanation": "This query shows..."
}

Visualization types: line_chart, bar_chart, table, map, scatter, gauge

User Question: "{{question}}"`;


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

// Allow-list of tables the analytics chat is permitted to read. These are the
// only base tables that exist in (or should be reachable through) the
// `analytics` schema. Anything else — other schemas, system catalogs, or
// invented tables — is rejected.
const ALLOWED_TABLES = new Set(['devices', 'telemetry', 'locations', 'alerts', 'journeys']);

// Dangerous keywords that must never appear in a read-only analytics query.
// This is defense-in-depth on top of the SELECT/WITH + table allow-list; it is
// intentionally broad (DDL, DML, procedural, and maintenance verbs).
const DANGEROUS_KEYWORDS = [
  'insert', 'update', 'delete', 'drop', 'truncate', 'alter',
  'create', 'grant', 'revoke', 'exec', 'execute', 'merge',
  'call', 'copy', 'vacuum', 'analyze', 'reindex', 'cluster',
  'comment', 'lock', 'set', 'reset', 'do', 'listen', 'notify',
];

/**
 * Structural safety checks that must hold for BOTH the model-generated SQL and
 * the rewritten SQL that is actually sent to the database. These guard against
 * statement stacking and comment-based obfuscation regardless of the source of
 * the text, so we run them again after string rewriting in executeQuery().
 */
function assertSafeStatement(sql: string): void {
  const trimmed = sql.trim();
  const lowerSQL = trimmed.toLowerCase();

  // 1. Single statement only. A single trailing semicolon is tolerated; any
  //    other semicolon indicates stacked/injected statements
  //    (e.g. "...; DROP TABLE ...").
  const withoutTrailingSemicolon = trimmed.replace(/;+\s*$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    throw new Error('Only a single SQL statement is allowed');
  }

  // 2. Reject SQL comments — a common vector for smuggling payloads past
  //    keyword/allow-list checks (line comments "--", "#" and block comments).
  if (/--|\/\*|\*\/|#/.test(sql)) {
    throw new Error('SQL comments are not allowed');
  }

  // 3. Block dangerous keywords (defense in depth).
  for (const keyword of DANGEROUS_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`).test(lowerSQL)) {
      throw new Error(`Keyword '${keyword}' is not allowed`);
    }
  }

  // 4. Block access to system catalogs / metadata schemas. Only the analytics
  //    schema is ever a legitimate target.
  if (/\b(information_schema|pg_catalog|pg_[a-z_]+)\b/.test(lowerSQL)) {
    throw new Error('Access to system catalogs is not allowed');
  }
}

function validateSQL(sql: string): void {
  const trimmed = sql.trim();
  const lowerSQL = trimmed.toLowerCase();

  // Structural guards (single statement, no comments, no dangerous verbs,
  // no system catalogs).
  assertSafeStatement(sql);

  // Allow-listed leading keyword only.
  if (!lowerSQL.startsWith('select') && !lowerSQL.startsWith('with')) {
    throw new Error('Only SELECT queries are allowed');
  }

  // Table allow-list. Every table referenced after FROM/JOIN must be one of the
  // known analytics tables (with or without the analytics. prefix, since the
  // schema prefix is applied at execution time) or a CTE defined in this query.
  // Collect CTE names first so WITH ... AS (...) queries are not rejected.
  const cteNames = new Set<string>();
  for (const m of lowerSQL.matchAll(/\b([a-z_][a-z0-9_]*)\s+as\s*\(/g)) {
    cteNames.add(m[1]);
  }

  for (const match of lowerSQL.matchAll(/\b(?:from|join)\s+("?[a-z_][a-z0-9_."]*"?)/g)) {
    const raw = match[1].replace(/"/g, '');
    const parts = raw.split('.');
    const table = parts[parts.length - 1];
    const schema = parts.length > 1 ? parts[parts.length - 2] : 'analytics';

    // CTE references are unqualified and were defined above.
    if (parts.length === 1 && cteNames.has(table)) {
      continue;
    }

    if (schema !== 'analytics') {
      throw new Error(`Table schema '${schema}' is not allowed`);
    }
    if (!ALLOWED_TABLES.has(table)) {
      throw new Error(`Table '${table}' is not in the allow-list`);
    }
  }

  // Must include device filter — either the :deviceFilter placeholder or a
  // literal serial_number filter (used when the model scopes to "my device").
  const hasDeviceFilter = sql.includes(':deviceFilter') || /serial_number\s*=\s*'[^']+'/.test(sql);
  if (!hasDeviceFilter) {
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

async function generateSQL(question: string, assignedDevice?: string): Promise<{ sql: string; visualizationType: string; explanation: string }> {
  // Retrieve relevant context via RAG (falls back gracefully on error)
  let retrievedContext = '';
  try {
    const docs = await retrieveRelevantContext(
      question,
      rds,
      CLUSTER_ARN,
      SECRET_ARN,
      DATABASE_NAME,
      5
    );
    retrievedContext = formatRetrievedContext(docs);
  } catch (error: any) {
    console.warn('RAG retrieval failed, using static context only:', error.message);
  }

  // Fetch prompt config from Phoenix (falls back to hardcoded if unavailable)
  const promptConfig = await getPromptTemplate('songbird-sql-generator', FALLBACK_SQL_PROMPT);
  const assignedDeviceRule = assignedDevice
    ? `When the user says "my device", use serial_number = '${assignedDevice}' instead of :deviceFilter`
    : 'If the user asks about "my device" and no device is assigned, use :deviceFilter and note there is no specific device assigned';
  const prompt = renderTemplate(promptConfig.template, {
    question,
    retrieved_context: retrievedContext,
    assigned_device_rule: assignedDeviceRule,
  });
  // Phoenix stores Anthropic API model IDs; map to Bedrock equivalents
  const modelId = (promptConfig.modelName && toBedrockModelId(promptConfig.modelName)) || BEDROCK_MODEL_ID;
  const maxTokens = promptConfig.maxTokens || 8192;

  const { response, responseBody, content } = await traceAsyncFn(
    'bedrock.generate_sql',
    async (span) => {
      span.setAttribute('llm.model_name', modelId);
      span.setAttribute('llm.system', 'aws-bedrock');
      span.setAttribute('llm.invocation_parameters', JSON.stringify({ max_tokens: maxTokens }));

      // Log the user's original question and whether RAG context was injected
      span.setAttribute('input.value', question);
      span.setAttribute('rag.context_retrieved', retrievedContext.length > 0);
      span.setAttribute('rag.context_length', retrievedContext.length);

      // Log the full prompt (OpenInference flattened message format)
      span.setAttribute('llm.input_messages.0.message.role', 'user');
      span.setAttribute('llm.input_messages.0.message.content', prompt);

      const response = await bedrock.send(new InvokeModelCommand({
        modelId,
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: maxTokens,
          messages: [
            { role: 'user', content: prompt },
            { role: 'assistant', content: '{' }, // prefill to force JSON output
          ],
        }),
      }));

      const responseBody = JSON.parse(new TextDecoder().decode(response.body));

      // Check if the model was cut off before finishing
      if (responseBody.stop_reason === 'max_tokens') {
        throw new Error('SQL generation was cut off — prompt may be too large. Try a simpler question.');
      }

      // Prepend the prefilled '{' since Bedrock strips it from the response
      const content = '{' + responseBody.content[0].text;

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

  // Extract JSON — strip code fences if present, then find the outermost { }
  let jsonText = content
    .replace(/^```(?:json)?\s*/i, '')  // strip opening fence
    .replace(/\s*```\s*$/, '')          // strip closing fence
    .trim();

  // Find the outermost { } in case there's still surrounding text
  const jsonStart = jsonText.indexOf('{');
  const jsonEnd = jsonText.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    jsonText = jsonText.slice(jsonStart, jsonEnd + 1);
  }

  // Fix unescaped control characters by scanning character by character.
  // JSON.parse rejects bare newlines/tabs inside string values.
  let fixed = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < jsonText.length; i++) {
    const ch = jsonText[i];
    if (escape) {
      fixed += ch;
      escape = false;
      continue;
    }
    if (ch === '\\') {
      fixed += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      fixed += ch;
      continue;
    }
    if (inString) {
      if (ch === '\n') { fixed += '\\n'; continue; }
      if (ch === '\r') { fixed += '\\r'; continue; }
      if (ch === '\t') { fixed += '\\t'; continue; }
    }
    fixed += ch;
  }

  const result = JSON.parse(fixed);
  return result;
}

async function executeQuery(sql: string, deviceSerialNumbers: string[]): Promise<any[]> {
  // Defense in depth: the device scope must never be empty at execution time,
  // otherwise the :deviceFilter placeholder would expand to an empty IN () list
  // and silently widen access.
  if (!deviceSerialNumbers.length) {
    throw new Error('Device scope is required to execute a query');
  }

  // Replace device filter placeholder
  const deviceList = deviceSerialNumbers.map(sn => `'${sn.replace(/'/g, "''")}'`).join(', ');
  let finalSQL = sql.replaceAll(':deviceFilter', deviceList);

  // Reject SQL containing $N positional parameters — RDS Data API treats these as
  // prepared statement params and errors when none are supplied.
  if (/\$\d+/.test(finalSQL)) {
    throw new Error('Generated SQL contains unsupported positional parameters ($1, $2, ...). Please rephrase your question.');
  }

  // Auto-fix missing analytics. schema prefix for known tables
  const knownTables = ['devices', 'telemetry', 'locations', 'alerts', 'journeys'];
  for (const table of knownTables) {
    // Match table name not already prefixed with analytics.
    finalSQL = finalSQL.replace(
      new RegExp(`(?<!analytics\\.)\\b(${table})\\b`, 'gi'),
      'analytics.$1'
    );
  }

  // Re-assert structural safety on the *rewritten* SQL. The device-list
  // expansion and schema-prefix rewriting above operate on model-controlled
  // text; running the structural guards again ensures no injected statement,
  // comment, or dangerous verb slipped in via a malicious serial number or an
  // unexpected rewrite. This is the last check before the string reaches the DB.
  assertSafeStatement(finalSQL);

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

async function saveChatHistory(request: ChatRequest, result: QueryResult): Promise<number> {
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

  return timestamp;
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

    // Get user's accessible devices — must be supplied by the caller.
    // Falling back to all devices would grant unrestricted data access.
    const deviceSerialNumbers: string[] = request.deviceSerialNumbers?.length
      ? request.deviceSerialNumbers
      : [];

    if (deviceSerialNumbers.length === 0) {
      return {
        statusCode: 403,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ error: 'deviceSerialNumbers is required' }),
      };
    }

    // Look up the user's assigned device from DynamoDB devices table
    let assignedDevice: string | undefined;
    try {
      // Try exact match first, then case-insensitive
      const assignedResult = await ddb.send(new ScanCommand({
        TableName: DEVICES_TABLE,
        FilterExpression: 'assigned_to = :email OR assigned_to = :emailLower OR assigned_to = :emailUpper',
        ExpressionAttributeValues: {
          ':email': request.userEmail,
          ':emailLower': request.userEmail.toLowerCase(),
          ':emailUpper': request.userEmail.toUpperCase(),
        },
        ProjectionExpression: 'serial_number',
      }));
      assignedDevice = assignedResult.Items?.[0]?.serial_number as string | undefined;
      console.log('Assigned device lookup result:', assignedDevice, 'for email:', request.userEmail);
    } catch (error: any) {
      console.warn('Could not look up assigned device:', error.message);
    }

    console.log('Processing question:', request.question);
    console.log('Device filter:', deviceSerialNumbers);
    console.log('Assigned device:', assignedDevice);

    // Wrap the entire pipeline in a CHAIN span so all steps are grouped in Phoenix
    const result = await traceAsyncFn(
      'chat_query',
      async (chainSpan) => {
        chainSpan.setAttribute('input.value', request.question);
        chainSpan.setAttribute('user.email', request.userEmail);
        chainSpan.setAttribute('session.id', request.sessionId);
        chainSpan.setAttribute('device.count', deviceSerialNumbers.length);
        if (assignedDevice) chainSpan.setAttribute('user.assigned_device', assignedDevice);

        // Step 1: Generate SQL using Bedrock
        const { sql, visualizationType, explanation } = await generateSQL(request.question, assignedDevice);

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
            // Log first 20 rows as output for Phoenix inspection
            span.setAttribute('sql.result_preview', JSON.stringify(rows.slice(0, 20)));
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

        // Step 6: Save to chat history, get back the exact DynamoDB timestamp
        const savedTimestamp = await saveChatHistory(request, queryResult);

        return { ...queryResult, savedTimestamp };
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

// Exported for unit testing of the SQL safety guards (M16 hardening).
export { validateSQL, assertSafeStatement, ALLOWED_TABLES, DANGEROUS_KEYWORDS };
