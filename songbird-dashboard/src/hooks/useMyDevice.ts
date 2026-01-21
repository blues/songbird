/**
 * Hook to get the current user's claimed device
 *
 * Returns the serial number of the device assigned to the current user,
 * or null if no device is assigned.
 */

import { useMemo } from 'react';
import { useCurrentUserEmail } from './useAuth';
import { useUsers } from './useUsers';
import { useDevices } from './useDevices';

interface MyDeviceResult {
  serialNumber: string | null;
  isLoading: boolean;
}

export function useMyDevice(): MyDeviceResult {
  const { email, isLoading: emailLoading } = useCurrentUserEmail();
  const { data: users, isLoading: usersLoading } = useUsers(true);
  const { data: devicesResponse, isLoading: devicesLoading } = useDevices();

  const serialNumber = useMemo(() => {
    if (!email || !users || !devicesResponse?.devices) {
      return null;
    }

    // Find the current user by email
    const currentUser = users.find(u => u.email === email);
    if (!currentUser?.assigned_devices?.length) {
      return null;
    }

    // Get the assigned device UID
    const deviceUid = currentUser.assigned_devices[0];

    // Find the device to get its serial number
    const device = devicesResponse.devices.find(d => d.device_uid === deviceUid);
    return device?.serial_number ?? null;
  }, [email, users, devicesResponse]);

  return {
    serialNumber,
    isLoading: emailLoading || usersLoading || devicesLoading,
  };
}
