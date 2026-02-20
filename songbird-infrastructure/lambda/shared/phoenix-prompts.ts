/**
 * Phoenix Prompt Hub integration.
 *
 * Fetches prompt templates from Phoenix at runtime with caching and fallback.
 * Uses the Phoenix REST API directly (no SDK dependency) for compatibility
 * with the project's CommonJS/Node module resolution.
 */

const PHOENIX_HOST = process.env.PHOENIX_HOST || '';
const PROMPT_TAG = process.env.PHOENIX_PROMPT_TAG || 'production';
const CACHE_TTL_MS = parseInt(process.env.PHOENIX_PROMPT_CACHE_TTL_MS || '300000', 10); // 5 min

export interface PromptConfig {
  template: string;
  modelName?: string;
  maxTokens?: number;
}

// Module-level cache (survives across Lambda invocations in the same container)
const cache = new Map<string, { config: PromptConfig; fetchedAt: number }>();

/**
 * Extract the template text from a Phoenix PromptVersion response.
 * Supports both chat templates (messages array) and string templates.
 */
function extractTemplate(promptVersion: any): string {
  const template = promptVersion.template;
  if (template.type === 'string') {
    return template.template;
  }
  if (template.type === 'chat' && template.messages) {
    return template.messages
      .map((msg: any) => {
        if (typeof msg.content === 'string') return msg.content;
        if (Array.isArray(msg.content)) {
          return msg.content
            .filter((part: any) => part.type === 'text')
            .map((part: any) => part.text)
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
async function fetchPromptFromPhoenix(promptName: string): Promise<any | null> {
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
    if (response.status === 404) return null;
    throw new Error(`Phoenix API returned ${response.status}: ${response.statusText}`);
  }

  const body = await response.json() as any;
  // Phoenix wraps responses in { data: ... }
  return body.data || body;
}

/**
 * Map Anthropic API model IDs to AWS Bedrock model IDs.
 * Phoenix stores Anthropic API IDs (for Playground compatibility),
 * but the Lambda calls Bedrock which uses a different naming scheme.
 */
const ANTHROPIC_TO_BEDROCK: Record<string, string> = {
  'claude-sonnet-4-5-20250929': 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'claude-haiku-4-5-20251001': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'claude-3-5-sonnet-20241022': 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
  'claude-3-5-haiku-20241022': 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
};

export function toBedrockModelId(anthropicModelId: string): string | undefined {
  return ANTHROPIC_TO_BEDROCK[anthropicModelId];
}

/**
 * Extract model config from a Phoenix PromptVersion response.
 */
function extractModelConfig(promptVersion: any): { modelName?: string; maxTokens?: number } {
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
export async function getPromptTemplate(
  promptName: string,
  fallbackTemplate: string
): Promise<PromptConfig> {
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
    const config: PromptConfig = { template, modelName, maxTokens };

    cache.set(cacheKey, { config, fetchedAt: Date.now() });
    console.log(`Fetched prompt "${promptName}" from Phoenix (model: ${modelName || 'default'})`);
    return config;
  } catch (error) {
    console.warn(`Failed to fetch prompt "${promptName}" from Phoenix, using fallback:`, error);
    return { template: fallbackTemplate };
  }
}

/**
 * Simple mustache-style template variable substitution.
 * Replaces {{ varName }} with the provided values.
 */
export function renderTemplate(template: string, variables: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), value);
  }
  return result;
}
