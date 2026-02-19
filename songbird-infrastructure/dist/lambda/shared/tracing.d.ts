/**
 * Phoenix OpenTelemetry Tracing Initialization
 *
 * Provides centralized tracing setup for Lambda functions that need to send
 * traces to Arize Phoenix for AI observability.
 */
import { Span } from '@opentelemetry/api';
/**
 * Initialize Phoenix OpenTelemetry tracing for a Lambda function.
 * Call this at the top of Lambda handler files before any other imports.
 *
 * @param projectName - Name of the project/service for tracing (e.g., 'songbird-analytics-chat-query')
 */
export declare function initializeTracing(projectName: string): void;
/**
 * Wrap an async function with an OpenTelemetry span for tracing.
 * This is primarily used to trace LLM calls that aren't auto-instrumented.
 *
 * @param name - Name of the span (e.g., 'bedrock.invoke_model')
 * @param fn - Async function to trace
 * @param attributes - Optional attributes to attach to the span
 * @returns The result of the function
 */
export declare function traceAsyncFn<T>(name: string, fn: (span: Span) => Promise<T>, attributes?: Record<string, string | number | boolean>): Promise<T>;
