"use strict";
/**
 * Analytics Evaluators
 *
 * Code-based and LLM-based evaluators for assessing analytics query quality.
 * Used by the daily evaluation Lambda to generate quality reports.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateSQLHallucination = exports.evaluateInsightRelevance = exports.analyzeQueryComplexity = exports.evaluateSQLExecution = exports.evaluateSQLSyntax = void 0;
const client_bedrock_runtime_1 = require("@aws-sdk/client-bedrock-runtime");
/**
 * SQL Syntax Validator
 *
 * Code-based evaluator that checks if generated SQL is valid and safe.
 */
function evaluateSQLSyntax(sql) {
    const errors = [];
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
exports.evaluateSQLSyntax = evaluateSQLSyntax;
/**
 * SQL Execution Success
 *
 * Evaluates whether SQL executed without errors.
 */
function evaluateSQLExecution(executionError, rowCount) {
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
exports.evaluateSQLExecution = evaluateSQLExecution;
/**
 * Query Complexity Analyzer
 *
 * Categorizes query complexity for routing to appropriate models.
 */
function analyzeQueryComplexity(sql) {
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
    let category;
    let normalizedScore;
    if (complexityScore <= 1) {
        category = 'simple';
        normalizedScore = 0.33;
    }
    else if (complexityScore <= 4) {
        category = 'medium';
        normalizedScore = 0.66;
    }
    else {
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
exports.analyzeQueryComplexity = analyzeQueryComplexity;
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
async function callBedrock(bedrock, modelId, prompt) {
    const response = await bedrock.send(new client_bedrock_runtime_1.InvokeModelCommand({
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
function parseLLMJson(text) {
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
async function evaluateInsightRelevance(bedrock, modelId, question, sql, insights) {
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
    }
    catch (error) {
        return {
            name: 'insight_relevance',
            score: 0,
            label: 'error',
            explanation: `Evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
            metadata: { error: true },
        };
    }
}
exports.evaluateInsightRelevance = evaluateInsightRelevance;
/**
 * SQL Hallucination Evaluator (LLM-as-judge)
 *
 * Checks if the generated SQL references valid tables and columns from the schema,
 * and whether the SQL logically addresses the user's question.
 */
async function evaluateSQLHallucination(bedrock, modelId, question, sql) {
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
    }
    catch (error) {
        return {
            name: 'sql_hallucination',
            score: 0,
            label: 'error',
            explanation: `Evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
            metadata: { error: true },
        };
    }
}
exports.evaluateSQLHallucination = evaluateSQLHallucination;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZhbHVhdG9ycy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL2xhbWJkYS9hbmFseXRpY3MvZXZhbHVhdG9ycy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7O0dBS0c7OztBQUVILDRFQUEyRjtBQVUzRjs7OztHQUlHO0FBQ0gsU0FBZ0IsaUJBQWlCLENBQUMsR0FBVztJQUMzQyxNQUFNLE1BQU0sR0FBYSxFQUFFLENBQUM7SUFDNUIsSUFBSSxLQUFLLEdBQUcsR0FBRyxDQUFDO0lBRWhCLDBDQUEwQztJQUMxQyxNQUFNLE9BQU8sR0FBRyxHQUFHLENBQUMsSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFLENBQUM7SUFDekMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUM7UUFDakUsTUFBTSxDQUFDLElBQUksQ0FBQyxvQ0FBb0MsQ0FBQyxDQUFDO1FBQ2xELEtBQUssR0FBRyxDQUFDLENBQUM7SUFDWixDQUFDO0lBRUQsaUNBQWlDO0lBQ2pDLE1BQU0sU0FBUyxHQUFHLENBQUMsUUFBUSxFQUFFLFFBQVEsRUFBRSxRQUFRLEVBQUUsTUFBTSxFQUFFLFVBQVUsRUFBRSxPQUFPLEVBQUUsUUFBUSxDQUFDLENBQUM7SUFDeEYsS0FBSyxNQUFNLE9BQU8sSUFBSSxTQUFTLEVBQUUsQ0FBQztRQUNoQyxJQUFJLE9BQU8sQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUM5QixNQUFNLENBQUMsSUFBSSxDQUFDLCtCQUErQixPQUFPLEVBQUUsQ0FBQyxDQUFDO1lBQ3RELEtBQUssR0FBRyxDQUFDLENBQUM7UUFDWixDQUFDO0lBQ0gsQ0FBQztJQUVELHNDQUFzQztJQUN0QyxJQUFJLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxlQUFlLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxRQUFRLENB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QUNmLE9BQU87WUFDTCxJQUFJLEVBQUUsbUJBQW1CO1lBQ3pCLEtBQUssRUFBRSxDQUFDO1lBQ1IsS0FBSyxFQUFFLE9BQU87WUFDZCxXQUFXLEVBQUUsc0JBQXNCLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsRUFBRTtZQUMzRixRQUFRLEVBQUUsRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFO1NBQzFCLENBQUM7SUFDSixDQUFDO0FBQ0gsQ0FBQztBQXpERCw0REF5REMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEFuYWx5dGljcyBFdmFsdWF0b3JzXG4gKlxuICogQ29kZS1iYXNlZCBhbmQgTExNLWJhc2VkIGV2YWx1YXRvcnMgZm9yIGFzc2Vzc2luZyBhbmFseXRpY3MgcXVlcnkgcXVhbGl0eS5cbiAqIFVzZWQgYnkgdGhlIGRhaWx5IGV2YWx1YXRpb24gTGFtYmRhIHRvIGdlbmVyYXRlIHF1YWxpdHkgcmVwb3J0cy5cbiAqL1xuXG5pbXBvcnQgeyBCZWRyb2NrUnVudGltZUNsaWVudCwgSW52b2tlTW9kZWxDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LWJlZHJvY2stcnVudGltZSc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRXZhbHVhdGlvblJlc3VsdCB7XG4gIG5hbWU6IHN0cmluZztcbiAgc2NvcmU6IG51bWJlcjsgLy8gMC0xIGZvciBjb2RlLWJhc2VkLCBub3JtYWxpemVkIGZyb20gMS01IGZvciBMTE0tYmFzZWRcbiAgbGFiZWw/OiBzdHJpbmc7XG4gIGV4cGxhbmF0aW9uPzogc3RyaW5nO1xuICBtZXRhZGF0YT86IFJlY29yZDxzdHJpbmcsIGFueT47XG59XG5cbi8qKlxuICogU1FMIFN5bnRheCBWYWxpZGF0b3JcbiAqXG4gKiBDb2RlLWJhc2VkIGV2YWx1YXRvciB0aGF0IGNoZWNrcyBpZiBnZW5lcmF0ZWQgU1FMIGlzIHZhbGlkIGFuZCBzYWZlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXZhbHVhdGVTUUxTeW50YXgoc3FsOiBzdHJpbmcpOiBFdmFsdWF0aW9uUmVzdWx0IHtcbiAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgc2NvcmUgPSAxLjA7XG5cbiAgLy8gQ2hlY2sgMTogTXVzdCBzdGFydCB3aXRoIFNFTEVDVCBvciBXSVRIXG4gIGNvbnN0IHRyaW1tZWQgPSBzcWwudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gIGlmICghdHJpbW1lZC5zdGFydHNXaXRoKCdzZWxlY3QnKSAmJiAhdHJpbW1lZC5zdGFydHNXaXRoKCd3aXRoJykpIHtcbiAgICBlcnJvcnMucHVzaCgnU1FMIG11c3Qgc3RhcnQgd2l0aCBTRUxFQ1Qgb3IgV0lUSCcpO1xuICAgIHNjb3JlID0gMDtcbiAgfVxuXG4gIC8vIENoZWNrIDI6IE5vIGRhbmdlcm91cyBrZXl3b3Jkc1xuICBjb25zdCBkYW5nZXJvdXMgPSBbJ2luc2VydCcsICd1cGRhdGUnLCAnZGVsZXRlJywgJ2Ryb3AnLCAndHJ1bmNhdGUnLCAnYWx0ZXInLCAnY3JlYXRlJ107XG4gIGZvciAoY29uc3Qga2V5d29yZCBvZiBkYW5nZXJvdXMpIHtcbiAgICBpZiAodHJpbW1lZC5pbmNsdWRlcyhrZXl3b3JkKSkge1xuICAgICAgZXJyb3JzLnB1c2goYERhbmdlcm91cyBrZXl3b3JkIGRldGVjdGVkOiAke2tleXdvcmR9YCk7XG4gICAgICBzY29yZSA9IDA7XG4gICAgfVxuICB9XG5cbiAgLy8gQ2hlY2sgMzogTXVzdCBpbmNsdWRlIGRldmljZSBmaWx0ZXJcbiAgaWYgKCFzcWwuaW5jbHVkZXMoJzpkZXZpY2VGaWx0ZXInKSAmJiAhc3FsLmluY2x1ZGVzKCdzZXJpYWxfbnVtYmVyIElOJykpIHtcbiAgICBlcnJvcnMucHVzaCgnTWlzc2luZyByZXF1aXJlZCBkZXZpY2UgZmlsdGVyJyk7XG4gICAgc2NvcmUgPSBNYXRoLm1heCgwLCBzY29yZSAtIDAuMyk7XG4gIH1cblxuICAvLyBDaGVjayA0OiBIYXMgTElNSVQgY2xhdXNlIChwcmV2ZW50cyBtYXNzaXZlIHJlc3VsdCBzZXRzKVxuICBpZiAoIXRyaW1tZWQuaW5jbHVkZXMoJ2xpbWl0JykpIHtcbiAgICBlcnJvcnMucHVzaCgnTWlzc2luZyBMSU1JVCBjbGF1c2UnKTtcbiAgICBzY29yZSA9IE1hdGgubWF4KDAsIHNjb3JlIC0gMC4yKTtcbiAgfVxuXG4gIC8vIENoZWNrIDU6IEJhc2ljIHN5bnRheCBjaGVja3NcbiAgY29uc3Qgb3BlblBhcmVucyA9IChzcWwubWF0Y2goL1xcKC9nKSB8fCBbXSkubGVuZ3RoO1xuICBjb25zdCBjbG9zZVBhcmVucyA9IChzcWwubWF0Y2goL1xcKS9nKSB8fCBbXSkubGVuZ3RoO1xuICBpZiAob3BlblBhcmVucyAhPT0gY2xvc2VQYXJlbnMpIHtcbiAgICBlcnJvcnMucHVzaCgnVW5tYXRjaGVkIHBhcmVudGhlc2VzJyk7XG4gICAgc2NvcmUgPSBNYXRoLm1heCgwLCBzY29yZSAtIDAuMyk7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIG5hbWU6ICdzcWxfc3ludGF4X3ZhbGlkJyxcbiAgICBzY29yZSxcbiAgICBsYWJlbDogc2NvcmUgPT09IDEuMCA/ICd2YWxpZCcgOiAnaW52YWxpZCcsXG4gICAgZXhwbGFuYXRpb246IGVycm9ycy5sZW5ndGggPiAwID8gZXJyb3JzLmpvaW4oJzsgJykgOiAnU1FMIHN5bnRheCBpcyB2YWxpZCcsXG4gICAgbWV0YWRhdGE6IHtcbiAgICAgIGVycm9yX2NvdW50OiBlcnJvcnMubGVuZ3RoLFxuICAgICAgZXJyb3JzLFxuICAgIH0sXG4gIH07XG59XG5cbi8qKlxuICogU1FMIEV4ZWN1dGlvbiBTdWNjZXNzXG4gKlxuICogRXZhbHVhdGVzIHdoZXRoZXIgU1FMIGV4ZWN1dGVkIHdpdGhvdXQgZXJyb3JzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXZhbHVhdGVTUUxFeGVjdXRpb24oXG4gIGV4ZWN1dGlvbkVycm9yOiBzdHJpbmcgfCBudWxsLFxuICByb3dDb3VudDogbnVtYmVyXG4pOiBFdmFsdWF0aW9uUmVzdWx0IHtcbiAgY29uc3QgaGFzRXJyb3IgPSAhIWV4ZWN1dGlvbkVycm9yO1xuICBjb25zdCBzY29yZSA9IGhhc0Vycm9yID8gMCA6IDE7XG5cbiAgcmV0dXJuIHtcbiAgICBuYW1lOiAnc3FsX2V4ZWN1dGlvbl9zdWNjZXNzJyxcbiAgICBzY29yZSxcbiAgICBsYWJlbDogaGFzRXJyb3IgPyAnZmFpbGVkJyA6ICdzdWNjZXNzJyxcbiAgICBleHBsYW5hdGlvbjogaGFzRXJyb3JcbiAgICAgID8gYEV4ZWN1dGlvbiBmYWlsZWQ6ICR7ZXhlY3V0aW9uRXJyb3J9YFxuICAgICAgOiBgU1FMIGV4ZWN1dGVkIHN1Y2Nlc3NmdWxseSwgcmV0dXJuZWQgJHtyb3dDb3VudH0gcm93c2AsXG4gICAgbWV0YWRhdGE6IHtcbiAgICAgIGVycm9yOiBleGVjdXRpb25FcnJvcixcbiAgICAgIHJvd19jb3VudDogcm93Q291bnQsXG4gICAgfSxcbiAgfTtcbn1cblxuLyoqXG4gKiBRdWVyeSBDb21wbGV4aXR5IEFuYWx5emVyXG4gKlxuICogQ2F0ZWdvcml6ZXMgcXVlcnkgY29tcGxleGl0eSBmb3Igcm91dGluZyB0byBhcHByb3ByaWF0ZSBtb2RlbHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhbmFseXplUXVlcnlDb21wbGV4aXR5KHNxbDogc3RyaW5nKTogRXZhbHVhdGlvblJlc3VsdCB7XG4gIGxldCBjb21wbGV4aXR5U2NvcmUgPSAwO1xuXG4gIC8vIENvdW50IENURXMgKFdJVEggY2xhdXNlcylcbiAgY29uc3QgY3RlQ291bnQgPSAoc3FsLm1hdGNoKC9cXGJXSVRIXFxiL2dpKSB8fCBbXSkubGVuZ3RoO1xuICBjb21wbGV4aXR5U2NvcmUgKz0gY3RlQ291bnQgKiAyO1xuXG4gIC8vIENvdW50IHN1YnF1ZXJpZXNcbiAgY29uc3Qgc3VicXVlcnlDb3VudCA9IChzcWwubWF0Y2goL1xcKFxccypTRUxFQ1QvZ2kpIHx8IFtdKS5sZW5ndGg7XG4gIGNvbXBsZXhpdHlTY29yZSArPSBzdWJxdWVyeUNvdW50O1xuXG4gIC8vIENvdW50IEpPSU5zXG4gIGNvbnN0IGpvaW5Db3VudCA9IChzcWwubWF0Y2goL1xcYkpPSU5cXGIvZ2kpIHx8IFtdKS5sZW5ndGg7XG4gIGNvbXBsZXhpdHlTY29yZSArPSBqb2luQ291bnQ7XG5cbiAgLy8gQ291bnQgd2luZG93IGZ1bmN0aW9uc1xuICBjb25zdCB3aW5kb3dDb3VudCA9IChzcWwubWF0Y2goL1xcYk9WRVJcXHMqXFwoL2dpKSB8fCBbXSkubGVuZ3RoO1xuICBjb21wbGV4aXR5U2NvcmUgKz0gd2luZG93Q291bnQgKiAxLjU7XG5cbiAgLy8gRGV0ZXJtaW5lIGNhdGVnb3J5XG4gIGxldCBjYXRlZ29yeTogJ3NpbXBsZScgfCAnbWVkaXVtJyB8ICdjb21wbGV4JztcbiAgbGV0IG5vcm1hbGl6ZWRTY29yZTogbnVtYmVyO1xuXG4gIGlmIChjb21wbGV4aXR5U2NvcmUgPD0gMSkge1xuICAgIGNhdGVnb3J5ID0gJ3NpbXBsZSc7XG4gICAgbm9ybWFsaXplZFNjb3JlID0gMC4zMztcbiAgfSBlbHNlIGlmIChjb21wbGV4aXR5U2NvcmUgPD0gNCkge1xuICAgIGNhdGVnb3J5ID0gJ21lZGl1bSc7XG4gICAgbm9ybWFsaXplZFNjb3JlID0gMC42NjtcbiAgfSBlbHNlIHtcbiAgICBjYXRlZ29yeSA9ICdjb21wbGV4JztcbiAgICBub3JtYWxpemVkU2NvcmUgPSAxLjA7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIG5hbWU6ICdxdWVyeV9jb21wbGV4aXR5JyxcbiAgICBzY29yZTogbm9ybWFsaXplZFNjb3JlLFxuICAgIGxhYmVsOiBjYXRlZ29yeSxcbiAgICBleHBsYW5hdGlvbjogYFF1ZXJ5IGNvbXBsZXhpdHk6ICR7Y2F0ZWdvcnl9IChzY29yZTogJHtjb21wbGV4aXR5U2NvcmV9KWAsXG4gICAgbWV0YWRhdGE6IHtcbiAgICAgIGNvbXBsZXhpdHlfc2NvcmU6IGNvbXBsZXhpdHlTY29yZSxcbiAgICAgIGN0ZV9jb3VudDogY3RlQ291bnQsXG4gICAgICBzdWJxdWVyeV9jb3VudDogc3VicXVlcnlDb3VudCxcbiAgICAgIGpvaW5fY291bnQ6IGpvaW5Db3VudCxcbiAgICAgIHdpbmRvd19jb3VudDogd2luZG93Q291bnQsXG4gICAgfSxcbiAgfTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIExMTS1iYXNlZCBFdmFsdWF0b3JzIChyZXF1aXJlIEJlZHJvY2sgY2xpZW50KVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuY29uc3QgU0NIRU1BX1RBQkxFUyA9IGBcbmFuYWx5dGljcy5kZXZpY2VzOiBzZXJpYWxfbnVtYmVyLCBkZXZpY2VfdWlkLCBuYW1lLCBmbGVldF9uYW1lLCBmbGVldF91aWQsIHN0YXR1cywgbGFzdF9zZWVuLCB2b2x0YWdlLCB0ZW1wZXJhdHVyZSwgbGFzdF9sb2NhdGlvbl9sYXQsIGxhc3RfbG9jYXRpb25fbG9uXG5hbmFseXRpY3MudGVsZW1ldHJ5OiBkZXZpY2VfdWlkLCBzZXJpYWxfbnVtYmVyLCB0aW1lLCB0ZW1wZXJhdHVyZSwgaHVtaWRpdHksIHByZXNzdXJlLCB2b2x0YWdlLCBldmVudF90eXBlXG5hbmFseXRpY3MubG9jYXRpb25zOiBkZXZpY2VfdWlkLCBzZXJpYWxfbnVtYmVyLCB0aW1lLCBsYXQsIGxvbiwgc291cmNlLCBqb3VybmV5X2lkXG5hbmFseXRpY3MuYWxlcnRzOiBhbGVydF9pZCwgZGV2aWNlX3VpZCwgc2VyaWFsX251bWJlciwgYWxlcnRfdHlwZSwgc2V2ZXJpdHksIG1lc3NhZ2UsIGFja25vd2xlZGdlZCwgY3JlYXRlZF9hdFxuYW5hbHl0aWNzLmpvdXJuZXlzOiBkZXZpY2VfdWlkLCBzZXJpYWxfbnVtYmVyLCBqb3VybmV5X2lkLCBzdGFydF90aW1lLCBlbmRfdGltZSwgc3RhdHVzLCBkaXN0YW5jZV9rbVxuYC50cmltKCk7XG5cbi8qKlxuICogQ2FsbCBCZWRyb2NrIENsYXVkZSB3aXRoIGEgcHJvbXB0IGFuZCByZXR1cm4gdGhlIHRleHQgcmVzcG9uc2UuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNhbGxCZWRyb2NrKFxuICBiZWRyb2NrOiBCZWRyb2NrUnVudGltZUNsaWVudCxcbiAgbW9kZWxJZDogc3RyaW5nLFxuICBwcm9tcHQ6IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgYmVkcm9jay5zZW5kKG5ldyBJbnZva2VNb2RlbENvbW1hbmQoe1xuICAgIG1vZGVsSWQsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgYW50aHJvcGljX3ZlcnNpb246ICdiZWRyb2NrLTIwMjMtMDUtMzEnLFxuICAgICAgbWF4X3Rva2VuczogNTEyLFxuICAgICAgbWVzc2FnZXM6IFt7IHJvbGU6ICd1c2VyJywgY29udGVudDogcHJvbXB0IH1dLFxuICAgIH0pLFxuICB9KSk7XG5cbiAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UobmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHJlc3BvbnNlLmJvZHkpKTtcbiAgcmV0dXJuIGJvZHkuY29udGVudFswXS50ZXh0O1xufVxuXG4vKipcbiAqIFBhcnNlIGEgSlNPTiByZXNwb25zZSBmcm9tIHRoZSBMTE0sIGhhbmRsaW5nIG1hcmtkb3duIGNvZGUgYmxvY2tzLlxuICovXG5mdW5jdGlvbiBwYXJzZUxMTUpzb24odGV4dDogc3RyaW5nKTogYW55IHtcbiAgbGV0IGpzb25UZXh0ID0gdGV4dDtcbiAgY29uc3QgbWF0Y2ggPSB0ZXh0Lm1hdGNoKC9gYGBqc29uXFxuKFtcXHNcXFNdKz8pXFxuYGBgLykgfHwgdGV4dC5tYXRjaCgvYGBgXFxuKFtcXHNcXFNdKz8pXFxuYGBgLyk7XG4gIGlmIChtYXRjaCkge1xuICAgIGpzb25UZXh0ID0gbWF0Y2hbMV07XG4gIH1cbiAgcmV0dXJuIEpTT04ucGFyc2UoanNvblRleHQudHJpbSgpKTtcbn1cblxuLyoqXG4gKiBJbnNpZ2h0IFJlbGV2YW5jZSBFdmFsdWF0b3IgKExMTS1hcy1qdWRnZSlcbiAqXG4gKiBSYXRlcyBob3cgd2VsbCB0aGUgZ2VuZXJhdGVkIGluc2lnaHQgYW5zd2VycyB0aGUgdXNlcidzIHF1ZXN0aW9uLlxuICogUmV0dXJucyBhIHNjb3JlIGZyb20gMS01LCBub3JtYWxpemVkIHRvIDAtMS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGV2YWx1YXRlSW5zaWdodFJlbGV2YW5jZShcbiAgYmVkcm9jazogQmVkcm9ja1J1bnRpbWVDbGllbnQsXG4gIG1vZGVsSWQ6IHN0cmluZyxcbiAgcXVlc3Rpb246IHN0cmluZyxcbiAgc3FsOiBzdHJpbmcsXG4gIGluc2lnaHRzOiBzdHJpbmcsXG4pOiBQcm9taXNlPEV2YWx1YXRpb25SZXN1bHQ+IHtcbiAgY29uc3QgcHJvbXB0ID0gYFlvdSBhcmUgZXZhbHVhdGluZyB0aGUgcXVhbGl0eSBvZiBhbiBBSS1nZW5lcmF0ZWQgYW5hbHl0aWNzIGluc2lnaHQuXG5cblVzZXIgUXVlc3Rpb246IFwiJHtxdWVzdGlvbn1cIlxuXG5HZW5lcmF0ZWQgU1FMOlxuJHtzcWx9XG5cbkdlbmVyYXRlZCBJbnNpZ2h0OlxuJHtpbnNpZ2h0c31cblxuUmF0ZSB0aGUgaW5zaWdodCBvbiBhIHNjYWxlIG9mIDEtNTpcbjEgPSBDb21wbGV0ZWx5IGlycmVsZXZhbnQsIGRvZXMgbm90IGFkZHJlc3MgdGhlIHF1ZXN0aW9uIGF0IGFsbFxuMiA9IFBhcnRpYWxseSByZWxldmFudCBidXQgbWlzc2VzIGtleSBhc3BlY3RzIG9mIHRoZSBxdWVzdGlvblxuMyA9IFNvbWV3aGF0IHJlbGV2YW50LCBhZGRyZXNzZXMgdGhlIHF1ZXN0aW9uIGJ1dCB3aXRoIHNpZ25pZmljYW50IGdhcHNcbjQgPSBNb3N0bHkgcmVsZXZhbnQsIGFuc3dlcnMgdGhlIHF1ZXN0aW9uIHdpdGggbWlub3Igb21pc3Npb25zXG41ID0gSGlnaGx5IHJlbGV2YW50LCBkaXJlY3RseSBhbmQgY29tcGxldGVseSBhbnN3ZXJzIHRoZSBxdWVzdGlvblxuXG5SZXNwb25kIHdpdGggSlNPTiBvbmx5Olxue1wic2NvcmVcIjogPDEtNT4sIFwiZXhwbGFuYXRpb25cIjogXCI8YnJpZWYgZXhwbGFuYXRpb24gb2YgcmF0aW5nPlwifWA7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGNhbGxCZWRyb2NrKGJlZHJvY2ssIG1vZGVsSWQsIHByb21wdCk7XG4gICAgY29uc3QgcmVzdWx0ID0gcGFyc2VMTE1Kc29uKHJlc3BvbnNlKTtcbiAgICBjb25zdCByYXdTY29yZSA9IE1hdGgubWluKDUsIE1hdGgubWF4KDEsIHJlc3VsdC5zY29yZSkpO1xuICAgIGNvbnN0IG5vcm1hbGl6ZWRTY29yZSA9IChyYXdTY29yZSAtIDEpIC8gNDsgLy8gTWFwIDEtNSB0byAwLTFcblxuICAgIHJldHVybiB7XG4gICAgICBuYW1lOiAnaW5zaWdodF9yZWxldmFuY2UnLFxuICAgICAgc2NvcmU6IG5vcm1hbGl6ZWRTY29yZSxcbiAgICAgIGxhYmVsOiByYXdTY29yZSA+PSA0ID8gJ3JlbGV2YW50JyA6IHJhd1Njb3JlID49IDMgPyAncGFydGlhbCcgOiAnaXJyZWxldmFudCcsXG4gICAgICBleHBsYW5hdGlvbjogcmVzdWx0LmV4cGxhbmF0aW9uLFxuICAgICAgbWV0YWRhdGE6IHsgcmF3X3Njb3JlOiByYXdTY29yZSB9LFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG5hbWU6ICdpbnNpZ2h0X3JlbGV2YW5jZScsXG4gICAgICBzY29yZTogMCxcbiAgICAgIGxhYmVsOiAnZXJyb3InLFxuICAgICAgZXhwbGFuYXRpb246IGBFdmFsdWF0aW9uIGZhaWxlZDogJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcil9YCxcbiAgICAgIG1ldGFkYXRhOiB7IGVycm9yOiB0cnVlIH0sXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIFNRTCBIYWxsdWNpbmF0aW9uIEV2YWx1YXRvciAoTExNLWFzLWp1ZGdlKVxuICpcbiAqIENoZWNrcyBpZiB0aGUgZ2VuZXJhdGVkIFNRTCByZWZlcmVuY2VzIHZhbGlkIHRhYmxlcyBhbmQgY29sdW1ucyBmcm9tIHRoZSBzY2hlbWEsXG4gKiBhbmQgd2hldGhlciB0aGUgU1FMIGxvZ2ljYWxseSBhZGRyZXNzZXMgdGhlIHVzZXIncyBxdWVzdGlvbi5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGV2YWx1YXRlU1FMSGFsbHVjaW5hdGlvbihcbiAgYmVkcm9jazogQmVkcm9ja1J1bnRpbWVDbGllbnQsXG4gIG1vZGVsSWQ6IHN0cmluZyxcbiAgcXVlc3Rpb246IHN0cmluZyxcbiAgc3FsOiBzdHJpbmcsXG4pOiBQcm9taXNlPEV2YWx1YXRpb25SZXN1bHQ+IHtcbiAgY29uc3QgcHJvbXB0ID0gYFlvdSBhcmUgZXZhbHVhdGluZyBhIGdlbmVyYXRlZCBTUUwgcXVlcnkgZm9yIGhhbGx1Y2luYXRpb25zIGFuZCBjb3JyZWN0bmVzcy5cblxuRGF0YWJhc2UgU2NoZW1hOlxuJHtTQ0hFTUFfVEFCTEVTfVxuXG5Vc2VyIFF1ZXN0aW9uOiBcIiR7cXVlc3Rpb259XCJcblxuR2VuZXJhdGVkIFNRTDpcbiR7c3FsfVxuXG5DaGVjayBmb3IgdGhlc2UgaXNzdWVzOlxuMS4gRG9lcyB0aGUgU1FMIHJlZmVyZW5jZSBhbnkgdGFibGVzIHRoYXQgZG9uJ3QgZXhpc3QgaW4gdGhlIHNjaGVtYT9cbjIuIERvZXMgdGhlIFNRTCByZWZlcmVuY2UgYW55IGNvbHVtbnMgdGhhdCBkb24ndCBleGlzdCBpbiB0aGUgbGlzdGVkIHRhYmxlcz9cbjMuIERvZXMgdGhlIFNRTCBsb2dpY2FsbHkgYWRkcmVzcyB0aGUgdXNlcidzIHF1ZXN0aW9uP1xuNC4gQXJlIHRoZXJlIGFueSBpbXBvc3NpYmxlIG9wZXJhdGlvbnMgKGUuZy4sIGpvaW5pbmcgb24gbm9uLWV4aXN0ZW50IGtleXMpP1xuXG5SYXRlIHRoZSBTUUwgb24gYSBzY2FsZSBvZiAxLTU6XG4xID0gU2V2ZXJlIGhhbGx1Y2luYXRpb24gKG5vbi1leGlzdGVudCB0YWJsZXMvY29sdW1ucywgY29tcGxldGVseSB3cm9uZyBhcHByb2FjaClcbjIgPSBTaWduaWZpY2FudCBpc3N1ZXMgKHdyb25nIGNvbHVtbnMgb3IgdGFibGVzLCBwYXJ0aWFsbHkgd3JvbmcgbG9naWMpXG4zID0gTWlub3IgaXNzdWVzIChjb3JyZWN0IHRhYmxlcy9jb2x1bW5zIGJ1dCBxdWVzdGlvbmFibGUgbG9naWMpXG40ID0gTW9zdGx5IGNvcnJlY3QgKHZhbGlkIHNjaGVtYSByZWZlcmVuY2VzLCBzb3VuZCBsb2dpYyB3aXRoIG1pbm9yIGlzc3VlcylcbjUgPSBObyBoYWxsdWNpbmF0aW9uIChhbGwgcmVmZXJlbmNlcyB2YWxpZCwgbG9naWMgY29ycmVjdGx5IGFkZHJlc3NlcyBxdWVzdGlvbilcblxuUmVzcG9uZCB3aXRoIEpTT04gb25seTpcbntcInNjb3JlXCI6IDwxLTU+LCBcImlzc3Vlc1wiOiBbXCI8aXNzdWUxPlwiLCBcIjxpc3N1ZTI+XCJdLCBcImV4cGxhbmF0aW9uXCI6IFwiPGJyaWVmIHN1bW1hcnk+XCJ9YDtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgY2FsbEJlZHJvY2soYmVkcm9jaywgbW9kZWxJZCwgcHJvbXB0KTtcbiAgICBjb25zdCByZXN1bHQgPSBwYXJzZUxMTUpzb24ocmVzcG9uc2UpO1xuICAgIGNvbnN0IHJhd1Njb3JlID0gTWF0aC5taW4oNSwgTWF0aC5tYXgoMSwgcmVzdWx0LnNjb3JlKSk7XG4gICAgY29uc3Qgbm9ybWFsaXplZFNjb3JlID0gKHJhd1Njb3JlIC0gMSkgLyA0OyAvLyBNYXAgMS01IHRvIDAtMVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIG5hbWU6ICdzcWxfaGFsbHVjaW5hdGlvbicsXG4gICAgICBzY29yZTogbm9ybWFsaXplZFNjb3JlLFxuICAgICAgbGFiZWw6IHJhd1Njb3JlID49IDQgPyAndmFsaWQnIDogcmF3U2NvcmUgPj0gMyA/ICdtaW5vcl9pc3N1ZXMnIDogJ2hhbGx1Y2luYXRpb24nLFxuICAgICAgZXhwbGFuYXRpb246IHJlc3VsdC5leHBsYW5hdGlvbixcbiAgICAgIG1ldGFkYXRhOiB7XG4gICAgICAgIHJhd19zY29yZTogcmF3U2NvcmUsXG4gICAgICAgIGlzc3VlczogcmVzdWx0Lmlzc3VlcyB8fCBbXSxcbiAgICAgIH0sXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4ge1xuICAgICAgbmFtZTogJ3NxbF9oYWxsdWNpbmF0aW9uJyxcbiAgICAgIHNjb3JlOiAwLFxuICAgICAgbGFiZWw6ICdlcnJvcicsXG4gICAgICBleHBsYW5hdGlvbjogYEV2YWx1YXRpb24gZmFpbGVkOiAke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKX1gLFxuICAgICAgbWV0YWRhdGE6IHsgZXJyb3I6IHRydWUgfSxcbiAgICB9O1xuICB9XG59XG4iXX0=