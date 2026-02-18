/**
 * Phoenix OpenTelemetry Tracing Initialization
 *
 * Provides centralized tracing setup for Lambda functions that need to send
 * traces to Arize Phoenix for AI observability.
 */
/**
 * Initialize Phoenix OpenTelemetry tracing for a Lambda function.
 * Call this at the top of Lambda handler files before any other imports.
 *
 * @param projectName - Name of the project/service for tracing (e.g., 'songbird-analytics-chat-query')
 */
export declare function initializeTracing(projectName: string): void;
