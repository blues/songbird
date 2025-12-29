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
 * Moves the old device_uid to previous_device_uids and sets the new one
 */
export async function updateAliasOnSwap(
  serialNumber: string,
  newDeviceUid: string,
  oldDeviceUid: string
): Promise<void> {
  const now = Date.now();

  const command = new UpdateCommand({
    TableName: DEVICE_ALIASES_TABLE,
    Key: { serial_number: serialNumber },
    UpdateExpression: `
      SET device_uid = :new_uid,
          updated_at = :now,
          previous_device_uids = list_append(if_not_exists(previous_device_uids, :empty_list), :old_uid_list)
    `,
    ExpressionAttributeValues: {
      ':new_uid': newDeviceUid,
      ':now': now,
      ':old_uid_list': [oldDeviceUid],
      ':empty_list': [],
    },
  });

  await docClient.send(command);
  console.log(`Updated device alias on swap: ${serialNumber} - ${oldDeviceUid} -> ${newDeviceUid}`);
}

/**
 * Handle device alias for incoming event
 * Creates alias if new, updates if Notecard was swapped
 * Returns true if a swap was detected
 */
export async function handleDeviceAlias(
  serialNumber: string,
  deviceUid: string
): Promise<{ isNewDevice: boolean; isSwap: boolean; oldDeviceUid?: string }> {
  const existingAlias = await getAliasBySerial(serialNumber);

  if (!existingAlias) {
    // New device - create alias
    await createAlias(serialNumber, deviceUid);
    return { isNewDevice: true, isSwap: false };
  }

  if (existingAlias.device_uid !== deviceUid) {
    // Notecard swap detected!
    const oldDeviceUid = existingAlias.device_uid;
    await updateAliasOnSwap(serialNumber, deviceUid, oldDeviceUid);
    return { isNewDevice: false, isSwap: true, oldDeviceUid };
  }

  // Same device, no changes needed
  return { isNewDevice: false, isSwap: false };
}
