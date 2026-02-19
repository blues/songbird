/**
 * Phoenix OpenTelemetry Tracing Initialization
 *
 * Provides centralized tracing setup for Lambda functions that need to send
 * traces to Arize Phoenix for AI observability.
 */

import { register } from '@arizeai/phoenix-otel';
import { trace, context, SpanStatusCode, Span } from '@opentelemetry/api';

let tracer: ReturnType<typeof trace.getTracer> | null = null;

/**
 * Initialize Phoenix OpenTelemetry tracing for a Lambda function.
 * Call this at the top of Lambda handler files before any other imports.
 *
 * @param projectName - Name of the project/service for tracing (e.g., 'songbird-analytics-chat-query')
 */
export function initializeTracing(projectName: string): void {
  // Only initialize if Phoenix endpoint is configured
  if (!process.env.PHOENIX_COLLECTOR_ENDPOINT) {
    console.warn('PHOENIX_COLLECTOR_ENDPOINT not set, tracing disabled');
    return;
  }

  try {
    register({
      projectName,
      url: process.env.PHOENIX_COLLECTOR_ENDPOINT,
      batch: true,
      global: true,
    });

    tracer = trace.getTracer(projectName);
    console.log(`Phoenix tracing initialized for ${projectName}`);
  } catch (error) {
    console.error('Failed to initialize Phoenix tracing:', error);
    // Don't throw - allow Lambda to continue without tracing
  }
}

/**
 * Wrap an async function with an OpenTelemetry span for tracing.
 * This is primarily used to trace LLM calls that aren't auto-instrumented.
 *
 * @param name - Name of the span (e.g., 'bedrock.invoke_model')
 * @param fn - Async function to trace
 * @param attributes - Optional attributes to attach to the span
 * @returns The result of the function
 */
export async function traceAsyncFn<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  if (!tracer) {
    // Tracing not initialized, just run the function
    const mockSpan = trace.getTracer('noop').startSpan('noop');
    const result = await fn(mockSpan);
    mockSpan.end();
    return result;
  }

  return tracer.startActiveSpan(name, async (span) => {
    try {
      // Add attributes if provided
      if (attributes) {
        for (const [key, value] of Object.entries(attributes)) {
          span.setAttribute(key, value);
        }
      }

      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      span.end();
    }
  });
}
