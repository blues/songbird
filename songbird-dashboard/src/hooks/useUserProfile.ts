import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchUserAttributes, updateUserAttribute, updateUserAttributes } from 'aws-amplify/auth';
import type { DisplayPreferences } from '@/types';

export interface UserProfile {
  name?: string;
  email?: string;
  givenName?: string;
  familyName?: string;
  // Display preferences
  preferences: DisplayPreferences;
}

const DEFAULT_PREFERENCES: DisplayPreferences = {
  temp_unit: 'celsius',
  time_format: '24h',
  default_time_range: '24',
  map_style: 'street',
};

async function getUserProfile(): Promise<UserProfile> {
  const attributes = await fetchUserAttributes();
  return {
    name: attributes.name,
    email: attributes.email,
    givenName: attributes.given_name,
    familyName: attributes.family_name,
    preferences: {
      temp_unit: (attributes['custom:temp_unit'] as DisplayPreferences['temp_unit']) || DEFAULT_PREFERENCES.temp_unit,
      time_format: (attributes['custom:time_format'] as DisplayPreferences['time_format']) || DEFAULT_PREFERENCES.time_format,
      default_time_range: (attributes['custom:default_time_range'] as DisplayPreferences['default_time_range']) || DEFAULT_PREFERENCES.default_time_range,
      map_style: (attributes['custom:map_style'] as DisplayPreferences['map_style']) || DEFAULT_PREFERENCES.map_style,
    },
  };
}

async function updateDisplayName(name: string): Promise<void> {
  const result = await updateUserAttribute({
    userAttribute: {
      attributeKey: 'name',
      value: name,
    },
  });

  if (!result.isUpdated) {
    throw new Error('Failed to update display name');
  }
}

async function updatePreferences(preferences: Partial<DisplayPreferences>): Promise<void> {
  const updates: { attributeKey: string; value: string }[] = [];

  if (preferences.temp_unit !== undefined) {
    updates.push({ attributeKey: 'custom:temp_unit', value: preferences.temp_unit });
  }
  if (preferences.time_format !== undefined) {
    updates.push({ attributeKey: 'custom:time_format', value: preferences.time_format });
  }
  if (preferences.default_time_range !== undefined) {
    updates.push({ attributeKey: 'custom:default_time_range', value: preferences.default_time_range });
  }
  if (preferences.map_style !== undefined) {
    updates.push({ attributeKey: 'custom:map_style', value: preferences.map_style });
  }

  if (updates.length === 0) return;

  await updateUserAttributes({
    userAttributes: Object.fromEntries(updates.map(u => [u.attributeKey, u.value])),
  });
}

export function useUserProfile() {
  return useQuery({
    queryKey: ['userProfile'],
    queryFn: getUserProfile,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 1,
  });
}

export function useUpdateDisplayName() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updateDisplayName,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['userProfile'] });
    },
  });
}

export function useUpdatePreferences() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updatePreferences,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['userProfile'] });
    },
  });
}
