/**
 * Device Lookup Utilities
 *
 * Provides functions to resolve serial_number <-> device_uid mappings
 * using the device aliases table. This enables Notecard swapping while
 * preserving device identity and history.
 */
/**
 * Device alias record structure
 */
export interface DeviceAlias {
    serial_number: string;
    device_uid: string;
    previous_device_uids?: string[];
    created_at: number;
    updated_at: number;
}
/**
 * Resolved device info with all associated device_uids
 */
export interface ResolvedDevice {
    serial_number: string;
    device_uid: string;
    all_device_uids: string[];
}
/**
 * Get alias record by serial_number
 */
export declare function getAliasBySerial(serialNumber: string): Promise<DeviceAlias | null>;
/**
 * Get alias record by device_uid (using GSI)
 */
export declare function getAliasByDeviceUid(deviceUid: string): Promise<DeviceAlias | null>;
/**
 * Resolve a serial_number or device_uid to full device info
 * Returns null if not found
 */
export declare function resolveDevice(serialOrDeviceUid: string): Promise<ResolvedDevice | null>;
/**
 * Get the current device_uid for a serial_number
 */
export declare function getDeviceUidForSerial(serialNumber: string): Promise<string | null>;
/**
 * Get the serial_number for a device_uid
 */
export declare function getSerialForDeviceUid(deviceUid: string): Promise<string | null>;
/**
 * Get all device_uids associated with a serial_number (for historical queries)
 */
export declare function getAllDeviceUidsForSerial(serialNumber: string): Promise<string[]>;
/**
 * Create a new device alias
 */
export declare function createAlias(serialNumber: string, deviceUid: string): Promise<void>;
/**
 * Update alias when a Notecard is swapped
 * Moves the old device_uid to previous_device_uids and sets the new one
 */
export declare function updateAliasOnSwap(serialNumber: string, newDeviceUid: string, oldDeviceUid: string): Promise<void>;
/**
 * Handle device alias for incoming event
 * Creates alias if new, updates if Notecard was swapped
 * Returns true if a swap was detected
 */
export declare function handleDeviceAlias(serialNumber: string, deviceUid: string): Promise<{
    isNewDevice: boolean;
    isSwap: boolean;
    oldDeviceUid?: string;
}>;
