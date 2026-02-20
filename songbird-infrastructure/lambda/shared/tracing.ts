import { trace, context, SpanStatusCode, SpanKind, Span } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';

const PHOENIX_HTTP_ENDPOINT = process.env.PHOENIX_HTTP_ENDPOINT || 'http://localhost:4318/v1/traces';

let provider: NodeTracerProvider | null = null;
let spanProcessor: BatchSpanProcessor | null = null;

export function initializeTracing(serviceName: string): void {
  if (provider) {
    console.log('Tracing already initialized');
    return;
  }

  // Create resource with service information and Phoenix project name
  const resource = new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: '1.0.0',
    'openinference.project.name': 'Songbird',
  });

  // Create OTLP exporter (HTTP/protobuf)
  const exporter = new OTLPTraceExporter({
    url: PHOENIX_HTTP_ENDPOINT,
  });

  // Create tracer provider
  provider = new NodeTracerProvider({
    resource,
  });

  // Add batch span processor with aggressive settings for Lambda
  spanProcessor = new BatchSpanProcessor(exporter, {
    maxQueueSize: 2048,
    maxExportBatchSize: 512,
    scheduledDelayMillis: 100, // Export quickly
    exportTimeoutMillis: 30000,
  });

  provider.addSpanProcessor(spanProcessor);
  provider.register();

  console.log('OpenTelemetry initialized:', { serviceName, endpoint: PHOENIX_HTTP_ENDPOINT });
}

/**
 * Flush all pending spans to Phoenix
 * CRITICAL for Lambda: Must call this before handler returns or spans won't export
 */
export async function flushSpans(): Promise<void> {
  if (!spanProcessor) {
    console.log('No span processor to flush');
    return;
  }

  try {
    console.log('Flushing spans to Phoenix...');
    await spanProcessor.forceFlush();
    console.log('Spans flushed successfully');
  } catch (error) {
    console.error('Error flushing spans:', error);
  }
}

export async function traceAsyncFn<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes: Record<string, string | number | boolean> = {},
  spanKind?: SpanKind
): Promise<T> {
  const tracer = trace.getTracer('songbird');
  const span = tracer.startSpan(name, { attributes, kind: spanKind });
  console.log(`Creating span: ${name}`);

  // Set this span as the active context so child spans nest under it
  const ctx = trace.setSpan(context.active(), span);

  try {
    const result = await context.with(ctx, () => fn(span));
    span.setStatus({ code: SpanStatusCode.OK });
    console.log(`Span completed successfully: ${name}`);
    return result;
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    span.recordException(error as Error);
    console.error(`Span failed: ${name}`, error);
    throw error;
  } finally {
    span.end();
    console.log(`Span ended: ${name}`);
  }
}
