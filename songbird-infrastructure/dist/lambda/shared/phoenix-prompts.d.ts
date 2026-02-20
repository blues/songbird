/**
 * Phoenix Prompt Hub integration.
 *
 * Fetches prompt templates from Phoenix at runtime with caching and fallback.
 * Uses the Phoenix REST API directly (no SDK dependency) for compatibility
 * with the project's CommonJS/Node module resolution.
 */
export interface PromptConfig {
    template: string;
    modelName?: string;
    maxTokens?: number;
}
export declare function toBedrockModelId(anthropicModelId: string): string | undefined;
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
export declare function getPromptTemplate(promptName: string, fallbackTemplate: string): Promise<PromptConfig>;
/**
 * Simple mustache-style template variable substitution.
 * Replaces {{ varName }} with the provided values.
 */
export declare function renderTemplate(template: string, variables: Record<string, string>): string;
