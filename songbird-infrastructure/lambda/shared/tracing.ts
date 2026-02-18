/**
 * Phoenix OpenTelemetry Tracing Initialization
 *
 * Provides centralized tracing setup for Lambda functions that need to send
 * traces to Arize Phoenix for AI observability.
 */

import { register } from '@arizeai/phoenix-otel';

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

    console.log(`Phoenix tracing initialized for ${projectName}`);
  } catch (error) {
    console.error('Failed to initialize Phoenix tracing:', error);
    // Don't throw - allow Lambda to continue without tracing
  }
}
