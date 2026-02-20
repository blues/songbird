/**
 * Daily Evaluation Lambda
 *
 * Runs automated evaluations on the last 24 hours of analytics chat queries.
 * Generates a quality report and optionally sends it via SNS.
 */

import { ScheduledEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import {
  evaluateSQLSyntax,
  evaluateSQLExecution,
  analyzeQueryComplexity,
  evaluateInsightRelevance,
  evaluateSQLHallucination,
} from './evaluators';

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);
const sns = new SNSClient({});
const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });

const CHAT_HISTORY_TABLE = process.env.CHAT_HISTORY_TABLE!;
const REPORT_SNS_TOPIC = process.env.REPORT_SNS_TOPIC; // Optional
// Use the same model as chat-query for evaluations (Haiku not enabled in this account)
const EVAL_MODEL_ID = process.env.EVAL_MODEL_ID || 'us.anthropic.claude-3-5-sonnet-20241022-v2:0';

interface EvaluationReport {
  date: string;
  totalQueries: number;
  syntaxValidRate: number;
  executionSuccessRate: number;
  avgInsightRelevance: number;
  avgHallucinationScore: number;
  llmEvaluatedCount: number;
  complexityDistribution: {
    simple: number;
    medium: number;
    complex: number;
  };
  topErrors: Array<{ error: string; count: number }>;
}

export const handler = async (_event: ScheduledEvent): Promise<void> => {
  console.log('Starting daily evaluation...');

  const yesterday = Date.now() - (24 * 60 * 60 * 1000);

  // Scan chat history for last 24h
  // Using Scan + filter since there's no timestamp-based GSI
  const queries: Record<string, any>[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(new ScanCommand({
      TableName: CHAT_HISTORY_TABLE,
      FilterExpression: '#ts > :yesterday',
      ExpressionAttributeNames: { '#ts': 'timestamp' },
      ExpressionAttributeValues: { ':yesterday': yesterday },
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    if (result.Items) {
      queries.push(...result.Items);
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log(`Evaluating ${queries.length} queries from last 24h`);

  if (queries.length === 0) {
    console.log('No queries to evaluate. Skipping report.');
    return;
  }

  // Run code-based evaluations
  let syntaxValid = 0;
  let executionSuccess = 0;
  const complexityDistribution = { simple: 0, medium: 0, complex: 0 };
  const errorCounts: Record<string, number> = {};

  for (const query of queries) {
    if (!query.sql) continue;

    // Evaluate SQL syntax
    const syntaxResult = evaluateSQLSyntax(query.sql);
    if (syntaxResult.score === 1.0) {
      syntaxValid++;
    } else {
      const errors = (syntaxResult.metadata?.errors as string[]) || [];
      for (const error of errors) {
        errorCounts[error] = (errorCounts[error] || 0) + 1;
      }
    }

    // Evaluate execution success
    const executionError = query.execution_error || null;
    const execResult = evaluateSQLExecution(executionError, query.row_count || 0);
    if (execResult.score === 1.0) {
      executionSuccess++;
    }

    // Analyze complexity
    const complexityResult = analyzeQueryComplexity(query.sql);
    const category = complexityResult.label as 'simple' | 'medium' | 'complex';
    complexityDistribution[category]++;
  }

  // Run LLM-based evaluations on a sample (to control cost)
  // Evaluate up to 20 queries per run with Haiku (~$0.001 per evaluation)
  const llmSampleSize = Math.min(queries.length, 20);
  const llmSample = queries
    .filter(q => q.sql && q.question && q.insights)
    .slice(0, llmSampleSize);

  let totalRelevanceScore = 0;
  let totalHallucinationScore = 0;
  let llmEvaluatedCount = 0;

  for (let i = 0; i < llmSample.length; i++) {
    const query = llmSample[i];
    try {
      const [relevanceResult, hallucinationResult] = await Promise.all([
        evaluateInsightRelevance(bedrock, EVAL_MODEL_ID, query.question, query.sql, query.insights),
        evaluateSQLHallucination(bedrock, EVAL_MODEL_ID, query.question, query.sql),
      ]);

      // Only count non-error results in averages
      if (relevanceResult.label !== 'error' && hallucinationResult.label !== 'error') {
        totalRelevanceScore += relevanceResult.score;
        totalHallucinationScore += hallucinationResult.score;
        llmEvaluatedCount++;
        console.log(`LLM eval [${i + 1}/${llmSample.length}]: relevance=${relevanceResult.score.toFixed(2)} (${relevanceResult.label}), hallucination=${hallucinationResult.score.toFixed(2)} (${hallucinationResult.label})`);
      } else {
        const relErr = relevanceResult.label === 'error' ? relevanceResult.explanation : null;
        const halErr = hallucinationResult.label === 'error' ? hallucinationResult.explanation : null;
        console.warn(`LLM eval [${i + 1}/${llmSample.length}] error: relevance=${relErr}, hallucination=${halErr}`);
      }
    } catch (error) {
      console.error(`LLM evaluation failed for query [${i + 1}]: ${query.question}`, error);
    }
  }

  const avgInsightRelevance = llmEvaluatedCount > 0 ? totalRelevanceScore / llmEvaluatedCount : 0;
  const avgHallucinationScore = llmEvaluatedCount > 0 ? totalHallucinationScore / llmEvaluatedCount : 0;

  // Generate report
  const report: EvaluationReport = {
    date: new Date().toISOString().split('T')[0],
    totalQueries: queries.length,
    syntaxValidRate: queries.length > 0 ? syntaxValid / queries.length : 0,
    executionSuccessRate: queries.length > 0 ? executionSuccess / queries.length : 0,
    avgInsightRelevance,
    avgHallucinationScore,
    llmEvaluatedCount,
    complexityDistribution,
    topErrors: Object.entries(errorCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([error, count]) => ({ error, count })),
  };

  console.log('Evaluation Report:', JSON.stringify(report, null, 2));

  // Emit single-line structured metrics for CloudWatch metric filters
  console.log(JSON.stringify({
    metric: 'EvaluationReport',
    totalQueries: report.totalQueries,
    syntaxValidRate: report.syntaxValidRate,
    executionSuccessRate: report.executionSuccessRate,
    avgInsightRelevance: report.avgInsightRelevance,
    avgHallucinationScore: report.avgHallucinationScore,
    llmEvaluatedCount: report.llmEvaluatedCount,
    simpleQueries: report.complexityDistribution.simple,
    mediumQueries: report.complexityDistribution.medium,
    complexQueries: report.complexityDistribution.complex,
  }));

  // Send to SNS (optional)
  if (REPORT_SNS_TOPIC) {
    await sns.send(new PublishCommand({
      TopicArn: REPORT_SNS_TOPIC,
      Subject: `Analytics Evaluation Report - ${report.date}`,
      Message: formatReport(report),
    }));
    console.log('Report sent to SNS topic');
  }

  console.log('Daily evaluation complete');
};

function formatReport(report: EvaluationReport): string {
  const lines = [
    `Analytics Evaluation Report - ${report.date}`,
    '============================================',
    '',
    `Total Queries: ${report.totalQueries}`,
    '',
    'Code-Based Metrics:',
    `- SQL Syntax Valid: ${(report.syntaxValidRate * 100).toFixed(1)}%`,
    `- Execution Success: ${(report.executionSuccessRate * 100).toFixed(1)}%`,
    '',
    `LLM-Based Metrics (${report.llmEvaluatedCount} queries sampled):`,
    `- Avg Insight Relevance: ${(report.avgInsightRelevance * 100).toFixed(1)}% (0-100%)`,
    `- Avg Hallucination Score: ${(report.avgHallucinationScore * 100).toFixed(1)}% (higher = less hallucination)`,
    '',
    'Complexity Distribution:',
    `- Simple: ${report.complexityDistribution.simple} (${((report.complexityDistribution.simple / report.totalQueries) * 100).toFixed(1)}%)`,
    `- Medium: ${report.complexityDistribution.medium} (${((report.complexityDistribution.medium / report.totalQueries) * 100).toFixed(1)}%)`,
    `- Complex: ${report.complexityDistribution.complex} (${((report.complexityDistribution.complex / report.totalQueries) * 100).toFixed(1)}%)`,
    '',
    'Top Errors:',
    ...report.topErrors.map((e, i) => `${i + 1}. ${e.error}: ${e.count} occurrences`),
    '',
    'View detailed traces at: https://phoenix.songbird.live',
  ];

  return lines.join('\n');
}
