/**
 * Authentication hooks
 *
 * Provides role detection and user group information.
 * Integrates with PostHog for user identification.
 */

import { useEffect } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useQuery } from '@tanstack/react-query';
import posthog from 'posthog-js';
import type { UserGroup } from '@/types';

/**
 * Get user's groups from the current session
 */
async function getUserGroups(): Promise<UserGroup[]> {
  try {
    const session = await fetchAuthSession();
    const groups = session.tokens?.idToken?.payload['cognito:groups'];

    if (Array.isArray(groups)) {
      return groups as UserGroup[];
    }
    if (typeof groups === 'string') {
      return [groups as UserGroup];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Shared TanStack Query hook for user groups — a single Cognito round-trip
 * is shared across all components that call any of the auth hooks simultaneously.
 */
function useUserGroupsQuery() {
  return useQuery({
    queryKey: ['authSession', 'groups'],
    queryFn: getUserGroups,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

/**
 * Hook to check if the current user is an admin
 */
export function useIsAdmin() {
  const { data: groups = [], isLoading } = useUserGroupsQuery();
  return { isAdmin: groups.includes('Admin'), isLoading };
}

/**
 * Hook to get the current user's groups
 */
export function useUserGroups() {
  const { data: groups = [], isLoading } = useUserGroupsQuery();
  return { groups, isLoading };
}

/**
 * Hook to check if the current user can send commands
 * Returns true for all roles except Viewer
 */
export function useCanSendCommands() {
  const { data: groups = [], isLoading } = useUserGroupsQuery();
  // Viewers can only view, not send commands
  // If user has no groups or only Viewer group, they cannot send
  const isViewerOnly = groups.length === 0 ||
    (groups.length === 1 && groups.includes('Viewer'));
  return { canSend: !isViewerOnly, isLoading };
}

/**
 * Hook to get the current user's email
 */
export function useCurrentUserEmail() {
  const { data, isLoading } = useQuery({
    queryKey: ['authSession', 'email'],
    queryFn: async () => {
      const session = await fetchAuthSession();
      return (session.tokens?.idToken?.payload['email'] as string | undefined) ?? null;
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });
  return { email: data ?? null, isLoading };
}

/**
 * Hook to check if the current user can unlock a device.
 * Returns true if user is an admin OR is the device owner (assigned_to matches).
 */
export function useCanUnlockDevice(assignedTo?: string) {
  const { isAdmin, isLoading: isAdminLoading } = useIsAdmin();
  const { email, isLoading: isEmailLoading } = useCurrentUserEmail();

  const isLoading = isAdminLoading || isEmailLoading;

  // Admin can unlock any device
  if (isAdmin) {
    return { canUnlock: true, isLoading };
  }

  // Device owner can unlock their own device
  if (email && assignedTo && email === assignedTo) {
    return { canUnlock: true, isLoading };
  }

  return { canUnlock: false, isLoading };
}

/**
 * Hook to identify the current user to PostHog for analytics.
 * Should be called once when the user is authenticated.
 */
export function usePostHogIdentify() {
  useEffect(() => {
    async function identifyUser() {
      try {
        const session = await fetchAuthSession();
        const payload = session.tokens?.idToken?.payload;

        if (!payload) return;

        const userId = payload['sub'] as string;
        const email = payload['email'] as string | undefined;
        const name = payload['name'] as string | undefined;
        const groups = payload['cognito:groups'];

        if (userId) {
          posthog.identify(userId, {
            email,
            name,
            group: Array.isArray(groups) ? groups[0] : groups,
            groups: Array.isArray(groups) ? groups : groups ? [groups] : [],
          });
        }
      } catch {
        // Silently fail - analytics shouldn't break the app
      }
    }

    identifyUser();
  }, []);
}
