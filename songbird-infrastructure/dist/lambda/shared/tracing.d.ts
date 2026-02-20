import { SpanKind, Span } from '@opentelemetry/api';
export declare function initializeTracing(serviceName: string): void;
/**
 * Flush all pending spans to Phoenix
 * CRITICAL for Lambda: Must call this before handler returns or spans won't export
 */
export declare function flushSpans(): Promise<void>;
export declare function traceAsyncFn<T>(name: string, fn: (span: Span) => Promise<T>, attributes?: Record<string, string | number | boolean>, spanKind?: SpanKind): Promise<T>;
