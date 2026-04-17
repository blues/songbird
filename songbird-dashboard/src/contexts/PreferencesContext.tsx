/**
 * Preferences Context
 *
 * Provides user display preferences throughout the app.
 */

import { createContext, useContext, ReactNode } from 'react';
import { useUserProfile } from '@/hooks/useUserProfile';
import { DEFAULT_PREFERENCES } from '@/config/preferences';
import type { DisplayPreferences } from '@/types';

interface PreferencesContextValue {
  preferences: DisplayPreferences;
  isLoading: boolean;
}

const PreferencesContext = createContext<PreferencesContextValue>({
  preferences: DEFAULT_PREFERENCES,
  isLoading: true,
});

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { data: profile, isLoading } = useUserProfile();

  const preferences = profile?.preferences || DEFAULT_PREFERENCES;

  return (
    <PreferencesContext.Provider value={{ preferences, isLoading }}>
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences() {
  return useContext(PreferencesContext);
}
