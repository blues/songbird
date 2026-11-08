/**
 * Device Lookup Utilities
 *
 * Provides functions to resolve serial_number <-> device_uid mappings
 * using the device aliases table. This enables Notecard swapping while
 * preserving device identity and history.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

// Initialize clients
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

const DEVICE_ALIASES_TABLE = process.env.DEVICE_ALIASES_TABLE!;

/**
 * Device alias record structure
 */
export interface DeviceAlias {
  serial_number: string;           // PK - stable identifier
  device_uid: string;              // Current active Notecard device_uid
  previous_device_uids?: string[]; // History of swapped Notecards
  created_at: number;
  updated_at: number;
}

/**
 * Resolved device info with all associated device_uids
 */
export interface ResolvedDevice {
  serial_number: string;
  device_uid: string;           // Current device_uid
  all_device_uids: string[];    // All device_uids (current + previous)
}

/**
 * Get alias record by serial_number
 */
export async function getAliasBySerial(serialNumber: string): Promise<DeviceAlias | null> {
  const command = new GetCommand({
    TableName: DEVICE_ALIASES_TABLE,
    Key: { serial_number: serialNumber },
  });

  const result = await docClient.send(command);
  return result.Item as DeviceAlias | null;
}

/**
 * Get alias record by device_uid (using GSI)
 */
export async function getAliasByDeviceUid(deviceUid: string): Promise<DeviceAlias | null> {
  const command = new QueryCommand({
    TableName: DEVICE_ALIASES_TABLE,
    IndexName: 'device-uid-index',
    KeyConditionExpression: 'device_uid = :device_uid',
    ExpressionAttributeValues: {
      ':device_uid': deviceUid,
    },
    Limit: 1,
  });

  const result = await docClient.send(command);
  if (result.Items && result.Items.length > 0) {
    return result.Items[0] as DeviceAlias;
  }
  return null;
}

/**
 * Resolve a serial_number or device_uid to full device info
 * Returns null if not found
 */
export async function resolveDevice(serialOrDeviceUid: string): Promise<ResolvedDevice | null> {
  // First, try to look up as serial_number
  let alias = await getAliasBySerial(serialOrDeviceUid);

  // If not found, try as device_uid
  if (!alias) {
    alias = await getAliasByDeviceUid(serialOrDeviceUid);
  }

  if (!alias) {
    return null;
  }

  // Build list of all device_uids
  const allDeviceUids = [alias.device_uid];
  if (alias.previous_device_uids) {
    allDeviceUids.push(...alias.previous_device_uids);
  }

  return {
    serial_number: alias.serial_number,
    device_uid: alias.device_uid,
    all_device_uids: allDeviceUids,
  };
}

/**
 * Get the current device_uid for a serial_number
 */
export async function getDeviceUidForSerial(serialNumber: string): Promise<string | null> {
  const alias = await getAliasBySerial(serialNumber);
  return alias?.device_uid ?? null;
}

/**
 * Get the serial_number for a device_uid
 */
export async function getSerialForDeviceUid(deviceUid: string): Promise<string | null> {
  const alias = await getAliasByDeviceUid(deviceUid);
  return alias?.serial_number ?? null;
}

/**
 * Get all device_uids associated with a serial_number (for historical queries)
 */
export async function getAllDeviceUidsForSerial(serialNumber: string): Promise<string[]> {
  const alias = await getAliasBySerial(serialNumber);
  if (!alias) {
    return [];
  }

  const allDeviceUids = [alias.device_uid];
  if (alias.previous_device_uids) {
    allDeviceUids.push(...alias.previous_device_uids);
  }
  return allDeviceUids;
}

/**
 * Create a new device alias
 */
export async function createAlias(serialNumber: string, deviceUid: string): Promise<void> {
  const now = Date.now();

  const command = new PutCommand({
    TableName: DEVICE_ALIASES_TABLE,
    Item: {
      serial_number: serialNumber,
      device_uid: deviceUid,
      created_at: now,
      updated_at: now,
    },
    ConditionExpression: 'attribute_not_exists(serial_number)',
  });

  try {
    await docClient.send(command);
    console.log(`Created device alias: ${serialNumber} -> ${deviceUid}`);
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      console.log(`Alias already exists for ${serialNumber}, skipping create`);
    } else {
      throw error;
    }
  }
}

/**
 * Update alias when a Notecard is swapped
 * Moves the old device_uid into previous_device_uids and sets the new one.
 *
 * The write is guarded by a ConditionExpression asserting device_uid still
 * equals the value the caller read (expectedOldDeviceUid). This closes the
 * read-modify-write TOCTOU window: a concurrent swap that already moved
 * device_uid causes a ConditionalCheckFailedException instead of silently
 * clobbering the newer mapping. previous_device_uids is rebuilt as a
 * de-duplicated set rather than blindly appended.
 */
export async function updateAliasOnSwap(
  serialNumber: string,
  newDeviceUid: string,
  oldDeviceUid: string,
  previousDeviceUids: string[] = []
): Promise<void> {
  const now = Date.now();

  // De-dup history: existing previous uids + the old uid, minus the incoming
  // new uid (which is now the current device_uid).
  const dedupedPrevious = Array.from(
    new Set([...previousDeviceUids, oldDeviceUid])
  ).filter((uid) => uid !== newDeviceUid);

  const command = new UpdateCommand({
    TableName: DEVICE_ALIASES_TABLE,
    Key: { serial_number: serialNumber },
    UpdateExpression: `
      SET device_uid = :new_uid,
          updated_at = :now,
          previous_device_uids = :previous
    `,
    // Only apply if device_uid is still what we read (no concurrent swap).
    ConditionExpression: 'device_uid = :expected_old',
    ExpressionAttributeValues: {
      ':new_uid': newDeviceUid,
      ':now': now,
      ':previous': dedupedPrevious,
      ':expected_old': oldDeviceUid,
    },
  });

  await docClient.send(command);
  console.log(`Updated device alias on swap: ${serialNumber} - ${oldDeviceUid} -> ${newDeviceUid}`);
}

/**
 * Handle device alias for incoming event
 * Creates alias if new, updates if Notecard was swapped
 * Returns true if a swap was detected
 *
 * Swap updates use a conditional write and retry on contention so two events
 * for the same serial cannot race and lose an update (TOCTOU-safe).
 */
export async function handleDeviceAlias(
  serialNumber: string,
  deviceUid: string
): Promise<{ isNewDevice: boolean; isSwap: boolean; oldDeviceUid?: string }> {
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const existingAlias = await getAliasBySerial(serialNumber);

    if (!existingAlias) {
      // New device - create alias. createAlias is conditional on
      // attribute_not_exists, so a racing create is handled there.
      await createAlias(serialNumber, deviceUid);
      return { isNewDevice: true, isSwap: false };
    }

    if (existingAlias.device_uid === deviceUid) {
      // Same device, no changes needed
      return { isNewDevice: false, isSwap: false };
    }

    // Notecard swap detected - apply a conditional write guarded on the
    // device_uid we just read.
    const oldDeviceUid = existingAlias.device_uid;
    try {
      await updateAliasOnSwap(
        serialNumber,
        deviceUid,
        oldDeviceUid,
        existingAlias.previous_device_uids ?? []
      );
      return { isNewDevice: false, isSwap: true, oldDeviceUid };
    } catch (error: any) {
      if (error.name === 'ConditionalCheckFailedException' && attempt < MAX_ATTEMPTS) {
        // Lost the race with a concurrent swap - re-read and retry. If the
        // other writer already set our device_uid, the next loop returns
        // no-op via the equality check above.
        console.log(`Alias swap for ${serialNumber} lost a race, retrying (attempt ${attempt})`);
        continue;
      }
      throw error;
    }
  }

  throw new Error(`handleDeviceAlias: exceeded retries resolving swap for ${serialNumber}`);
}
