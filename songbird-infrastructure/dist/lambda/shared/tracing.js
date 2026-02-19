"use strict";
/**
 * Phoenix OpenTelemetry Tracing Initialization
 *
 * Provides centralized tracing setup for Lambda functions that need to send
 * traces to Arize Phoenix for AI observability.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.traceAsyncFn = exports.initializeTracing = void 0;
const phoenix_otel_1 = require("@arizeai/phoenix-otel");
const api_1 = require("@opentelemetry/api");
let tracer = null;
/**
 * Initialize Phoenix OpenTelemetry tracing for a Lambda function.
 * Call this at the top of Lambda handler files before any other imports.
 *
 * @param projectName - Name of the project/service for tracing (e.g., 'songbird-analytics-chat-query')
 */
function initializeTracing(projectName) {
    // Only initialize if Phoenix endpoint is configured
    if (!process.env.PHOENIX_COLLECTOR_ENDPOINT) {
        console.warn('PHOENIX_COLLECTOR_ENDPOINT not set, tracing disabled');
        return;
    }
    try {
        (0, phoenix_otel_1.register)({
            projectName,
            url: process.env.PHOENIX_COLLECTOR_ENDPOINT,
            batch: true,
            global: true,
        });
        tracer = api_1.trace.getTracer(projectName);
        console.log(`Phoenix tracing initialized for ${projectName}`);
    }
    catch (error) {
        console.error('Failed to initialize Phoenix tracing:', error);
        // Don't throw - allow Lambda to continue without tracing
    }
}
exports.initializeTracing = initializeTracing;
/**
 * Wrap an async function with an OpenTelemetry span for tracing.
 * This is primarily used to trace LLM calls that aren't auto-instrumented.
 *
 * @param name - Name of the span (e.g., 'bedrock.invoke_model')
 * @param fn - Async function to trace
 * @param attributes - Optional attributes to attach to the span
 * @returns The result of the function
 */
async function traceAsyncFn(name, fn, attributes) {
    if (!tracer) {
        // Tracing not initialized, just run the function
        const mockSpan = api_1.trace.getTracer('noop').startSpan('noop');
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
            span.setStatus({ code: api_1.SpanStatusCode.OK });
            return result;
        }
        catch (error) {
            span.setStatus({
                code: api_1.SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : String(error),
            });
            span.recordException(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
        finally {
            span.end();
        }
    });
}
exports.traceAsyncFn = traceAsyncFn;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidHJhY2luZy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL2xhbWJkYS9zaGFyZWQvdHJhY2luZy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7O0dBS0c7OztBQUVILHdEQUFpRDtBQUNqRCw0Q0FBMEU7QUFFMUUsSUFBSSxNQUFNLEdBQThDLElBQUksQ0FBQztBQUU3RDs7Ozs7R0FLRztBQUNILFNBQWdCLGlCQUFpQixDQUFDLFdBQW1CO0lBQ25ELG9EQUFvRDtJQUNwRCxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQywwQkFBMEIsRUFBRSxDQUFDO1FBQzVDLE9BQU8sQ0FBQyxJQUFJLENBQUMsc0RBQXNELENBQUMsQ0FBQztRQUNyRSxPQUFPO0lBQ1QsQ0FBQztJQUVELElBQUksQ0FBQztRQUNILElBQUEsdUJBQVEsRUFBQztZQUNQLFdBQVc7WUFDWCxHQUFHLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQywwQkFBMEI7WUFDM0MsS0FBSyxFQUFFLElBQUk7WUFDWCxNQUFNLEVBQUUsSUFBSTtTQUNiLENBQUMsQ0FBQztRQUVILE1BQU0sR0FBRyxXQUFLLENBQUMsU0FBUyxDQUFDLFdBQVcsQ0FBQyxDQUFDO1FBQ3RDLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUNBQW1DLFdBQVcsRUFBRSxDQUFDLENBQUM7SUFDaEUsQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDZixPQUFPLENBQUMsS0FBSyxDQUFDLHVDQUF1QyxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQzlELHlEQUF5RDtJQUMzRCxDQUFDO0FBQ0gsQ0FBQztBQXJCRCw4Q0FxQkM7QUFFRDs7Ozs7Ozs7R0FRRztBQUNJLEtBQUssVUFBVSxZQUFZLENBQ2hDLElBQVksRUFDWixFQUE4QixFQUM5QixVQUFzRDtJQUV0RCxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDWixpREFBaUQ7UUFDakQsTUFBTSxRQUFRLEdBQUcsV0FBSyxDQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDM0QsTUFBTSxNQUFNLEdBQUcsTUFBTSxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDbEMsUUFBUSxDQUFDLEdBQUcsRUFBRSxDQUFDO1FBQ2YsT0FBTyxNQUFNLENBQUM7SUFDaEIsQ0FBQztJQUVELE9BQU8sTUFBTSxDQUFDLGVBQWUsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRSxFQUFFO1FBQ2pELElBQUksQ0FBQztZQUNILDZCQUE2QjtZQUM3QixJQUFJLFVBQVUsRUFBRSxDQUFDO2dCQUNmLEtBQUssTUFBTSxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxFQUFFLENBQUM7b0JBQ3RELElBQUksQ0FBQyxZQUFZLENBQUMsR0FBRyxFQUFFLEtBQUssQ0FBQyxDQUFDO2dCQUNoQyxDQUFDO1lBQ0gsQ0FBQztZQUVELE1BQU0sTUFBTSxHQUFHLE1BQU0sRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQzlCLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxJQUFJLEVBQUUsb0JBQWMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1lBQzVDLE9BQU8sTUFBTSxDQUFDO1FBQ2hCLENBQUM7UUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1lBQ2YsSUFBSSxDQUFDLFNBQVMsQ0FBQztnQkFDYixJQUFJLEVBQUUsb0JBQWMsQ0FBQyxLQUFLO2dCQUMxQixPQUFPLEVBQUUsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQzthQUNoRSxDQUFDLENBQUM7WUFDSCxJQUFJLENBQUMsZUFBZSxDQUFDLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsSUFBSSxLQUFLLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUNoRixNQUFNLEtBQUssQ0FBQztRQUNkLENBQUM7Z0JBQVMsQ0FBQztZQUNULElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztRQUNiLENBQUM7SUFDSCxDQUFDLENBQUMsQ0FBQztBQUNMLENBQUM7QUFwQ0Qsb0NBb0NDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBQaG9lbml4IE9wZW5UZWxlbWV0cnkgVHJhY2luZyBJbml0aWFsaXphdGlvblxuICpcbiAqIFByb3ZpZGVzIGNlbnRyYWxpemVkIHRyYWNpbmcgc2V0dXAgZm9yIExhbWJkYSBmdW5jdGlvbnMgdGhhdCBuZWVkIHRvIHNlbmRcbiAqIHRyYWNlcyB0byBBcml6ZSBQaG9lbml4IGZvciBBSSBvYnNlcnZhYmlsaXR5LlxuICovXG5cbmltcG9ydCB7IHJlZ2lzdGVyIH0gZnJvbSAnQGFyaXplYWkvcGhvZW5peC1vdGVsJztcbmltcG9ydCB7IHRyYWNlLCBjb250ZXh0LCBTcGFuU3RhdHVzQ29kZSwgU3BhbiB9IGZyb20gJ0BvcGVudGVsZW1ldHJ5L2FwaSc7XG5cbmxldCB0cmFjZXI6IFJldHVyblR5cGU8dHlwZW9mIHRyYWNlLmdldFRyYWNlcj4gfCBudWxsID0gbnVsbDtcblxuLyoqXG4gKiBJbml0aWFsaXplIFBob2VuaXggT3BlblRlbGVtZXRyeSB0cmFjaW5nIGZvciBhIExhbWJkYSBmdW5jdGlvbi5cbiAqIENhbGwgdGhpcyBhdCB0aGUgdG9wIG9mIExhbWJkYSBoYW5kbGVyIGZpbGVzIGJlZm9yZSBhbnkgb3RoZXIgaW1wb3J0cy5cbiAqXG4gKiBAcGFyYW0gcHJvamVjdE5hbWUgLSBOYW1lIG9mIHRoZSBwcm9qZWN0L3NlcnZpY2UgZm9yIHRyYWNpbmcgKGUuZy4sICdzb25nYmlyZC1hbmFseXRpY3MtY2hhdC1xdWVyeScpXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpbml0aWFsaXplVHJhY2luZyhwcm9qZWN0TmFtZTogc3RyaW5nKTogdm9pZCB7XG4gIC8vIE9ubHkgaW5pdGlhbGl6ZSBpZiBQaG9lbml4IGVuZHBvaW50IGlzIGNvbmZpZ3VyZWRcbiAgaWYgKCFwcm9jZXNzLmVudi5QSE9FTklYX0NPTExFQ1RPUl9FTkRQT0lOVCkge1xuICAgIGNvbnNvbGUud2FybignUEhPRU5JWF9DT0xMRUNUT1JfRU5EUE9JTlQgbm90IHNldCwgdHJhY2luZyBkaXNhYmxlZCcpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHRyeSB7XG4gICAgcmVnaXN0ZXIoe1xuICAgICAgcHJvamVjdE5hbWUsXG4gICAgICB1cmw6IHByb2Nlc3MuZW52LlBIT0VOSVhfQ09MTEVDVE9SX0VORFBPSU5ULFxuICAgICAgYmF0Y2g6IHRydWUsXG4gICAgICBnbG9iYWw6IHRydWUsXG4gICAgfSk7XG5cbiAgICB0cmFjZXIgPSB0cmFjZS5nZXRUcmFjZXIocHJvamVjdE5hbWUpO1xuICAgIGNvbnNvbGUubG9nKGBQaG9lbml4IHRyYWNpbmcgaW5pdGlhbGl6ZWQgZm9yICR7cHJvamVjdE5hbWV9YCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRmFpbGVkIHRvIGluaXRpYWxpemUgUGhvZW5peCB0cmFjaW5nOicsIGVycm9yKTtcbiAgICAvLyBEb24ndCB0aHJvdyAtIGFsbG93IExhbWJkYSB0byBjb250aW51ZSB3aXRob3V0IHRyYWNpbmdcbiAgfVxufVxuXG4vKipcbiAqIFdyYXAgYW4gYXN5bmMgZnVuY3Rpb24gd2l0aCBhbiBPcGVuVGVsZW1ldHJ5IHNwYW4gZm9yIHRyYWNpbmcuXG4gKiBUaGlzIGlzIHByaW1hcmlseSB1c2VkIHRvIHRyYWNlIExMTSBjYWxscyB0aGF0IGFyZW4ndCBhdXRvLWluc3RydW1lbnRlZC5cbiAqXG4gKiBAcGFyYW0gbmFtZSAtIE5hbWUgb2YgdGhlIHNwYW4gKGUuZy4sICdiZWRyb2NrLmludm9rZV9tb2RlbCcpXG4gKiBAcGFyYW0gZm4gLSBBc3luYyBmdW5jdGlvbiB0byB0cmFjZVxuICogQHBhcmFtIGF0dHJpYnV0ZXMgLSBPcHRpb25hbCBhdHRyaWJ1dGVzIHRvIGF0dGFjaCB0byB0aGUgc3BhblxuICogQHJldHVybnMgVGhlIHJlc3VsdCBvZiB0aGUgZnVuY3Rpb25cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRyYWNlQXN5bmNGbjxUPihcbiAgbmFtZTogc3RyaW5nLFxuICBmbjogKHNwYW46IFNwYW4pID0+IFByb21pc2U8VD4sXG4gIGF0dHJpYnV0ZXM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBudW1iZXIgfCBib29sZWFuPlxuKTogUHJvbWlzZTxUPiB7XG4gIGlmICghdHJhY2VyKSB7XG4gICAgLy8gVHJhY2luZyBub3QgaW5pdGlhbGl6ZWQsIGp1c3QgcnVuIHRoZSBmdW5jdGlvblxuICAgIGNvbnN0IG1vY2tTcGFuID0gdHJhY2UuZ2V0VHJhY2VyKCdub29wJykuc3RhcnRTcGFuKCdub29wJyk7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZm4obW9ja1NwYW4pO1xuICAgIG1vY2tTcGFuLmVuZCgpO1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICByZXR1cm4gdHJhY2VyLnN0YXJ0QWN0aXZlU3BhbihuYW1lLCBhc3luYyAoc3BhbikgPT4ge1xuICAgIHRyeSB7XG4gICAgICAvLyBBZGQgYXR0cmlidXRlcyBpZiBwcm92aWRlZFxuICAgICAgaWYgKGF0dHJpYnV0ZXMpIHtcbiAgICAgICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoYXR0cmlidXRlcykpIHtcbiAgICAgICAgICBzcGFuLnNldEF0dHJpYnV0ZShrZXksIHZhbHVlKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBmbihzcGFuKTtcbiAgICAgIHNwYW4uc2V0U3RhdHVzKHsgY29kZTogU3BhblN0YXR1c0NvZGUuT0sgfSk7XG4gICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBzcGFuLnNldFN0YXR1cyh7XG4gICAgICAgIGNvZGU6IFNwYW5TdGF0dXNDb2RlLkVSUk9SLFxuICAgICAgICBtZXNzYWdlOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvciksXG4gICAgICB9KTtcbiAgICAgIHNwYW4ucmVjb3JkRXhjZXB0aW9uKGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyb3IpKSk7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgc3Bhbi5lbmQoKTtcbiAgICB9XG4gIH0pO1xufVxuIl19