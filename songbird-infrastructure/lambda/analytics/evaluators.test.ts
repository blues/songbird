import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

import {
  evaluateSQLSyntax,
  evaluateSQLExecution,
  analyzeQueryComplexity,
  evaluateInsightRelevance,
  evaluateSQLHallucination,
} from './evaluators';

const bedrockMock = mockClient(BedrockRuntimeClient);

beforeEach(() => {
  bedrockMock.reset();
});

function makeBedrockResponse(json: Record<string, any>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ content: [{ text: JSON.stringify(json) }] })
  );
}

// ---------------------------------------------------------------------------
// evaluateSQLSyntax
// ---------------------------------------------------------------------------
describe('evaluateSQLSyntax', () => {
  it('returns valid for well-formed SELECT with device filter and LIMIT', () => {
    const sql = 'SELECT * FROM telemetry WHERE serial_number IN (:deviceFilter) LIMIT 100';
    const result = evaluateSQLSyntax(sql);
    expect(result.name).toBe('sql_syntax_valid');
    expect(result.score).toBe(1.0);
    expect(result.label).toBe('valid');
    expect(result.explanation).toBe('SQL syntax is valid');
    expect(result.metadata?.error_count).toBe(0);
  });

  it('returns valid for WITH (CTE) queries', () => {
    const sql = 'WITH cte AS (SELECT 1) SELECT * FROM cte WHERE :deviceFilter LIMIT 10';
    const result = evaluateSQLSyntax(sql);
    expect(result.score).toBe(1.0);
  });

  it('scores 0 when SQL does not start with SELECT or WITH', () => {
    const sql = 'INSERT INTO devices VALUES (1)';
    const result = evaluateSQLSyntax(sql);
    expect(result.score).toBe(0);
    expect(result.label).toBe('invalid');
  });

  it('scores 0 when dangerous keywords are present', () => {
    const dangerousKeywords = ['insert', 'update', 'delete', 'drop', 'truncate', 'alter', 'create'];
    for (const keyword of dangerousKeywords) {
      const sql = `SELECT * FROM t WHERE ${keyword}_col = 1 LIMIT 10`;
      const result = evaluateSQLSyntax(sql);
      expect(result.score).toBe(0);
      expect(result.metadata?.errors).toContainEqual(expect.stringContaining(keyword));
    }
  });

  it('deducts 0.3 when device filter is missing', () => {
    const sql = 'SELECT * FROM telemetry LIMIT 10';
    const result = evaluateSQLSyntax(sql);
    expect(result.score).toBe(0.7);
    expect(result.metadata?.errors).toContainEqual('Missing required device filter');
  });

  it('deducts 0.2 when LIMIT is missing', () => {
    const sql = 'SELECT * FROM telemetry WHERE :deviceFilter';
    const result = evaluateSQLSyntax(sql);
    expect(result.score).toBe(0.8);
    expect(result.metadata?.errors).toContainEqual('Missing LIMIT clause');
  });

  it('deducts 0.3 for unmatched parentheses', () => {
    const sql = 'SELECT * FROM telemetry WHERE (serial_number IN (:deviceFilter) LIMIT 10';
    const result = evaluateSQLSyntax(sql);
    expect(result.score).toBe(0.7);
    expect(result.metadata?.errors).toContainEqual('Unmatched parentheses');
  });

  it('accumulates multiple deductions', () => {
    // Missing device filter (-0.3), missing LIMIT (-0.2), unmatched parens (-0.3)
    const sql = 'SELECT * FROM telemetry WHERE (foo = 1';
    const result = evaluateSQLSyntax(sql);
    expect(result.score).toBeCloseTo(0.2);
    expect(result.metadata?.error_count).toBe(3);
  });

  it('accepts serial_number IN as device filter', () => {
    const sql = "SELECT * FROM telemetry WHERE serial_number IN ('s1') LIMIT 10";
    const result = evaluateSQLSyntax(sql);
    expect(result.score).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// evaluateSQLExecution
// ---------------------------------------------------------------------------
describe('evaluateSQLExecution', () => {
  it('returns score 1 on success with rows', () => {
    const result = evaluateSQLExecution(null, 42);
    expect(result.name).toBe('sql_execution_success');
    expect(result.score).toBe(1);
    expect(result.label).toBe('success');
    expect(result.metadata?.row_count).toBe(42);
  });

  it('returns score 1 on success with zero rows', () => {
    const result = evaluateSQLExecution(null, 0);
    expect(result.score).toBe(1);
    expect(result.label).toBe('success');
  });

  it('returns score 0 on error', () => {
    const result = evaluateSQLExecution('syntax error at position 5', 0);
    expect(result.score).toBe(0);
    expect(result.label).toBe('failed');
    expect(result.explanation).toContain('syntax error at position 5');
    expect(result.metadata?.error).toBe('syntax error at position 5');
  });
});

// ---------------------------------------------------------------------------
// analyzeQueryComplexity
// ---------------------------------------------------------------------------
describe('analyzeQueryComplexity', () => {
  it('classifies a simple SELECT as simple', () => {
    const sql = 'SELECT * FROM telemetry WHERE serial_number = :s LIMIT 10';
    const result = analyzeQueryComplexity(sql);
    expect(result.name).toBe('query_complexity');
    expect(result.label).toBe('simple');
    expect(result.score).toBe(0.33);
    expect(result.metadata?.cte_count).toBe(0);
    expect(result.metadata?.join_count).toBe(0);
  });

  it('classifies query with one JOIN as simple (score 1 <= threshold)', () => {
    const sql = 'SELECT * FROM telemetry JOIN devices ON telemetry.device_uid = devices.device_uid LIMIT 10';
    const result = analyzeQueryComplexity(sql);
    expect(result.label).toBe('simple');
    expect(result.score).toBe(0.33);
    expect(result.metadata?.join_count).toBe(1);
  });

  it('classifies query with two JOINs as medium', () => {
    const sql = 'SELECT * FROM telemetry JOIN devices ON t.d = d.d JOIN alerts ON a.d = d.d LIMIT 10';
    const result = analyzeQueryComplexity(sql);
    expect(result.label).toBe('medium');
    expect(result.score).toBe(0.66);
    expect(result.metadata?.join_count).toBe(2);
  });

  it('classifies query with CTE + JOINs + subquery as complex', () => {
    const sql = `
      WITH recent AS (SELECT * FROM telemetry)
      SELECT * FROM recent
      JOIN devices ON recent.device_uid = devices.device_uid
      JOIN alerts ON alerts.device_uid = devices.device_uid
      WHERE device_uid IN (SELECT device_uid FROM active)
      LIMIT 10
    `;
    const result = analyzeQueryComplexity(sql);
    expect(result.label).toBe('complex');
    expect(result.score).toBe(1.0);
    expect(result.metadata?.cte_count).toBe(1);
    expect(result.metadata?.join_count).toBe(2);
    // subquery regex also matches CTE inner SELECT, so 2 not 1
    expect(result.metadata?.subquery_count).toBe(2);
  });

  it('counts window functions', () => {
    const sql = 'SELECT ROW_NUMBER() OVER (PARTITION BY device_uid) FROM telemetry LIMIT 10';
    const result = analyzeQueryComplexity(sql);
    expect(result.metadata?.window_count).toBe(1);
    // 1.5 points for 1 window function -> medium
    expect(result.label).toBe('medium');
  });

  it('returns simple for empty-ish query', () => {
    const result = analyzeQueryComplexity('SELECT 1');
    expect(result.label).toBe('simple');
  });
});

// ---------------------------------------------------------------------------
// evaluateInsightRelevance (LLM-based)
// ---------------------------------------------------------------------------
describe('evaluateInsightRelevance', () => {
  it('returns normalized score on success', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: makeBedrockResponse({ score: 4, explanation: 'Good answer' }),
    });

    const bedrock = new BedrockRuntimeClient({});
    const result = await evaluateInsightRelevance(
      bedrock, 'test-model', 'What is the avg temp?', 'SELECT AVG(temperature) ...', 'The average temperature is 22C'
    );

    expect(result.name).toBe('insight_relevance');
    expect(result.score).toBe(0.75); // (4-1)/4
    expect(result.label).toBe('relevant');
    expect(result.explanation).toBe('Good answer');
    expect(result.metadata?.raw_score).toBe(4);
  });

  it('clamps scores above 5 to 5', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: makeBedrockResponse({ score: 10, explanation: 'over the top' }),
    });

    const bedrock = new BedrockRuntimeClient({});
    const result = await evaluateInsightRelevance(bedrock, 'test-model', 'q', 'sql', 'insight');
    expect(result.score).toBe(1.0); // (5-1)/4
    expect(result.metadata?.raw_score).toBe(5);
  });

  it('returns error result when Bedrock call fails', async () => {
    bedrockMock.on(InvokeModelCommand).rejects(new Error('Service unavailable'));

    const bedrock = new BedrockRuntimeClient({});
    const result = await evaluateInsightRelevance(bedrock, 'test-model', 'q', 'sql', 'insight');

    expect(result.score).toBe(0);
    expect(result.label).toBe('error');
    expect(result.explanation).toContain('Service unavailable');
    expect(result.metadata?.error).toBe(true);
  });

  it('labels score 3 as partial', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: makeBedrockResponse({ score: 3, explanation: 'Okay' }),
    });

    const bedrock = new BedrockRuntimeClient({});
    const result = await evaluateInsightRelevance(bedrock, 'test-model', 'q', 'sql', 'insight');
    expect(result.label).toBe('partial');
  });

  it('labels score 2 as irrelevant', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: makeBedrockResponse({ score: 2, explanation: 'Not good' }),
    });

    const bedrock = new BedrockRuntimeClient({});
    const result = await evaluateInsightRelevance(bedrock, 'test-model', 'q', 'sql', 'insight');
    expect(result.label).toBe('irrelevant');
  });
});

// ---------------------------------------------------------------------------
// evaluateSQLHallucination (LLM-based)
// ---------------------------------------------------------------------------
describe('evaluateSQLHallucination', () => {
  it('returns normalized score on success', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: makeBedrockResponse({ score: 5, issues: [], explanation: 'All valid' }),
    });

    const bedrock = new BedrockRuntimeClient({});
    const result = await evaluateSQLHallucination(bedrock, 'test-model', 'question', 'SELECT 1');

    expect(result.name).toBe('sql_hallucination');
    expect(result.score).toBe(1.0); // (5-1)/4
    expect(result.label).toBe('valid');
    expect(result.metadata?.issues).toEqual([]);
  });

  it('labels score 3 as minor_issues', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: makeBedrockResponse({ score: 3, issues: ['wrong column'], explanation: 'Minor' }),
    });

    const bedrock = new BedrockRuntimeClient({});
    const result = await evaluateSQLHallucination(bedrock, 'test-model', 'q', 'sql');
    expect(result.label).toBe('minor_issues');
    expect(result.metadata?.issues).toEqual(['wrong column']);
  });

  it('labels low score as hallucination', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: makeBedrockResponse({ score: 1, issues: ['fake table'], explanation: 'Bad' }),
    });

    const bedrock = new BedrockRuntimeClient({});
    const result = await evaluateSQLHallucination(bedrock, 'test-model', 'q', 'sql');
    expect(result.label).toBe('hallucination');
    expect(result.score).toBe(0); // (1-1)/4
  });

  it('returns error result when Bedrock call fails', async () => {
    bedrockMock.on(InvokeModelCommand).rejects(new Error('Timeout'));

    const bedrock = new BedrockRuntimeClient({});
    const result = await evaluateSQLHallucination(bedrock, 'test-model', 'q', 'sql');

    expect(result.score).toBe(0);
    expect(result.label).toBe('error');
    expect(result.explanation).toContain('Timeout');
  });

  it('handles markdown-wrapped JSON responses', async () => {
    const wrappedJson = '```json\n{"score": 4, "issues": [], "explanation": "ok"}\n```';
    bedrockMock.on(InvokeModelCommand).resolves({
      body: new TextEncoder().encode(
        JSON.stringify({ content: [{ text: wrappedJson }] })
      ),
    });

    const bedrock = new BedrockRuntimeClient({});
    const result = await evaluateSQLHallucination(bedrock, 'test-model', 'q', 'sql');
    expect(result.score).toBe(0.75);
    expect(result.label).toBe('valid');
  });
});
