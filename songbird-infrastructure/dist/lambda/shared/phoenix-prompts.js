"use strict";
/**
 * Phoenix Prompt Hub integration.
 *
 * Fetches prompt templates from Phoenix at runtime with caching and fallback.
 * Uses the Phoenix REST API directly (no SDK dependency) for compatibility
 * with the project's CommonJS/Node module resolution.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderTemplate = exports.getPromptTemplate = exports.toBedrockModelId = void 0;
const PHOENIX_HOST = process.env.PHOENIX_HOST || '';
const PROMPT_TAG = process.env.PHOENIX_PROMPT_TAG || 'production';
const CACHE_TTL_MS = parseInt(process.env.PHOENIX_PROMPT_CACHE_TTL_MS || '300000', 10); // 5 min
// Module-level cache (survives across Lambda invocations in the same container)
const cache = new Map();
/**
 * Extract the template text from a Phoenix PromptVersion response.
 * Supports both chat templates (messages array) and string templates.
 */
function extractTemplate(promptVersion) {
    const template = promptVersion.template;
    if (template.type === 'string') {
        return template.template;
    }
    if (template.type === 'chat' && template.messages) {
        return template.messages
            .map((msg) => {
            if (typeof msg.content === 'string')
                return msg.content;
            if (Array.isArray(msg.content)) {
                return msg.content
                    .filter((part) => part.type === 'text')
                    .map((part) => part.text)
                    .join('');
            }
            return '';
        })
            .join('\n\n');
    }
    return '';
}
/**
 * Fetch a prompt version from Phoenix REST API.
 * Tries tag-based retrieval first, falls back to /latest for Phoenix v8.0.0 compatibility.
 * Phoenix API wraps responses in a { data: ... } envelope.
 */
async function fetchPromptFromPhoenix(promptName) {
    const encodedName = encodeURIComponent(promptName);
    // Try tag-based retrieval first (Phoenix v9+)
    const tagUrl = `${PHOENIX_HOST}/v1/prompts/${encodedName}/tags/${encodeURIComponent(PROMPT_TAG)}`;
    let response = await fetch(tagUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000),
    });
    // Fall back to /latest if tags endpoint isn't available (Phoenix v8.0.0)
    if (response.status === 404 || response.status === 405) {
        const latestUrl = `${PHOENIX_HOST}/v1/prompts/${encodedName}/latest`;
        response = await fetch(latestUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(5000),
        });
    }
    if (!response.ok) {
        if (response.status === 404)
            return null;
        throw new Error(`Phoenix API returned ${response.status}: ${response.statusText}`);
    }
    const body = await response.json();
    // Phoenix wraps responses in { data: ... }
    return body.data || body;
}
/**
 * Map Anthropic API model IDs to AWS Bedrock model IDs.
 * Phoenix stores Anthropic API IDs (for Playground compatibility),
 * but the Lambda calls Bedrock which uses a different naming scheme.
 */
const ANTHROPIC_TO_BEDROCK = {
    'claude-sonnet-4-5-20250929': 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'claude-haiku-4-5-20251001': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    'claude-3-5-sonnet-20241022': 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
    'claude-3-5-haiku-20241022': 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
};
function toBedrockModelId(anthropicModelId) {
    return ANTHROPIC_TO_BEDROCK[anthropicModelId];
}
exports.toBedrockModelId = toBedrockModelId;
/**
 * Extract model config from a Phoenix PromptVersion response.
 */
function extractModelConfig(promptVersion) {
    const modelName = promptVersion.model_name || undefined;
    const params = promptVersion.invocation_parameters;
    // Anthropic invocation params are nested: { type: "anthropic", anthropic: { max_tokens: N } }
    const maxTokens = params?.anthropic?.max_tokens || params?.max_tokens || undefined;
    return { modelName, maxTokens };
}
/**
 * Fetch a prompt config from Phoenix with caching and fallback.
 *
 * Returns the template string plus optional model name and max_tokens from the prompt version.
 * When Phoenix specifies a model, the caller can use it instead of the Lambda env var default.
 *
 * @param promptName - The name of the prompt in Phoenix
 * @param fallbackTemplate - Hardcoded fallback template if Phoenix is unreachable
 * @returns PromptConfig with template and optional model overrides
 */
async function getPromptTemplate(promptName, fallbackTemplate) {
    // If PHOENIX_HOST is not set, skip Phoenix entirely
    if (!PHOENIX_HOST) {
        return { template: fallbackTemplate };
    }
    const cacheKey = `${promptName}:${PROMPT_TAG}`;
    const cached = cache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
        return cached.config;
    }
    try {
        const promptVersion = await fetchPromptFromPhoenix(promptName);
        if (!promptVersion) {
            console.warn(`Prompt "${promptName}" not found in Phoenix, using fallback`);
            return { template: fallbackTemplate };
        }
        const template = extractTemplate(promptVersion);
        if (!template) {
            console.warn(`Prompt "${promptName}" has empty template, using fallback`);
            return { template: fallbackTemplate };
        }
        const { modelName, maxTokens } = extractModelConfig(promptVersion);
        const config = { template, modelName, maxTokens };
        cache.set(cacheKey, { config, fetchedAt: Date.now() });
        console.log(`Fetched prompt "${promptName}" from Phoenix (model: ${modelName || 'default'})`);
        return config;
    }
    catch (error) {
        console.warn(`Failed to fetch prompt "${promptName}" from Phoenix, using fallback:`, error);
        return { template: fallbackTemplate };
    }
}
exports.getPromptTemplate = getPromptTemplate;
/**
 * Simple mustache-style template variable substitution.
 * Replaces {{ varName }} with the provided values.
 */
function renderTemplate(template, variables) {
    let result = template;
    for (const [key, value] of Object.entries(variables)) {
        result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), value);
    }
    return result;
}
exports.renderTemplate = renderTemplate;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGhvZW5peC1wcm9tcHRzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vbGFtYmRhL3NoYXJlZC9waG9lbml4LXByb21wdHMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7R0FNRzs7O0FBRUgsTUFBTSxZQUFZLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxZQUFZLElBQUksRUFBRSxDQUFDO0FBQ3BELE1BQU0sVUFBVSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsa0JBQWtCLElBQUksWUFBWSxDQUFDO0FBQ2xFLE1BQU0sWUFBWSxHQUFHLFFBQVEsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLDJCQUEyQixJQUFJLFFBQVEsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLFFBQVE7QUFRaEcsZ0ZBQWdGO0FBQ2hGLE1BQU0sS0FBSyxHQUFHLElBQUksR0FBRyxFQUF1RCxDQUFDO0FBRTdFOzs7R0FHRztBQUNILFNBQVMsZUFBZSxDQUFDLGFBQWtCO0lBQ3pDLE1BQU0sUUFBUSxHQUFHLGFBQWEsQ0FBQyxRQUFRLENBQUM7SUFDeEMsSUFBSSxRQUFRLENBQUMsSUFBSSxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQy9CLE9BQU8sUUFBUSxDQUFDLFFBQVEsQ0FBQztJQUMzQixDQUFDO0lBQ0QsSUFBSSxRQUFRLENBQUMsSUFBSSxLQUFLLE1BQU0sSUFBSSxRQUFRLENBQUMsUUFBUSxFQUFFLENBQUM7UUFDbEQsT0FBTyxRQUFRLENBQUMsUUFBUTthQUNyQixHQUFHLENBQUMsQ0FBQyxHQUFRLEVBQUUsRUFBRTtZQUNoQixJQUFJLE9BQU8sR0FBRyxDQUFDLE9BQU8sS0FBSyxRQUFRO2dCQUFFLE9BQU8sR0FBRyxDQUFDLE9BQU8sQ0FBQztZQUN4RCxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7Z0JBQy9CLE9BQU8sR0FBRyxDQUFDLE9BQU87cUJBQ2YsTUFBTSxDQUFD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QUFDLFFBQVEsRUFBRSxFQUFFLE1BQU0sRUFBRSxTQUFTLEVBQUUsSUFBSSxDQUFDLEdBQUcsRUFBRSxFQUFFLENBQUMsQ0FBQztRQUN2RCxPQUFPLENBQUMsR0FBRyxDQUFDLG1CQUFtQixVQUFVLDBCQUEwQixTQUFTLElBQUksU0FBUyxHQUFHLENBQUMsQ0FBQztRQUM5RixPQUFPLE1BQU0sQ0FBQztJQUNoQixDQUFDO0lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztRQUNmLE9BQU8sQ0FBQyxJQUFJLENBQUMsMkJBQTJCLFVBQVUsaUNBQWlDLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDNUYsT0FBTyxFQUFFLFFBQVEsRUFBRSxnQkFBZ0IsRUFBRSxDQUFDO0lBQ3hDLENBQUM7QUFDSCxDQUFDO0FBdkNELDhDQXVDQztBQUVEOzs7R0FHRztBQUNILFNBQWdCLGNBQWMsQ0FBQyxRQUFnQixFQUFFLFNBQWlDO0lBQ2hGLElBQUksTUFBTSxHQUFHLFFBQVEsQ0FBQztJQUN0QixLQUFLLE1BQU0sQ0FBQyxHQUFHLEVBQUUsS0FBSyxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDO1FBQ3JELE1BQU0sR0FBRyxNQUFNLENBQUMsT0FBTyxDQUFDLElBQUksTUFBTSxDQUFDLGFBQWEsR0FBRyxZQUFZLEVBQUUsR0FBRyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUM7SUFDaEYsQ0FBQztJQUNELE9BQU8sTUFBTSxDQUFDO0FBQ2hCLENBQUM7QUFORCx3Q0FNQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogUGhvZW5peCBQcm9tcHQgSHViIGludGVncmF0aW9uLlxuICpcbiAqIEZldGNoZXMgcHJvbXB0IHRlbXBsYXRlcyBmcm9tIFBob2VuaXggYXQgcnVudGltZSB3aXRoIGNhY2hpbmcgYW5kIGZhbGxiYWNrLlxuICogVXNlcyB0aGUgUGhvZW5peCBSRVNUIEFQSSBkaXJlY3RseSAobm8gU0RLIGRlcGVuZGVuY3kpIGZvciBjb21wYXRpYmlsaXR5XG4gKiB3aXRoIHRoZSBwcm9qZWN0J3MgQ29tbW9uSlMvTm9kZSBtb2R1bGUgcmVzb2x1dGlvbi5cbiAqL1xuXG5jb25zdCBQSE9FTklYX0hPU1QgPSBwcm9jZXNzLmVudi5QSE9FTklYX0hPU1QgfHwgJyc7XG5jb25zdCBQUk9NUFRfVEFHID0gcHJvY2Vzcy5lbnYuUEhPRU5JWF9QUk9NUFRfVEFHIHx8ICdwcm9kdWN0aW9uJztcbmNvbnN0IENBQ0hFX1RUTF9NUyA9IHBhcnNlSW50KHByb2Nlc3MuZW52LlBIT0VOSVhfUFJPTVBUX0NBQ0hFX1RUTF9NUyB8fCAnMzAwMDAwJywgMTApOyAvLyA1IG1pblxuXG5leHBvcnQgaW50ZXJmYWNlIFByb21wdENvbmZpZyB7XG4gIHRlbXBsYXRlOiBzdHJpbmc7XG4gIG1vZGVsTmFtZT86IHN0cmluZztcbiAgbWF4VG9rZW5zPzogbnVtYmVyO1xufVxuXG4vLyBNb2R1bGUtbGV2ZWwgY2FjaGUgKHN1cnZpdmVzIGFjcm9zcyBMYW1iZGEgaW52b2NhdGlvbnMgaW4gdGhlIHNhbWUgY29udGFpbmVyKVxuY29uc3QgY2FjaGUgPSBuZXcgTWFwPHN0cmluZywgeyBjb25maWc6IFByb21wdENvbmZpZzsgZmV0Y2hlZEF0OiBudW1iZXIgfT4oKTtcblxuLyoqXG4gKiBFeHRyYWN0IHRoZSB0ZW1wbGF0ZSB0ZXh0IGZyb20gYSBQaG9lbml4IFByb21wdFZlcnNpb24gcmVzcG9uc2UuXG4gKiBTdXBwb3J0cyBib3RoIGNoYXQgdGVtcGxhdGVzIChtZXNzYWdlcyBhcnJheSkgYW5kIHN0cmluZyB0ZW1wbGF0ZXMuXG4gKi9cbmZ1bmN0aW9uIGV4dHJhY3RUZW1wbGF0ZShwcm9tcHRWZXJzaW9uOiBhbnkpOiBzdHJpbmcge1xuICBjb25zdCB0ZW1wbGF0ZSA9IHByb21wdFZlcnNpb24udGVtcGxhdGU7XG4gIGlmICh0ZW1wbGF0ZS50eXBlID09PSAnc3RyaW5nJykge1xuICAgIHJldHVybiB0ZW1wbGF0ZS50ZW1wbGF0ZTtcbiAgfVxuICBpZiAodGVtcGxhdGUudHlwZSA9PT0gJ2NoYXQnICYmIHRlbXBsYXRlLm1lc3NhZ2VzKSB7XG4gICAgcmV0dXJuIHRlbXBsYXRlLm1lc3NhZ2VzXG4gICAgICAubWFwKChtc2c6IGFueSkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIG1zZy5jb250ZW50ID09PSAnc3RyaW5nJykgcmV0dXJuIG1zZy5jb250ZW50O1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShtc2cuY29udGVudCkpIHtcbiAgICAgICAgICByZXR1cm4gbXNnLmNvbnRlbnRcbiAgICAgICAgICAgIC5maWx0ZXIoKHBhcnQ6IGFueSkgPT4gcGFydC50eXBlID09PSAndGV4dCcpXG4gICAgICAgICAgICAubWFwKChwYXJ0OiBhbnkpID0+IHBhcnQudGV4dClcbiAgICAgICAgICAgIC5qb2luKCcnKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gJyc7XG4gICAgICB9KVxuICAgICAgLmpvaW4oJ1xcblxcbicpO1xuICB9XG4gIHJldHVybiAnJztcbn1cblxuLyoqXG4gKiBGZXRjaCBhIHByb21wdCB2ZXJzaW9uIGZyb20gUGhvZW5peCBSRVNUIEFQSS5cbiAqIFRyaWVzIHRhZy1iYXNlZCByZXRyaWV2YWwgZmlyc3QsIGZhbGxzIGJhY2sgdG8gL2xhdGVzdCBmb3IgUGhvZW5peCB2OC4wLjAgY29tcGF0aWJpbGl0eS5cbiAqIFBob2VuaXggQVBJIHdyYXBzIHJlc3BvbnNlcyBpbiBhIHsgZGF0YTogLi4uIH0gZW52ZWxvcGUuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGZldGNoUHJvbXB0RnJvbVBob2VuaXgocHJvbXB0TmFtZTogc3RyaW5nKTogUHJvbWlzZTxhbnkgfCBudWxsPiB7XG4gIGNvbnN0IGVuY29kZWROYW1lID0gZW5jb2RlVVJJQ29tcG9uZW50KHByb21wdE5hbWUpO1xuXG4gIC8vIFRyeSB0YWctYmFzZWQgcmV0cmlldmFsIGZpcnN0IChQaG9lbml4IHY5KylcbiAgY29uc3QgdGFnVXJsID0gYCR7UEhPRU5JWF9IT1NUfS92MS9wcm9tcHRzLyR7ZW5jb2RlZE5hbWV9L3RhZ3MvJHtlbmNvZGVVUklDb21wb25lbnQoUFJPTVBUX1RBRyl9YDtcbiAgbGV0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2godGFnVXJsLCB7XG4gICAgbWV0aG9kOiAnR0VUJyxcbiAgICBoZWFkZXJzOiB7ICdBY2NlcHQnOiAnYXBwbGljYXRpb24vanNvbicgfSxcbiAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoNTAwMCksXG4gIH0pO1xuXG4gIC8vIEZhbGwgYmFjayB0byAvbGF0ZXN0IGlmIHRhZ3MgZW5kcG9pbnQgaXNuJ3QgYXZhaWxhYmxlIChQaG9lbml4IHY4LjAuMClcbiAgaWYgKHJlc3BvbnNlLnN0YXR1cyA9PT0gNDA0IHx8IHJlc3BvbnNlLnN0YXR1cyA9PT0gNDA1KSB7XG4gICAgY29uc3QgbGF0ZXN0VXJsID0gYCR7UEhPRU5JWF9IT1NUfS92MS9wcm9tcHRzLyR7ZW5jb2RlZE5hbWV9L2xhdGVzdGA7XG4gICAgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChsYXRlc3RVcmwsIHtcbiAgICAgIG1ldGhvZDogJ0dFVCcsXG4gICAgICBoZWFkZXJzOiB7ICdBY2NlcHQnOiAnYXBwbGljYXRpb24vanNvbicgfSxcbiAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCg1MDAwKSxcbiAgICB9KTtcbiAgfVxuXG4gIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID09PSA0MDQpIHJldHVybiBudWxsO1xuICAgIHRocm93IG5ldyBFcnJvcihgUGhvZW5peCBBUEkgcmV0dXJuZWQgJHtyZXNwb25zZS5zdGF0dXN9OiAke3Jlc3BvbnNlLnN0YXR1c1RleHR9YCk7XG4gIH1cblxuICBjb25zdCBib2R5ID0gYXdhaXQgcmVzcG9uc2UuanNvbigpIGFzIGFueTtcbiAgLy8gUGhvZW5peCB3cmFwcyByZXNwb25zZXMgaW4geyBkYXRhOiAuLi4gfVxuICByZXR1cm4gYm9keS5kYXRhIHx8IGJvZHk7XG59XG5cbi8qKlxuICogTWFwIEFudGhyb3BpYyBBUEkgbW9kZWwgSURzIHRvIEFXUyBCZWRyb2NrIG1vZGVsIElEcy5cbiAqIFBob2VuaXggc3RvcmVzIEFudGhyb3BpYyBBUEkgSURzIChmb3IgUGxheWdyb3VuZCBjb21wYXRpYmlsaXR5KSxcbiAqIGJ1dCB0aGUgTGFtYmRhIGNhbGxzIEJlZHJvY2sgd2hpY2ggdXNlcyBhIGRpZmZlcmVudCBuYW1pbmcgc2NoZW1lLlxuICovXG5jb25zdCBBTlRIUk9QSUNfVE9fQkVEUk9DSzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgJ2NsYXVkZS1zb25uZXQtNC01LTIwMjUwOTI5JzogJ3VzLmFudGhyb3BpYy5jbGF1ZGUtc29ubmV0LTQtNS0yMDI1MDkyOS12MTowJyxcbiAgJ2NsYXVkZS1oYWlrdS00LTUtMjAyNTEwMDEnOiAndXMuYW50aHJvcGljLmNsYXVkZS1oYWlrdS00LTUtMjAyNTEwMDEtdjE6MCcsXG4gICdjbGF1ZGUtMy01LXNvbm5ldC0yMDI0MTAyMic6ICd1cy5hbnRocm9waWMuY2xhdWRlLTMtNS1zb25uZXQtMjAyNDEwMjItdjI6MCcsXG4gICdjbGF1ZGUtMy01LWhhaWt1LTIwMjQxMDIyJzogJ3VzLmFudGhyb3BpYy5jbGF1ZGUtMy01LWhhaWt1LTIwMjQxMDIyLXYxOjAnLFxufTtcblxuZXhwb3J0IGZ1bmN0aW9uIHRvQmVkcm9ja01vZGVsSWQoYW50aHJvcGljTW9kZWxJZDogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIEFOVEhST1BJQ19UT19CRURST0NLW2FudGhyb3BpY01vZGVsSWRdO1xufVxuXG4vKipcbiAqIEV4dHJhY3QgbW9kZWwgY29uZmlnIGZyb20gYSBQaG9lbml4IFByb21wdFZlcnNpb24gcmVzcG9uc2UuXG4gKi9cbmZ1bmN0aW9uIGV4dHJhY3RNb2RlbENvbmZpZyhwcm9tcHRWZXJzaW9uOiBhbnkpOiB7IG1vZGVsTmFtZT86IHN0cmluZzsgbWF4VG9rZW5zPzogbnVtYmVyIH0ge1xuICBjb25zdCBtb2RlbE5hbWUgPSBwcm9tcHRWZXJzaW9uLm1vZGVsX25hbWUgfHwgdW5kZWZpbmVkO1xuICBjb25zdCBwYXJhbXMgPSBwcm9tcHRWZXJzaW9uLmludm9jYXRpb25fcGFyYW1ldGVycztcbiAgLy8gQW50aHJvcGljIGludm9jYXRpb24gcGFyYW1zIGFyZSBuZXN0ZWQ6IHsgdHlwZTogXCJhbnRocm9waWNcIiwgYW50aHJvcGljOiB7IG1heF90b2tlbnM6IE4gfSB9XG4gIGNvbnN0IG1heFRva2VucyA9IHBhcmFtcz8uYW50aHJvcGljPy5tYXhfdG9rZW5zIHx8IHBhcmFtcz8ubWF4X3Rva2VucyB8fCB1bmRlZmluZWQ7XG4gIHJldHVybiB7IG1vZGVsTmFtZSwgbWF4VG9rZW5zIH07XG59XG5cbi8qKlxuICogRmV0Y2ggYSBwcm9tcHQgY29uZmlnIGZyb20gUGhvZW5peCB3aXRoIGNhY2hpbmcgYW5kIGZhbGxiYWNrLlxuICpcbiAqIFJldHVybnMgdGhlIHRlbXBsYXRlIHN0cmluZyBwbHVzIG9wdGlvbmFsIG1vZGVsIG5hbWUgYW5kIG1heF90b2tlbnMgZnJvbSB0aGUgcHJvbXB0IHZlcnNpb24uXG4gKiBXaGVuIFBob2VuaXggc3BlY2lmaWVzIGEgbW9kZWwsIHRoZSBjYWxsZXIgY2FuIHVzZSBpdCBpbnN0ZWFkIG9mIHRoZSBMYW1iZGEgZW52IHZhciBkZWZhdWx0LlxuICpcbiAqIEBwYXJhbSBwcm9tcHROYW1lIC0gVGhlIG5hbWUgb2YgdGhlIHByb21wdCBpbiBQaG9lbml4XG4gKiBAcGFyYW0gZmFsbGJhY2tUZW1wbGF0ZSAtIEhhcmRjb2RlZCBmYWxsYmFjayB0ZW1wbGF0ZSBpZiBQaG9lbml4IGlzIHVucmVhY2hhYmxlXG4gKiBAcmV0dXJucyBQcm9tcHRDb25maWcgd2l0aCB0ZW1wbGF0ZSBhbmQgb3B0aW9uYWwgbW9kZWwgb3ZlcnJpZGVzXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRQcm9tcHRUZW1wbGF0ZShcbiAgcHJvbXB0TmFtZTogc3RyaW5nLFxuICBmYWxsYmFja1RlbXBsYXRlOiBzdHJpbmdcbik6IFByb21pc2U8UHJvbXB0Q29uZmlnPiB7XG4gIC8vIElmIFBIT0VOSVhfSE9TVCBpcyBub3Qgc2V0LCBza2lwIFBob2VuaXggZW50aXJlbHlcbiAgaWYgKCFQSE9FTklYX0hPU1QpIHtcbiAgICByZXR1cm4geyB0ZW1wbGF0ZTogZmFsbGJhY2tUZW1wbGF0ZSB9O1xuICB9XG5cbiAgY29uc3QgY2FjaGVLZXkgPSBgJHtwcm9tcHROYW1lfToke1BST01QVF9UQUd9YDtcbiAgY29uc3QgY2FjaGVkID0gY2FjaGUuZ2V0KGNhY2hlS2V5KTtcbiAgaWYgKGNhY2hlZCAmJiAoRGF0ZS5ub3coKSAtIGNhY2hlZC5mZXRjaGVkQXQpIDwgQ0FDSEVfVFRMX01TKSB7XG4gICAgcmV0dXJuIGNhY2hlZC5jb25maWc7XG4gIH1cblxuICB0cnkge1xuICAgIGNvbnN0IHByb21wdFZlcnNpb24gPSBhd2FpdCBmZXRjaFByb21wdEZyb21QaG9lbml4KHByb21wdE5hbWUpO1xuXG4gICAgaWYgKCFwcm9tcHRWZXJzaW9uKSB7XG4gICAgICBjb25zb2xlLndhcm4oYFByb21wdCBcIiR7cHJvbXB0TmFtZX1cIiBub3QgZm91bmQgaW4gUGhvZW5peCwgdXNpbmcgZmFsbGJhY2tgKTtcbiAgICAgIHJldHVybiB7IHRlbXBsYXRlOiBmYWxsYmFja1RlbXBsYXRlIH07XG4gICAgfVxuXG4gICAgY29uc3QgdGVtcGxhdGUgPSBleHRyYWN0VGVtcGxhdGUocHJvbXB0VmVyc2lvbik7XG4gICAgaWYgKCF0ZW1wbGF0ZSkge1xuICAgICAgY29uc29sZS53YXJuKGBQcm9tcHQgXCIke3Byb21wdE5hbWV9XCIgaGFzIGVtcHR5IHRlbXBsYXRlLCB1c2luZyBmYWxsYmFja2ApO1xuICAgICAgcmV0dXJuIHsgdGVtcGxhdGU6IGZhbGxiYWNrVGVtcGxhdGUgfTtcbiAgICB9XG5cbiAgICBjb25zdCB7IG1vZGVsTmFtZSwgbWF4VG9rZW5zIH0gPSBleHRyYWN0TW9kZWxDb25maWcocHJvbXB0VmVyc2lvbik7XG4gICAgY29uc3QgY29uZmlnOiBQcm9tcHRDb25maWcgPSB7IHRlbXBsYXRlLCBtb2RlbE5hbWUsIG1heFRva2VucyB9O1xuXG4gICAgY2FjaGUuc2V0KGNhY2hlS2V5LCB7IGNvbmZpZywgZmV0Y2hlZEF0OiBEYXRlLm5vdygpIH0pO1xuICAgIGNvbnNvbGUubG9nKGBGZXRjaGVkIHByb21wdCBcIiR7cHJvbXB0TmFtZX1cIiBmcm9tIFBob2VuaXggKG1vZGVsOiAke21vZGVsTmFtZSB8fCAnZGVmYXVsdCd9KWApO1xuICAgIHJldHVybiBjb25maWc7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS53YXJuKGBGYWlsZWQgdG8gZmV0Y2ggcHJvbXB0IFwiJHtwcm9tcHROYW1lfVwiIGZyb20gUGhvZW5peCwgdXNpbmcgZmFsbGJhY2s6YCwgZXJyb3IpO1xuICAgIHJldHVybiB7IHRlbXBsYXRlOiBmYWxsYmFja1RlbXBsYXRlIH07XG4gIH1cbn1cblxuLyoqXG4gKiBTaW1wbGUgbXVzdGFjaGUtc3R5bGUgdGVtcGxhdGUgdmFyaWFibGUgc3Vic3RpdHV0aW9uLlxuICogUmVwbGFjZXMge3sgdmFyTmFtZSB9fSB3aXRoIHRoZSBwcm92aWRlZCB2YWx1ZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUZW1wbGF0ZSh0ZW1wbGF0ZTogc3RyaW5nLCB2YXJpYWJsZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4pOiBzdHJpbmcge1xuICBsZXQgcmVzdWx0ID0gdGVtcGxhdGU7XG4gIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHZhcmlhYmxlcykpIHtcbiAgICByZXN1bHQgPSByZXN1bHQucmVwbGFjZShuZXcgUmVnRXhwKGBcXFxce1xcXFx7XFxcXHMqJHtrZXl9XFxcXHMqXFxcXH1cXFxcfWAsICdnJyksIHZhbHVlKTtcbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuIl19