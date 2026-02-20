/**
 * Analytics Evaluators
 *
 * Code-based and LLM-based evaluators for assessing analytics query quality.
 * Used by the daily evaluation Lambda to generate quality reports.
 */
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
export interface EvaluationResult {
    name: string;
    score: number;
    label?: string;
    explanation?: string;
    metadata?: Record<string, any>;
}
/**
 * SQL Syntax Validator
 *
 * Code-based evaluator that checks if generated SQL is valid and safe.
 */
export declare function evaluateSQLSyntax(sql: string): EvaluationResult;
/**
 * SQL Execution Success
 *
 * Evaluates whether SQL executed without errors.
 */
export declare function evaluateSQLExecution(executionError: string | null, rowCount: number): EvaluationResult;
/**
 * Query Complexity Analyzer
 *
 * Categorizes query complexity for routing to appropriate models.
 */
export declare function analyzeQueryComplexity(sql: string): EvaluationResult;
/**
 * Insight Relevance Evaluator (LLM-as-judge)
 *
 * Rates how well the generated insight answers the user's question.
 * Returns a score from 1-5, normalized to 0-1.
 */
export declare function evaluateInsightRelevance(bedrock: BedrockRuntimeClient, modelId: string, question: string, sql: string, insights: string): Promise<EvaluationResult>;
/**
 * SQL Hallucination Evaluator (LLM-as-judge)
 *
 * Checks if the generated SQL references valid tables and columns from the schema,
 * and whether the SQL logically addresses the user's question.
 */
export declare function evaluateSQLHallucination(bedrock: BedrockRuntimeClient, modelId: string, question: string, sql: string): Promise<EvaluationResult>;
