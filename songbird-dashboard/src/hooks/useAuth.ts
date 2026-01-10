/**
 * Authentication hooks
 *
 * Provides role detection and user group information.
 * Integrates with PostHog for user identification.
 */

import { useState, useEffect } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
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
 * Hook to check if the current user is an admin
 */
export function useIsAdmin() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getUserGroups()
      .then(groups => {
        setIsAdmin(groups.includes('Admin'));
        setIsLoading(false);
      })
      .catch(() => {
        setIsAdmin(false);
        setIsLoading(false);
      });
  }, []);

  return { isAdmin, isLoading };
}

/**
 * Hook to get the current user's groups
 */
export function useUserGroups() {
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getUserGroups()
      .then(g => {
        setGroups(g);
        setIsLoading(false);
      })
      .catch(() => {
        setGroups([]);
        setIsLoading(false);
      });
  }, []);

  return { groups, isLoading };
}

/**
 * Hook to check if the current user can send commands
 * Returns true for all roles except Viewer
 */
export function useCanSendCommands() {
  const [canSend, setCanSend] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getUserGroups()
      .then(groups => {
        // Viewers can only view, not send commands
        // If user has no groups or only Viewer group, they cannot send
        const isViewerOnly = groups.length === 0 ||
          (groups.length === 1 && groups.includes('Viewer'));
        setCanSend(!isViewerOnly);
        setIsLoading(false);
      })
      .catch(() => {
        setCanSend(false);
        setIsLoading(false);
      });
  }, []);

  return { canSend, isLoading };
}

/**
 * Hook to get the current user's email
 */
export function useCurrentUserEmail() {
  const [email, setEmail] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchAuthSession()
      .then(session => {
        const userEmail = session.tokens?.idToken?.payload['email'] as string | undefined;
        setEmail(userEmail || null);
        setIsLoading(false);
      })
      .catch(() => {
        setEmail(null);
        setIsLoading(false);
      });
  }, []);

  return { email, isLoading };
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
