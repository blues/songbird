/**
 * Feature Flags Context
 *
 * Provides feature flag management throughout the app.
 *
 * Features can be enabled via:
 * 1. URL parameters (e.g., ?ff_analytics=true) - for quick testing
 * 2. localStorage - for persistent testing
 * 3. Admin panel in Settings - for managing flags
 *
 * URL parameters take precedence and automatically save to localStorage.
 */

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';

/**
 * Define all feature flags here.
 * Add new flags with their default values.
 */
export interface FeatureFlags {
  analytics: boolean;      // Analytics page and features
  // Add new feature flags here as needed:
  // newFeature: boolean;
}

const DEFAULT_FLAGS: FeatureFlags = {
  analytics: false,
};

// List of all flag keys for iteration
const FLAG_KEYS = Object.keys(DEFAULT_FLAGS) as (keyof FeatureFlags)[];

const STORAGE_KEY = 'songbird_feature_flags';
const URL_PREFIX = 'ff_'; // URL params like ?ff_analytics=true

interface FeatureFlagsContextValue {
  flags: FeatureFlags;
  isEnabled: (flag: keyof FeatureFlags) => boolean;
  setFlag: (flag: keyof FeatureFlags, enabled: boolean) => void;
  resetFlags: () => void;
  enabledCount: number;
}

const FeatureFlagsContext = createContext<FeatureFlagsContextValue>({
  flags: DEFAULT_FLAGS,
  isEnabled: () => false,
  setFlag: () => {},
  resetFlags: () => {},
  enabledCount: 0,
});

/**
 * Load flags from localStorage
 */
function loadStoredFlags(): Partial<FeatureFlags> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.warn('Failed to load feature flags from localStorage:', e);
  }
  return {};
}

/**
 * Save flags to localStorage
 */
function saveFlags(flags: FeatureFlags): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(flags));
  } catch (e) {
    console.warn('Failed to save feature flags to localStorage:', e);
  }
}

/**
 * Parse URL parameters for feature flags
 */
function parseUrlFlags(): Partial<FeatureFlags> {
  const params = new URLSearchParams(window.location.search);
  const urlFlags: Partial<FeatureFlags> = {};

  for (const key of FLAG_KEYS) {
    const param = params.get(`${URL_PREFIX}${key}`);
    if (param !== null) {
      urlFlags[key] = param === 'true' || param === '1';
    }
  }

  return urlFlags;
}

/**
 * Remove feature flag params from URL (clean up after reading)
 */
function cleanUrlParams(): void {
  const url = new URL(window.location.href);
  let changed = false;

  for (const key of FLAG_KEYS) {
    if (url.searchParams.has(`${URL_PREFIX}${key}`)) {
      url.searchParams.delete(`${URL_PREFIX}${key}`);
      changed = true;
    }
  }

  if (changed) {
    window.history.replaceState({}, '', url.toString());
  }
}

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
  const [flags, setFlags] = useState<FeatureFlags>(() => {
    // Initialize with defaults, then overlay stored flags
    const stored = loadStoredFlags();
    return { ...DEFAULT_FLAGS, ...stored };
  });

  // Check URL params on mount
  useEffect(() => {
    const urlFlags = parseUrlFlags();
    if (Object.keys(urlFlags).length > 0) {
      setFlags(prev => {
        const newFlags = { ...prev, ...urlFlags };
        saveFlags(newFlags);
        return newFlags;
      });
      // Clean URL after applying flags
      cleanUrlParams();
    }
  }, []);

  const isEnabled = useCallback((flag: keyof FeatureFlags): boolean => {
    return flags[flag] ?? false;
  }, [flags]);

  const setFlag = useCallback((flag: keyof FeatureFlags, enabled: boolean) => {
    setFlags(prev => {
      const newFlags = { ...prev, [flag]: enabled };
      saveFlags(newFlags);
      return newFlags;
    });
  }, []);

  const resetFlags = useCallback(() => {
    setFlags(DEFAULT_FLAGS);
    saveFlags(DEFAULT_FLAGS);
  }, []);

  const enabledCount = FLAG_KEYS.filter(key => flags[key]).length;

  return (
    <FeatureFlagsContext.Provider value={{ flags, isEnabled, setFlag, resetFlags, enabledCount }}>
      {children}
    </FeatureFlagsContext.Provider>
  );
}

/**
 * Hook to access feature flags
 */
export function useFeatureFlags() {
  return useContext(FeatureFlagsContext);
}

/**
 * Hook to check if a specific feature is enabled
 */
export function useFeature(flag: keyof FeatureFlags): boolean {
  const { isEnabled } = useFeatureFlags();
  return isEnabled(flag);
}

/**
 * Get all available flag keys (useful for admin panel)
 */
export function getFeatureFlagKeys(): (keyof FeatureFlags)[] {
  return FLAG_KEYS;
}

/**
 * Feature flag metadata for admin panel
 */
export const FEATURE_FLAG_INFO: Record<keyof FeatureFlags, { name: string; description: string }> = {
  analytics: {
    name: 'Analytics',
    description: 'Enable the Analytics page with natural language queries and data visualization',
  },
};
