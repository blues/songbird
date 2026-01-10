/**
 * PostHog Feature Flags Hook
 *
 * Provides feature flag access using PostHog.
 * Replaces the old FeatureFlagsContext with PostHog-backed flags.
 */

import { useFeatureFlagEnabled, usePostHog } from 'posthog-js/react';

/**
 * Known feature flags in the system.
 * Add new flags here as they're created in PostHog.
 */
export type FeatureFlagKey = 'analytics';

/**
 * Check if a specific feature flag is enabled.
 * Returns false if PostHog isn't initialized or flag doesn't exist.
 */
export function useFeatureFlag(flag: FeatureFlagKey): boolean {
  const enabled = useFeatureFlagEnabled(flag);
  return enabled ?? false;
}

/**
 * Get all feature flags as an object.
 * Useful for components that need to check multiple flags.
 */
export function useFeatureFlags(): Record<FeatureFlagKey, boolean> {
  const analytics = useFeatureFlagEnabled('analytics') ?? false;

  return {
    analytics,
  };
}

/**
 * Get the PostHog instance for custom tracking.
 */
export function useAnalytics() {
  return usePostHog();
}
