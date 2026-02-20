---
planStatus:
  planId: plan-phoenix-implementation
  title: Phoenix Advanced Features Implementation Guide
  status: in-progress
  planType: feature
  priority: high
  owner: satch
  stakeholders: []
  tags:
    - observability
    - analytics
    - llm
    - phoenix
    - implementation
  created: "2026-02-19"
  updated: "2026-02-20T00:00:00.000Z"
  progress: 60
---
# Phoenix Advanced Features - Implementation Guide

**Parent Plan**: [phoenix-advanced-features.md](./phoenix-advanced-features.md)

This guide provides step-by-step implementation instructions for the Phoenix integration, including both code changes and manual Phoenix UI configuration.

> **Status as of 2026-02-20**: Phase 1 (Parts 1-4) code complete and deployed. Phase 2 LLM-as-judge evaluators complete and deployed. CloudWatch dashboard live at `Songbird-Analytics`. Part 3 (Golden Dataset) requires manual curation in Phoenix UI.

---

## Overview

**What We're Adding in Phase 1**:
1. ✅ **Expanded Tracing**: Enable tracing in 5 additional Lambda functions
2. ✅ **Cost Tracking**: Add LLM cost calculations to trace spans
3. ✅ **Golden Dataset**: Create curated test dataset from production traces
4. ✅ **Basic Evaluations**: Implement SQL syntax validator and daily evaluation

**Timeline**: 2 weeks
**Effort**: 1 engineer full-time

---

## Prerequisites

### Access Requirements
- [x] Phoenix UI access at `https://phoenix.songbird.live` (or ALB endpoint)
- [x] AWS Console access (Lambda, CDK deployment)
- [x] GitHub repository access (blues/songbird)

### Knowledge Requirements
- Familiarity with AWS Lambda and CDK
- Basic understanding of OpenTelemetry tracing
- Phoenix UI navigation (projects, traces, datasets)

---

## Part 1: Expand Tracing Coverage

### Goal
Enable OpenTelemetry tracing in 5 additional Lambda functions to get full observability across the Songbird backend.

### Code Changes

#### Step 1.1: Update Lambda Functions with Tracing

**Files to Modify**:
1. `songbird-infrastructure/lambda/api-ingest/index.ts`
2. `songbird-infrastructure/lambda/api-commands/index.ts`
3. `songbird-infrastructure/lambda/api-devices/index.ts`
4. `songbird-infrastructure/lambda/analytics/sync-to-aurora.ts`
5. `songbird-infrastructure/lambda/api-alerts/index.ts`

**Changes for Each File**:

Add at the **very top** of each file (before any other imports):

```typescript
// Initialize Phoenix tracing before any other imports
import { initializeTracing, traceAsyncFn } from '../shared/tracing';
initializeTracing('songbird-<LAMBDA_NAME>'); // Replace with actual name
```

**Service Names**:
- `api-ingest/index.ts` → `'songbird-api-ingest'`
- `api-commands/index.ts` → `'songbird-api-commands'`
- `api-devices/index.ts` → `'songbird-api-devices'`
- `analytics/sync-to-aurora.ts` → `'songbird-analytics-sync'`
- `api-alerts/index.ts` → `'songbird-api-alerts'`

**Example for api-ingest/index.ts**:
```typescript
// Initialize Phoenix tracing before any other imports
import { initializeTracing, traceAsyncFn } from '../shared/tracing';
initializeTracing('songbird-api-ingest');

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
// ... rest of imports

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    // Existing code...
  } catch (error) {
    // Error handling...
  }
};
```

#### Step 1.2: Add Custom Spans for Key Operations

**Optional but Recommended**: Wrap critical operations with `traceAsyncFn()` for detailed visibility.

**Example - Wrap DynamoDB Operations in api-devices**:

```typescript
// Before
const result = await ddb.send(new GetCommand({
  TableName: DEVICES_TABLE,
  Key: { serial_number: serialNumber },
}));

// After
const result = await traceAsyncFn(
  'dynamodb.get_device',
  async (span) => {
    span.setAttribute('db.table', DEVICES_TABLE);
    span.setAttribute('device.serial_number', serialNumber);

    return await ddb.send(new GetCommand({
      TableName: DEVICES_TABLE,
      Key: { serial_number: serialNumber },
    }));
  },
  {
    'db.system': 'dynamodb',
    'db.operation': 'get',
  }
);
```

**Other Good Candidates for Custom Spans**:
- External API calls (Notehub API)
- Aurora Data API queries
- Complex business logic (mode calculations, alert checks)
- SNS notifications

#### Step 1.3: Update CDK to Configure Phoenix Environment Variables

**File**: `songbird-infrastructure/lib/api-construct.ts`

Find where Lambda functions are created and add Phoenix environment variables:

```typescript
// Example for api-ingest Lambda
const ingestLambda = new NodejsFunction(this, 'IngestLambda', {
  functionName: 'songbird-api-ingest',
  // ... existing config
  environment: {
    // ... existing env vars
    PHOENIX_COLLECTOR_ENDPOINT: props.phoenixOtlpEndpoint,
    OTEL_SERVICE_NAME: 'songbird-api-ingest',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
  },
});
```

**Update \****`ApiConstructProps`**\*\* interface** to accept Phoenix endpoint:

```typescript
export interface ApiConstructProps {
  // ... existing props
  phoenixOtlpEndpoint: string; // Add this
}
```

**File**: `songbird-infrastructure/lib/songbird-stack.ts`

Pass Phoenix OTLP endpoint from ObservabilityConstruct to ApiConstruct:

```typescript
const apiConstruct = new ApiConstruct(this, 'Api', {
  // ... existing props
  phoenixOtlpEndpoint: observabilityConstruct.otlpEndpoint,
});
```

Repeat for other constructs that have Lambdas needing tracing.

#### Step 1.4: Update package.json Dependencies

**File**: `songbird-infrastructure/lambda/package.json`

Ensure tracing dependencies are available:

```json
{
  "dependencies": {
    "@arizeai/phoenix-otel": "^1.0.0",
    "@opentelemetry/api": "^1.8.0",
    // ... existing dependencies
  }
}
```

Run `npm install` in `songbird-infrastructure/lambda/` directory.

#### Step 1.5: Deploy Changes

```bash
cd songbird-infrastructure
npm run build
npm run deploy
```

### Verification

1. **Check Lambda Logs** (CloudWatch):
```
   Look for: "Phoenix tracing initialized for songbird-api-ingest"
```

2. **Check Phoenix UI**:
  - Navigate to `https://phoenix.songbird.live`
  - Go to "Traces" page
  - You should see traces from all 5 new services
  - Filter by service: `otel.service.name=songbird-api-ingest`

3. **Test End-to-End Tracing**:
  - Trigger a Notehub event (send telemetry from device)
  - Check Phoenix for trace showing: API Gateway → api-ingest → DynamoDB → sync-to-aurora
  - Verify trace context propagation (single trace ID across all spans)

---

## Part 2: Cost Tracking

### Goal
Add LLM cost calculations to trace spans so we can track analytics feature costs over time.

### Code Changes

#### Step 2.1: Add Model Pricing Constants

**File**: `songbird-infrastructure/lambda/analytics/chat-query.ts`

Add after imports:

```typescript
// LLM Model Pricing (USD per million tokens) - Updated Feb 2026
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'us.anthropic.claude-3-5-sonnet-20241022-v2:0': {
    input: 3.00,    // $3 per million input tokens
    output: 15.00,  // $15 per million output tokens
  },
  'us.anthropic.claude-3-5-haiku-20241022-v1:0': {
    input: 1.00,    // $1 per million input tokens
    output: 5.00,   // $5 per million output tokens
  },
  'us.anthropic.claude-opus-4-20250514-v1:0': {
    input: 15.00,   // $15 per million input tokens
    output: 75.00,  // $75 per million output tokens
  },
};
```

#### Step 2.2: Add Cost Calculation Function

Add helper function:

```typescript
function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): { inputCost: number; outputCost: number; totalCost: number } {
  const pricing = MODEL_PRICING[modelId];
  if (!pricing) {
    console.warn(`No pricing data for model: ${modelId}`);
    return { inputCost: 0, outputCost: 0, totalCost: 0 };
  }

  const inputCost = (inputTokens * pricing.input) / 1_000_000;
  const outputCost = (outputTokens * pricing.output) / 1_000_000;
  const totalCost = inputCost + outputCost;

  return { inputCost, outputCost, totalCost };
}
```

#### Step 2.3: Update Tracing to Include Cost

**In \****`generateSQL()`**\*\* function**, after logging token usage:

```typescript
span.setAttribute('llm.usage.input_tokens', responseBody.usage?.input_tokens || 0);
span.setAttribute('llm.usage.output_tokens', responseBody.usage?.output_tokens || 0);

// Add cost calculation
const inputTokens = responseBody.usage?.input_tokens || 0;
const outputTokens = responseBody.usage?.output_tokens || 0;
const { inputCost, outputCost, totalCost } = calculateCost(
  BEDROCK_MODEL_ID,
  inputTokens,
  outputTokens
);

span.setAttribute('llm.cost.input_usd', inputCost);
span.setAttribute('llm.cost.output_usd', outputCost);
span.setAttribute('llm.cost.total_usd', totalCost);
span.setAttribute('llm.cost.currency', 'USD');
```

**Repeat for \****`generateInsights()`**\*\* function** with same pattern.

#### Step 2.4: Deploy

```bash
cd songbird-infrastructure
npm run build
npm run deploy
```

### Manual Phoenix UI Configuration

#### Step 2.5: Create Cost Tracking Dashboard

1. **Navigate to Phoenix UI** → "Dashboards"
2. **Click "New Dashboard"**
3. **Name**: "Analytics Cost Tracking"
4. **Add Widgets**:

   **Widget 1: Total Cost Over Time**
  - Type: Line Chart
  - Metric: `llm.cost.total_usd` (SUM)
  - Group By: Time (1 hour buckets)
  - Filter: `otel.service.name=songbird-analytics-chat-query`
  - Time Range: Last 7 days

   **Widget 2: Cost by Model**
  - Type: Bar Chart
  - Metric: `llm.cost.total_usd` (SUM)
  - Group By: `llm.request.model`
  - Time Range: Last 30 days

   **Widget 3: Cost per Query (Average)**
  - Type: Gauge
  - Metric: `llm.cost.total_usd` (AVG)
  - Filter: `span.kind=llm`
  - Display: Current value with trend

   **Widget 4: Token Usage Distribution**
  - Type: Histogram
  - Metric: `llm.usage.input_tokens` + `llm.usage.output_tokens`
  - Bins: 20
  - Time Range: Last 7 days

5. **Save Dashboard**

### Verification

1. **Trigger Analytics Query**: Use Songbird dashboard to ask a question
2. **Check Phoenix**:
  - Find the trace for that query
  - Verify span has `llm.cost.total_usd` attribute
  - Check dashboard shows cost data

3. **Validate Cost Calculation**:
  - Take a sample trace
  - Manually calculate: (input_tokens × $3 + output_tokens × $15) / 1M
  - Compare with `llm.cost.total_usd` in span

---

## Part 3: Golden Dataset Creation

### Goal
Create a curated dataset of 50 high-quality analytics queries from production for testing and evaluation.

### Manual Phoenix UI Steps

#### Step 3.1: Create Dataset from Traces

1. **Navigate to Phoenix UI** → "Traces"
2. **Filter for Good Queries**:
```
   otel.service.name = "songbird-analytics-chat-query"
   AND span.status_code = "OK"
```
3. **Review Traces**:
  - Look for queries that:
    - Generated valid SQL
    - Returned meaningful results
    - Had good insights
    - Cover different query types (location, temperature, alerts, etc.)

4. **Select 50 Traces**:
  - Click checkbox on each good trace
  - Variety is key: simple queries, complex CTEs, aggregations, JOINs

5. **Create Dataset**:
  - Click "Actions" → "Create Dataset from Selected"
  - Name: `analytics-golden-queries`
  - Description: "Curated high-quality analytics queries for evaluation and testing"
  - Click "Create"

#### Step 3.2: Annotate Dataset Examples

1. **Go to Dataset**: "Datasets" → `analytics-golden-queries`
2. **For Each Example**:
  - Review the query and result
  - Add annotation:
    - **Query Type**: location / temperature / alerts / journey / general
    - **Complexity**: simple / medium / complex
    - **Expected Quality**: 1-5 stars
  - Use keyboard shortcuts (1-5 keys) for fast annotation

3. **Add Expected Outputs** (optional but recommended):
  - Edit dataset examples
  - Add column: `expected_visualization_type`
  - Add column: `expected_sql_structure` (e.g., "SELECT with CTE")
  - This helps with automated evaluation

### Alternative: Programmatic Dataset Creation

If you prefer to automate this:

#### Step 3.3: Create Dataset via Python Script

**File**: `scripts/create_golden_dataset.py`

```python
#!/usr/bin/env python3
"""
Create golden dataset from production traces
"""
import os
from phoenix.client import Client

# Connect to Phoenix
phoenix_url = os.environ.get('PHOENIX_URL', 'https://phoenix.songbird.live')
client = Client(endpoint=phoenix_url)

# Query for good traces
traces = client.query_spans(
    filter="otel.service.name = 'songbird-analytics-chat-query' AND span.status_code = 'OK'",
    limit=100  # Get more than needed, then filter
)

# Filter and curate
golden_examples = []
for trace in traces:
    # Extract attributes
    question = trace.attributes.get('user.question', '')
    sql = trace.attributes.get('llm.output_messages', '')

    # Quality filters
    if len(question) < 10:
        continue  # Too short
    if 'error' in sql.lower():
        continue  # Contains errors

    golden_examples.append({
        'input': question,
        'output': sql,
        'trace_id': trace.trace_id,
        'span_id': trace.span_id,
    })

    if len(golden_examples) >= 50:
        break

# Create dataset
dataset = client.datasets.create_dataset(
    name='analytics-golden-queries',
    description='Curated high-quality analytics queries',
    examples=golden_examples,
    metadata={
        'created_by': 'script',
        'version': '1.0',
    }
)

print(f"Created dataset: {dataset.id}")
print(f"Examples: {len(golden_examples)}")
```

**Run**:
```bash
cd songbird-infrastructure
export PHOENIX_URL=https://phoenix.songbird.live
python3 scripts/create_golden_dataset.py
```

### Verification

1. **Check Dataset in Phoenix UI**:
  - "Datasets" → `analytics-golden-queries`
  - Should have ~50 examples
  - Each example has `input` (question) and `output` (SQL)
  - Linked to original trace

2. **Dataset Quality Check**:
  - Variety of query types represented
  - Mix of simple and complex queries
  - No duplicates or near-duplicates
  - All SQL is valid and executable

---

## Part 4: Basic Evaluations

### Goal
Implement automated evaluation of SQL query quality with a daily evaluation job.

### Code Changes

#### Step 4.1: Create SQL Syntax Evaluator

**File**: `songbird-infrastructure/lambda/analytics/evaluators.ts` (new file)

```typescript
/**
 * Analytics Evaluators
 *
 * Code-based and LLM-based evaluators for assessing analytics query quality.
 */

export interface EvaluationResult {
  name: string;
  score: number; // 0-1 for code-based, 1-5 for LLM-based
  label?: string;
  explanation?: string;
  metadata?: Record<string, any>;
}

/**
 * SQL Syntax Validator
 *
 * Code-based evaluator that checks if generated SQL is valid and safe.
 */
export function evaluateSQLSyntax(sql: string): EvaluationResult {
  const errors: string[] = [];
  let score = 1.0;

  // Check 1: Must start with SELECT or WITH
  const trimmed = sql.trim().toLowerCase();
  if (!trimmed.startsWith('select') && !trimmed.startsWith('with')) {
    errors.push('SQL must start with SELECT or WITH');
    score = 0;
  }

  // Check 2: No dangerous keywords
  const dangerous = ['insert', 'update', 'delete', 'drop', 'truncate', 'alter', 'create'];
  for (const keyword of dangerous) {
    if (trimmed.includes(keyword)) {
      errors.push(`Dangerous keyword detected: ${keyword}`);
      score = 0;
    }
  }

  // Check 3: Must include device filter
  if (!sql.includes(':deviceFilter') && !sql.includes('serial_number IN')) {
    errors.push('Missing required device filter');
    score = Math.max(0, score - 0.3);
  }

  // Check 4: Has LIMIT clause (prevents massive result sets)
  if (!trimmed.includes('limit')) {
    errors.push('Missing LIMIT clause');
    score = Math.max(0, score - 0.2);
  }

  // Check 5: Basic syntax checks
  const openParens = (sql.match(/\(/g) || []).length;
  const closeParens = (sql.match(/\)/g) || []).length;
  if (openParens !== closeParens) {
    errors.push('Unmatched parentheses');
    score = Math.max(0, score - 0.3);
  }

  return {
    name: 'sql_syntax_valid',
    score,
    label: score === 1.0 ? 'valid' : 'invalid',
    explanation: errors.length > 0 ? errors.join('; ') : 'SQL syntax is valid',
    metadata: {
      error_count: errors.length,
      errors,
    },
  };
}

/**
 * SQL Execution Success
 *
 * Evaluates whether SQL executed without errors.
 */
export function evaluateSQLExecution(
  executionError: string | null,
  rowCount: number
): EvaluationResult {
  const hasError = !!executionError;
  const score = hasError ? 0 : 1;

  return {
    name: 'sql_execution_success',
    score,
    label: hasError ? 'failed' : 'success',
    explanation: hasError
      ? `Execution failed: ${executionError}`
      : `SQL executed successfully, returned ${rowCount} rows`,
    metadata: {
      error: executionError,
      row_count: rowCount,
    },
  };
}

/**
 * Query Complexity Analyzer
 *
 * Categorizes query complexity for routing to appropriate models.
 */
export function analyzeQueryComplexity(sql: string): EvaluationResult {
  let complexityScore = 0;

  // Count CTEs (WITH clauses)
  const cteCount = (sql.match(/\bWITH\b/gi) || []).length;
  complexityScore += cteCount * 2;

  // Count subqueries
  const subqueryCount = (sql.match(/\(\s*SELECT/gi) || []).length;
  complexityScore += subqueryCount;

  // Count JOINs
  const joinCount = (sql.match(/\bJOIN\b/gi) || []).length;
  complexityScore += joinCount;

  // Count window functions
  const windowCount = (sql.match(/\bOVER\s*\(/gi) || []).length;
  complexityScore += windowCount * 1.5;

  // Determine category
  let category: 'simple' | 'medium' | 'complex';
  let normalizedScore: number;

  if (complexityScore <= 1) {
    category = 'simple';
    normalizedScore = 0.33;
  } else if (complexityScore <= 4) {
    category = 'medium';
    normalizedScore = 0.66;
  } else {
    category = 'complex';
    normalizedScore = 1.0;
  }

  return {
    name: 'query_complexity',
    score: normalizedScore,
    label: category,
    explanation: `Query complexity: ${category} (score: ${complexityScore})`,
    metadata: {
      complexity_score: complexityScore,
      cte_count: cteCount,
      subquery_count: subqueryCount,
      join_count: joinCount,
      window_count: windowCount,
    },
  };
}
```

#### Step 4.2: Create Daily Evaluation Lambda

**File**: `songbird-infrastructure/lambda/analytics/daily-evaluation.ts` (new file)

```typescript
/**
 * Daily Evaluation Lambda
 *
 * Runs automated evaluations on the last 24 hours of analytics traces.
 * Sends results to Phoenix and generates a report.
 */

import { ScheduledEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { evaluateSQLSyntax, evaluateSQLExecution, analyzeQueryComplexity } from './evaluators';

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);
const sns = new SNSClient({});

const CHAT_HISTORY_TABLE = process.env.CHAT_HISTORY_TABLE!;
const REPORT_SNS_TOPIC = process.env.REPORT_SNS_TOPIC; // Optional

interface EvaluationReport {
  date: string;
  totalQueries: number;
  syntaxValidRate: number;
  executionSuccessRate: number;
  complexityDistribution: {
    simple: number;
    medium: number;
    complex: number;
  };
  topErrors: Array<{ error: string; count: number }>;
}

export const handler = async (event: ScheduledEvent): Promise<void> => {
  console.log('Starting daily evaluation...');

  // Query last 24h of chat history
  const yesterday = Date.now() - (24 * 60 * 60 * 1000);

  // Note: This is a simplified query - in production, you'd need to
  // scan the table or use a GSI with timestamp
  const result = await ddb.send(new QueryCommand({
    TableName: CHAT_HISTORY_TABLE,
    // You'll need to adjust this query based on your table structure
    // This is a placeholder
    FilterExpression: 'timestamp > :yesterday',
    ExpressionAttributeValues: {
      ':yesterday': yesterday,
    },
  }));

  const queries = result.Items || [];
  console.log(`Evaluating ${queries.length} queries from last 24h`);

  // Run evaluations
  let syntaxValid = 0;
  let executionSuccess = 0;
  const complexityDistribution = { simple: 0, medium: 0, complex: 0 };
  const errorCounts: Record<string, number> = {};

  for (const query of queries) {
    // Evaluate SQL syntax
    const syntaxResult = evaluateSQLSyntax(query.sql || '');
    if (syntaxResult.score === 1.0) {
      syntaxValid++;
    } else {
      // Track errors
      const errors = syntaxResult.metadata?.errors || [];
      for (const error of errors) {
        errorCounts[error] = (errorCounts[error] || 0) + 1;
      }
    }

    // Evaluate execution success
    // Determine if query had execution error (you may need to add this to schema)
    const executionError = null; // TODO: Add execution error tracking
    const execResult = evaluateSQLExecution(executionError, query.row_count || 0);
    if (execResult.score === 1.0) {
      executionSuccess++;
    }

    // Analyze complexity
    const complexityResult = analyzeQueryComplexity(query.sql || '');
    const category = complexityResult.label as 'simple' | 'medium' | 'complex';
    complexityDistribution[category]++;
  }

  // Generate report
  const report: EvaluationReport = {
    date: new Date().toISOString().split('T')[0],
    totalQueries: queries.length,
    syntaxValidRate: queries.length > 0 ? syntaxValid / queries.length : 0,
    executionSuccessRate: queries.length > 0 ? executionSuccess / queries.length : 0,
    complexityDistribution,
    topErrors: Object.entries(errorCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([error, count]) => ({ error, count })),
  };

  console.log('Evaluation Report:', JSON.stringify(report, null, 2));

  // Send to SNS (optional)
  if (REPORT_SNS_TOPIC) {
    await sns.send(new PublishCommand({
      TopicArn: REPORT_SNS_TOPIC,
      Subject: `Analytics Evaluation Report - ${report.date}`,
      Message: formatReport(report),
    }));
  }

  // TODO: Push evaluation results to Phoenix via REST API
  // This requires Phoenix client implementation

  console.log('Daily evaluation complete');
};

function formatReport(report: EvaluationReport): string {
  return `
Analytics Evaluation Report - ${report.date}
============================================

Total Queries: ${report.totalQueries}

Quality Metrics:
- SQL Syntax Valid: ${(report.syntaxValidRate * 100).toFixed(1)}%
- Execution Success: ${(report.executionSuccessRate * 100).toFixed(1)}%

Complexity Distribution:
- Simple: ${report.complexityDistribution.simple} (${((report.complexityDistribution.simple / report.totalQueries) * 100).toFixed(1)}%)
- Medium: ${report.complexityDistribution.medium} (${((report.complexityDistribution.medium / report.totalQueries) * 100).toFixed(1)}%)
- Complex: ${report.complexityDistribution.complex} (${((report.complexityDistribution.complex / report.totalQueries) * 100).toFixed(1)}%)

Top Errors:
${report.topErrors.map((e, i) => `${i + 1}. ${e.error}: ${e.count} occurrences`).join('\n')}

View detailed traces at: https://phoenix.songbird.live
  `.trim();
}
```

#### Step 4.3: Update CDK to Deploy Evaluation Lambda

**File**: `songbird-infrastructure/lib/analytics-construct.ts`

Add after existing Lambdas:

```typescript
// ==========================================================================
// Lambda: Daily Evaluation
// ==========================================================================
const dailyEvaluationLambda = new NodejsFunction(this, 'DailyEvaluationLambda', {
  functionName: 'songbird-analytics-daily-evaluation',
  description: 'Run daily evaluations on analytics queries',
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'handler',
  entry: path.join(__dirname, '../lambda/analytics/daily-evaluation.ts'),
  timeout: cdk.Duration.minutes(5),
  memorySize: 512,
  environment: {
    CHAT_HISTORY_TABLE: this.chatHistoryTable.tableName,
  },
  bundling: { minify: true, sourceMap: true },
  logRetention: logs.RetentionDays.TWO_WEEKS,
});

this.chatHistoryTable.grantReadData(dailyEvaluationLambda);

// Schedule to run daily at 8am UTC
const evaluationRule = new events.Rule(this, 'DailyEvaluationRule', {
  schedule: events.Schedule.cron({ hour: '8', minute: '0' }),
  description: 'Trigger daily analytics evaluation',
});

evaluationRule.addTarget(new targets.LambdaFunction(dailyEvaluationLambda));
```

**Add Import**:
```typescript
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
```

#### Step 4.4: Deploy

```bash
cd songbird-infrastructure
npm run build
npm run deploy
```

### Manual Testing

#### Step 4.5: Test Evaluation Lambda

**Invoke Manually**:
```bash
aws lambda invoke \
  --function-name songbird-analytics-daily-evaluation \
  --payload '{}' \
  /tmp/eval-response.json

cat /tmp/eval-response.json
```

**Check Logs**:
```bash
aws logs tail /aws/lambda/songbird-analytics-daily-evaluation --follow
```

### Verification

1. **Check CloudWatch Logs**: Should see evaluation report with metrics
2. **Verify EventBridge Rule**: Confirm rule is enabled and scheduled
3. **Check Email** (if SNS configured): Should receive daily report
4. **Manual Test**: Run evaluators on sample SQL queries in Node REPL

---

## Part 5: Verification & Testing

### End-to-End Test Scenario

**Test 1: Tracing Verification**
1. Send telemetry from Songbird device
2. Check Phoenix: Trace should show `api-ingest` → DynamoDB → `sync-to-aurora`
3. Ask analytics question in dashboard
4. Check Phoenix: Trace should show `chat-query` with LLM spans and cost

**Test 2: Cost Tracking**
1. Ask 10 analytics questions
2. Check Phoenix cost dashboard
3. Verify total cost matches expected: ~$0.05-0.10 per query

**Test 3: Dataset Quality**
1. Review golden dataset in Phoenix UI
2. Verify 50 examples with variety
3. Check annotations are present

**Test 4: Evaluation**
1. Trigger evaluation Lambda
2. Check report in CloudWatch Logs
3. Verify metrics make sense (>90% success rate expected)

---

## Rollback Plan

If issues arise, rollback steps:

1. **Remove Phoenix Tracing**:
```bash
   # Remove PHOENIX_COLLECTOR_ENDPOINT from Lambda env vars
   # Redeploy
   npm run deploy
```

2. **Disable Evaluation Lambda**:
```bash
   aws events disable-rule --name <rule-name>
```

3. **Revert Code Changes**:
```bash
   git revert <commit-sha>
   git push
   npm run deploy
```

---

## Troubleshooting

### Issue: Traces Not Appearing in Phoenix

**Symptoms**: Lambdas log "Phoenix tracing initialized" but no traces in UI

**Checks**:
1. Verify `PHOENIX_COLLECTOR_ENDPOINT` is correct (with port 4318)
2. Check Phoenix server is running: `curl ``https://phoenix.songbird.live/healthz`
3. Check Lambda VPC routing (if in VPC, needs route to Phoenix ALB)
4. Check Phoenix logs: `aws ecs execute-command --cluster songbird-phoenix --task <task-id> --command "tail -f /phoenix-data/logs/phoenix.log"`

**Fix**:
- Ensure Lambda security group allows egress to Phoenix ALB
- Verify ALB security group allows ingress on port 4318

### Issue: Cost Attributes Missing

**Symptoms**: Traces appear but no `llm.cost.*` attributes

**Checks**:
1. Check span attributes in Phoenix UI
2. Verify `MODEL_PRICING` includes the model ID being used
3. Check for warnings in Lambda logs about missing pricing

**Fix**:
- Add missing model to `MODEL_PRICING` constant
- Redeploy Lambda

### Issue: Dataset Creation Failed

**Symptoms**: Error when creating dataset in Phoenix UI

**Checks**:
1. Check Phoenix server capacity (CPU/memory)
2. Verify trace IDs are valid
3. Check Phoenix logs for errors

**Fix**:
- Reduce batch size (create dataset with fewer traces)
- Restart Phoenix service if needed

### Issue: Evaluation Lambda Timeout

**Symptoms**: Lambda times out after 5 minutes

**Checks**:
1. Check number of queries being evaluated
2. Check DynamoDB read capacity

**Fix**:
- Increase Lambda timeout to 10 minutes
- Add pagination to query fewer items per run
- Optimize DynamoDB query (add GSI on timestamp)

---

## Post-Implementation Checklist

- [x] All 5 Lambda functions sending traces to Phoenix (Phase 1, Part 1 - deployed 2026-02-19)
- [x] Phoenix UI shows traces from all services
- [x] Cost tracking added to trace spans (Phase 1, Part 2 - deployed 2026-02-19)
- [ ] Golden dataset has 50+ examples (Phase 1, Part 3 - requires manual curation in Phoenix UI)
- [x] Daily evaluation Lambda runs successfully (Phase 1, Part 4 - deployed 2026-02-19)
- [x] Evaluation report received via CloudWatch Logs
- [x] LLM-as-judge evaluators deployed (Phase 2 - insight relevance + SQL hallucination, deployed 2026-02-20)
- [x] CloudWatch dashboard `Songbird-Analytics` deployed with evaluation metrics, Lambda performance, and Aurora health (deployed 2026-02-20)
- [ ] Documentation updated (CLAUDE.md with Phoenix patterns)
- [ ] Team trained on Phoenix UI navigation

---

## Completed Work Summary

### Phase 1 (Parts 1-4) - Completed 2026-02-19
- **Part 1: Expanded Tracing** - 5 additional Lambda functions instrumented with OpenTelemetry (api-ingest, api-commands, api-devices, api-alerts, sync-to-aurora)
- **Part 2: Cost Tracking** - LLM token costs added as span attributes (`llm.cost.total_usd`)
- **Part 3: Golden Dataset** - Manual step, not yet done (requires curating 50+ traces in Phoenix UI)
- **Part 4: Basic Evaluations** - Daily evaluation Lambda with SQL syntax validation, execution success checking, and query complexity analysis. Runs at 8am UTC via EventBridge.

### Phase 2 (Partial) - Completed 2026-02-20
- **LLM-as-Judge Evaluators** - Two Bedrock-powered evaluators added to daily evaluation:
  - `evaluateInsightRelevance` - Rates insight quality 1-5 via Claude Sonnet
  - `evaluateSQLHallucination` - Checks SQL for hallucinated tables/columns against known schema
  - Samples up to 20 queries per run, uses `us.anthropic.claude-3-5-sonnet-20241022-v2:0`
- **CloudWatch Dashboard** (`Songbird-Analytics`) - Replaces Phoenix dashboards (not available in self-hosted OSS)
  - Evaluation quality scores (syntax valid rate, execution success, insight relevance, hallucination score)
  - Queries evaluated volume
  - Lambda invocations, errors, duration (p50/p99), throttles
  - Aurora Serverless capacity (ACU) and database connections
  - 6 CloudWatch metric filters extract structured metrics from evaluation Lambda logs

### Key Files Modified/Created
- `lambda/analytics/evaluators.ts` - All evaluation functions (code-based + LLM-based)
- `lambda/analytics/daily-evaluation.ts` - Scheduled evaluation Lambda handler
- `lambda/shared/tracing.ts` - OpenTelemetry initialization and flush helper
- `lib/analytics-construct.ts` - Lambda definitions, metric filters, CloudWatch dashboard
- `lib/observability-construct.ts` - Phoenix ECS Fargate, ALB, DNS
- `lib/api-construct.ts` - Phoenix tracing env vars for API Lambdas

## Next Steps

Remaining work:

1. **Golden Dataset Curation** (Phase 1, Part 3): Manually curate 50+ traces in Phoenix UI
2. **Cost Optimization** (Phase 2): Analyze LLM costs, consider model downgrades for simpler queries
3. **Human Feedback Loop** (Phase 2): Add thumbs up/down to dashboard chat UI, feed back to evaluations
4. **Monitoring**: Watch evaluation metrics daily for first week via CloudWatch dashboard
5. **Iteration**: Refine LLM evaluator prompts based on false positives/negatives
6. **Documentation**: Create runbook for Phoenix troubleshooting, update CLAUDE.md with patterns

---

## Resources

- [Phoenix Documentation](https://arize.com/docs/phoenix)
- [OpenTelemetry Tracing Guide](https://opentelemetry.io/docs/concepts/observability-primer/#distributed-traces)
- [phoenix-advanced-features.md](./phoenix-advanced-features.md)
- Phoenix UI: `https://phoenix.songbird.live`
- CloudWatch Dashboard: `https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=Songbird-Analytics`
- CloudWatch Logs: AWS Console → CloudWatch → Log Groups → `/aws/lambda/songbird-*`

---

## Support

Questions or issues? Contact:
- **Phoenix Issues**: Check Phoenix GitHub or docs
- **Songbird Backend**: Satch (@satch)
- **AWS Infrastructure**: Check CDK docs or AWS support
