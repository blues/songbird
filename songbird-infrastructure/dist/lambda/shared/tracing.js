"use strict";
/**
 * Phoenix OpenTelemetry Tracing Initialization
 *
 * Provides centralized tracing setup for Lambda functions that need to send
 * traces to Arize Phoenix for AI observability.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeTracing = void 0;
const phoenix_otel_1 = require("@arizeai/phoenix-otel");
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
        console.log(`Phoenix tracing initialized for ${projectName}`);
    }
    catch (error) {
        console.error('Failed to initialize Phoenix tracing:', error);
        // Don't throw - allow Lambda to continue without tracing
    }
}
exports.initializeTracing = initializeTracing;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidHJhY2luZy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL2xhbWJkYS9zaGFyZWQvdHJhY2luZy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7O0dBS0c7OztBQUVILHdEQUFpRDtBQUVqRDs7Ozs7R0FLRztBQUNILFNBQWdCLGlCQUFpQixDQUFDLFdBQW1CO0lBQ25ELG9EQUFvRDtJQUNwRCxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQywwQkFBMEIsRUFBRSxDQUFDO1FBQzVDLE9BQU8sQ0FBQyxJQUFJLENBQUMsc0RBQXNELENBQUMsQ0FBQztRQUNyRSxPQUFPO0lBQ1QsQ0FBQztJQUVELElBQUksQ0FBQztRQUNILElBQUEsdUJBQVEsRUFBQztZQUNQLFdBQVc7WUFDWCxHQUFHLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQywwQkFBMEI7WUFDM0MsS0FBSyxFQUFFLElBQUk7WUFDWCxNQUFNLEVBQUUsSUFBSTtTQUNiLENBQUMsQ0FBQztRQUVILE9BQU8sQ0FBQyxHQUFHLENBQUMsbUNBQW1DLFdBQVcsRUFBRSxDQUFDLENBQUM7SUFDaEUsQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDZixPQUFPLENBQUMsS0FBSyxDQUFDLHVDQUF1QyxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQzlELHlEQUF5RDtJQUMzRCxDQUFDO0FBQ0gsQ0FBQztBQXBCRCw4Q0FvQkMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFBob2VuaXggT3BlblRlbGVtZXRyeSBUcmFjaW5nIEluaXRpYWxpemF0aW9uXG4gKlxuICogUHJvdmlkZXMgY2VudHJhbGl6ZWQgdHJhY2luZyBzZXR1cCBmb3IgTGFtYmRhIGZ1bmN0aW9ucyB0aGF0IG5lZWQgdG8gc2VuZFxuICogdHJhY2VzIHRvIEFyaXplIFBob2VuaXggZm9yIEFJIG9ic2VydmFiaWxpdHkuXG4gKi9cblxuaW1wb3J0IHsgcmVnaXN0ZXIgfSBmcm9tICdAYXJpemVhaS9waG9lbml4LW90ZWwnO1xuXG4vKipcbiAqIEluaXRpYWxpemUgUGhvZW5peCBPcGVuVGVsZW1ldHJ5IHRyYWNpbmcgZm9yIGEgTGFtYmRhIGZ1bmN0aW9uLlxuICogQ2FsbCB0aGlzIGF0IHRoZSB0b3Agb2YgTGFtYmRhIGhhbmRsZXIgZmlsZXMgYmVmb3JlIGFueSBvdGhlciBpbXBvcnRzLlxuICpcbiAqIEBwYXJhbSBwcm9qZWN0TmFtZSAtIE5hbWUgb2YgdGhlIHByb2plY3Qvc2VydmljZSBmb3IgdHJhY2luZyAoZS5nLiwgJ3NvbmdiaXJkLWFuYWx5dGljcy1jaGF0LXF1ZXJ5JylcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGluaXRpYWxpemVUcmFjaW5nKHByb2plY3ROYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgLy8gT25seSBpbml0aWFsaXplIGlmIFBob2VuaXggZW5kcG9pbnQgaXMgY29uZmlndXJlZFxuICBpZiAoIXByb2Nlc3MuZW52LlBIT0VOSVhfQ09MTEVDVE9SX0VORFBPSU5UKSB7XG4gICAgY29uc29sZS53YXJuKCdQSE9FTklYX0NPTExFQ1RPUl9FTkRQT0lOVCBub3Qgc2V0LCB0cmFjaW5nIGRpc2FibGVkJyk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdHJ5IHtcbiAgICByZWdpc3Rlcih7XG4gICAgICBwcm9qZWN0TmFtZSxcbiAgICAgIHVybDogcHJvY2Vzcy5lbnYuUEhPRU5JWF9DT0xMRUNUT1JfRU5EUE9JTlQsXG4gICAgICBiYXRjaDogdHJ1ZSxcbiAgICAgIGdsb2JhbDogdHJ1ZSxcbiAgICB9KTtcblxuICAgIGNvbnNvbGUubG9nKGBQaG9lbml4IHRyYWNpbmcgaW5pdGlhbGl6ZWQgZm9yICR7cHJvamVjdE5hbWV9YCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRmFpbGVkIHRvIGluaXRpYWxpemUgUGhvZW5peCB0cmFjaW5nOicsIGVycm9yKTtcbiAgICAvLyBEb24ndCB0aHJvdyAtIGFsbG93IExhbWJkYSB0byBjb250aW51ZSB3aXRob3V0IHRyYWNpbmdcbiAgfVxufVxuIl19