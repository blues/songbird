#!/usr/bin/env npx ts-node
/**
 * Migration Script: Create Device Aliases for Existing Devices
 *
 * This script scans the existing devices table and creates alias records
 * in the device-aliases table for each device. This is a one-time migration
 * to support the new serial_number-based lookup system.
 *
 * Usage:
 *   npx ts-node scripts/migrate-device-aliases.ts
 *
 * Or with dry-run (no writes):
 *   DRY_RUN=true npx ts-node scripts/migrate-device-aliases.ts
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

const DEVICES_TABLE = process.env.DEVICES_TABLE || 'songbird-devices';
const DEVICE_ALIASES_TABLE = process.env.DEVICE_ALIASES_TABLE || 'songbird-device-aliases';
const DRY_RUN = process.env.DRY_RUN === 'true';

interface DeviceRecord {
  device_uid: string;
  serial_number?: string;
  created_at?: number;
}

interface MigrationStats {
  totalDevices: number;
  devicesWithSerial: number;
  devicesWithoutSerial: number;
  aliasesCreated: number;
  aliasesSkipped: number;
  errors: number;
}

async function scanDevices(): Promise<DeviceRecord[]> {
  const devices: DeviceRecord[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;

  do {
    const command = new ScanCommand({
      TableName: DEVICES_TABLE,
      ProjectionExpression: 'device_uid, serial_number, created_at',
      ExclusiveStartKey: lastEvaluatedKey,
    });

    const result = await docClient.send(command);
    devices.push(...(result.Items as DeviceRecord[] || []));
    lastEvaluatedKey = result.LastEvaluatedKey;

    console.log(`Scanned ${devices.length} devices so far...`);
  } while (lastEvaluatedKey);

  return devices;
}

async function checkAliasExists(serialNumber: string): Promise<boolean> {
  const command = new GetCommand({
    TableName: DEVICE_ALIASES_TABLE,
    Key: { serial_number: serialNumber },
  });

  const result = await docClient.send(command);
  return !!result.Item;
}

async function createAlias(serialNumber: string, deviceUid: string): Promise<void> {
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

  await docClient.send(command);
}

async function migrate(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Device Aliases Migration Script');
  console.log('='.repeat(60));
  console.log(`Devices Table: ${DEVICES_TABLE}`);
  console.log(`Aliases Table: ${DEVICE_ALIASES_TABLE}`);
  console.log(`Dry Run: ${DRY_RUN}`);
  console.log('='.repeat(60));
  console.log('');

  const stats: MigrationStats = {
    totalDevices: 0,
    devicesWithSerial: 0,
    devicesWithoutSerial: 0,
    aliasesCreated: 0,
    aliasesSkipped: 0,
    errors: 0,
  };

  // Scan all devices
  console.log('Scanning devices table...');
  const devices = await scanDevices();
  stats.totalDevices = devices.length;
  console.log(`Found ${devices.length} devices\n`);

  // Process each device
  for (const device of devices) {
    const { device_uid, serial_number } = device;

    if (!serial_number || serial_number.trim() === '') {
      console.log(`  SKIP: ${device_uid} - No serial number`);
      stats.devicesWithoutSerial++;
      continue;
    }

    stats.devicesWithSerial++;

    try {
      // Check if alias already exists
      const exists = await checkAliasExists(serial_number);

      if (exists) {
        console.log(`  EXISTS: ${serial_number} -> ${device_uid}`);
        stats.aliasesSkipped++;
        continue;
      }

      // Create alias
      if (DRY_RUN) {
        console.log(`  DRY RUN: Would create ${serial_number} -> ${device_uid}`);
        stats.aliasesCreated++;
      } else {
        await createAlias(serial_number, device_uid);
        console.log(`  CREATED: ${serial_number} -> ${device_uid}`);
        stats.aliasesCreated++;
      }
    } catch (error: any) {
      if (error.name === 'ConditionalCheckFailedException') {
        // Race condition - alias was created by another process
        console.log(`  RACE: ${serial_number} -> ${device_uid} (created by another process)`);
        stats.aliasesSkipped++;
      } else {
        console.error(`  ERROR: ${serial_number} -> ${device_uid}: ${error.message}`);
        stats.errors++;
      }
    }
  }

  // Print summary
  console.log('');
  console.log('='.repeat(60));
  console.log('Migration Summary');
  console.log('='.repeat(60));
  console.log(`Total devices scanned:     ${stats.totalDevices}`);
  console.log(`Devices with serial:       ${stats.devicesWithSerial}`);
  console.log(`Devices without serial:    ${stats.devicesWithoutSerial}`);
  console.log(`Aliases created:           ${stats.aliasesCreated}${DRY_RUN ? ' (dry run)' : ''}`);
  console.log(`Aliases skipped (exists):  ${stats.aliasesSkipped}`);
  console.log(`Errors:                    ${stats.errors}`);
  console.log('='.repeat(60));

  if (stats.devicesWithoutSerial > 0) {
    console.log('');
    console.log('WARNING: Some devices have no serial number set.');
    console.log('These devices will not work with the new serial_number-based APIs.');
    console.log('You should configure serial numbers in Notehub for these devices.');
  }

  if (DRY_RUN) {
    console.log('');
    console.log('This was a DRY RUN. No changes were made.');
    console.log('Run without DRY_RUN=true to apply changes.');
  }
}

// Run the migration
migrate()
  .then(() => {
    console.log('\nMigration complete!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nMigration failed:', error);
    process.exit(1);
  });
