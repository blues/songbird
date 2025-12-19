import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchUserAttributes, updateUserAttribute } from 'aws-amplify/auth';

export interface UserProfile {
  name?: string;
  email?: string;
  givenName?: string;
  familyName?: string;
}

async function getUserProfile(): Promise<UserProfile> {
  const attributes = await fetchUserAttributes();
  return {
    name: attributes.name,
    email: attributes.email,
    givenName: attributes.given_name,
    familyName: attributes.family_name,
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
