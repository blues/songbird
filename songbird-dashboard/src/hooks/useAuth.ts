/**
 * Authentication hooks
 *
 * Provides role detection and user group information.
 */

import { useState, useEffect } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
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
