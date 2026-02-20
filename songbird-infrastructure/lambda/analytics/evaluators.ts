/**
 * Analytics Evaluators
 *
 * Code-based and LLM-based evaluators for assessing analytics query quality.
 * Used by the daily evaluation Lambda to generate quality reports.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

export interface EvaluationResult {
  name: string;
  score: number; // 0-1 for code-based, normalized from 1-5 for LLM-based
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

// ==========================================================================
// LLM-based Evaluators (require Bedrock client)
// ==========================================================================

const SCHEMA_TABLES = `
analytics.devices: serial_number, device_uid, name, fleet_name, fleet_uid, status, last_seen, voltage, temperature, last_location_lat, last_location_lon
analytics.telemetry: device_uid, serial_number, time, temperature, humidity, pressure, voltage, event_type
analytics.locations: device_uid, serial_number, time, lat, lon, source, journey_id
analytics.alerts: alert_id, device_uid, serial_number, alert_type, severity, message, acknowledged, created_at
analytics.journeys: device_uid, serial_number, journey_id, start_time, end_time, status, distance_km
`.trim();

/**
 * Call Bedrock Claude with a prompt and return the text response.
 */
async function callBedrock(
  bedrock: BedrockRuntimeClient,
  modelId: string,
  prompt: string,
): Promise<string> {
  const response = await bedrock.send(new InvokeModelCommand({
    modelId,
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
  }));

  const body = JSON.parse(new TextDecoder().decode(response.body));
  return body.content[0].text;
}

/**
 * Parse a JSON response from the LLM, handling markdown code blocks.
 */
function parseLLMJson(text: string): any {
  let jsonText = text;
  const match = text.match(/```json\n([\s\S]+?)\n```/) || text.match(/```\n([\s\S]+?)\n```/);
  if (match) {
    jsonText = match[1];
  }
  return JSON.parse(jsonText.trim());
}

/**
 * Insight Relevance Evaluator (LLM-as-judge)
 *
 * Rates how well the generated insight answers the user's question.
 * Returns a score from 1-5, normalized to 0-1.
 */
export async function evaluateInsightRelevance(
  bedrock: BedrockRuntimeClient,
  modelId: string,
  question: string,
  sql: string,
  insights: string,
): Promise<EvaluationResult> {
  const prompt = `You are evaluating the quality of an AI-generated analytics insight.

User Question: "${question}"

Generated SQL:
${sql}

Generated Insight:
${insights}

Rate the insight on a scale of 1-5:
1 = Completely irrelevant, does not address the question at all
2 = Partially relevant but misses key aspects of the question
3 = Somewhat relevant, addresses the question but with significant gaps
4 = Mostly relevant, answers the question with minor omissions
5 = Highly relevant, directly and completely answers the question

Respond with JSON only:
{"score": <1-5>, "explanation": "<brief explanation of rating>"}`;

  try {
    const response = await callBedrock(bedrock, modelId, prompt);
    const result = parseLLMJson(response);
    const rawScore = Math.min(5, Math.max(1, result.score));
    const normalizedScore = (rawScore - 1) / 4; // Map 1-5 to 0-1

    return {
      name: 'insight_relevance',
      score: normalizedScore,
      label: rawScore >= 4 ? 'relevant' : rawScore >= 3 ? 'partial' : 'irrelevant',
      explanation: result.explanation,
      metadata: { raw_score: rawScore },
    };
  } catch (error) {
    return {
      name: 'insight_relevance',
      score: 0,
      label: 'error',
      explanation: `Evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { error: true },
    };
  }
}

/**
 * SQL Hallucination Evaluator (LLM-as-judge)
 *
 * Checks if the generated SQL references valid tables and columns from the schema,
 * and whether the SQL logically addresses the user's question.
 */
export async function evaluateSQLHallucination(
  bedrock: BedrockRuntimeClient,
  modelId: string,
  question: string,
  sql: string,
): Promise<EvaluationResult> {
  const prompt = `You are evaluating a generated SQL query for hallucinations and correctness.

Database Schema:
${SCHEMA_TABLES}

User Question: "${question}"

Generated SQL:
${sql}

Check for these issues:
1. Does the SQL reference any tables that don't exist in the schema?
2. Does the SQL reference any columns that don't exist in the listed tables?
3. Does the SQL logically address the user's question?
4. Are there any impossible operations (e.g., joining on non-existent keys)?

Rate the SQL on a scale of 1-5:
1 = Severe hallucination (non-existent tables/columns, completely wrong approach)
2 = Significant issues (wrong columns or tables, partially wrong logic)
3 = Minor issues (correct tables/columns but questionable logic)
4 = Mostly correct (valid schema references, sound logic with minor issues)
5 = No hallucination (all references valid, logic correctly addresses question)

Respond with JSON only:
{"score": <1-5>, "issues": ["<issue1>", "<issue2>"], "explanation": "<brief summary>"}`;

  try {
    const response = await callBedrock(bedrock, modelId, prompt);
    const result = parseLLMJson(response);
    const rawScore = Math.min(5, Math.max(1, result.score));
    const normalizedScore = (rawScore - 1) / 4; // Map 1-5 to 0-1

    return {
      name: 'sql_hallucination',
      score: normalizedScore,
      label: rawScore >= 4 ? 'valid' : rawScore >= 3 ? 'minor_issues' : 'hallucination',
      explanation: result.explanation,
      metadata: {
        raw_score: rawScore,
        issues: result.issues || [],
      },
    };
  } catch (error) {
    return {
      name: 'sql_hallucination',
      score: 0,
      label: 'error',
      explanation: `Evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { error: true },
    };
  }
}
